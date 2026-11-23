// test/runner.test.js
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createRunner } = require('../core/runner.js');

function harness(overrides = {}) {
  let t = 1000000;
  const events = [];
  const scheduled = [];
  const targets = {
    search: overrides.search || (async () => ({ candidates: [], rejected: [], notes: [] })),
    act: overrides.act || (async () => ({ ok: true, verified: true, message: 'Готово', newAppointment: { id: 1, startTime: '2026-09-24T09:00:00' } })),
  };
  const api = {
    post: overrides.apiPost || (async () => ({ ok: true, json: { payload: { appointment: [] } } })),
    backoffUntil: overrides.backoffUntil || (() => 0),
  };
  const runner = createRunner({
    targets,
    api,
    session: overrides.session || { needsRefresh: () => false, refresh: async () => true, refreshedAt: 0 },
    timer: { schedule: (ms, fn) => scheduled.push({ ms, fn }), cancel: () => scheduled.splice(0) },
    now: () => t,
    emit: (type, payload) => events.push({ type, payload }),
    config: { slowMs: 30000, minIntervalMs: 30000, refreshAt: 0.6, sleepFactor: 3, staleFactor: 3 },
  });
  return { runner, events, scheduled, api, advance: (ms) => { t += ms; }, at: () => t };
}

const target = { id: 'lab', scenario: 'bookLab', title: 'Кровь', mode: 'auto', source: { moId: 1, samplingTypeId: 1 } };
const cand = { slot: { startTime: '2026-09-24T09:00:00+03:00', endTime: '2026-09-24T09:15:00+03:00' }, address: 'улица Тестовая, д. 2', resourceId: 1, complexResourceId: 2 };

function deferred() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}

for (const mode of ['auto', 'confirm']) {
  test(`${mode}: stop() во время поиска не даёт записать слот или запросить подтверждение`, async () => {
    const response = deferred();
    const entered = deferred();
    let delay = false;
    let acted = 0;
    const result = { candidates: [cand], rejected: [], notes: [] };
    const h = harness({
      search: () => { if (!delay) return result; entered.resolve(); return response.promise; },
      act: async () => { acted++; return { ok: true, verified: true }; },
    });
    h.runner.setTargets([{ ...target, mode }]);
    h.runner.confirmDryRun((await h.runner.dryRun()).id);
    await h.runner.start();
    delay = true;
    const tick = h.runner.tick();
    await entered.promise;
    h.runner.stop();
    response.resolve(result);
    await tick;

    assert.equal(acted, 0);
    assert.ok(!h.events.some((e) => e.type === 'needConfirm' || e.type === 'booked'));
    assert.deepEqual(h.runner.status().pending, []);
    assert.equal(h.scheduled.length, 0);
  });
}

test('stop() и новый start() не оживляют старый поиск', async () => {
  const response = deferred();
  const entered = deferred();
  let delay = false;
  let acted = 0;
  const result = { candidates: [cand], rejected: [], notes: [] };
  const h = harness({
    search: () => { if (!delay) return result; entered.resolve(); return response.promise; },
    act: async () => { acted++; return { ok: true, verified: true }; },
  });
  h.runner.setTargets([target]);
  h.runner.confirmDryRun((await h.runner.dryRun()).id);
  await h.runner.start();
  delay = true;
  const oldTick = h.runner.tick();
  await entered.promise;
  h.runner.stop();
  await h.runner.start();
  response.resolve(result);
  await oldTick;

  assert.equal(acted, 0);
  assert.equal(h.runner.status().running, true);
  assert.equal(h.runner.status().lastCheckAt, 0);
  assert.equal(h.scheduled.length, 1, 'старый тик не добавляет таймер новому запуску');
  delay = false;
  await h.runner.tick();
  assert.equal(acted, 1, 'новый запуск продолжает работать');
});

for (const mode of ['auto', 'confirm']) {
  test(`${mode}: остановка при чтении записей перед act() отменяет запись`, async () => {
    const response = deferred();
    const entered = deferred();
    let delay = false;
    let acted = 0;
    const appointments = { ok: true, json: { payload: { appointment: [] } } };
    const h = harness({
      apiPost: () => { if (!delay) return appointments; entered.resolve(); return response.promise; },
      search: async () => {
        if (h.runner.status().running && mode === 'auto') delay = true;
        return { candidates: [cand], rejected: [], notes: [] };
      },
      act: async () => { acted++; return { ok: true, verified: true }; },
    });
    h.runner.setTargets([{ ...target, mode }]);
    h.runner.confirmDryRun((await h.runner.dryRun()).id);
    await h.runner.start();
    const tick = h.runner.tick();
    let work = tick;
    if (mode === 'confirm') {
      await tick;
      delay = true;
      work = h.runner.answer(target.id, 'book');
    }
    await entered.promise;
    h.runner.stop();
    response.resolve(appointments);
    await work;

    assert.equal(acted, 0);
    assert.ok(!h.events.some((e) => e.type === 'booked'));
    assert.equal(h.scheduled.length, 0);
  });
}

