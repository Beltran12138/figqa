/**
 * Pure-read dump of a Figma .fig file (ZIP container + fig-kiwi canvas).
 * Deterministic, no Figma runtime. Dependencies: kiwi-schema, pako.
 *
 * Usage:
 *   node dump-fig.mjs [path-to.fig]
 *   node dump-fig.mjs extracted/canvas.fig
 */

import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { decodeBinarySchema, compileSchema } = require("kiwi-schema");
const AdmZip = require("adm-zip");
const fzstd = require("fzstd");

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/** Detect compression of a fig-kiwi chunk (empirical on real samples). */
function detectCompression(data) {
  if (data.length >= 4 && data[0] === 0x28 && data[1] === 0xb5 && data[2] === 0x2f && data[3] === 0xfd) {
    return "zstd";
  }
  // zlib raw deflate has no magic; try inflateRaw later. CM=8 zlib wrapper:
  if (data.length >= 2 && (data[0] & 0x0f) === 0x08 && ((data[0] << 8) | data[1]) % 31 === 0) {
    return "zlib";
  }
  return "deflateRaw-or-unknown";
}

function inflateChunk(data, label) {
  const kind = detectCompression(data);
  if (kind === "zstd") {
    try {
      return { algo: "zstd", bytes: Buffer.from(fzstd.decompress(data)) };
    } catch (e) {
      throw new Error(`${label}: zstd decompress failed: ${e.message}`);
    }
  }
  if (kind === "zlib") {
    try {
      return { algo: "zlib", bytes: zlib.inflateSync(data) };
    } catch (e) {
      throw new Error(`${label}: zlib inflate failed: ${e.message}`);
    }
  }
  // default: raw deflate (historical fig-kiwi schema/data)
  try {
    return { algo: "deflateRaw", bytes: zlib.inflateRawSync(data) };
  } catch (eRaw) {
    // last resort: zstd without relying on magic (shouldn't happen)
    try {
      return { algo: "zstd-fallback", bytes: Buffer.from(fzstd.decompress(data)) };
    } catch (eZ) {
      throw new Error(
        `${label}: inflate failed (tried deflateRaw: ${eRaw.message}; zstd: ${eZ.message})`
      );
    }
  }
}

// ---------- ZIP (optional outer container) ----------

function isZip(buf) {
  return buf.length >= 4 && buf[0] === 0x50 && buf[1] === 0x4b && buf[2] === 0x03 && buf[3] === 0x04;
}

/**
 * Figma desktop .fig is a ZIP (often with bit3 data-descriptor flags).
 * Use adm-zip (central directory) — local-header-only scanners fail on bit3.
 */
function extractCanvasFig(outerBuf) {
  if (!isZip(outerBuf)) {
    return { kind: "raw-fig-kiwi", canvas: outerBuf, zipEntries: null };
  }
  const zip = new AdmZip(outerBuf);
  const zipEntries = zip.getEntries().map((e) => ({
    name: e.entryName,
    compression: e.header?.method,
    compressedSize: e.header?.compressedSize,
    uncompressedSize: e.header?.size,
    isDirectory: e.isDirectory,
    data: e.isDirectory ? null : e.getData(),
  }));
  const canvasEntry = zipEntries.find(
    (e) => e.name === "canvas.fig" || e.name.endsWith("/canvas.fig")
  );
  if (!canvasEntry || !canvasEntry.data) {
    throw new Error(
      `ZIP has no canvas.fig. Entries: ${zipEntries.map((e) => e.name).join(", ")}`
    );
  }
  return { kind: "zip-container", canvas: canvasEntry.data, zipEntries };
}

// ---------- fig-kiwi archive ----------

const MAGIC = "fig-kiwi";

