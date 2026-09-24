// test/integration.test.js — сквозной тест: от обнаружения цели до записи
// слота через полный контур core/index.js (сборка модулей + раннер), плюс
// проверка «одной активной вкладки» через channel.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { create } = require('../core/index.js');
const referrals = require('./fixtures/referrals.json');
const schedule = require('./fixtures/schedule.json');
const doctorsLi = require('./fixtures/doctors-li.json');

// core/index.js больше не делает require() своих соседей (это ломало бы
// проверку сборки из Task 1 — в собранном userscript require( быть не
// должно). Вместо этого create() принимает готовые фабрики через modules;
// в браузерной сборке их роль играет плоский globalThis.EmiasCore, в Node мы
// собираем тот же плоский объект сами через require() каждого модуля.
const modules = Object.assign(
  {},
  require('../core/util.js'),
  require('../core/errors.js'),
  require('../core/filters.js'),
  require('../core/session.js'),
  require('../core/api.js'),
  require('../core/discover.js'),
  require('../core/targets.js'),
  require('../core/runner.js'),
);

// Номер полиса ОМС собираем из частей во время выполнения, а не 16-значным
// литералом, — иначе scripts/check-fixtures.js (часть npm test) примет
// тестовые данные за утечку персональных данных.
const OMS = Array(16).fill('0').join('');

function env() {
  const store = {
    'persist:sessionAuth': JSON.stringify({ accessToken: '"a"', refreshToken: '"r"', idToken: 'null', ctime: '"2026-09-23T06:00:00Z"' }),
  };
  let booked = null;
  const fetchFn = async (url, opts) => {
    const body = JSON.parse(opts.body || '{}');
    const reply = (json) => ({ ok: true, status: 200, text: async () => JSON.stringify(json), json: async () => json });
    if (url.includes('getAssignmentsReferralsInfo')) return reply(referrals);
    if (url.includes('getAppointmentReceptionsByPatient')) return reply({ payload: { appointment: booked ? [booked] : [] } });
    if (url.includes('getDoctorsInfoForLI')) return reply(doctorsLi);
    if (url.includes('getAvailableResourceScheduleInfo')) return reply(schedule);
    if (url.includes('createAppointment')) {
      booked = { id: 700000000010, startTime: body.startTime.slice(0, 19), endTime: body.endTime.slice(0, 19), type: 'BM', lpuId: 10000001, lpuAddress: 'улица Тестовая, д. 2', toBM: { id: 1, name: 'Взятие венозной крови' } };
      return reply({ payload: {} });
    }
    throw new Error('неожиданный запрос ' + url);
  };
  const timer = { queue: [], schedule(ms, fn) { this.queue.push(fn); }, cancel() { this.queue.length = 0; } };
  return {
    fetchFn, timer, store,
    booked: () => booked,
    storage: { getItem: (k) => store[k] ?? null, setItem: (k, v) => { store[k] = String(v); }, removeItem: (k) => { delete store[k]; } },
  };
}

test('полный путь: нашли цель → холостой прогон → подтверждение → запись', async () => {
  const e = env();
  const now = () => Date.parse('2026-09-23T06:00:00Z');
  const h = create({ storage: e.storage, fetch: e.fetchFn, now, timer: e.timer, channel: null, modules });
  await h.init({ identity: { oms: OMS, birth: '2000-01-01' } });

  const options = await h.discover();
  const lab = options.find((o) => o.scenario === 'bookLab');
  assert.ok(lab, 'должна найтись цель «записаться на кровь»');

  h.setTargets([{ ...lab, mode: 'auto', minLeadMs: 2 * 3600000, travelMs: 3600000, respectTravel: true, dateTo: '2026-10-14' }]);
  const report = await h.dryRun();
  assert.equal(e.booked(), null, 'холостой прогон ничего не записывает');
  assert.ok(report.items[0].would, 'в отчёте есть слот, который был бы взят');

  await assert.rejects(async () => h.start(), /холостой прогон/i);
  h.confirmDryRun(report.id);
  await h.start();
  await e.timer.queue.shift()();

  assert.ok(e.booked(), 'слот записан');
  assert.equal(h.status().targets[0].state, 'improving');
});

test('init() без identity и без опознаваемых данных в хранилище бросает понятное сообщение', async () => {
  const e = env();
  const now = () => Date.parse('2026-09-23T06:00:00Z');
  const h = create({ storage: e.storage, fetch: e.fetchFn, now, timer: e.timer, channel: null, modules });
  // В storage из env() есть валидный вход (persist:sessionAuth), но нет ни
  // persist:persist (полис), ни разбираемого idToken (дата рождения) — и
  // identity явно не передан. session.read() пройдёт успешно, а вот
  // определить полис/дату рождения init() не сможет.
  await assert.rejects(async () => h.init(), /полис.*дату рождения/i);
});

