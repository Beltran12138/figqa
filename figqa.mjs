#!/usr/bin/env node
/**
 * figqa — design-system QA for Figma files, with no Figma.
 *
 * No runtime, no plugin, no account, no network: it reads the .fig binary directly.
 *
 *   figqa vars <file.fig>                     list colour variables (local vs library-backed)
 *   figqa lint <file.fig> [--rules r.json]    report design-system violations, exit 1 on error
 *   figqa fix  <file.fig> -o <out.fig>        bind hard-coded colours to matching variables
 *
 * Why `fix` cannot be a REST script: POST /v1/files/:key/variables accepts only
 * variableCollections / variableModes / variables / variableModeValues — it cannot bind a
 * variable to a layer property. The Plugin API can, but needs an editor runtime someone drives.
 * Writing the file is the only headless path. Verified against Figma import (Phase 1g).
 */
import fs from "node:fs";
import path from "node:path";
import { open, save, hex, colorVariables, bindingFor, paints, guidStr } from "./lib/figfile.mjs";

const DEFAULT_RULES = {
  "color/unbound": "error",
  "color/unbound-library": "warn",
  "color/off-token": ["warn", { tokens: [], top: 10 }],
  "radius/max": ["warn", { max: 16, allowPill: true }],
  "font/allowlist": ["warn", { families: [] }],
  "text/placeholder": ["warn", { patterns: ["lorem", "ipsum", "占位", "示例", "待补充", "xxx", "テスト"] }],
};

const sev = (r) => (Array.isArray(r) ? r[0] : r);
const opt = (r) => (Array.isArray(r) ? r[1] || {} : {});

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

  const findings = [];
  const add = (rule, msg, sample) => {
    let f = findings.find((x) => x.rule === rule && x.message === msg);
    if (!f) { f = { rule, severity: sev(rules[rule]), message: msg, count: 0, samples: [] }; findings.push(f); }
    f.count++;
    if (f.samples.length < 5 && sample) f.samples.push(sample);
  };

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
  if (rules["color/off-token"]) {
    const top = [...offToken].sort((a, b) => b[1].count - a[1].count).slice(0, opt(rules["color/off-token"]).top || 10);
    for (const [h, e] of top) {
      const f = { rule: "color/off-token", severity: sev(rules["color/off-token"]),
                  message: `${h} used ${e.count}x — matches no variable and no configured token`,
                  count: e.count, samples: [e.sample] };
      findings.push(f);
    }
  }

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

const [cmd, file, ...rest] = process.argv.slice(2);
const flag = (n) => { const i = rest.indexOf(n); return i >= 0 ? rest[i + 1] : undefined; };
const has = (n) => rest.includes(n);

if (!cmd || !file || has("--help")) {
  console.log(`figqa — design-system QA for Figma files, with no Figma

  figqa vars <file.fig>
  figqa lint <file.fig> [--rules rules.json] [--json]
  figqa fix  <file.fig> -o <out.fig> [--mark]

--mark prefixes changed layer names with 🧪 so you can find them with Ctrl+F in Figma.`);
  process.exit(file ? 0 : 1);
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
