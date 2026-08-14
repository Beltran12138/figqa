# figqa

**Design-system QA for Figma files — with no Figma.**

No plugin, no editor runtime, no account, no network. `figqa` reads the `.fig` binary directly, reports design-system violations with a CI-usable exit code, and can **bind hard-coded colours to design tokens by writing the file back**.

```console
$ figqa lint "design-system.fig" --rules rules/example.json

design-system.fig — 114210 nodes, 12 colour variables (1 local / 11 library)

ERROR [color/unbound]   hard-coded #2565CF but local variable "主色" holds exactly this value
                        799 occurrences, e.g. "placeholder" (TEXT) fillPaints
ERROR [font/allowlist]  font "Noto Sans SC" is not in the allowlist [PingFang SC, Inter]
                        182 occurrences, e.g. "Home" (TEXT)
ERROR [font/allowlist]  font "Open Sans" is not in the allowlist [PingFang SC, Inter]
                        87 occurrences, e.g. " text" (TEXT)
warn  [color/off-token] #E7E7E7 used 18557x — matches no variable and no configured token
warn  [radius/max]      corner radius 12px exceeds max 6px
                        917 occurrences

9 rogue font families, 799 auto-fixable colours
$ echo $?
1
```

That run took one command on a 45 MB, 114,210-node file. Figma was never open.

---

## Why this can exist

Every Figma linter on the market is a **plugin** — it needs a person with an editor seat to open the file and click. That is fine for a designer's pre-handoff check and useless as a gate: a markdown standard nobody executes doesn't block anything.

The obvious alternative is the REST API. It gets you halfway and then stops:

| | read violations | **write the fix** |
|---|---|---|
| REST API | ✅ `GET /v1/files/:key` returns `boundVariables` | ❌ `POST /v1/files/:key/variables` accepts only `variableCollections` / `variableModes` / `variables` / `variableModeValues` — **it cannot bind a variable to a layer property** |
| Plugin API | ✅ | ✅ but needs an editor runtime someone drives |
| **writing `.fig`** | ✅ | ✅ **headless** |

