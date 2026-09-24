// scripts/check-fixtures.js — не даёт утечь личным данным
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const SKIP_PATHS = ['.git', 'node_modules', 'dist', '.superpowers', 'docs/superpowers'];
const RULES = [
  [/\b\d{16}\b/, 'похоже на номер полиса ОМС (16 цифр)'],
  [/"birthDate"\s*:\s*"(19|20)\d\d-\d\d-\d\d"/, 'похоже на дату рождения'],
  [/\b[А-ЯЁ][а-яё]+\s+[А-ЯЁ][а-яё]+(вич|вна|ична)\b/, 'похоже на ФИО'],
];

function shouldSkip(relPath) {
  for (const skip of SKIP_PATHS) {
    if (relPath === skip || relPath.startsWith(skip + '/')) return true;
  }
  return false;
}

function scanTree(rootDir) {
  const bad = [];
  (function walk(dir) {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      const relPath = path.relative(rootDir, p);
      if (shouldSkip(relPath)) continue;
      if (e.isDirectory()) { walk(p); continue; }
      if (!/\.(js|json|md)$/.test(e.name)) continue;
      const text = fs.readFileSync(p, 'utf8');
      for (const [re, why] of RULES) {
        const m = text.match(re);
        if (m) bad.push(`${relPath}: ${why} → ${m[0]}`);
      }
    }
  })(rootDir);
  return bad;
}

if (typeof module === 'object' && module.exports) module.exports = { scanTree };

if (typeof require !== 'undefined' && require.main === module) {
  const bad = scanTree(ROOT);
  if (bad.length) { console.error('Найдены личные данные:\n' + bad.join('\n')); process.exit(1); }
  console.log('проверка на личные данные пройдена');
}
