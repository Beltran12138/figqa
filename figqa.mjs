#!/usr/bin/env node
/**
 * figqa — design-system QA for Figma files, with no Figma.
 *
 * No runtime, no plugin, no account, no network: it reads the .fig binary directly.
 *
 *   figqa vars <file.fig>                     list colour variables (local vs library-backed)
 *   figqa lint <file.fig> [--rules r.json]    report design-system violations, exit 1 on error
 *   figqa lint <dir> --system <file.fig>      same rules, asserted against generated code
 *   figqa fix  <file.fig> -o <out.fig>        bind hard-coded colours to matching variables
 *
 * Why `fix` cannot be a REST script: POST /v1/files/:key/variables accepts only
 * variableCollections / variableModes / variables / variableModeValues — it cannot bind a
 * variable to a layer property. The Plugin API can, and since Feb 2026 an agent can drive it
 * over Figma's remote MCP server without a human clicking — but that server takes interactive
 * OAuth from a catalog-listed client only, so no unattended job can hold the session.
 * Writing the file is the only path that needs no Figma session at all. Verified (Phase 1g).
 */
import fs from "node:fs";
import path from "node:path";
import { open, save, hex, colorVariables, bindingFor, paints, guidStr } from "./lib/figfile.mjs";
import { scanCode, rel, cssSystemVariables } from "./lib/codedir.mjs";

const DEFAULT_RULES = {
  "color/unbound": "error",
  "color/unbound-library": "warn",
  "color/off-token": ["warn", { tokens: [], top: 10 }],
  "radius/max": ["warn", { max: 16, allowPill: true }],
  "font/allowlist": ["warn", { families: [] }],
  "text/placeholder": ["warn", { patterns: ["lorem", "ipsum", "占位", "示例", "待补充", "xxx", "テスト"] }],
  // code-side rules — only fire when the target is a directory
  "code/hardcoded-token": "error",
  "code/dangling-token": "error",
  "token/drift": "warn",
};

const sev = (r) => (Array.isArray(r) ? r[0] : r);
const opt = (r) => (Array.isArray(r) ? r[1] || {} : {});

/** Aggregate identical findings so one drifted colour is one line, not 800. */
function collector(rules) {
  const findings = [];
  const add = (rule, message, sample) => {
    let f = findings.find((x) => x.rule === rule && x.message === message);
    if (!f) { f = { rule, severity: sev(rules[rule]), message, count: 0, samples: [] }; findings.push(f); }
    f.count++;
    if (f.samples.length < 5 && sample) f.samples.push(sample);
  };
  return { findings, add };
}

/** Rank a Map of hex -> {count, sample} and emit the top N as findings. */
function topN(map, rule, rules, label, limit) {
  return [...map].sort((a, b) => b[1].count - a[1].count).slice(0, limit).map(([k, e]) => ({
    rule, severity: sev(rules[rule]), message: label(k, e.count), count: e.count, samples: [e.sample],
  }));
}

function loadRules(p) {
  if (!p) return DEFAULT_RULES;
  const user = JSON.parse(fs.readFileSync(p, "utf8"));
  return { ...DEFAULT_RULES, ...(user.rules || user) };
}

// ---------------------------------------------------------------- lint

