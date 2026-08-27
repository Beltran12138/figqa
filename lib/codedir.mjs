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
