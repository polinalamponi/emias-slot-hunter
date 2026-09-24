// test/targets.test.js
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createUtil } = require('../core/util.js');
const { createFilters } = require('../core/filters.js');
const { createTargets } = require('../core/targets.js');
const doctorsLi = require('./fixtures/doctors-li.json');
const schedule = require('./fixtures/schedule.json');
const doctorsV5 = require('./fixtures/doctors-v5.json');
const doctorsV5Multi = require('./fixtures/doctors-v5-multi.json');

const util = createUtil();
const filters = createFilters(util);
const NOW = util.toMs('2026-09-23T09:00:00+03:00');

// C2: backoffUntil() всегда есть, даже когда тест не про паузы (по умолчанию
// пауза никогда не действует) — targets.js теперь сверяется с ней перед
// каждым запросом расписания.
function fakeApi(handlers) {
  const calls = [];
  return {
    calls,
    backoffUntil: () => 0,
    post: async (path, body) => {
      calls.push({ path, body });
      for (const [match, res] of handlers) if (path.includes(match)) return typeof res === 'function' ? res(body) : res;
      throw new Error('нет обработчика для ' + path);
    },
  };
}

const labTarget = {
  id: 'lab', scenario: 'bookLab', addressContains: 'Тестовая, д. 2',
  minLeadMs: 2 * 3600000, travelMs: 3600000, respectTravel: true,
  source: { moId: 10000001, samplingTypeId: 1 }, dateTo: '2026-10-14',
};

test('bookLab ищет кабинеты по направлению и отдаёт слоты с адресом', async () => {
  const api = fakeApi([['getDoctorsInfoForLI', { ok: true, json: doctorsLi }], ['getAvailableResourceScheduleInfo', { ok: true, json: schedule }]]);
  const t = createTargets({ api, filters, util });
  const r = await t.search(labTarget, { now: NOW, appointments: [] });
  assert.equal(r.candidates.length, 2);
  assert.equal(r.candidates[0].address, 'улица Тестовая, д. 2');
  assert.equal(r.candidates[0].resourceId, 200000001);
  assert.equal(r.candidates[0].complexResourceId, 300000001);
  assert.equal(api.calls[0].body.assignment.moId, 10000001);
});

test('фильтр по адресу отбрасывает чужие кабинеты', async () => {
  const api = fakeApi([['getDoctorsInfoForLI', { ok: true, json: doctorsLi }], ['getAvailableResourceScheduleInfo', { ok: true, json: schedule }]]);
  const t = createTargets({ api, filters, util });
  const r = await t.search({ ...labTarget, addressContains: 'к. 28' }, { now: NOW, appointments: [] });
  assert.equal(r.candidates.length, 0);
  assert.match(r.notes.join(' '), /адрес/i);
});

test('shiftLab передаёт appointmentId и moId записи', async () => {
  const api = fakeApi([['getDoctorsInfoForLI', { ok: true, json: doctorsLi }], ['getAvailableResourceScheduleInfo', { ok: true, json: schedule }]]);
  const t = createTargets({ api, filters, util });
  const target = { ...labTarget, scenario: 'shiftLab', current: '2026-09-25T12:50:00+03:00',
    source: { appointmentId: 700000000002, moId: 10000001, samplingTypeId: 1 } };
  await t.search(target, { now: NOW, appointments: [] });
  assert.equal(api.calls[0].body.appointmentId, 700000000002);
  assert.equal(api.calls[0].body.assignment.moId, 10000001);
  assert.equal(api.calls[1].body.appointmentId, 700000000002, 'расписание тоже запрашивается в режиме переноса');
});

test('act для bookLab записывает и подтверждает по списку записей', async () => {
  const booked = { payload: { appointment: [ { id: 700000000009, startTime: '2026-09-24T09:00:00', endTime: '2026-09-24T09:15:00', lpuAddress: 'улица Тестовая, д. 2', type: 'BM', toBM: { id: 1, name: 'Взятие венозной крови' } } ] } };
  const api = fakeApi([['createAppointment', { ok: true, json: { payload: {} } }], ['getAppointmentReceptionsByPatient', { ok: true, json: booked }]]);
  const t = createTargets({ api, filters, util });
  const cand = { slot: { startTime: '2026-09-24T09:00:00+03:00', endTime: '2026-09-24T09:15:00+03:00' }, address: 'улица Тестовая, д. 2', resourceId: 200000001, complexResourceId: 300000001 };
  const r = await t.act(labTarget, cand, { now: NOW, appointments: [] });
  assert.equal(r.ok, true);
  assert.equal(r.verified, true);
  assert.equal(r.newAppointment.id, 700000000009);
  assert.deepEqual(Object.keys(api.calls[0].body).sort(), ['availableResourceId', 'complexResourceId', 'endTime', 'startTime']);
});

