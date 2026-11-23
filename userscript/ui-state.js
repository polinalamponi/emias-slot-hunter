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
      } else if (form.when === 'range') {
        // Диапазон с датами у переноса — перенести в эти дни, даже если они
        // позже текущей записи; иначе при датах после неё охотник молча не
        // нашёл бы ничего. Диапазон только по времени — как раньше, «раньше
        // текущей записи», но в это время. Для новой записи anyTime ни на что
        // не влияет.
        anyTime = !!option.current && !!(form.dateFrom || form.dateTo);
      }

      const deadline = option.deadline || null;
      // Искать за пределами срока действия направления бессмысленно — если человек
      // задал dateTo позже deadline (или deadline вообще не знал), обрезаем по deadline.
      // Диапазон дат есть только у «как можно раньше»: у «выбранного дня» и
      // «того же дня» день уже задан, а скрытые старые даты из формы не должны
      // молча отсекать слоты этого дня.
      const useDates = !onlyDay;
      const dateTo = !useDates || !form.dateTo ? null : (deadline && deadline < form.dateTo ? deadline : form.dateTo);

      return {
        id: option.id, scenario: option.scenario, title: option.title, source: option.source,
        current: option.current || null,
        onlyDay,
        anyTime,
        dateFrom: (useDates && form.dateFrom) || null,
        dateTo,
        deadline,
        timeFrom: form.timeFrom || null,
        timeTo: form.timeTo || null,
        addressContains: form.where === 'sameCampus' ? stripCampus(option.address)
          : form.where === 'contains' ? (form.addressContains || null) : null,
        prefer: form.preferUntil ? { until: form.preferUntil, timeTo: form.preferTimeTo || null } : null,
        near: form.nearStart && form.nearEnd ? { start: form.nearStart, end: form.nearEnd } : null,
        // Запас на дорогу между записями — всегда (см. travelOk в core/filters.js):
        // галку в мастере убрали, снимать её смысла нет.
        respectTravel: true,
        travelMs: 60 * 60000,
        minLeadMs: 2 * 60 * 60000,
        // По умолчанию после первой записи останавливаемся: время приёма не
        // должно неожиданно «уезжать». «Искать ещё раньше» — явный выбор.
        keepImproving: option.scenario !== 'bookReferral' && form.afterBooking === 'improve',
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
      else if (t.anyTime && t.current) parts.push('перенесу в выбранные даты');
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

      if (t.timeFrom && t.timeTo && t.timeFrom > t.timeTo) parts.push(`время после ${t.timeFrom} или до ${t.timeTo}`);
      else if (t.timeFrom && t.timeTo) parts.push(`время с ${t.timeFrom} до ${t.timeTo}`);
      else if (t.timeFrom) parts.push(`время после ${t.timeFrom}`);
      else if (t.timeTo) parts.push(`время до ${t.timeTo}`);
      if (t.addressContains) parts.push(`адрес: ${t.addressContains}`);
      if (t.prefer) {
        let preferText = `сначала предпочитаю до ${dayHuman(t.prefer.until)}`;
        if (t.prefer.timeTo) preferText += `, до ${t.prefer.timeTo}`;
        parts.push(preferText);
      }
      if (t.purpose) parts.push(`цель визита: ${purposeTitle(t.purpose)}`);
      parts.push(t.mode === 'confirm' ? 'уточняю перед записью' : 'записываю сразу');
      parts.push(t.keepImproving ? 'после записи ищу ещё раньше' : 'после записи останавливаюсь');

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
        ? `${item.title}: подходящих окошек пока нет, жду`
        : `${item.title}: записала бы на ${human(item.would.startTime)} — ${item.would.address}`;
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

    // Карточка «угостите автора кофе» после успешной записи: не чаще раза
    // в 3 дня, а после нажатия «Угостить кофе» — 3 месяца не показываем.
    const THANKS_PAUSE_MS = 3 * 24 * 3600000;
    const THANKS_AFTER_DONATE_MS = 90 * 24 * 3600000;
    function shouldShowThanks(st, now) {
      const s = st || {};
      if (s.donatedAt && now - s.donatedAt < THANKS_AFTER_DONATE_MS) return false;
      if (s.shownAt && now - s.shownAt < THANKS_PAUSE_MS) return false;
      return true;
    }

    // Форма мастера → то, что реально применяется. Поля дат и времени видны
    // только после выбора своего пункта («в выбранные даты», «только в
    // определённое время»); скрытые поля не должны молча фильтровать слоты,
    // даже если человек успел их заполнить и передумал.
    // Даты и время задаются внутри пункта «выбрать диапазон», независимо друг
    // от друга: можно только даты, только время или и то и другое. Одна и та
    // же дата в «с» и «по» — один день. У других пунктов поля скрыты и не
    // применяются, даже если человек успел их заполнить.
    function normalizeForm(form) {
      const f = { ...(form || {}) };
      if (f.when === 'range') {
        if (f.dateFrom && f.dateFrom === f.dateTo) { f.when = 'onlyDay'; f.day = f.dateFrom; f.dateFrom = ''; f.dateTo = ''; }
      } else {
        f.dateFrom = ''; f.dateTo = ''; f.timeFrom = ''; f.timeTo = '';
      }
      return f;
    }

    return {
      normalizeForm,
      buildTarget, describeTarget, describeDryRunItem, saveConfig, loadConfig, applyBookedUpdate, human, stripCampus, KEY,
      INQUIRY_PURPOSES, shouldShowThanks,
    };
  }

  const api = { createUiState };
  if (typeof module === 'object' && module.exports) module.exports = api;
  else { root.EmiasCore = root.EmiasCore || {}; Object.assign(root.EmiasCore, api); }
})(typeof globalThis !== 'undefined' ? globalThis : this);