function parseFigKiwiArchive(buf) {
  if (buf.length < 12) throw new Error(`canvas too short: ${buf.length}`);
  const magic = buf.toString("latin1", 0, 8);
  if (magic !== MAGIC) {
    throw new Error(`bad magic: ${JSON.stringify(magic)} (expected ${JSON.stringify(MAGIC)})`);
  }
  const version = buf.readUInt32LE(8);
  const chunks = [];
  let offset = 12;
  while (offset + 4 <= buf.length) {
    const size = buf.readUInt32LE(offset);
    const start = offset;
    offset += 4;
    if (size < 0 || offset + size > buf.length) {
      throw new Error(
        `chunk overrun at ${start}: size=${size}, remaining=${buf.length - offset}`
      );
    }
    const data = Buffer.from(buf.subarray(offset, offset + size));
    offset += size;
    chunks.push({ index: chunks.length, offset: start, size, data });
  }
  if (offset !== buf.length) {
    // trailing bytes after last chunk — report, don't guess
    throw new Error(`trailing ${buf.length - offset} bytes after last chunk at offset ${offset}`);
  }
  return { magic, version, chunks, endOffset: offset, fileSize: buf.length };
}

// ---------- schema dump ----------

function formatFieldType(field) {
  // kiwi-schema Field: { name, line, column, type, isArray, isDeprecated, value }
  const base = field.type;
  return field.isArray ? `${base}[]` : base;
}

function dumpSchema(schema) {
  const defs = schema.definitions || [];
  const byKind = { ENUM: 0, STRUCT: 0, MESSAGE: 0 };
  for (const d of defs) {
    byKind[d.kind] = (byKind[d.kind] || 0) + 1;
  }

  const lines = [];
  lines.push(`# Schema field inventory`);
  lines.push(`definitions: ${defs.length}`);
  lines.push(`byKind: ${JSON.stringify(byKind)}`);
  lines.push(``);

  for (const def of defs) {
    lines.push(`## ${def.kind} ${def.name}`);
    if (!def.fields || def.fields.length === 0) {
      lines.push(`  (no fields)`);
      lines.push(``);
      continue;
    }
    for (const f of def.fields) {
      const num = f.value !== undefined ? f.value : "?";
      const dep = f.isDeprecated ? " DEPRECATED" : "";
      lines.push(`  - #${num} ${f.name}: ${formatFieldType(f)}${dep}`);
    }
    lines.push(``);
  }
  return lines.join("\n");
}

function schemaToJson(schema) {
  return (schema.definitions || []).map((def) => ({
    kind: def.kind,
    name: def.name,
    fields: (def.fields || []).map((f) => ({
      number: f.value,
      name: f.name,
      type: formatFieldType(f),
      isArray: !!f.isArray,
      isDeprecated: !!f.isDeprecated,
    })),
  }));
}

// ---------- JSON helpers ----------

function toJsonable(value, depth = 0) {
  if (value == null) return value;
  if (typeof value !== "object") return value;
  if (Buffer.isBuffer(value) || value instanceof Uint8Array) {
    const u8 = value instanceof Uint8Array ? value : new Uint8Array(value);
    if (u8.length <= 32) {
      return {
        __type: "bytes",
        length: u8.length,
        hex: Buffer.from(u8).toString("hex"),
      };
    }
    return {
      __type: "bytes",
      length: u8.length,
      hexHead: Buffer.from(u8.subarray(0, 16)).toString("hex"),
      hexTail: Buffer.from(u8.subarray(u8.length - 8)).toString("hex"),
    };
  }
  if (Array.isArray(value)) {
    if (depth > 40) return `[Array len=${value.length}]`;
    return value.map((v) => toJsonable(v, depth + 1));
  }
  if (depth > 40) return "[Object max depth]";
  const out = {};
  for (const [k, v] of Object.entries(value)) {
    // skip *Tag companion fields in summary paths later; keep full dump
    out[k] = toJsonable(v, depth + 1);
  }
  return out;
}

function presentFields(obj) {
  if (!obj || typeof obj !== "object") return [];
  return Object.keys(obj).filter((k) => !k.endsWith("Tag") && obj[k] !== undefined);
}

