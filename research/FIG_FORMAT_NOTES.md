# Figma `.fig` 二进制结构笔记（实证样本）

> **范围**：纯 read 探索。不生成 `.fig`，不碰 Figma runtime / plugin / MCP。  
> **样本**：`./sample.fig`  
> **工具**：`dump-fig.mjs` + `kiwi-schema` + `fzstd` + `adm-zip` + Node `zlib`  
> **生成时间**：2026-07-14（脚本 `out/summary.json` 时间戳为准）  
> **置信度**：结构字段 / 字节偏移 / inflate 结果 = **高**（本机 CLI 可复现）；语义解释（blob 内容格式等）= **中/低**（未深挖）

---

## 0. 复现命令（确定性）

```powershell
cd fig-format-explore
node dump-fig.mjs "./sample.fig"
```

产出目录：`out/`

| 文件 | 内容 |
|------|------|
| `out/summary.json` | magic/version/chunk/类型计数总览 |
| `out/schema.json` | 622 个 definition 的字段清单（name/type/number） |
| `out/schema-fields.txt` | 同上，人读文本 |
| `out/message.json` | 完整 `decodeMessage` JSON（NodeTree 根） |
| `out/node-index.json` | 1642 节点紧凑索引 |
| `out/node-samples.json` | FRAME / TEXT / ROUNDED_RECTANGLE 字段填充实况 |
| `out/canvas.fig` | 从 ZIP 抽出的 fig-kiwi 本体 |
| `out/meta.json` | ZIP 内 sidecar |
| `out/zip-entries.json` | ZIP 条目尺寸 |

### 样本指纹（本机核实）

| 对象 | 值 |
|------|-----|
| outer size | `1571694` |
| outer SHA-256 | `cf542aed7b753c65cbe94e742205c5af1ea6d65517ccb0f37d10d54035c05fc3` |
| canvas.fig size | `1561533` |
| canvas SHA-256 | `f3857b3085a7aeecad3347efe1ee00b146a653bb145c8d74e8be1759b17c3e97` |
| magic (latin1) | `fig-kiwi` |
| version (uint32 LE) | `106` (`0x6A`) |

---

## 1. 两层容器：ZIP → fig-kiwi

### 1.1 外层 ZIP（桌面导出 `.fig`）

**事实**：样本文件头 4 字节 = `50 4B 03 04`（ZIP local file header），**不是**裸 `fig-kiwi`。

Central directory 实测条目：

| name | method | compressed | uncompressed | 备注 |
|------|--------|------------|--------------|------|
| `canvas.fig` | 0 (store) | 1561533 | 1561533 | fig-kiwi 本体 |
| `thumbnail.png` | 0 (store) | 9116 | 9116 | 预览图 |
| `meta.json` | 8 (deflate) | 233 | 322 | sidecar JSON |
| `images/` | 0 | 0 | 0 | 空目录 |

**注意**：general purpose flag 含 bit3（data descriptor，flags=`0x0808`）。**只扫 local header 会读到 size=0 而失败**；必须走 central directory（`adm-zip` / .NET `ZipFile` 均可）。

`meta.json` 内容（完整）：

```json
{
  "client_meta": {
    "background_color": {"r":0.9607843160629272,"g":0.9607843160629272,"b":0.9607843160629272,"a":1},
    "thumbnail_size": {"width":400,"height":134},
    "render_coordinates": {"x":0,"y":0,"width":5360,"height":1800}
  },
  "file_name": "sample",
  "developer_related_links": [],
  "exported_at": "2026-07-14T06:25:49.224Z"
}
```

### 1.2 内层 `canvas.fig` = fig-kiwi archive

字节布局（**全部实测**）：

```
offset 0..7   : magic "fig-kiwi"  (latin1 / ASCII)
offset 8..11  : version uint32 LE = 106
offset 12..   : chunk stream
```

每个 chunk：

```
uint32 LE size
bytes[size]   // 压缩载荷
```

本样本 **恰好 2 个 chunk**，无 trailing bytes：