test('act для переноса повторяет запрос с referralId, если первый отклонён', async () => {
  let shifts = 0;
  const moved = { payload: { appointment: [ { id: 700000000001, startTime: '2026-09-24T09:00:00', endTime: '2026-09-24T09:15:00', lpuAddress: 'улица Тестовая, д. 2', type: 'LDP', toLdp: { ldpTypeId: 599925, ldpTypeName: 'УЗИ' } } ] } };
  const api = fakeApi([
    ['shiftAppointment', () => { shifts++; return shifts === 1 ? { ok: false, status: 400, json: null, explained: { message: 'нет', action: 'retry' } } : { ok: true, json: { payload: {} } }; }],
    ['getAppointmentReceptionsByPatient', { ok: true, json: moved }],
  ]);
  const t = createTargets({ api, filters, util });
  const target = { ...labTarget, scenario: 'shiftLdp', current: '2026-09-30T13:45:00+03:00', source: { appointmentId: 700000000001, referralId: 900000000001, ldpTypeId: 599925 } };
  const cand = { slot: { startTime: '2026-09-24T09:00:00+03:00', endTime: '2026-09-24T09:15:00+03:00' }, address: 'улица Тестовая, д. 2', resourceId: 200000001, complexResourceId: 300000001 };
  const r = await t.act(target, cand, { now: NOW, appointments: [] });
  assert.equal(shifts, 2);
  assert.equal(api.calls[1].body.referralId, 900000000001);
  assert.equal(r.verified, true);
});

test('act сообщает, если ЕМИАС ответил ok, но записи в списке нет', async () => {
  const api = fakeApi([['createAppointment', { ok: true, json: { payload: {} } }], ['getAppointmentReceptionsByPatient', { ok: true, json: { payload: { appointment: [] } } }]]);
  const t = createTargets({ api, filters, util });
  const cand = { slot: { startTime: '2026-09-24T09:00:00+03:00', endTime: '2026-09-24T09:15:00+03:00' }, address: 'улица Тестовая, д. 2', resourceId: 1, complexResourceId: 2 };
  const r = await t.act(labTarget, cand, { now: NOW, appointments: [] });
  assert.equal(r.ok, true);
  assert.equal(r.verified, false);
  assert.match(r.message, /не вижу/i);
});

// ---- Раунд правок 1: тесты на найденные ревью критические и важные замечания ----

test('slot нарушающий minLeadMs отбрасывается фильтром (pickSlots реально применяется)', async () => {
  const api = fakeApi([['getDoctorsInfoForLI', { ok: true, json: doctorsLi }], ['getAvailableResourceScheduleInfo', { ok: true, json: schedule }]]);
  const t = createTargets({ api, filters, util });
  const target = { ...labTarget, minLeadMs: 48 * 3600000 }; // оба слота фикстуры ближе 48 часов от NOW
  const r = await t.search(target, { now: NOW, appointments: [] });
  assert.equal(r.candidates.length, 0);
  assert.ok(r.rejected.length > 0);
  assert.match(r.rejected[0].reason, /скоро/i);
});

test('конфликт по travel time между кампусами убирает все слоты кабинета', async () => {
  const api = fakeApi([['getDoctorsInfoForLI', { ok: true, json: doctorsLi }], ['getAvailableResourceScheduleInfo', { ok: true, json: schedule }]]);
  const t = createTargets({ api, filters, util });
  // Запись в другом кампусе в 09:30-09:45 требует часа на дорогу в обе стороны —
  // под раздачу попадают оба слота фикстуры (09:00 и 10:00).
  const other = { id: 1, startTime: '2026-09-24T09:30:00', endTime: '2026-09-24T09:45:00', lpuAddress: 'улица Другая, д. 5' };
  const r = await t.search(labTarget, { now: NOW, appointments: [other] });
  assert.equal(r.candidates.length, 0);
});

test('shiftLdp ищет через v5/getDoctorsInfo и передаёт appointmentId и referralId в запрос расписания', async () => {
  const api = fakeApi([
    ['v5/saOrchestrator/getDoctorsInfo', { ok: true, json: doctorsV5 }],
    ['getAvailableResourceScheduleInfo', { ok: true, json: schedule }],
  ]);
  const t = createTargets({ api, filters, util });
  const target = { ...labTarget, scenario: 'shiftLdp', current: '2026-09-25T12:50:00+03:00',
    source: { appointmentId: 700000000003, referralId: 900000000002, ldpTypeId: 599925 } };
  const r = await t.search(target, { now: NOW, appointments: [] });
  assert.equal(api.calls[0].path.includes('v5/saOrchestrator/getDoctorsInfo'), true);
  assert.equal(api.calls[0].body.appointmentId, 700000000003);
  assert.equal(api.calls[1].body.appointmentId, 700000000003);
  assert.equal(api.calls[1].body.referralId, 900000000002);
  assert.equal(r.candidates.length, 2);
});

