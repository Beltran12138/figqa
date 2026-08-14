/**
 * Extract screen inventory + per-screen TEXT from a raw canvas.fig (pure read).
 * Usage: node extract-screens.mjs <canvas.fig> [out.md]
 */
import fs from "node:fs";
import zlib from "node:zlib";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const { decodeBinarySchema, compileSchema } = require("kiwi-schema");
const fzstd = require("fzstd");

const inPath = process.argv[2];
const outPath = process.argv[3] || "out/screens.md";

const buf = fs.readFileSync(inPath);
if (buf.toString("latin1", 0, 8) !== "fig-kiwi") throw new Error("not raw fig-kiwi (extract canvas.fig first)");
// chunks
const chunks = [];
let off = 12;
while (off + 4 <= buf.length) {
  const size = buf.readUInt32LE(off); off += 4;
  chunks.push(Buffer.from(buf.subarray(off, off + size))); off += size;
}
const infl = (d) => (d[0] === 0x28 && d[1] === 0xb5 ? Buffer.from(fzstd.decompress(d)) : zlib.inflateRawSync(d));
const schema = decodeBinarySchema(new Uint8Array(infl(chunks[0])));
const compiled = compileSchema(schema);
const msg = compiled.decodeMessage(new Uint8Array(infl(chunks[1])));
const nodes = msg.nodeChanges || [];
const g = (x) => (x ? `${x.sessionID}:${x.localID}` : null);

// index
const byGuid = new Map();
const children = new Map(); // parentGuid -> [ {guid,pos} ]
for (const n of nodes) {
  const id = g(n.guid);
  byGuid.set(id, n);
}
for (const n of nodes) {
  const p = n.parentIndex ? g(n.parentIndex.guid) : null;
  if (!p) continue;
  if (!children.has(p)) children.set(p, []);
  children.get(p).push({ id: g(n.guid), pos: n.parentIndex.position });
}
// text field probe (first TEXT node keys)
const firstText = nodes.find((n) => n.type === "TEXT");
if (firstText) fs.writeFileSync("out/_text_keys.json", JSON.stringify(Object.keys(firstText), null, 2));
const textOf = (n) => {
  const t = n.textData?.characters ?? n.characters ?? null;
  return typeof t === "string" ? t.replace(/\s+/g, " ").trim() : null;
};

// type counts
const tc = {};
for (const n of nodes) tc[n.type || "?"] = (tc[n.type || "?"] || 0) + 1;

// find CANVAS nodes -> their FRAME children = screens
const canvases = nodes.filter((n) => n.type === "CANVAS");
function descendants(id, acc = []) {
  const kids = children.get(id) || [];
  for (const k of kids) {
    const node = byGuid.get(k.id);
    if (!node) continue;
    acc.push(node);
    descendants(k.id, acc);
  }
  return acc;
}
const AREA_MIN = 150000; // ~ >= 大屏 (e.g. 1200x800 部分)
const lines = [];
lines.push(`# ${inPath} — 屏幕 + 文字提取`);
lines.push(`节点总数 ${nodes.length} ｜ 类型 ${JSON.stringify(tc)}`);
lines.push(`Pages(CANVAS): ${canvases.map((c) => c.name || "(无名)").join(" / ")}`);
lines.push("");
let screenNo = 0;
for (const cv of canvases) {
  const cvId = g(cv.guid);
  const topFrames = (children.get(cvId) || [])
    .map((k) => byGuid.get(k.id))
    .filter((n) => n && n.type === "FRAME" && n.size && n.size.x * n.size.y >= AREA_MIN)
    .sort((a, b) => b.size.x * b.size.y - a.size.x * a.size.y);
  if (!topFrames.length) continue;
  lines.push(`\n# ══ Page: ${cv.name || "(无名)"} （${topFrames.length} 屏）══`);
  for (const fr of topFrames) {
    screenNo++;
    const desc = descendants(g(fr.guid));
    const texts = [];
    const selfT = textOf(fr);
    if (selfT) texts.push(selfT);
    for (const d of desc) { const t = textOf(d); if (t) texts.push(t); }
    const uniq = [...new Set(texts)];
    const w = fr.size ? `${Math.round(fr.size.x)}×${Math.round(fr.size.y)}` : "?";
    lines.push(`## [屏 ${screenNo}] ${fr.name || "(无名)"}  (${w}, ${uniq.length} 唯一文字)`);
    if (uniq.length) {
      lines.push("```");
      lines.push(uniq.slice(0, 120).join(" | "));
      lines.push("```");
    }
    lines.push("");
  }
}
fs.mkdirSync("out", { recursive: true });
fs.writeFileSync(outPath, lines.join("\n"));
console.log(JSON.stringify({ ok: true, screens: screenNo, canvases: canvases.length, typeCounts: tc, out: outPath }, null, 2));
