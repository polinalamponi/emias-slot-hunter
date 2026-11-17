// core/filters.js
(function (root) {
  'use strict';

  function createFilters(util) {
    const { toMs, slotHHMM, distTo, campus } = util;

    function slotComparator(t) {
      if (t.near) {
        // Сортируем по близости к желаемому интервалу near (0 = пересекается с ним).
        return (a, b) => distTo(t.near, toMs(a.startTime), toMs(a.endTime)) - distTo(t.near, toMs(b.startTime), toMs(b.endTime));
      }
      if (t.anyTime && t.current) {
        // При anyTime ближайшие к текущей записи по модулю — первыми.
        const cur = toMs(t.current);
        return (a, b) => Math.abs(toMs(a.startTime) - cur) - Math.abs(toMs(b.startTime) - cur);
      }
      // prefer поднимает наверх слоты, попадающие в предпочтительное окно
      // (день не позже prefer.until и, если задано, время раньше prefer.timeTo).
      // Внутри каждой группы — по возрастанию времени.
      const preferred = (slot) => (t.prefer
        && slot.startTime.slice(0, 10) <= t.prefer.until
        && (!t.prefer.timeTo || slotHHMM(slot.startTime) < t.prefer.timeTo) ? 0 : 1);
      return (a, b) => preferred(a) - preferred(b) || toMs(a.startTime) - toMs(b.startTime);
    }

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

      ok.sort(slotComparator(t));

      return { ok, rejected };
    }

    return { pickSlots, travelOk, slotComparator };
  }

  const api = { createFilters };
  if (typeof module === 'object' && module.exports) module.exports = api;
  else { root.EmiasCore = root.EmiasCore || {}; Object.assign(root.EmiasCore, api); }
})(typeof globalThis !== 'undefined' ? globalThis : this);
