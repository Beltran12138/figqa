/**
 * P0 IMAGE blob 探测：定位 .fig 里图片字节的存储位置 + fill 引用结构。
 *
 * 纯结构探测，合规设计——只输出格式结构，绝不输出任何设计业务内容：
 *   - 不打印 node.name / characters / meta.file_name / 任何文本值
 *   - image hash 会打印（它是内容寻址指针=images/ 文件名，非业务语义）
 *   - 图片字节只报 magic(前8字节)/大小，不落盘不打印内容
 *
 * 输出：images/ 目录清单 + IMAGE paint 计数与字段结构 + blobs 计数。
 *
 * Usage: node probe-images.mjs <path.fig>
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
  const chunks = [];
  let off = 12;
  while (off + 4 <= buf.length) {
    const size = buf.readUInt32LE(off);
    off += 4;
    chunks.push(Buffer.from(buf.subarray(off, off + size)));
    off += size;
  }
  return { version, chunks };
}

function magicKind(buf) {
  if (!buf || buf.length < 4) return "empty";
  const b = buf;
  if (b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return "PNG";
  if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return "JPEG";
  if (b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46) return "GIF";
  if (b[0] === 0x52 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x46) return "WEBP/RIFF";
  return "unknown";
}

// enum 值 → name 解析（NodeType/PaintType 等），避免依赖硬编码
function enumMap(schema, enumName) {
  const def = (schema.definitions || []).find((d) => d.name === enumName);
  if (!def) return { n2i: {}, i2n: {} };
  const n2i = {}, i2n = {};
  for (const f of def.fields || []) { n2i[f.name] = f.value; i2n[f.value] = f.name; }
  return { n2i, i2n };
}

function main() {
  const src = process.argv[2];
  if (!src) { console.error("Usage: node probe-images.mjs <path.fig>"); process.exit(1); }
  const outer = fs.readFileSync(src);
  const report = { srcSize: outer.length, zip: {}, message: {} };

  // ---- ZIP 层：images/ 目录 ----
  const zip = new AdmZip(outer);
  const entries = zip.getEntries();
  const imageEntries = entries
    .filter((e) => e.entryName.startsWith("images/") && !e.isDirectory)
    .map((e) => {
      const data = e.getData();
      return { name: e.entryName, size: data.length, kind: magicKind(data), magicHex: data.subarray(0, 8).toString("hex") };
    });
  report.zip.allEntryNames = entries.map((e) => e.entryName);
  report.zip.imagesDirFiles = imageEntries;
  report.zip.imagesCount = imageEntries.length;

  // ---- canvas → message ----
  const canvasE = entries.find((e) => e.entryName === "canvas.fig" || e.entryName.endsWith("/canvas.fig"));
  if (!canvasE) { console.log(JSON.stringify(report, null, 2)); return; }
  const arc = parseArchive(canvasE.getData());
  const schemaBytes = zlib.inflateRawSync(arc.chunks[0]);
  const c1 = arc.chunks[1];
  const dataBytes = (c1[0] === 0x28 && c1[1] === 0xb5) ? Buffer.from(fzstd.decompress(c1)) : zlib.inflateRawSync(c1);
  const schema = decodeBinarySchema(new Uint8Array(schemaBytes));
  const compiled = compileSchema(schema);
  const msg = compiled.decodeMessage(new Uint8Array(dataBytes));
  const nc = msg.nodeChanges || [];
  report.message.nodeChanges = nc.length;
  report.message.blobs = (msg.blobs || []).length;

  const { i2n: paintTypeI2N, n2i: paintTypeN2I } = enumMap(schema, "PaintType");
  report.message.paintTypeEnum = paintTypeN2I;

  // ---- 遍历所有 paints 找 IMAGE ----
  const imagePaints = [];
  const refKeySets = {};
  const scanPaints = (paints, host) => {
    if (!Array.isArray(paints)) return;
    for (const p of paints) {
      const t = p?.type;
      const tName = typeof t === "number" ? paintTypeI2N[t] : t;
      if (tName === "IMAGE") {
        // 只记结构：字段名集合 + image 子对象结构（hash 是指针可留）
        const keys = Object.keys(p).filter((k) => !k.endsWith("Tag")).sort();
        const sig = keys.join(",");
        refKeySets[sig] = (refKeySets[sig] || 0) + 1;
        if (imagePaints.length < 5) {
          // 结构化打印：image 子对象只保留键 + hash(hex)，不含其他
          const imgObj = p.image || p.imageRef || null;
          let imgStruct = null;
          if (imgObj && typeof imgObj === "object") {
            imgStruct = {};
            for (const [k, v] of Object.entries(imgObj)) {
              if (k.endsWith("Tag")) continue;
              if (v instanceof Uint8Array || Buffer.isBuffer(v)) imgStruct[k] = { __bytes: v.length, hex: Buffer.from(v).toString("hex") };
              else if (typeof v === "object" && v !== null) imgStruct[k] = Object.keys(v);
              else imgStruct[k] = v; // hash 字符串/数字：内容寻址指针
            }
          }
          imagePaints.push({ host, paintKeys: keys, image: imgStruct });
        }
      }
    }
  };
  for (const n of nc) {
    scanPaints(n.fillPaints, "fillPaints");
    scanPaints(n.strokePaints, "strokePaints");
  }
  report.message.imagePaintCount = Object.values(refKeySets).reduce((a, b) => a + b, 0);
  report.message.imagePaintKeySignatures = refKeySets;
  report.message.imagePaintSamples = imagePaints;

  console.log(JSON.stringify(report, null, 2));
}

try { main(); } catch (e) { console.error("FATAL:", e.message); console.error(e.stack); process.exit(1); }