test('без dateTo и deadline горизонт поиска не схлопывается в «только сегодня» (+30 дней)', async () => {
  const api = fakeApi([['getDoctorsInfoForLI', { ok: true, json: doctorsLi }], ['getAvailableResourceScheduleInfo', { ok: true, json: schedule }]]);
  const t = createTargets({ api, filters, util });
  const { dateTo, ...noDateTo } = labTarget;
  await t.search(noDateTo, { now: NOW, appointments: [] });
  const today = util.mskDate(new Date(NOW));
  assert.ok(api.calls[0].body.assignment.period.dateTo > today, 'горизонт должен быть больше одного дня');
});

test('deadline цели используется как горизонт поиска, если dateTo не задан', async () => {
  const api = fakeApi([['getDoctorsInfoForLI', { ok: true, json: doctorsLi }], ['getAvailableResourceScheduleInfo', { ok: true, json: schedule }]]);
  const t = createTargets({ api, filters, util });
  const { dateTo, ...rest } = labTarget;
  const target = { ...rest, deadline: '2026-09-30' };
  await t.search(target, { now: NOW, appointments: [] });
  assert.equal(api.calls[0].body.assignment.period.dateTo, '2026-09-30');
});

test('CRITICAL: несовпадение id кабинета в расписании не подставляет чужой адрес, кабинет пропускается', async () => {
  const scheduleWrongCr = {
    payload: {
      availableResource: {
        id: 200000001, name: 'Кабинет_1',
        complexResource: [{ id: 999999999, name: '1', room: { number: '1', defaultAddress: 'улица Тестовая, д. 2' } }],
      },
      scheduleOfDay: [
        { date: '2026-09-24', scheduleBySlot: [{ complexResourceId: 999999999, cabinetNumber: '1',
          slot: [{ startTime: '2026-09-24T09:00:00+03:00', endTime: '2026-09-24T09:15:00+03:00' }] }] },
      ],
    },
  };
  const api = fakeApi([['getDoctorsInfoForLI', { ok: true, json: doctorsLi }], ['getAvailableResourceScheduleInfo', { ok: true, json: scheduleWrongCr }]]);
  const t = createTargets({ api, filters, util });
  const r = await t.search(labTarget, { now: NOW, appointments: [] });
  assert.equal(r.candidates.length, 0);
  assert.match(r.notes.join(' '), /адрес/i);
});

test('collectResources пропускает notAvailable-кабинеты и дедуплицирует ресурсы по id', async () => {
  const withDupsAndUnavailable = {
    payload: {
      doctorsInfo: [
        {
          lpuId: 10000001, lpuShortName: 'Тестовая больница', defaultAddress: 'улица Тестовая, д. 2',
          availableResources: [
            { id: 200000001, name: 'Кабинет_1', arType: 30, complexResource: [{ id: 300000001, name: '1' }] },
            { id: 200000001, name: 'Кабинет_1_dup', arType: 30, complexResource: [{ id: 300000001, name: '1' }] },
            { id: 200000099, name: 'Кабинет_недоступен', arType: 30, notAvailable: true, complexResource: [{ id: 300000099, name: '1' }] },
          ],
        },
      ],
    },
  };
  const api = fakeApi([['getDoctorsInfoForLI', { ok: true, json: withDupsAndUnavailable }], ['getAvailableResourceScheduleInfo', { ok: true, json: schedule }]]);
  const t = createTargets({ api, filters, util });
  const r = await t.search(labTarget, { now: NOW, appointments: [] });
  // Дубликат по id 200000001 схлопывается в один ресурс (2 слота, не 4), а недоступный
  // кабинет 200000099 вообще не доходит до запроса расписания.
  assert.equal(r.candidates.length, 2);
  assert.equal(api.calls.length, 2);
});

test('onlyIfConflict без конфликта: skipped из filters.pickSlots попадает в notes', async () => {
  const api = fakeApi([['getDoctorsInfoForLI', { ok: true, json: doctorsLi }], ['getAvailableResourceScheduleInfo', { ok: true, json: schedule }]]);
  const t = createTargets({ api, filters, util });
  const target = { ...labTarget, scenario: 'shiftLab', onlyIfConflict: true, current: '2026-09-25T12:50:00+03:00',
    source: { appointmentId: 700000000002, moId: 10000001, samplingTypeId: 1 } };
  const selfAppt = { id: 700000000002, startTime: '2026-09-25T12:50:00+03:00', endTime: '2026-09-25T13:05:00+03:00', lpuAddress: 'улица Тестовая, д. 2' };
  const r = await t.search(target, { now: NOW, appointments: [selfAppt] });
  assert.equal(r.candidates.length, 0);
  assert.match(r.notes.join(' '), /конфликт/i);
});

