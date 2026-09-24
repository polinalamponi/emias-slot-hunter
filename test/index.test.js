// test/index.test.js — heartbeat лидера между вкладками (Task 12c): пока
// экземпляр работает, он раз в 20 с шлёт в channel { type: 'alive', from },
// остальные экземпляры запоминают время последнего чужого alive/claim в
// leaderSeenAt() (0, если channel не передан вовсе). Полный сценарий
// арбитража «побеждает больший id» уже проверен в test/integration.test.js —
// здесь только heartbeat поверх него.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { create } = require('../core/index.js');

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

// Номер полиса ОМС собираем из частей, а не 16-значным литералом — иначе
// scripts/check-fixtures.js (часть npm test) примет тестовые данные за
// утечку персональных данных (см. test/integration.test.js).
const OMS = Array(16).fill('0').join('');

// Та же заглушка timer, что и в test/integration.test.js и test/runner.test.js:
// schedule()/cancel() просто кладут/чистят очередь колбэков, тест сам решает,
// когда «наступает» время очередного отложенного срабатывания.
function fakeTimer() {
  const queue = [];
  return { queue, schedule(ms, fn) { queue.push({ ms, fn }); }, cancel() { queue.length = 0; } };
}

// Заглушка BroadcastChannel: копит отправленное в .sent, доставку эмулирует
// сам тест явным вызовом onmessage (без реальной асинхронности — она уже
// проверена в test/integration.test.js через makeAsyncBus).
function fakeChannel() {
  return { sent: [], onmessage: null, postMessage(msg) { this.sent.push(msg); } };
}

function env() {
  const store = {
    'persist:sessionAuth': JSON.stringify({ accessToken: '"a"', refreshToken: '"r"', idToken: 'null', ctime: '"2026-09-23T06:00:00Z"' }),
  };
  const fetchFn = async (url) => {
    const reply = (json) => ({ ok: true, status: 200, text: async () => JSON.stringify(json), json: async () => json });
    // dryRun() всегда спрашивает текущие записи пациента — единственный
    // запрос, который реально уходит для сценария scenario: 'unsupported'
    // (targets.search для него ничего не запрашивает, см. core/targets.js).
    if (url.includes('getAppointmentReceptionsByPatient')) return reply({ payload: { appointment: [] } });
    throw new Error('неожиданный запрос ' + url);
  };
  return {
    fetchFn,
    storage: { getItem: (k) => store[k] ?? null, setItem: (k, v) => { store[k] = String(v); }, removeItem: (k) => { delete store[k]; } },
  };
}

const now = () => Date.parse('2026-09-23T06:00:00Z');

function makeHunter({ instanceId, channel, timer }) {
  const e = env();
  return create({ storage: e.storage, fetch: e.fetchFn, now, timer: timer || fakeTimer(), channel: channel || null, modules, instanceId });
}

// Проводит экземпляр через обязательный холостой прогон (сценарий не из
// белого списка targets.js — ничего не найдёт и не потребует сети сверх
// getAppointmentReceptionsByPatient), после чего start() разрешён.
async function readyToStart(h) {
  await h.init({ identity: { oms: OMS, birth: '2000-01-01' } });
  h.setTargets([{ id: 'x', scenario: 'unsupported', title: 'т' }]);
  const report = await h.dryRun();
  h.confirmDryRun(report.id);
}

test('работающий экземпляр раз в 20 с шлёт { type: "alive", from: myId } в channel', async () => {
  const timer = fakeTimer();
  const channel = fakeChannel();
  const h = makeHunter({ instanceId: 'a', channel, timer });
  await readyToStart(h);

  await h.start();
  channel.sent.length = 0; // claim от самого старта нас здесь не интересует

  // Раннер и heartbeat делят один и тот же слот настоящего timer (см.
  // createSharedTimer в core/index.js) — в любой момент там ровно ОДНО
  // отложенное срабатывание, взведённое на ближайшее из двух. Heartbeat
  // всегда не дальше, чем через 20 с, а тик раннера — не ближе (минимум
  // раннера тот же — MIN_INTERVAL_MS), поэтому сразу после start() это
  // отложенное срабатывание — ровно 20000 мс, heartbeat.
  assert.equal(timer.queue.length, 1);
  assert.equal(timer.queue[0].ms, 20000);

  timer.queue.shift().fn();

  const alive = channel.sent.filter((m) => m.type === 'alive');
  assert.equal(alive.length, 1);
  assert.deepEqual(alive[0], { type: 'alive', from: 'a' });
});

