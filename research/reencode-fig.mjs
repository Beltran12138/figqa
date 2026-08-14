/**
 * Phase 1a：round-trip 验证 .fig write 路径（纯本机，不碰 Figma runtime）
 *
 * 读原 .fig → decode Message → re-encode → 套 zstd+ZIP → out/roundtrip.fig → 自读验证
 *
 * 验证层（从严到宽）：
 *   L1  kiwi byte 对称:  encodeMessage(decodeMessage(data)) === data           (最严，可能不等)
 *   L2  kiwi 语义对称:   decodeMessage(encodeMessage(msg)) deep-equal msg
 *   L3a 内层自读:        新 canvas.fig 解回的 message deep-equal 原
 *   L3b 全链路自读:      roundtrip.fig 经 ZIP 读回的 message deep-equal 原
 *
 * L1 不等不代表失败（Figma 服务端用自家 Kiwi 实现，字段序/默认值可能不同）；
 * 真正判 write 路径通不通 = L2/L3 自读通过 + Phase 1b 人工 import 渲染。
 *
 * 产物 out/roundtrip.fig 交人工拖进 Figma（Phase 1b）。
 *
 * Usage: node reencode-fig.mjs [path.fig]   （默认 sample.fig）
 */

import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { decodeBinarySchema, compileSchema } = require("kiwi-schema");
const AdmZip = require("adm-zip");
const fzstd = require("fzstd");

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const MAGIC = "fig-kiwi";
const DEFAULT_SRC = "./sample.fig";

// ---------- fig-kiwi archive parse / build（对称）----------
function parseArchive(buf) {
  const magic = buf.toString("latin1", 0, 8);
  if (magic !== MAGIC) throw new Error(`bad magic ${JSON.stringify(magic)} (want ${MAGIC})`);
  const version = buf.readUInt32LE(8);
  const chunks = [];
  let off = 12;
  while (off + 4 <= buf.length) {
    const size = buf.readUInt32LE(off);
    off += 4;
    if (off + size > buf.length) throw new Error(`chunk overrun at ${off}: size=${size} rem=${buf.length - off}`);
    chunks.push({ size, data: Buffer.from(buf.subarray(off, off + size)) });
    off += size;
  }
  if (off !== buf.length) throw new Error(`trailing ${buf.length - off} B after last chunk`);
  return { magic, version, chunks };
}

function buildArchive(version, chunkBytes) {
  const parts = [Buffer.from(MAGIC, "latin1")];
  const v = Buffer.alloc(4); v.writeUInt32LE(version, 0); parts.push(v);
  for (const cb of chunkBytes) {
    const sz = Buffer.alloc(4); sz.writeUInt32LE(cb.length, 0);
    parts.push(sz, cb);
  }
  return Buffer.concat(parts);
}

// ---------- 比较 ----------
function u8(b) { return b instanceof Uint8Array ? b : new Uint8Array(b); }
function byteEqual(a, b) {
  a = u8(a); b = u8(b);
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}
function isBytes(x) { return x instanceof Uint8Array || Buffer.isBuffer(x); }
function deepEqualMsg(a, b) {
  if (a == null || b == null) return a === b;
  const ab = isBytes(a), bb = isBytes(b);
  if (ab || bb) return ab && bb && byteEqual(a, b);
  if (typeof a !== "object" || typeof b !== "object") return a === b;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  const ka = Object.keys(a), kb = Object.keys(b);
  if (ka.length !== kb.length) return false;
  for (const k of ka) {
    if (!Object.prototype.hasOwnProperty.call(b, k)) return false;
    if (!deepEqualMsg(a[k], b[k])) return false;
  }
  return true;
}

