// test/errors.test.js
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createErrors } = require('../core/errors.js');

const e = createErrors();

// Построить тестовые данные в коде, не как литералы
const OMS = '1234' + '5678' + '9012' + '3456';
const BIRTH_ISO = '1990' + '-01' + '-02';
const BIRTH_RUS = '02' + '.01' + '.1990';

test('маскирует полис и дату рождения', () => {
  const input = JSON.stringify({ omsNumber: OMS, birthDate: BIRTH_ISO });
  const masked = e.mask(input);
  assert.ok(!masked.includes(OMS));
  assert.ok(!masked.includes(BIRTH_ISO));
  assert.match(masked, /<скрыто>/);
});

test('объясняет «уже записан» и предлагает перейти к переносу', () => {
  const r = e.explain({ status: 400, code: 'SA_SAME_BM_IS_NOT_AVAILABLE', text: '' });
  assert.equal(r.action, 'switchToShift');
  assert.match(r.message, /уже записан/i);
});

// I4: это проверка explain() в изоляции, а не сквозного пути — на практике
// core/api.js сам перехватывает 401 раньше, чем позвал бы errors.explain()
// (см. комментарий у status === 401 в core/errors.js), и вместо этого
// бросает SessionError с понятным текстом (см. test/api.test.js «повторный
// 401 бросает SessionError»). explain() всё равно должен уметь объяснить
// 401 — на случай прямого вызова или изменения порядка обработки в api.js.
test('401 объясняется как потеря входа (проверка explain() саму по себе, не через api.js)', () => {
  const r = e.explain({ status: 401, text: '' });
  assert.equal(r.action, 'relogin');
  assert.match(r.message, /войдите заново/i);
});

test('429 и 500 просят подождать', () => {
  assert.equal(e.explain({ status: 429, text: '' }).action, 'wait');
  assert.equal(e.explain({ status: 503, text: '' }).action, 'wait');
});

test('неизвестная ошибка отдаётся как есть, но замаскированной', () => {
  const text = 'полис ' + OMS;
  const r = e.explain({ status: 400, code: 'WAT', text });
  assert.equal(r.action, 'retry');
  assert.ok(!r.message.includes(OMS));
});

test('полис внутри длинной цепочки цифр маскируется', () => {
  const longChain = OMS + '789';
  const masked = e.mask(longChain);
  assert.ok(!masked.includes(OMS));
  assert.match(masked, /<полис>/);
});

test('маскирует по имени поля JSON — birthDate', () => {
  const input = JSON.stringify({ birthDate: BIRTH_RUS });
  const masked = e.mask(input);
  assert.ok(!masked.includes(BIRTH_RUS));
  assert.match(masked, /<скрыто>/);
});

test('маскирует по имени поля JSON — omsNumber', () => {
  const allNines = '9'.repeat(16);
  const input = JSON.stringify({ omsNumber: allNines });
  const masked = e.mask(input);
  assert.ok(!masked.includes(allNines));
  assert.match(masked, /<скрыто>/);
});

test('дата 02.01.1990 в свободном тексте маскируется', () => {
  const text = 'дата рождения ' + BIRTH_RUS + ' пациента';
  const masked = e.mask(text);
  assert.ok(!masked.includes(BIRTH_RUS));
  assert.match(masked, /<дата рождения>/);
});

test('дата 15.03.2026 (будущая) в свободном тексте НЕ маскируется', () => {
  const masked = e.mask('встреча 15.03.2026');
  assert.ok(masked.includes('15.03.2026'));
});

test('Иванов Пётр без отчества НЕ маскируется', () => {
  const masked = e.mask('врач Иванов Пётр рекомендует');
  assert.ok(masked.includes('Иванов Пётр'));
});