| chunk | size 字段偏移 | size | 数据偏移 | 数据结束 | 压缩 | inflate 后 |
|-------|---------------|------|----------|----------|------|-----------|
| 0 schema | 12 | 28465 | 16 | 28481 | **deflateRaw** | 70974 B |
| 1 data | 28481 | 1533048 | 28485 | 1561533 | **zstd** | 2869289 B |

校验：`12 + 4 + 28465 + 4 + 1533048 = 1561533` ✓

#### 压缩判别（禁止猜测失败路径）

| 信号 | 含义 |
|------|------|
| chunk0 head `b5 bd 09 98 ...` | 无固定 magic；`zlib.inflateRaw` 成功 → raw deflate |
| chunk1 head `28 b5 2f fd ...` | **zstd frame magic**；`fzstd.decompress` 成功 |
| 对 chunk1 用 inflateRaw | **失败** `invalid stored block lengths`（红线：不可硬猜 deflate） |

**反共识结论**（相对早期文档/旧库）：

```
约束：version 已到 106
→ 市场/旧资料常写「schema + data 均为 deflateRaw」
→ 错在：本样本 data 已切 zstd，schema 仍 deflateRaw
→ Z：chunk 压缩算法按载荷头探测，禁止写死单一 algo
```

旧包 `fig-kiwi@0.0.1` 默认 writer version=15、双 deflateRaw，**不能直接代表 2026 桌面导出**。

---

## 2. Schema chunk（kiwi binary schema）

流程：

```
chunk0 bytes → inflateRaw → decodeBinarySchema (kiwi-schema) → Schema
```

### 2.1 规模（本样本 embedded schema）

| kind | count |
|------|------:|
| ENUM | 204 |
| STRUCT | 30 |
| MESSAGE | 388 |
| **total** | **622** |

完整清单：`out/schema.json` / `out/schema-fields.txt`。

### 2.2 关键类型（摘录，编号= kiwi field value）

**STRUCT GUID**

| # | name | type |
|---|------|------|
| 1 | sessionID | uint |
| 2 | localID | uint |

**STRUCT Vector** `x,y : float`  
**STRUCT Matrix** `m00,m01,m02,m10,m11,m12 : float`  
**STRUCT ParentIndex** `guid:GUID`, `position:string`  
**STRUCT Color** `r,g,b,a : float`  
**STRUCT Blob** `bytes:byte[]`

**ENUM NodeType**（部分；完整见 schema）

| # | name |
|---|------|
| 0 | NONE |
| 1 | DOCUMENT |
| 2 | CANVAS |
| 3 | GROUP |
| 4 | FRAME |
| 10 | RECTANGLE |
| 12 | ROUNDED_RECTANGLE |
| 13 | TEXT |
| 28 | VARIABLE |
| 31 | VARIABLE_SET |
| 46 | BRUSH |
| … | （样本 schema 共扩展到 60+ 含 SLIDE / CODE_* / WEBPAGE 等） |

**MESSAGE Message**（根消息；字段号可跳号）

| # | name | type | 本样本是否有值 |
|---|------|------|----------------|
| 1 | type | MessageType | ✓ `NODE_CHANGES` |
| 2 | sessionID | uint | ✓ `0` |
| 3 | ackID | uint | ✓ `0` |
| 4 | nodeChanges | NodeChange[] | ✓ **1642** |
| 6 | blobs | Blob[] | ✓ **980** |
| 47 | originFileKey | string | ✓（长 hex 串） |
| 48 | nodeChangeOrder | NodeChangeOrder | ✓ `GUID` |
| 其余 41 个字段 | … | … | 空（见 summary） |

**MESSAGE NodeChange**：schema 内 **600** 字段条目（含 `*Tag` 伴生字段）；非 Tag 约 **540** 个业务字段。  
节点不是 class 继承树，而是 **单一大 Message 类型 + 可选字段稀疏填充**。

---

## 3. Data chunk → Message（“NodeTree”）

流程：

```
chunk1 bytes → zstd decompress → compileSchema(schema).decodeMessage(bytes) → Message
```

### 3.1 顶层实况

```json
{
  "type": "NODE_CHANGES",
  "sessionID": 0,
  "ackID": 0,
  "originFileKey": "lk-62d80cf3…",
  "nodeChangeOrder": "GUID",
  "nodeChanges": [ /* 1642 */ ],
  "blobs": [ /* 980 × { bytes: Uint8Array } */ ]
}
```

