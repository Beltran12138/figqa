/**
 * 独立核实 v4（不依赖 Grok report）。合规：不打印 name 业务值/原始色，只打印结构与测试标记色数值。
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
  if (magic !== MAGIC) throw new Error(`bad magic`);
  const version = buf.readUInt32LE(8);
  const chunks = []; let off = 12;
  while (off + 4 <= buf.length) {
    const size = buf.readUInt32LE(off); off += 4;
    chunks.push({ size, data: Buffer.from(buf.subarray(off, off + size)) }); off += size;
  }
  return { magic, version, chunks };
}
function nodeTypeEnumMap(schema) {
  const def = (schema.definitions || []).find((d) => d.name === "NodeType");
  const n2i = {}, i2n = {};
  for (const f of def.fields || []) { n2i[f.name] = f.value; i2n[f.value] = f.name; }
  return { n2i, i2n };
}

const src = "./out/addnode-v4.fig";
const outer = fs.readFileSync(src);
const zip = new AdmZip(outer);
console.log("== ZIP ==");
for (const e of zip.getEntries()) console.log(`  ${e.entryName} method=${e.header.method} comp=${e.header.compressedSize}`);

const canvasE = zip.getEntries().find(e => e.entryName === "canvas.fig");
const arc = parseArchive(canvasE.getData());
const schema = decodeBinarySchema(new Uint8Array(zlib.inflateRawSync(arc.chunks[0].data)));
const { n2i, i2n } = nodeTypeEnumMap(schema);
const compiled = compileSchema(schema);
const msg = compiled.decodeMessage(new Uint8Array(fzstd.decompress(arc.chunks[1].data)));
const nc = msg.nodeChanges || [];
console.log(`\n== Message: nodeChanges=${nc.length} (期望1643) blobs=${(msg.blobs||[]).length} ==`);
console.log(`  NodeType: CANVAS=${n2i.CANVAS} FRAME=${n2i.FRAME}`);

// guid 唯一
const guids = nc.map(n => `${n.guid?.sessionID}:${n.guid?.localID}`);
const uniq = new Set(guids);
console.log(`\n== guid 唯一: total=${guids.length} unique=${uniq.size} dup=${guids.length-uniq.size} ==`);

// D 新节点 0:298
const huge = nc.find(n => n.guid?.sessionID === 0 && n.guid?.localID === 298);
console.log(`\n== D 新节点 0:298 ==`);
if (!huge) console.log("  NOT FOUND ❌");
else {
  const fc = huge.fillPaints?.[0]?.color;
  console.log(`  FOUND; size=${huge.size?.x}x${huge.size?.y} (期望2200x1600)`);
  console.log(`  transform m02=${huge.transform?.m02} m12=${huge.transform?.m12} (期望100/2200)`);
  console.log(`  parent=${huge.parentIndex?.guid?.sessionID}:${huge.parentIndex?.guid?.localID} (期望0:1)`);
  console.log(`  posCode=${huge.parentIndex?.position?.charCodeAt?.(0)} (期望44)`);
  console.log(`  hasFillPaints=${!!huge.fillPaints?.length} fillRGB=${fc?`${fc.r},${fc.g},${fc.b}`:"none"} (期望绿0,1,0)`);
  console.log(`  hasFillGeometry=${huge.fillGeometry!==undefined} (期望false=已删)`);
  console.log(`  fieldCount=${Object.keys(huge).length}`);
}

// canvas 0:1 下 position 碰撞（v1 blocker，v4 声称修）
const canvasKids = nc.filter(n => n.parentIndex?.guid?.sessionID===0 && n.parentIndex?.guid?.localID===1);
const posMap = {};
for (const n of canvasKids) { const p = n.parentIndex?.position||""; posMap[p]=(posMap[p]||0)+1; }
const collisions = Object.entries(posMap).filter(([,c])=>c>1);
console.log(`\n== canvas 0:1 position 碰撞: kids=${canvasKids.length} 碰撞组=${collisions.length} (期望0) ==`);

// B: CANVAS 节点 backgroundColor 品红
const canvases = nc.filter(n => { const t=n.type; const ti=typeof t==="number"?t:n2i[t]; return ti===n2i.CANVAS; });
let magentaCount = 0;
for (const c of canvases) { const bg=c.backgroundColor; if (bg && bg.r===1 && bg.g===0 && bg.b===1) magentaCount++; }
console.log(`\n== B: CANVAS 节点=${canvases.length} 品红背景=${magentaCount} (期望4) ==`);

// C: 0:1 下顶层 FRAME（排除新节点）fill 霓虹
const topFrames = nc.filter(n => {
  const t=n.type; const ti=typeof t==="number"?t:n2i[t];
  if (ti!==n2i.FRAME) return false;
  const pg=n.parentIndex?.guid;
  if (!(pg?.sessionID===0 && pg?.localID===1)) return false;
  if (n.guid?.sessionID===0 && n.guid?.localID===298) return false; // 排除 D 新节点
  return true;
});
let neonCount = 0;
for (const f of topFrames) {
  const col = f.fillPaints?.[0]?.color;
  if (!col) continue;
  if ((col.r===1&&col.g===0&&col.b===0)||(col.r===0&&col.g===1&&col.b===1)||(col.r===1&&col.g===1&&col.b===0)) neonCount++;
}
console.log(`\n== C: 顶层FRAME=${topFrames.length} 霓虹fill=${neonCount} (期望11) ==`);

// A: name 前缀计数（不打印 name 值，只数带 ■V4· 前缀的）
let prefixCount = 0;
for (const n of nc) if (typeof n.name==="string" && n.name.startsWith("■V4·")) prefixCount++;
console.log(`\n== A: name 带 ■V4· 前缀=${prefixCount} (期望1642) ==`);
