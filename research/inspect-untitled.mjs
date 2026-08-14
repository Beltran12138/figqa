/**
 * 只读核实 Untitled.fig 现状：节点数/类型分布/是否有 TEXT 模板（决定模式3种子策略）。
 * 合规：只打印结构与字段名，不打印 characters 原文。
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
  while (off + 4 <= buf.length) {
    const size = buf.readUInt32LE(off); off += 4;
    chunks.push({ size, data: Buffer.from(buf.subarray(off, off + size)) }); off += size;
  }
  return { version, chunks };
}
function typeMap(schema) {
  const def = (schema.definitions || []).find(d => d.name === "NodeType");
  const n2i = {}, i2n = {};
  for (const f of def.fields || []) { n2i[f.name] = f.value; i2n[f.value] = f.name; }
  return { n2i, i2n };
}
const ti = (n) => typeof n.type === "number" ? n.type : n2i_global[n.type];
let n2i_global, i2n_global;

const src = "./untitled.fig";
const buf = fs.readFileSync(src);
console.log(`== file size ${buf.length} bytes ==`);
const zip = new AdmZip(buf);
console.log("== ZIP entries ==");
for (const e of zip.getEntries()) console.log(`  ${e.entryName} method=${e.header.method} comp=${e.header.compressedSize}`);

const canvasE = zip.getEntries().find(e => e.entryName === "canvas.fig");
if (!canvasE) { console.log("NO canvas.fig — 非 fig 文件"); process.exit(1); }
const arc = parseArchive(canvasE.getData());
console.log(`\n== fig-kiwi version=${arc.version} chunks=${arc.chunks.length} ==`);

const schema = decodeBinarySchema(new Uint8Array(zlib.inflateRawSync(arc.chunks[0].data)));
({ n2i: n2i_global, i2n: i2n_global } = typeMap(schema));
const msg = compileSchema(schema).decodeMessage(new Uint8Array(fzstd.decompress(arc.chunks[1].data)));
const nc = msg.nodeChanges || [];
console.log(`\n== nodeChanges=${nc.length} blobs=${(msg.blobs||[]).length} ==`);

const tc = {};
for (const n of nc) { const nm = i2n_global[ti(n)] || `?${ti(n)}`; tc[nm] = (tc[nm]||0)+1; }
console.log("== type 分布 ==");
for (const [k,v] of Object.entries(tc).sort((a,b)=>b[1]-a[1])) console.log(`  ${k}: ${v}`);

const texts = nc.filter(n => i2n_global[ti(n)] === "TEXT");
console.log(`\n== TEXT=${texts.length}（>0 则半克隆有种子）==`);
if (texts.length) {
  console.log(`  首个TEXT字段集(${Object.keys(texts[0]).length}字段): ${Object.keys(texts[0]).join(",")}`);
}
const frames = nc.filter(n => i2n_global[ti(n)] === "FRAME").length;
const rrs = nc.filter(n => i2n_global[ti(n)] === "ROUNDED_RECTANGLE").length;
console.log(`== FRAME=${frames} RR=${rrs} ==`);

// 现有节点的 size/transform 样本（看有无现成布局可参考，不打印 name）
if (nc.length > 2) {
  const sample = nc.find(n => i2n_global[ti(n)] === "FRAME") || nc[2];
  console.log(`\n== 样本节点 size=${sample.size?.x}x${sample.size?.y} transform=(${sample.transform?.m02},${sample.transform?.m12}) ==`);
}
