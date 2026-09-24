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