test('stop() во время первого чтения записей не запускает поиск', async () => {
  const response = deferred();
  const entered = deferred();
  let delay = false;
  let searched = 0;
  const appointments = { ok: true, json: { payload: { appointment: [] } } };
  const h = harness({
    apiPost: () => { if (!delay) return appointments; entered.resolve(); return response.promise; },
    search: async () => { searched++; return { candidates: [], rejected: [], notes: [] }; },
  });
  h.runner.setTargets([target]);
  h.runner.confirmDryRun((await h.runner.dryRun()).id);
  await h.runner.start();
  searched = 0;
  delay = true;
  const tick = h.runner.tick();
  await entered.promise;
  h.runner.stop();
  response.resolve(appointments);
  await tick;
  assert.equal(searched, 0);
  assert.equal(h.scheduled.length, 0);
});

test('stop() во время обновления сессии не запускает чтение записей', async () => {
  const response = deferred();
  const entered = deferred();
  let reads = 0;
  const h = harness({
    session: { needsRefresh: () => true, refresh: () => { entered.resolve(); return response.promise; }, refreshedAt: 0 },
    apiPost: async () => { reads++; return { ok: true, json: { payload: { appointment: [] } } }; },
  });
  h.runner.setTargets([target]);
  h.runner.confirmDryRun((await h.runner.dryRun()).id);
  await h.runner.start();
  reads = 0;
  const tick = h.runner.tick();
  await entered.promise;
  h.runner.stop();
  response.resolve(true);
  await tick;
  assert.equal(reads, 0);
  assert.equal(h.scheduled.length, 0);
});

test('смена целей во время поиска не даёт записать слот из старого ответа', async () => {
  const response = deferred();
  const entered = deferred();
  let delay = false;
  let acted = 0;
  const result = { candidates: [cand], rejected: [], notes: [] };
  const h = harness({
    search: () => { if (!delay) return result; entered.resolve(); return response.promise; },
    act: async () => { acted++; return { ok: true, verified: true }; },
  });
  h.runner.setTargets([target]);
  h.runner.confirmDryRun((await h.runner.dryRun()).id);
  await h.runner.start();
  delay = true;
  const tick = h.runner.tick();
  await entered.promise;
  h.runner.setTargets([{ ...target, title: 'Другая цель' }]);
  response.resolve(result);
  await tick;
  assert.equal(acted, 0);
  assert.equal(h.runner.status().running, false);
  assert.ok(h.events.some((e) => e.type === 'needDryRun'));
});

test('после stop() и start() старое подтверждение слота не принимается', async () => {
  let acted = 0;
  const h = harness({
    search: async () => ({ candidates: [cand], rejected: [], notes: [] }),
    act: async () => { acted++; return { ok: true, verified: true }; },
  });
  h.runner.setTargets([{ ...target, mode: 'confirm' }]);
  h.runner.confirmDryRun((await h.runner.dryRun()).id);
  await h.runner.start();
  await h.runner.tick();
  h.runner.stop();
  await h.runner.start();
  const res = await h.runner.answer(target.id, 'book');
  assert.equal(res.ok, false);
  assert.equal(acted, 0);
});

test('уже отправленная запись проверяется после stop(), но следующая цель не запускается', async () => {
  const response = deferred();
  const entered = deferred();
  const searched = [];
  const h = harness({
    search: async (t) => { searched.push(t.id); return { candidates: [cand], rejected: [], notes: [] }; },
    act: () => { entered.resolve(); return response.promise; },
  });
  h.runner.setTargets([target, { ...target, id: 'lab2' }]);
  h.runner.confirmDryRun((await h.runner.dryRun()).id);
  await h.runner.start();
  searched.length = 0;
  const tick = h.runner.tick();
  await entered.promise;
  h.runner.stop();
  response.resolve({ ok: true, verified: true, message: 'Готово' });
  await tick;
  assert.deepEqual(searched, [target.id]);
  assert.equal(h.events.filter((e) => e.type === 'booked').length, 1);
  assert.equal(h.scheduled.length, 0);
});

test('start без подтверждённого прогона запрещён', async () => {
  const h = harness();
  h.runner.setTargets([target]);
  await assert.rejects(async () => h.runner.start(), /холостой прогон/i);
});

test('dryRun ничего не записывает и отдаёт отчёт', async () => {
  let acted = 0;
  const h = harness({ search: async () => ({ candidates: [cand], rejected: [], notes: [] }), act: async () => { acted++; return { ok: true, verified: true }; } });
  h.runner.setTargets([target]);
  const report = await h.runner.dryRun();
  assert.equal(acted, 0);
  assert.equal(report.items[0].would.startTime, cand.slot.startTime);
  assert.ok(report.id);
});

test('после подтверждения start разрешён, а изменение целей сбрасывает подтверждение', async () => {
  const h = harness({ search: async () => ({ candidates: [cand], rejected: [], notes: [] }) });
  h.runner.setTargets([target]);
  const report = await h.runner.dryRun();
  h.runner.confirmDryRun(report.id);
  await h.runner.start();
  assert.equal(h.runner.status().running, true);
  h.runner.stop();
  h.runner.setTargets([{ ...target, title: 'Кровь 2' }]);
  await assert.rejects(async () => h.runner.start(), /холостой прогон/i);
});