function lint(handle, rules) {
  const vars = colorVariables(handle);
  const localByHex = new Map(), libByHex = new Map();
  for (const v of vars) (v.local ? localByHex : libByHex).set(v.hex, v.hex && !(v.local ? localByHex : libByHex).has(v.hex) ? v : (v.local ? localByHex : libByHex).get(v.hex) || v);

  const { findings, add } = collector(rules);

  // --- colour rules ---
  const offToken = new Map();
  const tokenSet = new Set((opt(rules["color/off-token"]).tokens || []).map((t) => t.toUpperCase()));
  for (const { node, field, paint } of paints(handle)) {
    if (paint.type !== "SOLID" || !paint.color) continue;
    const h = hex(paint.color);
    if (paint.colorVar) continue;                                   // already bound: fine
    if (rules["color/unbound"] && localByHex.has(h)) {
      add("color/unbound", `hard-coded ${h} but local variable "${localByHex.get(h).name}" holds exactly this value`,
          `"${node.name}" (${node.type}) ${field}`);
      continue;
    }
    if (rules["color/unbound-library"] && libByHex.has(h)) {
      add("color/unbound-library", `hard-coded ${h} matches library variable "${libByHex.get(h).name}" (binding to library variables is not yet writable — needs assetRef)`,
          `"${node.name}" (${node.type}) ${field}`);
      continue;
    }
    if (rules["color/off-token"] && !tokenSet.has(h)) {
      const e = offToken.get(h) || { count: 0, sample: `"${node.name}" (${node.type}) ${field}` };
      e.count++; offToken.set(h, e);
    }
  }
  if (rules["color/off-token"])
    findings.push(...topN(offToken, "color/off-token", rules,
      (h, n) => `${h} used ${n}x — matches no variable and no configured token`,
      opt(rules["color/off-token"]).top || 10));

  // --- structural rules ---
  const rmax = opt(rules["radius/max"]);
  for (const n of handle.nodes) {
    if (rules["radius/max"] && typeof n.cornerRadius === "number") {
      const pill = rmax.allowPill !== false && n.cornerRadius >= 999;
      if (!pill && n.cornerRadius > (rmax.max ?? 16))
        add("radius/max", `corner radius ${n.cornerRadius}px exceeds max ${rmax.max ?? 16}px`, `"${n.name}" (${n.type})`);
    }
    const fams = opt(rules["font/allowlist"]).families || [];
    if (rules["font/allowlist"] && fams.length && n.fontName?.family && !fams.includes(n.fontName.family))
      add("font/allowlist", `font "${n.fontName.family}" is not in the allowlist [${fams.join(", ")}]`, `"${n.name}" (${n.type})`);

    const pats = opt(rules["text/placeholder"]).patterns || [];
    const chars = n.textData?.characters;
    if (rules["text/placeholder"] && chars) {
      const hit = pats.find((p) => chars.toLowerCase().includes(String(p).toLowerCase()));
      if (hit) add("text/placeholder", `placeholder text matching "${hit}" — must be marked as sample data or replaced`,
                   `"${n.name}": ${chars.slice(0, 40)}`);
    }
  }
  return { findings, vars };
}

function printLint(file, handle, { findings, vars }) {
  const errors = findings.filter((f) => f.severity === "error");
  const warns = findings.filter((f) => f.severity === "warn");
  console.log(`\n${path.basename(file)} — ${handle.nodes.length} nodes, ${vars.length} colour variables (${vars.filter((v) => v.local).length} local / ${vars.filter((v) => !v.local).length} library)\n`);
  for (const group of [errors, warns]) {
    for (const f of group.sort((a, b) => b.count - a.count)) {
      const tag = f.severity === "error" ? "ERROR" : "warn ";
      console.log(`${tag} [${f.rule}] ${f.message}`);
      console.log(`      ${f.count} occurrence${f.count > 1 ? "s" : ""}${f.samples.length ? `, e.g. ${f.samples[0]}` : ""}`);
    }
  }
  const fixable = findings.filter((f) => f.rule === "color/unbound").reduce((a, f) => a + f.count, 0);
  console.log(`\n${errors.reduce((a, f) => a + f.count, 0)} errors, ${warns.reduce((a, f) => a + f.count, 0)} warnings`);
  if (fixable) console.log(`${fixable} of them are auto-fixable: figqa fix "${file}" -o fixed.fig`);
  return errors.length ? 1 : 0;
}

// ---------------------------------------------------------------- lint (code side)

/**
 * Assert the same design system against generated code.
 *
 * The interesting rule is `code/hardcoded-token`, and it needs no configuration and no name
 * mapping: a hex literal in the code is compared against the *values* of the variables in the
 * .fig. Names would not work — a Figma variable is called `background/Tab/up` and the code
 * calls it `--bg-tab-up`; the value is the only thing the two artifacts share.
 */
