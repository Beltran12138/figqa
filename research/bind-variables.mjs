/**
 * Phase 1g — write side: bind hard-coded paint colors to existing color VARIABLES,
 * offline, with no Figma runtime / plugin / account.
 *
 * Why this matters: Figma's REST API can *read* `boundVariables` but cannot *create*
 * bindings (POST /v1/files/:key/variables only accepts variableCollections /
 * variableModes / variables / variableModeValues). Plugin API can bind, but needs an
 * editor runtime driven by a human or agent. Writing the `.fig` is the only headless path.
 *
 * Mechanism (read-side evidence from a real file, see probe-variables.mjs):
 *   unbound paint = { type, color, opacity, visible, blendMode }
 *   bound   paint = same + colorVar: {
 *       value: { alias: { guid: <VARIABLE node guid> } },
 *       dataType: "ALIAS", resolvedDataType: "COLOR" }
 *   The delta is exactly one additive field; `color` (resolved value) is retained.
 *
 * Usage:
 *   node bind-variables.mjs <in.fig> [out.fig] [--limit N] [--dry]
 */
import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { decodeBinarySchema, compileSchema } = require("kiwi-schema");
const AdmZip = require("adm-zip");
const fzstd = require("fzstd");

const MAGIC = "fig-kiwi";
const argv = process.argv.slice(2);
const inPath = argv[0];
const outPath = argv.find((a, i) => i > 0 && !a.startsWith("--")) || "out/bound.fig";
const limitArg = argv.find((a) => a.startsWith("--limit"));
const LIMIT = limitArg ? Number(limitArg.split("=")[1] || argv[argv.indexOf(limitArg) + 1]) : Infinity;
const DRY = argv.includes("--dry");
if (!inPath) throw new Error("usage: node bind-variables.mjs <in.fig> [out.fig] [--limit N] [--dry]");

const MARK = argv.includes("--mark");        // positive control: prefix bound nodes' names
const ALLOW_LIB = argv.includes("--allow-library");
const log = (...a) => console.log(...a);
// NOTE: alpha is part of the identity. Matching on RGB alone bound #FFFFFF(a=1) paints to a
// library variable whose value is rgba(1,1,1,0.9) — wrong even if Figma had accepted it.
const hex = (c) => "#" + [c.r, c.g, c.b].map((v) => Math.round(v * 255).toString(16).padStart(2, "0")).join("").toUpperCase()
  + (c.a === undefined || Math.abs(c.a - 1) < 1e-6 ? "" : Math.round(c.a * 255).toString(16).padStart(2, "0").toUpperCase());

function inflateChunk(d) {
  if (d[0] === 0x28 && d[1] === 0xb5 && d[2] === 0x2f && d[3] === 0xfd) return Buffer.from(fzstd.decompress(d));
  try { return zlib.inflateRawSync(d); } catch { return Buffer.from(fzstd.decompress(d)); }
}
function parseArchive(buf) {
  if (buf.toString("latin1", 0, 8) !== MAGIC) throw new Error("not fig-kiwi");
  const version = buf.readUInt32LE(8);
  const chunks = [];
  let off = 12;
  while (off + 4 <= buf.length) {
    const len = buf.readUInt32LE(off); off += 4;
    if (len === 0 || off + len > buf.length) break;
    chunks.push(buf.subarray(off, off + len)); off += len;
  }
  return { version, chunks };
}
function buildArchive(version, chunks) {
  const head = Buffer.alloc(12);
  head.write(MAGIC, 0, "latin1");
  head.writeUInt32LE(version, 8);
  const parts = [head];
  for (const c of chunks) {
    const l = Buffer.alloc(4); l.writeUInt32LE(c.length, 0);
    parts.push(l, Buffer.from(c));
  }
  return Buffer.concat(parts);
}

