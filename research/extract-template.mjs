/**
 * 从中性 .fig 提取各节点类型的完整字段集，作为从零构造的字段脚手架模板。
 * 只输出格式结构（字段名+值），用于理解「一个 TEXT/FRAME/RECT 节点需要哪些字段」。
 * Usage: node extract-template.mjs <template.fig> [outJson]
 */
import fs from "node:fs";
import zlib from "node:zlib";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const { decodeBinarySchema, compileSchema } = require("kiwi-schema");
const AdmZip = require("adm-zip");
const fzstd = require("fzstd");

const MAGIC = "fig-kiwi";
function parseArchive(buf) {
  if (buf.toString("latin1", 0, 8) !== MAGIC) throw new Error("bad magic");
  const version = buf.readUInt32LE(8);
  const chunks = []; let off = 12;
  while (off + 4 <= buf.length) { const s = buf.readUInt32LE(off); off += 4; chunks.push(Buffer.from(buf.subarray(off, off + s))); off += s; }
  return { version, chunks };
}

const src = process.argv[2];
const outJson = process.argv[3] || "/tmp/template-nodes.json";
const zip = new AdmZip(fs.readFileSync(src));
const canvasE = zip.getEntries().find((e) => e.entryName.endsWith("canvas.fig"));
const arc = parseArchive(canvasE.getData());
const schema = decodeBinarySchema(new Uint8Array(zlib.inflateRawSync(arc.chunks[0])));
const compiled = compileSchema(schema);
const c1 = arc.chunks[1];
const dataBytes = (c1[0] === 0x28 && c1[1] === 0xb5) ? Buffer.from(fzstd.decompress(c1)) : zlib.inflateRawSync(c1);
const msg = compiled.decodeMessage(new Uint8Array(dataBytes));
const nc = msg.nodeChanges || [];

// 每种 type 取第一个节点，输出完整字段（Buffer→hex 摘要以免噪音）
function clean(v) {
  if (v instanceof Uint8Array || Buffer.isBuffer(v)) return { __bytes: v.length };
  if (Array.isArray(v)) return v.map(clean);
  if (v && typeof v === "object") { const o = {}; for (const [k, x] of Object.entries(v)) o[k] = clean(x); return o; }
  return v;
}
const byType = {};
for (const n of nc) { const t = n.type || "?"; if (!byType[t]) byType[t] = clean(n); }
const out = { version: arc.version, types: Object.keys(byType), fieldNamesByType: {}, samples: byType };
for (const [t, node] of Object.entries(byType)) out.fieldNamesByType[t] = Object.keys(node).sort();
fs.writeFileSync(outJson, JSON.stringify(out, null, 2));
console.log("version", arc.version, "types", Object.keys(byType).join(","));
console.log("wrote", outJson, fs.statSync(outJson).size, "bytes");