function lintCode(scan, sysVars, rules) {
  const { findings, add } = collector(rules);
  const byHex = new Map();
  for (const v of sysVars) if (!byHex.has(v.hex)) byHex.set(v.hex, v);

  const offToken = new Map();
  const tokenSet = new Set((opt(rules["color/off-token"]).tokens || []).map((t) => t.toUpperCase()));
  for (const c of scan.colors) {
    const at = `${rel(scan.root, c.file)}:${c.line}`;
    const v = byHex.get(c.hex);

    // A literal inside a token definition is the alias layer's job, not a violation. The
    // failure mode there is drift: the alias was copied from the library once and the
    // library moved. Only checkable when a --system was supplied.
    if (c.def) {
      if (sysVars.length && !v && rules["token/drift"])
        add("token/drift",
            `${c.def} is defined as ${c.hex}, which matches no variable in the design system` +
            ` — either deliberately custom, or copied before the library changed`, at);
      continue;
    }

    if (v && rules["code/hardcoded-token"]) {
      add("code/hardcoded-token",
          `hard-coded ${c.hex} — the design system defines "${v.name}" with exactly this value`, at);
      continue;
    }
    if (rules["color/off-token"] && !tokenSet.has(c.hex)) {
      const e = offToken.get(c.hex) || { count: 0, sample: at };
      e.count++; offToken.set(c.hex, e);
    }
  }
  if (rules["color/off-token"])
    findings.push(...topN(offToken, "color/off-token", rules,
      (h, n) => `${h} used ${n}x — matches no variable and no configured token`,
      opt(rules["color/off-token"]).top || 10));

  // A token the code invents but nobody defines resolves to nothing at runtime and renders
  // as an unstyled default — invisible in a screenshot review, obvious to a string compare.
  //
  // This claim is only sound when every stylesheet the tree imports could be read. If a
  // dependency's CSS is missing, an undefined-looking token may simply be defined in there,
  // so the rule reports its own blind spot instead of emitting a page of false positives.
  if (rules["code/dangling-token"]) {
    const dangling = new Map();
    for (const r of scan.refs) {
      if (scan.defs.has(r.name)) continue;
      const e = dangling.get(r.name) || { count: 0, sample: `${rel(scan.root, r.file)}:${r.line}` };
      e.count++; dangling.set(r.name, e);
    }
    if (!scan.unresolvedImports.length) {
      findings.push(...topN(dangling, "code/dangling-token", rules,
        (name, n) => `var(${name}) is referenced ${n}x but defined nowhere in the tree`, Infinity));
    } else if (dangling.size) {
      const refs = [...dangling.values()].reduce((a, e) => a + e.count, 0);
      findings.push({
        rule: "code/dangling-token", severity: "warn", count: refs,
        message: `${dangling.size} token(s) look undefined, but ${scan.unresolvedImports.length} imported ` +
                 `stylesheet(s) could not be read, so this cannot be decided: ${scan.unresolvedImports.join(", ")}` +
                 ` — install dependencies and re-run to check`,
        samples: [[...dangling.keys()].slice(0, 4).join(", ") + (dangling.size > 4 ? ", …" : "")],
      });
    }
  }
  return findings;
}

function printLintCode(scan, sysVars, findings, systemPath, sysInfo) {
  const errors = findings.filter((f) => f.severity === "error");
  const warns = findings.filter((f) => f.severity === "warn");
  console.log(`\n${scan.root} — ${scan.files.length} files, ${scan.colors.length} colour literals, ` +
              `${scan.refs.length} var() references, ${scan.defs.size} tokens defined`);
  console.log(systemPath
    ? `checked against ${path.basename(systemPath)} — ${sysVars.length} colour variable values`
    : `no --system given: only rules that need no design system were run`);
  // How much of the design system was actually readable decides what a clean run means.
  // A stylesheet whose palette lives in an uninstalled dependency yields almost nothing,
  // and silence would then read as "no violations" instead of "nothing to compare against".
  if (sysInfo) {
    const why = [];
    if (sysInfo.missingExamples.length) why.push(`chain ends undefined (e.g. ${sysInfo.missingExamples.join(", ")})`);
    if (sysInfo.unparsedExamples.length) why.push(`unreadable notation (e.g. ${sysInfo.unparsedExamples.join(" / ")})`);
    console.log(`  ${sysInfo.filesRead} stylesheet(s) read` +
      (sysInfo.undecidable ? `, ${sysInfo.undecidable} token(s) undecided — ${why.join("; ")}`
                           : `, every var() chain resolved`));
    if (sysInfo.approx)
      console.log(`  ${sysInfo.approx} value(s) fell outside sRGB and were gamut-mapped — exact-match` +
                  ` rules can miss those, since a published fallback hex need not be the same bytes`);
    if (sysInfo.unresolvedImports.length)
      console.log(`  could not open: ${sysInfo.unresolvedImports.join(", ")} — install dependencies` +
                  ` for the full palette, or results below understate coverage`);
  }
  console.log("");
  for (const group of [errors, warns]) {
    for (const f of group.sort((a, b) => b.count - a.count)) {
      console.log(`${f.severity === "error" ? "ERROR" : "warn "} [${f.rule}] ${f.message}`);
      console.log(`      ${f.count} occurrence${f.count > 1 ? "s" : ""}${f.samples.length ? `, e.g. ${f.samples[0]}` : ""}`);
    }
  }
  console.log(`\n${errors.reduce((a, f) => a + f.count, 0)} errors, ${warns.reduce((a, f) => a + f.count, 0)} warnings`);
  if (!systemPath)
    console.log(`\nPass --system <design.fig> to also check colours against the design system's own values.`);
  return errors.length ? 1 : 0;
}

// ---------------------------------------------------------------- fix

