/**
 * Code-side adapter: read a directory of generated UI code the same way lib/figfile.mjs
 * reads a .fig, so that one rule set can be asserted against both artifacts.
 *
 * The point of the pair is the cross-check. A design system's ground truth lives in the
 * .fig; whether the generated code actually referenced it is only observable in the code.
 * Neither file answers the question alone.
 *
 * Deterministic and offline, like the rest of figqa: read the bytes, count, compare.
 */
import fs from "node:fs";
import path from "node:path";

const CODE_EXT = new Set([".tsx", ".ts", ".jsx", ".js", ".mjs", ".css", ".scss", ".sass", ".less", ".html", ".vue", ".svelte"]);
const SKIP_DIR = new Set(["node_modules", ".git", "dist", "build", "out", ".next", ".nuxt", "coverage", ".turbo", ".cache"]);

/** Every hex literal, 6- or 8-digit. 8-digit carries alpha, which is part of a colour's identity. */
const HEX = /#([0-9a-fA-F]{8}|[0-9a-fA-F]{6})\b/g;

/**
 * Custom-property definitions. Deliberately NOT anchored to line start: a compact token
 * sheet puts two on one line —  `--text-xs: 12px;  --lh-xs: 18px;`  — and an anchored
 * pattern silently misses the second, which then reports as an undefined reference.
 * That false positive cost real time before the anchor was removed.
 */
const DEF = /(--[a-zA-Z0-9_-]+)\s*:\s*[^;{}]+/g;