test('search для неподдерживаемого сценария не делает сетевых запросов', async () => {
  const api = fakeApi([]);
  const t = createTargets({ api, filters, util });
  const target = { ...labTarget, scenario: 'bookReferral', source: { referralId: 1 } };
  const r = await t.search(target, { now: NOW, appointments: [] });
  assert.equal(r.candidates.length, 0);
  assert.equal(api.calls.length, 0);
  assert.match(r.notes.join(' '), /не поддерживается/i);
});

test('act для неподдерживаемого сценария не делает сетевых запросов', async () => {
  const api = fakeApi([]);
  const t = createTargets({ api, filters, util });
  const target = { ...labTarget, scenario: 'bookReferral', source: { referralId: 1 } };
  const cand = { slot: { startTime: '2026-09-24T09:00:00+03:00', endTime: '2026-09-24T09:15:00+03:00' }, address: 'улица Тестовая, д. 2', resourceId: 1, complexResourceId: 2 };
  const r = await t.act(target, cand, { now: NOW, appointments: [] });
  assert.equal(r.ok, false);
  assert.equal(api.calls.length, 0);
});

test('act для bookLab не засчитывает запись, чей id уже был в списке до брони', async () => {
  const stale = { id: 700000000009, startTime: '2026-09-24T09:00:00', endTime: '2026-09-24T09:15:00', lpuAddress: 'улица Тестовая, д. 2', type: 'BM', toBM: { id: 1, name: 'Взятие венозной крови' } };
  const api = fakeApi([['createAppointment', { ok: true, json: { payload: {} } }], ['getAppointmentReceptionsByPatient', { ok: true, json: { payload: { appointment: [stale] } } }]]);
  const t = createTargets({ api, filters, util });
  const cand = { slot: { startTime: '2026-09-24T09:00:00+03:00', endTime: '2026-09-24T09:15:00+03:00' }, address: 'улица Тестовая, д. 2', resourceId: 200000001, complexResourceId: 300000001 };
  const r = await t.act(labTarget, cand, { now: NOW, appointments: [stale] });
  assert.equal(r.verified, false);
});

test('act проверяет адрес найденной записи — чужой кампус не считается совпадением', async () => {
  const wrongAddr = { id: 700000000001, startTime: '2026-09-24T09:00:00', endTime: '2026-09-24T09:15:00', lpuAddress: 'улица Другая, д. 5', type: 'LDP', toLdp: { ldpTypeId: 599925, ldpTypeName: 'УЗИ' } };
  const api = fakeApi([['shiftAppointment', { ok: true, json: { payload: {} } }], ['getAppointmentReceptionsByPatient', { ok: true, json: { payload: { appointment: [wrongAddr] } } }]]);
  const t = createTargets({ api, filters, util });
  const target = { ...labTarget, scenario: 'shiftLdp', current: '2026-09-30T13:45:00+03:00', source: { appointmentId: 700000000001, ldpTypeId: 599925 } };
  const cand = { slot: { startTime: '2026-09-24T09:00:00+03:00', endTime: '2026-09-24T09:15:00+03:00' }, address: 'улица Тестовая, д. 2', resourceId: 200000001, complexResourceId: 300000001 };
  const r = await t.act(target, cand, { now: NOW, appointments: [] });
  assert.equal(r.verified, false);
});

test('act для shiftLab не засчитывает запись с другим видом анализа', async () => {
  const wrongType = { id: 700000000002, startTime: '2026-09-24T09:00:00', endTime: '2026-09-24T09:15:00', lpuAddress: 'улица Тестовая, д. 2', type: 'BM', toBM: { id: 2, name: 'Другой анализ' } };
  const api = fakeApi([['shiftAppointment', { ok: true, json: { payload: {} } }], ['getAppointmentReceptionsByPatient', { ok: true, json: { payload: { appointment: [wrongType] } } }]]);
  const t = createTargets({ api, filters, util });
  const target = { ...labTarget, scenario: 'shiftLab', source: { appointmentId: 700000000002, moId: 10000001, samplingTypeId: 1 } };
  const cand = { slot: { startTime: '2026-09-24T09:00:00+03:00', endTime: '2026-09-24T09:15:00+03:00' }, address: 'улица Тестовая, д. 2', resourceId: 200000001, complexResourceId: 300000001 };
  const r = await t.act(target, cand, { now: NOW, appointments: [] });
  assert.equal(r.verified, false);
});

