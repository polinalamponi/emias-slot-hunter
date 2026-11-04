// core/util.js
(function (root) {
  'use strict';

  const VERSION = '0.1.4';
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
