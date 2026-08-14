/**
 * Shared .fig access layer: open / walk / save.
 * Deterministic, offline. No Figma runtime, plugin, account or network.
 *
 * Format chain (verified on Figma version 106):
 *   .fig = ZIP { canvas.fig (STORE), thumbnail.png (STORE), meta.json (DEFLATE), images/<sha1> }
 *   canvas.fig = "fig-kiwi" + u32 version + [u32 len + chunk] x2
 *   chunk0 = kiwi schema (deflateRaw), chunk1 = Message (zstd)
 * The schema is embedded per-file and read dynamically — that is what makes this survive
 * some amount of Figma schema drift instead of hardcoding a snapshot.
 */
import fs from "node:fs";
import zlib from "node:zlib";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { decodeBinarySchema, compileSchema } = require("kiwi-schema");
const AdmZip = require("adm-zip");
const fzstd = require("fzstd");

const MAGIC = "fig-kiwi";

export function inflateChunk(d) {
  if (d[0] === 0x28 && d[1] === 0xb5 && d[2] === 0x2f && d[3] === 0xfd) return Buffer.from(fzstd.decompress(d));
  try { return zlib.inflateRawSync(d); } catch { return Buffer.from(fzstd.decompress(d)); }
}

function splitChunks(buf) {
  if (buf.toString("latin1", 0, 8) !== MAGIC) throw new Error("not a fig-kiwi stream");
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

function joinChunks(version, chunks) {
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

/** Open a .fig (ZIP) or a bare canvas.fig. Returns a handle usable by lint and fix. */
export function open(filePath) {
  const outer = fs.readFileSync(filePath);
  const isZip = outer[0] === 0x50 && outer[1] === 0x4b;
  let zip = null, canvasBuf = outer;
  if (isZip) {
    zip = new AdmZip(outer);
    const e = zip.getEntries().find((x) => x.entryName.endsWith("canvas.fig"));
    if (!e) throw new Error("ZIP has no canvas.fig — not a Figma file");
    canvasBuf = e.getData();
  }
  const { version, chunks } = splitChunks(canvasBuf);
  const schema = decodeBinarySchema(inflateChunk(chunks[0]));
  const compiled = compileSchema(schema);
  const message = compiled.decodeMessage(inflateChunk(chunks[1]));
  return { filePath, outer, zip, isZip, version, schemaChunk: chunks[0], schema, compiled, message,
           nodes: message.nodeChanges || [] };
}

/**
 * Write the (mutated) message back out.
 * Every original ZIP entry is preserved byte-for-byte except canvas.fig, each keeping its own
 * compression method. Rebuilding only canvas/thumbnail/meta silently drops images/ — a real
 * file in testing carried 62 entries.
 */
export function save(handle, outPath) {
  if (!handle.isZip) throw new Error("cannot save a bare canvas.fig — open a real .fig");
  const reEncoded = handle.compiled.encodeMessage(handle.message);
  const newCanvas = joinChunks(handle.version, [handle.schemaChunk, zlib.zstdCompressSync(Buffer.from(reEncoded))]);
  const out = new AdmZip();
  let files = 0;
  for (const e of handle.zip.getEntries()) {
    if (e.isDirectory) { const d = out.addFile(e.entryName, Buffer.alloc(0)); if (d) d.header.method = e.header.method; continue; }
    const data = e.entryName.endsWith("canvas.fig") ? newCanvas : e.getData();
    const ne = out.addFile(e.entryName, data);
    ne.header.method = e.header.method;
    files++;
  }
  out.writeZip(outPath);
  return { outPath, bytes: fs.statSync(outPath).size, filesPreserved: files };
}

// ---------- colour ----------

/** Alpha is part of a colour's identity: rgba(1,1,1,0.9) is NOT #FFFFFF. */
export function hex(c) {
  const p = (v) => Math.round(v * 255).toString(16).padStart(2, "0").toUpperCase();
  const base = "#" + p(c.r) + p(c.g) + p(c.b);
  return c.a === undefined || Math.abs(c.a - 1) < 1e-6 ? base : base + p(c.a);
}

// ---------- variables ----------

/**
 * A library-backed variable is a cached copy: it carries sourceLibraryKey and its
 * variableSetID points at an { assetRef } rather than a { guid }. Referencing one by guid
 * yields a binding Figma cannot resolve, and it silently falls back to the raw colour.
 */
export const isLocalVariable = (n) =>
  !n.sourceLibraryKey && !n.variableSetID?.assetRef && !!n.variableSetID?.guid;

/** Index colour variables by hex. Library-backed ones are indexed but flagged, never bound by default. */
export function colorVariables(handle) {
  const list = [];
  for (const n of handle.nodes) {
    if (n.type !== "VARIABLE" || !n.variableDataValues || !n.guid) continue;
    const local = isLocalVariable(n);
    for (const e of n.variableDataValues.entries || []) {
      const cv = e.variableData?.value?.colorValue;
      if (!cv) continue;
      list.push({ hex: hex(cv), name: n.name, guid: n.guid, local, modeID: e.modeID });
    }
  }
  return list;
}

export const bindingFor = (guid) => ({
  value: { alias: { guid } }, dataType: "ALIAS", resolvedDataType: "COLOR",
});

// ---------- traversal ----------

/** Yield every paint on every node, tagged with which field it came from. */
export function* paints(handle) {
  for (const n of handle.nodes) {
    for (const field of ["fillPaints", "strokePaints"]) {
      const arr = n[field];
      if (!arr) continue;
      for (let i = 0; i < arr.length; i++) yield { node: n, field, index: i, paint: arr[i] };
    }
  }
}

export const guidStr = (g) => (g ? `${g.sessionID}:${g.localID}` : "-");
