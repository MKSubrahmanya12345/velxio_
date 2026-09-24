#!/usr/bin/env node
// Static wiring checker — no install, no run, no bundler.
//
// Three passes:
//   1. RESOLVE   every relative import actually exists on disk
//                (Forge cross-imports are easy to get wrong by one level:
//                 src/*.js -> ../../../forge, src/services/*.js -> ../../../../forge)
//   2. EXPORTS   every named local import is actually exported by its target
//   3. SYMBOLS   every local exported symbol that a file USES is imported or
//                defined there (catches "used isSafetyCritical but never
//                imported", which parses fine and fails at runtime)
//
// Run after moving/adding files:
//   node WireGI/scripts/check-imports.cjs

const fs = require('fs');
const path = require('path');

const REPO = path.resolve(__dirname, '..', '..');
const ROOTS = ['WireGI/server/src', 'WireGI/client/src'];
const EXT = ['.js', '.ts', '.tsx'];

const files = [];
for (const root of ROOTS) {
  const abs = path.join(REPO, root);
  if (!fs.existsSync(abs)) continue;
  (function walk(dir) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(p);
      else if (EXT.includes(path.extname(entry.name))) files.push(p);
    }
  })(abs);
}

// Comments only — used where string contents still matter (import specifiers).
const strip = (src) =>
  src
    .replace(/\/\*[\s\S]*?\*\//g, '') // block comments
    .replace(/(^|[^:])\/\/.*$/gm, '$1'); // line comments (keeps http://)

// Comments AND string literals — used for the symbol pass, so that a string
// like 'research' or "health" is never mistaken for a reference to an
// exported function of the same name.
const stripHard = (src) =>
  strip(src)
    .replace(/`(?:[^`\\]|\\.)*`/g, '``')
    .replace(/'(?:[^'\\\n]|\\.)*'/g, "''")
    .replace(/"(?:[^"\\\n]|\\.)*"/g, '""');

const read = (f) => fs.readFileSync(f, 'utf8');

// ── gather exports per file ────────────────────────────────────────────────
const exportsByFile = new Map();
for (const f of files) {
  const src = strip(read(f));
  const names = new Set();
  for (const m of src.matchAll(/export\s+(?:async\s+)?function\s+([A-Za-z0-9_$]+)/g)) names.add(m[1]);
  for (const m of src.matchAll(/export\s+(?:const|let|var|class)\s+([A-Za-z0-9_$]+)/g)) names.add(m[1]);
  // TypeScript type-only exports (`export type X`, `export interface X`) — the
  // client is .tsx, so an imported type must not read as a missing export.
  for (const m of src.matchAll(/export\s+(?:type|interface|enum)\s+([A-Za-z0-9_$]+)/g)) names.add(m[1]);
  for (const m of src.matchAll(/export\s*\{([^}]+)\}/g)) {
    for (const part of m[1].split(',')) {
      const name = part.split(/\s+as\s+/).pop().trim();
      if (name) names.add(name);
    }
  }
  exportsByFile.set(path.resolve(f), names);
}

const IMPORT_RE = /import\s+(?:([A-Za-z0-9_$]+)\s*,\s*)?(?:\{([^}]*)\})?\s*from\s*['"]([^'"]+)['"]/g;

function resolveLocal(fromFile, spec) {
  if (!spec.startsWith('.')) return null;
  const base = path.resolve(path.dirname(fromFile), spec);
  const candidates = [base, ...EXT.map((e) => base + e), ...EXT.map((e) => path.join(base, 'index' + e))];
  return candidates.find((c) => fs.existsSync(c) && fs.statSync(c).isFile()) || null;
}

let checked = 0;
let missing = 0;
let badExport = 0;
let undef = 0;

// ── pass 1 + 2 ─────────────────────────────────────────────────────────────
for (const f of files) {
  const src = strip(read(f));
  for (const m of src.matchAll(IMPORT_RE)) {
    const [, , named, spec] = m;
    if (!spec.startsWith('.')) continue; // bare specifier: express, react, node:…
    checked += 1;
    const target = resolveLocal(f, spec);
    if (!target) {
      missing += 1;
      console.log(`MISSING   ${path.relative(REPO, f)}  ->  ${spec}`);
      continue;
    }
    if (!named) continue;
    const available = exportsByFile.get(target);
    if (!available) continue; // target outside the scanned roots
    for (const part of named.split(',')) {
      // `import { type X, y }` — strip the inline type modifier before checking
      const name = part
        .trim()
        .replace(/^type\s+/, '')
        .split(/\s+as\s+/)[0]
        .trim();
      if (!name) continue;
      if (!available.has(name)) {
        badExport += 1;
        console.log(`NO EXPORT ${name}  in ${path.relative(REPO, f)}  ->  ${spec}`);
      }
    }
  }
}

// ── pass 3: local exports used but not imported/defined ────────────────────
// Every symbol the local services export, so a typo'd import shows up as a
// use-without-definition rather than an ERR at boot.
const localSymbols = new Set();
for (const [, names] of exportsByFile) for (const n of names) localSymbols.add(n);

for (const f of files) {
  // Two views of the file: `src` has strings/comments removed so a call site is
  // never faked by a string literal, and `impSrc` keeps string contents so the
  // import specifiers are still readable.
  const src = stripHard(read(f));
  const impSrc = strip(read(f));
  for (const sym of localSymbols) {
    // Only flag a BARE call site — `sym(` — which is what breaks at runtime.
    // Property keys ({ research: … }), method calls (agent.resumeProject(…))
    // and other names ending in the symbol (myResearch(…) are all ignored.
    if (!new RegExp(`(?<![.\\w$])${sym}\\s*\\(`).test(src)) continue;

    // Declared in this very file?
    const declares = new RegExp(
      `(?:export\\s+)?(?:async\\s+)?(?:function|const|let|var|class)\\s+${sym}\\b`,
    ).test(src);
    if (declares) continue;

    // Imported (with or without an alias) from a relative specifier?
    const imported = [...impSrc.matchAll(IMPORT_RE)].some(
      ([, , named, spec]) =>
        spec.startsWith('.') &&
        (named || '').split(',').some((p) => p.split(/\s+as\s+/)[0].trim() === sym),
    );
    if (!imported) {
      undef += 1;
      console.log(`NOT IMPORTED  ${sym}(  called in ${path.relative(REPO, f)}`);
    }
  }
}

console.log(
  `imports checked: ${checked}   missing: ${missing}   bad exports: ${badExport}   unimported symbols: ${undef}`,
);
process.exit(missing || badExport || undef ? 1 : 0);