test('в режиме auto найденный слот записывается и цель помечается выполненной', async () => {
  const h = harness({ search: async () => ({ candidates: [cand], rejected: [], notes: [] }) });
  h.runner.setTargets([target]);
  h.runner.confirmDryRun((await h.runner.dryRun()).id);
  await h.runner.start();
  await h.runner.tick();
  assert.ok(h.events.some((e) => e.type === 'booked'));
  assert.equal(h.runner.status().targets[0].state, 'done');
});

test('в режиме confirm слот не записывается без ответа', async () => {
  const h = harness({ search: async () => ({ candidates: [cand], rejected: [], notes: [] }) });
  h.runner.setTargets([{ ...target, mode: 'confirm' }]);
  h.runner.confirmDryRun((await h.runner.dryRun()).id);
  await h.runner.start();
  await h.runner.tick();
  assert.ok(h.events.some((e) => e.type === 'needConfirm'));
  assert.ok(!h.events.some((e) => e.type === 'booked'));
});

test('интервал не опускается ниже минимального (жёсткий пол ПОСЛЕ джиттера)', async () => {
  const h = harness();
  h.runner.setTargets([target]);
  h.runner.confirmDryRun((await h.runner.dryRun()).id);
  await h.runner.start();
  await h.runner.tick();
  const last = h.scheduled[h.scheduled.length - 1];
  assert.ok(last.ms >= 30000, 'задержка не должна опускаться ниже minIntervalMs ни при каком джиттере');
});

test('длинный разрыв между тиками распознаётся как сон', async () => {
  const h = harness();
  h.runner.setTargets([target]);
  h.runner.confirmDryRun((await h.runner.dryRun()).id);
  await h.runner.start();
  await h.runner.tick();
  h.advance(30000 * 10);
  await h.runner.tick();
  const slept = h.events.find((e) => e.type === 'slept');
  assert.ok(slept, 'должно быть событие slept');
  assert.ok(slept.payload.missed >= 8);
});

// Переписано точно (см. примечание в задании): проверяем ровно одно — после
// трёх интервалов без единой успешной проверки приходит событие stale, и до
// следующей успешной проверки оно приходит один раз, а не на каждом тике.
// Без хаков вида forceConfirmForTest и без catch-заглушек: dryRun() должен
// сам пережить упавший search() и вернуть отчёт, на основе которого можно
// честно подтвердить холостой прогон и запуститься.
test('после трёх интервалов без успешной проверки приходит событие stale, один раз', async () => {
  const h = harness({ search: async () => { throw new Error('сеть'); } });
  h.runner.setTargets([target]);
  const report = await h.runner.dryRun();
  h.runner.confirmDryRun(report.id);
  await h.runner.start();

  const staleCount = () => h.events.filter((e) => e.type === 'stale').length;

  h.advance(30000);
  await h.runner.tick();
  assert.equal(staleCount(), 0, 'через один интервал ещё рано для stale');

  h.advance(30000);
  await h.runner.tick();
  assert.equal(staleCount(), 0, 'через два интервала ещё рано для stale');

  h.advance(30000);
  await h.runner.tick();
  assert.equal(staleCount(), 1, 'через три интервала без успеха должно прийти ровно одно stale');

  h.advance(30000);
  await h.runner.tick();
  assert.equal(staleCount(), 1, 'stale не должен повторяться на каждом следующем неудачном тике');
});

// --- Раунд правок 1: покрытие трёх исходов act(), answer(), таймаута
// подтверждения и keepImproving (CRITICAL 1) ---

test('keepImproving: успешная мутация переводит цель в improving, а не done', async () => {
  const h = harness({
    search: async () => ({ candidates: [cand], rejected: [], notes: [] }),
    act: async () => ({ ok: true, verified: true, message: 'Готово', newAppointment: { id: 42, startTime: '2026-09-24T09:00:00', lpuId: 999 } }),
  });
  h.runner.setTargets([{ ...target, keepImproving: true }]);
  h.runner.confirmDryRun((await h.runner.dryRun()).id);
  await h.runner.start();
  await h.runner.tick();
  assert.ok(h.events.some((e) => e.type === 'booked'));
  assert.equal(h.runner.status().targets[0].state, 'improving');
});

