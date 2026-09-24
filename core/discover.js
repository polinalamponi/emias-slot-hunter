(function (root) {
  'use strict';

  function createDiscover({ api }) {
    async function list() {
      const [refRes, apptRes] = await Promise.all([
        api.post('v4/saOrchestrator/getAssignmentsReferralsInfo', {}),
        api.post('v10/saOrchestrator/getAppointmentReceptionsByPatient', {}),
      ]);

      // IMPORTANT 3: проверяем, что оба запроса успешны
      if (!refRes.ok || !apptRes.ok) {
        const msg = (refRes.ok ? apptRes : refRes).explained?.message || 'Не удалось получить данные из ЕМИАС, попробуйте ещё раз';
        throw new Error(msg);
      }

      const ar = (refRes.json && refRes.json.payload && refRes.json.payload.arInfo) || {};
      const appts = (apptRes.json && apptRes.json.payload && apptRes.json.payload.appointment) || [];
      const out = [];

      // Обрабатываем существующие записи как цели переноса
      for (const a of appts) {
        // IMPORTANT 2: проверяем наличие startTime перед конкатенацией
        const current = a.startTime ? (a.startTime + '+03:00') : null;
        const common = { current, address: a.lpuAddress || null, deadline: null, supported: !!a.enableShift,
          unsupportedReason: a.enableShift ? null : 'ЕМИАС не разрешает переносить эту запись' };
        if (a.type === 'BM' && a.toBM) {
          out.push({ id: 'appt:' + a.id, scenario: 'shiftLab', title: a.toBM.name, ...common,
            source: { appointmentId: a.id, moId: a.lpuId, samplingTypeId: a.toBM.id } });
        } else if (a.type === 'LDP' && a.toLdp) {
          out.push({ id: 'appt:' + a.id, scenario: 'shiftLdp', title: a.toLdp.ldpTypeName, ...common,
            source: { appointmentId: a.id, ldpTypeId: Number(a.toLdp.ldpTypeId), referralId: a.referral && a.referral.referralId, lpuId: a.lpuId } });
        } else if (a.type === 'DOCTOR' && a.toDoctor) {
          // MINOR 5: добавлена проверка типа записи, как для других типов
          out.push({ id: 'appt:' + a.id, scenario: 'shiftDoctor', title: a.toDoctor.specialityName, ...common,
            source: { appointmentId: a.id, specialityName: a.toDoctor.specialityName, referralId: a.referral && a.referral.referralId, lpuId: a.lpuId } });
        }
        // MINOR 5: остальные типы записей в v0.1 не поддерживаются, пропускаем молча
      }

      // Если есть свободные направления на кровь, предлагаем их как цели записи
      // CRITICAL 1: дедупликация теперь по паре (moId + samplingTypeId), не по названию
      const bookedLab = new Set(out.filter((o) => o.scenario === 'shiftLab').map((o) => `${o.source.moId}:${o.source.samplingTypeId}`));
      // Живой ЕМИАС отдаёт { items, count }, старые фикстуры — массив.
      const assignments = Array.isArray(ar.assignments) ? ar.assignments : (ar.assignments && ar.assignments.items) || [];
      for (const as of assignments) {
        if (!as.active || !as.appointmentAvailable) continue;
        const title = (as.toBM && as.toBM.name) || 'Лабораторное исследование';
        const labKey = `${as.moId}:${as.toBM && as.toBM.id}`;
        if (bookedLab.has(labKey)) continue;
        out.push({ id: `lab:${as.moId}:${as.toBM && as.toBM.id}`, scenario: 'bookLab', title,
          current: null, address: as.moName || null, deadline: as.period && as.period.dateTo,
          supported: true, unsupportedReason: null,
          source: { moId: as.moId, samplingTypeId: as.toBM && as.toBM.id } });
      }

      // Направления без активной записи: к врачу (toDoctor) — цель bookDoctor,
      // на исследование (toLdp) — bookLdp. Запросы bookLdp взяты по аналогии с
      // bookDoctor и на живом сайте ещё не сняты.
      for (const ref of (ar.referrals && ar.referrals.items) || []) {
        if (ref.countActiveAppointment > 0) continue;
        if (ref.toDoctor) {
          const title = ref.toDoctor.specialityName + (ref.toDoctor.doctorFio ? ' — ' + ref.toDoctor.doctorFio : '');
          out.push({ id: 'ref:' + ref.id, scenario: 'bookDoctor', title, current: null,
            address: ref.lpuName || null, deadline: ref.endTime, supported: true, unsupportedReason: null,
            source: {
              referralId: ref.id, lpuId: ref.lpuId, specialityId: ref.toDoctor.specialityId,
              needPurpose: !!ref.needPurpose, availableResourceId: ref.availableResourceId || null,
            } });
          continue;
        }
        if (ref.toLdp) {
          out.push({ id: 'ref:' + ref.id, scenario: 'bookLdp', title: ref.toLdp.ldpTypeName || 'Исследование', current: null,
            address: ref.lpuName || null, deadline: ref.endTime, supported: true, unsupportedReason: null,
            source: { referralId: ref.id, lpuId: ref.lpuId, ldpTypeId: Number(ref.toLdp.ldpTypeId) } });
          continue;
        }
        const title = 'Направление';
        out.push({ id: 'ref:' + ref.id, scenario: 'bookReferral', title, current: null,
          address: ref.lpuName || null, deadline: ref.endTime, supported: false,
          unsupportedReason: 'Новая запись по такому направлению появится в следующей версии',
          source: { referralId: ref.id, lpuId: ref.lpuId } });
      }

      return out;
    }

    return { list };
  }

  const api = { createDiscover };
  if (typeof module === 'object' && module.exports) module.exports = api;
  else { root.EmiasCore = root.EmiasCore || {}; Object.assign(root.EmiasCore, api); }
})(typeof globalThis !== 'undefined' ? globalThis : this);
