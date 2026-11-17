const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { create } = require('../core/index.js');
const { createUiState } = require('../userscript/ui-state.js');
const doctors = require('./fixtures/doctors-li.json');
const schedule = require('./fixtures/schedule.json');

const modules = Object.assign({}, ...['util', 'errors', 'filters', 'session', 'api', 'discover', 'targets', 'runner']
  .map((name) => require('../core/' + name + '.js')));
const NOW = Date.parse('2026-09-23T06:00:00Z');
const OMS = Array(16).fill('0').join('');
const BIRTH = ['2000', '01', '01'].join('-');
const uiSource = fs.readFileSync(path.join(__dirname, '../userscript/ui-dom.js'), 'utf8');

function deferred() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}

function reply(json, status = 200) {
  return { ok: status >= 200 && status < 300, status, text: async () => JSON.stringify(json), json: async () => json };
}

async function environment({ mode = 'auto', scenario = 'shiftLab', intercept = async () => null } = {}) {
  const target = {
    id: 'lab', title: 'Кровь', scenario, mode, minLeadMs: 7200000, respectTravel: false,
    current: scenario === 'shiftLab' ? '2026-09-30T10:00:00+03:00' : null,
    source: { moId: 10000001, samplingTypeId: 1, appointmentId: 1, referralId: 555 },
  };
  const store = {
    'persist:sessionAuth': JSON.stringify({ accessToken: '"test"', refreshToken: '"refresh"', idToken: 'null', ctime: '"2026-09-23T06:00:00Z"' }),
    'persist:persist': JSON.stringify({ persistOmsNumber: JSON.stringify(OMS) }),
  };
  const storage = { getItem: (key) => store[key] ?? null, setItem: (key, value) => { store[key] = String(value); } };
  const calls = [];
  const events = [];
  const timer = { queue: [], schedule(ms, fn) { this.queue.push(fn); }, cancel() { this.queue.length = 0; } };
  let booked = null;
  const fetch = async (url, options) => {
    const body = JSON.parse(options.body || '{}');
    calls.push({ url, body });
    const intercepted = await intercept(url, body);
    if (intercepted) return intercepted;
    if (url.includes('refreshTokens')) return reply({ access_token: 'fresh', refresh_token: 'fresh-refresh', expires_in: 3600 });
    if (url.includes('policy/list')) return reply({ payload: { policies: [{ omsNumber: OMS, birthDate: BIRTH }] } });
    if (url.includes('getAppointmentReceptionsByPatient')) return reply({ payload: { appointment: booked ? [booked] : [] } });
    if (url.includes('getDoctorsInfoForLI')) return reply(doctors);
    if (url.includes('getAvailableResourceScheduleInfo')) return reply(schedule);
    if (url.includes('createAppointment') || url.includes('shiftAppointment')) {
      booked = { id: 77, startTime: body.startTime.slice(0, 19), endTime: body.endTime.slice(0, 19),
        lpuId: 10000001, lpuAddress: 'улица Тестовая, д. 2', toBM: { id: 1 } };
      return reply({ payload: {} });
    }
    throw new Error('Неожиданный запрос ' + url);
  };
  function createCore() {
    const core = create({ storage, fetch, modules, now: () => NOW, timer });
    core.on('*', (event) => events.push(event));
    return core;
  }
  const core = createCore();
  await core.init({ identity: { oms: OMS, birth: BIRTH } });
  core.setTargets([target]);
  const report = await core.dryRun();
  core.confirmDryRun(report.id);
  storage.setItem('emiasSlotHunter:config', JSON.stringify({ enabled: true, targets: [target], confirmedFor: report.targetsHash }));
  return { core, createCore, fetch, storage, calls, events, timer };
}

for (const restart of [false, true]) {
  test(`сквозной перенос: отказ после остановки не вызывает повтор с referralId (перезапуск ${restart})`, async () => {
    const entered = deferred();
    const response = deferred();
    const env = await environment({ intercept: async (url) => {
      if (url.includes('shiftAppointment')) { entered.resolve(); return response.promise; }
    } });
    await env.core.start();
    const tick = env.timer.queue.shift()();
    await entered.promise;
    env.core.stop();
    if (restart) await env.core.start();
    response.resolve(reply({ error: { code: 'TEST_NEEDS_REFERRAL' } }, 400));
    await tick;
    assert.equal(env.calls.filter((call) => call.url.includes('shiftAppointment')).length, 1);
    assert.ok(!env.events.some((event) => event.type === 'booked'));
  });
}