// ---------- read ----------
const outerBuf = fs.readFileSync(inPath);
const isZip = outerBuf[0] === 0x50 && outerBuf[1] === 0x4b;
if (!isZip) throw new Error("expects a real .fig (ZIP container), not a bare canvas.fig");
const zip = new AdmZip(outerBuf);
const entries = zip.getEntries();
const canvasEntry = entries.find((e) => e.entryName.endsWith("canvas.fig"));
if (!canvasEntry) throw new Error("no canvas.fig in ZIP");

const arc = parseArchive(canvasEntry.getData());
const schemaChunkRaw = arc.chunks[0];
const schema = decodeBinarySchema(inflateChunk(schemaChunkRaw));
const compiled = compileSchema(schema);
const msg = compiled.decodeMessage(inflateChunk(arc.chunks[1]));
const nodes = msg.nodeChanges || [];
log(`[1] ${path.basename(inPath)}: ${nodes.length} nodeChanges, ${(msg.blobs || []).length} blobs, ${entries.length} zip entries`);

// ---------- index color variables ----------
// A VARIABLE node holds its value per mode in variableDataValues.entries[].variableData.value.colorValue
// LOCAL vs LIBRARY is the whole ballgame. A library-backed variable is a cached copy:
// it carries sourceLibraryKey and its variableSetID points at an { assetRef } instead of a
// { guid }. Referencing such a variable by guid produces a binding Figma cannot resolve, and
// it silently falls back to the raw color — which is exactly what the first 1g run hit.
const isLocalVar = (n) => !n.sourceLibraryKey && !n.variableSetID?.assetRef && !!n.variableSetID?.guid;
const varIndex = new Map();   // hex -> {guid, name}
const varList = [];
for (const n of nodes) {
  if (n.type !== "VARIABLE" || !n.variableDataValues || !n.guid) continue;
  const local = isLocalVar(n);
  for (const e of n.variableDataValues.entries || []) {
    const cv = e.variableData?.value?.colorValue;
    if (!cv) continue;
    const h = hex(cv);
    varList.push({ hex: h, name: n.name, guid: n.guid, local });
    if (!(local || ALLOW_LIB)) continue;
    if (!varIndex.has(h)) varIndex.set(h, { guid: n.guid, name: n.name, local });
  }
}
log(`[2] color variables: ${varList.length} total, ${varList.filter((v) => v.local).length} local, ${varList.filter((v) => !v.local).length} library-backed`);
for (const v of varList) log(`      ${v.local ? "LOCAL  " : "library"} ${v.hex.padEnd(9)} ${v.name}  guid=${v.guid.sessionID}:${v.guid.localID}`);
log(`    bindable index (${ALLOW_LIB ? "local+library" : "local only"}): ${varIndex.size} distinct colors`);

// ---------- bind ----------
let bindable = 0, alreadyBound = 0, rawUnmatched = 0, applied = 0;
const samples = [];
const perVar = new Map();
for (const n of nodes) {
  for (const key of ["fillPaints", "strokePaints"]) {
    for (const p of n[key] || []) {
      if (p.colorVar) { alreadyBound++; continue; }
      if (p.type !== "SOLID" || !p.color) continue;
      const hit = varIndex.get(hex(p.color));
      if (!hit) { rawUnmatched++; continue; }
      bindable++;
      if (applied >= LIMIT) continue;
      if (!DRY) {
        p.colorVar = {
          value: { alias: { guid: hit.guid } },
          dataType: "ALIAS",
          resolvedDataType: "COLOR",
        };
        // Positive control: Phase 1c proved name mutations survive import. If the prefix shows
        // up in Figma but the binding does not, the write landed and Figma rejected the binding
        // specifically — that distinction is what makes the test conclusive either way.
        if (MARK && !String(n.name || "").startsWith("🧪1G·")) n.name = `🧪1G·${n.name || ""}`;
      }
      applied++;
      perVar.set(hit.name, (perVar.get(hit.name) || 0) + 1);
      if (samples.length < 12) samples.push({ node: n.name || "(unnamed)", nodeType: n.type, field: key, hex: hex(p.color), variable: hit.name });
    }
  }
}
const totalPaints = alreadyBound + bindable + rawUnmatched;
log(`[3] paints: total=${totalPaints} alreadyBound=${alreadyBound} bindable=${bindable} noMatchingVariable=${rawUnmatched}`);
log(`    binding rate: ${(alreadyBound / totalPaints * 100).toFixed(2)}%  ->  ${((alreadyBound + applied) / totalPaints * 100).toFixed(2)}%  (applied ${applied})`);
log(`[4] per variable:`); for (const [k, v] of [...perVar].sort((a, b) => b[1] - a[1])) log(`      ${k}: ${v}`);