test('вкладка запоминает время последнего чужого alive в leaderSeenAt()', async () => {
  const channel = fakeChannel();
  const h = makeHunter({ instanceId: 'a', channel });

  assert.equal(h.leaderSeenAt(), 0, 'до первого сигнала от другой вкладки — 0');
  channel.onmessage({ data: { type: 'alive', from: 'b' } });
  assert.equal(h.leaderSeenAt(), now(), 'чужой alive обновляет leaderSeenAt() на текущее время');

  channel.sent.length = 0;
  channel.onmessage({ data: { type: 'alive', from: 'a' } }); // свой собственный alive — не считается
  assert.equal(channel.sent.length, 0, 'свой alive никак не отвечается');
});

test('вкладка запоминает время последнего чужого claim в leaderSeenAt(), обработчик claim не меняется', async () => {
  const channel = fakeChannel();
  const h = makeHunter({ instanceId: 'zz', channel }); // не running — на claim не отвечает, но время запоминает

  assert.equal(h.leaderSeenAt(), 0);
  channel.onmessage({ data: { type: 'claim', from: 'a' } });
  assert.equal(h.leaderSeenAt(), now(), 'чужой claim тоже обновляет leaderSeenAt()');
  // Раннер не запущен — прежнее поведение обработчика claim (не отвечать,
  // если сам не running) сохранилось: чужой claim не отправил ответный claim.
  assert.equal(channel.sent.length, 0);
});

test('остановленный экземпляр alive не шлёт: stop() снимает и heartbeat, и тик', async () => {
  const timer = fakeTimer();
  const channel = fakeChannel();
  const h = makeHunter({ instanceId: 'a', channel, timer });
  await readyToStart(h);
  await h.start();
  assert.equal(timer.queue.length, 1, 'после старта отложено что-то (heartbeat/тик)');

  h.stop();

  assert.equal(timer.queue.length, 0, 'после stop() в настоящем timer ничего не осталось отложенным');
  channel.sent.length = 0;
  // Собственно проверить «не шлёт» больше нечем позвать — таймер снят, но
  // на всякий случай убеждаемся, что раннер и правда остановлен.
  assert.equal(h.status().running, false);
});

test('проигравшая арбитраж вкладка (чужой claim с бо́льшим id) останавливает свой heartbeat', async () => {
  const timer = fakeTimer();
  const channel = fakeChannel();
  const h = makeHunter({ instanceId: 'a', channel, timer });
  await readyToStart(h);
  await h.start();
  assert.equal(timer.queue.length, 1);

  channel.onmessage({ data: { type: 'claim', from: 'z' } }); // 'z' > 'a'

  assert.equal(h.status().running, false, 'проиграла арбитраж — остановилась');
  assert.equal(timer.queue.length, 0, 'heartbeat снят вместе с тиком — вкладка не выдаёт себя за лидера');
});

test('без channel координации нет — leaderSeenAt() всегда 0', async () => {
  const h = makeHunter({ instanceId: 'a', channel: null });
  assert.equal(h.leaderSeenAt(), 0);

  await readyToStart(h);
  await h.start();
  assert.equal(h.leaderSeenAt(), 0, 'и после start() тоже 0 — без channel и слать, и слушать некому');
});

