const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createUiState } = require('../userscript/ui-state.js');

const ui = createUiState();
const option = {
  id: 'appt:1', scenario: 'shiftLdp', title: 'УЗИ вен', current: '2026-09-30T13:45:00+03:00',
  address: '2-й Тестовый проезд, д. 5, к. 22', supported: true, source: { appointmentId: 1, ldpTypeId: 599925, referralId: 2 },
};

test('buildTarget: «тот же корпус» превращается в фильтр по адресу без номера корпуса', () => {
  const t = ui.buildTarget(option, { when: 'earlier', where: 'sameCampus', respectTravel: true, mode: 'auto' });
  assert.equal(t.addressContains, '2-й Тестовый проезд, д. 5');
  assert.equal(t.anyTime, false);
  assert.equal(t.current, option.current);
  assert.equal(t.mode, 'auto');
});

test('buildTarget: «только в день» выставляет onlyDay и anyTime', () => {
  const t = ui.buildTarget(option, { when: 'anyTimeOnDay', day: '2026-09-25', where: 'any', mode: 'confirm' });
  assert.equal(t.onlyDay, '2026-09-25');
  assert.equal(t.anyTime, true);
  assert.equal(t.addressContains, null);
});

test('buildTarget: дополнительные условия prefer и near', () => {
  const t = ui.buildTarget(option, {
    when: 'earlier', where: 'any', mode: 'auto',
    preferUntil: '2026-09-27', preferTimeTo: '11:00',
    nearStart: '2026-09-25T11:00:00+03:00', nearEnd: '2026-09-25T11:15:00+03:00',
  });
  assert.deepEqual(t.prefer, { until: '2026-09-27', timeTo: '11:00' });
  assert.deepEqual(t.near, { start: '2026-09-25T11:00:00+03:00', end: '2026-09-25T11:15:00+03:00' });
});

test('describeTarget: человеческое описание без жаргона', () => {
  const t = ui.buildTarget(option, { when: 'earlier', where: 'sameCampus', timeFrom: '08:00', timeTo: '12:00', respectTravel: true, mode: 'auto' });
  const s = ui.describeTarget({ ...t, title: 'УЗИ вен' });
  assert.match(s, /раньше 30 сентября, 13:45/);
  assert.match(s, /08:00.*12:00/);
  assert.match(s, /записываю сразу/i);
});

test('describeDryRunItem: слот и предупреждения', () => {
  const s = ui.describeDryRunItem({
    title: 'Кровь', would: { startTime: '2026-09-24T09:00:00+03:00', address: 'улица Тестовая, д. 2' },
    waiting: false, warnings: ['Адрес «улица Тестовая, д. 2» не содержит «к. 28»'], notes: [],
  });
  assert.match(s, /24 сентября, 09:00/);
  assert.match(s, /не содержит/);
});

test('сохранение и чтение настроек', () => {
  const data = {};
  const storage = { getItem: (k) => data[k] ?? null, setItem: (k, v) => { data[k] = v; } };
  ui.saveConfig(storage, { targets: [{ id: 'x' }], enabled: true, confirmedHash: 'h' });
  assert.deepEqual(ui.loadConfig(storage).targets, [{ id: 'x' }]);
  assert.equal(Object.keys(data)[0], 'emiasSlotHunter:config');
});

// ---- C1: слияние события booked в сохранённые настройки ----

test('applyBookedUpdate: обновляет current/source/scenario цели по совпадению id, не трогая остальное', () => {
  const cfg = {
    enabled: true, confirmedFor: 'dr123',
    targets: [
      { id: 'lab', scenario: 'bookLab', title: 'Кровь', current: null, source: { moId: 1 } },
      { id: 'other', scenario: 'shiftLdp', title: 'УЗИ', current: '2026-09-25T10:00:00+03:00', source: { appointmentId: 5 } },
    ],
  };
  const payload = {
    targetId: 'lab', current: '2026-09-24T10:30:00+03:00',
    source: { moId: 1, appointmentId: 42 }, scenario: 'shiftLab',
  };
  const next = ui.applyBookedUpdate(cfg, payload);
  assert.notEqual(next, cfg, 'при реальном изменении должен вернуться новый объект');
  assert.equal(next.targets[0].current, '2026-09-24T10:30:00+03:00');
  assert.equal(next.targets[0].scenario, 'shiftLab');
  assert.deepEqual(next.targets[0].source, { moId: 1, appointmentId: 42 });
  assert.equal(next.targets[0].title, 'Кровь', 'остальные поля цели не трогаем');
  assert.deepEqual(next.targets[1], cfg.targets[1], 'чужая цель не меняется');
  assert.equal(next.confirmedFor, 'dr123', 'confirmedFor — отпечаток ДО мутации, applyBookedUpdate его не трогает');
});