const report = {
  src: inPath, out: DRY ? null : outPath, phase: "1g",
  variables: [...varIndex].map(([h, v]) => ({ hex: h, name: v.name, guid: `${v.guid.sessionID}:${v.guid.localID}` })),
  paints: { total: totalPaints, alreadyBound, bindable, noMatchingVariable: rawUnmatched, applied },
  bindingRate: { before: +(alreadyBound / totalPaints * 100).toFixed(2), after: +((alreadyBound + applied) / totalPaints * 100).toFixed(2) },
  verifyInFigma: samples,
  risk: "Self-read consistency is NOT proof. The only real verification is: import out.fig into Figma, select one of verifyInFigma[] layers, and check the right panel shows the variable name instead of a raw hex.",
};
fs.mkdirSync("out", { recursive: true });

if (DRY) { fs.writeFileSync("out/bind-report-dry.json", JSON.stringify(report, null, 2)); log("[dry] no file written -> out/bind-report-dry.json"); process.exit(0); }

// ---------- write back ----------
const reEncoded = compiled.encodeMessage(msg);
const newDataChunk = zlib.zstdCompressSync(Buffer.from(reEncoded));
const newCanvas = buildArchive(arc.version, [schemaChunkRaw, newDataChunk]);
log(`[5] re-encoded message=${reEncoded.length} B, zstd=${newDataChunk.length} B, canvas=${newCanvas.length} B (orig canvas ${canvasEntry.getData().length} B)`);

// Preserve EVERY original entry verbatim (images/ etc.), swapping only canvas.fig.
// reencode-fig.mjs rebuilt only canvas/thumbnail/meta — that silently drops images on real files.
const newZip = new AdmZip();
let kept = 0;
for (const e of entries) {
  if (e.isDirectory) { const d = newZip.addFile(e.entryName, Buffer.alloc(0)); if (d) d.header.method = e.header.method; continue; }
  const data = e.entryName.endsWith("canvas.fig") ? newCanvas : e.getData();
  const ne = newZip.addFile(e.entryName, data);
  ne.header.method = e.header.method;  // keep STORE/DEFLATE as the original had it
  kept++;
}
newZip.writeZip(outPath);
log(`[6] wrote ${outPath} (${fs.statSync(outPath).size} B; ${kept} files preserved, orig ${outerBuf.length} B)`);

// ---------- self-read (necessary, not sufficient) ----------
const back = new AdmZip(fs.readFileSync(outPath));
const bArc = parseArchive(back.getEntries().find((e) => e.entryName.endsWith("canvas.fig")).getData());
const bMsg = compiled.decodeMessage(inflateChunk(bArc.chunks[1]));
let boundAfter = 0;
for (const n of bMsg.nodeChanges || []) for (const k of ["fillPaints", "strokePaints"]) for (const p of n[k] || []) if (p.colorVar) boundAfter++;
report.selfRead = { nodeChanges: (bMsg.nodeChanges || []).length, boundPaints: boundAfter, expected: alreadyBound + applied, match: boundAfter === alreadyBound + applied };
log(`[7] self-read: boundPaints=${boundAfter} expected=${alreadyBound + applied} match=${report.selfRead.match}`);
fs.writeFileSync("out/bind-report.json", JSON.stringify(report, null, 2));
log(`\n[NEXT] Import ${outPath} into Figma. Verify one of these layers shows a VARIABLE, not a hex:`);
for (const s of samples.slice(0, 6)) log(`    "${s.node}" (${s.nodeType}) ${s.field} ${s.hex} -> ${s.variable}`);