function fix(handle, { mark }) {
  const local = new Map();
  for (const v of colorVariables(handle)) if (v.local && !local.has(v.hex)) local.set(v.hex, v);
  let applied = 0;
  const perVar = new Map(), samples = [];
  for (const { node, field, paint } of paints(handle)) {
    if (paint.colorVar || paint.type !== "SOLID" || !paint.color) continue;
    const hit = local.get(hex(paint.color));
    if (!hit) continue;
    paint.colorVar = bindingFor(hit.guid);
    if (mark && !String(node.name || "").startsWith("🧪")) node.name = `🧪${node.name || ""}`;
    applied++;
    perVar.set(hit.name, (perVar.get(hit.name) || 0) + 1);
    if (samples.length < 6) samples.push(`"${node.name}" (${node.type}) ${field} ${hex(paint.color)} -> ${hit.name}`);
  }
  return { applied, perVar, samples };
}

// ---------------------------------------------------------------- cli

const argv = process.argv.slice(2);
const [cmd, file, ...rest] = argv;
const flag = (n) => { const i = rest.indexOf(n); return i >= 0 ? rest[i + 1] : undefined; };
const has = (n) => rest.includes(n);

// Asking for help is not a usage error: `figqa --help` prints the same text either way, but
// only the missing-arguments case should fail. Scanned across all of argv because `--help`
// lands in `cmd` when it is the only argument, and in `rest` when it follows a file.
const wantsHelp = argv.some((a) => a === "--help" || a === "-h" || a === "help");

if (wantsHelp || !cmd || !file) {
  console.log(`figqa — design-system QA for Figma files, with no Figma

  figqa vars <file.fig>
  figqa lint <file.fig> [--rules rules.json] [--json]
  figqa lint <dir> [--system <file.fig|theme.css>] [--rules rules.json] [--json]
  figqa fix  <file.fig> -o <out.fig> [--mark]

Pointing lint at a directory checks generated code instead of the design file. With
--system, colours in the code are compared against the design system's own variable
values — matched by value, since the two artifacts never share names.

--system takes a .fig or a theme stylesheet. A stylesheet is followed through @import
and its var() chains are resolved, including oklch; whatever could not be resolved is
reported rather than dropped.

--mark prefixes changed layer names with 🧪 so you can find them with Ctrl+F in Figma.`);
  process.exit(wantsHelp ? 0 : 1);
}

// A directory target is the code side: no .fig to open, different rules.
if (cmd === "lint" && fs.existsSync(file) && fs.statSync(file).isDirectory()) {
  const rules = loadRules(flag("--rules"));
  const systemPath = flag("--system");
  // The design system may be a .fig or a theme stylesheet — same shape out either way.
  let sysVars = [], sysInfo = null;
  if (systemPath) {
    if (/\.(css|scss|less)$/i.test(systemPath)) { sysInfo = cssSystemVariables(systemPath); sysVars = sysInfo.vars; }
    else sysVars = colorVariables(open(systemPath));
  }
  const scan = scanCode(file);
  const findings = lintCode(scan, sysVars, rules);
  if (has("--json")) { console.log(JSON.stringify(findings, null, 2)); process.exit(0); }
  process.exit(printLintCode(scan, sysVars, findings, systemPath, sysInfo));
}

const handle = open(file);

if (cmd === "vars") {
  const vars = colorVariables(handle);
  console.log(`${vars.length} colour variables (${vars.filter((v) => v.local).length} local, ${vars.filter((v) => !v.local).length} library-backed)\n`);
  for (const v of vars) console.log(`  ${v.local ? "LOCAL  " : "library"} ${v.hex.padEnd(10)} ${v.name}  guid=${guidStr(v.guid)}`);
  console.log(`\nOnly LOCAL variables are bindable today: a library-backed variable is referenced by
VariableID.assetRef, not by guid, and a guid reference to one is silently ignored by Figma.`);
  process.exit(0);
}

if (cmd === "lint") {
  const result = lint(handle, loadRules(flag("--rules")));
  if (has("--json")) { console.log(JSON.stringify(result.findings, null, 2)); process.exit(0); }
  process.exit(printLint(file, handle, result));
}

if (cmd === "fix") {
  const out = flag("-o") || flag("--out");
  if (!out) { console.error("fix needs -o <out.fig>"); process.exit(1); }
  const r = fix(handle, { mark: has("--mark") });
  if (!r.applied) { console.log("nothing to bind: no hard-coded colour matches a local variable's value"); process.exit(0); }
  const w = save(handle, out);
  console.log(`bound ${r.applied} paints to ${r.perVar.size} variable(s)`);
  for (const [k, v] of [...r.perVar].sort((a, b) => b[1] - a[1])) console.log(`   ${k}: ${v}`);
  console.log(`\nwrote ${w.outPath} (${w.bytes} B, ${w.filesPreserved} files preserved)`);
  console.log(`\nSelf-read consistency is not proof. Verify by importing ${out} into Figma and
checking one changed layer shows the variable name instead of a hex value.`);
  for (const s of r.samples) console.log(`   ${s}`);
  process.exit(0);
}

console.error(`unknown command "${cmd}"`);
process.exit(1);
