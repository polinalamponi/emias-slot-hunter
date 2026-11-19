// userscript/ui-notify.js — уведомления на телефон через ntfy (ntfy.sh).
// Зачем: ЕМИАС пушит только напоминание за несколько часов до визита, а о
// самой записи человек узнаёт лишь по значку в браузере — если он в этот
// момент не у ноутбука, узнает слишком поздно. Скрипт в момент записи сам
// отправляет сообщение на телефон.
//
// Канал ntfy выбран потому, что для него не нужны ни аккаунт, ни бот: человек
// ставит приложение ntfy и подписывается на свой личный топик. Имя топика —
// единственный «ключ» канала: кто его знает, тот читает уведомления, поэтому
// скрипт сам генерирует случайное неугадываемое имя (как пароль), а в
// подсказке просит никому его не показывать. Один общий топик на всех
// пользователей недопустим — участники читали бы уведомления друг друга.
//
// Приватность: топик хранится только в localStorage пользователя, запросы
// идут напрямую в api.ntfy.sh — никаких промежуточных серверов. Пока
// уведомления не настроены, скрипт ведёт себя как раньше.
(function (root) {
  'use strict';

  const KEY = 'emiasSlotHunter:notify';

  function loadSettings(storage) {
    const empty = { server: 'https://ntfy.sh', topic: '' };
    try {
      const s = JSON.parse(storage.getItem(KEY)) || empty;
      return {
        server: String(s.server || empty.server).trim().replace(/\/+$/, ''),
        topic: String(s.topic || '').trim(),
      };
    } catch (e) { return { ...empty }; }
  }

  // Пустые поля сохраняем пустыми (а не тянем старые значения) — иначе нельзя
  // очистить поле в интерфейсе.
  function saveSettings(storage, s) {
    const next = {
      server: String(s.server || '').trim().replace(/\/+$/, '') || 'https://ntfy.sh',
      topic: String(s.topic || '').trim(),
    };
    storage.setItem(KEY, JSON.stringify(next));
    return next;
  }

  // Случайный личный топик: имя топика — единственный «ключ» канала, поэтому
  // оно должно быть неугадываемым, как пароль. 22 символа.
  function generateTopic(rnd = Math.random) {
    const alphabet = 'abcdefghijklmnopqrstuvwxyz0123456789';
    let tail = '';
    for (let i = 0; i < 16; i++) tail += alphabet[Math.floor(rnd() * alphabet.length)];
    return 'emias-' + tail;
  }

  // Заголовок и текст события по-человечески. time и address приходят уже
  // отформатированными из ui-dom (ui.human / ui.stripCampus).
  function messageFor(event) {
    switch (event.kind) {
      case 'booked':
        return { title: 'ЕМИАС: записано', body: `✅ ${event.title} — ${event.time}${event.address ? ', ' + event.address : ''}` };
      case 'needConfirm':
        return { title: 'ЕМИАС: нужно решение (60 сек)', body: `⚠️ ${event.title} — ${event.time}${event.address ? ', ' + event.address : ''}` };
      case 'allDone':
        return { title: 'ЕМИАС: охота завершена', body: '🏁 Все цели выполнены, охотник остановился' };
      case 'sessionLost':
        return { title: 'ЕМИАС: вход закончился', body: '🔴 Войдите заново на сайте — поиск продолжится сам' };
      case 'stale':
        return { title: 'ЕМИАС: нет ответа', body: '🔴 Давно нет ответа от ЕМИАС — проверьте вкладку с охотой' };
      case 'test':
        return { title: 'ЕМИАС: проверка', body: '🔔 Уведомления охотника настроены' };
      default:
        return { title: 'ЕМИАС: охотник за слотами', body: event.message || '' };
    }
  }

  function createNotifier({ storage, fetch }) {
    const settings = () => loadSettings(storage);
    const missing = () => (settings().topic ? null : 'не задан топик ntfy');

    // ntfy: JSON-публикация в корень сервера — так уходит и заголовок, и текст.
    async function send(event) {
      const no = missing();
      if (no) return { ok: false, silent: true, error: no };
      const s = settings();
      const text = messageFor(event);
      let base;
      try { base = new URL(s.server + '/'); } catch (e) { return { ok: false, error: 'неверный адрес сервера ntfy' }; }
      let r;
      try {
        r = await fetch(base.href, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ topic: s.topic, title: text.title, message: text.body }),
        });
      } catch (e) {
        return { ok: false, error: 'нет связи с ' + s.server };
      }
      if (!r.ok) return { ok: false, error: 'HTTP ' + r.status + ' от ' + s.server };
      return { ok: true };
    }

    async function test() {
      const no = missing();
      if (no) return { ok: false, error: no };
      return send({ kind: 'test' });
    }

    return { send, test, settings };
  }

  const api = { createNotifier, messageFor, generateTopic, loadSettings, saveSettings, KEY };
  if (typeof module === 'object' && module.exports) module.exports = api;
  else { root.EmiasCore = root.EmiasCore || {}; Object.assign(root.EmiasCore, api); }
})(typeof globalThis !== 'undefined' ? globalThis : this);
