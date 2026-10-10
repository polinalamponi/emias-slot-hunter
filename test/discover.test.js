const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createDiscover } = require('../core/discover.js');
const referrals = require('./fixtures/referrals.json');
const appointments = require('./fixtures/appointments.json');

const api = {
  post: async (path) => {
    if (path.includes('getAssignmentsReferralsInfo')) return { ok: true, json: referrals };
    if (path.includes('getAppointmentReceptionsByPatient')) return { ok: true, json: appointments };
    throw new Error('неожиданный путь: ' + path);
  },
};

test('находит запись на кровь как цель переноса и направление как цель записи', async () => {
  const list = await createDiscover({ api }).list();
  const lab = list.find((o) => o.scenario === 'shiftLab');
  assert.equal(lab.source.appointmentId, 700000000002);
  assert.equal(lab.source.moId, 10000001, 'moId для переноса = lpuId записи');
  assert.equal(lab.current, '2026-09-25T12:50:00+03:00');
  assert.ok(list.every((o) => o.scenario !== 'bookLab'), 'пока есть активная запись, повторной записи не предлагаем');
});

test('исследование и приём врача становятся целями переноса', async () => {
  const list = await createDiscover({ api }).list();
  const ldp = list.find((o) => o.scenario === 'shiftLdp');
  assert.equal(ldp.source.appointmentId, 700000000001);
  assert.equal(ldp.source.ldpTypeId, 599925);
  assert.equal(ldp.source.referralId, 900000000001);
  const doc = list.find((o) => o.scenario === 'shiftDoctor');
  assert.equal(doc.source.appointmentId, 700000000003);
  assert.match(doc.title, /эндокринолог/i);
});

test('направление на исследование (toLdp) без записи становится целью bookLdp', async () => {
  const list = await createDiscover({ api }).list();
  const ref = list.find((o) => o.id === 'ref:900000000004');
  assert.equal(ref.scenario, 'bookLdp');
  assert.equal(ref.supported, true);
  assert.equal(ref.title, 'Электрокардиография');
  assert.deepEqual(ref.source, { referralId: 900000000004, lpuId: 10000002, ldpTypeId: 599930 });
});

test('направление к врачу без записи (needPurpose: true) становится целью bookDoctor', async () => {
  const list = await createDiscover({ api }).list();
  const ref = list.find((o) => o.id === 'ref:900000000002');
  assert.equal(ref.scenario, 'bookDoctor');
  assert.equal(ref.title, 'Врач-эндокринолог');
  assert.equal(ref.current, null);
  assert.equal(ref.address, 'Тестовая поликлиника');
  assert.equal(ref.deadline, '2026-10-13');
  assert.equal(ref.supported, true);
  assert.equal(ref.unsupportedReason, null);
  assert.deepEqual(ref.source, {
    referralId: 900000000002, lpuId: 10000003, specialityId: 10, needPurpose: true, availableResourceId: null,
  });
});

test('направление к конкретному врачу без записи (needPurpose: false, availableResourceId) становится целью bookDoctor с ФИО в названии', async () => {
  const list = await createDiscover({ api }).list();
  const ref = list.find((o) => o.id === 'ref:900000000003');
  assert.equal(ref.scenario, 'bookDoctor');
  assert.equal(ref.title, 'Врач-невролог — Петров П.П.');
  assert.deepEqual(ref.source, {
    referralId: 900000000003, lpuId: 10000004, specialityId: 11, needPurpose: false, availableResourceId: 200000005,
  });
});

test('направление на кровь без записи даёт цель bookLab', async () => {
  const noAppts = { payload: { appointment: [] } };
  const api2 = { post: async (p) => (p.includes('Referrals') ? { ok: true, json: referrals } : { ok: true, json: noAppts }) };
  const list = await createDiscover({ api: api2 }).list();
  const book = list.find((o) => o.scenario === 'bookLab');
  assert.equal(book.source.moId, 10000001);
  assert.equal(book.source.samplingTypeId, 1);
  assert.equal(book.deadline, '2026-10-14');
  assert.equal(book.supported, true);
});

// Живой ЕМИАС (проверено 2026-09-24) отдаёт assignments не массивом, а
// объектом { items: [...], count } — так же, как referrals. На массив
// рассчитывал только тестовый фикстур, и мастер падал с «object is not iterable».
function apiWithRealShape(assignmentItems) {
  return {
    post: async (path) => {
      if (path.includes('getAssignmentsReferralsInfo')) {
        return { ok: true, json: { payload: { arInfo: {
          referrals: { items: [
            { id: 900000000009, type: 'REF_TO_DOCTOR', startTime: '2026-09-14', endTime: '2026-10-13',
              lpuId: 10000003, lpuName: 'Тестовая поликлиника',
              toDoctor: { specialityId: 10, specialityName: 'Врач-эндокринолог' },
              countActiveAppointment: 0, needPurpose: false },
          ] },
          assignments: { items: assignmentItems, count: assignmentItems.length },
        } } } };
      }
      // Записей нет — ЕМИАС отвечает 204 с пустым телом (api.js даёт json: null).
      if (path.includes('getAppointmentReceptionsByPatient')) return { ok: true, status: 204, json: null };
      throw new Error('неожиданный путь: ' + path);
    },
  };
}