test('discover пробрасывает человекочитаемую ошибку ЕМИАС наружу', async () => {
  const e = env();
  const now = () => Date.parse('2026-09-23T06:00:00Z');
  const failingFetch = async (url, opts) => {
    if (url.includes('getAssignmentsReferralsInfo')) {
      return { ok: false, status: 500, text: async () => '', json: async () => null };
    }
    return e.fetchFn(url, opts);
  };
  const h = create({ storage: e.storage, fetch: failingFetch, now, timer: e.timer, channel: null, modules });
  await h.init({ identity: { oms: OMS, birth: '2000-01-01' } });

  // discover.list() должен именно бросить Error с понятным текстом, а не
  // проглотить сбой внутри create() — интерфейс потом покажет это сообщение
  // и кнопку «Повторить».
  await assert.rejects(async () => h.discover(), /ЕМИАС/i);
});

// Шина сообщений имитирует BroadcastChannel с АСИНХРОННОЙ доставкой (как в
// настоящем браузере: postMessage никогда не вызывает onmessage в этом же
// тике). Это существенно: при синхронной доставке старты идут строго
// последовательно и не воспроизводят состояние гонки, которое ловит
// арбитраж по id.
function makeAsyncBus() {
  const channels = [];
  function makeChannel() {
    const ch = {
      onmessage: null,
      postMessage: (msg) => {
        for (const other of channels) {
          if (other === ch) continue;
          setImmediate(() => { if (other.onmessage) other.onmessage({ data: msg }); });
        }
      },
    };
    channels.push(ch);
    return ch;
  }
  return { makeChannel };
}

// Даёт очереди setImmediate несколько кругов «осесть» — нужно, т.к. цепочка
// заявок на лидерство может включать переотправку (см. core/index.js):
// проигравший по id инстанс не отвечает, а выигравший по id, получив claim
// от меньшего id, рассылает свой claim ещё раз.
function settle(rounds = 5) {
  return new Promise((resolve) => {
    let n = 0;
    (function step() { if (n++ >= rounds) return resolve(); setImmediate(step); })();
  });
}

function makeHunter(channel, instanceId) {
  const e = env();
  const now = () => Date.parse('2026-09-23T06:00:00Z');
  const h = create({ storage: e.storage, fetch: e.fetchFn, now, timer: e.timer, channel, modules, instanceId });
  return h;
}

async function readyToStart(h) {
  await h.init({ identity: { oms: OMS, birth: '2000-01-01' } });
  // Сценарий не из белого списка targets.js — холостой прогон отработает
  // (ничего не найдёт), а тикать раннеру в этих тестах не нужно вовсе.
  h.setTargets([{ id: 'x', scenario: 'unsupported', title: 'т' }]);
  const report = await h.dryRun();
  h.confirmDryRun(report.id);
}

test('одна активная вкладка: одновременный старт двух вкладок — активной остаётся ровно одна, побеждает больший id', async () => {
  const bus = makeAsyncBus();
  const a = makeHunter(bus.makeChannel(), 'a'); // меньший id
  const b = makeHunter(bus.makeChannel(), 'b'); // больший id
  await readyToStart(a);
  await readyToStart(b);

  const standbyA = [];
  const standbyB = [];
  a.on('standby', (p) => standbyA.push(p));
  b.on('standby', (p) => standbyB.push(p));

  // Настоящая гонка: обе вкладки стартуют одновременно, доставка сообщений
  // асинхронная — без арбитража по id обе могли бы остаться running.
  await Promise.all([a.start(), b.start()]);
  await settle();

  const runningCount = [a.status().running, b.status().running].filter(Boolean).length;
  assert.equal(runningCount, 1, 'активной должна остаться ровно одна вкладка, а не ноль и не две');
  assert.equal(b.status().running, true, 'побеждает вкладка с бо́льшим id');
  assert.equal(a.status().running, false, 'вкладка с меньшим id уступает лидерство');
  assert.equal(standbyA.length, 1, 'проигравшая вкладка получает ровно одно событие standby');
  assert.equal(standbyA[0].by, 'b', 'standby сообщает id победителя');
  assert.equal(standbyB.length, 0, 'победившая вкладка событие standby не получает');
});

test('одна активная вкладка: вкладка без подтверждённого холостого прогона не может забрать лидерство у работающей', async () => {
  const bus = makeAsyncBus();
  const a = makeHunter(bus.makeChannel(), 'z'); // id МЕНЬШЕ, чем у b ('z' < 'zz' как строки) — но это не должно иметь значения
  const b = makeHunter(bus.makeChannel(), 'zz');
  await readyToStart(a);
  // b НЕ проходит гейт холостого прогона: dryRun()/confirmDryRun() не вызваны.
  await b.init({ identity: { oms: OMS, birth: '2000-01-01' } });
  b.setTargets([{ id: 'x', scenario: 'unsupported', title: 'т' }]);

  const standbyA = [];
  a.on('standby', (p) => standbyA.push(p));

  await a.start();
  assert.equal(a.status().running, true, 'первая вкладка легитимно работает');

  await assert.rejects(async () => b.start(), /холостой прогон/i, 'без подтверждения прогона start() отклоняется');
  await settle();

  assert.equal(a.status().running, true, 'работающая вкладка не должна была остановиться');
  assert.equal(standbyA.length, 0, 'claim от вкладки, не прошедшей гейт, вообще не должен был уйти в канал');
});
