// core/index.js — сборка всех модулей ядра (util, errors, filters, session,
// api, discover, targets, runner) в единый объект EmiasHunter, плюс события
// и координация «одна активная вкладка» поверх channel.
//
// Важно: в отличие от остальных модулей ядра, этот файл не подключает своих
// соседей напрямую через модульную систему Node — так собранный userscript
// (dist/*.user.js) остался бы с таким подключением внутри, а тест сборки
// (Task 1) явно это запрещает. Вместо этого create() принимает соседей через
// параметр modules — плоский объект со всеми фабриками (createUtil,
// createErrors, ..., createRunner). Если modules не передан, берём
// globalThis.EmiasCore: именно туда каждый core/*.js в браузерной сборке
// кладёт себя через `Object.assign(root.EmiasCore, api)`, и после склейки
// всех файлов в одну IIFE (scripts/build.js) там уже лежит ровно тот же набор
// фабрик. В тестах modules собирают явно, каждый сосед по отдельности, — так
// ядро остаётся без прямого подключения модулей, а тест рабочим.
(function (root) {
  'use strict';

  // Нижняя граница интервала проверок — 20 секунд. Это жёсткий пол: даже
  // если снаружи передадут config с меньшими slowMs/minIntervalMs (случайно
  // или по недосмотру), фактический интервал раннера ниже этого порога не
  // опустится — чтобы не долбить ЕМИАС слишком часто.
  const MIN_INTERVAL_MS = 20000;

  // Раз в столько шлём в channel heartbeat работающей вкладки — см.
  // createSharedTimer ниже и Task 12c.
  const ALIVE_INTERVAL_MS = 20000;

  // identityFromStorage() не смогла определить полис и/или дату рождения —
  // ни через idToken/policy/list, ни явным opts.identity. Отдельное имя (как
  // SessionError в core/api.js) даёт userscript/ui-dom.js отличить этот
  // случай от настоящей потери сессии: там нужно другое, не вводящее в
  // заблуждение объяснение (см. Task после review бага с датой рождения).
  class IdentityError extends Error {
    constructor(message) {
      super(message);
      this.name = 'IdentityError';
    }
  }

  // Настоящий timer (что в браузере — воркер с единственным setTimeout
  // внутри, что в тестовой заглушке) держит только ОДНО отложенное
  // срабатывание одновременно — ровно то, что нужно раннеру: тики идут
  // строго по одному, и schedule()/cancel() раннера рассчитаны именно на
  // это. Но пока экземпляр работает, параллельно нужен ещё и независимый
  // периодический heartbeat (раз в ALIVE_INTERVAL_MS, что бы ни было
  // настроено раннеру в slowMs) — двум одновременным потребителям одного
  // и того же timer.schedule() просто наступить друг другу на pending-
  // колбэк нельзя. createSharedTimer делит единственный слот настоящего
  // timer между двумя логическими под-таймерами: tick — разовое
  // срабатывание, интерфейс которого (schedule/cancel) отдаём раннеру
  // взамен настоящего timer как есть; alive — периодическое, включается и
  // выключается самим core/index.js. В любой момент настоящий timer взведён
  // на ближайшее из двух отложенных срабатываний; сработав, будим все
  // под-таймеры, чьё время пришло, и переармируем.
  function createSharedTimer(realTimer, now) {
    const slots = { tick: null, alive: null }; // { fn, dueAt, everyMs (0 = разовый) }
    // Время (в шкале now()), на которое сейчас взведён настоящий timer — а
    // не заново считанный now() в момент срабатывания. В браузере разницы
    // почти нет (настоящее время и так успело дойти до dueAt), а вот в
    // тестах now() обычно фиксированная функция (время не «идёт» само по
    // себе, timer.schedule()/cancel() — просто заглушка с очередью
    // колбэков) — сверяться с повторным now() там было бы неверно: заново
    // считанное now() всегда останется МЕНЬШЕ dueAt, и ни один под-таймер
    // никогда не считался бы наступившим.
    let armedAt = null;

    function armSoonest() {
      let soonest = null;
      for (const key of Object.keys(slots)) {
        const s = slots[key];
        if (s && (soonest === null || s.dueAt < soonest)) soonest = s.dueAt;
      }
      // Сначала снимаем прежнее отложенное срабатывание, потом (если есть
      // что ждать) взводим новое — ровно ОДНО пере-взведение настоящего
      // timer на вызов armSoonest(), а не «ещё один поверх старого». Само
      // по себе schedule() настоящего Worker-таймера тоже заменяет
      // предыдущий отложенный вызов, но так это верно и для простых
      // тестовых заглушек timer (очередь без автозамены).
      realTimer.cancel();
      if (soonest === null) { armedAt = null; return; }
      armedAt = soonest;
      realTimer.schedule(Math.max(0, soonest - now()), onFire);
    }

    function onFire() {
      const t = armedAt === null ? now() : armedAt;
      for (const key of Object.keys(slots)) {
        const s = slots[key];
        if (!s || s.dueAt > t) continue;
        slots[key] = s.everyMs ? { ...s, dueAt: t + s.everyMs } : null;
        s.fn();
      }
      armSoonest();
    }

    return {
      tick: {
        schedule(ms, fn) { slots.tick = { fn, dueAt: now() + ms, everyMs: 0 }; armSoonest(); },
        cancel() { slots.tick = null; armSoonest(); },
      },
      startAlive(fn) { slots.alive = { fn, dueAt: now() + ALIVE_INTERVAL_MS, everyMs: ALIVE_INTERVAL_MS }; armSoonest(); },
      stopAlive() { slots.alive = null; armSoonest(); },
    };
  }

  function create({ storage, fetch, now = Date.now, timer, channel = null, config = {}, modules, instanceId } = {}) {
    const M = modules || root.EmiasCore;
    if (!M) {
      throw new Error('core/index.js: не переданы модули ядра (modules) и globalThis.EmiasCore недоступен');
    }

    const util = M.createUtil();
    const errors = M.createErrors();
    const filters = M.createFilters(util);
    const session = M.createSession({ storage, fetch, now });
    const api = M.createApi({ session, errors, fetch, now });
    const discover = M.createDiscover({ api, today: () => util.mskDate(new Date(now())) });
    const targets = M.createTargets({ api, filters, util });

    // Простая шина событий: подписка по типу события ('log', 'found',
    // 'booked', 'needConfirm', 'sessionLost', 'stale', 'slept', 'standby', ...)
    // и подписка на всё сразу через '*'.
    const listeners = {};
    const emit = (type, payload) => {
      for (const fn of listeners[type] || []) fn(payload);
      for (const fn of listeners['*'] || []) fn({ type, payload });
    };

    const safeConfig = { slowMs: 20000, minIntervalMs: 20000, refreshAt: 0.6, sleepFactor: 3, staleFactor: 3, ...config };
    // Жёсткий пол применяем уже ПОСЛЕ разворачивания пользовательского config —
    // runner.js берёт Math.max(minIntervalMs, slowMs), поэтому если оба поля
    // занижены одновременно, пол внутри runner.js не спасёт.
    safeConfig.minIntervalMs = Math.max(MIN_INTERVAL_MS, safeConfig.minIntervalMs);
    safeConfig.slowMs = Math.max(MIN_INTERVAL_MS, safeConfig.slowMs);

    // Heartbeat нужен только когда координация вообще включена (есть
    // channel) — без него делить слот timer не с кем, раннер получает
    // настоящий timer как есть.
    const sharedTimer = channel ? createSharedTimer(timer, now) : null;
    const runner = M.createRunner({ targets, api, session, timer: sharedTimer ? sharedTimer.tick : timer, now, emit, config: safeConfig });

    // «Одна активная вкладка». Идентификатор экземпляра — по умолчанию
    // случайный (можно задать явно через instanceId — понадобилось тестам,
    // где важен детерминированный порядок арбитража). Побеждает БОЛЬШИЙ
    // идентификатор, а не тот, кто стартовал последним: при асинхронной
    // доставке (настоящий BroadcastChannel именно такой) сравнение «кто
    // последний» не работает — при одновременном старте обе вкладки могут
    // одновременно оказаться running и обе получить чужой claim, и тогда обе
    // остановились бы, если бы правило было «останавливаюсь при любом чужом
    // claim». Вместо этого:
    //  - если я сейчас работаю и получил claim с БОЛЬШИМ id — я проиграл,
    //    останавливаюсь и сообщаю об этом событием standby;
    //  - если я сейчас работаю и получил claim с МЕНЬШИМ id — я не
    //    останавливаюсь, а рассылаю свой claim ещё раз, чтобы тот экземпляр
    //    увидел больший id и остановился сам (без этого при одновременном
    //    старте могли бы остаться работающими оба);
    //  - если я сейчас не работаю — не реагирую вовсе (в т.ч. не отвечаю
    //    своим claim), иначе неработающие вкладки бы бесконечно перекидывались
    //    сообщениями между собой.
    // Если channel не передан (например, тесты или окружение без
    // BroadcastChannel), считаем себя единственными и координацию не включаем.
    const myId = instanceId || Math.random().toString(36).slice(2);

    // Heartbeat лидера (Task 12c): пока эта вкладка активно работает, она
    // раз в ALIVE_INTERVAL_MS шлёт { type: 'alive', from: myId } — самому
    // сообщению ни на что, кроме отметки времени у чужих вкладок, влиять не
    // положено (обработчик claim ниже не меняется). leaderSeenAtTs — время
    // последнего чужого alive ИЛИ claim; без channel координации нет вовсе,
    // и leaderSeenAt() всегда отдаёт 0. Используется в userscript/ui-dom.js:
    // standby-вкладка запускает дорогой startFromSavedConfig() только если
    // давно ничего не слышала от лидера, а не раз в минуту вслепую.
    let leaderSeenAtTs = 0;
    function sendAlive() {
      // Раннер мог остановиться сам (например, needDryRun на тике) в обход
      // stop()/арбитража — в этом случае heartbeat самоликвидируется, а не
      // продолжает выдавать вкладку за лидера, который на деле не работает.
      if (!runner.status().running) { sharedTimer.stopAlive(); return; }
      channel.postMessage({ type: 'alive', from: myId });
    }
    function startAlive() { if (sharedTimer) sharedTimer.startAlive(sendAlive); }
    function stopAlive() { if (sharedTimer) sharedTimer.stopAlive(); }

    if (channel) {
      channel.onmessage = (msg) => {
        const m = msg && msg.data ? msg.data : msg;
        if (!m || m.from === myId) return;
        // И alive, и claim от чужой вкладки означают «лидер сейчас жив» —
        // это ЕДИНСТВЕННОЕ, на что влияет alive; арбитраж по claim ниже
        // остаётся прежним.
        if (m.type === 'alive' || m.type === 'claim') leaderSeenAtTs = now();
        if (m.type !== 'claim') return;
        if (!runner.status().running) return;
        if (m.from > myId) {
          runner.stop();
          stopAlive();
          emit('standby', { by: m.from });
        } else if (m.from < myId) {
          channel.postMessage({ type: 'claim', from: myId });
        }
      };
    }

    // Настоящий idToken ЕМИАС даты рождения не содержит (проверено на живой
    // вкладке 2026-09-24: поля jti, exp, ua_ver, trusted, iat, sub, aud, amr,
    // sid, iss, ua_id, FirstName — birthdate/birth_date среди них нет).
    // Полис при этом в хранилище есть (persist:persist.persistOmsNumber).
    // Сам сайт берёт дату рождения из ответа GET /api-eip/v2/policy/list —
    // если её не нашлось в idToken, спрашиваем тот же список и берём дату из
    // полиса, чей omsNumber совпал с persistOmsNumber (в ответе может быть
    // несколько полисов, например старый и текущий). Дату рождения нигде не
    // сохраняем — она живёт только в session.identity() (в памяти), как и
    // раньше для явно введённой.
    async function birthFromPolicyList(oms) {
      if (!oms) return null; // сверять не с чем — не обращаемся вообще
      const r = await api.get('v2/policy/list');
      if (!r.ok || !r.json) return null;
      const policies = (r.json.payload && r.json.payload.policies) || [];
      const mine = policies.find((p) => p && p.omsNumber === oms);
      return (mine && String(mine.birthDate || '').slice(0, 10)) || null;
    }

    // Полис и дату рождения предпочтительно передают явно (opts.identity) —
    // например, их вводит пользователь в интерфейсе. Если их нет, пробуем
    // угадать из хранилища сайта, а если даты там нет — из policy/list; любая
    // ошибка разбора здесь не должна валить init() — просто вернём null и
    // вызывающий код попросит ввести их. Ошибка сессии (SessionError из
    // api.get) наоборот НЕ гасится — это не «не нашли данные», а настоящая
    // потеря входа, и она должна дойти до вызывающего кода как есть.
    async function identityFromStorage() {
      let oms = null;
      try { oms = JSON.parse(JSON.parse(storage.getItem('persist:persist')).persistOmsNumber); } catch (e) { oms = null; }
      let birth = null;
      try {
        const t = JSON.parse(JSON.parse(storage.getItem('persist:sessionAuth')).idToken);
        const payload = JSON.parse(decodeURIComponent(escape(atob(t.split('.')[1].replace(/-/g, '+').replace(/_/g, '/')))));
        birth = (payload.birthdate || payload.birth_date || '').slice(0, 10) || null;
      } catch (e) { birth = null; }
      if (!birth) birth = await birthFromPolicyList(oms);
      return { oms, birth };
    }

    // Залогинен ли сам сайт. После выхода ЕМИАС стирает токены и полис, но
    // наша копия токенов (emiasSlotHunter:auth) остаётся и session.read() её
    // принимает — без этой проверки человек видел бы «не нашла полис» вместо
    // «войдите».
    function siteLoggedIn() {
      try { return !!JSON.parse(JSON.parse(storage.getItem('persist:sessionAuth')).accessToken); } catch (e) { return false; }
    }

    async function init(opts = {}) {
      // Бросает понятную ошибку, если входа в ЕМИАС нет вовсе — не глотаем.
      session.read();
      if (!opts.identity && !siteLoggedIn()) throw new Error('нет входа в ЕМИАС: войдите на сайте и попробуйте снова');
      const id = opts.identity || await identityFromStorage();
      if (!id.oms || !id.birth) {
        throw new IdentityError('не удалось определить полис и дату рождения — откройте раздел «Записи» на сайте и попробуйте снова');
      }
      session.setIdentity(id);
      return { ok: true };
    }

    // Список целей нормализуем перед передачей раннеру: keepImproving по
    // умолчанию включён (искать более удобный слот и после первой удачной
    // записи/переноса), кроме bookReferral — этот сценарий в v0.1 не
    // поддержан целиком (см. targets.js), «улучшать» там нечего. Явное
    // keepImproving: false в цели отключает поведение.
    function normalizeTarget(t) {
      return { ...t, keepImproving: t.keepImproving !== false && t.scenario !== 'bookReferral' };
    }

    return {
      init,
      discover: () => discover.list(),
      setTargets: (list) => runner.setTargets(list.map(normalizeTarget)),
      dryRun: () => runner.dryRun(),
      confirmDryRun: (id) => runner.confirmDryRun(id),
      start: async () => {
        // Гейт холостого прогона проверяем ПЕРВЫМ: если runner.start() бросит
        // (прогон не подтверждён), claim в channel вообще не уходит — иначе
        // неудачная попытка старта во второй вкладке останавливала бы первую,
        // которая работает легитимно.
        await runner.start();
        if (channel) {
          channel.postMessage({ type: 'claim', from: myId });
          startAlive();
        }
        return { ok: true };
      },
      stop: () => { stopAlive(); return runner.stop(); },
      answer: (targetId, decision) => runner.answer(targetId, decision),
      status: () => runner.status(),
      leaderSeenAt: () => leaderSeenAtTs,
      on: (type, fn) => { (listeners[type] = listeners[type] || []).push(fn); },
    };
  }

  const api = { create };
  if (typeof module === 'object' && module.exports) module.exports = api;
  else { root.EmiasCore = root.EmiasCore || {}; Object.assign(root.EmiasCore, api); }
})(typeof globalThis !== 'undefined' ? globalThis : this);