test('keepImproving для bookDoctor: успешная запись переводит цель в shiftDoctor, source пополняется из новой записи', async () => {
  const doctorTarget = {
    id: 'ref:1', scenario: 'bookDoctor', title: 'Врач-эндокринолог', mode: 'auto',
    source: { referralId: 900000000002, lpuId: 10000003, specialityId: 10, needPurpose: false, availableResourceId: null },
  };
  const searchCalls = [];
  const h = harness({
    search: async (t) => { searchCalls.push({ ...t, source: { ...t.source } }); return { candidates: [cand], rejected: [], notes: [] }; },
    act: async () => ({
      ok: true, verified: true, message: 'Готово',
      newAppointment: { id: 700000000020, startTime: '2026-09-24T09:00:00', lpuId: 10000001, toDoctor: { specialityName: 'Врач-эндокринолог' } },
    }),
  });
  h.runner.setTargets([{ ...doctorTarget, keepImproving: true }]);
  h.runner.confirmDryRun((await h.runner.dryRun()).id);
  await h.runner.start();
  await h.runner.tick(); // находит слот, записывает, конвертирует цель в shiftDoctor
  assert.equal(h.runner.status().targets[0].state, 'improving');
  h.advance(30000);
  await h.runner.tick(); // следующий цикл ищет уже по-новому (shiftDoctor)

  const last = searchCalls[searchCalls.length - 1];
  assert.equal(last.scenario, 'shiftDoctor');
  assert.equal(last.source.appointmentId, 700000000020);
  assert.equal(last.source.referralId, 900000000002);
  assert.equal(last.source.lpuId, 10000001);
  assert.equal(last.source.specialityName, 'Врач-эндокринолог');
});

test('keepImproving для bookLdp: успешная запись переводит цель в shiftLdp с appointmentId, referralId и ldpTypeId', async () => {
  const ldpTarget = {
    id: 'ref:4', scenario: 'bookLdp', title: 'Электрокардиография', mode: 'auto',
    source: { referralId: 900000000004, lpuId: 10000002, ldpTypeId: 599930 },
  };
  const searchCalls = [];
  const h = harness({
    search: async (t) => { searchCalls.push({ ...t, source: { ...t.source } }); return { candidates: [cand], rejected: [], notes: [] }; },
    act: async () => ({
      ok: true, verified: true, message: 'Готово',
      newAppointment: { id: 700000000030, startTime: '2026-09-24T09:00:00', lpuId: 10000001, toLdp: { ldpTypeId: 599930 } },
    }),
  });
  h.runner.setTargets([{ ...ldpTarget, keepImproving: true }]);
  h.runner.confirmDryRun((await h.runner.dryRun()).id);
  await h.runner.start();
  await h.runner.tick();
  h.advance(30000);
  await h.runner.tick();

  const last = searchCalls[searchCalls.length - 1];
  assert.equal(last.scenario, 'shiftLdp');
  assert.equal(last.source.appointmentId, 700000000030);
  assert.equal(last.source.referralId, 900000000004);
  assert.equal(last.source.ldpTypeId, 599930);
  assert.equal(last.source.lpuId, 10000001);
});

test('verifyFailed: цель не помечается выполненной и слот не повторяется сразу', async () => {
  let acted = 0;
  const h = harness({
    search: async () => ({ candidates: [cand], rejected: [], notes: [] }),
    act: async () => { acted++; return { ok: true, verified: false, verifyFailed: true, message: 'не смог проверить' }; },
  });
  h.runner.setTargets([target]);
  h.runner.confirmDryRun((await h.runner.dryRun()).id);
  await h.runner.start();
  await h.runner.tick();
  assert.equal(acted, 1);
  assert.notEqual(h.runner.status().targets[0].state, 'done');
  assert.ok(h.events.some((e) => e.type === 'found' && e.payload.targetId === target.id), 'о неопределённом результате должно быть событие');
  await h.runner.tick(); // тот же слот на следующем тике — повторной попытки быть не должно
  assert.equal(acted, 1, 'повторной попытки на том же слоте сразу быть не должно');
});

test('verifyFailed: по истечении 10 минут попытка на том же слоте снова разрешена', async () => {
  let acted = 0;
  const h = harness({
    search: async () => ({ candidates: [cand], rejected: [], notes: [] }),
    act: async () => {
      acted++;
      if (acted === 1) return { ok: true, verified: false, verifyFailed: true, message: 'не смог проверить' };
      return { ok: true, verified: true, message: 'Готово', newAppointment: { id: 1, startTime: cand.slot.startTime } };
    },
  });
  h.runner.setTargets([target]);
  h.runner.confirmDryRun((await h.runner.dryRun()).id);
  await h.runner.start();
  await h.runner.tick();
  assert.equal(acted, 1);
  h.advance(10 * 60 * 1000 + 1);
  await h.runner.tick();
  assert.equal(acted, 2, 'после истечения TTL метка снимается и попытка повторяется');
  assert.equal(h.runner.status().targets[0].state, 'done');
});

test('act(): action stopTarget выключает цель', async () => {
  const h = harness({
    search: async () => ({ candidates: [cand], rejected: [], notes: [] }),
    act: async () => ({ ok: false, verified: false, action: 'stopTarget', message: 'нельзя' }),
  });
  h.runner.setTargets([target]);
  h.runner.confirmDryRun((await h.runner.dryRun()).id);
  await h.runner.start();
  await h.runner.tick();
  assert.equal(h.runner.status().targets[0].state, 'stopped');
});

