/**
 * 第一层脚本验收：几何越界检查（不靠视觉）。
 * 读 .fig，算每个可见节点 bbox，报告：①越出画布 root frame ②文字疑似越出所在卡片矩形。
 * 局限：TEXT size 是生成时估算值，Figma 重算后可能不同 → 只挡「明显越界」，非像素级。
 * Usage: node geom-check.mjs <path.fig>
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
  const version = buf.readUInt32LE(8); const chunks = []; let off = 12;
  while (off + 4 <= buf.length) { const s = buf.readUInt32LE(off); off += 4; chunks.push(Buffer.from(buf.subarray(off, off + s))); off += s; }
  return { version, chunks };
}
const zip = new AdmZip(fs.readFileSync(process.argv[2]));
const canvasE = zip.getEntries().find((e) => e.entryName.endsWith("canvas.fig"));
const arc = parseArchive(canvasE.getData());
const schema = decodeBinarySchema(new Uint8Array(zlib.inflateRawSync(arc.chunks[0])));
const compiled = compileSchema(schema);
const c1 = arc.chunks[1];
const data = (c1[0] === 0x28 && c1[1] === 0xb5) ? Buffer.from(fzstd.decompress(c1)) : zlib.inflateRawSync(c1);
const msg = compiled.decodeMessage(new Uint8Array(data));
const nc = msg.nodeChanges || [];

const bbox = (n) => n.size && n.transform ? { x: n.transform.m02, y: n.transform.m12, w: n.size.x, h: n.size.y, r: n.transform.m02 + n.size.x, b: n.transform.m12 + n.size.y } : null;
const root = nc.find((n) => n.type === "FRAME");
const rb = bbox(root);
const cards = nc.filter((n) => n.type === "ROUNDED_RECTANGLE" && n.size && n.size.x > 200); // 大矩形=卡片容器
const texts = nc.filter((n) => n.type === "TEXT");

let warn = 0;
console.log(`画布 root: ${rb.w}x${rb.h}`);
// ① 越出画布
for (const n of [...texts, ...nc.filter(n => n.type === "ROUNDED_RECTANGLE")]) {
  const b = bbox(n); if (!b) continue;
  if (b.x < rb.x - 0.5 || b.y < rb.y - 0.5 || b.r > rb.r + 0.5 || b.b > rb.b + 0.5) {
    console.log(`  ⚠ 越出画布: [${n.type}] "${(n.textData?.characters || n.name || "").slice(0, 16)}" bbox=(${b.x.toFixed(0)},${b.y.toFixed(0)},${b.r.toFixed(0)},${b.b.toFixed(0)})`);
    warn++;
  }
}
// ② 文字越出其所在卡片（按 y 区间归属最近卡片）
for (const t of texts) {
  const b = bbox(t); if (!b) continue;
  const host = cards.find((c) => { const cb = bbox(c); return b.y >= cb.y - 2 && b.b <= cb.b + 20 && b.x >= cb.x - 2; });
  if (host) { const cb = bbox(host); if (b.r > cb.r + 0.5) { console.log(`  ⚠ 文字右溢出卡片: "${t.textData?.characters?.slice(0, 16)}" textR=${b.r.toFixed(0)} cardR=${cb.r.toFixed(0)}`); warn++; } }
}
console.log(warn === 0 ? "✓ 无明显几何越界（估算级）" : `发现 ${warn} 处疑似越界（估算级，需 Figma 目验确认）`);
