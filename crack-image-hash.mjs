/**
 * P0 破 hash：确定 .fig 里 images/ 文件名 与 图片字节 的摘要关系。
 * 输入一个「带图」.fig，对每张图算 md5/sha1/sha256，与 ZIP 里文件名 + Paint.image.hash 比对。
 *
 * 合规：只输出 hash 值/文件名/尺寸，绝不输出图片内容或任何设计文本。
 *
 * Usage: node crack-image-hash.mjs <path-with-image.fig>
 */
import fs from "node:fs";
import zlib from "node:zlib";
import crypto from "node:crypto";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const { decodeBinarySchema, compileSchema } = require("kiwi-schema");
const AdmZip = require("adm-zip");
const fzstd = require("fzstd");

const MAGIC = "fig-kiwi";
function parseArchive(buf) {
  if (buf.toString("latin1", 0, 8) !== MAGIC) throw new Error("bad magic");
  const chunks = []; let off = 12;
  while (off + 4 <= buf.length) { const s = buf.readUInt32LE(off); off += 4; chunks.push(Buffer.from(buf.subarray(off, off + s))); off += s; }
  return { chunks };
}
function digests(buf) {
  return {
    md5: crypto.createHash("md5").update(buf).digest("hex"),
    sha1: crypto.createHash("sha1").update(buf).digest("hex"),
    sha256: crypto.createHash("sha256").update(buf).digest("hex"),
  };
}
function enumI2N(schema, name) {
  const def = (schema.definitions || []).find((d) => d.name === name);
  const m = {}; for (const f of def?.fields || []) m[f.value] = f.name; return m;
}

function main() {
  const src = process.argv[2];
  if (!src) { console.error("Usage: node crack-image-hash.mjs <path.fig>"); process.exit(1); }
  const outer = fs.readFileSync(src);
  const zip = new AdmZip(outer);
  const out = { src, images: [], paintHashes: [], verdict: null };

  // ---- ZIP images/ 文件：文件名 + 三种摘要 ----
  const imgEntries = zip.getEntries().filter((e) => e.entryName.startsWith("images/") && !e.isDirectory);
  for (const e of imgEntries) {
    const data = e.getData();
    const nameOnly = e.entryName.replace(/^images\//, "");
    out.images.push({ file: nameOnly, size: data.length, ...digests(data) });
  }

  // ---- Paint.image.hash（byte[] → hex）----
  const canvasE = zip.getEntries().find((e) => e.entryName.endsWith("canvas.fig"));
  const arc = parseArchive(canvasE.getData());
  const schema = decodeBinarySchema(new Uint8Array(zlib.inflateRawSync(arc.chunks[0])));
  const c1 = arc.chunks[1];
  const data = (c1[0] === 0x28 && c1[1] === 0xb5) ? Buffer.from(fzstd.decompress(c1)) : zlib.inflateRawSync(c1);
  const compiled = compileSchema(schema);
  const msg = compiled.decodeMessage(new Uint8Array(data));
  const paintI2N = enumI2N(schema, "PaintType");
  const seen = new Set();
  for (const n of msg.nodeChanges || []) {
    for (const p of [...(n.fillPaints || []), ...(n.strokePaints || [])]) {
      const tName = typeof p?.type === "number" ? paintI2N[p.type] : p?.type;
      if (tName !== "IMAGE") continue;
      const h = p.image?.hash;
      if (!h) continue;
      const hex = Buffer.from(h).toString("hex");
      if (seen.has(hex)) continue; seen.add(hex);
      out.paintHashes.push({ hashHex: hex, hashLen: h.length, scaleMode: typeof p.imageScaleMode === "number" ? enumI2N(schema, "ImageScaleMode")[p.imageScaleMode] : p.imageScaleMode, origW: p.originalImageWidth, origH: p.originalImageHeight });
    }
  }

  // ---- 判定：文件名/paint.hash 命中哪种摘要 ----
  const checks = [];
  for (const img of out.images) {
    const fnameStem = img.file.replace(/\.[a-z]+$/i, "").toLowerCase();
    for (const algo of ["md5", "sha1", "sha256"]) {
      if (img[algo] === fnameStem) checks.push(`images/ 文件名 == ${algo}(bytes)`);
    }
    for (const ph of out.paintHashes) {
      for (const algo of ["md5", "sha1", "sha256"]) {
        if (img[algo] === ph.hashHex.toLowerCase()) checks.push(`Paint.image.hash == ${algo}(bytes)`);
      }
      if (ph.hashHex.toLowerCase() === fnameStem) checks.push("Paint.image.hash == images/ 文件名");
    }
  }
  out.verdict = checks.length ? [...new Set(checks)] : "未命中已知摘要（需扩展算法：sha1前N字节/其它）";
  console.log(JSON.stringify(out, null, 2));
}
try { main(); } catch (e) { console.error("FATAL:", e.message); console.error(e.stack); process.exit(1); }