test('сквозной перенос: работающий поиск повторяет отказ с referralId и проверяет результат', async () => {
  let attempts = 0;
  const env = await environment({ intercept: async (url) => {
    if (url.includes('shiftAppointment') && ++attempts === 1) return reply({ error: { code: 'TEST_NEEDS_REFERRAL' } }, 400);
  } });
  await env.core.start();
  await env.timer.queue.shift()();
  const writes = env.calls.filter((call) => call.url.includes('shiftAppointment'));
  assert.equal(writes.length, 2);
  assert.equal(writes[1].body.referralId, 555);
  assert.ok(env.events.some((event) => event.type === 'booked'));
});

for (const stopDuring of ['response', 'refresh']) {
  test(`сквозная запись: 401 не повторяет запись после остановки во время ${stopDuring}`, async () => {
    const entered = deferred();
    const response = deferred();
    let attempts = 0;
    const env = await environment({ scenario: 'bookLab', intercept: async (url) => {
      if (url.includes('createAppointment') && ++attempts === 1) {
        if (stopDuring === 'response') { entered.resolve(); await response.promise; }
        return reply({}, 401);
      }
      if (url.includes('refreshTokens') && stopDuring === 'refresh') { entered.resolve(); await response.promise; }
    } });
    await env.core.start();
    const tick = env.timer.queue.shift()();
    await entered.promise;
    env.core.stop();
    response.resolve();
    await tick;
    assert.equal(attempts, 1);
    assert.ok(!env.events.some((event) => event.type === 'booked'));
  });
}

test('сквозная запись: работающий поиск обновляет токен после 401 и подтверждает запись', async () => {
  let attempts = 0;
  const env = await environment({ scenario: 'bookLab', intercept: async (url) => {
    if (url.includes('createAppointment') && ++attempts === 1) return reply({}, 401);
  } });
  await env.core.start();
  await env.timer.queue.shift()();
  assert.equal(attempts, 2);
  assert.equal(env.calls.filter((call) => call.url.includes('refreshTokens')).length, 1);
  assert.ok(env.events.some((event) => event.type === 'booked'));
});

// Минимальный DOM для запуска всего ui-dom.js. Клики проходят через обработчики
// настоящего интерфейса, а запросы — через реальные session/api/targets/runner.
class Element {
  constructor(tagName) {
    this.tagName = tagName;
    this.children = [];
    this.parentNode = null;
    this.listeners = {};
    this.className = '';
    this.hidden = false;
    this.ownText = '';
  }
  get firstChild() { return this.children[0] || null; }
  get textContent() { return this.ownText + this.children.map((child) => child.textContent).join(''); }
  set textContent(value) {
    for (const child of this.children) child.parentNode = null;
    this.children = [];
    this.ownText = '';
    if (this.tagName === '#text') this.ownText = String(value);
    else if (String(value)) {
      const text = new Element('#text');
      text.ownText = String(value);
      this.appendChild(text);
    }
  }
  appendChild(child) { child.parentNode = this; this.children.push(child); return child; }
  removeChild(child) {
    const index = this.children.indexOf(child);
    assert.ok(index >= 0);
    this.children.splice(index, 1);
    child.parentNode = null;
  }
  replaceChild(child, previous) {
    const index = this.children.indexOf(previous);
    assert.ok(index >= 0);
    this.children[index] = child;
    child.parentNode = this;
    previous.parentNode = null;
  }
  attachShadow() { this.shadowRoot = new Element('shadow-root'); return this.shadowRoot; }
  setAttribute(key, value) { this[key] = value; }
  addEventListener(type, handler) { this.listeners[type] = handler; }
  click() { return this.listeners.click(); }
  querySelectorAll(selector) {
    const matches = (node) => selector.startsWith('.') ? node.className.split(' ').includes(selector.slice(1)) : node.tagName === selector;
    return this.children.flatMap((child) => [...(matches(child) ? [child] : []), ...child.querySelectorAll(selector)]);
  }
  querySelector(selector) { return this.querySelectorAll(selector)[0] || null; }
}

