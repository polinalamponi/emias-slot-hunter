// test/api.test.js
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createApi, SessionError } = require('../core/api.js');
const { createErrors } = require('../core/errors.js');

const errors = createErrors();

// Построить тестовые данные в коде, не как литералы
const OMS = '0000000000' + '000000';
const BIRTH = '2000' + '-01-01';

const fakeSession = (token = 'tok') => {
  let refreshed = 0;
  return {
    token: () => token,
    identity: () => ({ oms: OMS, birth: BIRTH }),
    refresh: async () => { refreshed++; token = 'tok2'; return true; },
    get refreshed() { return refreshed; },
  };
};

test('добавляет заголовки и тело с полисом и датой рождения', async () => {
  const calls = [];
  const api = createApi({
    session: fakeSession(), errors, now: () => 0,
    fetch: async (url, opts) => { calls.push({ url, opts }); return { ok: true, status: 200, text: async () => '{"payload":{}}' }; },
  });
  await api.post('v10/saOrchestrator/getAppointmentReceptionsByPatient', {});
  assert.equal(calls[0].url, '/api-eip/v10/saOrchestrator/getAppointmentReceptionsByPatient');
  assert.equal(calls[0].opts.headers['EI-Token'], 'tok');
  assert.equal(calls[0].opts.headers['X-App'], 'portal');
  assert.deepEqual(JSON.parse(calls[0].opts.body), { omsNumber: OMS, birthDate: BIRTH });
});

test('401 приводит к продлению и одному повтору', async () => {
  const session = fakeSession();
  let n = 0;
  const api = createApi({
    session, errors, now: () => 0,
    fetch: async () => { n++; return n === 1 ? { ok: false, status: 401, text: async () => '' } : { ok: true, status: 200, text: async () => '{"payload":{"ok":1}}' }; },
  });
  const r = await api.post('v1/x', {});
  assert.equal(r.ok, true);
  assert.equal(session.refreshed, 1);
  assert.equal(n, 2);
});

test('повторный 401 бросает SessionError', async () => {
  const api = createApi({
    session: fakeSession(), errors, now: () => 0,
    fetch: async () => ({ ok: false, status: 401, text: async () => '' }),
  });
  await assert.rejects(() => api.post('v1/x', {}), SessionError);
});

// I4: userscript/ui-dom.js onSessionLost показывает e.message пользователю
// как есть (в пояснении к значку) — техническое «сессия не продлевается»
// человек не поймёт и не поймёт, что делать. Текст должен быть понятным
// по-русски и говорить, что делать.
test('I4: SessionError несёт понятный человеку текст, а не техническую фразу', async () => {
  const api = createApi({
    session: fakeSession(), errors, now: () => 0,
    fetch: async () => ({ ok: false, status: 401, text: async () => '' }),
  });
  await assert.rejects(() => api.post('v1/x', {}), (e) => {
    assert.match(e.message, /войдите заново/i);
    assert.doesNotMatch(e.message, /не продлевается/);
    return true;
  });
});

test('429 ставит паузу на 30 секунд', async () => {
  const api = createApi({
    session: fakeSession(), errors, now: () => 1000,
    fetch: async () => ({ ok: false, status: 429, text: async () => '' }),
  });
  const r = await api.post('v1/x', {});
  assert.equal(r.ok, false);
  assert.equal(api.backoffUntil(), 31000);
});

test('сетевая ошибка увеличивает паузу и не роняет вызов', async () => {
  let t = 0;
  const api = createApi({
    session: fakeSession(), errors, now: () => t,
    fetch: async () => { throw new TypeError('Failed to fetch'); },
  });
  const r1 = await api.post('v1/x', {});
  assert.equal(r1.ok, false);
  assert.equal(api.backoffUntil(), 30000);
  t = 30000;
  await api.post('v1/x', {});
  assert.equal(api.backoffUntil(), 30000 + 60000);
});