test('act(): action relogin даёт событие sessionLost', async () => {
  const h = harness({
    search: async () => ({ candidates: [cand], rejected: [], notes: [] }),
    act: async () => ({ ok: false, verified: false, action: 'relogin', message: 'сессия потеряна' }),
  });
  h.runner.setTargets([target]);
  h.runner.confirmDryRun((await h.runner.dryRun()).id);
  await h.runner.start();
  await h.runner.tick();
  assert.ok(h.events.some((e) => e.type === 'sessionLost'));
});

test('act(): action wait/retry оставляет цель активной и пробуется снова на следующем тике', async () => {
  let acted = 0;
  const h = harness({
    search: async () => ({ candidates: [cand], rejected: [], notes: [] }),
    act: async () => { acted++; return { ok: false, verified: false, action: acted === 1 ? 'wait' : 'retry', message: 'подождите' }; },
  });
  h.runner.setTargets([target]);
  h.runner.confirmDryRun((await h.runner.dryRun()).id);
  await h.runner.start();
  await h.runner.tick();
  assert.equal(acted, 1);
  assert.ok(!['done', 'stopped'].includes(h.runner.status().targets[0].state));
  await h.runner.tick();
  assert.equal(acted, 2, 'цель должна пробоваться снова на следующем тике');
});

test('confirm: answer(id, "book") доводит до booked', async () => {
  const h = harness({ search: async () => ({ candidates: [cand], rejected: [], notes: [] }) });
  h.runner.setTargets([{ ...target, mode: 'confirm' }]);
  h.runner.confirmDryRun((await h.runner.dryRun()).id);
  await h.runner.start();
  await h.runner.tick();
  assert.ok(h.runner.status().pending.includes(target.id));
  const res = await h.runner.answer(target.id, 'book');
  assert.ok(res.ok && res.verified);
  assert.ok(h.events.some((e) => e.type === 'booked'));
  assert.equal(h.runner.status().targets[0].state, 'done');
});

test('confirm: answer(id, "skip") не записывает', async () => {
  let acted = 0;
  const h = harness({
    search: async () => ({ candidates: [cand], rejected: [], notes: [] }),
    act: async () => { acted++; return { ok: true, verified: true, message: 'Готово' }; },
  });
  h.runner.setTargets([{ ...target, mode: 'confirm' }]);
  h.runner.confirmDryRun((await h.runner.dryRun()).id);
  await h.runner.start();
  await h.runner.tick();
  const res = await h.runner.answer(target.id, 'skip');
  assert.equal(res.ok, false);
  assert.equal(acted, 0, 'act() не должен вызываться при отказе');
  assert.ok(!h.events.some((e) => e.type === 'booked'));
  assert.equal(h.runner.status().targets[0].state, 'idle');
});

test('истечение срока ожидания подтверждения снимает заявку без записи', async () => {
  let acted = 0;
  const h = harness({
    search: async () => ({ candidates: [cand], rejected: [], notes: [] }),
    act: async () => { acted++; return { ok: true, verified: true, message: 'Готово' }; },
  });
  h.runner.setTargets([{ ...target, mode: 'confirm' }]);
  h.runner.confirmDryRun((await h.runner.dryRun()).id);
  await h.runner.start();
  await h.runner.tick();
  assert.ok(h.runner.status().pending.includes(target.id));
  h.advance(60000 + 1);
  await h.runner.tick();
  assert.equal(h.runner.status().pending.length, 0, 'заявка должна быть снята по истечении срока');
  assert.equal(acted, 0, 'записи не должно было произойти');
  const res = await h.runner.answer(target.id, 'book');
  assert.equal(res.ok, false, 'ответ на уже снятую заявку ничего не делает');
  assert.equal(acted, 0);
});

// --- Раунд правок 1: Important 2-5, 7 ---

test('search(): action stopTarget тоже даёт событие, а не только тихую остановку', async () => {
  const h = harness({ search: async () => ({ candidates: [], rejected: [], notes: ['доступ закрыт'], action: 'stopTarget' }) });
  h.runner.setTargets([target]);
  h.runner.confirmDryRun((await h.runner.dryRun()).id);
  await h.runner.start();
  await h.runner.tick();
  assert.equal(h.runner.status().targets[0].state, 'stopped');
  assert.ok(h.events.some((e) => e.type === 'found' && e.payload.targetId === target.id), 'об остановке нужно сообщить событием, а не только сменой состояния');
});

test('гейт холостого прогона переживает мутации keepImproving (current/source/scenario меняются, а гейт — нет)', async () => {
  const h = harness({
    search: async () => ({ candidates: [cand], rejected: [], notes: [] }),
    act: async () => ({ ok: true, verified: true, message: 'Готово', newAppointment: { id: 42, startTime: '2026-09-24T09:00:00', lpuId: 999 } }),
  });
  h.runner.setTargets([{ ...target, keepImproving: true }]);
  h.runner.confirmDryRun((await h.runner.dryRun()).id);
  await h.runner.start();
  await h.runner.tick(); // цель мутировала: current/source/scenario изменились
  h.runner.stop();
  await h.runner.start(); // не должно требовать новый холостой прогон
  assert.equal(h.runner.status().running, true);
});