async function mountUi(env) {
  const body = new Element('body');
  const timers = new Map();
  let nextTimer = 0;
  let core;
  const setTimer = (fn, ms) => { timers.set(++nextTimer, { fn, ms }); return nextTimer; };
  class FixedDate extends Date {
    constructor(...args) { super(...(args.length ? args : [NOW])); }
    static now() { return NOW; }
  }
  vm.runInNewContext(uiSource, {
    window: { localStorage: env.storage, fetch: env.fetch },
    document: { body, createElement: (tag) => new Element(tag), createTextNode: (text) => {
      const node = new Element('#text'); node.textContent = text; return node;
    } },
    EmiasCore: { create: () => { core = env.createCore(); return core; }, createUiState },
    Date: FixedDate, console,
    setTimeout: setTimer, setInterval: setTimer, clearTimeout: (id) => timers.delete(id), clearInterval: (id) => timers.delete(id),
  });
  await new Promise(setImmediate);
  assert.equal(core.status().running, true, 'интерфейс возобновил поиск из настроек');
  const root = body.children[0].shadowRoot;
  const button = (text) => {
    const found = root.querySelectorAll('button').find((node) => node.textContent.includes(text));
    assert.ok(found, 'кнопка ' + text);
    return found;
  };
  return { core, root, button, timers };
}

for (const outcome of ['cancelled', 'refused', 'booked', 'restarted']) {
  test(`интерфейс → API → интерфейс: подтверждение и ${outcome}`, async () => {
    const entered = deferred();
    const response = deferred();
    let blocked = false;
    const env = await environment({ mode: 'confirm', scenario: 'bookLab', intercept: async (url) => {
      if (!blocked) return;
      if (outcome === 'booked' && url.includes('createAppointment')) { entered.resolve(); await response.promise; }
      if (outcome !== 'booked' && url.includes('getAppointmentReceptionsByPatient')) { entered.resolve(); await response.promise; }
      if (outcome === 'refused' && url.includes('createAppointment')) return reply({ error: { code: 'TEST_REJECTED' } }, 400);
    } });
    const ui = await mountUi(env);
    await env.timer.queue.shift()();
    blocked = true;
    const answer = ui.button('Записать').click();
    await entered.promise;
    if (outcome !== 'refused') {
      ui.root.querySelector('.esh-badge').click();
      ui.button('Остановить поиск').click();
      assert.equal(ui.root.querySelector('.esh-confirms').children.length, 0, 'карточка исчезает сразу при остановке');
    }
    if (outcome === 'restarted') {
      blocked = false;
      await ui.core.start();
      await env.timer.queue.shift()();
      assert.equal(ui.root.querySelector('.esh-confirms').children.length, 1);
    }
    response.resolve();
    await answer;
    const cards = ui.root.querySelector('.esh-confirms');
    const writes = env.calls.filter((call) => call.url.includes('createAppointment'));
    if (outcome === 'cancelled') {
      assert.equal(writes.length, 0);
      assert.equal(cards.children.length, 0);
      assert.equal(ui.root.querySelector('.esh-badge').textContent, '🎯 Настроить');
      assert.ok(![...ui.timers.values()].some((timer) => timer.ms === 7000));
    } else if (outcome === 'restarted') {
      assert.equal(writes.length, 0);
      assert.equal(cards.children.length, 1, 'старый ответ сохраняет карточку нового запуска');
      assert.ok(![...ui.timers.values()].some((timer) => timer.ms === 7000));
    } else if (outcome === 'refused') {
      assert.equal(writes.length, 1);
      assert.match(cards.textContent, /записать не удалось/);
    } else {
      assert.equal(writes.length, 1);
      assert.ok(env.events.some((event) => event.type === 'booked'));
      assert.equal(cards.children.length, 0);
      assert.match(ui.root.querySelector('.esh-badge').textContent, /Записано/);
    }
  });
}