test('applyBookedUpdate: id не найден или конфига нет — возвращает исходный cfg без изменений', () => {
  const cfg = { enabled: true, targets: [{ id: 'lab', current: null }] };
  const same = ui.applyBookedUpdate(cfg, { targetId: 'нет-такого', current: 'x' });
  assert.equal(same, cfg, 'без совпадения по id объект возвращается как есть — сохранять нечего');
  assert.equal(ui.applyBookedUpdate(null, { targetId: 'lab' }), null);
  assert.equal(ui.applyBookedUpdate({ enabled: true }, { targetId: 'lab' }).enabled, true, 'нет targets — cfg возвращается как есть');
});

test('buildTarget: «в тот же день, но раньше» подставляет день текущей записи', () => {
  const t = ui.buildTarget(option, { when: 'sameDayEarlier', where: 'any', mode: 'auto' });
  assert.equal(t.onlyDay, option.current.slice(0, 10));
  assert.equal(t.anyTime, false);
});

test('buildTarget: «в выбранный день» делает цель выполнимой, даже если день позже текущей записи', () => {
  const t = ui.buildTarget(option, { when: 'onlyDay', day: '2026-10-05', where: 'any', mode: 'auto' });
  assert.equal(t.onlyDay, '2026-10-05');
  assert.equal(t.anyTime, true);
});

test('buildTarget: deadline ограничивает dateTo и попадает в цель отдельным полем', () => {
  const withDeadline = { ...option, deadline: '2026-10-14' };
  const t1 = ui.buildTarget(withDeadline, { when: 'earlier', where: 'any', mode: 'auto', dateTo: '2026-11-30' });
  assert.equal(t1.dateTo, '2026-10-14');
  assert.equal(t1.deadline, '2026-10-14');

  const t2 = ui.buildTarget(withDeadline, { when: 'earlier', where: 'any', mode: 'auto' });
  assert.equal(t2.dateTo, null);
  assert.equal(t2.deadline, '2026-10-14');
});

test('describeTarget: для записи по направлению без текущей записи называет период поиска', () => {
  const referralOption = { id: 'ref:1', scenario: 'bookLab', title: 'Анализ крови', current: null, deadline: '2026-10-14', source: {} };
  const t = ui.buildTarget(referralOption, { when: 'earlier', where: 'any', mode: 'auto' });
  const s = ui.describeTarget(t);
  assert.match(s, /по 14 октября/);
  assert.doesNotMatch(s, /раньше/);
});

test('describeTarget: prefer с timeTo и near вместе называют время предпочтения и конец интервала', () => {
  const t = ui.buildTarget(option, {
    when: 'earlier', where: 'any', mode: 'auto',
    preferUntil: '2026-09-27', preferTimeTo: '11:00',
    nearStart: '2026-09-25T11:00:00+03:00', nearEnd: '2026-09-25T11:15:00+03:00',
  });
  const s = ui.describeTarget(t);
  assert.match(s, /11:00/);
  assert.match(s, /11:15/);
});

test('buildTarget: по умолчанию после записи останавливаемся', () => {
  const lab = ui.buildTarget({ ...option, scenario: 'bookLab' }, { when: 'earlier', where: 'any', mode: 'auto' });
  assert.equal(lab.keepImproving, false);
  assert.match(ui.describeTarget(lab), /после записи останавливаюсь/);
});

