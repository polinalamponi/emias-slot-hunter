const { test } = require('node:test');
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');

test('сборка создаёт userscript с метаданными и кодом ядра', () => {
  execFileSync('node', ['scripts/build.js'], { cwd: ROOT });
  const out = fs.readFileSync(path.join(ROOT, 'dist/emias-slot-hunter.user.js'), 'utf8');
  assert.match(out, /==UserScript==/);
  assert.match(out, /@match\s+https:\/\/emias\.info\/\*/);
  assert.match(out, /EmiasCore/);
  assert.ok(!out.includes('require('), 'в собранном файле не должно остаться require()');
});
