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
