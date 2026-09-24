const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createUtil } = require('../core/util.js');

const u = createUtil();

test('toMs: время без зоны считается московским', () => {
  assert.equal(u.toMs('2026-09-23T12:50:00'), u.toMs('2026-09-23T12:50:00+03:00'));
});

test('slotHHMM отдаёт московское время слота', () => {
  assert.equal(u.slotHHMM('2026-09-23T08:06:00+03:00'), '08:06');
});

test('mskDate отдаёт дату в формате YYYY-MM-DD', () => {
  assert.equal(u.mskDate(new Date('2026-09-23T21:30:00+03:00')), '2026-09-23');
  assert.equal(u.mskDate(new Date('2026-09-23T23:30:00Z')), '2026-09-24');
});

test('distTo: 0 при пересечении, иначе расстояние в мс', () => {
  const range = { start: '2026-09-23T11:00:00+03:00', end: '2026-09-23T11:15:00+03:00' };
  const at = (t) => u.toMs('2026-09-23T' + t + ':00+03:00');
  assert.equal(u.distTo(range, at('11:05'), at('11:10')), 0);
  assert.equal(u.distTo(range, at('12:00'), at('12:10')), 45 * 60000);
  assert.equal(u.distTo(range, at('10:00'), at('10:30')), 30 * 60000);
});

test('campus отбрасывает номер корпуса', () => {
  assert.equal(u.campus('Тестовый проезд, д. 5, к. 28'), u.campus('Тестовый проезд, д. 5, к. 22'));
  assert.notEqual(u.campus('Примерная улица, д. 14'), u.campus('Тестовый проезд, д. 5, к. 22'));
});

test('jitter держится в пределах ±20%', () => {
  assert.equal(u.jitter(1000, () => 0), 800);
  assert.equal(u.jitter(1000, () => 1), 1200);
  assert.equal(u.jitter(1000, () => 0.5), 1000);
});
