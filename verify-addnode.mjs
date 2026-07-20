/**
 * 独立核实 Grok 产出的 addnode.fig（不依赖其 report，自己 decode 验）
 * 合规：stdout 只打印结构/数值，不打印 name/颜色等业务内容
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
  const magic = buf.toString("latin1", 0, 8);
  if (magic !== MAGIC) throw new Error(`bad magic ${JSON.stringify(magic)}`);
  const version = buf.readUInt32LE(8);
  const chunks = []; let off = 12;
  while (off + 4 <= buf.length) {
    const size = buf.readUInt32LE(off); off += 4;
    chunks.push({ size, data: Buffer.from(buf.subarray(off, off + size)) }); off += size;
  }
  return { magic, version, chunks };
}

const src = "./out/addnode.fig";
const outer = fs.readFileSync(src);
const zip = new AdmZip(outer);
const entries = zip.getEntries().map(e => ({
  name: e.entryName, method: e.header.method,
  comp: e.header.compressedSize, uncomp: e.header.uncompressedSize,
}));
console.log("== ZIP entries ==");
for (const e of entries) console.log(`  ${e.name} method=${e.method} comp=${e.comp} uncomp=${e.uncomp}`);

const canvasE = zip.getEntries().find(e => e.entryName === "canvas.fig");
if (!canvasE) { console.error("FAIL: no canvas.fig"); process.exit(1); }
const arc = parseArchive(canvasE.getData());
console.log(`\n== fig-kiwi = magic=${arc.magic} version=${arc.version} chunks=${arc.chunks.length}`);

const schema = decodeBinarySchema(new Uint8Array(zlib.inflateRawSync(arc.chunks[0].data)));
const compiled = compileSchema(schema);
const data = Buffer.from(fzstd.decompress(arc.chunks[1].data));
const msg = compiled.decodeMessage(new Uint8Array(data));
const nc = msg.nodeChanges || [];
console.log(`\n== Message ==`);
console.log(`  nodeChanges=${nc.length} (源 1642，期望 1643)`);
console.log(`  blobs=${(msg.blobs||[]).length}`);

// 找新节点 88:298
const found = nc.find(n => n.guid && n.guid.sessionID === 88 && n.guid.localID === 298);
console.log(`\n== 新节点 88:298 ==`);
if (!found) { console.log("  NOT FOUND — FAIL"); }
else {
  console.log("  FOUND ✅");
  console.log(`  has name field: ${"name" in found} (value redacted)`);
  console.log(`  parentIndex.guid: ${JSON.stringify(found.parentIndex?.guid)} (期望指向 5:2)`);
  console.log(`  parentIndex.position length: ${(found.parentIndex?.position||"").length}`);
  console.log(`  transform.m02=${found.transform?.m02} m12=${found.transform?.m12} (期望 2000/200)`);
  console.log(`  size: ${JSON.stringify(found.size)} (期望 ~28x28)`);
  console.log(`  field count: ${Object.keys(found).length}`);
  console.log(`  field names: ${Object.keys(found).join(",")}`);
}
// 克隆源 88:5 仍在
const orig = nc.find(n => n.guid && n.guid.sessionID === 88 && n.guid.localID === 5);
console.log(`\n== 克隆源 88:5 仍存在: ${!!orig ? "✅" : "❌"} ==`);

// guid 唯一性
const guids = nc.map(n => `${n.guid?.sessionID}:${n.guid?.localID}`);
const uniq = new Set(guids);
console.log(`\n== guid 唯一性: total=${guids.length} unique=${uniq.size} dup=${guids.length - uniq.size} ==`);

// position 碰撞核查（同 parent 5:2 下）
const sameParent = nc.filter(n => n.parentIndex?.guid?.sessionID === 5 && n.parentIndex?.guid?.localID === 2);
const posCounts = {};
for (const n of sameParent) {
  const p = n.parentIndex?.position || "";
  posCounts[p] = (posCounts[p] || 0) + 1;
}
const collisions = Object.entries(posCounts).filter(([, c]) => c > 1);
console.log(`\n== parent 5:2 下 position 碰撞: ${collisions.length} 个 position 值被多个节点共用 ==`);
if (collisions.length) console.log(`  (碰撞的 position 长度: ${collisions.map(c=>c[0].length).join(",")})`);
