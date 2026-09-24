// userscript/ui-dom.js — видимый интерфейс: значок, мастер настройки из 4
// экранов и возобновление поиска после перезагрузки страницы. Единственный
// самозапускающийся модуль — все остальные части ядра только складывают
// себя в globalThis.EmiasCore, а этот файл их использует и рисует DOM.
//
// Простых людей без технической подготовки в тексте интерфейса не должно
// пугать ни одно слово — весь пользовательский текст на обычном русском.
(function () {
  'use strict';

  if (typeof window === 'undefined' || typeof document === 'undefined') return;
  // На всякий случай не даём смонтироваться дважды (например, если скрипт
  // случайно оказался подключён более одного раза).
  if (window.__emiasSlotHunterMounted) return;
  window.__emiasSlotHunterMounted = true;

  const { create, createUiState } = globalThis.EmiasCore;
  const ui = createUiState();
  const storage = window.localStorage;

  /* ==================== состояние мастера (переменная модуля) ==================== */
  // Ничего отсюда не пишется в хранилище раньше шага 3 — см. requirements.
  const wizard = {
    open: false,
    step: 0,
    options: [],        // результат discover()
    selected: [],        // выбранные варианты (option) с шага 1
    forms: {},           // option.id -> форма условий с шага 2
    report: null,         // результат dryRun() для текущих целей
    builtTargets: null,    // цели, переданные в core.setTargets перед прогоном
    checked: false,         // галочка «Я проверил(а)» на шаге 3
    loading: false,          // идёт discover()/dryRun()
    loadError: null,          // текст ошибки связи + что повторять
  };

  let core = null;
  let badgeState = { kind: 'init', text: '…', detail: '' };
  let panelMode = null; // 'wizard' | 'status' | 'recovery' | 'standby' | null
  const logEvents = [];
  const pendingConfirms = {}; // targetId -> { payload, expiresAt, tickId }
  // Узлы карточек «записать не удалось» (Task 12c minor): answerConfirm их
  // выводит УЖЕ после того, как отвязал карточку от pendingConfirms, и сама
  // держит на экране ещё RESULT_NOTE_MS — clearAllConfirmCards() их не
  // видит, если не следить за ними отдельно (см. ниже).
  const failedConfirmNodes = [];
  let statusRefreshId = null;
  let recoveryWatchId = null;
  let standbyRetryId = null;
  let badgeRevertId = null;
  let preBookedBadge = null; // значок до последнего «Записано», чтобы вернуть текст, а не только цвет
  // C-1: отпечаток подтверждённых целей, по которым работает ЭТА вкладка.
  // Работающая вкладка сверяет его с настройками (startStatusRefresh) —
  // если другая вкладка перенастроила или остановила поиск, эта уступает.
  let runningFor = null;
  // I-1: номер попытки запуска по сохранённым настройкам. «Остановить»,
  // открытие мастера и новая попытка увеличивают его — старая попытка,
  // дождавшись холостого прогона, видит, что устарела, и не стартует.
  let startAttempt = 0;
  // I-3: временное пояснение к зелёному значку (например, «записать не
  // удалось»), чтобы обновление раз в 5 секунд не стирало его сразу.
  let badgeNote = null; // { text, until }
  const foundCount = {}; // targetId -> сколько событий found пришло (чтобы не дублировать лог)

  const dom = {}; // ссылки на элементы внутри shadowRoot

  /* ==================== маленький помощник для сборки DOM ==================== */
  // Строим элементы без innerHTML — так текст из ответов ЕМИАС (адреса,
  // названия) никогда не интерпретируется как разметка.
  function h(tag, attrs, children) {
    const node = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs || {})) {
      if (v === null || v === undefined || v === false) continue;
      if (k === 'class') node.className = v;
      else if (k === 'text') node.textContent = v;
      else if (k.startsWith('on') && typeof v === 'function') node.addEventListener(k.slice(2), v);
      else if (k === 'checked' || k === 'disabled' || k === 'hidden' || k === 'open') node[k] = v;
      else node.setAttribute(k, v);
    }
    for (const c of [].concat(children || [])) {
      if (c === null || c === undefined) continue;
      node.appendChild(typeof c === 'string' || typeof c === 'number' ? document.createTextNode(String(c)) : c);
    }
    return node;
  }

  function clear(node) { while (node.firstChild) node.removeChild(node.firstChild); }

  function hhmm(ts) {
    if (!ts) return '—';
    const d = new Date(ts);
    return String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0');
  }

  /* ==================== таймер ядра: Web Worker из Blob ==================== */
  // Ровно два метода — schedule(ms, fn) и cancel() — как требует core/index.js.
  // Если Worker создать не удалось (например, страница это запрещает через
  // Content-Security-Policy), тихо переключаемся на обычный setTimeout.
  function createWorkerTimer() {
    let worker = null;
    let cb = null;
    let lastMs = 0;
    let scheduledAt = 0;
    let fallbackId = null;
    let usingFallback = false;

    function fallbackSchedule(ms, fn) {
      cb = fn;
      fallbackId = setTimeout(fn, ms);
    }

    // I9: Worker может упасть уже после успешного создания (CSP, старый
    // Safari) — тогда проверки молча останавливались бы навсегда при
    // зелёном значке. Переключаемся на setTimeout и перепланируем именно
    // тот вызов, который уже был отложен в воркере, на оставшееся время.
    function switchToFallback() {
      if (usingFallback) return;
      usingFallback = true;
      try { if (worker) worker.terminate(); } catch (e) { /* воркер уже недоступен */ }
      worker = null;
      if (cb) {
        const remaining = Math.max(0, lastMs - (Date.now() - scheduledAt));
        fallbackSchedule(remaining, cb);
      }
    }

    try {
      const code = "let t=null; onmessage=function(e){ clearTimeout(t); var ms=e.data&&e.data.ms; if(typeof ms==='number'&&ms>=0){ t=setTimeout(function(){ postMessage(1); }, ms);} };";
      const blob = new Blob([code], { type: 'application/javascript' });
      const url = URL.createObjectURL(blob);
      worker = new Worker(url);
      // Minor: не оставляем blob-URL висеть — Worker уже получил код к этому
      // моменту, дальше URL не нужен.
      URL.revokeObjectURL(url);
      worker.onmessage = () => { if (cb) cb(); };
      worker.onerror = () => switchToFallback();
      return {
        schedule(ms, fn) {
          if (usingFallback) { fallbackSchedule(ms, fn); return; }
          cb = fn; lastMs = ms; scheduledAt = Date.now();
          worker.postMessage({ ms });
        },
        cancel() {
          cb = null;
          if (usingFallback) { if (fallbackId) clearTimeout(fallbackId); fallbackId = null; return; }
          if (worker) worker.postMessage({ ms: -1 });
        },
      };
    } catch (e) {
      return {
        schedule(ms, fn) { fallbackSchedule(ms, fn); },
        cancel() { if (fallbackId) clearTimeout(fallbackId); fallbackId = null; cb = null; },
      };
    }
  }

  /* ==================== звук и уведомление ==================== */
  function playBeep() {
    try {
      const Ctx = window.AudioContext || window.webkitAudioContext;
      const ctx = new Ctx();
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.frequency.value = 880;
      gain.gain.value = 0.2;
      osc.connect(gain).connect(ctx.destination);
      osc.start();
      osc.stop(ctx.currentTime + 0.25);
      osc.onended = () => ctx.close();
    } catch (e) { /* звук необязателен, тихо игнорируем */ }
  }

  // I8: раньше звук и уведомление были только у booked — у needConfirm их не
  // было, хотя на ответ всего 60 секунд, а вкладка обычно фоновая. Общая
  // функция используется для обоих случаев.
  // Minor: Notification.requestPermission() в старых Safari может не
  // вернуть промис вовсе — проверяем это и оборачиваем в try/catch с .catch,
  // чтобы такой браузер не ронял обработчик целиком.
  function notify(title, body) {
    playBeep();
    if (typeof Notification === 'undefined' || typeof Notification.requestPermission !== 'function') return;
    const show = () => {
      try { new Notification(title, { body }); } catch (e) { /* уведомление необязательно */ }
    };
    try {
      if (Notification.permission === 'granted') { show(); return; }
      if (Notification.permission === 'denied') return;
      // Старый callback-стиль и новый promise-стиль могут сработать оба —
      // handled не даёт показать уведомление дважды.
      let handled = false;
      const onResult = (perm) => { if (handled) return; handled = true; if (perm === 'granted') show(); };
      const p = Notification.requestPermission(onResult);
      if (p && typeof p.then === 'function') p.then(onResult).catch(() => { /* уведомление необязательно */ });
    } catch (e) { /* уведомление необязательно */ }
  }

  /* ==================== стили значка и мастера (только внутри shadowRoot) ==================== */
  function styles() {
    return `
      :host, * { box-sizing: border-box; font-family: -apple-system, Segoe UI, Roboto, Arial, sans-serif; }
      .esh-root { position: fixed; right: 16px; bottom: 16px; z-index: 999999; display: flex; flex-direction: column; align-items: flex-end; gap: 8px; }
      .esh-badge { cursor: pointer; border: none; border-radius: 20px; padding: 10px 16px; font-size: 14px; color: #fff; background: #5b6472; box-shadow: 0 2px 8px rgba(0,0,0,.25); white-space: nowrap; }
      .esh-badge.k-idle, .esh-badge.k-init { background: #5b6472; }
      .esh-badge.k-running, .esh-badge.k-resuming { background: #2e9e5b; }
      .esh-badge.k-booked { background: #e08a2b; }
      .esh-badge.k-standby { background: #3a7bd5; }
      .esh-badge.k-paused { background: #8a6d3b; }
      .esh-badge.k-needLogin, .esh-badge.k-needIdentity, .esh-badge.k-sessionLost, .esh-badge.k-stale, .esh-badge.k-resumeError, .esh-badge.k-needDryRun { background: #d64545; }
      .esh-sub { display: block; font-size: 11px; opacity: .85; font-weight: normal; }
      .esh-card { width: 320px; max-height: 70vh; overflow: auto; background: #fff; color: #222; border-radius: 12px; box-shadow: 0 4px 20px rgba(0,0,0,.3); padding: 14px; }
      .esh-card h3 { margin: 0 0 8px; font-size: 16px; }
      .esh-card p { margin: 4px 0; font-size: 13px; line-height: 1.4; }
      .esh-row { display: flex; align-items: center; gap: 8px; margin: 6px 0; }
      .esh-opt { border: 1px solid #e0e0e0; border-radius: 8px; padding: 8px; margin-bottom: 8px; }
      .esh-opt.disabled { opacity: .55; }
      .esh-opt .title { font-weight: 600; font-size: 13px; }
      .esh-opt .meta { font-size: 12px; color: #666; }
      .esh-opt .reason { font-size: 12px; color: #a33; }
      .esh-field { display: block; font-size: 12px; margin: 6px 0 2px; color: #444; }
      .esh-card input[type=text], .esh-card input[type=date], .esh-card input[type=time] { width: 100%; padding: 4px 6px; margin-top: 4px; font-size: 13px; border: 1px solid #ccc; border-radius: 6px; }
      .esh-btns { display: flex; gap: 8px; margin-top: 12px; }
      .esh-btn { flex: 1; padding: 8px 10px; border-radius: 8px; border: 1px solid #ccc; background: #f4f4f4; cursor: pointer; font-size: 13px; }
      .esh-btn.primary { background: #2e7dd7; color: #fff; border-color: #2e7dd7; }
      .esh-btn.primary:disabled { background: #a9c6ea; border-color: #a9c6ea; cursor: not-allowed; }
      .esh-btn.danger { background: #d64545; color: #fff; border-color: #d64545; }
      .esh-warn { color: #a33; font-size: 12px; }
      .esh-note { color: #666; font-size: 12px; }
      .esh-confirm { width: 300px; background: #fff8ea; border: 1px solid #e0b84b; border-radius: 10px; padding: 10px; margin-bottom: 8px; box-shadow: 0 2px 10px rgba(0,0,0,.2); }
      .esh-slept { width: 300px; background: #eef2ff; border: 1px solid #98a6e0; border-radius: 10px; padding: 10px; display: flex; justify-content: space-between; gap: 8px; }
      /* .esh-slept задаёт свой display: flex — этим он перебивает display:
         none из стандартного правила [hidden] (авторское правило с любым
         указанным display выигрывает у правила User Agent), и пустая рамка
         остаётся видна поверх значка, пока карточку не заполнили текстом.
         Возвращаем скрытие явно. */
      .esh-slept[hidden] { display: none; }
      .esh-log { font-size: 12px; max-height: 160px; overflow: auto; background: #fafafa; border: 1px solid #eee; border-radius: 6px; padding: 6px; }
      .esh-log div { margin-bottom: 4px; }
      details.esh-more summary { cursor: pointer; font-size: 12px; color: #2e7dd7; margin-top: 6px; }
    `;
  }

  /* ==================== создание корневого элемента (один раз) ==================== */
  function mountBadge() {
    const host = document.createElement('div');
    host.id = 'emias-slot-hunter-host';
    const shadow = host.attachShadow({ mode: 'open' });
    shadow.appendChild(h('style', { text: styles() }));

    const root = h('div', { class: 'esh-root' });
    const badge = h('button', { class: 'esh-badge k-init', onclick: onBadgeClick, text: 'ЕМИАС: охотник за слотами' });
    const confirms = h('div', { class: 'esh-confirms' });
    const slept = h('div', { class: 'esh-slept', hidden: true });
    const panel = h('div', { class: 'esh-card', hidden: true });

    root.appendChild(confirms);
    root.appendChild(slept);
    root.appendChild(panel);
    root.appendChild(badge);
    shadow.appendChild(root);
    document.body.appendChild(host);

    Object.assign(dom, { shadow, root, badge, confirms, slept, panel });
  }

  /* ==================== значок ==================== */
  function setBadge(next) {
    badgeState = { ...badgeState, ...next };
    renderBadge(badgeState);
  }

  function renderBadge(status) {
    const b = dom.badge;
    b.className = 'esh-badge k-' + status.kind;
    clear(b);
    b.appendChild(document.createTextNode(status.text));
    if (status.detail) b.appendChild(h('span', { class: 'esh-sub', text: status.detail }));
  }

  function onBadgeClick() {
    if (panelMode) { hidePanel(); return; }
    const kind = badgeState.kind;
    // C2 п.2: sessionLost/stale — мастер не открываем, только объяснение и
    // кнопка «Остановить поиск» (сама работа тем временем продолжается сама
    // по себе и восстановится молча через startRecoveryWatch()).
    if (kind === 'sessionLost' || kind === 'stale') { openRecoveryPanel(); return; }
    if (kind === 'needLogin' || kind === 'needIdentity') { retryLogin(); return; }
    if (kind === 'resumeError') { resumeIfEnabled(); return; }
    if (kind === 'standby') { openStandbyPanel(); return; }
    if (kind === 'running' || kind === 'resuming' || kind === 'booked') { openStatusPanel(); return; }
    // needDryRun и любой прочий случай — безопаснее всего начать настройку заново.
    openWizardGuarded(1);
  }

  // C2 п.2: открытие мастера, когда ядро всё ещё работает по старым целям
  // (например, кликнули «Настроить» мимо статус-панели), сначала
  // останавливает цикл — иначе setTargets() на шаге 3 обнулит подтверждение
  // прямо во время работающего поиска.
  //
  // C-1 п.2: заодно помечаем паузу в настройках — вкладки в standby не
  // должны подхватывать поиск по старым целям, пока здесь меняют условия, а
  // работающая вкладка (если поиск шёл не здесь) по этой метке уступает.
  // Пауза снимается в onStart после нового подтверждения.
  function openWizardGuarded(step) {
    startAttempt++; // незаконченная попытка возобновления больше не стартует (I-1)
    stopRecoveryWatch(); // M-2
    if (core.status().running) {
      core.stop();
      runningFor = null;
      stopStatusRefresh();
      clearAllConfirmCards();
      setBadge({ kind: 'paused', text: '⏸ Поиск приостановлен', detail: 'нужен новый холостой прогон' });
    }
    // Настройка идёт в этой вкладке — повтор standby не должен подменять
    // цели мастера в ядре и стартовать сам.
    if (standbyRetryId) { clearInterval(standbyRetryId); standbyRetryId = null; }
    if (badgeState.kind === 'standby') setBadge({ kind: 'paused', text: '⏸ Поиск приостановлен', detail: 'идёт настройка' });
    const cfg = ui.loadConfig(storage);
    if (cfg && cfg.enabled && !cfg.paused) ui.saveConfig(storage, { ...cfg, paused: true, pausedAt: Date.now() });
    openWizard(step);
  }

  function showPanel() { dom.panel.hidden = false; }
  function hidePanel() { dom.panel.hidden = true; panelMode = null; wizard.open = false; }

  /* ==================== панель объяснения при sessionLost/stale ==================== */
  function openRecoveryPanel() { panelMode = 'recovery'; showPanel(); renderRecoveryPanel(); }

  function renderRecoveryPanel() {
    clear(dom.panel);
    const isStale = badgeState.kind === 'stale';
    dom.panel.appendChild(h('h3', { text: isStale ? 'Давно нет ответа от ЕМИАС' : 'Нужно войти в ЕМИАС' }));
    dom.panel.appendChild(h('p', { text: 'Войдите в ЕМИАС в соседней вкладке — поиск продолжится сам, ничего перезапускать не нужно.' }));
    if (badgeState.detail) dom.panel.appendChild(h('p', { class: 'esh-note', text: badgeState.detail }));
    dom.panel.appendChild(h('div', { class: 'esh-btns' }, [
      h('button', { class: 'esh-btn danger', text: 'Остановить поиск', onclick: onStop }),
    ]));
  }

  /* ==================== панель standby (эта вкладка уступила другой) ==================== */
  function openStandbyPanel() { panelMode = 'standby'; showPanel(); renderStandbyPanel(); }

  function renderStandbyPanel(note) {
    clear(dom.panel);
    const cfg = ui.loadConfig(storage);
    const paused = !!(cfg && cfg.paused);
    dom.panel.appendChild(h('h3', { text: paused ? 'Условия поиска меняют в другой вкладке' : 'Поиск идёт в другой вкладке' }));
    // C3: в этой вкладке остановить поиск нельзя — он не здесь работает, и
    // «Остановить поиск» тут не должно ни к чему предлагать, ни менять
    // enabled в настройках.
    dom.panel.appendChild(h('p', {
      text: paused
        ? 'Когда там нажмут «Запустить охоту», поиск продолжится по новым условиям. Можно и настроить поиск здесь заново.'
        : 'Чтобы остановить поиск, сделайте это в той вкладке ЕМИАС, где он сейчас работает.',
    }));
    if (note) dom.panel.appendChild(h('p', { class: 'esh-warn', text: note }));
    dom.panel.appendChild(h('div', { class: 'esh-btns' }, [
      paused
        ? h('button', { class: 'esh-btn primary', text: 'Настроить здесь', onclick: () => openWizardGuarded(1) })
        : h('button', { class: 'esh-btn primary', text: 'Продолжить в этой вкладке', onclick: onContinueHere }),
    ]));
  }

  // I11: по клику пробуем перехватить лидерство прямо сейчас — ядро само
  // решит спор вкладок (у чьего claim id больше).
  // C-1 п.1: стартуем только по свежим настройкам и только после нового
  // холостого прогона, совпавшего с подтверждённым (тот же путь, что и
  // resumeIfEnabled) — цели из памяти вкладки могли устареть.
  async function onContinueHere() {
    clear(dom.panel);
    dom.panel.appendChild(h('h3', { text: 'Поиск идёт в другой вкладке' }));
    dom.panel.appendChild(h('p', { class: 'esh-note', text: 'Проверяю условия поиска, подождите…' }));
    let r;
    try {
      r = await startFromSavedConfig();
    } catch (e) {
      if (panelMode === 'standby') renderStandbyPanel('Не удалось проверить: ' + ((e && e.message) || 'нет ответа от ЕМИАС'));
      return;
    }
    if (r.status === 'started') {
      setBadge({ kind: 'running', text: '🟢 Ищу слоты', detail: runningDetail() });
      startStatusRefresh();
      if (standbyRetryId) { clearInterval(standbyRetryId); standbyRetryId = null; }
      hidePanel();
    } else if (r.status === 'mismatch') {
      showReconfirm(r.cfg, r.report);
    } else if (r.status === 'off') {
      setBadge({ kind: 'idle', text: '🎯 Настроить', detail: '' });
      hidePanel();
    } else if (panelMode === 'standby') {
      renderStandbyPanel();
    }
  }

  /* ==================== лог событий (для статус-панели) ==================== */
  function pushLog(entry) {
    logEvents.unshift(entry);
    if (logEvents.length > 40) logEvents.length = 40;
    if (panelMode === 'status') renderStatusPanel();
  }

  function renderLog(events) {
    const box = h('div', { class: 'esh-log' });
    for (const e of events.slice(0, 20)) box.appendChild(h('div', { text: `${hhmm(e.at)} · ${e.msg}` }));
    if (!events.length) box.appendChild(h('div', { class: 'esh-note', text: 'событий пока нет' }));
    return box;
  }

  function titleFor(targetId) {
    const t = (core.status().targets || []).find((x) => x.id === targetId);
    return (t && t.title) || 'Запись';
  }

  /* ==================== статус-панель (что происходит сейчас) ==================== */
  function renderStatusPanel() {
    const st = core.status();
    const waiting = new Set(st.pending);
    const lines = st.targets.map((t) => h('p', { text: `${t.title}: ${waiting.has(t.id) ? 'жду вашего решения' : describeState(t)}` }));
    // Панель перерисовывается целиком каждые 5 секунд (см. startStatusRefresh)
    // и на каждое новое событие лога — без этого позиция прокрутки в логе
    // сбрасывалась бы к началу при каждой перерисовке.
    const prevLog = dom.panel.querySelector('.esh-log');
    const logScrollTop = prevLog ? prevLog.scrollTop : 0;
    clear(dom.panel);
    dom.panel.appendChild(h('h3', { text: 'Что сейчас происходит' }));
    // M-1: время берём из lastCheckAt — его ставит только настоящая проверка.
    dom.panel.appendChild(h('p', { class: 'esh-note', text: `Последняя проверка: ${st.lastCheckAt ? hhmm(st.lastCheckAt) : 'ещё не было'}` }));
    dom.panel.appendChild(h('div', {}, lines));
    const logBox = renderLog(logEvents);
    dom.panel.appendChild(logBox);
    logBox.scrollTop = logScrollTop;
    const stopBtn = h('button', { class: 'esh-btn danger', text: 'Остановить поиск', onclick: onStop });
    dom.panel.appendChild(h('div', { class: 'esh-btns' }, [stopBtn]));
  }

  function describeState(t) {
    if (t.state === 'stopped') return `остановлено (${t.note || 'причина неизвестна'})`;
    if (t.state === 'done') return 'готово';
    if (t.state === 'improving') return 'записано, ищу вариант получше';
    return 'проверяю расписание';
  }

  function openStatusPanel() { panelMode = 'status'; showPanel(); renderStatusPanel(); }

  /* ==================== мастер: открытие и переключение шагов ==================== */
  function openWizard(step) {
    panelMode = 'wizard';
    wizard.open = true;
    wizard.step = step;
    showPanel();
    if (step === 1) loadStep1();
    else if (step === 2) renderStep2(wizard.selected);
    else if (step === 3) loadStep3();
    else if (step === 4) renderStep4();
  }

  function renderLoading(title) {
    clear(dom.panel);
    dom.panel.appendChild(h('h3', { text: title }));
    dom.panel.appendChild(h('p', { class: 'esh-note', text: 'Спрашиваю ЕМИАС, подождите…' }));
  }

  function renderLoadError(title, message, onRetry) {
    clear(dom.panel);
    dom.panel.appendChild(h('h3', { text: title }));
    dom.panel.appendChild(h('p', { class: 'esh-warn', text: message }));
    dom.panel.appendChild(h('div', { class: 'esh-btns' }, [
      h('button', { class: 'esh-btn primary', text: 'Повторить', onclick: onRetry }),
    ]));
  }

  /* ==================== шаг 1: выбор направлений и записей ==================== */
  async function loadStep1() {
    renderLoading('Шаг 1 из 3. За чем следить');
    try {
      const options = await core.discover();
      wizard.options = options;
      renderStep1(options);
    } catch (e) {
      renderLoadError('Шаг 1 из 3. За чем следить', e && e.message, loadStep1);
    }
  }

  function isSelected(option) { return wizard.selected.some((o) => o.id === option.id); }

  function toggleOption(option, on) {
    wizard.selected = wizard.selected.filter((o) => o.id !== option.id);
    if (on) wizard.selected.push(option);
    // Кнопка «Далее» рисуется один раз вместе со списком — без этого она
    // оставалась неактивной, пока мастер не перерисуют заново.
    if (dom.step1Next) dom.step1Next.disabled = wizard.selected.length === 0;
  }

  function renderOptionRow(option) {
    const supported = option.supported !== false;
    const box = h('div', { class: 'esh-opt' + (supported ? '' : ' disabled') });
    const checkbox = h('input', {
      type: 'checkbox', checked: isSelected(option), disabled: !supported,
      onchange: (e) => toggleOption(option, e.target.checked),
    });
    box.appendChild(h('label', { class: 'esh-row' }, [
      checkbox,
      h('div', {}, [
        h('div', { class: 'title', text: option.title }),
        h('div', { class: 'meta', text: describeOptionMeta(option) }),
        !supported ? h('div', { class: 'reason', text: option.unsupportedReason || 'пока не поддерживается' }) : null,
      ]),
    ]));
    return box;
  }

  function describeOptionMeta(option) {
    const parts = [];
    if (option.current) parts.push('сейчас записано на ' + ui.human(option.current));
    if (option.address) parts.push(ui.stripCampus(option.address));
    if (option.deadline) parts.push('направление действует по ' + option.deadline.slice(8, 10) + '.' + option.deadline.slice(5, 7));
    return parts.join(' · ') || 'запись по направлению';
  }

  function renderStep1(options) {
    clear(dom.panel);
    dom.panel.appendChild(h('h3', { text: 'Шаг 1 из 3. За чем следить' }));
    if (!options.length) {
      dom.panel.appendChild(h('p', { class: 'esh-note', text: 'Направлений и записей, с которыми можно работать, не найдено.' }));
    }
    const list = h('div', {}, options.map(renderOptionRow));
    dom.panel.appendChild(list);
    const next = h('button', {
      class: 'esh-btn primary', text: 'Далее', disabled: wizard.selected.length === 0,
      onclick: () => openWizard(2),
    });
    dom.step1Next = next;
    dom.panel.appendChild(h('div', { class: 'esh-btns' }, [next]));
  }

  /* ==================== шаг 2: условия для каждого выбранного пункта ==================== */
  function ensureForm(option) {
    if (!wizard.forms[option.id]) {
      wizard.forms[option.id] = {
        // Для новой записи 'earlier' показывается как «как можно раньше».
        when: 'earlier',
        day: '', dateFrom: '', dateTo: '', timeFrom: '', timeTo: '',
        where: option.address ? 'sameCampus' : 'any', addressContains: '',
        respectTravel: true, mode: 'auto', purpose: 'unwell',
      };
    }
    return wizard.forms[option.id];
  }

  // Направление к врачу с needPurpose: true — сайт требует выбрать цель визита
  // (см. capture-2026-09-24-referral-doctor.md), иначе расписание и запись
  // отклоняются. Для остальных целей поле form.purpose ни на что не влияет.
  function purposeField(option, form, update) {
    if (!(option.source && option.source.needPurpose)) return null;
    const opts = [
      ['unwell', ui.INQUIRY_PURPOSES.unwell.title],
      ['documents', ui.INQUIRY_PURPOSES.documents.title],
    ];
    const group = h('div', {}, opts.map(([val, text]) => h('label', { class: 'esh-row' }, [
      h('input', { type: 'radio', name: 'purpose-' + option.id, checked: (form.purpose || 'unwell') === val, onchange: () => update({ purpose: val }) }),
      h('span', { text }),
    ])));
    return h('div', {}, [h('label', { class: 'esh-field', text: 'Цель визита' }), group]);
  }

  function whenField(option, form, update) {
    const opts = [
      ['earlier', option.current ? 'раньше, чем сейчас записано' : 'как можно раньше'],
      ...(option.current ? [['sameDayEarlier', 'в тот же день, но раньше']] : []),
      ['onlyDay', 'в выбранный день, в любое время'],
    ];
    const group = h('div', {}, opts.map(([val, text]) => h('label', { class: 'esh-row' }, [
      h('input', { type: 'radio', name: 'when-' + option.id, checked: form.when === val, onchange: () => update({ when: val }) }),
      h('span', { text }),
    ])));
    const dayInput = form.when === 'onlyDay' ? h('input', {
      type: 'date', value: form.day, onchange: (e) => update({ day: e.target.value }),
    }) : null;
    return h('div', {}, [group, dayInput]);
  }

  function whereField(option, form, update) {
    const opts = [
      ...(option.address ? [['sameCampus', 'в этом же здании']] : []),
      ['any', 'где угодно'],
      ['contains', 'адрес содержит:'],
    ];
    const group = h('div', {}, opts.map(([val, text]) => h('label', { class: 'esh-row' }, [
      h('input', { type: 'radio', name: 'where-' + option.id, checked: form.where === val, onchange: () => update({ where: val }) }),
      h('span', { text }),
    ])));
    const addrInput = form.where === 'contains' ? h('input', {
      type: 'text', value: form.addressContains, placeholder: 'например, Ленина',
      onchange: (e) => update({ addressContains: e.target.value }),
    }) : null;
    return h('div', {}, [group, addrInput]);
  }

  function advancedFields(form, update) {
    const field = (label, type, key) => h('label', { class: 'esh-field' }, [
      label, h('input', { type, value: form[key], onchange: (e) => update({ [key]: e.target.value }) }),
    ]);
    return h('details', { class: 'esh-more' }, [
      h('summary', { text: 'Дополнительно: даты и время' }),
      field('Не раньше какого дня', 'date', 'dateFrom'),
      field('Не позже какого дня', 'date', 'dateTo'),
      field('Время не раньше', 'time', 'timeFrom'),
      field('Время не позже', 'time', 'timeTo'),
    ]);
  }

  function renderTargetCard(option) {
    const form = ensureForm(option);
    const update = (patch) => { Object.assign(form, patch); renderStep2(wizard.selected); };
    const card = h('div', { class: 'esh-opt' });
    card.appendChild(h('div', { class: 'title', text: option.title }));
    card.appendChild(h('label', { class: 'esh-field', text: 'Когда' }));
    card.appendChild(whenField(option, form, update));
    card.appendChild(h('label', { class: 'esh-field', text: 'Где' }));
    card.appendChild(whereField(option, form, update));
    const purpose = purposeField(option, form, update);
    if (purpose) card.appendChild(purpose);
    card.appendChild(h('label', { class: 'esh-row' }, [
      h('input', { type: 'checkbox', checked: form.respectTravel, onchange: (e) => update({ respectTravel: e.target.checked }) }),
      h('span', { text: 'Учитывать время на дорогу между записями' }),
    ]));
    card.appendChild(h('label', { class: 'esh-field', text: 'Как записывать' }));
    card.appendChild(h('div', {}, [
      h('label', { class: 'esh-row' }, [
        h('input', { type: 'radio', name: 'mode-' + option.id, checked: form.mode === 'auto', onchange: () => update({ mode: 'auto' }) }),
        h('span', { text: 'сразу, без вопросов' }),
      ]),
      h('label', { class: 'esh-row' }, [
        h('input', { type: 'radio', name: 'mode-' + option.id, checked: form.mode === 'confirm', onchange: () => update({ mode: 'confirm' }) }),
        h('span', { text: 'сначала спрашивать' }),
      ]),
    ]));
    card.appendChild(advancedFields(form, update));
    const error = stepTwoError(option, form);
    if (error) card.appendChild(h('p', { class: 'esh-warn', text: error }));
    return card;
  }

  function stepTwoError(option, form) {
    if (form.when === 'onlyDay' && !form.day) return 'выберите день';
    if (form.where === 'contains' && !form.addressContains.trim()) return 'укажите часть адреса';
    return null;
  }

  // «Назад» на шаге 1: варианты уже получены discover()-ом при первом входе
  // на шаг 1 в этом сеансе мастера — рисуем из wizard.options, не ходим в
  // сеть повторно.
  function backToStep1() {
    panelMode = 'wizard';
    wizard.open = true;
    wizard.step = 1;
    showPanel();
    renderStep1(wizard.options);
  }

  function renderStep2(selected) {
    clear(dom.panel);
    dom.panel.appendChild(h('h3', { text: 'Шаг 2 из 3. Условия поиска' }));
    dom.panel.appendChild(h('div', {}, selected.map(renderTargetCard)));
    const hasErrors = selected.some((o) => stepTwoError(o, ensureForm(o)));
    const back = h('button', { class: 'esh-btn', text: 'Назад', onclick: backToStep1 });
    const next = h('button', { class: 'esh-btn primary', text: 'Далее', disabled: hasErrors, onclick: () => openWizard(3) });
    dom.panel.appendChild(h('div', { class: 'esh-btns' }, [back, next]));
  }

  /* ==================== шаг 3: холостой прогон и запуск ==================== */
  async function loadStep3() {
    renderLoading('Шаг 3 из 3. Проверка перед запуском');
    wizard.builtTargets = wizard.selected.map((o) => ui.buildTarget(o, ensureForm(o)));
    core.setTargets(wizard.builtTargets);
    try {
      wizard.report = await core.dryRun();
      wizard.checked = false;
      renderStep3(wizard.report);
    } catch (e) {
      renderLoadError('Шаг 3 из 3. Проверка перед запуском', e && e.message, loadStep3);
    }
  }

  function renderReportItem(item) {
    const text = ui.describeDryRunItem(item);
    const [head, ...rest] = text.split('\n');
    const box = h('div', { class: 'esh-opt' });
    box.appendChild(h('p', { text: head }));
    for (const line of rest) {
      const warn = line.trim().startsWith('⚠');
      box.appendChild(h('p', { class: warn ? 'esh-warn' : 'esh-note', text: line.trim() }));
    }
    return box;
  }

  function renderStep3(report) {
    clear(dom.panel);
    dom.panel.appendChild(h('h3', { text: 'Шаг 3 из 3. Проверка перед запуском' }));
    dom.panel.appendChild(h('p', { class: 'esh-note', text: 'Это холостой прогон: скрипт проверил расписание и показывает, что сделал бы прямо сейчас. Ничего не записано и не перенесено.' }));
    dom.panel.appendChild(h('div', {}, report.items.map(renderReportItem)));
    const checkbox = h('input', {
      type: 'checkbox', checked: wizard.checked,
      onchange: (e) => { wizard.checked = e.target.checked; renderStep3(wizard.report); },
    });
    dom.panel.appendChild(h('label', { class: 'esh-row' }, [checkbox, h('span', { text: 'Я проверил(а) результаты холостого прогона' })]));
    const btns = [];
    if (wizard.selected.length) btns.push(h('button', { class: 'esh-btn', text: 'Назад', onclick: () => openWizard(2) }));
    btns.push(h('button', { class: 'esh-btn primary', text: 'Запустить охоту', disabled: !wizard.checked, onclick: onStart }));
    dom.panel.appendChild(h('div', { class: 'esh-btns' }, btns));
  }

  /* ==================== шаг 4: подтверждение запуска ==================== */
  function renderStep4() {
    clear(dom.panel);
    dom.panel.appendChild(h('h3', { text: 'Готово' }));
    dom.panel.appendChild(h('p', {}, 'Слежу за расписанием. Значок будет зелёным, пока идёт поиск.'));
    const titles = (wizard.builtTargets || []).map((t) => t.title).join(', ');
    if (titles) dom.panel.appendChild(h('p', { class: 'esh-note', text: 'Слежу за: ' + titles }));
    dom.panel.appendChild(h('div', { class: 'esh-btns' }, [
      h('button', { class: 'esh-btn primary', text: 'Понятно', onclick: hidePanel }),
    ]));
  }

  async function onStart() {
    // C1: защита от запуска по пустому списку целей (например, если сюда
    // всё же попали с испорченным состоянием мастера) — без неё в настройки
    // тихо сохранился бы targets: [] при зелёном значке.
    if (!wizard.builtTargets || !wizard.builtTargets.length) {
      renderLoadError('Шаг 3 из 3. Проверка перед запуском', 'Список целей пуст — нечего запускать. Начните заново с шага 1.', () => openWizardGuarded(1));
      return;
    }
    try {
      core.confirmDryRun(wizard.report.id);
      await core.start();
      // C-1 п.2: новое подтверждение снимает паузу (новый объект настроек
      // без paused/pausedAt).
      ui.saveConfig(storage, { enabled: true, paused: false, targets: wizard.builtTargets, confirmedFor: wizard.report.targetsHash });
      runningFor = wizard.report.targetsHash;
      // Minor: сразу после старта проверок ещё не было — не выдумываем время
      // последней проверки.
      setBadge({ kind: 'running', text: '🟢 Ищу слоты', detail: 'первая проверка через минуту' });
      startStatusRefresh();
      openWizard(4);
    } catch (e) {
      renderLoadError('Шаг 3 из 3. Проверка перед запуском', e && e.message, () => renderStep3(wizard.report));
    }
  }

  function onStop() {
    startAttempt++; // I-1: идущая попытка возобновления после прогона не стартует
    core.stop();
    runningFor = null;
    stopStatusRefresh();
    stopRecoveryWatch(); // M-2
    if (standbyRetryId) { clearInterval(standbyRetryId); standbyRetryId = null; }
    clearAllConfirmCards(); // I6: живые карточки «спросить» после остановки не нужны
    const cfg = ui.loadConfig(storage) || {};
    ui.saveConfig(storage, { ...cfg, enabled: false });
    setBadge({ kind: 'idle', text: '🎯 Настроить', detail: '' });
    hidePanel();
  }

  /* ==================== запросы на подтверждение слота (mode: confirm) ==================== */
  function renderConfirmCard(targetId) {
    const p = pendingConfirms[targetId];
    if (!p) return;
    const left = Math.max(0, Math.round((p.expiresAt - Date.now()) / 1000));
    const card = h('div', { class: 'esh-confirm' });
    // I7: должно быть видно, что именно отдаётся — для переноса называем и
    // текущее время записи, и найденное, а не только найденное.
    const t = (core.status().targets || []).find((x) => x.id === targetId);
    const current = t && t.current;
    const headText = current
      ? `${p.payload.title}: перенесу с ${ui.human(current)} на ${ui.human(p.payload.slot.startTime)}`
      : `${p.payload.title}: запишу на ${ui.human(p.payload.slot.startTime)}`;
    card.appendChild(h('p', { text: headText }));
    if (p.payload.address) card.appendChild(h('p', { class: 'esh-note', text: ui.stripCampus(p.payload.address) }));
    card.appendChild(h('p', { class: 'esh-note', text: `Осталось ${left} с` }));
    card.appendChild(h('div', { class: 'esh-btns' }, [
      h('button', { class: 'esh-btn', text: 'Пропустить', onclick: () => answerConfirm(targetId, 'skip') }),
      h('button', { class: 'esh-btn primary', text: 'Записать', onclick: () => answerConfirm(targetId, 'book') }),
    ]));
    if (p.node) dom.confirms.replaceChild(card, p.node);
    else dom.confirms.appendChild(card);
    p.node = card;
  }

  // I6: карточки режима «спросить» надо чистить и при остановке, и при
  // standby — иначе остаётся живой отсчёт и кнопки, которые уже ничего не
  // делают (answer() на остановленном раннере просто отклонится).
  function clearAllConfirmCards() {
    for (const targetId of Object.keys(pendingConfirms)) removeConfirmCard(targetId);
    // Task 12c minor: карточка «записать не удалось» уже не в
    // pendingConfirms (answerConfirm удаляет её оттуда сразу после ответа),
    // но сам узел ещё несколько секунд на экране — без этого списка она
    // пережила бы остановку/standby и провисела бы впустую до RESULT_NOTE_MS.
    for (const entry of failedConfirmNodes.splice(0)) {
      clearTimeout(entry.timeoutId);
      if (entry.node && entry.node.parentNode) entry.node.parentNode.removeChild(entry.node);
    }
  }

  function onNeedConfirm(payload) {
    // I8: окно ответа всего 60 секунд, а вкладка обычно фоновая — без звука
    // и уведомления человек может просто не заметить запрос вовремя.
    const where = payload.address ? ` — ${ui.stripCampus(payload.address)}` : '';
    notify('ЕМИАС: нужно решение', `${payload.title}: ${ui.human(payload.slot.startTime)}${where} — 60 секунд на ответ`);
    const targetId = payload.targetId;
    const tickId = setInterval(() => {
      const p = pendingConfirms[targetId];
      if (!p || Date.now() >= p.expiresAt) { removeConfirmCard(targetId); return; }
      renderConfirmCard(targetId);
    }, 1000);
    pendingConfirms[targetId] = { payload, expiresAt: payload.expiresAt, tickId, node: null };
    renderConfirmCard(targetId);
  }

  function removeConfirmCard(targetId) {
    const p = pendingConfirms[targetId];
    if (!p) return;
    clearInterval(p.tickId);
    if (p.node && p.node.parentNode) p.node.parentNode.removeChild(p.node);
    delete pendingConfirms[targetId];
  }

  // I5/I-3: результат core.answer() показываем человеку на месте карточки:
  // пока ждём ответа — «Записываю…», при неудаче — понятный итог на
  // несколько секунд и то же в пояснении к значку. Дубля в логе избегаем
  // сравнением foundCount до/после core.answer(), а не перечислением
  // исходов: в большинстве неудач runner.js:finish() сам шлёт found с тем
  // же текстом, и onFound уже его залогировал, — но не всегда (например,
  // при res.action === 'relogin' finish() шлёт sessionLost, а не found, и
  // foundCount не растёт). Счётчик учитывает это сам: alreadyLogged
  // окажется false, и текст залогируется здесь, в answerConfirm, — без
  // догадок о том, какие именно исходы finish() уже успел залогировать.
  const RESULT_NOTE_MS = 7000;

  function showCardNote(node, text, warn) {
    clear(node);
    node.appendChild(h('p', { class: warn ? 'esh-warn' : 'esh-note', text }));
  }

  async function answerConfirm(targetId, decision) {
    const title = titleFor(targetId);
    const bookDecision = decision === 'book';
    const p = pendingConfirms[targetId];
    const node = p && p.node;
    // Отвязываем карточку от отсчёта, но сам элемент пока оставляем на месте.
    if (p) { clearInterval(p.tickId); delete pendingConfirms[targetId]; }
    const dropNode = () => { if (node && node.parentNode) node.parentNode.removeChild(node); };
    if (!bookDecision) {
      dropNode();
      try { await core.answer(targetId, 'skip'); } catch (e) { /* пропуск ничего не отправляет */ }
      return;
    }
    if (node) showCardNote(node, `${title}: записываю…`, false);
    const foundBefore = foundCount[targetId] || 0;
    let failText = null;
    let alreadyLogged = false;
    try {
      const res = await core.answer(targetId, 'book');
      if (!res || !res.ok || !res.verified) {
        failText = (res && res.message) || 'слот уже не актуален';
        alreadyLogged = (foundCount[targetId] || 0) > foundBefore;
      }
    } catch (e) {
      failText = (e && e.message) || 'неизвестная ошибка';
    }
    if (!failText) { dropNode(); return; }
    const text = `${title}: записать не удалось — ${failText}`;
    if (!alreadyLogged) pushLog({ at: Date.now(), msg: text });
    if (node) {
      showCardNote(node, text, true);
      const entry = { node, timeoutId: null };
      entry.timeoutId = setTimeout(() => {
        dropNode();
        const i = failedConfirmNodes.indexOf(entry);
        if (i !== -1) failedConfirmNodes.splice(i, 1);
      }, RESULT_NOTE_MS);
      failedConfirmNodes.push(entry);
    }
    showBadgeNote('записать не удалось: ' + failText);
  }

  function showBadgeNote(text) {
    const prevDetail = badgeState.detail;
    badgeNote = { text, until: Date.now() + RESULT_NOTE_MS };
    setBadge({ detail: text });
    setTimeout(() => {
      if (badgeState.detail !== text) return; // значок уже сменился по другой причине
      setBadge({ detail: badgeState.kind === 'running' ? runningDetail() : prevDetail });
    }, RESULT_NOTE_MS);
  }

  /* ==================== плашка «компьютер спал» ==================== */
  function onSlept(payload) {
    clear(dom.slept);
    dom.slept.hidden = false;
    dom.slept.appendChild(h('p', { text: `Компьютер спал с ${hhmm(payload.from)} по ${hhmm(payload.to)}` }));
    dom.slept.appendChild(h('button', { class: 'esh-btn', text: '✕', onclick: () => { dom.slept.hidden = true; } }));
  }

  // Minor/M-1: сразу после старта/возобновления показываем «первая проверка
  // через минуту», а не выдуманное «проверено в <время старта>» — реальное
  // время берём из core.status().lastCheckAt: его ставит только настоящая
  // проверка (lastTickAt ядро взводит и при start()).
  function runningDetail() {
    if (badgeNote && Date.now() < badgeNote.until) return badgeNote.text;
    badgeNote = null;
    const t = core.status().lastCheckAt;
    return t ? 'проверено в ' + hhmm(t) : 'первая проверка через минуту';
  }

  /* ==================== события ядра ==================== */
  // core.init() двух родов ошибок: настоящее «не вошли на сайте» (кидает
  // SessionError или обычную ошибку из core/session.js read()) и «вошли, но
  // не удалось само определить полис/дату рождения» (IdentityError из
  // core/index.js — идентификатор не нашёлся ни в idToken, ни в
  // /api-eip/v2/policy/list). Раньше оба случая показывали один и тот же
  // текст «🔒 Войдите в ЕМИАС» — по клику ядро пробовало снова, падало с той
  // же IdentityError и человек читал ровно то же самое сообщение по кругу,
  // хотя вход-то как раз есть. Текст для IdentityError отдельный и говорит,
  // что реально сделать (полис в хранилище сайта появляется, когда открыт
  // раздел «Полисы ОМС»).
  function initErrorBadge(e) {
    if (e && e.name === 'IdentityError') {
      return { kind: 'needIdentity', text: '🔒 Не нашла полис и дату рождения', detail: 'Откройте на сайте раздел «Полисы ОМС», дождитесь загрузки и нажмите ещё раз' };
    }
    return { kind: 'needLogin', text: '🔒 Войдите в ЕМИАС', detail: e && e.message };
  }

  // Если в настройках поиск включён и не на паузе, после входа просто
  // возобновляем его (как при загрузке страницы), а не открываем мастер —
  // иначе открытие мастера поставило бы на паузу поиск и в других вкладках.
  function retryLogin() {
    core.init().then(() => {
      const cfg = ui.loadConfig(storage);
      if (cfg && cfg.enabled && !cfg.paused && Array.isArray(cfg.targets) && cfg.targets.length) { resumeIfEnabled(); return; }
      setBadge({ kind: 'idle', text: '🎯 Настроить', detail: '' });
      openWizardGuarded(1);
    }).catch((e) => setBadge(initErrorBadge(e)));
  }

  function onBooked(payload) {
    const where = payload.address ? ` — ${ui.stripCampus(payload.address)}` : '';
    notify('ЕМИАС: записано', `${payload.title}: ${ui.human(payload.slot.startTime)}${where}`);
    pushLog({ at: Date.now(), msg: `Записано: ${payload.title} — ${ui.human(payload.slot.startTime)}` });
    // C1: раннер меняет current/source/scenario цели (перенос keepImproving)
    // только у себя в памяти — без этого сохранённые настройки (cfg.targets)
    // оставались бы со старыми полями, и следующий запуск по ним (перезагрузка
    // страницы, standby-вкладка, «Продолжить в этой вкладке») мог бы перенести
    // уже улучшенную запись НАЗАД. confirmedFor не трогаем — applyBookedUpdate
    // меняет только сами targets.
    const cfg = ui.loadConfig(storage);
    const nextCfg = ui.applyBookedUpdate(cfg, payload);
    if (nextCfg !== cfg) ui.saveConfig(storage, nextCfg);
    // Minor: раньше при возврате из «Записано» цвет менялся обратно, а текст
    // оставался старым («🟠 Записано: …») — запоминаем значок целиком (а не
    // только его kind), чтобы вернуть и текст тоже.
    if (badgeState.kind !== 'booked') preBookedBadge = { ...badgeState };
    setBadge({ kind: 'booked', text: '🟠 Записано: ' + payload.title, detail: '' });
    if (badgeRevertId) clearTimeout(badgeRevertId);
    badgeRevertId = setTimeout(() => {
      if (core.status().running) setBadge({ kind: 'running', text: '🟢 Ищу слоты', detail: runningDetail() });
      else if (preBookedBadge) setBadge(preBookedBadge);
    }, 8000);
  }

  function onFound(payload) {
    if (payload && payload.targetId) foundCount[payload.targetId] = (foundCount[payload.targetId] || 0) + 1;
    pushLog({ at: Date.now(), msg: `${titleFor(payload.targetId)}: ${payload.warning || 'проверила расписание'}` });
  }

  function onLog(payload) { pushLog(payload); }

  function onSessionLost(payload) {
    // Minor: текст payload.message раньше нигде не показывался — теперь он
    // идёт в пояснение к значку (и в панель объяснения, см. renderRecoveryPanel).
    setBadge({ kind: 'sessionLost', text: '🔴 Нужно войти в другой вкладке', detail: (payload && payload.message) || '' });
    startRecoveryWatch();
  }

  function onStale(payload) {
    setBadge({ kind: 'stale', text: '🔴 Давно нет ответа от ЕМИАС', detail: 'с ' + hhmm(payload.since) });
    startRecoveryWatch();
  }

  function onStandby(payload) {
    runningFor = null;
    stopStatusRefresh();
    stopRecoveryWatch(); // M-2
    clearAllConfirmCards(); // I6
    setBadge({ kind: 'standby', text: '↔ Поиск идёт в другой вкладке', detail: '' });
    startStandbyRetry(); // I11
  }

  // C2 п.1: раннер сам останавливается и просит новый холостой прогон, если
  // цели изменились уже во время работающего цикла (например, обошли
  // openWizardGuarded). UI-обработчику остаётся только честно это показать —
  // сам поиск в этот момент уже не идёт.
  function onNeedDryRun(payload) {
    runningFor = null;
    stopStatusRefresh();
    clearAllConfirmCards();
    setBadge({ kind: 'needDryRun', text: '🔴 Нужен новый холостой прогон', detail: (payload && payload.message) || '' });
  }

  // I10: исключение в любом обработчике не должно вылетать из emit() внутри
  // tick() и останавливать поиск навсегда при зелёном значке.
  function safe(fn) {
    return (payload) => {
      try { fn(payload); } catch (e) { try { console.error('emias-slot-hunter: обработчик события упал', e); } catch (e2) { /* даже это необязательно */ } }
    };
  }

  function subscribeCore() {
    core.on('log', safe(onLog));
    core.on('found', safe(onFound));
    core.on('booked', safe(onBooked));
    core.on('needConfirm', safe(onNeedConfirm));
    core.on('sessionLost', safe(onSessionLost));
    core.on('stale', safe(onStale));
    core.on('slept', safe(onSlept));
    core.on('standby', safe(onStandby));
    core.on('needDryRun', safe(onNeedDryRun));
  }

  /* ==================== обновление «время последней проверки» и восстановление ==================== */
  function startStatusRefresh() {
    stopStatusRefresh();
    statusRefreshId = setInterval(() => {
      if (yieldIfReconfigured()) return;
      if (badgeState.kind !== 'running' && badgeState.kind !== 'resuming') return;
      setBadge({ kind: 'running', text: '🟢 Ищу слоты', detail: runningDetail() });
      if (panelMode === 'status') renderStatusPanel();
    }, 5000);
  }

  function stopStatusRefresh() { if (statusRefreshId) clearInterval(statusRefreshId); statusRefreshId = null; }

  // C-1 п.3: работающая вкладка сверяет настройки со своими. Если поиск
  // выключили, поставили на паузу (открыли мастер) или подтвердили другие
  // цели в другой вкладке — останавливаемся. В настройки при этом ничего не
  // пишем: это решение другой вкладки. Дальше ведём себя как в standby —
  // раз в минуту смотрим, не пора ли продолжить по новым условиям.
  function yieldIfReconfigured() {
    if (!core.status().running) return false;
    const cfg = ui.loadConfig(storage);
    const same = cfg && cfg.enabled && !cfg.paused && runningFor && cfg.confirmedFor === runningFor;
    if (same) return false;
    core.stop();
    runningFor = null;
    stopStatusRefresh();
    stopRecoveryWatch();
    clearAllConfirmCards();
    if (!cfg || !cfg.enabled) {
      setBadge({ kind: 'idle', text: '🎯 Настроить', detail: 'поиск остановили в другой вкладке' });
      if (panelMode === 'status' || panelMode === 'recovery') hidePanel();
      return true;
    }
    setBadge({ kind: 'standby', text: '↔ Поиск перенастраивается в другой вкладке', detail: '' });
    if (panelMode === 'status' || panelMode === 'recovery') hidePanel();
    startStandbyRetry();
    return true;
  }

  // M-2: наблюдение за восстановлением после sessionLost/stale не должно
  // переживать остановку, standby и открытие мастера — иначе оно вернуло бы
  // зелёный значок, когда поиск уже не идёт.
  function stopRecoveryWatch() { if (recoveryWatchId) clearInterval(recoveryWatchId); recoveryWatchId = null; }

  // После sessionLost/stale ждём, пока раннер сам не сделает успешную
  // проверку (lastOkAt сдвинется вперёд) — тогда молча возвращаем зелёный
  // значок, без перезапуска поиска человеком.
  function startRecoveryWatch() {
    const since = core.status().lastOkAt;
    if (recoveryWatchId) clearInterval(recoveryWatchId);
    recoveryWatchId = setInterval(() => {
      const st = core.status();
      if (st.lastOkAt > since) {
        clearInterval(recoveryWatchId);
        recoveryWatchId = null;
        setBadge({ kind: 'running', text: '🟢 Ищу слоты', detail: runningDetail() });
        startStatusRefresh();
      }
    }, 5000);
  }

  // I11: standby — не конечное состояние. Если вкладку-лидера закрыли, эта
  // вкладка не должна навсегда остаться на «поиск идёт в другой вкладке» —
  // раз в минуту, пока в настройках enabled, пробуем start() заново; ядро
  // само уладит спор вкладок через channel.
  // C-1 п.1: стартуем не по целям из памяти вкладки, а по свежим настройкам
  // и только после нового холостого прогона, совпавшего с подтверждённым
  // (startFromSavedConfig). На паузе (в другой вкладке открыт мастер) или
  // при несовпадении отпечатка — молча ждём следующей минуты.
  // Task 12c: пока лидер жив, дорогой startFromSavedConfig() (реальные
  // запросы к ЕМИАС по всем целям, затем мгновенный проигрыш спора вкладок
  // и возврат в standby) звать незачем — значок на миг показывал «Ищу
  // слоты» при живой вкладке-лидере. Лидер раз в 20 с шлёт в channel
  // heartbeat (core.leaderSeenAt()); повторную попытку делаем, только если
  // от него давно ничего не слышно (порог намного больше периода
  // heartbeat — переживает пропуск одного-двух сигналов). Если недавно
  // слышали — молча ждём следующей минуты, ничего не запрашивая.
  const LEADER_SILENCE_MS = 90000;
  let standbyRetryBusy = false;
  function startStandbyRetry() {
    if (standbyRetryId) clearInterval(standbyRetryId);
    standbyRetryId = setInterval(async () => {
      if (badgeState.kind !== 'standby') { clearInterval(standbyRetryId); standbyRetryId = null; return; }
      if (standbyRetryBusy || wizard.open) return;
      const cfg = ui.loadConfig(storage);
      if (!cfg || !cfg.enabled) {
        // Поиск выключили в другой вкладке — ждать больше нечего. Это
        // дешёвая проверка настроек (localStorage), а не сеть — её незачем
        // придерживать гейтом лидера ниже.
        clearInterval(standbyRetryId);
        standbyRetryId = null;
        setBadge({ kind: 'idle', text: '🎯 Настроить', detail: '' });
        if (panelMode === 'standby') hidePanel();
        return;
      }
      if (cfg.paused) return;
      // Дорогой путь ниже (холостой прогон по сети) — только если от лидера
      // давно не было вестей; сама эта проверка и всё выше — не в сеть.
      if (Date.now() - core.leaderSeenAt() <= LEADER_SILENCE_MS) return;
      standbyRetryBusy = true;
      try {
        const r = await startFromSavedConfig();
        if (r.status !== 'started') return;
        if (standbyRetryId) clearInterval(standbyRetryId);
        standbyRetryId = null;
        setBadge({ kind: 'running', text: '🟢 Ищу слоты', detail: runningDetail() });
        startStatusRefresh();
        if (panelMode === 'standby') hidePanel();
      } catch (e) {
        /* нет связи или другая вкладка ещё жива — попробуем через минуту снова */
      } finally {
        standbyRetryBusy = false;
      }
    }, 60000);
  }

  /* ==================== запуск по сохранённым настройкам ==================== */
  // Единый путь для возобновления после перезагрузки, повтора в standby и
  // кнопки «Продолжить в этой вкладке» (C-1 п.1):
  //   перечитать настройки → setTargets(cfg.targets) → холостой прогон →
  //   сверить отпечаток с cfg.confirmedFor → только при совпадении
  //   confirmDryRun + start.
  // I-1: после прогона (он идёт по сети, это секунды) ещё раз проверяем, что
  // попытка не устарела (не нажали «Остановить», не открыли мастер) и что
  // настройки за это время не поменялись в другой вкладке.
  // Возвращает { status } — 'started' | 'mismatch' (с cfg и report) |
  // 'off' (поиск выключен/целей нет) | 'paused' | 'superseded'.
  // Ошибки связи пробрасывает наружу.
  function sameSavedConfig(a, b) {
    return !!(a && b) && a.enabled === b.enabled && !!a.paused === !!b.paused &&
      a.confirmedFor === b.confirmedFor && JSON.stringify(a.targets) === JSON.stringify(b.targets);
  }

  async function startFromSavedConfig() {
    const attempt = ++startAttempt;
    const cfg = ui.loadConfig(storage);
    if (!cfg || !cfg.enabled || !Array.isArray(cfg.targets) || !cfg.targets.length) return { status: 'off' };
    if (cfg.paused) return { status: 'paused', cfg };
    core.setTargets(cfg.targets);
    const report = await core.dryRun();
    if (attempt !== startAttempt) return { status: 'superseded' };
    const fresh = ui.loadConfig(storage);
    if (!sameSavedConfig(cfg, fresh)) {
      if (!fresh || !fresh.enabled) return { status: 'off' };
      if (fresh.paused) return { status: 'paused', cfg: fresh };
      return { status: 'superseded' };
    }
    if (report.targetsHash !== cfg.confirmedFor) return { status: 'mismatch', cfg, report };
    core.confirmDryRun(report.id);
    await core.start();
    runningFor = cfg.confirmedFor;
    return { status: 'started', cfg };
  }

  // Условия за пределами мастера изменились (например, структура записей
  // на сайте) — не запускаем молча, показываем новый холостой прогон на
  // шаге 3, чтобы человек подтвердил его ещё раз.
  // C1: цели уже переданы в ядро и отчёт уже снят (report — по cfg.targets) —
  // рисуем renderStep3(report) напрямую, не трогая wizard.selected и не
  // вызывая openWizard(3)/loadStep3(), которые пересобрали бы цели из пустого
  // wizard.selected и стёрли бы их в core.setTargets([]).
  // I-2: значок при этом не должен оставаться зелёным — поиск не идёт.
  function showReconfirm(cfg, report) {
    setBadge({ kind: 'needDryRun', text: '🔴 Подтвердите условия заново', detail: 'поиск не идёт, пока вы не подтвердите' });
    wizard.builtTargets = cfg.targets;
    wizard.report = report;
    wizard.checked = false;
    panelMode = 'wizard';
    wizard.open = true;
    wizard.step = 3;
    showPanel();
    renderStep3(report);
  }

  /* ==================== возобновление после перезагрузки страницы ==================== */
  async function resumeIfEnabled() {
    setBadge({ kind: 'init', text: '…', detail: '' });
    try {
      await core.init();
    } catch (e) {
      setBadge(initErrorBadge(e));
      return;
    }

    const cfg = ui.loadConfig(storage);
    if (!cfg || !cfg.enabled || !Array.isArray(cfg.targets) || !cfg.targets.length) {
      setBadge({ kind: 'idle', text: '🎯 Настроить', detail: '' });
      return;
    }
    if (cfg.paused) {
      // Мастер открывали (здесь или в другой вкладке) и новые условия ещё
      // не подтвердили — по старым целям молча не стартуем.
      setBadge({ kind: 'paused', text: '⏸ Поиск приостановлен', detail: 'нажмите, чтобы настроить заново' });
      return;
    }

    setBadge({ kind: 'resuming', text: '🟢 Возобновляю поиск…', detail: '' });
    let r;
    try {
      r = await startFromSavedConfig();
    } catch (e) {
      setBadge({ kind: 'resumeError', text: '🔴 Не удалось проверить, нажмите для повтора', detail: e && e.message });
      return;
    }

    if (r.status === 'started') {
      setBadge({ kind: 'running', text: '🟢 Ищу слоты', detail: runningDetail() });
      startStatusRefresh();
    } else if (r.status === 'mismatch') {
      showReconfirm(r.cfg, r.report);
    } else if (r.status === 'off') {
      // I-1: пока шёл прогон, поиск выключили (здесь или в другой вкладке).
      if (badgeState.kind === 'resuming') setBadge({ kind: 'idle', text: '🎯 Настроить', detail: '' });
    } else if (r.status === 'paused') {
      if (badgeState.kind === 'resuming') setBadge({ kind: 'paused', text: '⏸ Поиск приостановлен', detail: 'нажмите, чтобы настроить заново' });
    } else if (r.status === 'superseded' && badgeState.kind === 'resuming') {
      // Настройки поменялись в другой вкладке во время прогона — пробуем
      // заново уже по новым.
      resumeIfEnabled();
    }
    // superseded из-за «Остановить»/мастера в этой вкладке: значок уже
    // выставлен ими, ничего не трогаем.
  }

  /* ==================== запуск ==================== */
  async function boot() {
    mountBadge();
    const timer = createWorkerTimer();
    let channel = null;
    try { channel = new BroadcastChannel('emias-slot-hunter'); } catch (e) { channel = null; }
    core = create({ storage, fetch: window.fetch.bind(window), now: () => Date.now(), timer, channel });
    subscribeCore();
    await resumeIfEnabled();
  }

  boot();
})();
