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
