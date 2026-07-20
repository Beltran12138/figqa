# fig-format-explore

> **写侧 code-to-design 探索**：用代码程序化生成/修改 Figma `.fig` 文件，脱离 Figma runtime。
> ⚠️ **好奇驱动的研究脚手架，非生产即用解。** 生产改图请用 [Figma MCP `use_figma`](https://help.figma.com/hc/en-us/articles/32132100833559)（Plugin API，即时可视）。

---

## 这不是首创——先看社区生态

`.fig` 逆向**已有成熟开源生态**。本仓库是其中一份实现，不是从零突破。做之前先看这些：

| 项目 | 侧 | 说明 |
|---|---|---|
| [evanw/kiwi](https://github.com/evanw/kiwi) | 基础库 | Figma 前 CTO Evan Wallace 的 Kiwi 二进制序列化格式（`.fig` 底层编码）。[issue #17](https://github.com/evanw/kiwi/issues/17)/[#23](https://github.com/evanw/kiwi/issues/23) 是格式讨论 canonical |
| [madebyevan.com/fig-file-parser](https://madebyevan.com/figma/fig-file-parser/) | read | Evan 本人的在线 `.fig` 解析器（探索用） |
| [fig-kiwi](https://www.jsdelivr.com/package/npm/fig-kiwi) (npm) | read/write | 读写 `.fig` + pasteboard，带 TS 定义 |
| [bilalba/fig-mcp](https://github.com/bilalba/fig-mcp) | read + MCP | **已经有人把 `.fig` 做成 MCP server** 给 AI 抽设计信息 |
| [allan-simon/figma-kiwi-protocol](https://github.com/allan-simon/figma-kiwi-protocol) | read | WebSocket Kiwi 协议解码（实时同步方向） |
| [Grida io-figma](https://grida.co/docs/wg/feat-fig) | read/import | Figma import & translation pipeline |
| [Albert Sikkema – Reverse-engineering Figma Make](https://www.albertsikkema.com/ai/development/tools/reverse-engineering/2026/01/23/reverse-engineering-figma-make-files.html) | 教程 | 2026-01 Figma Make 二进制逆向（ZIP + Kiwi） |
| [Figma Inside (easylogic/Medium)](https://easylogic.medium.com/figma-inside-fig-%ED%8C%8C%EC%9D%BC-%EB%B6%84%EC%84%9D-7252bef141da) | 教程 | `.fig` 分析 walkthrough |

**本仓库的差异化（窄切口）**：上面多数是 **read 侧**（parse/inspect/render）或 **MCP 只读**。本仓库聚焦 **write 侧**——程序化**生成/修改** `.fig` 并被 Figma import 接受，附带实操踩坑。

---

## ⚠️ Figma 官方立场（必须读）

> Figma 在 [evanw/kiwi#23](https://github.com/evanw/kiwi/issues/23) 明说：`.fig` 是**内部实现细节，非 public API，不保证版本间稳定**。任何 parser/writer 可能在 Figma 更新后失效。生产集成请用 [Figma REST API](https://www.figma.com/developers/api)。

本仓库所有验证基于 **2026-07 Figma version 106**。升级后可能失效，自担风险。

---

## 已验证能力（Phase 1a-1e，高置信，Figma import 实测）

| Phase | 能力 | 实证 |
|---|---|---|
| 1a/1b | round-trip（读→decode→encode→zstd→ZIP） | Figma import「一模一样」 |
| 1c | 改现有节点任意字段 | 满树 name 加前缀被 Figma 应用 |
| 1d | 克隆现有节点加新节点 | 4 层 mutation 全被 Figma 接受 |
| 1e | 半克隆造新 TEXT（中文渲染） | 模板提取字段集 → 填新值，中文通过 |

**关键推论**：Figma import 时按 `phase=CREATED` **全量重建树 + 完全信任每字段值** → nodeChange 每字段可写，非只读黑盒。

## 未验证边界（别外推）

- 纯盲猜字段集从零造（无实用必要，总能提取模板）
- VECTOR·path / INSTANCE·componentId 从头建
- **IMAGE blob**（图片填充未处理）
- 全量复杂布局精度（501 行 HTML 未整页跑通）

---

## 脚手架清单（本机核实 2026-07-20）

```
fig-format-explore/
├── dump-fig.mjs          # read:  .fig → Message JSON + 字段样本
├── reencode-fig.mjs      # write: Message → zstd → ZIP（round-trip）
├── mutate-fig.mjs        # write: 改现有节点字段
├── add-node.mjs          # write: 克隆加新节点（v4 成功）
├── inspect-untitled.mjs  # read:  探查未命名 .fig
├── verify-addnode.mjs    # 独立核实（不收自报）
├── verify-v4.mjs         # 独立核实
├── FIG_FORMAT_NOTES.md   # read 侧格式笔记（格式链细节）
├── PRACTICE.md           # write 侧实践（本 README 的详细版）
└── out/                  # 产物 + *-report.json（核实基准）
```

## 复现

```bash
cd fig-format-explore
node dump-fig.mjs "path/to/your.fig"        # read 侧
node reencode-fig.mjs                        # write 侧 round-trip
```

依赖：Node 24+（内置 `zlib.zstdCompressSync`）。

---

## 写侧独有踩坑（read 侧笔记没有）

1. **zstd 压缩用 Node `zlib`，非 `fzstd`**——`fzstd@0.1.1` 是纯解压器无 compress。写回必须 `zlib.zstdCompressSync`。
2. **`parentIndex.position` 排序键避碰**——克隆节点复用源 position 会碰撞。解法 `pickFreeSingleCharPosition()`：扫 parent 子节点已用 position，挑未占用单字符（实证选 code 44）。
3. **`fillPaintes`/`fillGeometry` 不强制配对**——改 size 致原 geometry path 失效时 `delete fillGeometry`（paints 留），Figma 仍正常渲染。证伪了早期「必须配对」预判。
4. **半克隆 TEXT 字段集（30 个）**——纯从零盲猜凑不齐，先从模板 `.fig` 提取真实 TEXT 字段集照抄结构，只填新值；`derivedTextData` 留空让 Figma 导入后自己算 layout。

---

## 为什么不做成 MCP / 不推荐生产用

- **`bilalba/fig-mcp` 已经做了** `.fig` 的 MCP server（read 侧）。再做 write 侧 MCP = reinvent + 托管成本。
- **生产改图用 MCP `use_figma` 性价比更高**：Plugin API `createXxx` 即时 return 可见，失败修正循环好调；`.fig` 写侧改完要 import 才看结果，调试痛苦。
- **`.fig` 真优势只在**：离线 / 批量 / 无 Figma runtime / 无账号。这些场景狭窄。

详见 [`PRACTICE.md` §5 成本对比](./PRACTICE.md)。

---

## 证伪条件（贝叶斯）

若以下证据出现，需修正本仓库结论：
1. Figma 某版本拒绝 `phase=CREATED` 全量重建 → 关键推论失效
2. `fillPaints`/`fillGeometry` 不配对导致渲染失败 → 踩坑 #3 失效
3. 纯从零造 TEXT（无模板）成功 → 反逢迎边界收窄
4. IMAGE blob 填充被验证可行 → 未验边界缩短

---

## License

MIT。**不附担保**——`.fig` 格式不稳定（见上方 Figma 官方立场），本仓库代码可能随 Figma 版本更新失效。
