# Figma `.fig` 代码生成实践（写侧 code-to-design）

> **姊妹篇**：[`FIG_FORMAT_NOTES.md`](./FIG_FORMAT_NOTES.md)（read 侧格式笔记，本文不重复格式链细节，只引用）
> **实证基础**：本目录 Phase 1a-1e（2026-07-14 全通过，Figma import 逐项确认）
> **定位**：好奇驱动探索，**非生产即用解**。生产改图请用 [Figma MCP `use_figma`](https://help.figma.com/hc/en-us/articles/32132100833559)（Plugin API，即时可视）
> **本机核实**：2026-07-20（脚本 + 产物全在，见 §4）

---

## 0. 定位与边界

**code-to-design** = 用代码程序化生成/改 `.fig` 文件，脱 Figma runtime。

**适用场景**：批量生成 / 从结构化数据直出 / 离线 / 无 figma 账号。

**反逢迎边界**（老实说能做什么、不能做什么）：
- ✅ 已闭环：**半克隆造 TEXT 子集**（从模板提字段集填新值，实用场景已覆盖）
- ❌ 未验：纯盲猜字段集从零 / VECTOR·path / INSTANCE·componentId / IMAGE blob / 全量复杂布局
- ROI 判断：未验项递减，纯从零造无实用必要（总能提取模板）

**不替代 Plugin API**：生产即用解仍是「一次生成 createNode 脚本 → 单次 MCP `use_figma` 灌入」（省 ~80% token，即时可视）。本文档是「脱 runtime」的探索线。

---

## 1. 写侧能力矩阵（Phase 1a-1e 实证，高置信）

| Phase | 能力 | 实证方式 | 产物 |
|---|---|---|---|
| 1a/1b | round-trip（读→decode→encode→zstd→ZIP） | Figma import「一模一样」 | `out/roundtrip.fig` |
| 1c | 可修改现有节点任意字段 | 满树 name 加前缀被 Figma 应用 | `out/mutated.fig` |
| 1d | 可加新节点（克隆现有改 guid） | 4 层 mutation 全被 Figma 接受 | `out/addnode-v4.fig` |
| 1e | 半克隆造新 TEXT | 模板提取字段集→填新值，中文渲染通过 | `out/html-slice.fig` |

**关键推论**（高置信）：Figma import 时**全量应用 nodeChanges**（按 `phase=CREATED` 全量重建树）且**完全信任每字段值** → nodeChange 非只读黑盒，每字段可写。

---

## 2. 仍未验边界（别外推）

| 未验项 | 说明 |
|---|---|
| 纯盲猜字段集从零 | 无实用必要（总能提取模板） |
| VECTOR·path | 矢量路径未造 |
| INSTANCE·componentId | 组件实例未造 |
| **IMAGE blob** | 图片填充未处理 |
| 全量复杂布局 | 大页面未整页跑通 |
| 布局精度 | 中文渲染正常，但排版精度未深验 |

---

## 3. 关键技术点（写侧独有，read 侧笔记没有）

### 3.1 zstd 压缩用 Node `zlib`，非 fzstd

`fzstd@0.1.1` 是**纯解压器，无 compress**。写回必须用 Node 内置 `zlib.zstdCompressSync`（Node 24+ 内置）。

### 3.2 `parentIndex.position` 排序键避碰

克隆节点复用源 `position` → 同 parent 下碰撞。解法 `pickFreeSingleCharPosition()`：扫 parent 子节点已用 position，挑未占用单字符（charset 32-126，skip 78，实证选 code 44）。这是 1d v1 失败、v4 成功的分水岭。

### 3.3 `fillPaints` / `fillGeometry` 不强制配对

改 size 致原 `fillGeometry` path 失效时，`delete fillGeometry`（paints 留、geometry 无），Figma 仍正常渲染 fill。证伪了早期预判「必须配对」。

### 3.4 半克隆策略（TEXT 字段集）

TEXT 字段集 = **30 个**（fontSize / textAlignVertical / lineHeight / fontName / **textData** / fontVariantCommonLigatures / letterSpacing / textTracking / textAutoResize ...）。纯从零盲猜不可能凑齐 → **先从模板 `.fig` 提取真实 TEXT 字段集照抄结构，只填新值**。

- `textData`（源，填 characters + lines）
- `derivedTextData`（派生，**留空**让 Figma 导入后自己算 layoutSize/baselines/glyphs）

### 3.5 树根与 guid

- 树根：`DOCUMENT` + `CANVAS` 双无 parent，Figma 容忍
- guid：新 `sessionID`（如 999），非改现有节点
- NodeType 整数枚举（运行时验）：CANVAS=2 / FRAME=4 / RECTANGLE=10 / ROUNDED_RECTANGLE=12 / TEXT=13

---

## 4. 脚手架清单（本机核实 2026-07-20）

**读写核心**：
| 脚本 | 侧 | 作用 |
|---|---|---|
| `dump-fig.mjs` | read | `.fig` → Message JSON + 字段样本 |
| `reencode-fig.mjs` | write | Message → zstd → ZIP（round-trip） |
| `mutate-fig.mjs` | write | 改现有节点字段 |
| `add-node.mjs` | write | 克隆加新节点（v4） |
| `inspect-untitled.mjs` | read | 探查未命名 .fig |

**核实脚本**（独立核实，不收自报）：
- `verify-addnode.mjs` / `verify-v4.mjs`

**产物** `out/`：addnode v1-v4 / roundtrip / mutated，各带 `*-report.json`（v1 是失败迭代，v4 成功，演进见 report）。

**复现命令**（确定性）：
```bash
cd fig-format-explore
node dump-fig.mjs "./sample.fig"
```

---

## 5. 成本对比（vs MCP `use_figma`）

| 维度 | `.fig` 代码生成 | MCP `use_figma` |
|---|---|---|
| 从头画 | 写 ~500 行脚本手摆节点 | Plugin API `createXxx` 即时 return |
| 即时预览 | ❌（要 import 才看） | ✅ |
| 离线 / 批量 | ✅ | ❌（需 Figma runtime） |
| 无 figma 账号 | ✅ | ❌ |
| 失败修正 | 难调（改二进制不像 Plugin API 能即时 return） | 易（自检截图循环） |

**结论**：从头画场景 MCP 性价比仍优；`.fig` 真优势在**离线 / 批量 / 无 runtime / 无账号**。

---

## 6. 工作流 SOP（半克隆生成新内容）

1. **提取模板**：`dump-fig` 提取目标节点类型的真实字段集
2. **照抄结构**：字段集照抄，只填新值（`characters` / `name` / `guid`）
3. **derived 留空**：`textData` 填，`derivedTextData` 留空让 Figma 算
4. **guid 新 sessionID**：非改现有节点
5. **position 避碰**：`pickFreeSingleCharPosition`
6. **验证**：`verify-*` 脚本独立核实 + **Figma import 实测**（成功判据是 Figma 渲染，不是自读自写自洽）

---

## 7. 反共识结论（相对早期判断的修正）

| 早期判断 | 修正后 |
|---|---|
| 「从头画用 `.fig` 好」 | 可行性成立、**性价比反了**（MCP 即时预览更优） |
| 「自读自写自洽 = 可写 `.fig`」 | **假阳性**（自读自写自洽 ≠ Figma 可消费，import 推翻） |
| 「失败因 Message vs 文件格式」 | **错**（真实 `.fig` 内层也是 Message），真因 = ①缺 ZIP 外层 ②data chunk 应 zstd 却用 deflateRaw |

---

## 8. 证伪条件（贝叶斯）

若以下证据出现，需修正本文档：
1. Figma 某版本拒绝接受 `phase=CREATED` 全量重建 → §1 关键推论失效
2. `fillPaints`/`fillGeometry` 不配对导致渲染失败 → §3.3 失效
3. 纯从零造 TEXT（无模板）成功 → §0 反逢迎边界收窄
4. IMAGE blob 填充被验证可行 → §2 未验边界缩短

---

## 附录：来源

- [`FIG_FORMAT_NOTES.md`](./FIG_FORMAT_NOTES.md)（read 侧格式笔记，2026-07-14）
- Evan Wallace [fig-file-parser](https://madebyevan.com/figma/fig-file-parser/) / [kiwi#17](https://github.com/evanw/kiwi/issues/17)
- `out/*-report.json`（本机确定性产物，核实基准）
