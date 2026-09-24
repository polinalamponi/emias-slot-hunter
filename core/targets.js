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
    //  - для всех переносов ЕМИАС сохраняет id записи — сверяем его с appointmentId цели,
    //    а не полагаемся только на время и тип;
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
      if (appt.id !== t.source.appointmentId) return false;
      if (t.scenario === 'shiftLdp') return !!appt.toLdp && Number(appt.toLdp.ldpTypeId) === Number(t.source.ldpTypeId);
      if (t.scenario === 'shiftDoctor') return !!appt.toDoctor;
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
