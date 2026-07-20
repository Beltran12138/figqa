/**
 * Phase 1d-v4：最大可见度 mutation（用户 v2/v3 肉眼无感）
 *
 * 策略（多层同时炸，1c 已证 name 可进 Figma）：
 *   A. 全树有 name 的节点加前缀 marker（图层面板必见）
 *   B. 所有 CANVAS 的 backgroundColor → 品红 (1,0,1)
 *   C. Page 0:1 下全部顶层 FRAME 的 fillPaints → 高饱和纯色（轮换红/青/黄）
 *   D. 克隆最大 FRAME，挂到 canvas 0:1，size 2200×1600，fill 纯绿，
 *      transform (100, 2200) 画布下方，position 避碰撞，strip fillGeometry
 *
 * 产出：out/addnode-v4.fig + out/addnode-v4-report.json
 * stdout 合规：禁打印 name/业务文字；颜色只报 r,g,b 数值。
 *
 * Usage: node add-node.mjs [path.fig]
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
const MAGIC = "fig-kiwi";
const DEFAULT_SRC = "./sample.fig";

const NAME_PREFIX = "■V4·";
const NEW_NODE_NAME = "■V4-HUGE-GREEN";
const OUT_FIG = "addnode-v4.fig";
const OUT_REPORT = "addnode-v4-report.json";

const CANVAS_GUID = { sessionID: 0, localID: 1 };
const POS_CODE_MIN = 33;
const POS_CODE_MAX = 126;
const SKIP_POS_CODE = 78;

// 高饱和纯色（数值可打印）
const NEON = {
  magenta: { r: 1, g: 0, b: 1, a: 1 },
  red: { r: 1, g: 0, b: 0, a: 1 },
  cyan: { r: 0, g: 1, b: 1, a: 1 },
  yellow: { r: 1, g: 1, b: 0, a: 1 },
  green: { r: 0, g: 1, b: 0, a: 1 },
};
const FRAME_PALETTE = [NEON.red, NEON.cyan, NEON.yellow, NEON.red, NEON.cyan, NEON.yellow];

// ---------- archive ----------
function parseArchive(buf) {
  const magic = buf.toString("latin1", 0, 8);
  if (magic !== MAGIC) throw new Error(`bad magic ${JSON.stringify(magic)}`);
  const version = buf.readUInt32LE(8);
  const chunks = [];
  let off = 12;
  while (off + 4 <= buf.length) {
    const size = buf.readUInt32LE(off);
    off += 4;
    if (off + size > buf.length) throw new Error(`chunk overrun at ${off}`);
    chunks.push({ size, data: Buffer.from(buf.subarray(off, off + size)) });
    off += size;
  }
  if (off !== buf.length) throw new Error(`trailing ${buf.length - off} B`);
  return { magic, version, chunks };
}

function buildArchive(version, chunkBytes) {
  const parts = [Buffer.from(MAGIC, "latin1")];
  const v = Buffer.alloc(4);
  v.writeUInt32LE(version, 0);
  parts.push(v);
  for (const cb of chunkBytes) {
    const sz = Buffer.alloc(4);
    sz.writeUInt32LE(cb.length, 0);
    parts.push(sz, cb);
  }
  return Buffer.concat(parts);
}

function u8(b) {
  return b instanceof Uint8Array ? b : new Uint8Array(b);
}
function byteEqual(a, b) {
  a = u8(a);
  b = u8(b);
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}
function isBytes(x) {
  return x instanceof Uint8Array || Buffer.isBuffer(x);
}
function deepEqualMsg(a, b) {
  if (a == null || b == null) return a === b;
  const ab = isBytes(a),
    bb = isBytes(b);
  if (ab || bb) return ab && bb && byteEqual(a, b);
  if (typeof a !== "object" || typeof b !== "object") return a === b;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  const ka = Object.keys(a),
    kb = Object.keys(b);
  if (ka.length !== kb.length) return false;
  for (const k of ka) {
    if (!Object.prototype.hasOwnProperty.call(b, k)) return false;
    if (!deepEqualMsg(a[k], b[k])) return false;
  }
  return true;
}
function deepClone(obj) {
  return structuredClone(obj);
}

function nodeTypeEnumMap(schema) {
  const def = (schema.definitions || []).find((d) => d.name === "NodeType");
  if (!def) throw new Error("schema missing NodeType");
  const nameToInt = {};
  const intToName = {};
  for (const f of def.fields || []) {
    nameToInt[f.name] = f.value;
    intToName[f.value] = f.name;
  }
  return { nameToInt, intToName };
}
function typeToInt(typeVal, nameToInt) {
  if (typeof typeVal === "number") return typeVal;
  if (typeof typeVal === "string" && nameToInt[typeVal] !== undefined) return nameToInt[typeVal];
  throw new Error(`unknown NodeType ${JSON.stringify(typeVal)}`);
}
function fieldNames(obj) {
  if (!obj || typeof obj !== "object") return [];
  return Object.keys(obj).filter((k) => !k.endsWith("Tag") && obj[k] !== undefined);
}

function solidPaint(color) {
  return {
    type: "SOLID",
    color: { r: color.r, g: color.g, b: color.b, a: color.a ?? 1 },
    opacity: 1,
    visible: true,
    blendMode: "NORMAL",
  };
}

function setSolidFill(node, color) {
  node.fillPaints = [solidPaint(color)];
}

function siblingPositions(nodes, parent) {
  const used = new Set();
  let childCount = 0;
  for (const n of nodes) {
    const pg = n.parentIndex?.guid;
    if (!pg) continue;
    if (pg.sessionID === parent.sessionID && pg.localID === parent.localID) {
      childCount++;
      const p = n.parentIndex?.position;
      if (typeof p === "string") used.add(p);
    }
  }
  return { used, childCount };
}

function pickFreeSingleCharPosition(used) {
  for (let code = POS_CODE_MIN; code <= POS_CODE_MAX; code++) {
    if (code === SKIP_POS_CODE) continue;
    const ch = String.fromCharCode(code);
    if (!used.has(ch)) return { pos: ch, code };
  }
  throw new Error("no free position code");
}

function countPositionCollisions(nodes, parent) {
  const map = new Map();
  for (const n of nodes) {
    const pg = n.parentIndex?.guid;
    if (!pg) continue;
    if (pg.sessionID !== parent.sessionID || pg.localID !== parent.localID) continue;
    const p = n.parentIndex?.position;
    if (typeof p !== "string") continue;
    map.set(p, (map.get(p) || 0) + 1);
  }
  let collidingGroups = 0;
  for (const c of map.values()) if (c > 1) collidingGroups++;
  return { collidingGroups, uniquePositions: map.size };
}

function colorNums(c) {
  if (!c) return null;
  return { r: c.r, g: c.g, b: c.b, a: c.a };
}

function main() {
  const log = (...a) => console.error(...a);
  const src = process.argv[2] || DEFAULT_SRC;
  const outDir = path.join(__dirname, "out");
  fs.mkdirSync(outDir, { recursive: true });

  if (typeof zlib.zstdCompressSync !== "function") {
    throw new Error("need zlib.zstdCompressSync");
  }

  log(`[1] read`);
  const outerBuf = fs.readFileSync(src);
  const zip = new AdmZip(outerBuf);
  const ent = Object.fromEntries(zip.getEntries().map((e) => [e.entryName, e]));
  const getE = (n) => {
    const e = ent[n];
    if (!e) throw new Error(`ZIP missing ${n}`);
    return e.getData();
  };
  const canvasBuf = getE("canvas.fig");
  const thumbnailBuf = getE("thumbnail.png");
  const metaBuf = getE("meta.json");
  log(`[2] outer=${outerBuf.length} canvas=${canvasBuf.length}`);

  const arc = parseArchive(canvasBuf);
  const schemaChunkRaw = arc.chunks[0].data;
  const schemaInflated = zlib.inflateRawSync(schemaChunkRaw);
  const dataInflated = Buffer.from(fzstd.decompress(arc.chunks[1].data));
  const schema = decodeBinarySchema(new Uint8Array(schemaInflated));
  const { nameToInt, intToName } = nodeTypeEnumMap(schema);
  const FRAME_INT = nameToInt.FRAME;
  const CANVAS_INT = nameToInt.CANVAS;
  const RECTANGLE_INT = nameToInt.RECTANGLE;
  const ROUNDED_RECTANGLE_INT = nameToInt.ROUNDED_RECTANGLE;
  log(`[3] version=${arc.version} FRAME=${FRAME_INT} CANVAS=${CANVAS_INT}`);

  const compiled = compileSchema(schema);
  const origMsg = compiled.decodeMessage(new Uint8Array(dataInflated));
  const nodes = origMsg.nodeChanges || [];
  const origCount = nodes.length;
  log(`[4] nodes=${origCount} blobs=${origMsg.blobs?.length ?? 0}`);

  // ========== MUTATIONS ==========
  const stats = {
    namePrefixed: 0,
    canvasBgRecolored: 0,
    topFramesRecolored: 0,
    topFramesRenamed: 0,
    hugeAdded: false,
  };

  // A) 全树 name 前缀（1c 路径，图层面板洪水）
  for (const n of nodes) {
    if (typeof n.name === "string" && n.name.length > 0 && !n.name.startsWith(NAME_PREFIX)) {
      n.name = NAME_PREFIX + n.name;
      stats.namePrefixed++;
    }
  }
  log(`[A] namePrefixed=${stats.namePrefixed}`);

  // B) 所有 CANVAS backgroundColor → magenta
  for (const n of nodes) {
    if (typeToInt(n.type, nameToInt) !== CANVAS_INT) continue;
    n.backgroundColor = { ...NEON.magenta };
    n.backgroundEnabled = true;
    n.backgroundOpacity = 1;
    stats.canvasBgRecolored++;
  }
  log(
    `[B] canvasBgRecolored=${stats.canvasBgRecolored} color=${JSON.stringify(colorNums(NEON.magenta))}`
  );

  // C) Page 0:1 顶层 FRAME → 高饱和 fill + 确保 name 前缀
  const topFrames = [];
  for (const n of nodes) {
    if (typeToInt(n.type, nameToInt) !== FRAME_INT) continue;
    const pg = n.parentIndex?.guid;
    if (!pg || pg.sessionID !== CANVAS_GUID.sessionID || pg.localID !== CANVAS_GUID.localID) continue;
    topFrames.push(n);
  }
  topFrames.forEach((n, i) => {
    const col = FRAME_PALETTE[i % FRAME_PALETTE.length];
    setSolidFill(n, col);
    // 不 strip fillGeometry：只改 paint 颜色，path 仍合法
    // 强制可见
    n.visible = true;
    n.opacity = 1;
    stats.topFramesRecolored++;
    if (typeof n.name === "string" && n.name.startsWith(NAME_PREFIX)) stats.topFramesRenamed++;
  });
  log(
    `[C] topFrames under 0:1 count=${topFrames.length} recolored=${stats.topFramesRecolored} ` +
      `paletteCycle=red/cyan/yellow`
  );

  // D) 克隆最大 FRAME → 挂 canvas 0:1，超大绿块
  let bestFrame = null;
  let bestArea = -1;
  for (const n of nodes) {
    if (typeToInt(n.type, nameToInt) !== FRAME_INT) continue;
    if (!n.size || !n.fillPaints?.length) continue;
    const a = n.size.x * n.size.y;
    if (a > bestArea) {
      bestArea = a;
      bestFrame = n;
    }
  }
  if (!bestFrame) throw new Error("no FRAME with size+fill to clone");

  let maxLocal = 0;
  for (const n of nodes) {
    if (n.guid && typeof n.guid.localID === "number" && n.guid.localID > maxLocal) {
      maxLocal = n.guid.localID;
    }
  }
  const newGuid = { sessionID: 0, localID: maxLocal + 1 }; // session 0 更像文档原生

  const { used: usedOnCanvas, childCount: canvasKidsBefore } = siblingPositions(nodes, CANVAS_GUID);
  const posPick = pickFreeSingleCharPosition(usedOnCanvas);
  log(
    `[D] cloneFrame srcGuid=${bestFrame.guid.sessionID}:${bestFrame.guid.localID} ` +
      `srcSize=(${bestFrame.size.x},${bestFrame.size.y}) area=${bestArea} ` +
      `canvasKidsBefore=${canvasKidsBefore} freePosCode=${posPick.code} newGuid=0:${newGuid.localID}`
  );

  const huge = deepClone(bestFrame);
  // 清掉不宜继承的复杂字段（组件/原型/stack 子树语义）
  const dropKeys = [
    "editInfo",
    "pluginData",
    "pluginRelaunchData",
    "symbolData",
    "sharedSymbolReference",
    "derivedSymbolData",
    "prototypeInteractions",
    "componentPropDefs",
    "componentPropRefs",
    "componentPropAssignments",
    "guidPath",
    "overrideKey",
    "exportSettings",
    "interactions",
    "reactions",
  ];
  for (const k of dropKeys) {
    if (huge[k] !== undefined) delete huge[k];
  }
  // stack 相关：新块不参与 auto-layout 父（canvas 无 stack），清掉 stack 以免歧义
  for (const k of Object.keys(huge)) {
    if (k.startsWith("stack") && k !== "stackPositioning") delete huge[k];
  }
  delete huge.stackPositioning;

  huge.guid = { sessionID: newGuid.sessionID, localID: newGuid.localID };
  huge.phase = "CREATED";
  huge.type = "FRAME";
  huge.name = NEW_NODE_NAME;
  huge.visible = true;
  huge.opacity = 1;
  huge.parentIndex = {
    guid: { sessionID: CANVAS_GUID.sessionID, localID: CANVAS_GUID.localID },
    position: posPick.pos,
  };
  huge.size = { x: 2200, y: 1600 };
  huge.transform = {
    m00: 1,
    m01: 0,
    m02: 100,
    m10: 0,
    m11: 1,
    m12: 2200, // 画布下方，所有 artboard 下面
  };
  setSolidFill(huge, NEON.green);
  // size 变了：必须 strip 派生几何
  delete huge.fillGeometry;
  delete huge.strokeGeometry;
  // 圆角大一点更“块”
  huge.cornerRadius = 40;
  huge.rectangleTopLeftCornerRadius = 40;
  huge.rectangleTopRightCornerRadius = 40;
  huge.rectangleBottomLeftCornerRadius = 40;
  huge.rectangleBottomRightCornerRadius = 40;
  huge.rectangleCornerRadiiIndependent = true;
  huge.strokeWeight = 8;
  huge.strokeAlign = "INSIDE";
  huge.strokePaints = [solidPaint({ r: 0, g: 0, b: 0, a: 1 })];
  huge.frameMaskDisabled = true;

  nodes.push(huge);
  stats.hugeAdded = true;
  const newCount = nodes.length;
  log(
    `[D] huge pushed size=(2200,1600) xy=(100,2200) posCode=${posPick.code} ` +
      `fillRGB=${JSON.stringify(colorNums(NEON.green))} fieldCount=${fieldNames(huge).length}`
  );
  log(`    hugeFieldNames=${fieldNames(huge).join(",")}`);

  origMsg.nodeChanges = nodes;

  // 碰撞
  const coll = countPositionCollisions(nodes, CANVAS_GUID);
  const canvasKidsAfter = siblingPositions(nodes, CANVAS_GUID).childCount;
  log(
    `[E] canvas 0:1 collisionGroups=${coll.collidingGroups} kids=${canvasKidsAfter} (expect coll=0)`
  );

  // L2
  const reEncoded = compiled.encodeMessage(origMsg);
  const reDecoded = compiled.decodeMessage(new Uint8Array(reEncoded));
  const l2 = deepEqualMsg(reDecoded, origMsg);

  let prefixInL2 = 0;
  let hugeInL2 = false;
  let canvasMagentaL2 = 0;
  let topNeonL2 = 0;
  for (const n of reDecoded.nodeChanges || []) {
    if (typeof n.name === "string" && n.name.startsWith(NAME_PREFIX)) prefixInL2++;
    if (n.guid?.sessionID === newGuid.sessionID && n.guid?.localID === newGuid.localID) {
      hugeInL2 =
        n.size?.x === 2200 &&
        n.size?.y === 1600 &&
        n.transform?.m02 === 100 &&
        n.transform?.m12 === 2200 &&
        n.name === NEW_NODE_NAME;
    }
    if (typeToInt(n.type, nameToInt) === CANVAS_INT) {
      const c = n.backgroundColor;
      if (c && c.r === 1 && c.g === 0 && c.b === 1) canvasMagentaL2++;
    }
    const pg = n.parentIndex?.guid;
    if (
      typeToInt(n.type, nameToInt) === FRAME_INT &&
      pg?.sessionID === 0 &&
      pg?.localID === 1 &&
      n.guid?.localID !== newGuid.localID
    ) {
      const col = n.fillPaints?.[0]?.color;
      if (col && (col.r === 1 || col.g === 1) && col.a === 1) topNeonL2++;
    }
  }
  log(
    `[L2] equal=${l2} prefix=${prefixInL2}/${stats.namePrefixed} huge=${hugeInL2} ` +
      `canvasMagenta=${canvasMagentaL2} topNeon≈${topNeonL2}`
  );

  // package
  const newDataChunk = zlib.zstdCompressSync(Buffer.from(reEncoded));
  const newCanvas = buildArchive(arc.version, [schemaChunkRaw, newDataChunk]);
  const newZip = new AdmZip();
  const cE = newZip.addFile("canvas.fig", newCanvas);
  cE.header.method = 0;
  const tE = newZip.addFile("thumbnail.png", thumbnailBuf);
  tE.header.method = 0;
  newZip.addFile("meta.json", metaBuf);
  try {
    const dE = newZip.addFile("images/", Buffer.alloc(0));
    if (dE) dE.header.method = 0;
  } catch (e) {
    log(`    images/ skip: ${e.message}`);
  }
  const outPath = path.join(outDir, OUT_FIG);
  newZip.writeZip(outPath);
  const outSize = fs.statSync(outPath).size;
  log(`[pkg] wrote out/${OUT_FIG} bytes=${outSize}`);

  // L3b
  const rtZip = new AdmZip(fs.readFileSync(outPath));
  const rCanvas = rtZip.getEntries().find((e) => e.entryName === "canvas.fig");
  const rArc = parseArchive(rCanvas.getData());
  const rMsg = compiled.decodeMessage(new Uint8Array(fzstd.decompress(rArc.chunks[1].data)));
  const rCount = rMsg.nodeChanges?.length ?? 0;

  let prefixL3 = 0;
  let hugeL3 = false;
  let hugeChecks = {};
  let canvasMagentaL3 = 0;
  let topNeonL3 = 0;
  for (const n of rMsg.nodeChanges || []) {
    if (typeof n.name === "string" && n.name.startsWith(NAME_PREFIX)) prefixL3++;
    if (n.guid?.sessionID === newGuid.sessionID && n.guid?.localID === newGuid.localID) {
      hugeL3 = true;
      const fc = n.fillPaints?.[0]?.color;
      hugeChecks = {
        sizeOk: n.size?.x === 2200 && n.size?.y === 1600,
        xyOk: n.transform?.m02 === 100 && n.transform?.m12 === 2200,
        nameOk: n.name === NEW_NODE_NAME,
        parentOk: n.parentIndex?.guid?.sessionID === 0 && n.parentIndex?.guid?.localID === 1,
        posCodeOk: n.parentIndex?.position?.charCodeAt?.(0) === posPick.code,
        fillGreen: fc && fc.r === 0 && fc.g === 1 && fc.b === 0,
        noFillGeometry: n.fillGeometry === undefined,
        typeInt: typeToInt(n.type, nameToInt),
      };
    }
    if (typeToInt(n.type, nameToInt) === CANVAS_INT) {
      const c = n.backgroundColor;
      if (c && c.r === 1 && c.g === 0 && c.b === 1) canvasMagentaL3++;
    }
    const pg = n.parentIndex?.guid;
    if (
      typeToInt(n.type, nameToInt) === FRAME_INT &&
      pg?.sessionID === 0 &&
      pg?.localID === 1 &&
      !(n.guid?.sessionID === newGuid.sessionID && n.guid?.localID === newGuid.localID)
    ) {
      const col = n.fillPaints?.[0]?.color;
      if (col && col.a === 1 && (col.r + col.g + col.b >= 1) && (col.r === 1 || col.g === 1 || col.b === 1)) {
        // crude neon detect
        if (
          (col.r === 1 && col.g === 0 && col.b === 0) ||
          (col.r === 0 && col.g === 1 && col.b === 1) ||
          (col.r === 1 && col.g === 1 && col.b === 0)
        ) {
          topNeonL3++;
        }
      }
    }
  }

  const collL3 = countPositionCollisions(rMsg.nodeChanges || [], CANVAS_GUID);
  const l3b =
    rCount === newCount &&
    prefixL3 === stats.namePrefixed &&
    hugeL3 &&
    hugeChecks.sizeOk &&
    hugeChecks.xyOk &&
    hugeChecks.nameOk &&
    hugeChecks.parentOk &&
    hugeChecks.fillGreen &&
    canvasMagentaL3 === stats.canvasBgRecolored &&
    collL3.collidingGroups === 0;

  log(
    `[L3b] nodes=${rCount} prefix=${prefixL3} huge=${hugeL3} checks=${JSON.stringify(hugeChecks)} ` +
      `canvasMagenta=${canvasMagentaL3} topNeon=${topNeonL3} coll=${collL3.collidingGroups} pass=${l3b}`
  );

  const report = {
    phase: "1d-v4-max-visibility",
    src,
    generatedAt: new Date().toISOString(),
    intent:
      "Flood layers with name prefix + magenta canvas + neon top frames + 2200x1600 green frame below artboards",
    mutations: {
      A_namePrefix: { count: stats.namePrefixed, prefixMarker: "V4-block-prefix" },
      B_canvasBackground: {
        count: stats.canvasBgRecolored,
        color: colorNums(NEON.magenta),
      },
      C_topFrameFills: {
        count: stats.topFramesRecolored,
        palette: FRAME_PALETTE.map(colorNums),
      },
      D_hugeFrame: {
        added: stats.hugeAdded,
        guid: newGuid,
        typeInt: FRAME_INT,
        size: { x: 2200, y: 1600 },
        transform: { m02: 100, m12: 2200 },
        positionCode: posPick.code,
        parent: CANVAS_GUID,
        fill: colorNums(NEON.green),
        fillGeometryStripped: true,
        sourceCloneGuid: {
          sessionID: bestFrame.guid.sessionID,
          localID: bestFrame.guid.localID,
        },
        sourceArea: bestArea,
        fieldNames: fieldNames(huge),
      },
    },
    counts: {
      origNodeChanges: origCount,
      newNodeChanges: newCount,
      canvasKidsBefore,
      canvasKidsAfter,
    },
    positionAvoidance: {
      parent: CANVAS_GUID,
      chosenCode: posPick.code,
      alphabet: `${POS_CODE_MIN}-${POS_CODE_MAX} skip ${SKIP_POS_CODE}`,
      collisionGroups: coll.collidingGroups,
      collisionGroupsL3b: collL3.collidingGroups,
    },
    verdict: {
      l2: l2,
      l2_prefix: prefixInL2 === stats.namePrefixed,
      l2_huge: hugeInL2,
      l3b: l3b,
      l3b_detail: {
        prefixL3,
        hugeL3,
        hugeChecks,
        canvasMagentaL3,
        topNeonL3,
        nodeCountOk: rCount === newCount,
        collisionGroupsZero: collL3.collidingGroups === 0,
      },
      pass: l2 && l3b && hugeInL2,
    },
    sizes: {
      orig_fig: outerBuf.length,
      addnode_v4_fig: outSize,
      re_encoded: reEncoded.length,
      new_canvas: newCanvas.length,
    },
    outputs: { fig: `out/${OUT_FIG}`, report: `out/${OUT_REPORT}` },
    howToSee: [
      "1. Import out/addnode-v4.fig",
      "2. Layers panel: nearly all names start with marker prefix",
      "3. Page background should be magenta (1,0,1)",
      "4. Top-level artboards: red/cyan/yellow fills",
      "5. Scroll DOWN below artboards: 2200x1600 pure green frame at y=2200",
    ],
  };

  fs.writeFileSync(path.join(outDir, OUT_REPORT), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
  if (!report.verdict.pass) process.exitCode = 2;
}

try {
  main();
} catch (e) {
  console.error("FATAL:", e.message);
  console.error(e.stack);
  process.exit(1);
}