function main() {
  const log = (...a) => console.error(...a);
  const src = process.argv[2] || DEFAULT_SRC;
  const outDir = path.join(__dirname, "out");
  fs.mkdirSync(outDir, { recursive: true });

  log(`[1] read ${src}`);
  const outerBuf = fs.readFileSync(src);

  // ---- 解 ZIP，抽出各 entry 原始字节 ----
  const zip = new AdmZip(outerBuf);
  const ent = Object.fromEntries(zip.getEntries().map((e) => [e.entryName, e]));
  const getE = (n) => {
    const e = ent[n];
    if (!e) throw new Error(`ZIP 缺 ${n}；有: ${Object.keys(ent).join(", ")}`);
    return e.getData();
  };
  const canvasBuf = getE("canvas.fig");
  const thumbnailBuf = getE("thumbnail.png");
  const metaBuf = getE("meta.json");
  log(`[2] ZIP entries: canvas=${canvasBuf.length} thumbnail=${thumbnailBuf.length} meta=${metaBuf.length}`);

  // ---- 解 fig-kiwi 内层 ----
  const arc = parseArchive(canvasBuf);
  log(`[3] fig-kiwi magic=${arc.magic} version=${arc.version} chunks=${arc.chunks.length}`);
  if (arc.chunks.length < 2) throw new Error(`需 >=2 chunks，得 ${arc.chunks.length}`);
  const schemaChunkRaw = arc.chunks[0].data;   // deflateRaw 压缩的 schema（原样复用）
  const dataChunkRaw = arc.chunks[1].data;      // zstd 压缩的 Message

  const schemaInflated = zlib.inflateRawSync(schemaChunkRaw);
  const dataInflated = Buffer.from(fzstd.decompress(dataChunkRaw));
  log(`[4] inflate: schema=${schemaInflated.length} B  data=${dataInflated.length} B`);

  const schema = decodeBinarySchema(new Uint8Array(schemaInflated));
  const compiled = compileSchema(schema);
  if (typeof compiled.decodeMessage !== "function")
    throw new Error(`compiled 无 decodeMessage；有: ${Object.keys(compiled).filter(k=>k.startsWith("decode"))}`);
  if (typeof compiled.encodeMessage !== "function")
    throw new Error(`compiled 无 encodeMessage；有 encode*: ${Object.keys(compiled).filter(k=>k.startsWith("encode"))}`);

  // ---- decode 原 Message（完整 bytes，不走 JSON 截断）----
  const origMsg = compiled.decodeMessage(new Uint8Array(dataInflated));
  log(`[5] decodeMessage OK；top keys=${Object.keys(origMsg).join(",")}`);

  // ---- L1/L2：kiwi 对称性 ----
  const reEncoded = compiled.encodeMessage(origMsg);  // Uint8Array
  const l1Byte = byteEqual(reEncoded, dataInflated);
  const reDecoded = compiled.decodeMessage(new Uint8Array(reEncoded));
  const l2Sem = deepEqualMsg(reDecoded, origMsg);
  log(`[6] L1 byte-equal=${l1Byte} (reEncoded=${reEncoded.length} vs origData=${dataInflated.length})`);
  log(`    L2 semantic-equal=${l2Sem}`);

  // ---- packaging：data chunk 用 zstd(reEncoded)，schema chunk 原样 ----
  // fzstd 0.1.1 无 compress（纯解压器）；用 Node 24 内置 zlib.zstdCompressSync。
  // L3a 会用 fzstd.decompress 解它，验证 Node-zstd 与 fzstd 互通（Figma 可解的前提）。
  const newDataChunk = zlib.zstdCompressSync(Buffer.from(reEncoded));
  const newCanvas = buildArchive(arc.version, [schemaChunkRaw, newDataChunk]);
  log(`[7] 新 canvas.fig=${newCanvas.length} B（原 ${canvasBuf.length}）`);

  // ---- L3a：内层 canvas 自读 ----
  const arc2 = parseArchive(newCanvas);
  const d2 = Buffer.from(fzstd.decompress(arc2.chunks[1].data));
  const msg2 = compiled.decodeMessage(new Uint8Array(d2));
  const l3a = deepEqualMsg(msg2, origMsg);
  log(`[8] L3a 内层 canvas 自读 semantic-equal=${l3a}`);

  // ---- 套 ZIP 外层（对齐原文件 compression）----
  // 原文件：canvas.fig/thumbnail.png=STORE(0)，meta.json=DEFLATE(8)，images/=目录。
  // AdmZip addFile 默认 DEFLATE(8)；设 entry.header.method=0 强制 STORE（实测 writeZip 尊重）。
  const newZip = new AdmZip();
  const cE = newZip.addFile("canvas.fig", newCanvas); cE.header.method = 0;       // STORE
  const tE = newZip.addFile("thumbnail.png", thumbnailBuf); tE.header.method = 0; // STORE
  newZip.addFile("meta.json", metaBuf);                                            // DEFLATE(8) 默认
  try { const dE = newZip.addFile("images/", Buffer.alloc(0)); if (dE) dE.header.method = 0; }
  catch (e) { log(`    (images/ dir skip: ${e.message})`); }
  const outPath = path.join(outDir, "roundtrip.fig");
  newZip.writeZip(outPath);
  const outSize = fs.statSync(outPath).size;
  log(`[9] wrote ${outPath} (${outSize} B，原 .fig ${outerBuf.length} B)`);

  // ---- L3b：roundtrip.fig 全链路自读 ----
  const rt = fs.readFileSync(outPath);
  const rz = new AdmZip(rt);
  const rCanvas = rz.getEntries().find((e) => e.entryName === "canvas.fig");
  if (!rCanvas) throw new Error("roundtrip.fig 无 canvas.fig entry");
  const rArc = parseArchive(rCanvas.getData());
  const rData = Buffer.from(fzstd.decompress(rArc.chunks[1].data));
  const rMsg = compiled.decodeMessage(new Uint8Array(rData));
  const l3b = deepEqualMsg(rMsg, origMsg);
  log(`[10] L3b 全链路(ZIP->canvas->zstd->kiwi) 自读 semantic-equal=${l3b}`);

  const report = {
    src,
    generatedAt: new Date().toISOString(),
    verdict: {
      l1_kiwi_byte_equal: l1Byte,
      l2_kiwi_semantic_equal: l2Sem,
      l3a_inner_canvas_readable: l3a,
      l3b_full_zip_roundtrip: l3b,
    },
    sizes: {
      orig_fig: outerBuf.length,
      roundtrip_fig: outSize,
      orig_canvas: canvasBuf.length,
      new_canvas: newCanvas.length,
      orig_data_inflated: dataInflated.length,
      re_encoded: reEncoded.length,
      orig_data_chunk_zstd: dataChunkRaw.length,
      new_data_chunk_zstd: newDataChunk.length,
    },
    risk: "canvas/thumbnail 已按原文件 STORE 打包、meta DEFLATE。L3b 自读 OK ≠ Figma 接受（循环验证边界）——1b 是唯一真验证。",
    nextStep: "Phase 1b：把 out/roundtrip.fig 拖进 Figma。渲染正常=write 全通；空/报错=查 kiwi 字段序(语义L2等但Figma实现可能敏感)或 images/目录差异。",
  };
  fs.writeFileSync(path.join(outDir, "roundtrip-report.json"), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
}

try {
  main();
} catch (e) {
  console.error("FATAL:", e.message);
  console.error(e.stack);
  process.exit(1);
}
