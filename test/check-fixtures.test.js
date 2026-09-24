const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { scanTree } = require('../scripts/check-fixtures.js');

test('обнаруживает номер полиса (16 цифр подряд)', () => {
  const tmpdir = fs.mkdtempSync(path.join(os.tmpdir(), 'check-fixtures-'));
  try {
    // генерируем 16 цифр программно, чтобы не было в исходном коде
    const policy = Array(16).fill(0).map((_, i) => String(i % 10)).join('');
    fs.writeFileSync(path.join(tmpdir, 'bad.md'), `№ ${policy}`);
    const bad = scanTree(tmpdir);
    assert.equal(bad.length, 1);
    assert.match(bad[0], /bad.md.*полиса ОМС/);
  } finally {
    fs.rmSync(tmpdir, { recursive: true });
  }
});

test('не находит личных данных в чистом дереве', () => {
  const tmpdir = fs.mkdtempSync(path.join(os.tmpdir(), 'check-fixtures-'));
  try {
    fs.writeFileSync(path.join(tmpdir, 'test.js'), 'const x = 123; const y = "2026-09-23";');
    const bad = scanTree(tmpdir);
    assert.equal(bad.length, 0);
  } finally {
    fs.rmSync(tmpdir, { recursive: true });
  }
});
