// core/filters.js
(function (root) {
  'use strict';

  // Разбираем строку фильтра адреса на обязательные и запрещённые ключи
  // (пожелание из issue #1 — поликлиники Новой Москвы разбросаны на десятки
  // километров, одного ключа мало).
  //
  // Новый ключ начинается только там, где это сказано явно: после «;» или с
  // «+»/«-» после пробела. Обычный пробел ключи НЕ разделяет. Это важно:
  // «в этом же здании» кладёт сюда адрес целиком («улица Тестовая, д. 2»), и
  // старые сохранённые фильтры тоже бывают из нескольких слов. Если бы пробел
  // делил строку на ключи «ИЛИ», под «улица … д. 2» подошёл бы почти любой
  // адрес Москвы, и охотник записал бы в чужое здание.
  //
  // Ключ с «+» или без префикса — адрес должен содержать хотя бы ОДИН такой
  // ключ (ИЛИ); «-ключ» — адрес НЕ должен содержать ни одного такого.
  // Примеры: «+знамя труда +остафьево -шишкин», «фабрики; знамя».
  // Кавычки можно ставить вокруг фразы (+"ленина, д. 5"), внутри кавычек
  // «;», «+» и «-» не делят строку. Дефис внутри слова («Ново-Переделкино»)
  // и « - » с пробелами вокруг ключ не начинают.
  function splitAddressKeys(s) {
    const keys = [];
    let cur = '';
    let quoted = false;
    for (let i = 0; i < s.length; i++) {
      const c = s[i];
      if (c === '"') { quoted = !quoted; cur += c; continue; }
      const startsKey = !quoted && (c === ';'
        || (/\s/.test(c) && /[+-]/.test(s[i + 1] || '') && /\S/.test(s[i + 2] || '') && /[^+-]/.test(s[i + 2] || '')));
      if (startsKey) { keys.push(cur); cur = ''; continue; }
      cur += c;
    }
    keys.push(cur);
    return keys;
  }

  function parseAddressFilter(s) {
    const out = { any: [], none: [] };
    for (const raw of splitAddressKeys(String(s || ''))) {
      let body = raw.trim();
      let neg = false;
      if (body.startsWith('-')) { neg = true; body = body.slice(1).trim(); }
      else if (body.startsWith('+')) body = body.slice(1).trim();
      if (body.startsWith('"') && body.endsWith('"') && body.length >= 2) body = body.slice(1, -1);
      body = body.replace(/\s+/g, ' ').trim().toLowerCase();
      // Ключ без единой буквы или цифры («---», «+», «;») — не ключ, а мусор.
      if (!body || !/\p{L}|\p{N}/u.test(body)) continue;
      if (neg) out.none.push(body); else out.any.push(body);
    }
    return out;
  }

  // Подходит ли адрес под строку фильтра (см. parseAddressFilter). Пустой
  // фильтр (или строка без единого осмысленного токена) пропускает всё —
  // как и прежний includes() с пустой строкой.
  function addressMatches(address, s) {
    const f = parseAddressFilter(s);
    if (!f.any.length && !f.none.length) return true;
    const a = String(address || '').toLowerCase();
    if (f.none.some((kw) => a.includes(kw))) return false;
    if (!f.any.length) return true;
    return f.any.some((kw) => a.includes(kw));
  }

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
        // «С 18:00 до 09:00» (с позже до) — до и после работы: подходит время
        // после «с» ИЛИ до «до». Иначе — обычное окно с … до ….
        const hhmm = slotHHMM(slot.startTime);
        if (t.timeFrom && t.timeTo && t.timeFrom > t.timeTo) {
          if (hhmm < t.timeFrom && hhmm > t.timeTo) { reject(slot, 'не в выбранное время'); continue; }
        } else {
          if (t.timeFrom && hhmm < t.timeFrom) { reject(slot, 'раньше выбранного времени'); continue; }
          if (t.timeTo && hhmm > t.timeTo) { reject(slot, 'позже выбранного времени'); continue; }
        }
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

    // parseAddressFilter/addressMatches отдаем и здесь: коллеги берут соседей
    // через фабрики (createTargets({ filters })), и targets.search() зовёт
    // именно filters.addressMatches.
    return { pickSlots, travelOk, slotComparator, addressMatches };
  }

  const api = { createFilters, parseAddressFilter, addressMatches };
  if (typeof module === 'object' && module.exports) module.exports = api;
  else { root.EmiasCore = root.EmiasCore || {}; Object.assign(root.EmiasCore, api); }
})(typeof globalThis !== 'undefined' ? globalThis : this);
