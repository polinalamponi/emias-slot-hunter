const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createUtil } = require('../core/util.js');
const { createFilters, parseAddressFilter, addressMatches } = require('../core/filters.js');

const util = createUtil();
const f = createFilters(util);
const NOW = util.toMs('2026-09-23T09:00:00+03:00');
const slot = (start, mins = 15) => ({
  startTime: start,
  endTime: new Date(util.toMs(start) + mins * 60000).toISOString().replace('Z', '+00:00'),
});
const base = {
  id: 't1', scenario: 'shiftLdp', current: '2026-09-30T13:45:00+03:00',
  dateFrom: null, dateTo: null, timeFrom: null, timeTo: null, onlyDay: null,
  anyTime: false, near: null, prefer: null,
  minLeadMs: 2 * 3600000, travelMs: 3600000, respectTravel: true,
};
const pick = (slots, target = base, appointments = []) =>
  f.pickSlots({ slots, target, now: NOW, appointments, addressOf: () => 'улица Тестовая, д. 1' });

test('отбрасывает слоты позже текущей записи', () => {
  const r = pick([slot('2026-10-01T10:00:00+03:00'), slot('2026-09-25T10:00:00+03:00')]);
  assert.equal(r.ok.length, 1);
  assert.equal(r.ok[0].startTime, '2026-09-25T10:00:00+03:00');
  assert.equal(r.rejected[0].reason, 'позже текущей записи');
});

test('anyTime разрешает слоты позже текущей записи, но не ровно текущий', () => {
  const t = { ...base, anyTime: true, onlyDay: '2026-09-30' };
  const r = pick([slot('2026-09-30T13:45:00+03:00'), slot('2026-09-30T16:00:00+03:00')], t);
  assert.deepEqual(r.ok.map((s) => s.startTime), ['2026-09-30T16:00:00+03:00']);
});

test('соблюдает минимальный запас времени', () => {
  const r = pick([slot('2026-09-23T10:00:00+03:00'), slot('2026-09-23T14:00:00+03:00')]);
  assert.deepEqual(r.ok.map((s) => s.startTime), ['2026-09-23T14:00:00+03:00']);
  assert.equal(r.rejected[0].reason, 'слишком скоро (меньше 2 ч)');
});

test('уважает dateFrom, dateTo, окно времени и onlyDay', () => {
  const slots = [
    slot('2026-09-24T07:30:00+03:00'), slot('2026-09-25T09:00:00+03:00'), slot('2026-09-26T09:00:00+03:00'),
  ];
  const t = { ...base, dateFrom: '2026-09-25', dateTo: '2026-09-25', timeFrom: '08:00', timeTo: '11:00' };
  assert.deepEqual(pick(slots, t).ok.map((s) => s.startTime), ['2026-09-25T09:00:00+03:00']);
  const t2 = { ...base, onlyDay: '2026-09-26' };
  assert.deepEqual(pick(slots, t2).ok.map((s) => s.startTime), ['2026-09-26T09:00:00+03:00']);
});

test('время «с 18:00 до 09:00» — до или после работы', () => {
  const slots = [slot('2026-09-25T08:30:00+03:00'), slot('2026-09-25T12:00:00+03:00'), slot('2026-09-25T18:30:00+03:00')];
  const t = { ...base, timeFrom: '18:00', timeTo: '09:00' };
  assert.deepEqual(pick(slots, t).ok.map((s) => s.startTime).sort(), ['2026-09-25T08:30:00+03:00', '2026-09-25T18:30:00+03:00']);
  const evening = { ...base, timeFrom: '18:00' };
  assert.deepEqual(pick(slots, evening).ok.map((s) => s.startTime), ['2026-09-25T18:30:00+03:00']);
  const morning = { ...base, timeTo: '09:00' };
  assert.deepEqual(pick(slots, morning).ok.map((s) => s.startTime), ['2026-09-25T08:30:00+03:00']);
});

test('prefer поднимает подходящие слоты наверх, остальные по возрастанию времени', () => {
  const slots = [slot('2026-09-24T15:00:00+03:00'), slot('2026-09-26T09:00:00+03:00'), slot('2026-09-25T10:30:00+03:00')];
  const t = { ...base, prefer: { until: '2026-09-25', timeTo: '11:00' } };
  assert.deepEqual(pick(slots, t).ok.map((s) => s.startTime), [
    '2026-09-25T10:30:00+03:00', '2026-09-24T15:00:00+03:00', '2026-09-26T09:00:00+03:00',
  ]);
});

