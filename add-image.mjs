/**
 * P0 写侧闭环：往 .fig 加一张全新图片填充。
 * 机制（实证）：图片字节 → ZIP images/<sha1hex>；节点 fillPaints 加
 *   Paint{ type:IMAGE, image:{hash:<sha1 20B>}, imageScaleMode:FILL, originalImageWidth/Height }
 *
 * 默认自造一张纯色 PNG（无需外部素材）；也可传图片路径。
 * 产物 out/addimage.fig 交人工 import 验证（图片正常渲染 = P0 通）。
 *
 * Usage: node add-image.mjs <base.fig> [imagePath]
 */
import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const { decodeBinarySchema, compileSchema } = require("kiwi-schema");
const AdmZip = require("adm-zip");
const fzstd = require("fzstd");

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const MAGIC = "fig-kiwi";

function parseArchive(buf) {
  if (buf.toString("latin1", 0, 8) !== MAGIC) throw new Error("bad magic");
  const version = buf.readUInt32LE(8);
  const chunks = []; let off = 12;
  while (off + 4 <= buf.length) { const s = buf.readUInt32LE(off); off += 4; chunks.push(Buffer.from(buf.subarray(off, off + s))); off += s; }
  return { version, chunks };
}
function buildArchive(version, chunkBufs) {
  const parts = [Buffer.from(MAGIC, "latin1")];
  const v = Buffer.alloc(4); v.writeUInt32LE(version, 0); parts.push(v);
  for (const cb of chunkBufs) { const sz = Buffer.alloc(4); sz.writeUInt32LE(cb.length, 0); parts.push(sz, cb); }
  return Buffer.concat(parts);
}
// 自造纯色 PNG（8bit RGB），确定性、合法
function makeSolidPng(w, h, [r, g, b]) {
  const sig = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  const crc = (buf) => { const c = Buffer.alloc(4); c.writeUInt32BE(zlib.crc32(buf) >>> 0, 0); return c; };
  const chunk = (type, data) => {
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length, 0);
    const td = Buffer.concat([Buffer.from(type, "latin1"), data]);
    return Buffer.concat([len, td, crc(td)]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 2;
  const rowPix = Buffer.from(Array.from({ length: w }, () => [r, g, b]).flat());
  const raw = Buffer.concat(Array.from({ length: h }, () => Buffer.concat([Buffer.from([0]), rowPix])));
  const idat = zlib.deflateSync(raw);
  return Buffer.concat([sig, chunk("IHDR", ihdr), chunk("IDAT", idat), chunk("IEND", Buffer.alloc(0))]);
}

function main() {
  const log = (...a) => console.error(...a);
  const base = process.argv[2];
  if (!base) { console.error("Usage: node add-image.mjs <base.fig> [imagePath]"); process.exit(1); }
  const imgPath = process.argv[3];
  const IMG_W = 400, IMG_H = 400;
  const imgBytes = imgPath ? fs.readFileSync(imgPath) : makeSolidPng(IMG_W, IMG_H, [220, 40, 40]);
  const sha1 = crypto.createHash("sha1").update(imgBytes).digest();       // 20 字节 Buffer
  const sha1hex = sha1.toString("hex");
  log(`[1] 新图 ${imgBytes.length}B sha1=${sha1hex}`);

  const outer = fs.readFileSync(base);
  const zip = new AdmZip(outer);
  const entries = zip.getEntries();
  const canvasE = entries.find((e) => e.entryName.endsWith("canvas.fig"));
  const arc = parseArchive(canvasE.getData());
  const schema = decodeBinarySchema(new Uint8Array(zlib.inflateRawSync(arc.chunks[0])));
  const compiled = compileSchema(schema);
  const c1 = arc.chunks[1];
  const dataBytes = (c1[0] === 0x28 && c1[1] === 0xb5) ? Buffer.from(fzstd.decompress(c1)) : zlib.inflateRawSync(c1);
  const msg = compiled.decodeMessage(new Uint8Array(dataBytes));
  const nc = msg.nodeChanges || [];
  log(`[2] decode OK nodeChanges=${nc.length}`);

  // 选目标（放宽）：①已有 IMAGE 填充的节点（换图）②任意有 fillPaints 的③任意有 size 的
  let target = null;
  for (const n of nc) if ((n.fillPaints || []).some((p) => p.type === "IMAGE")) { target = n; break; }
  if (!target) for (const n of nc) if ((n.fillPaints || []).length) { target = n; break; }
  if (!target) { let area = -1; for (const n of nc) { if (!n.size) continue; const a = (n.size.x || 0) * (n.size.y || 0); if (a > area) { area = a; target = n; } } }
  if (!target) throw new Error(`找不到可填充目标；节点 types=${nc.map((n) => n.type).join(",")}`);
  const imagePaint = {
    type: "IMAGE",
    image: { hash: sha1 },
    imageScaleMode: "FILL",
    originalImageWidth: imgPath ? IMG_W : IMG_W,   // 未知真实尺寸时用占位；纯色图用 IMG_W/H
    originalImageHeight: imgPath ? IMG_H : IMG_H,
    opacity: 1,
    visible: true,
    blendMode: "NORMAL",
  };
  target.fillPaints = [imagePaint];
  log(`[3] 目标 FRAME guid=${target.guid?.sessionID}:${target.guid?.localID} size=${target.size.x}x${target.size.y} → fill=IMAGE`);

  // re-encode
  const reEncoded = Buffer.from(compiled.encodeMessage(msg));
  const newDataChunk = zlib.zstdCompressSync(reEncoded);
  const newCanvas = buildArchive(arc.version, [arc.chunks[0], newDataChunk]);
  log(`[4] re-encode msg=${reEncoded.length}B canvas=${newCanvas.length}B`);

  // 重打包 ZIP：canvas 换新、原 images/ 保留、加新图、thumbnail/meta 沿用
  const outDir = path.join(__dirname, "out");
  fs.mkdirSync(outDir, { recursive: true });
  const nz = new AdmZip();
  const put = (name, data, store) => { const e = nz.addFile(name, data); if (store) e.header.method = 0; };
  for (const e of entries) {
    if (e.isDirectory) { try { const d = nz.addFile(e.entryName, Buffer.alloc(0)); d.header.method = 0; } catch {} continue; }
    if (e.entryName.endsWith("canvas.fig")) continue;           // 换新
    const isImg = e.entryName.startsWith("images/");
    const isThumb = e.entryName === "thumbnail.png";
    put(e.entryName, e.getData(), isImg || isThumb);            // 图片类 STORE，其余(meta)默认 DEFLATE
  }
  put("canvas.fig", newCanvas, true);                           // STORE
  put(`images/${sha1hex}`, imgBytes, true);                     // 新图 STORE
  const outPath = path.join(outDir, "addimage.fig");
  nz.writeZip(outPath);
  log(`[5] wrote ${outPath} (${fs.statSync(outPath).size}B)`);

  console.log(JSON.stringify({ ok: true, out: outPath, newImageSha1: sha1hex, targetFrame: `${target.guid?.sessionID}:${target.guid?.localID}`, scaleMode: "FILL" }, null, 2));
}
try { main(); } catch (e) { console.error("FATAL:", e.message); console.error(e.stack); process.exit(1); }