So auto-fixing token drift without a human in the loop has exactly one path: write the file. That is what `figqa fix` does, and it is verified against Figma import — see [Phase 1g](#verified-capability).

---

## Install

```bash
git clone https://github.com/Beltran12138/figqa
cd figqa && npm install          # kiwi-schema, adm-zip, fzstd
node figqa.mjs --help
```

Node 24+ (needs the built-in `zlib.zstdCompressSync`).

## Usage

```bash
figqa vars <file.fig>                      # list colour variables, local vs library-backed
figqa lint <file.fig> [--rules r.json]     # report violations; exit 1 if any are error-level
figqa fix  <file.fig> -o <out.fig> [--mark]  # bind hard-coded colours to matching variables
```

`--mark` prefixes every changed layer name with 🧪 so you can find them with Ctrl+F after importing. Use it the first time you run `fix` on a file you care about.

## Rules

Brand values live in the rule file, never in the code.

```json
{
  "rules": {
    "color/unbound":         "error",
    "color/unbound-library": "warn",
    "color/off-token":       ["warn",  { "tokens": ["#FFFFFF", "#2565CF"], "top": 8 }],
    "radius/max":            ["warn",  { "max": 6, "allowPill": true }],
    "font/allowlist":        ["error", { "families": ["PingFang SC", "Inter"] }],
    "text/placeholder":      ["warn",  { "patterns": ["lorem", "TODO", "示例"] }]
  }
}
```

| rule | catches | auto-fix |
|---|---|---|
| `color/unbound` | a colour identical to a **local** variable's value, sitting unbound | ✅ |
| `color/unbound-library` | same, but the variable is library-backed | ❌ not yet — see below |
| `color/off-token` | colours matching no variable and no configured token, ranked by frequency | — |
| `radius/max` | corner radius over the limit (pill radii excepted) | — |
| `font/allowlist` | font families that drifted into the file | — |
| `text/placeholder` | placeholder copy shipped as if it were real | — |

Every rule is a **deterministic assertion**, not a model judgement. A rule either fires with a node path and a count, or it doesn't.

---

## Verified capability

Claims here are graded by how they were tested. "Self-read consistency" — decoding what you just encoded — is **not** evidence; it produced a confident false positive earlier in this project's history. The only accepted proof is importing the output into Figma and looking.

| Phase | Capability | Proof |
|---|---|---|
| 1a/1b | round-trip: read → decode → encode → zstd → ZIP | imported, renders identically |
| 1c | modify any field on an existing node | whole-tree name prefix applied by Figma |
| 1d | add new nodes (cloned) | 4 layers of mutation accepted |
| 1e | build new `TEXT` from a template field set | CJK renders correctly |
| 1f | add image fills (`IMAGE` blob, SHA-1 content addressing) | imported, image renders |
| **1g** | **bind a paint to a colour variable** | **imported, Figma's inspector shows the variable name** |

Phase 1g detail — a bound paint differs from an unbound one by exactly one additive field, with the resolved `color` retained:

```js
colorVar: { value: { alias: { guid: {sessionID, localID} } },
            dataType: "ALIAS", resolvedDataType: "COLOR" }
```

Positive control: `--mark` renames the same nodes it binds. Phase 1c already proved renames survive import, so "prefix appears but binding doesn't" would have been a clean negative rather than an ambiguous one. Of the 796 marked nodes, **0** carried a pre-existing binding, so the variable shown in Figma could only come from the written field.

### Local vs library-backed variables

This distinction decides whether a binding works at all, and it isn't documented anywhere else:

```
VariableID { guid, assetRef }        ← two fields, not redundant
  local variable    → reference by guid       ✅ writable today
  library variable  → reference by assetRef   ❌ not yet implemented
```

A library-backed variable is a **cached copy**: it carries `sourceLibraryKey`, its `variableSetID` points at an `{assetRef}` instead of a `{guid}`, and it usually comes with `visible:false`, `locked:true`, `variableScopes:[]`. Reference one by guid and Figma silently falls back to the raw colour — no error, no warning, nothing bound.

This is the current ceiling and it is a real one: **in the test file, 11 of 12 variables were library-backed**. Teams publish their tokens as a library, so most real drift is not fixable until `assetRef` writing is proven. `figqa lint` reports those cases under `color/unbound-library` rather than pretending it can fix them.

### Not verified — do not extrapolate

- writing `assetRef` references (library variables) — the next experiment
- binding non-colour variables (`strokeWeightVar`, `Effect.*Var`, `LayoutGrid.*Var`, responsive text vars) — the schema has slots for all of them; none tested
- creating variables or variable collections from scratch
- `VECTOR` paths and `INSTANCE.componentId` built from zero
- whether bindings behave correctly across mode switches after import

### Falsification conditions

Findings here should be revised if:

1. Figma rejects a `phase=CREATED` full-tree rebuild in some version → the whole write path fails
2. a guid reference to a library-backed variable is observed working → the local/library rule is wrong
3. `fillPaints` / `fillGeometry` mismatch starts breaking render → a documented workaround dies
4. writing `assetRef` succeeds → the ceiling above moves

---

## How it works

```
.fig = ZIP { canvas.fig (STORE), thumbnail.png (STORE), meta.json (DEFLATE), images/<sha1> }
canvas.fig = "fig-kiwi" + u32 version + [u32 len + chunk] × 2
   chunk 0 = kiwi schema   (deflateRaw)
   chunk 1 = Message       (zstd, magic 28 B5 2F FD) → nodeChanges[] + blobs[]
```

The schema is embedded per file and read **dynamically**, not hardcoded from a snapshot — which is what lets this survive some amount of Figma schema drift.

Gotchas that cost real time, in case you're building something similar:

1. **zstd compression needs Node's `zlib`.** `fzstd` is a decompressor only; there is no `compress` in it.
2. **Preserve every ZIP entry.** Rebuilding only `canvas.fig` / `thumbnail.png` / `meta.json` silently drops `images/` — the test file had 62 entries.
3. **Alpha is part of a colour's identity.** Matching on RGB alone will happily "match" `#FFFFFF` against a variable whose value is `rgba(1,1,1,0.9)`. It cost this project a wrong headline number before the check was added.
4. **`parentIndex.position` sort keys collide** when you clone a node; scan the parent's children and pick a free single character.
5. **`fillPaints` and `fillGeometry` are not required to agree.** Deleting a stale geometry path leaves the fill rendering fine.

Full format notes: [`research/FIG_FORMAT_NOTES.md`](research/FIG_FORMAT_NOTES.md) (read side) and [`research/PRACTICE.md`](research/PRACTICE.md) (write side). The `research/` directory holds the phase-by-phase scripts each capability was proven with, including the failed iterations.

---

## ⚠️ Figma's official position

Figma states in [evanw/kiwi#23](https://github.com/evanw/kiwi/issues/23) that `.fig` is an **internal implementation detail, not a public API, with no stability guarantee across versions**. Everything here was verified against **Figma version 106 (2026-07/08)** and may break on any update. For supported integrations use the [REST API](https://www.figma.com/developers/api).

Treat `figqa fix` output as you would any generated artifact: keep the original, verify the result, don't run it against a file you can't restore.

## Prior art

`.fig` parsing is not new. This project's narrow claim is the **write** side, and specifically variable binding.

| project | side | note |
|---|---|---|
| [evanw/kiwi](https://github.com/evanw/kiwi) | encoding | the binary format underneath `.fig` |
| [madebyevan.com/fig-file-parser](https://madebyevan.com/figma/fig-file-parser/) | read | Evan Wallace's own explorer |
| [fig-kiwi](https://www.npmjs.com/package/fig-kiwi) (npm) | read/write | only package advertising write; v0.0.1, unmaintained, ignores blobs |
| [sunyui/figma-parser](https://github.com/sunyui/figma-parser) | read | offline parse + asset export |
| [bilalba/fig-mcp](https://github.com/bilalba/fig-mcp) | read | `.fig` as an MCP server |
| [Grida](https://grida.co/tools/fig) | read | in-browser inspector |
| [Albert Sikkema](https://albertsikkema.com/ai/development/tools/reverse-engineering/2026/01/23/reverse-engineering-figma-make-files.html) | write-up | Figma Make binary walkthrough |

For in-canvas linting with click-to-fix, [Design Lint](https://www.figma.com/community/plugin/801195587640428208/design-lint) and YADL are better tools. `figqa` is for the case they can't serve: no runtime, no seat, no human — a gate that runs in CI.

## License

MIT. No warranty — see the stability warning above.