test('act сообщает понятную причину и action, если слот исчез между поиском и записью', async () => {
  const api = fakeApi([['createAppointment', { ok: false, status: 409, json: null, explained: { message: 'Слот уже занят', action: 'retry' } }]]);
  const t = createTargets({ api, filters, util });
  const cand = { slot: { startTime: '2026-09-24T09:00:00+03:00', endTime: '2026-09-24T09:15:00+03:00' }, address: 'улица Тестовая, д. 2', resourceId: 200000001, complexResourceId: 300000001 };
  const r = await t.act(labTarget, cand, { now: NOW, appointments: [] });
  assert.equal(r.ok, false);
  assert.match(r.message, /слот уже занят/i);
  assert.equal(r.action, 'retry');
  // При обычном бизнес-отказе (409, не 0/5xx) список записей перечитывать не нужно —
  // если бы код попытался, fakeApi бросил бы «нет обработчика».
  assert.equal(api.calls.length, 1);
});

test('act при сетевом сбое (status 0) не шлёт повтор с referralId, но перепроверяет список — перенос мог пройти', async () => {
  const moved = { id: 700000000005, startTime: '2026-09-24T09:00:00', endTime: '2026-09-24T09:15:00', lpuAddress: 'улица Тестовая, д. 2', type: 'LDP', toLdp: { ldpTypeId: 599925, ldpTypeName: 'УЗИ' } };
  const api = fakeApi([
    ['shiftAppointment', { ok: false, status: 0, json: null, explained: { message: 'Нет связи с ЕМИАС — попробую позже.', action: 'wait' } }],
    ['getAppointmentReceptionsByPatient', { ok: true, json: { payload: { appointment: [moved] } } }],
  ]);
  const t = createTargets({ api, filters, util });
  const target = { ...labTarget, scenario: 'shiftLdp', current: '2026-09-30T13:45:00+03:00', source: { appointmentId: 700000000005, referralId: 900000000005, ldpTypeId: 599925 } };
  const cand = { slot: { startTime: '2026-09-24T09:00:00+03:00', endTime: '2026-09-24T09:15:00+03:00' }, address: 'улица Тестовая, д. 2', resourceId: 200000001, complexResourceId: 300000001 };
  const r = await t.act(target, cand, { now: NOW, appointments: [] });
  assert.equal(api.calls.filter((c) => c.path.includes('shiftAppointment')).length, 1, 'не должно быть повторного запроса при status 0');
  assert.equal(r.ok, true);
  assert.equal(r.verified, true);
  assert.equal(r.newAppointment.id, 700000000005);
});

test('act: после успешной мутации список записей недоступен → verifyFailed, а не «записи нет»', async () => {
  const api = fakeApi([
    ['createAppointment', { ok: true, json: { payload: {} } }],
    ['getAppointmentReceptionsByPatient', { ok: false, status: 500, json: null, explained: { message: 'сбой', action: 'wait' } }],
  ]);
  const t = createTargets({ api, filters, util });
  const cand = { slot: { startTime: '2026-09-24T09:00:00+03:00', endTime: '2026-09-24T09:15:00+03:00' }, address: 'улица Тестовая, д. 2', resourceId: 200000001, complexResourceId: 300000001 };
  const r = await t.act(labTarget, cand, { now: NOW, appointments: [] });
  assert.equal(r.ok, true);
  assert.equal(r.verified, false);
  assert.equal(r.verifyFailed, true);
});

test('act: чтение списка после успешной мутации бросает исключение (повторный 401) — act не падает', async () => {
  const api = fakeApi([
    ['createAppointment', { ok: true, json: { payload: {} } }],
    ['getAppointmentReceptionsByPatient', () => { throw new Error('сессия не продлевается'); }],
  ]);
  const t = createTargets({ api, filters, util });
  const cand = { slot: { startTime: '2026-09-24T09:00:00+03:00', endTime: '2026-09-24T09:15:00+03:00' }, address: 'улица Тестовая, д. 2', resourceId: 200000001, complexResourceId: 300000001 };
  const r = await t.act(labTarget, cand, { now: NOW, appointments: [] });
  assert.equal(r.ok, true);
  assert.equal(r.verified, false);
  assert.equal(r.verifyFailed, true);
});

test('search передаёт action из последнего неуспешного ответа расписания', async () => {
  const api = fakeApi([
    ['getDoctorsInfoForLI', { ok: true, json: doctorsLi }],
    ['getAvailableResourceScheduleInfo', { ok: false, status: 429, json: null, explained: { message: 'подождите', action: 'wait' } }],
  ]);
  const t = createTargets({ api, filters, util });
  const r = await t.search(labTarget, { now: NOW, appointments: [] });
  assert.equal(r.candidates.length, 0);
  assert.equal(r.action, 'wait');
});

test('search передаёт action, если список кабинетов недоступен', async () => {
  const api = fakeApi([['getDoctorsInfoForLI', { ok: false, status: 401, json: null, explained: { message: 'вход истёк', action: 'relogin' } }]]);
  const t = createTargets({ api, filters, util });
  const r = await t.search(labTarget, { now: NOW, appointments: [] });
  assert.equal(r.candidates.length, 0);
  assert.equal(r.action, 'relogin');
});

