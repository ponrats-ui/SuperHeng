// i18n coverage audit: which dictionary groups are actually wired to a call site,
// and which source files still hold user-facing literals.
// Run: node scripts/i18n-audit.mjs
import fs from 'node:fs';
import path from 'node:path';

const SRC = 'src';
const I18N = path.join('lib', 'i18n');

function walk(dir, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const file = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === 'node_modules') continue;
      walk(file, out);
    } else if (/\.(tsx?|jsx?)$/.test(entry.name)) {
      out.push(file);
    }
  }
  return out;
}

const files = walk(SRC);
const text = new Map(files.map((f) => [f, fs.readFileSync(f, 'utf8')]));
const appText = files
  .filter((f) => !f.includes(I18N))
  .map((f) => text.get(f))
  .join('\n');

const en = text.get(path.join(SRC, I18N, 'en.ts'));
const keys = [...en.matchAll(/^ {2}'([\w.]+)':/gm)].map((m) => m[1]);

const groups = new Map();
for (const key of keys) {
  const group = key.split('.')[0];
  const stat = groups.get(group) ?? { total: 0, wired: 0 };
  stat.total += 1;
  if (appText.includes(`t('${key}'`) || appText.includes(`t("${key}"`)) stat.wired += 1;
  groups.set(group, stat);
}

console.log('--- dictionary groups (keys / wired call sites) ---');
for (const [group, stat] of [...groups].sort()) {
  const flag = stat.wired === 0 ? '  <-- NO CALL SITES' : '';
  console.log(`${group.padEnd(12)} ${String(stat.total).padStart(3)} / ${String(stat.wired).padStart(3)}${flag}`);
}

const thai = /[\u0E00-\u0E7F]/;
console.log('\n--- files with Thai source text outside i18n (UI or data) ---');
let thaiFiles = 0;
for (const file of files) {
  if (file.includes(I18N)) continue;
  const hits = text
    .get(file)
    .split(/\r?\n/)
    .map((line, i) => [i + 1, line])
    .filter(([, line]) => thai.test(line) && !/^\s*(\/\/|\*|\/\*)/.test(line));
  if (!hits.length) continue;
  thaiFiles += 1;
  console.log(`${String(hits.length).padStart(3)}  ${file}`);
  for (const [n, line] of hits.slice(0, 3)) console.log(`      ${n}: ${line.trim().slice(0, 90)}`);
}
console.log(`thai-bearing files: ${thaiFiles}`);
