// test/security.test.js — публичная гарантия: скрипт работает только на
// emias.info и обращается только к ЕМИАС. Если кто-то (автор по ошибке,
// чужой пулл-реквест или взломщик) расширит @match, добавит разрешения
// Tampermonkey или запрос на сторонний адрес, этот тест упадёт, и GitHub
// Action покажет красный крестик у коммита.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const DIST = path.join(ROOT, 'dist/emias-slot-hunter.user.js');
const RELEASE_URL = 'https://raw.githubusercontent.com/polinalamponi/emias-slot-hunter/release/dist/emias-slot-hunter.user.js';

function split() {
  const src = fs.readFileSync(DIST, 'utf8');
  const end = src.indexOf('// ==/UserScript==');
  assert.ok(src.startsWith('// ==UserScript==') && end > 0, 'файл должен начинаться с шапки userscript');
  const meta = src.slice(0, end).split('\n')
    .map((l) => l.match(/^\/\/ @(\S+)\s*(.*)$/)).filter(Boolean)
    .map((m) => ({ key: m[1], value: m[2].trim() }));
  return { meta, body: src.slice(end) };
}

const values = (meta, key) => meta.filter((m) => m.key === key).map((m) => m.value);

test('шапка: скрипт запускается только на emias.info', () => {
  const { meta } = split();
  assert.deepEqual(values(meta, 'match'), ['https://emias.info/*']);
  assert.deepEqual(values(meta, 'include'), [], '@include запрещён — только @match');
});

test('шапка: никаких разрешений Tampermonkey и внешних подключений', () => {
  const { meta } = split();
  assert.deepEqual(values(meta, 'grant'), ['none']);
  for (const key of ['connect', 'require', 'resource', 'antifeature', 'webRequest']) {
    assert.deepEqual(values(meta, key), [], `@${key} запрещён`);
  }
});

test('шапка: обновления приходят только из ветки release', () => {
  const { meta } = split();
  assert.deepEqual(values(meta, 'updateURL'), [RELEASE_URL]);
  assert.deepEqual(values(meta, 'downloadURL'), [RELEASE_URL]);
});

// Единственное исключение из «только emias.info» — ссылка на перевод автору
// в карточке благодарности после записи. Человек открывает её сам; скрипт по
// ней ничего не запрашивает. Разрешена ровно эта строка, ровно один раз,
// и только как href ссылки с rel="noopener noreferrer".
const DONATE_URL = 'https://t.tb.ru/pm_short/6lKWxzCflJH';

test('код: единственный внешний адрес — ссылка на перевод автору, и она только ссылка', () => {
  const { body } = split();
  assert.equal(body.split(DONATE_URL).length - 1, 1, 'адрес перевода встречается ровно один раз');
  assert.ok(body.includes(`const DONATE_URL = '${DONATE_URL}';`), 'адрес перевода объявлен константой DONATE_URL');
  assert.equal(body.split('DONATE_URL').length - 1, 2, 'DONATE_URL используется ровно один раз после объявления');
  assert.ok(body.includes("href: DONATE_URL, target: '_blank', rel: 'noopener noreferrer'"), 'DONATE_URL — только href ссылки');
});

test('код: в нём нет адресов, кроме emias.info', () => {
  const body = split().body.replace(DONATE_URL, '');
  const hosts = new Set([...body.matchAll(/(?:https?:|wss?:)?\/\/([a-z0-9-]+(?:\.[a-z0-9-]+)+)/gi)].map((m) => m[1].toLowerCase()));
  for (const h of hosts) assert.equal(h, 'emias.info', `в коде найден посторонний адрес: ${h}`);
});

test('код: fetch только по относительным путям ЕМИАС', () => {
  const { body } = split();
  const calls = [...body.matchAll(/\bfetch\s*\(\s*(.)/g)];
  assert.ok(calls.length > 0);
  for (const c of calls) {
    const rest = body.slice(c.index + c[0].length - 1, c.index + c[0].length + 1);
    assert.ok(/^['"`]\//.test(rest), `fetch должен начинаться с пути '/…' на том же сайте: ${body.slice(c.index, c.index + 60)}`);
  }
});

test('код: нет других способов отправить данные или выполнить чужой код', () => {
  const { body } = split();
  const banned = [
    [/XMLHttpRequest/, 'XMLHttpRequest'], [/sendBeacon/, 'navigator.sendBeacon'],
    [/\bWebSocket\b/, 'WebSocket'], [/\bEventSource\b/, 'EventSource'],
    [/\bGM_\w+|\bGM\.\w+/, 'API Tampermonkey (GM_*)'], [/\beval\s*\(/, 'eval'],
    [/new\s+Function\b/, 'new Function'], [/\bimport\s*\(/, 'import()'],
    [/importScripts/, 'importScripts'], [/new\s+Image\b/, 'new Image'],
    [/createElement\(\s*['"`](script|img|iframe|link|form)/i, 'вставка script/img/iframe/link/form'],
    [/\.(src|action|href)\s*=(?!=)/, 'присваивание .src/.action/.href'],
    [/window\.open\s*\(/, 'window.open'], [/(?:location\.href\s*=|location\.(assign|replace)\s*\()/, 'переход на другой адрес'],
  ];
  for (const [re, name] of banned) assert.ok(!re.test(body), `в коде появился запрещённый приём: ${name}`);
  // Единственный Worker — таймер из Blob (core/index.js), чтобы фоновая вкладка не засыпала.
  assert.equal((body.match(/new\s+Worker\s*\(/g) || []).length, 1, 'Worker допускается только один — таймер');
});
