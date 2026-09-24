const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createSession } = require('../core/session.js');

function fakeStorage(init = {}) {
  const data = { ...init };
  return {
    data,
    getItem: (k) => (k in data ? data[k] : null),
    setItem: (k, v) => { data[k] = String(v); },
    removeItem: (k) => { delete data[k]; },
  };
}
const siteAuth = (access, refresh, ctime) => JSON.stringify({
  accessToken: JSON.stringify(access), refreshToken: JSON.stringify(refresh),
  idToken: 'null', ctime: JSON.stringify(ctime),
});

test('read берёт более свежие токены из своего ключа', () => {
  const storage = fakeStorage({
    'persist:sessionAuth': siteAuth('site-a', 'site-r', '2026-09-23T09:00:00Z'),
    'emiasSlotHunter:auth': JSON.stringify({ access: 'mine-a', refresh: 'mine-r', at: Date.parse('2026-09-23T10:00:00Z') }),
  });
  const s = createSession({ storage, fetch: async () => {}, now: () => Date.parse('2026-09-23T10:30:00Z') });
  assert.equal(s.read().access, 'mine-a');
});

test('read берёт токены сайта, если вход свежее', () => {
  const storage = fakeStorage({
    'persist:sessionAuth': siteAuth('site-a', 'site-r', '2026-09-23T11:00:00Z'),
    'emiasSlotHunter:auth': JSON.stringify({ access: 'mine-a', refresh: 'mine-r', at: Date.parse('2026-09-23T10:00:00Z') }),
  });
  const s = createSession({ storage, fetch: async () => {}, now: () => Date.parse('2026-09-23T11:30:00Z') });
  assert.equal(s.read().access, 'site-a');
});

test('read бросает понятную ошибку, если входа нет', () => {
  const s = createSession({ storage: fakeStorage(), fetch: async () => {}, now: Date.now });
  assert.throws(() => s.read(), /нет входа/);
});

test('refresh перебирает ключи и сохраняет результат только в свой ключ', async () => {
  const storage = fakeStorage({ 'persist:sessionAuth': siteAuth('a', 'site-r', '2026-09-23T09:00:00Z') });
  const seen = [];
  const fetchFn = async (url, opts) => {
    const body = JSON.parse(opts.body);
    seen.push(body.refreshToken);
    if (body.refreshToken !== 'site-r') return { ok: false, status: 400, json: async () => ({}) };
    return { ok: true, status: 200, json: async () => ({ access_token: 'new-a', refresh_token: 'new-r', expires_in: 3600 }) };
  };
  const s = createSession({ storage, fetch: fetchFn, now: () => 1000 });
  s.setAuth({ access: 'a', refresh: 'dead-r', at: 0 });
  assert.equal(await s.refresh(), true);
  assert.deepEqual(seen, ['dead-r', 'site-r']);
  assert.equal(s.token(), 'new-a');
  assert.equal(JSON.parse(storage.data['emiasSlotHunter:auth']).refresh, 'new-r');
  assert.equal(storage.data['persist:sessionAuth'], siteAuth('a', 'site-r', '2026-09-23T09:00:00Z'), 'хранилище сайта не изменилось');
});

test('refresh возвращает false, если все ключи мертвы', async () => {
  const storage = fakeStorage({ 'persist:sessionAuth': siteAuth('a', 'r', '2026-09-23T09:00:00Z') });
  const s = createSession({ storage, fetch: async () => ({ ok: false, status: 400, json: async () => ({}) }), now: () => 1 });
  assert.equal(await s.refresh(), false);
});

test('refresh дедуплицирует параллельные вызовы', async () => {
  const storage = fakeStorage({ 'persist:sessionAuth': siteAuth('a', 'site-r', '2026-09-23T09:00:00Z') });
  let fetchCount = 0;
  const fetchFn = async (url, opts) => {
    fetchCount++;
    return new Promise((resolve) => {
      setTimeout(() => {
        resolve({ ok: true, status: 200, json: async () => ({ access_token: 'concurrent-a', refresh_token: 'concurrent-r', expires_in: 3600 }) });
      }, 10);
    });
  };
  const s = createSession({ storage, fetch: fetchFn, now: () => 1000 });
  const r1 = s.refresh();
  const r2 = s.refresh();
  assert.equal(r1, r2, 'оба вызова возвращают один и тот же промис');
  const res1 = await r1;
  const res2 = await r2;
  assert.equal(res1, true);
  assert.equal(res2, true);
  assert.equal(s.token(), 'concurrent-a');
  assert.equal(fetchCount, 1, 'fetch вызван ровно один раз');
});

test('needsRefresh учитывает возраст токена из хранилища сайта', () => {
  const nowMs = Date.parse('2026-09-23T10:30:00Z');
  const storage = fakeStorage({
    'persist:sessionAuth': siteAuth('a', 'r', '2026-09-23T10:00:00Z'),
  });
  const s = createSession({ storage, fetch: async () => {}, now: () => nowMs });
  s.read();
  assert.equal(s.needsRefresh(0.6), false, 'свежий токен (30 минут из часа) не требует обновления');

  const oldNowMs = Date.parse('2026-09-23T11:30:00Z');
  const storageOld = fakeStorage({
    'persist:sessionAuth': siteAuth('a', 'r', '2026-09-23T10:00:00Z'),
  });
  const sOld = createSession({ storage: storageOld, fetch: async () => {}, now: () => oldNowMs });
  sOld.read();
  assert.equal(sOld.needsRefresh(0.6), true, 'старый токен (90 минут) требует обновления');
});
