const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createUtil } = require('../core/util.js');
const { createFilters } = require('../core/filters.js');

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