test('near оставляет только слоты ближе к интервалу, чем текущая запись, и сортирует по близости', () => {
  const t = {
    ...base, current: '2026-09-25T18:00:00+03:00', onlyDay: '2026-09-25',
    near: { start: '2026-09-25T11:00:00+03:00', end: '2026-09-25T11:15:00+03:00' },
  };
  const slots = [slot('2026-09-25T19:00:00+03:00'), slot('2026-09-25T13:00:00+03:00'), slot('2026-09-25T11:30:00+03:00')];
  const r = pick(slots, t);
  assert.deepEqual(r.ok.map((s) => s.startTime), ['2026-09-25T11:30:00+03:00', '2026-09-25T13:00:00+03:00']);
});

test('travelOk: час на дорогу между разными адресами, пересечения запрещены', () => {
  const appts = [{ id: 9, startTime: '2026-09-25T12:00:00', endTime: '2026-09-25T12:30:00', lpuAddress: 'улица Другая, д. 2' }];
  const near = { startTime: '2026-09-25T12:45:00+03:00', endTime: '2026-09-25T13:00:00+03:00' };
  const far = { startTime: '2026-09-25T14:00:00+03:00', endTime: '2026-09-25T14:15:00+03:00' };
  const args = { selfId: null, address: 'улица Тестовая, д. 1', appointments: appts, travelMs: 3600000 };
  assert.equal(f.travelOk({ ...args, slot: near }), false);
  assert.equal(f.travelOk({ ...args, slot: far }), true);
});

test('travelOk игнорирует саму переносимую запись', () => {
  const appts = [{ id: 9, startTime: '2026-09-25T12:00:00', endTime: '2026-09-25T12:30:00', lpuAddress: 'улица Другая, д. 2' }];
  const slot9 = { startTime: '2026-09-25T12:45:00+03:00', endTime: '2026-09-25T13:00:00+03:00' };
  assert.equal(f.travelOk({ selfId: 9, address: 'улица Тестовая, д. 1', slot: slot9, appointments: appts, travelMs: 3600000 }), true);
});

test('onlyIfConflict: если текущая запись ни с чем не конфликтует, слоты не предлагаются', () => {
  const t = { ...base, current: '2026-09-25T18:00:00+03:00', onlyDay: '2026-09-25', onlyIfConflict: true, selfId: 5 };
  const appts = [
    { id: 5, startTime: '2026-09-25T18:00:00', endTime: '2026-09-25T18:30:00', lpuAddress: 'улица Тестовая, д. 1' },
    { id: 6, startTime: '2026-09-25T09:00:00', endTime: '2026-09-25T09:30:00', lpuAddress: 'улица Другая, д. 2' },
  ];
  const r = f.pickSlots({ slots: [slot('2026-09-25T12:00:00+03:00')], target: t, now: NOW, appointments: appts, addressOf: () => 'улица Тестовая, д. 1' });
  assert.equal(r.ok.length, 0);
  assert.equal(r.skipped, 'конфликта нет');
});

test('onlyIfConflict: при пересечении с другой записью слоты предлагаются', () => {
  const t = { ...base, current: '2026-09-25T12:10:00+03:00', onlyDay: '2026-09-25', onlyIfConflict: true, selfId: 5, anyTime: true };
  const appts = [
    { id: 5, startTime: '2026-09-25T12:10:00', endTime: '2026-09-25T12:40:00', lpuAddress: 'улица Тестовая, д. 1' },
    { id: 6, startTime: '2026-09-25T12:00:00', endTime: '2026-09-25T12:30:00', lpuAddress: 'улица Другая, д. 2' },
  ];
  const r = f.pickSlots({ slots: [slot('2026-09-25T16:00:00+03:00')], target: t, now: NOW, appointments: appts, addressOf: () => 'улица Тестовая, д. 1' });
  assert.equal(r.ok.length, 1);
  assert.equal(r.skipped, undefined);
});

/* ==================== мульти-фильтр адреса ==================== */

test('parseAddressFilter: ключи с +, без префикса, с - и через точку с запятой', () => {
  assert.deepEqual(parseAddressFilter('+фабрики -шишкин; -щапово; знамя'), {
    any: ['фабрики', 'знамя'], none: ['шишкин', 'щапово'],
  });
});