// ---- Task 12b: bookDoctor — новая запись к врачу по направлению ----

const doctorTarget = {
  id: 'ref:900000000002', scenario: 'bookDoctor', addressContains: null,
  minLeadMs: 2 * 3600000, travelMs: 3600000, respectTravel: true, dateTo: '2026-10-13',
  source: { referralId: 900000000002, lpuId: 10000003, specialityId: 10, needPurpose: true, availableResourceId: null },
};

test('bookDoctor ищет через v5/getDoctorsInfo с referralId, без appointmentId и purposeReceptionForm', async () => {
  const api = fakeApi([
    ['v5/saOrchestrator/getDoctorsInfo', { ok: true, json: doctorsV5 }],
    ['getAvailableResourceScheduleInfo', { ok: true, json: schedule }],
  ]);
  const t = createTargets({ api, filters, util });
  const target = { ...doctorTarget, purpose: { inquiryPurposeId: 61, inquiryPurposeCode: 251 } };
  const r = await t.search(target, { now: NOW, appointments: [] });
  assert.equal(api.calls[0].path, 'v5/saOrchestrator/getDoctorsInfo');
  assert.deepEqual(api.calls[0].body, { referralId: 900000000002 });
  assert.equal(r.candidates.length, 2);
});

test('bookDoctor: запрос расписания содержит availableResourceId, complexResourceId, referralId и inquiryPurposeId, если цель визита выбрана', async () => {
  const api = fakeApi([
    ['v5/saOrchestrator/getDoctorsInfo', { ok: true, json: doctorsV5 }],
    ['getAvailableResourceScheduleInfo', { ok: true, json: schedule }],
  ]);
  const t = createTargets({ api, filters, util });
  const target = { ...doctorTarget, purpose: { inquiryPurposeId: 61, inquiryPurposeCode: 251 } };
  await t.search(target, { now: NOW, appointments: [] });
  assert.deepEqual(Object.keys(api.calls[1].body).sort(), ['availableResourceId', 'complexResourceId', 'inquiryPurposeId', 'period', 'referralId']);
  assert.equal(api.calls[1].body.availableResourceId, 200000002);
  assert.equal(api.calls[1].body.referralId, 900000000002);
  assert.equal(api.calls[1].body.inquiryPurposeId, 61);
});

test('bookDoctor: без выбранной цели визита запрос расписания не содержит inquiryPurposeId', async () => {
  const api = fakeApi([
    ['v5/saOrchestrator/getDoctorsInfo', { ok: true, json: doctorsV5 }],
    ['getAvailableResourceScheduleInfo', { ok: true, json: schedule }],
  ]);
  const t = createTargets({ api, filters, util });
  const target = { ...doctorTarget, source: { ...doctorTarget.source, needPurpose: false } };
  await t.search(target, { now: NOW, appointments: [] });
  assert.deepEqual(Object.keys(api.calls[1].body).sort(), ['availableResourceId', 'complexResourceId', 'period', 'referralId']);
});

test('bookDoctor: если в source задан availableResourceId, остаётся только этот ресурс', async () => {
  const api = fakeApi([
    ['v5/saOrchestrator/getDoctorsInfo', { ok: true, json: doctorsV5Multi }],
    ['getAvailableResourceScheduleInfo', { ok: true, json: schedule }],
  ]);
  const t = createTargets({ api, filters, util });
  const target = { ...doctorTarget, source: { ...doctorTarget.source, needPurpose: false, availableResourceId: 200000006 } };
  await t.search(target, { now: NOW, appointments: [] });
  // Один ресурс — один запрос расписания (второй, notAvailable-подобный, не запрошен).
  assert.equal(api.calls.length, 2);
  assert.equal(api.calls[1].body.availableResourceId, 200000006);
});

test('bookDoctor: needPurpose и нет выбранной цели визита → пустые кандидаты, понятная заметка, сети нет', async () => {
  const api = fakeApi([]);
  const t = createTargets({ api, filters, util });
  const r = await t.search(doctorTarget, { now: NOW, appointments: [] });
  assert.equal(r.candidates.length, 0);
  assert.equal(api.calls.length, 0, 'act и даже поиск кабинетов не должны были вызываться');
  assert.match(r.notes.join(' '), /цель визита/i);
});

// ---- C2: 429 при переборе кабинетов/врачей не должен долбить ЕМИАС дальше в этом же поиске ----