test('ошибка с кодом объясняется по-русски', async () => {
  const api = createApi({
    session: fakeSession(), errors, now: () => 0,
    fetch: async () => ({ ok: false, status: 400, text: async () => JSON.stringify({ error: { code: 'SA_SAME_BM_IS_NOT_AVAILABLE' } }) }),
  });
  const r = await api.post('v1/x', {});
  assert.equal(r.explained.action, 'switchToShift');
});

test('сброс сетевой паузы при успешном запросе', async () => {
  let t = 0;
  let callCount = 0;
  const api = createApi({
    session: fakeSession(), errors, now: () => t,
    fetch: async () => {
      callCount++;
      // Вызов 1 и 3: сетевая ошибка
      // Вызов 2: успех
      if (callCount === 2) return { ok: true, status: 200, text: async () => '{"ok":1}' };
      throw new TypeError('Failed to fetch');
    },
  });
  // Первая сетевая ошибка: пауза 30s
  const r1 = await api.post('v1/x', {});
  assert.equal(r1.ok, false);
  assert.equal(api.backoffUntil(), 30000);
  // Успешный запрос сбрасывает счётчик netStep
  t = 30000;
  const r2 = await api.post('v1/x', {});
  assert.equal(r2.ok, true);
  assert.equal(api.backoffUntil(), 30000); // backoffUntil не меняется от успеха
  // Вторая сетевая ошибка должна дать паузу 30s (счётчик сброшен), не 60s
  const r3 = await api.post('v1/x', {});
  assert.equal(r3.ok, false);
  assert.equal(api.backoffUntil(), 30000 + 30000);
});

test('статус 200 с невалидным JSON считается ошибкой', async () => {
  const api = createApi({
    session: fakeSession(), errors, now: () => 0,
    fetch: async () => ({ ok: true, status: 200, text: async () => '<html>что-то</html>' }),
  });
  const r = await api.post('v1/x', {});
  assert.equal(r.ok, false);
  assert.ok(r.explained);
  assert.ok(r.explained.message && r.explained.message.length > 0);
});

test('статус 200 с пустым телом считается успехом', async () => {
  const api = createApi({
    session: fakeSession(), errors, now: () => 0,
    fetch: async () => ({ ok: true, status: 200, text: async () => '' }),
  });
  const r = await api.post('v1/x', {});
  assert.equal(r.ok, true);
  assert.equal(r.json, null);
  assert.equal(r.explained, null);
});

// get(): нужен для /api-eip/v2/policy/list (core/index.js, фолбэк на дату
// рождения) — GET без тела и без omsNumber/birthDate, session.identity()
// в этот момент ещё не заполнена.
test('get(): GET без тела, с EI-Token, без omsNumber/birthDate', async () => {
  const calls = [];
  const api = createApi({
    session: fakeSession(), errors, now: () => 0,
    fetch: async (url, opts) => { calls.push({ url, opts }); return { ok: true, status: 200, text: async () => '{"payload":{}}' }; },
  });
  const r = await api.get('v2/policy/list');
  assert.equal(calls[0].url, '/api-eip/v2/policy/list');
  assert.equal(calls[0].opts.method, 'GET');
  assert.equal(calls[0].opts.headers['EI-Token'], 'tok');
  assert.equal(calls[0].opts.body, undefined);
  assert.equal(r.ok, true);
  assert.deepEqual(r.json, { payload: {} });
});

test('get(): 401 продлевает сессию и повторяет запрос ровно как post()', async () => {
  const session = fakeSession();
  let n = 0;
  const api = createApi({
    session, errors, now: () => 0,
    fetch: async () => { n++; return n === 1 ? { ok: false, status: 401, text: async () => '' } : { ok: true, status: 200, text: async () => '{"payload":{}}' }; },
  });
  const r = await api.get('v2/policy/list');
  assert.equal(r.ok, true);
  assert.equal(session.refreshed, 1);
  assert.equal(n, 2);
});

test('get(): повторный 401 бросает SessionError', async () => {
  const api = createApi({
    session: fakeSession(), errors, now: () => 0,
    fetch: async () => ({ ok: false, status: 401, text: async () => '' }),
  });
  await assert.rejects(() => api.get('v2/policy/list'), SessionError);
});