/** Uses of a custom property. */
const REF = /var\(\s*(--[a-zA-Z0-9_-]+)/g;

/** `@import '...'` / `@import url("...")` — the tokens a tree uses may be defined behind one. */
const IMPORT = /@import\s+(?:url\()?\s*['"]([^'"]+)['"]/g;

export function walkCode(dir) {
  const files = [];
  (function rec(d) {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      if (e.isDirectory()) { if (!SKIP_DIR.has(e.name)) rec(path.join(d, e.name)); continue; }
      if (CODE_EXT.has(path.extname(e.name).toLowerCase())) files.push(path.join(d, e.name));
    }
  })(dir);
  return files;
}

/**
 * Scan a code tree.
 *   colors  every hex literal, with file:line
 *   refs    every var(--x) use, with file:line
 *   defs    Map of --x -> first definition site
 */
function readDefs(file, defs) {
  const lines = fs.readFileSync(file, "utf8").split(/\r?\n/);
  for (let i = 0; i < lines.length; i++)
    for (const m of lines[i].matchAll(DEF)) if (!defs.has(m[1])) defs.set(m[1], { file, line: i + 1 });
}

/**
 * Follow `@import` out of the tree so token definitions living in a dependency still count.
 * A specifier that cannot be located is recorded, not guessed at: a tree whose tokens come
 * from an unresolved stylesheet cannot support a sound "this token is undefined" claim, and
 * the caller needs to know that rather than receive a page of false alarms.
 */
/** A specifier may name a file, or a package directory whose stylesheet has to be located. */
function asStylesheet(p) {
  if (!fs.existsSync(p)) return null;
  if (fs.statSync(p).isFile()) return p;
  for (const n of ["index.css", "style.css", "styles.css", "dist/style.css"]) {
    const c = path.join(p, n);
    if (fs.existsSync(c) && fs.statSync(c).isFile()) return c;
  }
  const pkg = path.join(p, "package.json");
  if (fs.existsSync(pkg)) {
    try {
      const s = JSON.parse(fs.readFileSync(pkg, "utf8")).style;
      const c = s && path.join(p, s);
      if (c && fs.existsSync(c) && fs.statSync(c).isFile()) return c;
    } catch { /* a malformed package.json is not a reason to crash the lint */ }
  }
  return null;
}

function resolveImports(root, imports, defs, scanned) {
  const unresolved = [];
  for (const im of imports) {
    const cands = im.spec.startsWith(".")
      ? [path.resolve(path.dirname(im.file), im.spec)]
      : [path.join(root, "node_modules", im.spec),
         path.join(root, "..", "node_modules", im.spec),
         path.resolve(path.dirname(im.file), im.spec)];
    const hit = cands.map(asStylesheet).find(Boolean);
    if (!hit) { unresolved.push(im.spec); continue; }
    if (scanned.has(hit)) continue;
    scanned.add(hit);
    readDefs(hit, defs);
  }
  return [...new Set(unresolved)];
}

export function scanCode(dir) {
  const files = walkCode(dir);
  const colors = [], refs = [], defs = new Map(), imports = [];
  for (const f of files) {
    const lines = fs.readFileSync(f, "utf8").split(/\r?\n/);
    for (let i = 0; i < lines.length; i++) {
      const ln = lines[i];
      // Definition spans are computed first: a hex sitting inside one is a token's *value*,
      // not a hard-coded colour. Someone has to write the literal once — that is what an
      // alias layer is for. The question for those is whether the value still agrees with
      // the design system, which is a different rule.
      const spans = [...ln.matchAll(DEF)].map((m) => [m.index, m.index + m[0].length, m[1]]);
      for (const [, , name] of spans) if (!defs.has(name)) defs.set(name, { file: f, line: i + 1 });
      for (const m of ln.matchAll(HEX)) {
        const inDef = spans.find(([s, e]) => m.index >= s && m.index < e);
        colors.push({ hex: ("#" + m[1]).toUpperCase(), file: f, line: i + 1, def: inDef ? inDef[2] : null });
      }
      for (const m of ln.matchAll(REF)) refs.push({ name: m[1], file: f, line: i + 1 });
      for (const m of ln.matchAll(IMPORT)) imports.push({ spec: m[1], file: f, line: i + 1 });
    }
  }
  const unresolvedImports = resolveImports(dir, imports, defs, new Set(files));
  return { root: dir, files, colors, refs, defs, imports, unresolvedImports };
}

export const rel = (root, f) => path.relative(root, f).split(path.sep).join("/");

// ---------------------------------------------------------------- design system from CSS
//
// A design system's ground truth does not always live in a .fig. A Tailwind-style theme
// sheet is the source in exactly the same sense, so `--system` accepts one, and the rest of
// the lint cannot tell the difference: this returns the same { hex, name } shape that
// figfile.mjs's colorVariables() does.
//
// Two properties of real theme sheets make a naive reader useless. Untitled UI's theme.css
// is the reference case: 18 of its ~500 custom properties hold a literal colour and 486
// point at another var(), and the chains terminate in Tailwind's own palette, which is not
// in the file. Reading definitions alone would silently recover 4% of the system and report
// no problem. So this resolves alias chains, and counts what it still could not decide.

/**
 * Normalise any CSS colour literal to the #RRGGBB[AA] form lib/figfile.mjs produces.
 *
 * `meta` is an optional out-parameter: `meta.clipped` is set when an oklch value fell outside
 * sRGB and had to be gamut-mapped. That matters because the only rule here is exact value
 * equality — Tailwind's blue-500 is out of gamut, and its own published sRGB fallback
 * (#3B82F6, kept from v3) is not the same bytes as a channel-clipped render (#2B7FFF).
 * Neither is wrong; they just cannot be compared byte-for-byte, so the count is surfaced.
 */
export function cssColorToHex(v, meta) {
  if (!v) return null;
  const s = String(v).trim();
  const p = (n) => Math.max(0, Math.min(255, Math.round(n))).toString(16).padStart(2, "0").toUpperCase();

  let m = /^#([0-9a-fA-F]{3,8})$/.exec(s);
  if (m) {
    let h = m[1];
    if (h.length === 3 || h.length === 4) h = [...h].map((c) => c + c).join("");
    if (h.length !== 6 && h.length !== 8) return null;
    h = h.toUpperCase();
    return h.length === 8 && h.slice(6) === "FF" ? "#" + h.slice(0, 6) : "#" + h;
  }

  // Tailwind v4 ships its entire palette in oklch, so a reader that only speaks rgb/hex
  // recovers almost nothing from a modern theme sheet. Conversion is the CSS Color 4
  // definition: OKLCh -> OKLab -> LMS -> linear sRGB -> sRGB, then clip to gamut.
  m = /^oklch\(([^)]*)\)$/i.exec(s);
  if (m) {
    const parts = m[1].replace(/\//g, " ").split(/[\s,]+/).filter(Boolean);
    if (parts.length < 3) return null;
    const num = (x, base) => (x.endsWith("%") ? (parseFloat(x) / 100) * base : parseFloat(x));
    const L = num(parts[0], 1), C = num(parts[1], 0.4), H = parseFloat(parts[2]);
    if (![L, C].every(Number.isFinite)) return null;
    const h = (Number.isFinite(H) ? H : 0) * Math.PI / 180;
    const a = C * Math.cos(h), bb = C * Math.sin(h);
    const l_ = L + 0.3963377774 * a + 0.2158037573 * bb;
    const m_ = L - 0.1055613458 * a - 0.0638541728 * bb;
    const s_ = L - 0.0894841775 * a - 1.2914855480 * bb;
    const l3 = l_ ** 3, m3 = m_ ** 3, s3 = s_ ** 3;
    const lin = [
       4.0767416621 * l3 - 3.3077115913 * m3 + 0.2309699292 * s3,
      -1.2684380046 * l3 + 2.6097574011 * m3 - 0.3413193965 * s3,
      -0.0041960863 * l3 - 0.7034186147 * m3 + 1.7076147010 * s3,
    ];
    // Signed gamma: a slightly out-of-gamut channel goes negative, and Math.pow of a
    // negative base is NaN. Transform the magnitude, restore the sign, then clip.
    const enc = (x) => {
      const sign = x < 0 ? -1 : 1, v = Math.abs(x);
      const g = v <= 0.0031308 ? 12.92 * v : 1.055 * Math.pow(v, 1 / 2.4) - 0.055;
      const signed = sign * g;
      if (meta && (signed < -1e-6 || signed > 1 + 1e-6)) meta.clipped = true;
      return Math.max(0, Math.min(1, signed)) * 255;
    };
    let out = "#" + lin.map((x) => p(enc(x))).join("");
    if (parts.length >= 4) {
      const al = parts[3].endsWith("%") ? parseFloat(parts[3]) / 100 : Number(parts[3]);
      if (Number.isFinite(al) && Math.abs(al - 1) > 1e-6) out += p(al * 255);
    }
    return out;
  }

  m = /^rgba?\(([^)]*)\)$/i.exec(s);
  if (!m) return null;
  // Modern `rgb(R G B / A)` and legacy `rgba(R, G, B, A)` are both accepted.
  const parts = m[1].replace(/\//g, " ").split(/[\s,]+/).filter(Boolean);
  if (parts.length < 3) return null;
  const chan = (x) => (x.endsWith("%") ? parseFloat(x) * 2.55 : Number(x));
  const rgb = parts.slice(0, 3).map(chan);
  if (rgb.some((n) => !Number.isFinite(n))) return null;
  let out = "#" + rgb.map(p).join("");
  if (parts.length >= 4) {
    const a = parts[3].endsWith("%") ? parseFloat(parts[3]) / 100 : Number(parts[3]);
    if (Number.isFinite(a) && Math.abs(a - 1) > 1e-6) out += p(a * 255);
  }
  return out;
}

/**
 * Collect `--x: value` per mode. Mode comes from the enclosing selector, tracked with a real
 * brace stack rather than a line pattern, so `@media (prefers-color-scheme: dark) { :root {…} }`
 * and a nested `.dark-mode { … }` are both attributed correctly. `\bdark\b` is deliberate:
 * `.dark-mode` matches, `.darkroom` does not.
 */
function readCssDefs(file, maps) {
  const text = fs.readFileSync(file, "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
  const stack = [];
  let buf = "";
  for (const ch of text) {
    if (ch === "{") { stack.push(buf.trim()); buf = ""; continue; }
    if (ch === "}") { stack.pop(); buf = ""; continue; }
    if (ch === ";") {
      const d = /(--[a-zA-Z0-9_-]+)\s*:\s*([\s\S]+)$/.exec(buf.trim());
      if (d) {
        const mode = stack.some((sel) => /\bdark\b/i.test(sel)) ? "dark" : "default";
        if (!maps[mode].has(d[1])) maps[mode].set(d[1], d[2].trim());
      }
      buf = ""; continue;
    }
    buf += ch;
  }
  return [...text.matchAll(IMPORT)].map((m) => ({ spec: m[1], file }));
}

/** Notations that are colours even when this file cannot evaluate them (color-mix, lab, …). */
const COLOR_NOTATION = /^(?:rgba?|hsla?|hwb|lab|lch|oklab|oklch|color|color-mix)\s*\(/i;

/**
 * Follow one token to a colour.
 *   { hex }                    resolved
 *   { undecidable, missing }   the chain ran into a variable nobody defines
 *   { unparsed }               it IS a colour, in a notation this cannot read yet
 *   null                       a literal that is genuinely not a colour (a size, a font stack)
 *
 * The third case exists because collapsing it into the fourth is a false-negative machine:
 * every oklch token in a Tailwind palette once returned "not a colour" and vanished from the
 * comparison in silence, leaving a run that looked clean because most of the system was
 * never loaded. Anything colour-shaped that cannot be evaluated has to stay countable.
 */
function trace(name, mode, maps, depth = 0) {
  if (depth > 12) return { undecidable: true, missing: name };
  const raw = (mode === "dark" && maps.dark.has(name)) ? maps.dark.get(name) : maps.default.get(name);
  if (raw === undefined) return { undecidable: true, missing: name };

  const meta = {};
  const direct = cssColorToHex(raw, meta);
  if (direct) return { hex: direct, approx: !!meta.clipped };

  const m = /^var\(\s*(--[a-zA-Z0-9_-]+)\s*(?:,\s*([\s\S]+))?\)$/.exec(raw);
  if (m) {
    const via = trace(m[1], mode, maps, depth + 1);
    if (via && via.hex) return via;
    const fallback = m[2] && cssColorToHex(m[2].trim(), meta);   // var(--x, #fff)
    return fallback ? { hex: fallback, approx: !!meta.clipped } : via;
  }
  return COLOR_NOTATION.test(raw) ? { unparsed: raw.slice(0, 48) } : null;
}

/** Read a design system out of a stylesheet, following @import and resolving var() chains. */
export function cssSystemVariables(cssPath) {
  const maps = { default: new Map(), dark: new Map() };
  const seen = new Set([path.resolve(cssPath)]);
  const root = path.dirname(cssPath);
  const queue = readCssDefs(cssPath, maps);
  const unresolvedImports = [];

  while (queue.length) {
    const im = queue.shift();
    const cands = im.spec.startsWith(".")
      ? [path.resolve(path.dirname(im.file), im.spec)]
      : [path.join(root, "node_modules", im.spec),
         path.join(root, "..", "node_modules", im.spec),
         path.join(root, "..", "..", "node_modules", im.spec),
         path.resolve(path.dirname(im.file), im.spec)];
    const hit = cands.map(asStylesheet).find(Boolean);
    if (!hit) { unresolvedImports.push(im.spec); continue; }
    if (seen.has(path.resolve(hit))) continue;
    seen.add(path.resolve(hit));
    queue.push(...readCssDefs(hit, maps));
  }

  const vars = [], missing = new Set(), unparsed = new Set();
  let undecidableTokens = 0, approx = 0;
  for (const name of new Set([...maps.default.keys(), ...maps.dark.keys()])) {
    for (const mode of ["default", "dark"]) {
      if (!maps[mode].has(name)) continue;
      const r = trace(name, mode, maps);
      if (!r) continue;                                  // genuinely not a colour
      if (r.hex) { vars.push({ hex: r.hex, name, local: true, mode }); if (r.approx) approx++; continue; }
      undecidableTokens++;
      if (r.missing) missing.add(r.missing); else unparsed.add(r.unparsed);
    }
  }
  return {
    vars,
    undecidable: undecidableTokens,
    missingExamples: [...missing].slice(0, 4),
    unparsedExamples: [...unparsed].slice(0, 3),
    approx,
    unresolvedImports: [...new Set(unresolvedImports)],
    filesRead: seen.size,
  };
}