test('assignments в живом формате { items, count } и пустой — мастер не падает, направления к врачу видны', async () => {
  const list = await createDiscover({ api: apiWithRealShape([]) }).list();
  assert.equal(list.filter((o) => o.scenario === 'bookDoctor').length, 1);
  assert.equal(list.filter((o) => o.scenario === 'bookLab').length, 0);
});

test('assignments в живом формате { items, count } с анализом — предлагается запись на анализ', async () => {
  const list = await createDiscover({ api: apiWithRealShape([
    { moId: 10000001, moName: 'Клиника А', toBM: { id: 1, name: 'Взятие венозной крови' },
      period: { dateFrom: '2026-09-14', dateTo: '2026-10-14' }, active: true, appointmentAvailable: true },
  ]) }).list();
  const book = list.find((o) => o.scenario === 'bookLab');
  assert.ok(book);
  assert.equal(book.source.moId, 10000001);
  assert.equal(book.source.samplingTypeId, 1);
});

// IMPORTANT 4: новые тесты
test('два направления на один анализ в разных moId, активная запись в одном → второй остаётся целью', async () => {
  const api2 = {
    post: async (path) => {
      if (path.includes('getAssignmentsReferralsInfo')) {
        return { ok: true, json: {
          payload: {
            arInfo: {
              assignments: [
                { moId: 10000001, moName: 'Клиника А', toBM: { id: 1, name: 'Взятие венозной крови' },
                  period: { dateFrom: '2026-09-14', dateTo: '2026-10-14' }, active: true, appointmentAvailable: true },
                { moId: 10000004, moName: 'Клиника Б', toBM: { id: 1, name: 'Взятие венозной крови' },
                  period: { dateFrom: '2026-09-14', dateTo: '2026-10-14' }, active: true, appointmentAvailable: true }
              ],
              referrals: { items: [] },
              count: 2
            }
          }
        } };
      }
      if (path.includes('getAppointmentReceptionsByPatient')) {
        return { ok: true, json: {
          payload: {
            appointment: [
              { id: 700000000002, startTime: '2026-09-25T12:50:00', type: 'BM', lpuId: 10000001, lpuAddress: 'ул. А', enableShift: true,
                toBM: { id: 1, name: 'Взятие венозной крови' } }
            ]
          }
        } };
      }
      throw new Error('неожиданный путь: ' + path);
    }
  };
  const list = await createDiscover({ api: api2 }).list();
  const shiftLab = list.filter((o) => o.scenario === 'shiftLab');
  const bookLab = list.filter((o) => o.scenario === 'bookLab');
  assert.equal(shiftLab.length, 1, 'одна запись на перенос в клинике А');
  assert.equal(bookLab.length, 1, 'одно направление на новую запись в клинике Б');
  assert.equal(bookLab[0].source.moId, 10000004);
});

test('запись без startTime → current === null', async () => {
  const noStartTime = { payload: { appointment: [
    { id: 700000000004, type: 'BM', lpuId: 10000001, lpuAddress: 'ул. Тестовая', enableShift: true,
      toBM: { id: 1, name: 'Анализ' } }
  ] } };
  const api2 = { post: async (p) => (p.includes('getAppointmentReceptionsByPatient') ? { ok: true, json: noStartTime } : { ok: true, json: { payload: { arInfo: {} } } }) };
  const list = await createDiscover({ api: api2 }).list();
  const appt = list.find((o) => o.id === 'appt:700000000004');
  assert.ok(appt, 'запись найдена в списке');
  assert.equal(appt.current, null);
  assert.ok(list.length > 0, 'модуль не падает при отсутствии startTime');
});

test('пустой payload → пустой список, без исключения', async () => {
  const api2 = { post: async () => ({ ok: true, json: { payload: {} } }) };
  const list = await createDiscover({ api: api2 }).list();
  assert.equal(list.length, 0);
});

test('запись с enableShift: false → supported === false', async () => {
  const noShift = { payload: { appointment: [
    { id: 700000000005, startTime: '2026-09-25T12:50:00', type: 'BM', lpuId: 10000001, lpuAddress: 'ул. Тестовая', enableShift: false,
      toBM: { id: 1, name: 'Анализ' } }
  ] } };
  const api2 = { post: async (p) => (p.includes('getAppointmentReceptionsByPatient') ? { ok: true, json: noShift } : { ok: true, json: { payload: { arInfo: {} } } }) };
  const list = await createDiscover({ api: api2 }).list();
  const appt = list.find((o) => o.id === 'appt:700000000005');
  assert.ok(appt, 'запись найдена в списке');
  assert.equal(appt.supported, false);
  assert.match(appt.unsupportedReason, /ЕМИАС не разрешает/);
});

