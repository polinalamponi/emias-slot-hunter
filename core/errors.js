// core/errors.js
(function (root) {
  'use strict';

  function createErrors() {
    const mask = (text) => String(text == null ? '' : text)
      // Проход 1: маскирование по имени поля JSON
      .replace(/"(omsNumber|birthDate|birthdate|patientId|snils|fio|firstName|lastName|middleName|patronymic)"\s*:\s*"[^"]*"/g, (m) => {
        const key = m.match(/"([^"]+)"/)[1];
        return '"' + key + '":"<скрыто>"';
      })
      // Проход 2: полис (16 и более цифр подряд)
      .replace(/\d{16,}/g, '<полис>')
      // Проход 3: дата ISO (YYYY-MM-DD)
      .replace(/\b(19|20)\d\d-\d\d-\d\d(?=["' ]|$)/g, (m) => (Number(m.slice(0, 4)) < 2020 ? '<дата рождения>' : m))
      // Проход 4: дата DD.MM.YYYY
      .replace(/\b(\d{1,2})\.(\d{1,2})\.((19|20)\d\d)\b/g, (m) => {
        const year = Number(m.split('.')[2]);
        return (year >= 1900 && year <= 2019) ? '<дата рождения>' : m;
      })
      // Проход 5: ФИО (полное имя с отчеством)
      .replace(/\b[А-ЯЁ][а-яё]+\s+[А-ЯЁ][а-яё]+(вич|вна|ична)\b/g, '<ФИО>');

    const KNOWN = {
      SA_SAME_BM_IS_NOT_AVAILABLE: { message: 'Вы уже записаны на это исследование — перехожу в режим переноса.', action: 'switchToShift' },
      SA_REFERRAL_EXPIRED: { message: 'Направление истекло — цель отключена.', action: 'stopTarget' },
      SA_APPOINTMENT_NOT_FOUND: { message: 'Запись не найдена: возможно, её отменили или перенесли в другом месте.', action: 'stopTarget' },
      // Живой ответ ЕМИАС и на перенос уже начавшейся записи, и на приём
      // без направления (ЦЖЗ), который сайт этим путём переносить не даёт.
      SA_APPOINTMENT_CANNOT_BE_CANCELED: { message: 'ЕМИАС не даёт перенести эту запись: приём уже начался, запись отменена или такой перенос сайт не разрешает. Цель остановлена.', action: 'stopTarget' },
    };

    function explain({ status, code, text }) {
      if (code && KNOWN[code]) return KNOWN[code];
      // I4: в реальном пути 401 сюда не доходит — core/api.js сам перехватывает
      // 401 до вызова explain() (один раз продлевает сессию и повторяет запрос,
      // а при повторном 401 сразу бросает SessionError с тем же по смыслу
      // текстом, см. api.js), поэтому явное действие пользователю показывает
      // именно то исключение. Ветка ниже остаётся ради других вызывающих кодов
      // explain() напрямую (см. test/errors.test.js) и на случай, если этот
      // порядок обработки 401 в api.js когда-нибудь изменится — тест ниже
      // прямо помечен как проверка explain() в изоляции, а не сквозного пути.
      if (status === 401) return { message: 'ЕМИАС перестал принимать вход. Войдите заново в другой вкладке — поиск продолжится сам.', action: 'relogin' };
      if (status === 429) return { message: 'ЕМИАС просит не частить — пауза 30 секунд.', action: 'wait' };
      if (status >= 500) return { message: 'ЕМИАС временно отвечает ошибкой — пауза 30 секунд.', action: 'wait' };
      return { message: 'Непонятный ответ ЕМИАС: ' + mask(text).slice(0, 300), action: 'retry' };
    }

    return { mask, explain };
  }

  const api = { createErrors };
  if (typeof module === 'object' && module.exports) module.exports = api;
  else { root.EmiasCore = root.EmiasCore || {}; Object.assign(root.EmiasCore, api); }
})(typeof globalThis !== 'undefined' ? globalThis : this);