// ---------- node analysis ----------

function collectNodes(message) {
  // Message typically has nodeChanges: NodeChange[]
  const nodes = [];
  const lists = [];
  if (message?.nodeChanges) lists.push(["nodeChanges", message.nodeChanges]);
  if (message?.blobs) {
    // not nodes
  }
  // also walk any nested derivedSymbolData etc. later per-node

  for (const [listName, arr] of lists) {
    if (!Array.isArray(arr)) continue;
    for (let i = 0; i < arr.length; i++) {
      nodes.push({ list: listName, index: i, node: arr[i] });
    }
  }
  return nodes;
}

function guidStr(g) {
  if (!g) return null;
  return `${g.sessionID}:${g.localID}`;
}

function summarizeNode(node) {
  const fields = presentFields(node);
  const summary = {
    guid: guidStr(node.guid),
    type: node.type,
    name: node.name,
    phase: node.phase,
    parent: node.parentIndex
      ? { guid: guidStr(node.parentIndex.guid), position: node.parentIndex.position }
      : undefined,
    size: node.size,
    transform: node.transform,
    presentFieldCount: fields.length,
    presentFields: fields,
  };
  return summary;
}

function fieldFillReport(node, schemaNodeChangeFields) {
  const present = new Set(presentFields(node));
  const all = schemaNodeChangeFields || [];
  const filled = [];
  const empty = [];
  for (const f of all) {
    // skip *Tag meta fields in schema listing of interest
    if (f.name.endsWith("Tag")) continue;
    if (present.has(f.name)) {
      const v = node[f.name];
      filled.push({
        number: f.number,
        name: f.name,
        type: f.type,
        valuePreview: previewValue(v),
      });
    } else {
      empty.push({ number: f.number, name: f.name, type: f.type });
    }
  }
  return { filled, empty, filledCount: filled.length, emptyCount: empty.length };
}

function previewValue(v) {
  if (v == null) return v;
  if (typeof v === "string") return v.length > 80 ? v.slice(0, 80) + "…" : v;
  if (typeof v === "number" || typeof v === "boolean") return v;
  if (Array.isArray(v)) return { __arrayLength: v.length, sample: toJsonable(v.slice(0, 2)) };
  if (Buffer.isBuffer(v) || v instanceof Uint8Array) {
    return { __bytes: v.length };
  }
  return toJsonable(v);
}

// ---------- main ----------

