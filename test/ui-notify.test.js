// test/ui-notify.test.js — уведомления через ntfy: тексты событий, публикация,
// тихий отказ без настроек, генерация личного топика.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createNotifier, messageFor, generateTopic, loadSettings, saveSettings } = require('../userscript/ui-notify.js');

function storageOf(data = {}) {
  return { getItem: (k) => data[k] ?? null, setItem: (k, v) => { data[k] = String(v); } };
}

function reply(json, status = 200) {
  return { ok: status >= 200 && status < 300, status, json: async () => json };
}

/* ==================== тексты событий ==================== */

test('messageFor: тексты событий по-человечески, адрес опционален', () => {
  assert.deepEqual(
    messageFor({ kind: 'booked', title: 'Кровь', time: '25 ноября, 09:15', address: 'улица А' }),
    { title: 'ЕМИАС: записано', body: '✅ Кровь — 25 ноября, 09:15, улица А' },
  );
  assert.deepEqual(
    messageFor({ kind: 'booked', title: 'Кровь', time: '25 ноября, 09:15' }),
    { title: 'ЕМИАС: записано', body: '✅ Кровь — 25 ноября, 09:15' },
  );
  assert.match(messageFor({ kind: 'needConfirm', title: 'Хирург', time: '26 ноября, 10:00' }).title, /нужно решение/);
  assert.match(messageFor({ kind: 'allDone' }).body, /Все цели выполнены/);
  assert.match(messageFor({ kind: 'sessionLost' }).body, /Войдите заново/);
  assert.match(messageFor({ kind: 'stale' }).body, /Давно нет ответа/);
  assert.match(messageFor({ kind: 'test' }).body, /Уведомления охотника настроены/);
});

/* ==================== тихий отказ без настроек ==================== */

test('send без топика — тихий отказ, ни одного запроса', async () => {
  let called = 0;
  const n = createNotifier({ storage: storageOf(), fetch: async () => { called++; return reply({}); } });
  const r = await n.send({ kind: 'booked', title: 'x', time: 'y' });
  assert.equal(r.ok, false);
  assert.equal(r.silent, true);
  assert.equal(called, 0);
});

/* ==================== публикация в ntfy ==================== */

test('ntfy: JSON-публикация в корень сервера с личным топиком', async () => {
  const data = {};
  saveSettings(storageOf(data), { topic: 'emias-abc123def456aa' });
  const storage = { getItem: (k) => data[k] ?? null, setItem: (k, v) => { data[k] = String(v); } };
  let url = ''; let body = '';
  const n = createNotifier({ storage, fetch: async (u, opts) => { url = u; body = opts.body; return reply({}); } });
  const r = await n.send({ kind: 'booked', title: 'Врач', time: 'завтра 9:00' });
  assert.equal(r.ok, true);
  assert.equal(url, 'https://ntfy.sh/');
  const params = JSON.parse(body);
  assert.equal(params.topic, 'emias-abc123def456aa');
  assert.equal(params.title, 'ЕМИАС: записано');
  assert.equal(params.message, '✅ Врач — завтра 9:00');
});

test('ntfy: свой сервер разрешён, завершающий слэш обрезается', () => {
  const data = {};
  saveSettings(storageOf(data), { server: 'https://push.example.com///', topic: 'emias-abc123def456aa' });
  const s = loadSettings(storageOf(data));
  assert.equal(s.server, 'https://push.example.com');
});

test('ntfy: HTTP-ошибка сервера видна человеку', async () => {
  const data = {};
  saveSettings(storageOf(data), { topic: 'emias-abc123def456aa' });
  const storage = { getItem: (k) => data[k] ?? null, setItem: (k, v) => { data[k] = String(v); } };
  const n = createNotifier({ storage, fetch: async () => reply({}, 503) });
  const r = await n.send({ kind: 'test' });
  assert.equal(r.ok, false);
  assert.match(r.error, /503/);
});

test('test(): проверочное сообщение требует настроенный топик', async () => {
  const n = createNotifier({ storage: storageOf(), fetch: async () => { throw new Error('не должен вызываться'); } });
  const r = await n.test();
  assert.equal(r.ok, false);
  assert.equal(r.silent, undefined);
  assert.match(r.error, /не задан топик/);
});

/* ==================== настройки и топик ==================== */

test('saveSettings: топик сохраняется с обрезкой пробелов', () => {
  const data = {};
  const storage = storageOf(data);
  saveSettings(storage, { topic: '  emias-abc123def456aa  ' });
  assert.equal(loadSettings(storage).topic, 'emias-abc123def456aa');
});

test('saveSettings: пустой сервер возвращается к ntfy.sh', () => {
  const data = {};
  const storage = storageOf(data);
  saveSettings(storage, { topic: 'emias-abc123def456aa', server: '' });
  assert.equal(loadSettings(storage).server, 'https://ntfy.sh');
});

test('generateTopic: префикс emias-, 16 неугадываемых символов из безопасного алфавита', () => {
  for (let i = 0; i < 20; i++) {
    const t = generateTopic();
    assert.match(t, /^emias-[a-z0-9]{16}$/);
  }
  assert.notEqual(generateTopic(() => 0.1), generateTopic(() => 0.9));
});
