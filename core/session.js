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