test('C2: 429 на первом запросе расписания останавливает перебор остальных кабинетов в этом поиске', async () => {
  let backoffUntil = 0;
  let scheduleCalls = 0;
  const api = {
    calls: [],
    backoffUntil: () => backoffUntil,
    post: async (path, body) => {
      api.calls.push({ path, body });
      if (path.includes('v5/saOrchestrator/getDoctorsInfo')) return { ok: true, json: doctorsV5Multi };
      if (path.includes('getAvailableResourceScheduleInfo')) {
        scheduleCalls++;
        backoffUntil = NOW + 30000; // как реальный api.js при 429/5xx
        return { ok: false, status: 429, json: null, explained: { message: 'ЕМИАС просит не частить — пауза 30 секунд.', action: 'wait' } };
      }
      throw new Error('нет обработчика для ' + path);
    },
  };
  const t = createTargets({ api, filters, util });
  const target = { ...doctorTarget, source: { ...doctorTarget.source, needPurpose: false } };
  const r = await t.search(target, { now: NOW, appointments: [] });
  // doctorsV5Multi отдаёт ДВА ресурса — без гейта по backoff ушло бы два запроса расписания.
  assert.equal(scheduleCalls, 1, 'после 429 второй запрос расписания в этом же поиске уходить не должен');
  assert.equal(r.candidates.length, 0);
});

test('act для bookDoctor шлёт createAppointment с availableResourceId/complexResourceId/startTime/endTime/referralId и целью визита', async () => {
  const booked = { payload: { appointment: [
    { id: 700000000020, startTime: '2026-09-24T09:00:00', endTime: '2026-09-24T09:15:00', lpuAddress: 'улица Тестовая, д. 2', type: 'DOCTOR', toDoctor: { specialityName: 'Врач-эндокринолог' } },
  ] } };
  const api = fakeApi([['createAppointment', { ok: true, json: { payload: {} } }], ['getAppointmentReceptionsByPatient', { ok: true, json: booked }]]);
  const t = createTargets({ api, filters, util });
  const target = { ...doctorTarget, purpose: { inquiryPurposeId: 61, inquiryPurposeCode: 251 } };
  const cand = { slot: { startTime: '2026-09-24T09:00:00+03:00', endTime: '2026-09-24T09:15:00+03:00' }, address: 'улица Тестовая, д. 2', resourceId: 200000002, complexResourceId: 300000001 };
  const r = await t.act(target, cand, { now: NOW, appointments: [] });
  assert.equal(r.ok, true);
  assert.equal(r.verified, true);
  assert.equal(r.newAppointment.id, 700000000020);
  assert.deepEqual(Object.keys(api.calls[0].body).sort(), ['availableResourceId', 'complexResourceId', 'endTime', 'inquiryPurposeCode', 'inquiryPurposeId', 'referralId', 'startTime']);
  assert.equal(api.calls[0].body.referralId, 900000000002);
  assert.equal(api.calls[0].body.inquiryPurposeCode, 251);
});

test('act для bookDoctor без цели визита не добавляет inquiryPurpose* в тело createAppointment', async () => {
  const booked = { payload: { appointment: [
    { id: 700000000021, startTime: '2026-09-24T09:00:00', endTime: '2026-09-24T09:15:00', lpuAddress: 'улица Тестовая, д. 2', type: 'DOCTOR', toDoctor: { specialityName: 'Врач-невролог' } },
  ] } };
  const api = fakeApi([['createAppointment', { ok: true, json: { payload: {} } }], ['getAppointmentReceptionsByPatient', { ok: true, json: booked }]]);
  const t = createTargets({ api, filters, util });
  const target = { ...doctorTarget, source: { ...doctorTarget.source, needPurpose: false, referralId: 900000000003 } };
  const cand = { slot: { startTime: '2026-09-24T09:00:00+03:00', endTime: '2026-09-24T09:15:00+03:00' }, address: 'улица Тестовая, д. 2', resourceId: 200000005, complexResourceId: 300000005 };
  const r = await t.act(target, cand, { now: NOW, appointments: [] });
  assert.equal(r.verified, true);
  assert.deepEqual(Object.keys(api.calls[0].body).sort(), ['availableResourceId', 'complexResourceId', 'endTime', 'referralId', 'startTime']);
});

test('act для bookDoctor не засчитывает запись, чей id уже был в списке до брони', async () => {
  const stale = { id: 700000000020, startTime: '2026-09-24T09:00:00', endTime: '2026-09-24T09:15:00', lpuAddress: 'улица Тестовая, д. 2', type: 'DOCTOR', toDoctor: { specialityName: 'Врач-эндокринолог' } };
  const api = fakeApi([['createAppointment', { ok: true, json: { payload: {} } }], ['getAppointmentReceptionsByPatient', { ok: true, json: { payload: { appointment: [stale] } } }]]);
  const t = createTargets({ api, filters, util });
  const cand = { slot: { startTime: '2026-09-24T09:00:00+03:00', endTime: '2026-09-24T09:15:00+03:00' }, address: 'улица Тестовая, д. 2', resourceId: 200000002, complexResourceId: 300000001 };
  const r = await t.act(doctorTarget, cand, { now: NOW, appointments: [stale] });
  assert.equal(r.verified, false);
});