test('buildTarget: «искать ещё раньше» включает keepImproving, кроме bookReferral', () => {
  const form = { when: 'earlier', where: 'any', mode: 'auto', afterBooking: 'improve' };
  const lab = ui.buildTarget({ ...option, scenario: 'bookLab' }, form);
  const doctor = ui.buildTarget({ ...option, scenario: 'bookDoctor', source: { referralId: 1, needPurpose: false } }, form);
  const referral = ui.buildTarget({ ...option, scenario: 'bookReferral' }, form);
  assert.equal(lab.keepImproving, true);
  assert.equal(doctor.keepImproving, true);
  assert.equal(referral.keepImproving, false);
  assert.match(ui.describeTarget(lab), /после записи ищу ещё раньше/);
});

// ---- Task 12b: bookDoctor — цель визита ----

const doctorOption = {
  id: 'ref:1', scenario: 'bookDoctor', title: 'Врач-эндокринолог', current: null, deadline: '2026-10-13',
  address: 'Тестовая поликлиника', source: { referralId: 1, lpuId: 2, specialityId: 10, needPurpose: true, availableResourceId: null },
};

test('buildTarget: needPurpose даёт цель визита «плохое самочувствие» по умолчанию', () => {
  const t = ui.buildTarget(doctorOption, { when: 'earlier', where: 'any', mode: 'auto' });
  assert.deepEqual(t.purpose, { inquiryPurposeId: 61, inquiryPurposeCode: 251 });
});

test('buildTarget: needPurpose с выбором «оформление документов»', () => {
  const t = ui.buildTarget(doctorOption, { when: 'earlier', where: 'any', mode: 'auto', purpose: 'documents' });
  assert.deepEqual(t.purpose, { inquiryPurposeId: 63, inquiryPurposeCode: 255 });
});

test('buildTarget: без needPurpose цель визита не выставляется', () => {
  const noPurposeOption = { ...doctorOption, source: { ...doctorOption.source, needPurpose: false } };
  const t = ui.buildTarget(noPurposeOption, { when: 'earlier', where: 'any', mode: 'auto' });
  assert.equal(t.purpose, null);
});

test('describeTarget: bookDoctor формулируется как «Запишу к <специальность> по направлению до <дата>»', () => {
  const t = ui.buildTarget({ ...doctorOption, source: { ...doctorOption.source, needPurpose: false } }, { when: 'earlier', where: 'any', mode: 'auto' });
  const s = ui.describeTarget(t);
  assert.match(s, /^Запишу к Врач-эндокринолог по направлению до 13 октября/);
});

test('describeTarget: bookLdp формулируется как «Запишу на <исследование> по направлению до <дата>», без цели визита', () => {
  const ldpOption = {
    id: 'ref:4', scenario: 'bookLdp', title: 'Электрокардиография', current: null, deadline: '2026-10-05',
    address: 'Тестовая больница', source: { referralId: 4, lpuId: 2, ldpTypeId: 599930 },
  };
  const t = ui.buildTarget(ldpOption, { when: 'earlier', where: 'any', mode: 'auto' });
  assert.equal(t.purpose, null);
  assert.equal(t.keepImproving, false);
  const s = ui.describeTarget(t);
  assert.match(s, /^Запишу на Электрокардиография по направлению до 5 октября/);
  assert.doesNotMatch(s, /с .* по 5 октября/, 'дата уже в начале фразы — не дублируем');
});

test('describeTarget: bookDoctor упоминает выбранную цель визита', () => {
  const t = ui.buildTarget(doctorOption, { when: 'earlier', where: 'any', mode: 'auto', purpose: 'documents' });
  const s = ui.describeTarget(t);
  assert.match(s, /цель визита: Оформление документов/i);
});

test('shouldShowThanks: не чаще раза в 3 дня, после «Угостить кофе» — 3 месяца тишины', () => {
  const DAY = 24 * 3600000;
  const now = Date.parse('2026-12-01T10:00:00Z');
  assert.equal(ui.shouldShowThanks(null, now), true, 'ни разу не показывали — показываем');
  assert.equal(ui.shouldShowThanks({ shownAt: now - 2 * DAY }, now), false, 'показывали 2 дня назад');
  assert.equal(ui.shouldShowThanks({ shownAt: now - 3 * DAY - 1 }, now), true, 'прошло больше 3 дней');
  assert.equal(ui.shouldShowThanks({ donatedAt: now - 30 * DAY, shownAt: now - 30 * DAY }, now), false, 'перевели месяц назад');
  assert.equal(ui.shouldShowThanks({ donatedAt: now - 91 * DAY, shownAt: now - 91 * DAY }, now), true, 'прошло 3 месяца');
});