test('parseAddressFilter: пробел ключи не делит — несколько слов остаются одной фразой', () => {
  assert.deepEqual(parseAddressFilter('+знамя труда -шишкин лес'), { any: ['знамя труда'], none: ['шишкин лес'] });
  assert.deepEqual(parseAddressFilter('улица Тестовая, д. 2'), { any: ['улица тестовая, д. 2'], none: [] });
  // Дефис в слове и « - » с пробелами вокруг — не начало исключения.
  assert.deepEqual(parseAddressFilter('Ново-Переделкино'), { any: ['ново-переделкино'], none: [] });
  assert.deepEqual(parseAddressFilter('д. 5 - стр. 1'), { any: ['д. 5 - стр. 1'], none: [] });
});

// Регрессия: «в этом же здании» кладёт в фильтр адрес целиком. Если бы пробел
// делил его на ключи «ИЛИ», под «улица … д. 2» подошли бы чужие здания.
test('addressMatches: полный адрес («в этом же здании») не пропускает другие здания', () => {
  const same = 'улица Тестовая, д. 2';
  assert.equal(addressMatches('улица Тестовая, д. 2', same), true);
  assert.equal(addressMatches('улица Тестовая, д. 2, стр. 1', same), true);
  assert.equal(addressMatches('проспект Мира, д. 12', same), false);
  assert.equal(addressMatches('улица Тестовая, д. 3', same), false);
  assert.equal(addressMatches('улица Ленина, д. 2', same), false);
});

test('parseAddressFilter: кавычки склеивают фразу в один ключ, минус работает и перед кавычкой', () => {
  assert.deepEqual(parseAddressFilter('"ленина, д. 5" -"шишкин лес"'), {
    any: ['ленина, д. 5'], none: ['шишкин лес'],
  });
});

test('parseAddressFilter: плюс перед кавычками — фраза целиком как включение', () => {
  assert.deepEqual(parseAddressFilter('+"улица Алтайская, д. 13" -шишкин'), {
    any: ['улица алтайская, д. 13'], none: ['шишкин'],
  });
  assert.equal(addressMatches('улица Алтайская, д. 13, стр. 2', '+"улица Алтайская, д. 13"'), true);
  assert.equal(addressMatches('улица Алтайская, д. 3', '+"улица Алтайская, д. 13"'), false);
});

test('parseAddressFilter: пустая строка и мусор дают пустые списки', () => {
  assert.deepEqual(parseAddressFilter(''), { any: [], none: [] });
  assert.deepEqual(parseAddressFilter(null), { any: [], none: [] });
  assert.deepEqual(parseAddressFilter('+ -  ---  ; ;'), { any: [], none: [] });
});

test('addressMatches: достаточно совпадения с любым из ключей-включений (ИЛИ)', () => {
  assert.equal(addressMatches('посёлок Знамя труда, д. 1', '+фабрики +знамя'), true);
  assert.equal(addressMatches('посёлок Фабрики, д. 1', '+фабрики +знамя'), true);
  assert.equal(addressMatches('улица Тестовая, д. 2', '+фабрики +знамя'), false);
});

test('addressMatches: любой запрещённый ключ исключает адрес', () => {
  assert.equal(addressMatches('посёлок Шишкин лес', '+знамя -шишкин'), false);
  assert.equal(addressMatches('шишкин', '-шишкин -щапово'), false);
  assert.equal(addressMatches('улица Тестовая, д. 2', '-шишкин'), true);
});

test('addressMatches: только исключения — адрес без них проходит', () => {
  assert.equal(addressMatches('улица Тестовая, д. 2', '-шишкин -щапово'), true);
});

test('addressMatches: пустой фильтр пропускает всё, регистр не важен', () => {
  assert.equal(addressMatches('улица Тестовая, д. 2', ''), true);
  assert.equal(addressMatches('', ''), true);
  assert.equal(addressMatches('улица ТЕСТОВАЯ', 'тестовая'), true);
  assert.equal(addressMatches(null, 'тестовая'), false);
  assert.equal(addressMatches(null, ''), true);
});

test('addressMatches: одиночный ключ ведёт себя как прежний includes()', () => {
  assert.equal(addressMatches('улица Тестовая, д. 2', 'Тестовая, д. 2'), true);
  assert.equal(addressMatches('улица Тестовая, д. 2', 'к. 28'), false);
});
