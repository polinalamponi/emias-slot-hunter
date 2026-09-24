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

test('buildTarget: keepImproving зависит только от сценария', () => {
  const lab = ui.buildTarget({ ...option, scenario: 'bookLab' }, { when: 'earlier', where: 'any', mode: 'auto' });
  const referral = ui.buildTarget({ ...option, scenario: 'bookReferral' }, { when: 'earlier', where: 'any', mode: 'auto' });
  assert.equal(lab.keepImproving, true);
  assert.equal(referral.keepImproving, false);
});

test('buildTarget: bookDoctor тоже получает keepImproving: true', () => {
  const doctor = ui.buildTarget({ ...option, scenario: 'bookDoctor', source: { referralId: 1, needPurpose: false } }, { when: 'earlier', where: 'any', mode: 'auto' });
  assert.equal(doctor.keepImproving, true);
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
  assert.equal(t.keepImproving, true);
  const s = ui.describeTarget(t);
  assert.match(s, /^Запишу на Электрокардиография по направлению до 5 октября/);
  assert.doesNotMatch(s, /с .* по 5 октября/, 'дата уже в начале фразы — не дублируем');
});

test('describeTarget: bookDoctor упоминает выбранную цель визита', () => {
  const t = ui.buildTarget(doctorOption, { when: 'earlier', where: 'any', mode: 'auto', purpose: 'documents' });
  const s = ui.describeTarget(t);
  assert.match(s, /цель визита: Оформление документов/i);
});