### 3.2 NodeTree 组织方式（关键）

**不是**嵌套 JSON tree，而是：

1. 扁平 `nodeChanges: NodeChange[]`
2. 每个节点用 `guid {sessionID, localID}` 标识
3. 父子关系用 `parentIndex { guid, position }` 表达（`position` 为排序字符串，如 `"!"`）
4. 几何 path / 矢量命令等通过 `fillGeometry[].commandsBlob` 等 **索引进 `blobs[]`**

根：

| guid | type | name |
|------|------|------|
| `0:0` | DOCUMENT | Document |
| `0:1` | CANVAS | Page 1 | parent=`0:0` |

### 3.3 本样本节点类型分布

| type | count |
|------|------:|
| FRAME | 914 |
| TEXT | 666 |
| BRUSH | 25 |
| VARIABLE | 19 |
| ELLIPSE | 6 |
| ROUNDED_RECTANGLE | 6 |
| CANVAS | 4 |
| DOCUMENT | 1 |
| VARIABLE_SET | 1 |
| **合计** | **1642** |

**RECTANGLE (enum #10) 在本样本中 count=0**。  
矩形外观节点以 `ROUNDED_RECTANGLE` 出现（即使 UI 名可能是 “Rectangle”）。

---

## 4. 字段填充实况（FRAME / 矩形 / TEXT）

来源：`out/node-samples.json`（每类最多 3 个样本）。  
对照基线：NodeChange 非 Tag 字段约 540 个 → 单节点通常只填 **十几～三十几个**。

### 4.1 FRAME 样本：`管理后台样例页`

| 字段 | 值域摘要 |
|------|----------|
| guid | `{5,2}` |
| phase | `CREATED` |
| parentIndex | canvas `0:1`, position `"!"` |
| type | `FRAME` |
| name | `管理后台样例页` |
| visible | true |
| opacity | 1 |
| size | `{x:1280, y:840}` |
| transform | identity, 平移 0 |
| strokeWeight | 1 |
| strokeAlign | `INSIDE` |
| strokeJoin | `MITER` |
| fillPaints | 1× SOLID 近白灰 RGB≈(0.969,0.973,0.980) |
| fillGeometry | 1 path, `commandsBlob:0` |
| stackMode | `HORIZONTAL` |
| stackPrimarySizing | `FIXED` |
| frameMaskDisabled | false |
| editInfo | userId + lastEditedAt/createdAt |

**filled ≈ 18 / ~540**。Auto-layout 相关字段有值；大量 effect/prototype/component 字段为空。

### 4.2 ROUNDED_RECTANGLE 样本：`Rectangle`（矩形代理）

| 字段 | 值域摘要 |
|------|----------|
| type | `ROUNDED_RECTANGLE`（非 RECTANGLE） |
| size | `{28, 28}` |
| transform | 平移 `(20, 0)` |
| cornerRadius | `6` |
| rectangleTopLeft/Right/Bottom*CornerRadius | 均为 `6` |
| fillPaints | SOLID 蓝 RGB≈(0.145, 0.396, 0.812) |
| fillGeometry | path, `commandsBlob:856` → 指向 blobs[856] |
| stroke* | weight=1, align=INSIDE, join=MITER |

**filled ≈ 20**。圆角以 `cornerRadius` + 四角独立字段双写。

### 4.3 TEXT 样本：`B`

| 字段 | 值域摘要 |
|------|----------|
| type | `TEXT` |
| name / characters | `"B"` |
| fontSize | 15 |
| fontName | `{family:"Inter", style:"Bold", postscript:""}` |
| lineHeight | `{value:100, units:"PERCENT"}` |
| letterSpacing | `{value:0, units:"PERCENT"}` |
| textAlignVertical | `TOP` |
| textAutoResize | `WIDTH_AND_HEIGHT` |
| size | `{10, 18}` |
| transform | 平移 `(9, 5)` |
| fillPaints | SOLID 白 |
| textData | characters + lines[] + … |
| derivedTextData | layoutSize / baselines / glyphs（渲染派生） |
| fontVariant* / textBidiVersion / emojiImageSet | 有默认填充 |

**filled ≈ 32**（文本字段比 frame 更密）。  
字符内容在 `textData.characters`；字形轮廓等进一步引用 blobs。

### 4.4 共性观察（高置信）

1. **稀疏 Message 编码**：未设置的字段不出现在 decode 结果中（kiwi optional）。  
2. **几乎所有可视节点**都带：`guid, phase, type, name?, visible, opacity, size, transform, stroke*, fillPaints?`。  
3. **几何权威数据**常在 `blobs` + `*Geometry.commandsBlob` 索引，而不全在 JSON 标量里。  
4. **Tag 字段**（`guidTag` 等）是 schema/编码层伴生，业务 dump 可忽略。

---

## 5. 端到端解析流水线（实现契约）

```
.fig (ZIP, PK\x03\x04)
  ├─ meta.json, thumbnail.png, images/
  └─ canvas.fig
        ├─ "fig-kiwi" + uint32le version
        ├─ chunk0: deflateRaw → kiwi binary schema → decodeBinarySchema
        └─ chunk1: zstd|deflateRaw → Message bytes → compileSchema.decodeMessage
              └─ nodeChanges[] + blobs[]  = 场景图
```

伪代码（与 `dump-fig.mjs` 一致）：

```js
const zip = new AdmZip(figPath);
const canvas = zip.getEntry("canvas.fig").getData();
assert(canvas.toString("latin1", 0, 8) === "fig-kiwi");
const version = canvas.readUInt32LE(8);
// parse length-prefixed chunks...
const schemaBytes = zlib.inflateRawSync(chunks[0]);
const dataBytes = chunks[1][0]===0x28 && chunks[1][1]===0xb5
  ? Buffer.from(fzstd.decompress(chunks[1]))
  : zlib.inflateRawSync(chunks[1]);
const schema = decodeBinarySchema(schemaBytes);
const message = compileSchema(schema).decodeMessage(dataBytes);
```

---

## 6. 红线与失败模式（已踩坑记录）

| 症状 | 原因 | 正确做法 |
|------|------|----------|
| magic=`PK` 而非 fig-kiwi | 外层是 ZIP | 先解 `canvas.fig` |
| ZIP size=0 / data descriptor | flag bit3 | 用 central directory / adm-zip |
| data inflateRaw 失败 | version≥? 起 data 用 zstd | 看 `28 B5 2F FD` 后走 zstd |
| 用静态旧 schema 解码 | schema 随文件 embedded 且演进 | **必须用 chunk0 内嵌 schema** |
| 找不到 RECTANGLE 节点 | 样本用 ROUNDED_RECTANGLE | 按 typeCounts 统计，不假设 |

**未做 / 明确不做**：

- 不写回 / 不 encode `.fig`
- 不调用 Figma Desktop / plugin / MCP `use_figma`
- 不把“自己 decode 再 encode 读回”当成功判据——成功 = 本报告 + `out/*` 确定性产物

---

## 7. 证伪条件（贝叶斯）

若以下证据出现，需修正本笔记对应命题：

1. 出现 **chunkCount≠2** 的合法桌面 `.fig` → “双 chunk” 仅是本样本，非常量。  
2. schema chunk 也出现 zstd magic → 压缩探测表要扩展。  
3. 某文件 `decodeMessage` 根类型不是 `Message` / 无 `nodeChanges` → 根消息契约需改。  
4. 导出 `.fig` 变为裸 fig-kiwi（无 ZIP）→ 外层容器变为可选（脚本已支持 raw 路径）。

---

## 8. 依赖与版权边界

| 包 | 用途 |
|----|------|
| `kiwi-schema` | binary schema decode + compile + message decode |
| `fzstd` | zstd frame decompress |
| `adm-zip` | ZIP central-directory 读取 |
| Node `zlib` | deflateRaw |
| `fig-kiwi` / `@vetrivelcsamy/fig-kiwi-parser` | 参考 archive 布局（本 dump **未依赖**其过时 inflate 路径） |

格式逆向基于公开 kiwi 布局 + 样本字节实证；Figma 文件格式本身无官方完整公开规范。
