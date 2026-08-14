/**
 * Phase 1c：构造层验证——在 Message 层 mutate 节点，看 Figma 认不认
 *
 * 1a/1b 是原样回放（复用原 Figma 生成的合法 Message），只证包装层。
 * 1c 在 decode 出的 Message 上动手脚（改节点 name 加前缀），re-encode → 套 zstd+ZIP。
 * 若 Figma import 后图层面板出现 🧪1C· 前缀节点 = Figma 应用了我的 mutation = 真 write 构造能力证明。
 *
 * 选 name 作 mutation 靶点：inline string（不涉 blob/font），图层面板肉眼可见，风险最低。
 * 第一刀只改 name（全 string name 加前缀，信号最强）；改颜色/加节点留 1d。
 *
 * 验证层：
 *   L2'  mutate 后再 encode→decode deep-equal mutated msg（改名后结构仍合法）
 *   L3b' 全链路自读：mutated.fig 经 ZIP 读回的 message name 带 🧪1C· 前缀
 * （L2'/L3b' 通过 ≠ Figma 认，仍需 1c-人工 import 验真，同循环验证边界）
 *
 * Usage: node mutate-fig.mjs [path.fig]
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
const PREFIX = "🧪1C·";

// ---------- fig-kiwi archive parse / build（同 reencode-fig.mjs）----------
function parseArchive(buf) {
  const magic = buf.toString("latin1", 0, 8);
  if (magic !== MAGIC) throw new Error(`bad magic ${JSON.stringify(magic)}`);
  const version = buf.readUInt32LE(8);
  const chunks = [];
  let off = 12;
  while (off + 4 <= buf.length) {
    const size = buf.readUInt32LE(off); off += 4;
    if (off + size > buf.length) throw new Error(`chunk overrun at ${off}`);
    chunks.push({ size, data: Buffer.from(buf.subarray(off, off + size)) });
    off += size;
  }
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
  const zip = new AdmZip(outerBuf);
  const ent = Object.fromEntries(zip.getEntries().map((e) => [e.entryName, e]));
  const getE = (n) => { const e = ent[n]; if (!e) throw new Error(`ZIP 缺 ${n}`); return e.getData(); };
  const canvasBuf = getE("canvas.fig");
  const thumbnailBuf = getE("thumbnail.png");
  const metaBuf = getE("meta.json");

  const arc = parseArchive(canvasBuf);
  if (arc.chunks.length < 2) throw new Error(`需 >=2 chunks`);
  const schemaChunkRaw = arc.chunks[0].data;
  const dataChunkRaw = arc.chunks[1].data;
  const schemaInflated = zlib.inflateRawSync(schemaChunkRaw);
  const dataInflated = Buffer.from(fzstd.decompress(dataChunkRaw));

  const schema = decodeBinarySchema(new Uint8Array(schemaInflated));
  const compiled = compileSchema(schema);
  const origMsg = compiled.decodeMessage(new Uint8Array(dataInflated));
  log(`[2] decode OK；nodeChanges=${origMsg.nodeChanges?.length} blobs=${origMsg.blobs?.length}`);

  // ---- MUTATE：所有 string name 加前缀 ----
  const changes = origMsg.nodeChanges || [];
  let mutatedCount = 0;
  const sampleNames = [];
  for (const n of changes) {
    if (typeof n.name === "string" && n.name.length > 0) {
      n.name = PREFIX + n.name;
      mutatedCount++;
      if (sampleNames.length < 6) sampleNames.push(n.name);
    }
  }
  log(`[3] MUTATE：${mutatedCount}/${changes.length} 节点 name 加 "${PREFIX}" 前缀`);
  log(`    样本：${sampleNames.join(" | ")}`);
  if (mutatedCount === 0) throw new Error("没找到任何 string name 节点，检查 nodeChanges 结构");

  const mutatedMsg = origMsg;  // 原地改

  // ---- L2'：mutate 后 encode→decode 是否合法且等 mutated msg ----
  const reEncoded = compiled.encodeMessage(mutatedMsg);
  const reDecoded = compiled.decodeMessage(new Uint8Array(reEncoded));
  const l2mut = deepEqualMsg(reDecoded, mutatedMsg);
  // 进一步确认 name 前缀在 reDecoded 里还在
  let prefixSurvived = 0;
  for (const n of (reDecoded.nodeChanges || [])) {
    if (typeof n.name === "string" && n.name.startsWith(PREFIX)) prefixSurvived++;
  }
  log(`[4] L2' mutate 后 encode→decode semantic-equal=${l2mut}；前缀存活节点=${prefixSurvived}/${mutatedCount}`);

  // ---- packaging ----
  const newDataChunk = zlib.zstdCompressSync(Buffer.from(reEncoded));
  const newCanvas = buildArchive(arc.version, [schemaChunkRaw, newDataChunk]);

  const newZip = new AdmZip();
  const cE = newZip.addFile("canvas.fig", newCanvas); cE.header.method = 0;
  const tE = newZip.addFile("thumbnail.png", thumbnailBuf); tE.header.method = 0;
  newZip.addFile("meta.json", metaBuf);
  try { const dE = newZip.addFile("images/", Buffer.alloc(0)); if (dE) dE.header.method = 0; }
  catch (e) { log(`    (images/ dir skip: ${e.message})`); }
  const outPath = path.join(outDir, "mutated.fig");
  newZip.writeZip(outPath);
  const outSize = fs.statSync(outPath).size;
  log(`[5] wrote ${outPath} (${outSize} B)`);

  // ---- L3b'：mutated.fig 全链路自读，确认 name 带前缀 ----
  const rt = fs.readFileSync(outPath);
  const rz = new AdmZip(rt);
  const rCanvas = rz.getEntries().find((e) => e.entryName === "canvas.fig");
  const rArc = parseArchive(rCanvas.getData());
  const rData = Buffer.from(fzstd.decompress(rArc.chunks[1].data));
  const rMsg = compiled.decodeMessage(new Uint8Array(rData));
  let rPrefix = 0;
  for (const n of (rMsg.nodeChanges || [])) {
    if (typeof n.name === "string" && n.name.startsWith(PREFIX)) rPrefix++;
  }
  const l3b = rPrefix === mutatedCount;
  log(`[6] L3b' 全链路自读：带前缀节点=${rPrefix}/${mutatedCount} → ${l3b ? "OK" : "MISMATCH"}`);

  const report = {
    src,
    mutation: { field: "name", prefix: PREFIX, mutatedCount, totalNodes: changes.length, sampleNames },
    generatedAt: new Date().toISOString(),
    verdict: {
      l2_mutate_semantic_equal: l2mut,
      l2_prefix_survived_encode_decode: prefixSurvived === mutatedCount,
      l3b_full_zip_roundtrip_prefix_intact: l3b,
    },
    sizes: { orig_fig: outerBuf.length, mutated_fig: outSize, re_encoded: reEncoded.length },
    risk: "L2'/L3b' 自读带前缀 ≠ Figma 认。1c-人工 import 是唯一真验证。",
    nextStep: "把 out/mutated.fig 拖进 Figma。图层面板节点名带 🧪1C· 前缀 = 真 write 构造能力证明（Message 层 mutation 被 Figma 应用）。",
  };
  fs.writeFileSync(path.join(outDir, "mutated-report.json"), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
}

try { main(); } catch (e) {
  console.error("FATAL:", e.message);
  console.error(e.stack);
  process.exit(1);
}