function main() {
  const inputArg = process.argv[2] || path.join(__dirname, "extracted", "canvas.fig");
  // Also accept original zip path
  const defaultZip = "./sample.fig";
  let inputPath = inputArg;
  if (!fs.existsSync(inputPath) && fs.existsSync(defaultZip)) {
    inputPath = defaultZip;
  }
  if (!fs.existsSync(inputPath)) {
    console.error("File not found:", inputPath);
    process.exit(1);
  }

  const outDir = path.join(__dirname, "out");
  fs.mkdirSync(outDir, { recursive: true });

  const outerBuf = fs.readFileSync(inputPath);
  console.error(`[1] read ${inputPath} (${outerBuf.length} bytes)`);

  const { kind, canvas, zipEntries } = extractCanvasFig(outerBuf);
  console.error(`[2] container=${kind}, canvas.fig size=${canvas.length}`);

  if (zipEntries) {
    const zipMeta = zipEntries.map((e) => ({
      name: e.name,
      compressedSize: e.compressedSize,
      uncompressedSize: e.uncompressedSize,
      compression: e.compression,
    }));
    fs.writeFileSync(path.join(outDir, "zip-entries.json"), JSON.stringify(zipMeta, null, 2));
    // save meta.json if present
    const meta = zipEntries.find((e) => e.name === "meta.json");
    if (meta) {
      fs.writeFileSync(path.join(outDir, "meta.json"), meta.data);
    }
  }

  // Optionally write extracted canvas for verification
  fs.writeFileSync(path.join(outDir, "canvas.fig"), canvas);

  const archive = parseFigKiwiArchive(canvas);
  console.error(
    `[3] magic=${archive.magic} version=${archive.version} chunks=${archive.chunks.length}`
  );

  const chunkReport = archive.chunks.map((c) => ({
    index: c.index,
    offset: c.offset,
    size: c.size,
    first8hex: c.data.subarray(0, 8).toString("hex"),
  }));

  if (archive.chunks.length < 2) {
    throw new Error(`expected >=2 chunks (schema+data), got ${archive.chunks.length}`);
  }

  const schemaResult = inflateChunk(archive.chunks[0].data, "schema chunk");
  const dataResult = inflateChunk(archive.chunks[1].data, "data chunk");
  const schemaInflated = schemaResult.bytes;
  const dataInflated = dataResult.bytes;
  console.error(
    `[4] inflated schema=${schemaInflated.length} B (${schemaResult.algo}), data=${dataInflated.length} B (${dataResult.algo})`
  );

  // remaining chunks (if any) — report sizes only, don't guess role
  const extraChunks = [];
  for (let i = 2; i < archive.chunks.length; i++) {
    let inflated = null;
    let algo = null;
    let inflateError = null;
    try {
      const r = inflateChunk(archive.chunks[i].data, `chunk${i}`);
      inflated = r.bytes;
      algo = r.algo;
    } catch (e) {
      inflateError = e.message;
    }
    extraChunks.push({
      index: i,
      compressedSize: archive.chunks[i].size,
      detected: detectCompression(archive.chunks[i].data),
      algo,
      inflatedSize: inflated ? inflated.length : null,
      inflateError,
      first16hexInflated: inflated
        ? Buffer.from(inflated.subarray(0, 16)).toString("hex")
        : null,
    });
  }

  const schema = decodeBinarySchema(new Uint8Array(schemaInflated));
  const schemaJson = schemaToJson(schema);
  const schemaText = dumpSchema(schema);
  fs.writeFileSync(path.join(outDir, "schema.json"), JSON.stringify(schemaJson, null, 2));
  fs.writeFileSync(path.join(outDir, "schema-fields.txt"), schemaText);
  console.error(`[5] schema definitions=${schemaJson.length}`);

  const compiled = compileSchema(schema);
  if (typeof compiled.decodeMessage !== "function") {
    throw new Error(
      `compiled schema has no decodeMessage; methods: ${Object.keys(compiled)
        .filter((k) => k.startsWith("decode"))
        .join(", ")}`
    );
  }

  let message;
  try {
    message = compiled.decodeMessage(new Uint8Array(dataInflated));
  } catch (e) {
    throw new Error(`decodeMessage failed: ${e.message}`);
  }
  console.error(`[6] decodeMessage OK; top-level keys: ${Object.keys(message || {}).join(", ")}`);

  const messageJson = toJsonable(message);
  fs.writeFileSync(path.join(outDir, "message.json"), JSON.stringify(messageJson, null, 2));

  // node tree / nodeChanges
  const nodes = collectNodes(message);
  const typeCounts = {};
  for (const { node } of nodes) {
    const t = node.type || "(undefined)";
    typeCounts[t] = (typeCounts[t] || 0) + 1;
  }

  const nodeChangeDef = schemaJson.find((d) => d.name === "NodeChange");
  const nodeChangeFields = nodeChangeDef ? nodeChangeDef.fields : [];

  const TARGET_TYPES = new Set(["FRAME", "RECTANGLE", "TEXT", "ROUNDED_RECTANGLE"]);
  const samples = [];
  const perTypeSamples = { FRAME: 0, RECTANGLE: 0, TEXT: 0, ROUNDED_RECTANGLE: 0 };
  const MAX_PER_TYPE = 3;

  for (const { list, index, node } of nodes) {
    if (!TARGET_TYPES.has(node.type)) continue;
    if (perTypeSamples[node.type] >= MAX_PER_TYPE) continue;
    perTypeSamples[node.type]++;
    const fill = fieldFillReport(node, nodeChangeFields);
    samples.push({
      list,
      index,
      summary: summarizeNode(node),
      fieldFill: {
        filledCount: fill.filledCount,
        emptyCount: fill.emptyCount,
        filled: fill.filled,
        // empty list can be huge — keep names only
        emptyFieldNames: fill.empty.map((e) => e.name),
      },
      fullNode: toJsonable(node),
    });
  }

  // compact node index for whole tree
  const nodeIndex = nodes.map(({ list, index, node }) => ({
    list,
    index,
    ...summarizeNode(node),
  }));

  fs.writeFileSync(path.join(outDir, "node-index.json"), JSON.stringify(nodeIndex, null, 2));
  fs.writeFileSync(path.join(outDir, "node-samples.json"), JSON.stringify(samples, null, 2));

  // top-level message field fill
  const messageDef = schemaJson.find((d) => d.name === "Message");
  const messageFill = messageDef
    ? fieldFillReport(message, messageDef.fields)
    : null;

  const report = {
    source: path.resolve(inputPath),
    generatedAt: new Date().toISOString(),
    container: {
      kind,
      outerSize: outerBuf.length,
      zipEntries: zipEntries
        ? zipEntries.map((e) => ({
            name: e.name,
            compressedSize: e.compressedSize,
            uncompressedSize: e.uncompressedSize,
            compression: e.compression,
          }))
        : null,
    },
    figKiwi: {
      magic: archive.magic,
      version: archive.version,
      fileSize: archive.fileSize,
      chunkCount: archive.chunks.length,
      chunks: chunkReport.map((c, i) => {
        const detected = detectCompression(archive.chunks[i].data);
        const algo =
          i === 0 ? schemaResult.algo : i === 1 ? dataResult.algo : extraChunks.find((x) => x.index === i)?.algo;
        return {
          ...c,
          role: i === 0 ? "schema" : i === 1 ? "data(Message)" : "unknown",
          detectedCompression: detected,
          inflateAlgo: algo,
          inflatedSize:
            i === 0
              ? schemaInflated.length
              : i === 1
                ? dataInflated.length
                : extraChunks.find((x) => x.index === i)?.inflatedSize ?? null,
        };
      }),
      extraChunks,
    },
    schema: {
      definitionCount: schemaJson.length,
      byKind: schemaJson.reduce((acc, d) => {
        acc[d.kind] = (acc[d.kind] || 0) + 1;
        return acc;
      }, {}),
      messageTopLevelFieldsPresent: presentFields(message),
      messageFieldFill: messageFill
        ? {
            filledCount: messageFill.filledCount,
            emptyCount: messageFill.emptyCount,
            filled: messageFill.filled,
            emptyFieldNames: messageFill.empty.map((e) => e.name),
          }
        : null,
    },
    nodeTree: {
      nodeChangeCount: nodes.length,
      typeCounts,
      sampleTargets: perTypeSamples,
    },
    outputs: {
      "out/schema.json": "full schema definitions with field numbers",
      "out/schema-fields.txt": "human-readable field inventory",
      "out/message.json": "full decoded Message (NodeTree root)",
      "out/node-index.json": "compact per-node summary",
      "out/node-samples.json": "FRAME/RECTANGLE/TEXT field fill detail",
      "out/canvas.fig": "extracted fig-kiwi blob",
      "out/summary.json": "this file",
    },
  };

  fs.writeFileSync(path.join(outDir, "summary.json"), JSON.stringify(report, null, 2));
  console.error(`[7] wrote artifacts to ${outDir}`);
  console.log(JSON.stringify({ ok: true, summary: path.join(outDir, "summary.json"), typeCounts }, null, 2));
}

try {
  main();
} catch (e) {
  console.error("FATAL:", e.message);
  console.error(e.stack);
  process.exit(1);
}
