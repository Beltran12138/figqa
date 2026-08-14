/**
 * Phase 1g probe: does the .fig kiwi schema have a place for VARIABLE BINDINGS?
 * Pure read, deterministic, no Figma runtime.
 *
 * Step 1: dump the embedded schema (chunk 0) as text  -> out/schema.kiwi
 * Step 2: list every struct/message/enum whose name or fields mention variable/bound
 * Step 3: scan decoded nodeChanges for nodes that actually carry those fields
 *
 * Usage: node probe-variables.mjs <path.fig|canvas.fig> [--full]
 */
import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { decodeBinarySchema, compileSchema, prettyPrintSchema } = require("kiwi-schema");
const AdmZip = require("adm-zip");
const fzstd = require("fzstd");

const inPath = process.argv[2];
if (!inPath) throw new Error("usage: node probe-variables.mjs <path.fig>");
const MAGIC = "fig-kiwi";

function isZip(b) { return b.length >= 4 && b[0] === 0x50 && b[1] === 0x4b && b[2] === 0x03 && b[3] === 0x04; }

function inflateChunk(data, label) {
  if (data.length >= 4 && data[0] === 0x28 && data[1] === 0xb5 && data[2] === 0x2f && data[3] === 0xfd) {
    return { algo: "zstd", bytes: Buffer.from(fzstd.decompress(data)) };
  }
  try { return { algo: "deflateRaw", bytes: zlib.inflateRawSync(data) }; }
  catch { return { algo: "zstd-fallback", bytes: Buffer.from(fzstd.decompress(data)) }; }
}

function getCanvas(buf) {
  if (!isZip(buf)) return buf;
  const zip = new AdmZip(buf);
  const e = zip.getEntries().find((x) => x.entryName.endsWith("canvas.fig"));
  if (!e) throw new Error("no canvas.fig in ZIP");
  return e.getData();
}

const raw = fs.readFileSync(inPath);
const canvas = getCanvas(raw);
if (canvas.toString("latin1", 0, 8) !== MAGIC) throw new Error("not fig-kiwi");

// chunks: [magic 8][version u32][ (len u32 + data) x N ]
const chunks = [];
let off = 12;
while (off + 4 <= canvas.length) {
  const len = canvas.readUInt32LE(off); off += 4;
  if (len === 0 || off + len > canvas.length) break;
  chunks.push(canvas.subarray(off, off + len)); off += len;
}
console.log(`file=${path.basename(inPath)} version=${canvas.readUInt32LE(8)} chunks=${chunks.length}`);

const schemaBytes = inflateChunk(chunks[0], "schema").bytes;
const schema = decodeBinarySchema(schemaBytes);
const schemaText = prettyPrintSchema(schema);
fs.mkdirSync("out", { recursive: true });
fs.writeFileSync("out/schema.kiwi", schemaText);
console.log(`schema: ${schema.definitions.length} definitions -> out/schema.kiwi (${schemaText.length} B)`);

// ---- Step 2: variable-related definitions ----
const RX = /variab|bound|token|alias|symbol/i;
const hitDefs = schema.definitions.filter(
  (d) => RX.test(d.name) || (d.fields || []).some((f) => RX.test(f.name) || RX.test(f.type || ""))
);
console.log(`\n=== definitions mentioning variable/bound/token/alias (${hitDefs.length}) ===`);
for (const d of hitDefs) {
  const fields = (d.fields || []).filter((f) => RX.test(f.name) || RX.test(f.type || ""));
  console.log(`\n[${d.kind}] ${d.name}`);
  for (const f of fields) console.log(`    ${f.name}: ${f.type}${f.isArray ? "[]" : ""}`);
}

// ---- Step 3: do real nodes carry them? ----
const dataBytes = inflateChunk(chunks[1], "data").bytes;
const compiled = compileSchema(schema);
const msg = compiled.decodeMessage(dataBytes);
const nodes = msg.nodeChanges || [];
console.log(`\n=== message: ${nodes.length} nodeChanges, ${(msg.blobs || []).length} blobs ===`);

const fieldCount = new Map();
const sample = new Map();
for (const n of nodes) {
  for (const k of Object.keys(n)) {
    if (!RX.test(k)) continue;
    const v = n[k];
    const empty = v == null || (Array.isArray(v) && v.length === 0) ||
      (typeof v === "object" && !Array.isArray(v) && Object.keys(v).length === 0);
    if (empty) continue;
    fieldCount.set(k, (fieldCount.get(k) || 0) + 1);
    if (!sample.has(k)) sample.set(k, { node: n.name || "(unnamed)", type: n.type, value: v });
  }
}
if (fieldCount.size === 0) {
  console.log("NO node in this file carries a variable-ish field (expected if the file never used Variables).");
} else {
  for (const [k, c] of [...fieldCount].sort((a, b) => b[1] - a[1])) {
    const s = sample.get(k);
    console.log(`\n${k}: present on ${c}/${nodes.length} nodes`);
    console.log(`  first: node="${s.node}" type=${s.type}`);
    console.log(`  value: ${JSON.stringify(s.value, (_, v) => (v && v.type === "Buffer" ? "<Buffer>" : v)).slice(0, 600)}`);
  }
}

// nested scan: fills/strokes may hide bindings one level down
let nestedHits = 0;
const nestedSample = [];
for (const n of nodes) {
  for (const [k, v] of Object.entries(n)) {
    if (!Array.isArray(v)) continue;
    for (const item of v) {
      if (!item || typeof item !== "object") continue;
      for (const ik of Object.keys(item)) {
        if (RX.test(ik) && item[ik] != null && !(Array.isArray(item[ik]) && !item[ik].length)) {
          nestedHits++;
          if (nestedSample.length < 5) nestedSample.push({ node: n.name, path: `${k}[].${ik}`, value: item[ik] });
        }
      }
    }
  }
}
console.log(`\n=== nested (array-item level) variable-ish hits: ${nestedHits} ===`);
for (const s of nestedSample) console.log(`  ${s.path} on "${s.node}": ${JSON.stringify(s.value).slice(0, 300)}`);
