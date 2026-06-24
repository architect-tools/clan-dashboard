// check-imports.mjs — verify every named import resolves to a real export.
import { readFileSync, readdirSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';

const ID = '[A-Za-z0-9_$]+';
const files = [];
(function walk(d) {
  for (const e of readdirSync(d, { withFileTypes: true })) {
    const p = join(d, e.name);
    if (e.isDirectory()) walk(p); else if (p.endsWith('.js')) files.push(p);
  }
})('docs/js');

const exportsOf = {};
for (const f of files) {
  const src = readFileSync(f, 'utf8');
  const names = new Set();
  for (const m of src.matchAll(new RegExp(`export\\s+(?:async\\s+)?function\\s+(${ID})`, 'g'))) names.add(m[1]);
  for (const m of src.matchAll(new RegExp(`export\\s+(?:const|let|var)\\s+(${ID})`, 'g'))) names.add(m[1]);
  for (const m of src.matchAll(/export\s*\{([^}]+)\}/g))
    m[1].split(',').forEach((x) => { const n = x.trim().split(/\s+as\s+/).pop().trim(); if (n) names.add(n); });
  exportsOf[resolve(f)] = names;
}

let problems = 0;
for (const f of files) {
  const src = readFileSync(f, 'utf8');
  for (const m of src.matchAll(/import\s*\{([^}]+)\}\s*from\s*['"]([^'"]+)['"]/g)) {
    const imported = m[1].split(',').map((x) => x.trim().split(/\s+as\s+/)[0].trim()).filter(Boolean);
    const target = resolve(dirname(f), m[2]);
    if (!exportsOf[target]) { console.log('MISSING FILE: ' + m[2] + ' (in ' + f + ')'); problems++; continue; }
    for (const name of imported)
      if (!exportsOf[target].has(name)) { console.log(`MISSING EXPORT: ${name} <- ${m[2]} (in ${f})`); problems++; }
  }
}
console.log(problems === 0 ? `✅ import graph fully consistent (${files.length} modules)` : `❌ ${problems} problems`);
process.exit(problems === 0 ? 0 : 1);