test('api.post вернул ok: false → list() бросает Error', async () => {
  const api2 = { post: async () => ({ ok: false, explained: { message: 'Сервис недоступен' } }) };
  try {
    await createDiscover({ api: api2 }).list();
    assert.fail('должно было выбросить ошибку');
  } catch (e) {
    assert.match(e.message, /Сервис недоступен/);
  }
});

test('api.post вернул ok: false без explained → Error с дефолтным текстом', async () => {
  const api2 = { post: async () => ({ ok: false }) };
  try {
    await createDiscover({ api: api2 }).list();
    assert.fail('должно было выбросить ошибку');
  } catch (e) {
    assert.match(e.message, /Не удалось получить данные/);
  }
});

// На живом сайте приём врача без направления (терапевт, гинеколог) не нашёлся
// в мастере: тип записи у него, видимо, не 'DOCTOR'. Определяем вид записи по
// содержимому (toDoctor/toLdp/toBM), а непонятную запись показываем серой.
test('приём врача с другим type (или без type) всё равно становится целью переноса', async () => {
  const appts = { payload: { appointment: [
    { id: 700000000011, startTime: '2026-10-19T08:30:00', type: 'RECEPTION', lpuId: 10000003, lpuAddress: 'улица Тестовая, д. 3', enableShift: true,
      toDoctor: { specialityId: 12, specialityName: 'Врач-акушер-гинеколог' } },
    { id: 700000000012, startTime: '2026-10-16T11:45:00', lpuId: 10000003, lpuAddress: 'улица Тестовая, д. 3', enableShift: true,
      toDoctor: { specialityId: 13, specialityName: 'Врач-терапевт участковый' } },
  ] } };
  const api2 = { post: async (p) => (p.includes('getAppointmentReceptionsByPatient') ? { ok: true, json: appts } : { ok: true, json: { payload: { arInfo: {} } } }) };
  const list = await createDiscover({ api: api2 }).list();
  const docs = list.filter((o) => o.scenario === 'shiftDoctor');
  assert.deepEqual(docs.map((o) => o.title), ['Врач-акушер-гинеколог', 'Врач-терапевт участковый']);
  assert.ok(docs.every((o) => o.supported));
});

test('запись непонятного вида не пропадает молча, а показывается неподдерживаемой', async () => {
  const appts = { payload: { appointment: [
    { id: 700000000013, startTime: '2026-10-20T10:00:00', type: 'SOMETHING_NEW', lpuId: 10000003, lpuAddress: 'улица Тестовая, д. 3', enableShift: true },
  ] } };
  const api2 = { post: async (p) => (p.includes('getAppointmentReceptionsByPatient') ? { ok: true, json: appts } : { ok: true, json: { payload: { arInfo: {} } } }) };
  const list = await createDiscover({ api: api2 }).list();
  const appt = list.find((o) => o.id === 'appt:700000000013');
  assert.ok(appt, 'запись есть в списке');
  assert.equal(appt.supported, false);
  assert.equal(appt.current, '2026-10-20T10:00:00+03:00');
  assert.match(appt.unsupportedReason, /пока не умеет/);
});

test('просроченные направления (на кровь и обычные) в мастер не попадают', async () => {
  const ar = { payload: { arInfo: {
    assignments: { items: [
      { active: true, appointmentAvailable: true, moId: 1, moName: 'Тестовая больница', toBM: { id: 1, name: 'Кровь старая' }, period: { dateTo: '2026-09-24' } },
      { active: true, appointmentAvailable: true, moId: 2, moName: 'Тестовая больница', toBM: { id: 2, name: 'Кровь свежая' }, period: { dateTo: '2026-10-20' } },
    ] },
    referrals: { items: [
      { id: 900000000021, endTime: '2026-10-01', lpuId: 3, countActiveAppointment: 0, toLdp: { ldpTypeId: 1, ldpTypeName: 'УЗИ старое' } },
      { id: 900000000022, endTime: '2026-10-10', lpuId: 3, countActiveAppointment: 0, toLdp: { ldpTypeId: 2, ldpTypeName: 'УЗИ до сегодня' } },
    ] },
  } } };
  const api2 = { post: async (p) => (p.includes('getAssignmentsReferralsInfo') ? { ok: true, json: ar } : { ok: true, json: { payload: {} } }) };
  const list = await createDiscover({ api: api2, today: () => '2026-10-10' }).list();
  assert.deepEqual(list.map((o) => o.title).sort(), ['Кровь свежая', 'УЗИ до сегодня']);
});
