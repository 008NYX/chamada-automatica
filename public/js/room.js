'use strict';

(function () {
  'use strict';

  const $ = (id) => document.getElementById(id);

  const el = {
    roomName: $('room-name'),
    sheetDate: $('sheet-date'),
    sessionBadge: $('session-badge'),
    sessionCountdown: $('session-countdown'),
    openControls: $('open-controls'),
    durationMin: $('duration-min'),
    btnOpen: $('btn-open'),
    btnClose: $('btn-close'),
    btnRefresh: $('btn-refresh'),
    kpiTotal: $('kpi-total'),
    kpiPresent: $('kpi-present'),
    kpiPending: $('kpi-pending'),
    kpiAbsent: $('kpi-absent'),
    sheetTitle: $('sheet-title'),
    sheetHint: $('sheet-hint'),
    sheetBody: $('sheet-body'),
    sheetEmpty: $('sheet-empty'),
    exportSheet: $('export-sheet'),
    reportTitle: $('report-title'),
    reportHead: $('report-head'),
    reportBody: $('report-body'),
    reportEmpty: $('report-empty'),
    reportDays: $('report-days'),
    exportReport: $('export-report'),
    studentsTitle: $('students-title'),
    studentSearch: $('student-search'),
    studentsGrid: $('students-grid'),
    studentsEmpty: $('students-empty'),
  };

  const state = {
    classroom: '',
    today: '',
    selectedDate: '',
    classrooms: [],
    sheet: null,
    report: null,
    students: [],
    filter: '',
    autoTimer: null,
    tickTimer: null,
  };

  async function req(url, options) {
    const res = await fetch(url, {
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json' },
      ...options,
    });
    if (res.status === 401) {
      window.location.href = '/login';
      throw new Error('Sessao expirada');
    }
    const data = await res.json().catch(() => null);
    if (!res.ok) throw new Error((data && data.error) || `Erro HTTP ${res.status}`);
    return data;
  }

  function warnStorage() {
    const div = document.createElement('div');
    div.style.cssText =
      'position:fixed;top:0;left:0;right:0;z-index:9999;background:#dc2626;color:#fff;' +
      'padding:9px 12px;font:600 13px system-ui,sans-serif;text-align:center';
    div.textContent =
      'ATENCAO: MongoDB nao configurado neste servidor. Defina MONGODB_URI nas variaveis ' +
      'de ambiente (o banco local e temporario e some sozinho).';
    document.body.appendChild(div);
  }

  const fmtDate = (iso) => (iso ? iso.split('-').reverse().join('/') : '--');
  const fmtTime = (isoDate) =>
    isoDate ? new Date(isoDate).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' }) : '--';
  const pct = (rate) => `${Math.round((rate || 0) * 100)}%`;

  function fmtClock(ms) {
    if (ms == null) return '';
    const total = Math.max(0, Math.round(ms / 1000));
    const m = String(Math.floor(total / 60)).padStart(2, '0');
    const s = String(total % 60).padStart(2, '0');
    return `${m}:${s}`;
  }

  const STATUS_PILL = { present: ['ok', 'Presente'], pending: ['warn', 'Aguardando'], absent: ['bad', 'Falta'] };

  async function init() {
    const params = new URLSearchParams(window.location.search);
    let classroom = (params.get('classroom') || '').toUpperCase();

    try {
      const cfg = await req('/api/config');
      if (cfg.storage !== 'mongo') warnStorage();
      state.today = cfg.today;
      state.classrooms = cfg.classrooms;

      if (!state.classrooms.includes(classroom)) classroom = state.classrooms[0];
      state.classroom = classroom;
      state.selectedDate = cfg.today;
      el.roomName.textContent = `Sala ${classroom}`;
      el.sheetDate.value = cfg.today;
      document.title = `Sala ${classroom} - Escola Benedito Cláudio`;
    } catch (err) {
      console.error(err);
      return;
    }

    await Promise.all([loadSheet(), loadReport(), loadStudents()]);

    state.autoTimer = setInterval(refreshLive, 5000);
    state.tickTimer = setInterval(tickCountdown, 1000);
    document.addEventListener('visibilitychange', () => {
      if (!document.hidden) refreshLive();
    });
    window.addEventListener('beforeunload', () => {
      clearInterval(state.autoTimer);
      clearInterval(state.tickTimer);
    });
  }

  async function refreshLive() {
    if (document.hidden) return;
    try {
      await Promise.all([loadSheet(), loadReport()]);
    } catch (_) {

    }
  }

  async function loadSheet() {
    const sheet = await req(
      `/api/attendance/sheet?classroom=${encodeURIComponent(state.classroom)}&date=${encodeURIComponent(
        state.selectedDate
      )}`
    );
    state.sheet = sheet;
    renderSheet(sheet);
  }

  async function loadReport() {
    state.report = await req(`/api/attendance/report?classroom=${encodeURIComponent(state.classroom)}`);
    renderReport(state.report);
  }

  async function loadStudents() {
    const { users } = await req('/api/users');
    state.students = users.filter((u) => u.classroom === state.classroom);
    renderStudents();
  }

  function isTodayView() {
    return state.selectedDate === state.today;
  }

  function updateControls() {
    const session = state.sheet && state.sheet.session;
    const open = !!(session && session.open);
    const todayView = isTodayView();

    el.openControls.hidden = !todayView || open;
    el.btnClose.hidden = !todayView || !open;

    if (!todayView) {
      el.sessionBadge.textContent = 'Data passada';
      el.sessionBadge.className = 'pill pill--idle';
      el.sessionCountdown.textContent = '';
      return;
    }

    if (open) {
      const remaining = session.expiresAt ? Date.parse(session.expiresAt) - Date.now() : null;
      el.sessionBadge.textContent = 'Chamada aberta';
      el.sessionBadge.className = 'pill pill--ok';
      el.sessionCountdown.textContent =
        remaining == null ? 'sem tempo limite' : `fecha em ${fmtClock(remaining)}`;
    } else if (session) {
      el.sessionBadge.textContent = `Encerrada ${fmtTime(session.closedAt)}`;
      el.sessionBadge.className = 'pill pill--idle';
      el.sessionCountdown.textContent = '';
    } else {
      el.sessionBadge.textContent = 'Nao iniciada';
      el.sessionBadge.className = 'pill pill--warn';
      el.sessionCountdown.textContent = '';
    }
  }

  function tickCountdown() {
    const session = state.sheet && state.sheet.session;
    if (!session || !session.open || !session.expiresAt) return;
    const remaining = Date.parse(session.expiresAt) - Date.now();
    if (remaining <= 0) {
      el.sessionCountdown.textContent = 'tempo esgotado';
      refreshLive();
      return;
    }
    el.sessionCountdown.textContent = `fecha em ${fmtClock(remaining)}`;
  }

  function renderKpis(totals) {
    el.kpiTotal.textContent = totals.total;
    el.kpiPresent.textContent = totals.present;
    el.kpiPending.textContent = totals.pending;
    el.kpiAbsent.textContent = totals.absent;
  }

  function renderSheet(sheet) {
    renderKpis(sheet.totals);
    updateControls();

    el.sheetTitle.textContent = `Planilha — Sala ${sheet.classroom} — ${fmtDate(sheet.date)}`;
    el.sheetHint.textContent = sheet.totals.pending
      ? `${sheet.totals.pending} aluno(s) aguardando (nao conta falta enquanto a chamada estiver aberta).`
      : '';

    el.sheetBody.innerHTML = '';
    el.sheetEmpty.hidden = sheet.students.length > 0;

    for (const s of sheet.students) {
      const tr = document.createElement('tr');
      if (s.status === 'present') tr.className = 'row-present';

      tr.appendChild(cell(String(s.rollNumber == null ? '-' : s.rollNumber), 'cell-roll'));

      const studentCell = document.createElement('td');
      const wrap = document.createElement('div');
      wrap.className = 'student-cell';
      const img = document.createElement('img');
      img.className = 'avatar';
      img.alt = s.name;
      img.src = s.photo || ghostIcon();
      const name = document.createElement('span');
      name.textContent = s.name;
      wrap.appendChild(img);
      wrap.appendChild(name);
      studentCell.appendChild(wrap);
      tr.appendChild(studentCell);

      const statusCell = document.createElement('td');
      const pill = document.createElement('span');
      const [kind, label] = STATUS_PILL[s.status] || STATUS_PILL.absent;
      pill.className = `pill pill--${kind}`;
      pill.textContent = label;
      statusCell.appendChild(pill);
      tr.appendChild(statusCell);

      tr.appendChild(cell(s.present ? fmtTime(s.at) : '--'));
      tr.appendChild(cell(s.present ? (s.by === 'face' ? 'Reconhecimento' : 'Manual') : '--'));

      const actions = document.createElement('td');
      actions.className = 'col-actions';
      const btnPresent = document.createElement('button');
      btnPresent.className = 'btn btn--tiny btn--ok';
      btnPresent.textContent = 'Presente';
      btnPresent.addEventListener('click', () => setRecord(s.id, true));
      const btnAbsent = document.createElement('button');
      btnAbsent.className = 'btn btn--tiny btn--ghost';
      btnAbsent.textContent = 'Falta';
      btnAbsent.addEventListener('click', () => setRecord(s.id, false));
      actions.appendChild(btnPresent);
      actions.appendChild(btnAbsent);
      tr.appendChild(actions);

      el.sheetBody.appendChild(tr);
    }
  }

  function cell(text, cls) {
    const td = document.createElement('td');
    if (cls) td.className = cls;
    td.textContent = text;
    return td;
  }

  async function setRecord(studentId, present) {
    await req('/api/attendance/record', {
      method: 'PUT',
      body: JSON.stringify({ studentId, present, date: state.selectedDate }),
    });
    await Promise.all([loadSheet(), loadReport()]);
  }

  function renderReport(report) {
    el.reportHead.innerHTML = '';
    el.reportBody.innerHTML = '';
    el.reportTitle.textContent = `Relatório — Sala ${report.classroom || state.classroom}`;
    el.reportDays.textContent = `${report.days.length} dia(s) de chamada.`;

    const hasData = report.days.length > 0 && report.students.length > 0;
    el.reportEmpty.hidden = hasData;
    if (!hasData) return;

    const headRow = document.createElement('tr');
    ['Nº', 'Aluno', 'Presenças', 'Faltas', 'Aguardando', 'Dias', '%'].forEach((h) => {
      const th = document.createElement('th');
      th.textContent = h;
      headRow.appendChild(th);
    });
    for (const d of report.days) {
      const th = document.createElement('th');
      th.className = 'th-day';
      th.textContent = fmtDate(d);
      headRow.appendChild(th);
    }
    el.reportHead.appendChild(headRow);

    for (const s of report.students) {
      const tr = document.createElement('tr');
      tr.appendChild(cell(String(s.rollNumber == null ? '-' : s.rollNumber)));
      tr.appendChild(cell(s.name));
      tr.appendChild(cell(String(s.present), 'cell-center'));
      tr.appendChild(cell(String(s.absent), 'cell-center'));
      tr.appendChild(cell(String(s.pending || 0), 'cell-center'));
      tr.appendChild(cell(String(s.total), 'cell-center'));

      const rateCell = document.createElement('td');
      const bar = document.createElement('div');
      bar.className = 'mini-bar';
      const fill = document.createElement('div');
      fill.className = `mini-bar__fill ${s.rate >= 0.75 ? 'is-ok' : s.rate >= 0.5 ? 'is-mid' : 'is-bad'}`;
      fill.style.width = pct(s.rate);
      bar.appendChild(fill);
      const label = document.createElement('span');
      label.className = 'mini-bar__label';
      label.textContent = pct(s.rate);
      rateCell.appendChild(bar);
      rateCell.appendChild(label);
      tr.appendChild(rateCell);

      for (const d of report.days) {
        const td = document.createElement('td');
        const mark = s.byDate[d];
        const cls = mark === 'P' ? 'p' : mark === 'F' ? 'f' : 'pending';
        td.className = `cell-center day-mark day-mark--${cls}`;
        td.textContent = mark || '';
        tr.appendChild(td);
      }
      el.reportBody.appendChild(tr);
    }
  }

  function renderStudents() {
    const term = state.filter.trim().toLowerCase();
    const users = term
      ? state.students.filter((u) => u.name.toLowerCase().includes(term))
      : state.students;

    el.studentsGrid.innerHTML = '';
    el.studentsEmpty.hidden = users.length > 0;
    el.studentsEmpty.textContent = state.filter
      ? 'Nenhum aluno encontrado para a busca.'
      : 'Nenhum aluno nesta sala.';
    el.studentsTitle.textContent = `Alunos da sala ${state.classroom} (${state.students.length})`;

    const sorted = users.slice().sort((a, b) => (a.rollNumber || 0) - (b.rollNumber || 0));
    for (const u of sorted) {
      const card = document.createElement('div');
      card.className = 'student-card';

      const img = document.createElement('img');
      img.className = 'student-card__photo';
      img.alt = u.name;
      img.src = u.photo || ghostIcon();

      const info = document.createElement('div');
      info.className = 'student-card__info';
      const roll = document.createElement('span');
      roll.className = 'student-card__roll';
      roll.textContent = `Sala ${u.classroom || '-'} · Nº ${u.rollNumber == null ? '-' : u.rollNumber}`;
      const name = document.createElement('strong');
      name.textContent = u.name;
      const samples = document.createElement('span');
      samples.className = 'muted';
      samples.textContent = `${u.sampleCount || 0} vetor(es) facial(is)`;
      info.appendChild(roll);
      info.appendChild(name);
      info.appendChild(samples);

      const actions = document.createElement('div');
      actions.className = 'student-card__actions';

      const nameBtn = document.createElement('button');
      nameBtn.className = 'btn btn--tiny';
      nameBtn.textContent = 'Nome';
      nameBtn.addEventListener('click', () => editName(u));

      const edit = document.createElement('button');
      edit.className = 'btn btn--tiny';
      edit.textContent = 'Nº';
      edit.addEventListener('click', () => editRoll(u));

      const room = document.createElement('button');
      room.className = 'btn btn--tiny';
      room.textContent = 'Sala';
      room.addEventListener('click', () => editRoom(u));

      const del = document.createElement('button');
      del.className = 'btn btn--tiny btn--ghost';
      del.textContent = 'remover';
      del.addEventListener('click', () => removeStudent(u));

      actions.appendChild(nameBtn);
      actions.appendChild(edit);
      actions.appendChild(room);
      actions.appendChild(del);
      card.appendChild(img);
      card.appendChild(info);
      card.appendChild(actions);
      el.studentsGrid.appendChild(card);
    }
  }

  async function editRoll(user) {
    const answer = prompt(
      `Numero da chamada de ${user.name} (sala ${user.classroom || '-'}):`,
      user.rollNumber == null ? '' : String(user.rollNumber)
    );
    if (answer == null) return;
    const rollNumber = Number(answer);
    if (!Number.isInteger(rollNumber) || rollNumber < 1 || rollNumber > 9999) {
      alert('Informe um numero valido (1 a 9999).');
      return;
    }
    try {
      await req(`/api/users/${user.id}`, { method: 'PUT', body: JSON.stringify({ rollNumber }) });
      await Promise.all([loadStudents(), loadSheet()]);
    } catch (err) {
      alert(err.message);
    }
  }

  async function editName(user) {
    const answer = prompt('Nome completo do aluno:', user.name);
    if (answer == null) return;
    const name = answer.trim();
    if (!name) {
      alert('Informe o nome.');
      return;
    }
    try {
      await req(`/api/users/${user.id}`, { method: 'PUT', body: JSON.stringify({ name }) });
      await Promise.all([loadStudents(), loadSheet()]);
    } catch (err) {
      alert(err.message);
    }
  }

  async function editRoom(user) {
    const answer = prompt(
      `Nova sala de ${user.name} (opcoes: ${state.classrooms.join(', ')}):`,
      user.classroom || state.classroom
    );
    if (answer == null) return;
    const classroom = answer.trim().toUpperCase();
    if (!state.classrooms.includes(classroom)) {
      alert('Sala invalida.');
      return;
    }
    try {
      await req(`/api/users/${user.id}`, { method: 'PUT', body: JSON.stringify({ classroom }) });
      await Promise.all([loadStudents(), loadSheet(), loadReport()]);
    } catch (err) {
      alert(err.message);
    }
  }

  async function removeStudent(user) {
    if (!confirm(`Remover ${user.name}? As presencas desse aluno tambem serao apagadas.`)) return;
    try {
      await req(`/api/users/${user.id}`, { method: 'DELETE' });
      await Promise.all([loadStudents(), loadSheet(), loadReport()]);
    } catch (err) {
      alert(err.message);
    }
  }

  function ghostIcon() {
    const svg =
      '<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64">' +
      '<rect width="64" height="64" fill="#e2e8f0"/>' +
      '<circle cx="32" cy="25" r="11" fill="#94a3b8"/>' +
      '<ellipse cx="32" cy="53" rx="19" ry="13" fill="#94a3b8"/>' +
      '</svg>';
    return 'data:image/svg+xml;base64,' + btoa(svg);
  }

  const STATUS_LABEL = { present: 'Presente', pending: 'Aguardando', absent: 'Falta' };

  function csvCell(value) {
    return '"' + String(value == null ? '' : value).replace(/"/g, '""') + '"';
  }

  function downloadCsv(filename, rows) {
    const text = '\uFEFF' + rows.map((r) => r.map(csvCell).join(';')).join('\r\n');
    const blob = new Blob([text], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    a.click();
    URL.revokeObjectURL(url);
  }

  function exportSheet() {
    if (!state.sheet) return;
    const rows = [['Numero', 'Aluno', 'Status', 'Hora', 'Marcado por']];
    for (const s of state.sheet.students) {
      rows.push([
        s.rollNumber == null ? '' : s.rollNumber,
        s.name,
        STATUS_LABEL[s.status] || 'Falta',
        s.present ? fmtTime(s.at) : '',
        s.present ? (s.by === 'face' ? 'Reconhecimento' : 'Manual') : '',
      ]);
    }
    downloadCsv(`chamada_${state.classroom}_${state.sheet.date}.csv`, rows);
  }

  function exportReport() {
    const report = state.report;
    if (!report || !report.students.length) return;
    const rows = [
      ['Numero', 'Aluno', 'Presencas', 'Faltas', 'Aguardando', 'Dias', '%'].concat(report.days),
    ];
    for (const s of report.students) {
      rows.push(
        [
          s.rollNumber == null ? '' : s.rollNumber,
          s.name,
          s.present,
          s.absent,
          s.pending || 0,
          s.total,
          Math.round((s.rate || 0) * 100) + '%',
        ].concat(report.days.map((d) => s.byDate[d] || '-'))
      );
    }
    downloadCsv(`frequencia_${state.classroom}.csv`, rows);
  }

  el.btnOpen.addEventListener('click', async () => {
    const durationMin = Number(el.durationMin.value) || 0;
    await req('/api/attendance/session/open', {
      method: 'POST',
      body: JSON.stringify({ classroom: state.classroom, date: state.selectedDate, durationMin }),
    });
    await Promise.all([loadSheet(), loadReport()]);
  });

  el.btnClose.addEventListener('click', async () => {
    await req('/api/attendance/session/close', {
      method: 'POST',
      body: JSON.stringify({ classroom: state.classroom, date: state.selectedDate }),
    });
    await Promise.all([loadSheet(), loadReport()]);
  });

  el.btnRefresh.addEventListener('click', refreshLive);
  el.exportSheet.addEventListener('click', exportSheet);
  el.exportReport.addEventListener('click', exportReport);

  el.studentSearch.addEventListener('input', () => {
    state.filter = el.studentSearch.value;
    renderStudents();
  });

  document.querySelectorAll('.timer-presets .btn').forEach((btn) => {
    btn.addEventListener('click', () => {
      el.durationMin.value = btn.dataset.min;
    });
  });

  el.sheetDate.addEventListener('change', () => {
    state.selectedDate = el.sheetDate.value || state.today;
    loadSheet();
  });

  document.querySelectorAll('.tab').forEach((tab) => {
    tab.addEventListener('click', () => {
      document.querySelectorAll('.tab').forEach((t) => t.classList.remove('tab--active'));
      tab.classList.add('tab--active');
      for (const name of ['sheet', 'report', 'students']) {
        $(`tab-${name}`).hidden = name !== tab.dataset.tab;
      }
    });
  });

  init();
})();