test('answer() после stop() не отправляет ничего в ЕМИАС', async () => {
  let acted = 0;
  const h = harness({
    search: async () => ({ candidates: [cand], rejected: [], notes: [] }),
    act: async () => { acted++; return { ok: true, verified: true, message: 'Готово' }; },
  });
  h.runner.setTargets([{ ...target, mode: 'confirm' }]);
  h.runner.confirmDryRun((await h.runner.dryRun()).id);
  await h.runner.start();
  await h.runner.tick();
  assert.ok(h.runner.status().pending.includes(target.id));
  h.runner.stop();
  const res = await h.runner.answer(target.id, 'book');
  assert.equal(res.ok, false);
  assert.equal(acted, 0, 'act() не должен вызываться после stop()');
});

test('setTargets сбрасывает и подтверждение, и последний отчёт холостого прогона', async () => {
  const h = harness({ search: async () => ({ candidates: [cand], rejected: [], notes: [] }) });
  h.runner.setTargets([target]);
  const report = await h.runner.dryRun();
  h.runner.setTargets([target]); // тот же список целей, но отчёт снят до этого вызова
  assert.throws(() => h.runner.confirmDryRun(report.id), /устарел/i);
});

// --- Раунд правок 1: C2 пункт 1 — tick() обязан сам проверять гейт, а не
// полагаться только на start() ---

test('C2: setTargets во время работающего цикла — tick() останавливает раннер и не пишет по неподтверждённым целям', async () => {
  let acted = 0;
  const h = harness({
    search: async () => ({ candidates: [cand], rejected: [], notes: [] }),
    act: async () => { acted++; return { ok: true, verified: true, message: 'Готово' }; },
  });
  h.runner.setTargets([target]);
  h.runner.confirmDryRun((await h.runner.dryRun()).id);
  await h.runner.start();
  assert.equal(h.runner.status().running, true);
  // Мастер меняет цели, пока цикл ещё работает (например, человек пошёл
  // менять условия, не дождавшись остановки) — setTargets обнуляет
  // подтверждение, но раньше работающий tick() этого не замечал.
  h.runner.setTargets([{ ...target, title: 'Кровь 2' }]);
  await h.runner.tick();
  assert.equal(acted, 0, 'ни одного запроса записи не должно было уйти по неподтверждённым целям');
  assert.equal(h.runner.status().running, false, 'цикл должен остановиться сам');
  assert.ok(h.events.some((e) => e.type === 'needDryRun'), 'должно прийти событие needDryRun');
  assert.equal(h.scheduled.length, 0, 'следующий тик не должен планироваться');
});

// --- Раунд правок 1: I4 — потеря сессии не должна засчитываться как
// успешная проверка (lastOkAt/staleNotified) ---

test('I4: relogin из search() не двигает lastOkAt вперёд', async () => {
  const h = harness({
    search: async () => ({ candidates: [], rejected: [], notes: ['сессия истекла'], action: 'relogin' }),
  });
  h.runner.setTargets([target]);
  h.runner.confirmDryRun((await h.runner.dryRun()).id);
  await h.runner.start();
  const lastOkAtAfterStart = h.runner.status().lastOkAt;
  h.advance(30000);
  await h.runner.tick();
  assert.ok(h.events.some((e) => e.type === 'sessionLost'));
  assert.equal(h.runner.status().lastOkAt, lastOkAtAfterStart, 'lastOkAt не должен сдвигаться при relogin из search()');
});

test('I4: relogin из act() не двигает lastOkAt вперёд', async () => {
  const h = harness({
    search: async () => ({ candidates: [cand], rejected: [], notes: [] }),
    act: async () => ({ ok: false, verified: false, action: 'relogin', message: 'сессия потеряна' }),
  });
  h.runner.setTargets([target]);
  h.runner.confirmDryRun((await h.runner.dryRun()).id);
  await h.runner.start();
  const lastOkAtAfterStart = h.runner.status().lastOkAt;
  h.advance(30000);
  await h.runner.tick();
  assert.ok(h.events.some((e) => e.type === 'sessionLost'));
  assert.equal(h.runner.status().lastOkAt, lastOkAtAfterStart, 'lastOkAt не должен сдвигаться при relogin из act()');
});

// --- C2: гейт паузы (backoffUntil) проверяется не только раз в начале
// тика, но и между целями — иначе первая же 429 не мешает раннеру пройтись
// по остальным целям в этом же тике ---

test('C2: если пауза (backoffUntil) наступила после первой цели, вторая цель в этом тике не проверяется', async () => {
  let backoffUntil = 0;
  let searchCalls = 0;
  const h = harness({
    search: async () => {
      searchCalls++;
      backoffUntil = h.at() + 30000; // как будто ЕМИАС ответил 429 на первой цели
      return { candidates: [], rejected: [], notes: [], action: null };
    },
    backoffUntil: () => backoffUntil,
  });
  const target2 = { ...target, id: 'lab2', title: 'Кровь 2' };
  h.runner.setTargets([target, target2]);
  h.runner.confirmDryRun((await h.runner.dryRun()).id);
  await h.runner.start();
  // Холостой прогон тоже вызывал search() и уже успел взвести backoffUntil —
  // интересует только реальный тик, поэтому сбрасываем оба счётчика перед ним.
  searchCalls = 0;
  backoffUntil = 0;
  await h.runner.tick();
  assert.equal(searchCalls, 1, 'после наступления паузы на первой цели вторая цель проверяться не должна была');
});