test('buildTarget: у «выбранного дня» диапазон дат не применяется, время — применяется', () => {
  const t = ui.buildTarget(option, { when: 'onlyDay', day: '2026-10-05', where: 'any', mode: 'auto',
    dateFrom: '2026-10-10', dateTo: '2026-10-20', timeFrom: '08:00', timeTo: '10:00' });
  assert.equal(t.onlyDay, '2026-10-05');
  assert.equal(t.dateFrom, null, 'старое «с» из формы не отсекает выбранный день');
  assert.equal(t.dateTo, null);
  assert.equal(t.timeFrom, '08:00');
  assert.equal(t.timeTo, '10:00');
});

test('normalizeForm: у «как можно раньше» скрытые даты и время не применяются', () => {
  const filled = { when: 'earlier', dateFrom: '2026-10-10', dateTo: '2026-10-20', timeFrom: '18:00', timeTo: '' };
  const f = ui.normalizeForm(filled);
  assert.deepEqual([f.dateFrom, f.dateTo, f.timeFrom, f.timeTo], ['', '', '', '']);
  assert.equal(filled.dateFrom, '2026-10-10', 'сама форма не меняется — вернувшись к пункту, человек увидит свои даты');
});

test('диапазон только по времени: в любой день, но после 18:00', () => {
  const f = ui.normalizeForm({ when: 'range', dateFrom: '', dateTo: '', timeFrom: '18:00', timeTo: '' });
  const t = ui.buildTarget({ ...option, current: null }, { ...f, where: 'any', mode: 'auto' });
  assert.equal(t.dateFrom, null);
  assert.equal(t.dateTo, null);
  assert.equal(t.timeFrom, '18:00');
  assert.match(ui.describeTarget(t), /время после 18:00/);
  // у переноса без дат — по-прежнему «раньше текущей записи», но в это время
  const shift = ui.buildTarget(option, { ...f, where: 'any', mode: 'auto' });
  assert.equal(shift.anyTime, false);
  assert.equal(shift.timeFrom, '18:00');
});

test('диапазон: даты и время вместе', () => {
  const t = ui.buildTarget({ ...option, current: null }, { ...ui.normalizeForm({ when: 'range', dateFrom: '2026-10-10', dateTo: '2026-10-20', timeFrom: '08:00', timeTo: '' }), where: 'any', mode: 'auto' });
  assert.equal(t.onlyDay, null);
  assert.equal(t.dateFrom, '2026-10-10');
  assert.equal(t.dateTo, '2026-10-20');
  assert.equal(t.timeFrom, '08:00');
  assert.equal(t.timeTo, null, 'не указано — без ограничения');
});

test('диапазон с одной датой — это один день, в любое время', () => {
  const f = ui.normalizeForm({ when: 'range', dateFrom: '2026-10-12', dateTo: '2026-10-12', timeFrom: '', timeTo: '' });
  const t = ui.buildTarget(option, { ...f, where: 'any', mode: 'auto' });
  assert.equal(t.onlyDay, '2026-10-12');
  assert.equal(t.anyTime, true);
  assert.equal(t.dateFrom, null);
});

test('перенос с диапазоном дат: в эти дни, даже позже текущей записи', () => {
  // option.current — 30 сентября; даты после неё не должны отсекаться как «позже текущей записи».
  const t = ui.buildTarget(option, { ...ui.normalizeForm({ when: 'range', dateFrom: '2026-10-05', dateTo: '2026-10-09' }), where: 'any', mode: 'auto' });
  assert.equal(t.anyTime, true);
  assert.equal(t.onlyDay, null);
  assert.match(ui.describeTarget(t), /перенесу в выбранные даты/);
});