// ---- bookLdp — новая запись по направлению на исследование (УЗИ, ЭКГ…) ----
// По образцу bookDoctor, но без цели визита и без выбора врача.

const ldpTarget = {
  id: 'ref:900000000004', scenario: 'bookLdp', addressContains: null,
  minLeadMs: 2 * 3600000, travelMs: 3600000, respectTravel: true, dateTo: '2026-10-05',
  source: { referralId: 900000000004, lpuId: 10000002, ldpTypeId: 599930 },
};

test('bookLdp ищет через v5/getDoctorsInfo с referralId, расписание — с referralId, без appointmentId и цели визита', async () => {
  const api = fakeApi([
    ['v5/saOrchestrator/getDoctorsInfo', { ok: true, json: doctorsV5 }],
    ['getAvailableResourceScheduleInfo', { ok: true, json: schedule }],
  ]);
  const t = createTargets({ api, filters, util });
  const r = await t.search(ldpTarget, { now: NOW, appointments: [] });
  assert.equal(api.calls[0].path, 'v5/saOrchestrator/getDoctorsInfo');
  assert.deepEqual(api.calls[0].body, { referralId: 900000000004 });
  assert.deepEqual(Object.keys(api.calls[1].body).sort(), ['availableResourceId', 'complexResourceId', 'period', 'referralId']);
  assert.equal(api.calls[1].body.referralId, 900000000004);
  assert.equal(r.candidates.length, 2);
});

test('act для bookLdp шлёт createAppointment с referralId и засчитывает новую запись того же вида исследования', async () => {
  const booked = { payload: { appointment: [
    { id: 700000000030, startTime: '2026-09-24T09:00:00', endTime: '2026-09-24T09:15:00', lpuAddress: 'улица Тестовая, д. 2', type: 'LDP', toLdp: { ldpTypeId: 599930, ldpTypeName: 'Электрокардиография' } },
  ] } };
  const api = fakeApi([['createAppointment', { ok: true, json: { payload: {} } }], ['getAppointmentReceptionsByPatient', { ok: true, json: booked }]]);
  const t = createTargets({ api, filters, util });
  const cand = { slot: { startTime: '2026-09-24T09:00:00+03:00', endTime: '2026-09-24T09:15:00+03:00' }, address: 'улица Тестовая, д. 2', resourceId: 200000002, complexResourceId: 300000001 };
  const r = await t.act(ldpTarget, cand, { now: NOW, appointments: [] });
  assert.equal(api.calls[0].path, 'v4/saOrchestrator/createAppointment');
  assert.deepEqual(Object.keys(api.calls[0].body).sort(), ['availableResourceId', 'complexResourceId', 'endTime', 'referralId', 'startTime']);
  assert.equal(api.calls[0].body.referralId, 900000000004);
  assert.equal(r.verified, true);
  assert.equal(r.newAppointment.id, 700000000030);
});

test('act для bookLdp не засчитывает запись другого вида исследования в то же время', async () => {
  const other = { payload: { appointment: [
    { id: 700000000031, startTime: '2026-09-24T09:00:00', endTime: '2026-09-24T09:15:00', lpuAddress: 'улица Тестовая, д. 2', type: 'LDP', toLdp: { ldpTypeId: 599925, ldpTypeName: 'УЗИ' } },
  ] } };
  const api = fakeApi([['createAppointment', { ok: true, json: { payload: {} } }], ['getAppointmentReceptionsByPatient', { ok: true, json: other }]]);
  const t = createTargets({ api, filters, util });
  const cand = { slot: { startTime: '2026-09-24T09:00:00+03:00', endTime: '2026-09-24T09:15:00+03:00' }, address: 'улица Тестовая, д. 2', resourceId: 200000002, complexResourceId: 300000001 };
  const r = await t.act(ldpTarget, cand, { now: NOW, appointments: [] });
  assert.equal(r.verified, false);
});

test('bookDoctor не считается переносом: isShift не подставляет appointmentId в запросы', async () => {
  const api = fakeApi([
    ['v5/saOrchestrator/getDoctorsInfo', { ok: true, json: doctorsV5 }],
    ['getAvailableResourceScheduleInfo', { ok: true, json: schedule }],
  ]);
  const t = createTargets({ api, filters, util });
  const target = { ...doctorTarget, source: { ...doctorTarget.source, needPurpose: false } };
  await t.search(target, { now: NOW, appointments: [] });
  assert.equal('appointmentId' in api.calls[0].body, false);
  assert.equal('appointmentId' in api.calls[1].body, false);
});