/* ==================== identityFromStorage: фолбэк даты рождения на policy/list ====================
 * Реальный idToken ЕМИАС не содержит даты рождения (только jti, exp,
 * ua_ver, trusted, iat, sub, aud, amr, sid, iss, ua_id, FirstName) — только
 * полис (persist:persist.persistOmsNumber). Сам сайт берёт дату рождения из
 * ответа GET /api-eip/v2/policy/list. Дату рождения никуда не сохраняем —
 * она живёт только в session.identity() (в памяти), как и раньше. */

// UTF-8-безопасная кодировка JWT-пейлоада — обратная операция к
// decodeURIComponent(escape(atob(...))) в core/index.js identityFromStorage().
function fakeIdToken(payload) {
  const b64 = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64')
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  return 'h.' + b64 + '.s';
}

// storage['persist:sessionAuth'] и storage['persist:persist'] хранят каждое
// поле ещё раз JSON-закодированным (redux-persist) — воспроизводим ту же
// двойную обёртку, что разбирает identityFromStorage().
function sessionAuthEntry(idTokenPayload) {
  return JSON.stringify({
    accessToken: JSON.stringify('a'),
    refreshToken: JSON.stringify('r'),
    idToken: JSON.stringify(fakeIdToken(idTokenPayload)),
    ctime: JSON.stringify('2026-09-23T06:00:00Z'),
  });
}
function persistPersistEntry(oms) {
  return JSON.stringify({ persistOmsNumber: JSON.stringify(oms) });
}

test('identityFromStorage: дата рождения есть в idToken — policy/list не запрашивается', async () => {
  const BIRTH_FROM_TOKEN = '2001' + '-01-01';
  const e = env();
  e.storage.setItem('persist:persist', persistPersistEntry(OMS));
  e.storage.setItem('persist:sessionAuth', sessionAuthEntry({ sub: 'x', birthdate: BIRTH_FROM_TOKEN }));
  let bodyUsed = null;
  const fetchFn = async (url, opts) => {
    if (url.includes('policy/list')) throw new Error('не должно обращаться к policy/list — дата уже есть в idToken');
    if (url.includes('getAppointmentReceptionsByPatient')) { bodyUsed = JSON.parse(opts.body); return { ok: true, status: 200, text: async () => JSON.stringify({ payload: { appointment: [] } }) }; }
    throw new Error('неожиданный запрос ' + url);
  };
  const h = create({ storage: e.storage, fetch: fetchFn, now, timer: fakeTimer(), channel: null, modules });
  await h.init();
  h.setTargets([{ id: 'x', scenario: 'unsupported', title: 'т' }]);
  await h.dryRun();
  assert.deepEqual(bodyUsed, { omsNumber: OMS, birthDate: BIRTH_FROM_TOKEN });
});

test('identityFromStorage: даты нет в idToken — берём из policy/list, сверив полис с persistOmsNumber', async () => {
  const OTHER_OMS = Array(16).fill('1').join('');
  const RIGHT_BIRTH = '2002' + '-02-02';
  const WRONG_BIRTH = '1970' + '-01-01';
  const e = env();
  e.storage.setItem('persist:persist', persistPersistEntry(OMS));
  e.storage.setItem('persist:sessionAuth', sessionAuthEntry({ sub: 'x' })); // без birthdate/birth_date
  let bodyUsed = null;
  const fetchFn = async (url, opts) => {
    if (url.includes('policy/list')) {
      return {
        ok: true, status: 200, text: async () => JSON.stringify({ payload: { policies: [
          { omsNumber: OTHER_OMS, birthDate: WRONG_BIRTH }, // чужой полис — не должен использоваться
          { omsNumber: OMS, birthDate: RIGHT_BIRTH },
        ] } }),
      };
    }
    if (url.includes('getAppointmentReceptionsByPatient')) { bodyUsed = JSON.parse(opts.body); return { ok: true, status: 200, text: async () => JSON.stringify({ payload: { appointment: [] } }) }; }
    throw new Error('неожиданный запрос ' + url);
  };
  const h = create({ storage: e.storage, fetch: fetchFn, now, timer: fakeTimer(), channel: null, modules });
  await h.init();
  h.setTargets([{ id: 'x', scenario: 'unsupported', title: 'т' }]);
  await h.dryRun();
  assert.deepEqual(bodyUsed, { omsNumber: OMS, birthDate: RIGHT_BIRTH });
});

