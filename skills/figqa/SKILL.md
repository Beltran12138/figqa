---
name: figqa
description: Check design-system conformance without opening Figma. Lint a .fig file offline for hard-coded colours, off-token fonts and radii, and placeholder copy; or lint a directory of generated UI code for hard-coded hex values that the design system already has a token for, undefined CSS custom properties, and drifted alias values. Also extracts colour variables out of a .fig without the Enterprise-only Variables REST API, and can bind hard-coded colours to variables by writing the .fig back. Use when reviewing AI-generated UI against a design system, auditing a Figma file for token drift, reading design tokens on a non-Enterprise plan, or gating a design system in CI.
---

# figqa

Deterministic design-system QA over two artifacts: the `.fig` design file and the generated code. Every rule is an assertion with a count and a location — never a model judgement.

## Why this exists rather than the REST API

- `GET /v1/files/:key/variables` **requires a Full seat in an Enterprise org** — Enterprise is listed under GET as well as POST. Verified against a live Organization-tier account, not just read off the docs: its personal-access-token screen offers 15 scopes with **no Variables section at all**, and of the 7 scopes marked "Enterprise plan only" the account can be granted zero. The gate is on what the plan may be issued, not on what the endpoint rejects. `figqa` reads the file instead, so plan tier is irrelevant.
- `POST /v1/files/:key/variables` accepts only collections / modes / variables / mode values. It **cannot bind a variable to a layer property**.
- The Plugin API can bind, and since Feb 2026 an agent can drive it over Figma's remote MCP server without a human clicking. That server takes interactive OAuth from a catalog-listed client only — which rules out a clean CI container, but not a workstation that already completed the flow. Writing the `.fig` is the path that needs no Figma auth state anywhere.
- **That covers the check and the rewrite, not the round trip.** No REST endpoint returns the `.fig` binary, so the file being linted is a manual export; applying `fix` means importing the result as a new file. Do not describe `figqa` to a user as a gate over their live Figma document — it gates a snapshot.

## Commands

Assumes `figqa` is on PATH (`npm link` in the repo) — otherwise use `node /path/to/figqa.mjs`.

```bash
figqa vars <file.fig>                          # colour variables, local vs library-backed
figqa lint <file.fig> [--rules r.json] [--json]
figqa lint <dir> --system <file.fig|theme.css> [--rules r.json] [--json]
figqa fix  <file.fig> -o <out.fig> [--mark]    # bind hard-coded colours to variables
```

`lint` exits **1** when any error-level rule fires, so it works as a CI gate directly.

## Choosing the target

| The question | Target |
|---|---|
| Did the designer drift off the tokens? | the `.fig` |
| Did the agent that wrote this UI actually use the design system? | the code dir, `--system` the `.fig` |
| What tokens exist at all? | `vars` |

The pair matters: the design system's ground truth only exists in the design source, and whether the code referenced it is only observable in the code. Neither answers the question alone.

`--system` takes a `.fig` **or** a theme stylesheet — use the stylesheet for a Tailwind-style system (Untitled UI, shadcn) where the tokens live in CSS, and the `.fig` when the Figma library is the source. Always read the coverage line it prints before trusting a clean result: a theme sheet whose palette lives in an uninstalled dependency resolves a small fraction of the system, and `figqa` says so rather than reporting no violations.

## Rules

**Design file** — `color/unbound` (auto-fixable), `color/unbound-library`, `color/off-token`, `radius/max`, `font/allowlist`, `text/placeholder`.

**Code directory** — `code/hardcoded-token` (a hex literal whose exact value is a design-system variable), `code/dangling-token` (`var(--x)` nothing defines), `token/drift` (an alias token whose value matches no variable).

Severities and options live in a rules JSON; brand values never go in code. See `rules/example.json`.

## Interpreting output — do not overstate these

- **Colour matching is by value, never by name.** A Figma variable is `background/Tab/up`, the code says `--bg-tab-up`; the artifacts share no vocabulary. A *name* mismatch is therefore never reported, and a colour used correctly but under a surprising name looks fine. That is intended.
- **`code/dangling-token` reports its own blind spot.** If the tree imports a stylesheet that could not be read (uninstalled dependency, bare package specifier), the rule collapses to one warning naming those stylesheets instead of listing tokens. Install dependencies and re-run before treating it as a finding.
- **A hex inside a token definition is not flagged as hard-coded.** Someone has to write the literal once. Those are judged by `token/drift` instead.
- **`token/drift` has a benign case.** A token deliberately outside the system fires it too. It is a warning, not a defect.
- **A gamut-mapped value may not match by bytes.** An `oklch` colour outside sRGB has no single correct hex: Tailwind's `blue-500` ships `#3B82F6` as its own fallback while a channel-clipped render is `#2B7FFF`. Exact-equality rules can miss those, and the count is printed for that reason.
- **Library-backed variables cannot be auto-fixed.** They are referenced by `assetRef`, not `guid`, and a guid reference is silently ignored by Figma. `figqa lint` reports these as `color/unbound-library` rather than pretending. Most real team tokens are library-backed, so expect `fix` to cover less than the lint total.

## After running `fix`

Self-read consistency is **not** evidence — decoding what you just encoded produced a confident false positive in this project's history. The only accepted proof is importing the output into Figma and looking at one changed layer. Use `--mark` on the first run: it prefixes changed layer names with 🧪 so a `Ctrl+F` in Figma separates "binding failed" from "nothing was written". Keep the original file; `.fig` is an undocumented format with no stability guarantee across Figma versions.