// --- C1: событие booked обязано нести обновлённые current/source/scenario
// цели — иначе обвязка (userscript) не может сохранить их в настройках, и
// после перезагрузки/захвата standby-вкладкой стартует по УСТАРЕВШИМ полям
// (риск переноса записи НАЗАД) ---

test('C1: событие booked несёт current/source/scenario цели ПОСЛЕ мутации keepImproving', async () => {
  const h = harness({
    search: async () => ({ candidates: [cand], rejected: [], notes: [] }),
    act: async () => ({
      ok: true, verified: true, message: 'Готово',
      newAppointment: { id: 42, startTime: '2026-09-24T10:30:00', lpuId: 999 },
    }),
  });
  h.runner.setTargets([{ ...target, keepImproving: true }]);
  h.runner.confirmDryRun((await h.runner.dryRun()).id);
  await h.runner.start();
  await h.runner.tick();
  const booked = h.events.find((e) => e.type === 'booked');
  assert.ok(booked, 'должно быть событие booked');
  assert.equal(booked.payload.targetId, target.id);
  assert.equal(booked.payload.current, '2026-09-24T10:30:00+03:00', 'booked должен нести новое current, а не старое из cfg.targets');
  assert.equal(booked.payload.source.appointmentId, 42);
  assert.equal(booked.payload.scenario, 'shiftLab', 'bookLab после keepImproving становится shiftLab');
  assert.equal(booked.payload.previous, null, 'у новой записи прежнего времени нет');
});

test('booked при переносе несёт прежнее время записи (previous), даже после keepImproving', async () => {
  const h = harness({
    search: async () => ({ candidates: [cand], rejected: [], notes: [] }),
    act: async () => ({
      ok: true, verified: true, message: 'Готово',
      newAppointment: { id: 43, startTime: '2026-09-24T09:00:00', lpuId: 1 },
    }),
  });
  h.runner.setTargets([{ id: 'appt:7', scenario: 'shiftLab', title: 'Кровь', mode: 'auto', keepImproving: true,
    current: '2026-10-06T13:45:00+03:00', source: { appointmentId: 7, moId: 1, samplingTypeId: 1 } }]);
  h.runner.confirmDryRun((await h.runner.dryRun()).id);
  await h.runner.start();
  await h.runner.tick();
  const booked = h.events.find((e) => e.type === 'booked');
  assert.ok(booked, 'должно быть событие booked');
  assert.equal(booked.payload.previous, '2026-10-06T13:45:00+03:00');
  assert.equal(booked.payload.current, '2026-09-24T09:00:00+03:00');
});

test('M-1: lastCheckAt ставится только настоящей проверкой в tick(), а не start()', async () => {
  const h = harness();
  h.runner.setTargets([target]);
  h.runner.confirmDryRun((await h.runner.dryRun()).id);
  await h.runner.start();
  assert.equal(h.runner.status().lastCheckAt, 0, 'до первой проверки времени проверки нет');
  h.advance(30000);
  await h.runner.tick();
  assert.equal(h.runner.status().lastCheckAt, h.at());
  // Повторный старт снова означает «проверок в этом запуске ещё не было».
  h.runner.stop();
  await h.runner.start();
  assert.equal(h.runner.status().lastCheckAt, 0);
});

// Живой баг: после переноса крови на воскресенье охотник продолжал «улучшать»
// запись и после её начала, получая от ЕМИАС ошибку каждые 20 секунд.
test('перенос: когда до текущей записи меньше minLeadMs, цель завершается без запросов к ЕМИАС', async () => {
  const searched = [];
  const h = harness({ search: async (t) => { searched.push(t.id); return { candidates: [], rejected: [], notes: [] }; } });
  const soon = new Date(h.at() + 3600000).toISOString();
  h.runner.setTargets([{ id: 'appt:1', scenario: 'shiftLab', title: 'Кровь', mode: 'auto', keepImproving: true,
    current: soon, minLeadMs: 2 * 3600000, source: { appointmentId: 1, moId: 1, samplingTypeId: 1 } }]);
  h.runner.confirmDryRun((await h.runner.dryRun()).id);
  searched.length = 0;
  await h.runner.start();
  await h.runner.tick();
  assert.deepEqual(searched, [], 'к ЕМИАС за расписанием не ходим');
  const st = h.runner.status().targets[0];
  assert.equal(st.state, 'done');
  assert.match(st.note, /скоро|прош/);
  assert.ok(h.events.some((e) => e.type === 'targetDone' && e.payload.targetId === 'appt:1'), 'обвязка узнаёт о завершении');
});