test('describeTarget: «с 18:00 до 09:00» — «после 18:00 или до 09:00»', () => {
  const t = ui.buildTarget({ ...option, current: null }, { when: 'earlier', where: 'any', mode: 'auto', timeFrom: '18:00', timeTo: '09:00' });
  assert.match(ui.describeTarget(t), /время после 18:00 или до 09:00/);
});

test('врач по фамилии: только если выбран пункт «фамилия», попадает в описание', () => {
  const docOption = { ...doctorOption, source: { ...doctorOption.source, needPurpose: false } };
  const hidden = ui.buildTarget(docOption, { ...ui.normalizeForm({ when: 'earlier', doctor: 'any', doctorContains: 'Иванова' }), where: 'any', mode: 'auto' });
  assert.equal(hidden.doctorContains, null, 'выбран «любой» — фамилия не применяется');
  const t = ui.buildTarget(docOption, { ...ui.normalizeForm({ when: 'earlier', doctor: 'byName', doctorContains: ' Иванова ' }), where: 'any', mode: 'auto' });
  assert.equal(t.doctorContains, 'Иванова');
  assert.match(ui.describeTarget(t), /врач: Иванова/);
});

test('теги адреса и врача → фильтр ядра и человеческое описание', () => {
  const { addressMatches } = require('../core/filters.js');
  const f = ui.normalizeForm({ when: 'earlier', where: 'list', addrAny: ['Знамя труда', 'Остафьево'], addrNone: ['Шишкин лес'], addrAnyDraft: '', addrNoneDraft: '' });
  assert.equal(f.where, 'contains');
  assert.equal(addressMatches('посёлок Знамя труда, д. 1', f.addressContains), true);
  assert.equal(addressMatches('село Остафьево, д. 3', f.addressContains), true);
  assert.equal(addressMatches('Шишкин лес, Знамя труда', f.addressContains), false, '«кроме» сильнее «подходят»');
  assert.equal(addressMatches('улица Ленина, д. 5', f.addressContains), false);
  const t = ui.buildTarget({ ...option, current: null }, { ...f, mode: 'auto' });
  assert.match(ui.describeTarget(t), /адрес: Знамя труда или Остафьево, кроме Шишкин лес/);
  // набранный, но не добавленный тег тоже учитывается; «+»/«-»/«;» из текста не становятся синтаксисом
  const g = ui.normalizeForm({ when: 'earlier', where: 'list', addrAny: [], addrNone: [], addrAnyDraft: '-Тестовая; д. 2', addrNoneDraft: '' });
  assert.equal(addressMatches('улица Тестовая д. 2', g.addressContains), true);
  const d = ui.normalizeForm({ when: 'earlier', doctor: 'byName', docAny: ['Иванова'], docNone: [] });
  assert.equal(addressMatches('Иванова А.П.', d.doctorContains), true);
  assert.equal(addressMatches('Петрова Б.В.', d.doctorContains), false);
});

test('готовые варианты «когда»: утро, вечер, до или после работы, тот же день', () => {
  const build = (opt, preset) => ui.buildTarget(opt, { ...ui.normalizeForm({ whenPreset: preset, dateFrom: '2026-10-10', timeFrom: '07:00' }), where: 'any', mode: 'auto' });
  const fresh = { ...option, current: null };
  const m = build(fresh, 'morning');
  assert.deepEqual([m.dateFrom, m.timeFrom, m.timeTo], [null, null, '12:00'], 'утро — только время, старые даты не мешают');
  const e = build(fresh, 'evening');
  assert.deepEqual([e.timeFrom, e.timeTo], ['18:00', null]);
  const w = build(fresh, 'work');
  assert.deepEqual([w.timeFrom, w.timeTo], ['18:00', '09:00']);
  assert.match(ui.describeTarget(w), /после 18:00 или до 09:00/);
  // у переноса утро — «раньше текущей записи, но утром», не «в любые даты»
  const ms = build(option, 'morning');
  assert.equal(ms.anyTime, false);
  assert.equal(ms.timeTo, '12:00');
  const sd = build(option, 'sameDay');
  assert.equal(sd.onlyDay, String(option.current).slice(0, 10));
  const asap = build(fresh, 'asap');
  assert.deepEqual([asap.dateFrom, asap.timeFrom, asap.timeTo], [null, null, null]);
});
