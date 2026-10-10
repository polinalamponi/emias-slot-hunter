// ==UserScript==
// @name         ЕМИАС: охотник за слотами
// @namespace    https://github.com/polinalamponi/emias-slot-hunter
// @version      0.1.2
// @description  Следит за расписанием ЕМИАС и ловит освободившиеся слоты: записывает по направлению и переносит записи на более раннее время
// @author       polinalamponi
// @homepageURL  https://github.com/polinalamponi/emias-slot-hunter
// @supportURL   https://github.com/polinalamponi/emias-slot-hunter/issues
// @updateURL    https://raw.githubusercontent.com/polinalamponi/emias-slot-hunter/main/dist/emias-slot-hunter.user.js
// @downloadURL  https://raw.githubusercontent.com/polinalamponi/emias-slot-hunter/main/dist/emias-slot-hunter.user.js
// @match        https://emias.info/*
// @run-at       document-idle
// @grant        none
// @noframes
// ==/UserScript==

(function () {
'use strict';
/* ---- core/util.js ---- */
// core/util.js
(function (root) {
  'use strict';

  const VERSION = '0.1.2';
  const TZ = 'Europe/Moscow';

  function createUtil() {
    const fmt = (d, opts) => d.toLocaleString('sv-SE', { timeZone: TZ, ...opts });
    const mskDate = (d = new Date()) => fmt(d, { year: 'numeric', month: '2-digit', day: '2-digit' }).slice(0, 10);
    const mskTime = (d = new Date()) => fmt(d, { hour: '2-digit', minute: '2-digit', hour12: false });
    const mskDateTime = (d = new Date()) => fmt(d, { hour12: false });
    const hasZone = (iso) => /[+-]\d\d:?\d\d$|Z$/.test(String(iso).slice(10));
    const toMs = (iso) => new Date(hasZone(iso) ? iso : iso + '+03:00').getTime();
    const slotHHMM = (iso) => mskTime(new Date(toMs(iso)));
    const distTo = (range, startMs, endMs) =>
      Math.max(0, toMs(range.start) - endMs, startMs - toMs(range.end));
    const campus = (addr) => String(addr || '').replace(/,\s*к\.\s*\d+.*$/i, '').trim().toLowerCase();
    const jitter = (ms, rnd = Math.random) => Math.round(ms * (0.8 + rnd() * 0.4));

    return { VERSION, mskDate, mskTime, mskDateTime, toMs, slotHHMM, distTo, campus, jitter };
  }

  const api = { VERSION, createUtil };
  if (typeof module === 'object' && module.exports) module.exports = api;
  else { root.EmiasCore = root.EmiasCore || {}; Object.assign(root.EmiasCore, api); }
})(typeof globalThis !== 'undefined' ? globalThis : this);

/* ---- core/errors.js ---- */
// core/errors.js
(function (root) {
  'use strict';

  function createErrors() {
    const mask = (text) => String(text == null ? '' : text)
      // Проход 1: маскирование по имени поля JSON
      .replace(/"(omsNumber|birthDate|birthdate|patientId|snils|fio|firstName|lastName|middleName|patronymic)"\s*:\s*"[^"]*"/g, (m) => {
        const key = m.match(/"([^"]+)"/)[1];
        return '"' + key + '":"<скрыто>"';
      })
      // Проход 2: полис (16 и более цифр подряд)
      .replace(/\d{16,}/g, '<полис>')
      // Проход 3: дата ISO (YYYY-MM-DD)
      .replace(/\b(19|20)\d\d-\d\d-\d\d(?=["' ]|$)/g, (m) => (Number(m.slice(0, 4)) < 2020 ? '<дата рождения>' : m))
      // Проход 4: дата DD.MM.YYYY
      .replace(/\b(\d{1,2})\.(\d{1,2})\.((19|20)\d\d)\b/g, (m) => {
        const year = Number(m.split('.')[2]);
        return (year >= 1900 && year <= 2019) ? '<дата рождения>' : m;
      })
      // Проход 5: ФИО (полное имя с отчеством)
      .replace(/\b[А-ЯЁ][а-яё]+\s+[А-ЯЁ][а-яё]+(вич|вна|ична)\b/g, '<ФИО>');

    const KNOWN = {
      SA_SAME_BM_IS_NOT_AVAILABLE: { message: 'Вы уже записаны на это исследование — перехожу в режим переноса.', action: 'switchToShift' },
      SA_REFERRAL_EXPIRED: { message: 'Направление истекло — цель отключена.', action: 'stopTarget' },
      SA_APPOINTMENT_NOT_FOUND: { message: 'Запись не найдена: возможно, её отменили или перенесли в другом месте.', action: 'stopTarget' },
      // Живой ответ ЕМИАС и на перенос уже начавшейся записи, и на приём
      // без направления (ЦЖЗ), который сайт этим путём переносить не даёт.
      SA_APPOINTMENT_CANNOT_BE_CANCELED: { message: 'ЕМИАС не даёт перенести эту запись: приём уже начался, запись отменена или такой перенос сайт не разрешает. Цель остановлена.', action: 'stopTarget' },
    };

    function explain({ status, code, text }) {
      if (code && KNOWN[code]) return KNOWN[code];
      // I4: в реальном пути 401 сюда не доходит — core/api.js сам перехватывает
      // 401 до вызова explain() (один раз продлевает сессию и повторяет запрос,
      // а при повторном 401 сразу бросает SessionError с тем же по смыслу
      // текстом, см. api.js), поэтому явное действие пользователю показывает
      // именно то исключение. Ветка ниже остаётся ради других вызывающих кодов
      // explain() напрямую (см. test/errors.test.js) и на случай, если этот
      // порядок обработки 401 в api.js когда-нибудь изменится — тест ниже
      // прямо помечен как проверка explain() в изоляции, а не сквозного пути.
      if (status === 401) return { message: 'ЕМИАС перестал принимать вход. Войдите заново в другой вкладке — поиск продолжится сам.', action: 'relogin' };
      if (status === 429) return { message: 'ЕМИАС просит не частить — пауза 30 секунд.', action: 'wait' };
      if (status >= 500) return { message: 'ЕМИАС временно отвечает ошибкой — пауза 30 секунд.', action: 'wait' };
      return { message: 'Непонятный ответ ЕМИАС: ' + mask(text).slice(0, 300), action: 'retry' };
    }

    return { mask, explain };
  }

  const api = { createErrors };
  if (typeof module === 'object' && module.exports) module.exports = api;
  else { root.EmiasCore = root.EmiasCore || {}; Object.assign(root.EmiasCore, api); }
})(typeof globalThis !== 'undefined' ? globalThis : this);

/* ---- core/filters.js ---- */
// core/filters.js
(function (root) {
  'use strict';

  function createFilters(util) {
    const { toMs, slotHHMM, distTo, campus } = util;

    // Можно ли занять слот, не нарушив другие записи того же дня: между записями
    // в разных кампусах нужен запас travelMs на дорогу, в одном и том же — можно впритык.
    function travelOk({ selfId, address, slot, appointments, travelMs }) {
      const s = toMs(slot.startTime);
      const e = toMs(slot.endTime);
      const day = slot.startTime.slice(0, 10);
      for (const a of appointments || []) {
        if (selfId != null && a.id === selfId) continue;
        if (a.startTime.slice(0, 10) !== day) continue;
        const gap = campus(a.lpuAddress) === campus(address) ? 0 : travelMs;
        if (s < toMs(a.endTime) + gap && e > toMs(a.startTime) - gap) return false;
      }
      return true;
    }

    function pickSlots({ slots, target: t, now, appointments, addressOf }) {
      const cur = t.current ? toMs(t.current) : null;
      const ok = [];
      const rejected = [];
      const reject = (slot, reason) => rejected.push({ slot, reason });

      // onlyIfConflict: не трогаем запись, если она ни с чем не пересекается —
      // тогда искать замену незачем, возвращаем пустой результат с пометкой skipped.
      if (t.onlyIfConflict && cur != null) {
        const self = (appointments || []).find((a) => a.id === t.selfId);
        const hasConflict = self ? !travelOk({
          selfId: t.selfId, address: self.lpuAddress,
          slot: { startTime: self.startTime, endTime: self.endTime },
          appointments, travelMs: t.travelMs,
        }) : false;
        if (!hasConflict) return { ok: [], rejected: [], skipped: 'конфликта нет' };
      }

      // Для режима near расстояние текущей записи до желаемого интервала — точка
      // отсчёта: слот принимаем только если он ближе к near, чем сама текущая запись.
      let curDist = null;
      if (t.near && cur != null) {
        const self = (appointments || []).find((a) => a.id === t.selfId);
        curDist = self ? distTo(t.near, toMs(self.startTime), toMs(self.endTime)) : distTo(t.near, cur, cur);
      }

      for (const slot of slots) {
        const s = toMs(slot.startTime);
        const day = slot.startTime.slice(0, 10);
        if (s - now < t.minLeadMs) { reject(slot, `слишком скоро (меньше ${Math.round(t.minLeadMs / 3600000)} ч)`); continue; }
        if (t.onlyDay && day !== t.onlyDay) { reject(slot, 'другой день'); continue; }
        if (t.dateFrom && day < t.dateFrom) { reject(slot, 'раньше выбранной даты'); continue; }
        if (t.dateTo && day > t.dateTo) { reject(slot, 'позже выбранной даты'); continue; }
        if (t.timeFrom && slotHHMM(slot.startTime) < t.timeFrom) { reject(slot, 'раньше выбранного времени'); continue; }
        if (t.timeTo && slotHHMM(slot.startTime) > t.timeTo) { reject(slot, 'позже выбранного времени'); continue; }
        if (cur != null && s === cur) { reject(slot, 'это и есть текущая запись'); continue; }
        if (t.near) {
          if (curDist != null && distTo(t.near, s, toMs(slot.endTime)) >= curDist) { reject(slot, 'не ближе к нужной записи'); continue; }
        } else if (cur != null && !t.anyTime && s >= cur) { reject(slot, 'позже текущей записи'); continue; }
        if (t.respectTravel && !travelOk({ selfId: t.selfId, address: addressOf(slot), slot, appointments, travelMs: t.travelMs })) {
          reject(slot, 'не успеть доехать между записями'); continue;
        }
        ok.push(slot);
      }

      if (t.near) {
        // Сортируем по близости к желаемому интервалу near (0 = пересекается с ним).
        ok.sort((a, b) => distTo(t.near, toMs(a.startTime), toMs(a.endTime)) - distTo(t.near, toMs(b.startTime), toMs(b.endTime)));
      } else if (t.anyTime && cur != null) {
        // При anyTime ориентируемся на время текущей записи: ближайшие по модулю — первыми.
        ok.sort((a, b) => Math.abs(toMs(a.startTime) - cur) - Math.abs(toMs(b.startTime) - cur));
      } else {
        // prefer поднимает наверх слоты, попадающие в предпочтительное окно
        // (день не позже prefer.until и, если задано, время раньше prefer.timeTo);
        // внутри каждой группы (предпочтительные / остальные) — по возрастанию времени.
        const preferred = (slot) => (t.prefer
          && slot.startTime.slice(0, 10) <= t.prefer.until
          && (!t.prefer.timeTo || slotHHMM(slot.startTime) < t.prefer.timeTo) ? 0 : 1);
        ok.sort((a, b) => preferred(a) - preferred(b) || toMs(a.startTime) - toMs(b.startTime));
      }

      return { ok, rejected };
    }

    return { pickSlots, travelOk };
  }

  const api = { createFilters };
  if (typeof module === 'object' && module.exports) module.exports = api;
  else { root.EmiasCore = root.EmiasCore || {}; Object.assign(root.EmiasCore, api); }
})(typeof globalThis !== 'undefined' ? globalThis : this);

/* ---- core/session.js ---- */
// core/session.js
(function (root) {
  'use strict';

  const SITE_KEY = 'persist:sessionAuth';
  const MY_KEY = 'emiasSlotHunter:auth';

  function createSession({ storage, fetch, now }) {
    let auth = null;            // { access, refresh, at }
    let identity = { oms: null, birth: null };
    let ttlMs = 3600000;
    let refreshedAt = 0;
    let refreshing = null;

    function readSite() {
      try {
        const raw = storage.getItem(SITE_KEY);
        if (!raw) return null;
        const s = JSON.parse(raw);
        let at = 0;
        try { at = new Date(JSON.parse(s.ctime)).getTime() || 0; } catch (e) { at = 0; }
        return { access: JSON.parse(s.accessToken), refresh: JSON.parse(s.refreshToken), at };
      } catch (e) { return null; }
    }
    function readMine() {
      try {
        const a = JSON.parse(storage.getItem(MY_KEY));
        return a && a.access && a.refresh ? a : null;
      } catch (e) { return null; }
    }
    function read() {
      const site = readSite();
      const mine = readMine();
      const best = mine && (!site || (mine.at || 0) > site.at) ? mine : site;
      if (!best) throw new Error('нет входа в ЕМИАС: войдите на сайте и попробуйте снова');
      auth = auth && auth.at > (best.at || 0) ? auth : best;
      return auth;
    }

    async function tryRefresh(refreshToken) {
      const r = await fetch('/web-api/refreshTokens/', {
        method: 'POST', credentials: 'include',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json', 'X-App': 'portal' },
        body: JSON.stringify({ refreshToken }),
      });
      const j = r.ok ? await r.json().catch(() => null) : null;
      if (!r.ok || !j || !j.access_token) return false;
      auth = { access: j.access_token, refresh: j.refresh_token || refreshToken, at: now() };
      ttlMs = (j.expires_in || 3600) * 1000;
      refreshedAt = now();
      try { storage.setItem(MY_KEY, JSON.stringify(auth)); } catch (e) { /* приватный режим */ }
      return true;
    }

    function refresh() {
      if (refreshing) return refreshing;
      refreshing = (async () => {
        const seen = new Set();
        const candidates = [auth, readMine(), readSite()].filter(Boolean);
        for (const c of candidates) {
          if (!c.refresh || seen.has(c.refresh)) continue;
          seen.add(c.refresh);
          if (await tryRefresh(c.refresh)) return true;
        }
        return false;
      })().finally(() => { refreshing = null; });
      return refreshing;
    }

    return {
      read, refresh,
      token: () => (auth || read()).access,
      setAuth: (a) => { auth = a; },
      identity: () => identity,
      setIdentity: (v) => { identity = { ...identity, ...v }; },
      get ttlMs() { return ttlMs; },
      get refreshedAt() { return refreshedAt; },
      needsRefresh: (fraction) => {
        const age = Math.max(refreshedAt, (auth && auth.at) || 0);
        return !age || now() - age > ttlMs * fraction;
      },
    };
  }

  const api = { createSession };
  if (typeof module === 'object' && module.exports) module.exports = api;
  else { root.EmiasCore = root.EmiasCore || {}; Object.assign(root.EmiasCore, api); }
})(typeof globalThis !== 'undefined' ? globalThis : this);

/* ---- core/api.js ---- */
// core/api.js
(function (root) {
  'use strict';

  class SessionError extends Error {
    constructor(message) {
      super(message);
      this.name = 'SessionError';
    }
  }

  const NET_STEPS = [30000, 60000, 120000, 300000];

  function createApi({ session, errors, fetch, now }) {
    let backoffUntil = 0;
    let netStep = -1;

    // Общая часть post() и get(): заголовки, сетевой бэкофф, продление сессии
    // по 401, разбор ответа. body === undefined → запрос без тела (GET), с
    // телом → Content-Type и JSON.stringify (POST).
    async function request(method, path, body, retried) {
      let r;
      try {
        const headers = { Accept: 'application/json', 'EI-Token': session.token(), 'X-App': 'portal' };
        const opts = { method, headers };
        if (body !== undefined) {
          headers['Content-Type'] = 'application/json';
          opts.body = JSON.stringify(body);
        }
        r = await fetch('/api-eip/' + path, opts);
      } catch (e) {
        // Увеличиваем паузу при сетевой ошибке: 30s → 60s → 120s → 300s
        netStep = Math.min(netStep + 1, NET_STEPS.length - 1);
        backoffUntil = now() + NET_STEPS[netStep];
        return { ok: false, status: 0, json: null, explained: { message: 'Нет связи с ЕМИАС — попробую позже.', action: 'wait' } };
      }
      // Сброс счётчика сетевых ошибок при успешном соединении
      netStep = -1;

      const text = await r.text();
      let json = null;
      try { json = JSON.parse(text); } catch (e) { json = null; }

      // 401: пытаемся один раз продлить сессию и повторить запрос
      if (r.status === 401 && !retried) {
        if (await session.refresh()) return request(method, path, body, true);
      }
      // Повторный 401 — сессия не продлевается. Текст этого сообщения попадает
      // пользователю на глаза как есть (userscript/ui-dom.js onSessionLost
      // показывает payload.message из core/runner.js 'сессия потеряна'/e.message
      // в пояснении к значку), поэтому пишем его по-человечески, а не
      // техническим языком — и той же формулировкой, что уже даёт errors.js
      // для 401 (см. explain()), чтобы текст не расходился в зависимости от
      // того, через какой путь сессия оказалась потеряна.
      if (r.status === 401) throw new SessionError('Вход в ЕМИАС закончился. Войдите заново в другой вкладке — поиск продолжится сам.');
      // 429 и 5xx ошибки требуют паузу
      if (r.status === 429 || r.status >= 500) backoffUntil = now() + 30000;

      // Если 2xx статус но JSON не разобрался и текст не пустой (например, HTML-заглушка) — это ошибка
      // Пустой текст с 2xx считается успехом (json: null)
      if (r.ok && json === null && text.trim() !== '') {
        return {
          ok: false, status: r.status, json: null,
          explained: errors.explain({ status: r.status, code: undefined, text }),
        };
      }

      const err = json && (json.error || (json.errorCode ? { code: json.errorCode } : null));
      const ok = r.ok && !err;
      return {
        ok, status: r.status, json,
        explained: ok ? null : errors.explain({ status: r.status, code: err && err.code, text }),
      };
    }

    function post(path, body, retried) {
      const id = session.identity();
      return request('POST', path, { omsNumber: id.oms, birthDate: id.birth, ...body }, retried);
    }

    // GET без тела и без omsNumber/birthDate — используется до того, как
    // личность вообще определена (core/index.js: фолбэк даты рождения на
    // /v2/policy/list), поэтому в отличие от post() ничего не берёт из
    // session.identity().
    function get(path, retried) {
      return request('GET', path, undefined, retried);
    }

    return { post, get, backoffUntil: () => backoffUntil, SessionError };
  }

  const api = { createApi, SessionError };
  if (typeof module === 'object' && module.exports) module.exports = api;
  else { root.EmiasCore = root.EmiasCore || {}; Object.assign(root.EmiasCore, api); }
})(typeof globalThis !== 'undefined' ? globalThis : this);

/* ---- core/discover.js ---- */
(function (root) {
  'use strict';

  // today() — сегодняшняя дата 'YYYY-MM-DD' по Москве; без неё срок
  // направлений не проверяется.
  function createDiscover({ api, today }) {
    // Направление со сроком раньше сегодняшнего дня уже не даёт записаться.
    const expired = (dateTo) => !!(today && dateTo && String(dateTo).slice(0, 10) < today());

    async function list() {
      const [refRes, apptRes] = await Promise.all([
        api.post('v4/saOrchestrator/getAssignmentsReferralsInfo', {}),
        api.post('v10/saOrchestrator/getAppointmentReceptionsByPatient', {}),
      ]);

      // IMPORTANT 3: проверяем, что оба запроса успешны
      if (!refRes.ok || !apptRes.ok) {
        const msg = (refRes.ok ? apptRes : refRes).explained?.message || 'Не удалось получить данные из ЕМИАС, попробуйте ещё раз';
        throw new Error(msg);
      }

      const ar = (refRes.json && refRes.json.payload && refRes.json.payload.arInfo) || {};
      const appts = (apptRes.json && apptRes.json.payload && apptRes.json.payload.appointment) || [];
      const out = [];

      // Обрабатываем существующие записи как цели переноса
      for (const a of appts) {
        // IMPORTANT 2: проверяем наличие startTime перед конкатенацией
        const current = a.startTime ? (a.startTime + '+03:00') : null;
        const common = { current, address: a.lpuAddress || null, deadline: null, supported: !!a.enableShift,
          unsupportedReason: a.enableShift ? null : 'ЕМИАС не разрешает переносить эту запись' };
        // Вид записи определяем по содержимому, а не по a.type: на живом сайте
        // приём врача без направления пришёл с type не 'DOCTOR' и молча выпадал.
        if (a.toBM) {
          out.push({ id: 'appt:' + a.id, scenario: 'shiftLab', title: a.toBM.name, ...common,
            source: { appointmentId: a.id, moId: a.lpuId, samplingTypeId: a.toBM.id } });
        } else if (a.toLdp) {
          out.push({ id: 'appt:' + a.id, scenario: 'shiftLdp', title: a.toLdp.ldpTypeName, ...common,
            source: { appointmentId: a.id, ldpTypeId: Number(a.toLdp.ldpTypeId), referralId: a.referral && a.referral.referralId, lpuId: a.lpuId } });
        } else if (a.toDoctor) {
          out.push({ id: 'appt:' + a.id, scenario: 'shiftDoctor', title: a.toDoctor.specialityName, ...common,
            source: { appointmentId: a.id, specialityName: a.toDoctor.specialityName, referralId: a.referral && a.referral.referralId, lpuId: a.lpuId } });
        } else {
          // Непонятную запись не прячем: человек должен видеть, что скрипт её
          // заметил, но пока не умеет с ней работать.
          out.push({ id: 'appt:' + a.id, scenario: 'unknownAppointment', title: 'Запись', ...common,
            supported: false, unsupportedReason: 'Такую запись скрипт пока не умеет переносить',
            source: { appointmentId: a.id } });
        }
      }

      // Если есть свободные направления на кровь, предлагаем их как цели записи
      // CRITICAL 1: дедупликация теперь по паре (moId + samplingTypeId), не по названию
      const bookedLab = new Set(out.filter((o) => o.scenario === 'shiftLab').map((o) => `${o.source.moId}:${o.source.samplingTypeId}`));
      // Живой ЕМИАС отдаёт { items, count }, старые фикстуры — массив.
      const assignments = Array.isArray(ar.assignments) ? ar.assignments : (ar.assignments && ar.assignments.items) || [];
      for (const as of assignments) {
        if (!as.active || !as.appointmentAvailable) continue;
        if (expired(as.period && as.period.dateTo)) continue;
        const title = (as.toBM && as.toBM.name) || 'Лабораторное исследование';
        const labKey = `${as.moId}:${as.toBM && as.toBM.id}`;
        if (bookedLab.has(labKey)) continue;
        out.push({ id: `lab:${as.moId}:${as.toBM && as.toBM.id}`, scenario: 'bookLab', title,
          current: null, address: as.moName || null, deadline: as.period && as.period.dateTo,
          supported: true, unsupportedReason: null,
          source: { moId: as.moId, samplingTypeId: as.toBM && as.toBM.id } });
      }

      // Направления без активной записи: к врачу (toDoctor) — цель bookDoctor,
      // на исследование (toLdp) — bookLdp. Запросы bookLdp взяты по аналогии с
      // bookDoctor и на живом сайте ещё не сняты.
      for (const ref of (ar.referrals && ar.referrals.items) || []) {
        if (ref.countActiveAppointment > 0) continue;
        if (expired(ref.endTime)) continue;
        if (ref.toDoctor) {
          const title = ref.toDoctor.specialityName + (ref.toDoctor.doctorFio ? ' — ' + ref.toDoctor.doctorFio : '');
          out.push({ id: 'ref:' + ref.id, scenario: 'bookDoctor', title, current: null,
            address: ref.lpuName || null, deadline: ref.endTime, supported: true, unsupportedReason: null,
            source: {
              referralId: ref.id, lpuId: ref.lpuId, specialityId: ref.toDoctor.specialityId,
              needPurpose: !!ref.needPurpose, availableResourceId: ref.availableResourceId || null,
            } });
          continue;
        }
        if (ref.toLdp) {
          out.push({ id: 'ref:' + ref.id, scenario: 'bookLdp', title: ref.toLdp.ldpTypeName || 'Исследование', current: null,
            address: ref.lpuName || null, deadline: ref.endTime, supported: true, unsupportedReason: null,
            source: { referralId: ref.id, lpuId: ref.lpuId, ldpTypeId: Number(ref.toLdp.ldpTypeId) } });
          continue;
        }
        const title = 'Направление';
        out.push({ id: 'ref:' + ref.id, scenario: 'bookReferral', title, current: null,
          address: ref.lpuName || null, deadline: ref.endTime, supported: false,
          unsupportedReason: 'Новая запись по такому направлению появится в следующей версии',
          source: { referralId: ref.id, lpuId: ref.lpuId } });
      }

      return out;
    }

    return { list };
  }

  const api = { createDiscover };
  if (typeof module === 'object' && module.exports) module.exports = api;
  else { root.EmiasCore = root.EmiasCore || {}; Object.assign(root.EmiasCore, api); }
})(typeof globalThis !== 'undefined' ? globalThis : this);

/* ---- core/targets.js ---- */
// core/targets.js — новая запись по направлению: на анализ крови (bookLab), к врачу
// (bookDoctor), на исследование (bookLdp) — и перенос существующих записей
// (shiftLab, shiftLdp, shiftDoctor).
(function (root) {
  'use strict';

  function createTargets({ api, filters, util }) {
    const { toMs, campus } = util;

    // Поддерживаются только эти сценарии. Всё остальное (например,
    // bookReferral — направление непонятного вида) в v0.1 не
    // реализовано: явный белый список не даёт случайно уйти в сетевой
    // запрос с недостающими полями (например, appointmentId === undefined).
    const SUPPORTED_SCENARIOS = new Set(['bookLab', 'shiftLab', 'shiftLdp', 'shiftDoctor', 'bookDoctor', 'bookLdp']);
    const UNSUPPORTED_MESSAGE = 'Этот вид записи пока не поддерживается';
    const NEED_PURPOSE_MESSAGE = 'Для этого направления нужно выбрать цель визита';

    // Рекурсивно собираем доступные ресурсы (кабинеты/врачей) из ответа ЕМИАС.
    // Ветки notAvailable* пропускаем — это места, где приёма нет; собственные
    // флаги узла (notAvailable: true / available: false) проверяем отдельно,
    // т.к. ЕМИАС иногда помечает недоступность прямо на самом ресурсе, а не
    // только через обёртку notAvailableResources. Дедуплицируем по id — один
    // и тот же кабинет может встретиться в дереве несколько раз.
    function collectResources(payload) {
      const out = [];
      const seen = new Set();
      (function walk(node, notAvail) {
        if (Array.isArray(node)) { node.forEach((n) => walk(n, notAvail)); return; }
        if (!node || typeof node !== 'object') return;
        const selfNotAvail = node.notAvailable === true || node.available === false;
        for (const [k, v] of Object.entries(node)) {
          if (v && typeof v === 'object') walk(v, notAvail || selfNotAvail || /notAvailable/i.test(k));
        }
        if (!notAvail && !selfNotAvail && node.id && Array.isArray(node.complexResource) && 'arType' in node && !seen.has(node.id)) {
          seen.add(node.id);
          out.push(node);
        }
      })(payload, false);
      return out;
    }

    // Адрес кабинета берём только при точном совпадении id — раньше при
    // рассинхронизации id молча подставлялся адрес первого кабинета в
    // списке, из-за чего человек мог записаться по чужому адресу в обход
    // фильтра addressContains. Сравниваем строками — id из разных ответов
    // ЕМИАС иногда приходят числом и строкой.
    function scheduleAddress(payload, crId) {
      const crs = (payload && payload.availableResource && payload.availableResource.complexResource) || [];
      const cr = crs.find((c) => String(c.id) === String(crId));
      return (cr && cr.room && cr.room.defaultAddress) || '';
    }

    function scheduleSlots(payload, crId) {
      const out = [];
      for (const day of (payload && payload.scheduleOfDay) || [])
        for (const sb of day.scheduleBySlot || [])
          if (!sb.complexResourceId || sb.complexResourceId === crId)
            for (const sl of sb.slot || []) out.push(sl);
      return out.sort((a, b) => toMs(a.startTime) - toMs(b.startTime));
    }

    // bookLab, bookDoctor и bookLdp — сценарии новой записи; остальные — переносы
    // существующих записей и требуют appointmentId в каждом запросе к ЕМИАС.
    const isShift = (t) => !['bookLab', 'bookDoctor', 'bookLdp'].includes(t.scenario);
    const isReferralBooking = (t) => t.scenario === 'bookDoctor' || t.scenario === 'bookLdp';

    // Период поиска: не раньше сегодняшнего дня (и не раньше dateFrom цели).
    // Верхняя граница — в таком порядке: onlyDay; день текущей записи (для
    // обычного переноса без anyTime — искать позже неё бессмысленно); dateTo
    // цели. Если ничего из этого не задано (а discover.js в v0.1 не
    // проставляет dateTo ни одной цели), раньше поиск схлопывался в «только
    // сегодня», и охотник неделями смотрел на один день, ничего не находя и
    // не сообщая об этом. Теперь в этом случае берём deadline цели (срок
    // действия направления), а если и его нет — смотрим на 30 дней вперёд.
    const period = (t, now) => {
      const today = util.mskDate(new Date(now));
      const dateFrom = t.dateFrom && t.dateFrom > today ? t.dateFrom : today;
      const explicitLast = t.onlyDay || (t.current && !t.anyTime ? t.current.slice(0, 10) : t.dateTo) || t.dateTo;
      const defaultHorizon = () => util.mskDate(new Date(now + 30 * 24 * 3600000));
      const last = explicitLast || t.deadline || defaultHorizon();
      return { dateFrom, dateTo: last < dateFrom ? dateFrom : last };
    };

    async function listResources(t, p) {
      if (t.scenario === 'bookLab' || t.scenario === 'shiftLab') {
        // Пока у пациента есть активная запись на это же лабораторное исследование,
        // ЕМИАС отклоняет поиск слотов для НОВОЙ записи — нужен режим переноса
        // с appointmentId и moId (lpuId) текущей записи в assignment.
        const body = t.scenario === 'bookLab'
          ? { assignment: { moId: t.source.moId, samplingTypeId: t.source.samplingTypeId, period: p } }
          : { appointmentId: t.source.appointmentId, assignment: { moId: t.source.moId, samplingTypeId: t.source.samplingTypeId, period: p } };
        return api.post('v4/saOrchestrator/getDoctorsInfoForLI', body);
      }
      if (isReferralBooking(t)) {
        // Новая запись по направлению — без appointmentId и без
        // purposeReceptionForm (это поле относится только к переносу).
        return api.post('v5/saOrchestrator/getDoctorsInfo', { referralId: t.source.referralId });
      }
      return api.post('v5/saOrchestrator/getDoctorsInfo', { appointmentId: t.source.appointmentId, purposeReceptionForm: 'personal' });
    }

    async function search(t, ctx) {
      if (!SUPPORTED_SCENARIOS.has(t.scenario)) {
        return { candidates: [], rejected: [], notes: [UNSUPPORTED_MESSAGE], action: null };
      }
      // Направление требует выбора цели визита (needPurpose), а мастер её ещё не
      // задал (t.purpose) — без неё сайт отклоняет и расписание, и запись, поэтому
      // не делаем вообще никаких запросов, а сразу объясняем, чего не хватает.
      if (t.scenario === 'bookDoctor' && t.source.needPurpose && !t.purpose) {
        return { candidates: [], rejected: [], notes: [NEED_PURPOSE_MESSAGE], action: null };
      }
      const p = period(t, ctx.now);
      const notes = [];
      let action = null;
      const res = await listResources(t, p);
      if (!res.ok) {
        return {
          candidates: [], rejected: [],
          notes: [res.explained ? res.explained.message : 'ЕМИАС не отдал список кабинетов'],
          action: (res.explained && res.explained.action) || null,
        };
      }
      let resources = collectResources(res.json && res.json.payload);
      // Направление к конкретному врачу (availableResourceId уже известен из
      // getAssignmentsReferralsInfo) — не предлагаем записаться к другому врачу.
      if (t.scenario === 'bookDoctor' && t.source.availableResourceId) {
        resources = resources.filter((r) => String(r.id) === String(t.source.availableResourceId));
      }
      if (!resources.length) return { candidates: [], rejected: [], notes: ['Свободных кабинетов или врачей сейчас нет'], action: null };

      const candidates = [];
      let rejected = [];
      let addressMismatch = 0;
      let addressUnknown = 0;
      // C2: без этой проверки цикл продолжал бы слать getAvailableResourceScheduleInfo
      // по всем оставшимся кабинетам/врачам даже после того, как ЕМИАС уже ответил 429 —
      // от одной цели с десятками ресурсов в один тик могло уйти десятки запросов подряд.
      // ctx.now — снимок времени на момент вызова search(), тот же now(), которым api.js
      // выставляет backoffUntil, так что сравнение честное в пределах одного вызова.
      let pausedByBackoff = false;
      resourceLoop:
      for (const r of resources) {
        for (const cr of r.complexResource) {
          if (ctx.now < api.backoffUntil()) { pausedByBackoff = true; break resourceLoop; }
          const body = { availableResourceId: r.id, complexResourceId: cr.id, period: p };
          if (isShift(t)) body.appointmentId = t.source.appointmentId;
          // Перенос исследования иногда требует ещё и referralId — если он есть у цели, передаём сразу.
          if (isShift(t) && t.source.referralId) body.referralId = t.source.referralId;
          if (isReferralBooking(t)) {
            body.referralId = t.source.referralId;
            if (t.purpose && t.purpose.inquiryPurposeId) body.inquiryPurposeId = t.purpose.inquiryPurposeId;
          }
          const s = await api.post('v4/saOrchestrator/getAvailableResourceScheduleInfo', body);
          if (!s.ok) {
            notes.push(s.explained ? s.explained.message : 'расписание недоступно');
            action = (s.explained && s.explained.action) || action;
            continue;
          }
          const address = scheduleAddress(s.json.payload, cr.id);
          if (!address) { addressUnknown++; continue; }
          if (t.addressContains && !address.toLowerCase().includes(String(t.addressContains).toLowerCase())) { addressMismatch++; continue; }
          const slots = scheduleSlots(s.json.payload, cr.id);
          const picked = filters.pickSlots({
            slots,
            target: { ...t, selfId: t.source.appointmentId || null },
            now: ctx.now, appointments: ctx.appointments, addressOf: () => address,
          });
          // onlyIfConflict мог решить, что переносить нечего (конфликта нет) — без этой
          // строки в notes человек видел бы пустой список без объяснения причины.
          if (picked.skipped) notes.push(picked.skipped);
          rejected = rejected.concat(picked.rejected.map((x) => ({ ...x, address })));
          for (const slot of picked.ok) candidates.push({ slot, address, resourceId: r.id, complexResourceId: cr.id, name: r.name });
        }
      }
      if (addressUnknown) notes.push(`Не удалось определить адрес ${addressUnknown} кабинет(ов) в расписании — пропущены`);
      if (addressMismatch) notes.push(`Кабинетов с другим адресом пропущено: ${addressMismatch}`);
      if (pausedByBackoff) notes.push('ЕМИАС попросил паузу — часть кабинетов не проверена, продолжу на следующей проверке');
      return { candidates, rejected, notes, action };
    }

    // Проверяем, что найденная в списке запись — действительно та, что мы только что
    // создали/перенесли, а не что-то постороннее, случайно совпавшее по времени:
    //  - время начала должно совпасть со слотом;
    //  - адрес (кампус, без номера корпуса) должен совпасть с адресом кандидата;
    //  - для bookLab запись обязана получить НОВЫЙ id — ЕМИАС не присваивает новый id
    //    старой записи, поэтому id, уже бывший в списке ДО брони, не считается совпадением;
    //  - при переносе ЕМИАС выдаёт записи новый id, поэтому своей считаем запись с прежним
    //    id или новую (её не было в списке до переноса), а не любую с тем же временем;
    //  - тип записи должен соответствовать сценарию (в т.ч. конкретный вид анализа для
    //    shiftLab и конкретный ldpTypeId для shiftLdp — иначе можно принять за свою запись
    //    чужой перенесённый анализ/исследование с тем же временем).
    function matches(t, appt, cand, beforeIds) {
      if (toMs(appt.startTime) !== toMs(cand.slot.startTime)) return false;
      if (campus(appt.lpuAddress) !== campus(cand.address)) return false;
      if (t.scenario === 'bookLab') {
        if (beforeIds.has(appt.id)) return false;
        return !!appt.toBM && Number(appt.toBM.id) === Number(t.source.samplingTypeId);
      }
      if (t.scenario === 'bookDoctor') {
        if (beforeIds.has(appt.id)) return false;
        return !!appt.toDoctor;
      }
      if (t.scenario === 'bookLdp') {
        if (beforeIds.has(appt.id)) return false;
        return !!appt.toLdp && Number(appt.toLdp.ldpTypeId) === Number(t.source.ldpTypeId);
      }
      // Перенос: ЕМИАС выдаёт перенесённой записи новый id (проверено на живом
      // сайте — и для крови, и для приёма врача). Поэтому своя запись — либо с
      // прежним id, либо новая, которой не было в списке до переноса. Запись,
      // которая уже была до переноса под другим id, — чужая.
      if (appt.id !== t.source.appointmentId && beforeIds.has(appt.id)) return false;
      if (t.scenario === 'shiftLdp') return !!appt.toLdp && Number(appt.toLdp.ldpTypeId) === Number(t.source.ldpTypeId);
      if (t.scenario === 'shiftDoctor') {
        return !!appt.toDoctor && (!t.source.specialityName || appt.toDoctor.specialityName === t.source.specialityName);
      }
      if (t.scenario === 'shiftLab') return !!appt.toBM && Number(appt.toBM.id) === Number(t.source.samplingTypeId);
      return false;
    }

    // Перечитываем список записей и ищем в нём результат мутации. listRes.ok === false
    // («список недоступен») — это не то же самое, что «записи нет», поэтому у результата
    // есть отдельный флаг verifyFailed. Чтение может ещё и бросить исключение (например,
    // SessionError при повторном 401 уже ПОСЛЕ успешной записи/переноса) — такое исключение
    // не должно топить уже совершённую мутацию, поэтому оно тоже превращается в verifyFailed.
    async function verifyAppointment(t, cand, ctx) {
      const beforeIds = new Set((ctx.appointments || []).map((a) => a.id));
      let listRes;
      try {
        listRes = await api.post('v10/saOrchestrator/getAppointmentReceptionsByPatient', {});
      } catch (e) {
        return { verifyFailed: true };
      }
      if (!listRes.ok) return { verifyFailed: true };
      const appts = (listRes.json && listRes.json.payload && listRes.json.payload.appointment) || [];
      const found = appts.find((a) => matches(t, a, cand, beforeIds)) || null;
      return { found };
    }

    async function act(t, cand, ctx) {
      const base = {
        availableResourceId: cand.resourceId, complexResourceId: cand.complexResourceId,
        startTime: cand.slot.startTime, endTime: cand.slot.endTime,
      };
      let res;
      switch (t.scenario) {
        case 'bookLab': {
          res = await api.post('v4/saOrchestrator/createAppointment', base);
          break;
        }
        case 'bookDoctor': {
          const body = { ...base, referralId: t.source.referralId };
          // Цель визита уходит в запись обоими полями (id и code) только если
          // она реально была выбрана — иначе createAppointment получает лишние
          // поля, которых снятый на сайте запрос без цели не содержал.
          if (t.purpose && t.purpose.inquiryPurposeId) {
            body.inquiryPurposeId = t.purpose.inquiryPurposeId;
            body.inquiryPurposeCode = t.purpose.inquiryPurposeCode;
          }
          res = await api.post('v4/saOrchestrator/createAppointment', body);
          break;
        }
        case 'bookLdp': {
          res = await api.post('v4/saOrchestrator/createAppointment', { ...base, referralId: t.source.referralId });
          break;
        }
        case 'shiftLab':
        case 'shiftLdp':
        case 'shiftDoctor': {
          res = await api.post('v4/saOrchestrator/shiftAppointment', { ...base, appointmentId: t.source.appointmentId });
          // Перенос иногда проходит только со вторым параметром referralId — при отказе
          // повторяем с ним, но ТОЛЬКО при бизнес-отказе (400–499, кроме 429 и «выключить
          // цель»). При сетевой ошибке (status 0), 429 или 5xx api уже выставил паузу перед
          // следующей попыткой — слать второй запрос сразу же значит обойти эту паузу.
          const isBusinessRejection = !res.ok && res.status >= 400 && res.status < 500 && res.status !== 429
            && !(res.explained && res.explained.action === 'stopTarget');
          if (isBusinessRejection && t.source.referralId) {
            res = await api.post('v4/saOrchestrator/shiftAppointment', { ...base, appointmentId: t.source.appointmentId, referralId: t.source.referralId });
          }
          break;
        }
        default:
          return { ok: false, verified: false, message: UNSUPPORTED_MESSAGE, action: null };
      }

      if (!res.ok) {
        // Таймаут (status 0) или 5xx не значат, что мутация не прошла — ЕМИАС мог принять
        // запрос, но не успеть ответить вовремя. Перед вердиктом «не получилось» на всякий
        // случай перечитываем список записей: вдруг перенос/запись всё же случились.
        if (res.status === 0 || res.status >= 500) {
          const verify = await verifyAppointment(t, cand, ctx);
          if (verify.found) return { ok: true, verified: true, message: 'Готово', newAppointment: verify.found, action: null };
        }
        return {
          ok: false, verified: false,
          message: (res.explained && res.explained.message) || 'ЕМИАС отказал',
          action: (res.explained && res.explained.action) || null,
        };
      }

      // После успешного ответа обязательно перечитываем список записей и проверяем, что
      // запись реально появилась в нужное время — ЕМИАС иногда отвечает «готово», но записи нет.
      const verify = await verifyAppointment(t, cand, ctx);
      if (verify.verifyFailed) {
        return {
          ok: true, verified: false, verifyFailed: true,
          message: 'Не удалось проверить результат: ЕМИАС не отдал список записей. Проверю на следующей проверке.',
          action: null,
        };
      }
      if (!verify.found) {
        return { ok: true, verified: false, message: 'ЕМИАС ответил «готово», но в списке записей я этого не вижу — проверьте вручную', action: null };
      }
      return { ok: true, verified: true, message: 'Готово', newAppointment: verify.found, action: null };
    }

    return { search, act };
  }

  const api = { createTargets };
  if (typeof module === 'object' && module.exports) module.exports = api;
  else { root.EmiasCore = root.EmiasCore || {}; Object.assign(root.EmiasCore, api); }
})(typeof globalThis !== 'undefined' ? globalThis : this);

/* ---- core/runner.js ---- */
// core/runner.js — цикл проверок целей: обязательный холостой прогон перед
// стартом, обнаружение сна компьютера, «протухание» проверок и режим
// подтверждения. Время приходит только через now()/timer — прямой
// Date.now()/setTimeout здесь не используются, чтобы тесты были быстрыми и
// детерминированными.
(function (root) {
  'use strict';

  function hash(obj) {
    const s = JSON.stringify(obj);
    let h = 0;
    for (let i = 0; i < s.length; i++) { h = (h * 31 + s.charCodeAt(i)) | 0; }
    return 'dr' + Math.abs(h);
  }

  // Ключ кандидата — чтобы после «не смог проверить» не повторять попытку
  // ровно на том же слоте прямо на следующем тике (риск задвоить запись).
  function candidateKey(cand) {
    return cand.resourceId + ':' + cand.complexResourceId + ':' + cand.slot.startTime;
  }

  // Срок жизни метки «не тот же слот» после verifyFailed. Если слот всё это
  // время остаётся единственным кандидатом, цель не должна зависать на нём
  // бессрочно — по истечении срока попытка на том же слоте снова разрешена.
  const VERIFY_FAILED_TTL_MS = 10 * 60 * 1000;

  // Поля, которые finish() может изменить сам при keepImproving после
  // успешной мутации (перенос на более удобное время). Их исключаем из
  // отпечатка гейта холостого прогона — иначе успешный перенос будет каждый
  // раз ложно требовать новый холостой прогон, хотя человек ничего не менял.
  function gateFingerprint(list) {
    return hash(list.map((t) => {
      const { current, source, scenario, ...rest } = t;
      return rest;
    }));
  }

  function createRunner({ targets, api, session, timer, now, emit, config }) {
    const state = {
      running: false,
      list: [],
      byId: {},
      confirmed: null,
      lastReport: null,
      lastTickAt: 0,
      // Время последней НАСТОЯЩЕЙ проверки — ставится только в tick().
      // lastTickAt при start() тоже взводится (точка отсчёта для обнаружения
      // сна), поэтому для показа «проверено в …» он не годится.
      lastCheckAt: 0,
      lastOkAt: 0,
      staleNotified: false,
      pending: {},
      verifyFailedKey: {},
      leadershipHandlers: [],
    };

    const log = (msg) => emit('log', { at: now(), msg });
    // Нижняя граница интервала — 20 секунд, чтобы не нагружать ЕМИАС, даже
    // если когда-нибудь захочется настроить более «быстрый» slowMs.
    const interval = () => Math.max(config.minIntervalMs, config.slowMs);

    function setTargets(list) {
      state.list = list.map((t) => ({ ...t }));
      state.byId = {};
      state.verifyFailedKey = {};
      for (const t of state.list) state.byId[t.id] = { state: 'idle', note: '' };
      // Смена целей обнуляет подтверждение холостого прогона — иначе можно
      // было бы подтвердить одни цели, а незаметно подставить другие.
      // lastReport тоже устаревает — иначе confirmDryRun() смог бы принять
      // id старого отчёта, снятого по прежнему списку целей.
      state.confirmed = null;
      state.lastReport = null;
    }

    async function appointments() {
      const r = await api.post('v10/saOrchestrator/getAppointmentReceptionsByPatient', {});
      return (r.json && r.json.payload && r.json.payload.appointment) || [];
    }

    function buildWarnings(t, best, r, appts) {
      const w = [];
      if (best && t.addressContains && !best.address.toLowerCase().includes(String(t.addressContains).toLowerCase())) {
        w.push(`Адрес «${best.address}» не содержит «${t.addressContains}»`);
      }
      if (best && t.current && !t.anyTime && !t.near && new Date(best.slot.startTime) > new Date(t.current)) {
        w.push('Найденный слот позже текущей записи');
      }
      if (!best && r.rejected.length) {
        const why = {};
        for (const x of r.rejected) why[x.reason] = (why[x.reason] || 0) + 1;
        w.push('Слоты есть, но все отброшены: ' + Object.entries(why).map(([k, v]) => `${k} (${v})`).join(', '));
      }
      if (best) {
        const sameDay = appts.filter((a) => a.startTime.slice(0, 10) === best.slot.startTime.slice(0, 10));
        if (sameDay.length) w.push(`В этот день уже есть записи: ${sameDay.length}`);
      }
      return w;
    }

    async function dryRun() {
      const appts = await appointments();
      const items = [];
      for (const t of state.list) {
        let r;
        try {
          r = await targets.search(t, { now: now(), appointments: appts });
        } catch (e) {
          // Холостой прогон не должен падать целиком из-за одной сбойной
          // цели — иначе человек не увидит отчёт по остальным целям и не
          // сможет ничего подтвердить. Сбой показываем как предупреждение.
          items.push({
            targetId: t.id, title: t.title, would: null, waiting: true,
            warnings: ['Проверка не выполнена: ' + (e && e.message)], notes: [],
          });
          continue;
        }
        const best = r.candidates[0] || null;
        items.push({
          targetId: t.id, title: t.title,
          would: best ? { ...best.slot, address: best.address } : null,
          waiting: !best,
          warnings: buildWarnings(t, best, r, appts),
          notes: r.notes,
        });
      }
      const report = { id: hash({ list: state.list, at: now() }), items, targetsHash: gateFingerprint(state.list) };
      state.lastReport = report;
      return report;
    }

    function confirmDryRun(id) {
      if (!state.lastReport || state.lastReport.id !== id) throw new Error('отчёт устарел, повторите холостой прогон');
      // Подтверждение фиксируется по отпечатку целей на момент этого отчёта
      // (см. gateFingerprint) — снимок, который переживает последующие
      // мутации current/source/scenario из keepImproving.
      state.confirmed = state.lastReport.targetsHash;
    }

    async function start() {
      if (state.confirmed !== gateFingerprint(state.list)) throw new Error('сначала холостой прогон и подтверждение');
      state.running = true;
      state.lastTickAt = now();
      state.lastCheckAt = 0; // в этом запуске проверок ещё не было
      // Точка отсчёта для обнаружения «протухания»: считаем именно от
      // старта, а не только от последней УДАЧНОЙ проверки — иначе если ни
      // одной успешной проверки так и не случится, stale не придёт никогда.
      state.lastOkAt = now();
      state.staleNotified = false;
      schedule();
    }

    function stop() {
      state.running = false;
      timer.cancel();
    }

    function schedule() {
      if (!state.running) return;
      const base = interval();
      // Небольшой джиттер (±20%), чтобы не долбить ЕМИАС строго по таймеру.
      // minIntervalMs — жёсткий пол ПОСЛЕ джиттера: даже нижняя граница
      // джиттера не должна увести фактическую задержку ниже 20 секунд.
      const jittered = Math.round(base * (0.8 + Math.random() * 0.4));
      timer.schedule(Math.max(config.minIntervalMs, jittered), tick);
    }

    // Три исхода targets.act(): успех (ok && verified) — цель выполнена;
    // «не смогли проверить» (ok && !verified, включая явный verifyFailed) —
    // мутация могла пройти, но подтвердить не удалось: цель НЕ помечаем
    // выполненной и на этом же слоте не повторяемся прямо на следующем
    // тике; отказ (!ok) — смотрим action.
    async function finish(t, cand) {
      const appts = await appointments();
      const res = await targets.act(t, cand, { now: now(), appointments: appts });

      if (res.ok && res.verified) {
        state.byId[t.id] = { state: t.keepImproving ? 'improving' : 'done', note: res.message };
        delete state.verifyFailedKey[t.id];
        if (t.keepImproving && res.newAppointment) {
          t.current = res.newAppointment.startTime + '+03:00';
          const wasBookDoctor = t.scenario === 'bookDoctor';
          t.source = { ...t.source, appointmentId: res.newAppointment.id, moId: res.newAppointment.lpuId || t.source.moId };
          if (wasBookDoctor) {
            // Как и bookLab → shiftLab: после первой успешной записи по направлению
            // цель становится переносом уже СВОЕЙ записи. lpuId и specialityName
            // берём из только что созданной записи (appointmentId уже выставлен
            // строкой выше) — они нужны переносу для описания цели.
            t.source = {
              ...t.source, lpuId: res.newAppointment.lpuId || t.source.lpuId,
              specialityName: (res.newAppointment.toDoctor && res.newAppointment.toDoctor.specialityName) || t.title,
            };
            t.scenario = 'shiftDoctor';
          } else if (t.scenario === 'bookLab') {
            t.scenario = 'shiftLab';
          } else if (t.scenario === 'bookLdp') {
            // referralId и ldpTypeId остаются в source — они нужны переносу.
            t.source = { ...t.source, lpuId: res.newAppointment.lpuId || t.source.lpuId };
            t.scenario = 'shiftLdp';
          }
        }
        // C1: current/source/scenario идут в событие как есть ПОСЛЕ возможной мутации
        // выше — раннер меняет их только у себя в памяти (state.list), а обвязка
        // (userscript) хранит цели отдельно в localStorage (cfg.targets). Без этих
        // полей в payload обвязка не может обновить сохранённую цель и после
        // перезагрузки/захвата другой вкладкой стартует по УСТАРЕВШИМ current/source —
        // gateFingerprint намеренно не замечает эту рассинхронизацию (см. выше), так что
        // дыру не поймать ни один гейт, только сама доставка актуальных полей.
        emit('booked', {
          targetId: t.id, title: t.title, slot: cand.slot, address: cand.address, message: res.message,
          current: t.current, source: t.source, scenario: t.scenario,
        });
        return res;
      }

      if (res.ok && !res.verified) {
        // Не смогли подтвердить результат (verifyFailed или явное «готово,
        // но в списке не вижу») — не трогаем состояние цели и запоминаем
        // слот на VERIFY_FAILED_TTL_MS, чтобы не попытаться записаться на
        // него же ещё раз почти сразу; после истечения срока (или если
        // появится другой кандидат) попытка на этом слоте снова разрешена.
        state.verifyFailedKey[t.id] = { key: candidateKey(cand), expiresAt: now() + VERIFY_FAILED_TTL_MS };
        emit('found', { targetId: t.id, warning: res.message, slot: cand.slot, address: cand.address });
        return res;
      }

      // !res.ok — смотрим на action.
      if (res.action === 'stopTarget') {
        state.byId[t.id] = { state: 'stopped', note: res.message };
        emit('targetDone', { targetId: t.id, title: t.title, message: res.message });
      } else if (res.action === 'relogin') {
        emit('sessionLost', { message: res.message });
        return res;
      }
      // 'wait' | 'switchToShift' | 'retry' | null — обычный повтор на
      // следующем тике, состояние цели не меняем.
      emit('found', { targetId: t.id, warning: res.message, slot: cand.slot, address: cand.address });
      return res;
    }

    // Ответ пользователя на needConfirm (режим mode: 'confirm'). Раннер
    // может быть уже остановлен между needConfirm и ответом человека (или
    // намеренно, или из-за stop()) — в этом случае ничего в ЕМИАС не шлём,
    // заявка остаётся нетронутой на случай последующего запуска.
    async function answer(targetId, decision) {
      if (!state.running) return { ok: false, message: 'раннер остановлен, ответ не отправлен' };
      const p = state.pending[targetId];
      delete state.pending[targetId];
      if (!p) return { ok: false, message: 'решение уже не актуально' };
      if (decision !== 'book') {
        log(`${p.target.title}: пользователь отклонил слот`);
        return { ok: false };
      }
      return finish(p.target, p.candidate);
    }

    async function tick() {
      if (!state.running) return;

      // C2: гейт холостого прогона проверяем не только в start(), но и на
      // каждом тике — setTargets() может прийти уже во время работающего
      // цикла (мастер меняет условия, пока человек ещё читает холостой
      // прогон), и цикл не должен продолжать работать по неподтверждённым
      // целям до следующего запланированного tick().
      if (state.confirmed !== gateFingerprint(state.list)) {
        state.running = false;
        timer.cancel();
        emit('needDryRun', { message: 'цели изменились — нужен новый холостой прогон' });
        return;
      }

      // Обнаружение сна компьютера/вкладки: если между тиками прошло сильно
      // больше, чем должно быть по расписанию, — это не «мы решили не
      // проверять», а комп/браузер были неактивны.
      const gap = now() - state.lastTickAt;
      if (state.lastTickAt && gap > interval() * config.sleepFactor) {
        emit('slept', { from: state.lastTickAt, to: now(), missed: Math.round(gap / interval()) });
      }
      state.lastTickAt = now();
      state.lastCheckAt = now();

      try {
        if (session.needsRefresh(config.refreshAt)) await session.refresh();
        if (now() >= api.backoffUntil()) {
          const appts = await appointments();
          // I4: потеря сессии не должна засчитываться как успешная проверка —
          // оба break targetsLoop ниже взводят этот флаг, и lastOkAt/
          // staleNotified обновляются только если сессия жива.
          let relogin = false;
          targetsLoop:
          for (const t of state.list) {
            // C2: backoffUntil проверяли только один раз в начале tick() (выше) — но
            // targets.search() сам может нарваться на 429 ПОСЕРЕДИНЕ этого перебора
            // (например, у первой цели), и тогда без этой проверки раннер всё равно
            // продолжил бы дёргать ЕМИАС по остальным целям в том же тике.
            if (now() < api.backoffUntil()) break targetsLoop;
            const st = state.byId[t.id];
            // 'improving' — цель уже выполнена один раз, но keepImproving
            // просит продолжать искать более удобный слот, поэтому такую
            // цель не пропускаем, в отличие от 'done' и 'stopped'.
            if (st.state === 'done' || st.state === 'stopped') continue;
            if (state.pending[t.id]) continue; // ждём решения пользователя

            // Текущая запись уже скоро (или прошла) — переносить её некуда:
            // слоты раньше неё отсеет minLeadMs, а ЕМИАС на перенос начавшейся
            // записи отвечает ошибкой. Завершаем цель, а не долбим сайт.
            if (t.current && Date.parse(t.current) - now() < (t.minLeadMs || 0)) {
              const message = `запись на ${String(t.current).slice(0, 16).replace('T', ' ')} уже скоро или прошла — больше не переношу`;
              state.byId[t.id] = { state: 'done', note: message };
              emit('targetDone', { targetId: t.id, title: t.title, message });
              continue;
            }

            const r = await targets.search(t, { now: now(), appointments: appts });

            if (r.action === 'stopTarget') {
              const message = (r.notes && r.notes.join('; ')) || 'цель остановлена';
              state.byId[t.id] = { state: 'stopped', note: message };
              // Та же реакция, что и на stopTarget из act() (см. finish()) —
              // кто следит только за событиями, должен узнать об остановке,
              // а не только по опросу status().
              emit('found', { targetId: t.id, warning: message, slot: null, address: null });
              emit('targetDone', { targetId: t.id, title: t.title, message });
              continue;
            }
            if (r.action === 'relogin') {
              relogin = true;
              emit('sessionLost', { message: (r.notes && r.notes.join('; ')) || 'потеряна сессия' });
              break targetsLoop; // сессия недействительна для всех целей сразу
            }

            if (!r.candidates.length) {
              if (r.notes && r.notes.length) log(`${t.title}: ${r.notes.join('; ')}`);
              continue;
            }

            const cand = r.candidates[0];
            const key = candidateKey(cand);
            const vf = state.verifyFailedKey[t.id];
            if (vf) {
              if (now() < vf.expiresAt && vf.key === key) {
                log(`${t.title}: пропускаю тот же слот после неудачной проверки, попробую другой на следующем тике`);
                continue;
              }
              // Либо срок истёк, либо появился другой кандидат — метка не актуальна.
              delete state.verifyFailedKey[t.id];
            }

            if (t.mode === 'confirm') {
              const expiresAt = now() + 60000;
              state.pending[t.id] = { target: t, candidate: cand, expiresAt };
              emit('needConfirm', { targetId: t.id, title: t.title, slot: cand.slot, address: cand.address, expiresAt });
              continue;
            }

            const res = await finish(t, cand);
            if (res.action === 'relogin') { relogin = true; break targetsLoop; }
          }
          if (!relogin) {
            state.lastOkAt = now();
            state.staleNotified = false;
          }
        }
      } catch (e) {
        if (e && e.name === 'SessionError') emit('sessionLost', { message: e.message });
        else log('сбой проверки: ' + (e && e.message));
      }

      // Протухание: считаем от старта/последней удавшейся проверки. Как
      // только разрыв достиг трёх интервалов — сообщаем один раз и молчим
      // до следующей удачной проверки (staleNotified сбрасывается выше).
      if (now() - state.lastOkAt >= interval() * config.staleFactor && !state.staleNotified) {
        state.staleNotified = true;
        emit('stale', { since: state.lastOkAt });
      }

      for (const [id, p] of Object.entries(state.pending)) {
        if (now() > p.expiresAt) { delete state.pending[id]; log('подтверждение не получено, слот пропущен'); }
      }

      schedule();
    }

    function status() {
      return {
        running: state.running,
        confirmed: state.confirmed === gateFingerprint(state.list),
        lastTickAt: state.lastTickAt,
        lastCheckAt: state.lastCheckAt,
        lastOkAt: state.lastOkAt,
        sessionRefreshedAt: session.refreshedAt,
        targets: state.list.map((t) => ({ id: t.id, title: t.title, current: t.current || null, ...state.byId[t.id] })),
        pending: Object.keys(state.pending),
      };
    }

    // Единая вкладка: у самого core/runner.js в зависимостях фабрики нет
    // ничего для межвкладочной координации (BroadcastChannel/локальная
    // блокировка и т.п. — их нет в списке Consumes этой задачи), поэтому
    // фактический выбор «лидера» среди вкладок браузера — забота обвязки
    // вне core/. Здесь — точка расширения: с точки зрения одного экземпляра
    // раннера он всегда лидер.
    function onLeadership(fn) {
      state.leadershipHandlers.push(fn);
      fn(true);
      return () => { state.leadershipHandlers = state.leadershipHandlers.filter((f) => f !== fn); };
    }

    return { setTargets, dryRun, confirmDryRun, start, stop, tick, answer, status, onLeadership };
  }

  const api = { createRunner };
  if (typeof module === 'object' && module.exports) module.exports = api;
  else { root.EmiasCore = root.EmiasCore || {}; Object.assign(root.EmiasCore, api); }
})(typeof globalThis !== 'undefined' ? globalThis : this);

/* ---- core/index.js ---- */
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

/* ---- userscript/ui-state.js ---- */
// userscript/ui-state.js — чистая логика мастера настройки (без DOM)
(function (root) {
  'use strict';

  const KEY = 'emiasSlotHunter:config';
  const MONTHS = ['января', 'февраля', 'марта', 'апреля', 'мая', 'июня', 'июля', 'августа', 'сентября', 'октября', 'ноября', 'декабря'];

  // Цели визита для направления к врачу с needPurpose: true — сняты с сайта
  // emias.info 2026-09-24 (см. capture-2026-09-24-referral-doctor.md), это
  // единственные два варианта, которые сайт реально предложил для направления
  // к эндокринологу. 'unwell' — вариант по умолчанию.
  const INQUIRY_PURPOSES = {
    unwell: { inquiryPurposeId: 61, inquiryPurposeCode: 251, title: 'Плохое самочувствие или боль' },
    documents: { inquiryPurposeId: 63, inquiryPurposeCode: 255, title: 'Оформление документов' },
  };

  function createUiState() {
    const human = (iso) => {
      if (!iso) return '';
      const d = iso.slice(0, 10).split('-');
      return `${Number(d[2])} ${MONTHS[Number(d[1]) - 1]}, ${iso.slice(11, 16)}`;
    };
    const stripCampus = (addr) => String(addr || '').replace(/,\s*к\.\s*\d+.*$/i, '').trim();
    const dayHuman = (ymd) => { const d = String(ymd).split('-'); return `${Number(d[2])} ${MONTHS[Number(d[1]) - 1]}`; };

    function buildTarget(option, form) {
      // form.when — три взаимоисключающих варианта:
      //  - 'earlier': раньше текущей записи, день любой (onlyDay=null, anyTime=false);
      //  - 'sameDayEarlier': в тот же день, что текущая запись, но раньше неё
      //    (onlyDay = день текущей записи, anyTime=false; человек день не вводит);
      //  - 'onlyDay' (синоним 'anyTimeOnDay'): в выбранный человеком день, любое время
      //    (onlyDay = form.day, anyTime=true) — независимо от того, раньше или позже
      //    текущей записи выбранный день, иначе цель молча никогда ничего не находит.
      const currentDay = option.current ? String(option.current).slice(0, 10) : null;
      let onlyDay = null;
      let anyTime = false;
      if (form.when === 'sameDayEarlier') {
        onlyDay = currentDay;
      } else if (form.when === 'onlyDay' || form.when === 'anyTimeOnDay') {
        onlyDay = form.day || null;
        anyTime = true;
      }

      const deadline = option.deadline || null;
      // Искать за пределами срока действия направления бессмысленно — если человек
      // задал dateTo позже deadline (или deadline вообще не знал), обрезаем по deadline.
      const dateTo = !form.dateTo ? null : (deadline && deadline < form.dateTo ? deadline : form.dateTo);

      return {
        id: option.id, scenario: option.scenario, title: option.title, source: option.source,
        current: option.current || null,
        onlyDay,
        anyTime,
        dateFrom: form.dateFrom || null,
        dateTo,
        deadline,
        timeFrom: form.timeFrom || null,
        timeTo: form.timeTo || null,
        addressContains: form.where === 'sameCampus' ? stripCampus(option.address)
          : form.where === 'contains' ? (form.addressContains || null) : null,
        prefer: form.preferUntil ? { until: form.preferUntil, timeTo: form.preferTimeTo || null } : null,
        near: form.nearStart && form.nearEnd ? { start: form.nearStart, end: form.nearEnd } : null,
        respectTravel: form.respectTravel !== false,
        travelMs: 60 * 60000,
        minLeadMs: 2 * 60 * 60000,
        keepImproving: option.scenario !== 'bookReferral',
        mode: form.mode === 'confirm' ? 'confirm' : 'auto',
        purpose: (option.source && option.source.needPurpose) ? (() => {
          const chosen = INQUIRY_PURPOSES[form.purpose === 'documents' ? 'documents' : 'unwell'];
          return { inquiryPurposeId: chosen.inquiryPurposeId, inquiryPurposeCode: chosen.inquiryPurposeCode };
        })() : null,
      };
    }

    function purposeTitle(purpose) {
      const found = Object.values(INQUIRY_PURPOSES).find((p) => p.inquiryPurposeId === purpose.inquiryPurposeId);
      return found ? found.title : 'выбрана';
    }

    function describeTarget(t) {
      const parts = [];
      if (t.near) parts.push(`подгоняю ближе к ${human(t.near.start)}–${String(t.near.end).slice(11, 16)}`);
      else if (t.onlyDay && t.anyTime) parts.push(`любое время ${dayHuman(t.onlyDay)}`);
      else if (t.onlyDay && t.current) parts.push(`${dayHuman(t.onlyDay)}, раньше ${human(t.current)}`);
      else if (t.onlyDay) parts.push(`только ${dayHuman(t.onlyDay)}`);
      else if (t.current) parts.push(`раньше ${human(t.current)}`);

      // Если день не зафиксирован onlyDay, называем период поиска — иначе цель
      // без текущей записи (запись по направлению) не говорит о датах ничего.
      // Для bookDoctor и bookLdp дата уже называется в head ниже («…по направлению до …»).
      const byReferral = t.scenario === 'bookDoctor' || t.scenario === 'bookLdp';
      if (!t.onlyDay && !byReferral) {
        const last = t.dateTo || t.deadline || null;
        if (t.dateFrom && last) parts.push(`с ${dayHuman(t.dateFrom)} по ${dayHuman(last)}`);
        else if (t.dateFrom) parts.push(`с ${dayHuman(t.dateFrom)}`);
        else if (last) parts.push(`по ${dayHuman(last)}`);
        else if (!t.current && !t.near) parts.push('в ближайшие дни');
      }

      if (t.timeFrom || t.timeTo) parts.push(`время с ${t.timeFrom || '00:00'} до ${t.timeTo || '23:59'}`);
      if (t.addressContains) parts.push(`адрес: ${t.addressContains}`);
      if (t.prefer) {
        let preferText = `сначала предпочитаю до ${dayHuman(t.prefer.until)}`;
        if (t.prefer.timeTo) preferText += `, до ${t.prefer.timeTo}`;
        parts.push(preferText);
      }
      if (t.purpose) parts.push(`цель визита: ${purposeTitle(t.purpose)}`);
      if (t.respectTravel) parts.push('с запасом на дорогу');
      parts.push(t.mode === 'confirm' ? 'спрашиваю перед записью' : 'записываю сразу');

      // bookDoctor и bookLdp — запись по направлению без текущей записи, для неё
      // отдельная формулировка «Запишу к <специальность> / на <исследование> по
      // направлению до <дата>» вместо общего «<title>: …» — дата уже учтена в head.
      if (byReferral) {
        const last = t.dateTo || t.deadline || null;
        const head = `Запишу ${t.scenario === 'bookLdp' ? 'на' : 'к'} ${t.title} по направлению` + (last ? ` до ${dayHuman(last)}` : '');
        return parts.length ? `${head}, ${parts.join(', ')}` : head;
      }

      return `${t.title}: ${parts.join(', ')}`;
    }

    function describeDryRunItem(item) {
      const head = item.waiting
        ? `${item.title}: подходящих слотов сейчас нет, жду`
        : `${item.title}: взяла бы ${human(item.would.startTime)} — ${item.would.address}`;
      const warn = (item.warnings || []).map((w) => `\n  ⚠ ${w}`).join('');
      const notes = (item.notes || []).map((n) => `\n  · ${n}`).join('');
      return head + warn + notes;
    }

    const saveConfig = (storage, cfg) => storage.setItem(KEY, JSON.stringify(cfg));
    const loadConfig = (storage) => { try { return JSON.parse(storage.getItem(KEY)) || null; } catch (e) { return null; } };

    // C1: чистая функция слияния события 'booked' в сохранённые настройки —
    // без неё после успешного переноса keepImproving current/source/scenario
    // менялись только в памяти раннера (core/runner.js), а cfg.targets в
    // localStorage оставался со СТАРЫМИ значениями. На перезагрузке страницы,
    // при захвате лидерства standby-вкладкой или по кнопке «Продолжить в этой
    // вкладке» (startFromSavedConfig) ядро стартовало заново именно по
    // cfg.targets — и filters.pickSlots могло принять слот ХУЖЕ уже сделанного
    // переноса, но раньше устаревшего t.current, отправив запись НАЗАД.
    // confirmedFor намеренно не трогаем — это отпечаток целей ДО мутации (см.
    // gateFingerprint в core/runner.js), он и должен остаться прежним, иначе
    // обвязка ложно решила бы, что нужен новый холостой прогон.
    // Возвращает тот же объект cfg (по ссылке), если сохранять нечего —
    // вызывающий код (onBooked) по этому признаку решает, нужен ли saveConfig.
    function applyBookedUpdate(cfg, payload) {
      if (!cfg || !Array.isArray(cfg.targets) || !payload || payload.targetId == null) return cfg;
      let changed = false;
      const targets = cfg.targets.map((t) => {
        if (t.id !== payload.targetId) return t;
        changed = true;
        return { ...t, current: payload.current, source: payload.source, scenario: payload.scenario };
      });
      return changed ? { ...cfg, targets } : cfg;
    }

    return {
      buildTarget, describeTarget, describeDryRunItem, saveConfig, loadConfig, applyBookedUpdate, human, stripCampus, KEY,
      INQUIRY_PURPOSES,
    };
  }

  const api = { createUiState };
  if (typeof module === 'object' && module.exports) module.exports = api;
  else { root.EmiasCore = root.EmiasCore || {}; Object.assign(root.EmiasCore, api); }
})(typeof globalThis !== 'undefined' ? globalThis : this);

/* ---- userscript/ui-dom.js ---- */
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
  let finishedAll = false; // все цели завершились сами — поиск остановлен
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
    if (kind === 'booked') { acknowledgeBooked(); openStatusPanel(); return; }
    if (kind === 'running' || kind === 'resuming') { openStatusPanel(); return; }
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
      if (!showBookedBadge()) setBadge({ kind: 'running', text: '🟢 Ищу слоты', detail: runningDetail() });
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
    // lastBooked держит оранжевый значок, пока человек его не увидит (клик),
    // в том числе после перезагрузки страницы.
    if (nextCfg) ui.saveConfig(storage, { ...nextCfg, lastBooked: { title: payload.title, startTime: payload.slot.startTime, address: payload.address || null } });
    // Minor: раньше при возврате из «Записано» цвет менялся обратно, а текст
    // оставался старым («🟠 Записано: …») — запоминаем значок целиком (а не
    // только его kind), чтобы вернуть и текст тоже.
    if (badgeState.kind !== 'booked') preBookedBadge = { ...badgeState };
    if (!showBookedBadge()) setBadge({ kind: 'booked', text: '🟠 Записано: ' + payload.title, detail: '' });
  }

  // Раньше значок «Записано» через 8 секунд сам возвращался к «Ищу слоты», и
  // если человек не смотрел на экран, о переносе он не узнавал. Теперь значок
  // остаётся оранжевым, пока по нему не кликнут (и после перезагрузки тоже).
  function showBookedBadge() {
    const cfg = ui.loadConfig(storage);
    const b = cfg && cfg.lastBooked;
    if (!b) return false;
    setBadge({ kind: 'booked', text: '🟠 Записано: ' + b.title, detail: b.startTime ? 'на ' + ui.human(b.startTime) + ' — нажмите, чтобы посмотреть' : '' });
    return true;
  }

  function acknowledgeBooked() {
    const cfg = ui.loadConfig(storage);
    if (cfg && cfg.lastBooked) { const next = { ...cfg }; delete next.lastBooked; ui.saveConfig(storage, next); }
    if (core.status().running) setBadge({ kind: 'running', text: '🟢 Ищу слоты', detail: runningDetail() });
    else if (finishedAll) setBadge({ kind: 'idle', text: '✅ Готово', detail: 'все цели выполнены' });
    else if (preBookedBadge) setBadge(preBookedBadge);
  }

  // Цель завершена сама (например, до записи осталось мало времени) — если
  // так завершились все цели, поиск останавливаем: ходить в ЕМИАС незачем.
  function onTargetDone(payload) {
    pushLog({ at: Date.now(), msg: `${payload.title}: ${payload.message}` });
    const all = core.status().targets || [];
    if (!all.length || !all.every((t) => t.state === 'done' || t.state === 'stopped')) return;
    core.stop();
    runningFor = null;
    stopStatusRefresh();
    const cfg = ui.loadConfig(storage) || {};
    ui.saveConfig(storage, { ...cfg, enabled: false });
    finishedAll = true;
    notify('ЕМИАС: поиск завершён', 'Все цели выполнены, охотник остановился');
    if (!showBookedBadge()) setBadge({ kind: 'idle', text: '✅ Готово', detail: 'все цели выполнены' });
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
    core.on('targetDone', safe(onTargetDone));
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
      if (!showBookedBadge()) setBadge({ kind: 'running', text: '🟢 Ищу слоты', detail: runningDetail() });
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

})();