test('identityFromStorage: полиса в хранилище нет вовсе — к policy/list не обращается, init() бросает IdentityError', async () => {
  const e = env(); // persist:persist отсутствует
  const fetchFn = async (url) => { throw new Error('не должно быть сетевых запросов: ' + url); };
  const h = create({ storage: e.storage, fetch: fetchFn, now, timer: fakeTimer(), channel: null, modules });
  await assert.rejects(() => h.init(), (err) => {
    assert.equal(err.name, 'IdentityError');
    assert.match(err.message, /не удалось определить/);
    return true;
  });
});

test('identityFromStorage: ни в idToken, ни в policy/list подходящего полиса нет — init() бросает понятную IdentityError', async () => {
  const e = env();
  e.storage.setItem('persist:persist', persistPersistEntry(OMS));
  e.storage.setItem('persist:sessionAuth', sessionAuthEntry({ sub: 'x' }));
  const fetchFn = async (url) => {
    if (url.includes('policy/list')) return { ok: true, status: 200, text: async () => JSON.stringify({ payload: { policies: [] } }) };
    throw new Error('неожиданный запрос ' + url);
  };
  const h = create({ storage: e.storage, fetch: fetchFn, now, timer: fakeTimer(), channel: null, modules });
  await assert.rejects(() => h.init(), (err) => {
    assert.equal(err.name, 'IdentityError');
    return true;
  });
});

// После выхода с сайта ЕМИАС стирает и токены, и persistOmsNumber, но наша
// копия токенов (emiasSlotHunter:auth) остаётся — session.read() проходит, а
// полиса нет. Человек должен увидеть «войдите», а не «не нашла полис».
const OWN_AUTH = JSON.stringify({ access: 'a', refresh: 'r', at: 1 });
for (const [label, siteAuth] of [
  ['сайт разлогинен (accessToken пуст)', JSON.stringify({ accessToken: 'null', refreshToken: 'null', idToken: 'null', ctime: 'null' })],
  ['записи persist:sessionAuth нет вовсе', null],
]) {
  test(`init: ${label} — просит войти, а не IdentityError, и ничего не запрашивает`, async () => {
    const e = env();
    if (siteAuth === null) e.storage.removeItem('persist:sessionAuth');
    else e.storage.setItem('persist:sessionAuth', siteAuth);
    e.storage.setItem('emiasSlotHunter:auth', OWN_AUTH);
    const fetchFn = async (url) => { throw new Error('не должно быть сетевых запросов: ' + url); };
    const h = create({ storage: e.storage, fetch: fetchFn, now, timer: fakeTimer(), channel: null, modules });
    await assert.rejects(() => h.init(), (err) => {
      assert.notEqual(err.name, 'IdentityError');
      assert.match(err.message, /войдите/i);
      return true;
    });
  });
}

test('identityFromStorage: policy/list отвечает потерей сессии — распространяется как SessionError, а не как IdentityError', async () => {
  const e = env();
  e.storage.setItem('persist:persist', persistPersistEntry(OMS));
  e.storage.setItem('persist:sessionAuth', sessionAuthEntry({ sub: 'x' }));
  const fetchFn = async (url) => {
    if (url.includes('policy/list')) return { ok: false, status: 401, text: async () => '' };
    if (url.includes('refreshTokens')) return { ok: false, status: 401, json: async () => null };
    throw new Error('неожиданный запрос ' + url);
  };
  const h = create({ storage: e.storage, fetch: fetchFn, now, timer: fakeTimer(), channel: null, modules });
  await assert.rejects(() => h.init(), (err) => {
    assert.equal(err.name, 'SessionError');
    assert.notEqual(err.name, 'IdentityError');
    return true;
  });
});