test('перенос: запись ещё далеко — поиск идёт как обычно', async () => {
  const searched = [];
  const h = harness({ search: async (t) => { searched.push(t.id); return { candidates: [], rejected: [], notes: [] }; } });
  const later = new Date(h.at() + 10 * 3600000).toISOString();
  h.runner.setTargets([{ id: 'appt:1', scenario: 'shiftLab', title: 'Кровь', mode: 'auto', keepImproving: true,
    current: later, minLeadMs: 2 * 3600000, source: { appointmentId: 1, moId: 1, samplingTypeId: 1 } }]);
  h.runner.confirmDryRun((await h.runner.dryRun()).id);
  searched.length = 0;
  await h.runner.start();
  await h.runner.tick();
  assert.deepEqual(searched, ['appt:1']);
});

test('цель, остановленная ошибкой ЕМИАС (stopTarget), сообщает targetDone — обвязка может завершить поиск', async () => {
  const h = harness({ search: async () => ({ candidates: [], rejected: [], notes: ['ЕМИАС не даёт перенести эту запись'], action: 'stopTarget' }) });
  h.runner.setTargets([target]);
  h.runner.confirmDryRun((await h.runner.dryRun()).id);
  await h.runner.start();
  await h.runner.tick();
  assert.equal(h.runner.status().targets[0].state, 'stopped');
  assert.ok(h.events.some((e) => e.type === 'targetDone' && e.payload.targetId === target.id));
});

// Статус направления перед поиском: нет записи — новая запись; есть — перенос
// раньше неё; появилась во время работы — переход в перенос без ошибки.
const ldpTarget = { id: 'uzi', scenario: 'bookLdp', title: 'УЗИ', mode: 'auto', keepImproving: true, source: { referralId: 555, lpuId: 7, ldpTypeId: 100001 } };
const ldpAppt = { id: 9001, startTime: '2026-11-20T10:00:00', lpuId: 7, lpuAddress: 'улица Тестовая, д. 2', toLdp: { ldpTypeId: '100001', ldpTypeName: 'УЗИ' }, referral: { referralId: 555 } };

function statusHarness(apptsRef) {
  const seen = [];
  const h = harness({
    apiPost: async () => ({ ok: true, json: { payload: { appointment: apptsRef.list } } }),
    search: async (t) => { seen.push({ scenario: t.scenario, current: t.current, appointmentId: t.source.appointmentId }); return { candidates: [], rejected: [], notes: [] }; },
  });
  return { ...h, seen };
}

test('направление без записи: ищет новую запись', async () => {
  const appts = { list: [] };
  const h = statusHarness(appts);
  h.runner.setTargets([ldpTarget]);
  h.runner.confirmDryRun((await h.runner.dryRun()).id);
  await h.runner.start();
  await h.runner.tick();
  assert.deepEqual(h.seen.map((s) => s.scenario), ['bookLdp', 'bookLdp']);
  assert.ok(!h.events.some((e) => e.type === 'targetUpdated'));
});

test('по направлению уже есть запись: ищет раньше неё в режиме переноса', async () => {
  const appts = { list: [ldpAppt] };
  const h = statusHarness(appts);
  h.runner.setTargets([ldpTarget]);
  h.runner.confirmDryRun((await h.runner.dryRun()).id);
  await h.runner.start();
  await h.runner.tick();
  for (const s of h.seen) {
    assert.equal(s.scenario, 'shiftLdp');
    assert.equal(s.current, '2026-11-20T10:00:00+03:00');
    assert.equal(s.appointmentId, 9001);
  }
  const upd = h.events.filter((e) => e.type === 'targetUpdated');
  assert.equal(upd.length, 1);
  assert.equal(upd[0].payload.scenario, 'shiftLdp');
  assert.equal(upd[0].payload.source.referralId, 555);
  assert.equal(h.runner.status().running, true);
});

test('запись появилась во время работы: без ошибки переходит в перенос', async () => {
  const appts = { list: [] };
  const h = statusHarness(appts);
  h.runner.setTargets([ldpTarget]);
  h.runner.confirmDryRun((await h.runner.dryRun()).id);
  await h.runner.start();
  await h.runner.tick();
  appts.list = [ldpAppt]; // записались руками на сайте
  h.advance(30000);
  await h.runner.tick();
  assert.deepEqual(h.seen.map((s) => s.scenario), ['bookLdp', 'bookLdp', 'shiftLdp']);
  assert.ok(!h.events.some((e) => e.type === 'needDryRun' || e.type === 'targetDone'));
  assert.ok(!h.events.some((e) => e.type === 'log' && /сбой/.test(e.payload.msg)));
  assert.equal(h.runner.status().targets[0].current, '2026-11-20T10:00:00+03:00');
});

test('запись на анализ по назначению узнаётся по МО и виду анализа', async () => {
  const appts = { list: [{ id: 77, startTime: '2026-11-12T08:00:00', lpuId: 1, toBM: { id: 1, name: 'Кровь' } }] };
  const h = statusHarness(appts);
  h.runner.setTargets([{ ...target, keepImproving: true }]);
  await h.runner.dryRun();
  assert.equal(h.seen[0].scenario, 'shiftLab');
  assert.equal(h.seen[0].appointmentId, 77);
});
