'use strict';

(function () {
  'use strict';

  const CONFIG = {
    detectionIntervalMs: 220,
    matchThreshold: 0.55,
    pauseAfterMarkMs: 2000,
    roomPollMs: 5000,
    tinyFace: { inputSize: 320, scoreThreshold: 0.45 },
    glasses: { ...window.GlassesDetector.defaultConfig },
  };

  const $ = (id) => document.getElementById(id);

  const el = {
    video: $('video'),
    overlay: $('overlay'),
    roomSelect: $('room-select'),
    sessionBadge: $('session-badge'),
    sessionCountdown: $('session-countdown'),
    closedOverlay: $('closed-overlay'),
    closedText: $('closed-text'),
    badge: $('status-badge'),
    todayTotals: $('today-totals'),
    errorDetail: $('error-detail'),
    userPanel: $('user-panel'),
    userPhoto: $('user-photo'),
    userName: $('user-name'),
    userRoll: $('user-roll'),
    userConfidence: $('user-confidence'),
    presenceLine: $('presence-line'),
    presentCount: $('present-count'),
    presentList: $('present-list'),
    btnStart: $('btn-start'),
    ignoreGlasses: $('ignore-glasses'),
  };

  const state = {
    modelsReady: false,
    running: false,
    inFlight: false,
    starting: false,
    timer: null,
    pollTimer: null,
    tickTimer: null,
    userTimer: null,
    expiresAt: null,
    stream: null,
    classroom: null,
    roomOpen: false,
    rooms: [],
    usersIndex: [],
    facePresent: false,
    detection: null,
    landmarks: null,
    glasses: { isGlasses: false, score: 0 },
    ignoreGlasses: false,
    pausedUntil: 0,
    marking: false,
    markingSince: 0,
    presenceMessage: '',
    presenceOk: false,
    sheet: null,
  };

  async function loadModels() {
    try {
      if (window.faceapi.tf) {
        try {
          await window.faceapi.tf.setBackend('webgl');
        } catch (_) {

        }
        await window.faceapi.tf.ready();
      }
      await faceapi.nets.tinyFaceDetector.loadFromUri('/models');
      await faceapi.nets.faceLandmark68Net.loadFromUri('/models');
      await faceapi.nets.faceRecognitionNet.loadFromUri('/models');
      state.modelsReady = true;
      await init();
    } catch (err) {
      console.error(err);
      setBadge('Falha ao carregar a IA', 'no');
    }
  }

  let glassesModelLoaded = false;
  async function loadGlassesModel() {
    if (glassesModelLoaded) return;
    glassesModelLoaded = true;
    try {
      const { model } = await Api.getGlassesModel();
      GlassesDetector.setModel(model || null);
    } catch (_) {

    }
  }

  async function init() {
    try {
      const cfg = await Api.config();
      el.roomSelect.innerHTML = '';
      for (const room of cfg.classrooms) {
        const opt = document.createElement('option');
        opt.value = room;
        opt.textContent = room;
        el.roomSelect.appendChild(opt);
      }
      state.classroom = el.roomSelect.value;
    } catch (err) {
      console.error(err);
    }

    await loadUsers();
    await loadGlassesModel();
    await refreshRooms();
    state.pollTimer = setInterval(refreshRooms, CONFIG.roomPollMs);
    state.tickTimer = setInterval(tickCountdown, 1000);

    state.userTimer = setInterval(loadUsers, 15000);
  }

  async function refreshRooms() {
    try {
      const { rooms } = await Api.rooms();
      state.rooms = rooms;

      for (const opt of el.roomSelect.options) {
        const room = rooms.find((r) => r.classroom === opt.value);
        opt.textContent = room ? `${opt.value} ${room.open ? '(aberta)' : '(fechada)'}` : opt.value;
      }

      const current = rooms.find((r) => r.classroom === state.classroom);
      state.roomOpen = !!(current && current.open);
      updateRoomUI();

      await refreshSheet();
    } catch (err) {
      console.error(err);
    }
  }

  function updateRoomUI() {
    if (!state.classroom) {
      el.sessionBadge.textContent = 'Selecione a sala';
      el.sessionBadge.className = 'pill pill--warn';
      stopCamera();
      return;
    }

    if (state.roomOpen) {
      el.sessionBadge.textContent = 'Chamada aberta';
      el.sessionBadge.className = 'pill pill--ok';
      el.closedOverlay.hidden = true;
      if (!state.stream) setBadge('Aproxime o rosto da camera', 'idle');
      startCamera();
    } else {
      el.sessionBadge.textContent = 'Chamada fechada';
      el.sessionBadge.className = 'pill pill--bad';
      el.closedText.textContent = `Chamada da sala ${state.classroom} fechada`;
      el.closedOverlay.hidden = false;
      setBadge('Chamada fechada', 'warn');
      stopCamera();
    }
  }

  async function startCamera() {
    if (state.stream || state.starting) return;
    state.starting = true;
    try {
      if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
        throw new Error('getUserMedia indisponivel (acesse por http://localhost:3000)');
      }
      const stream = await navigator.mediaDevices.getUserMedia({
        video: { width: { ideal: 640 }, height: { ideal: 480 }, facingMode: 'user' },
        audio: false,
      });

      if (state.stream) {
        stream.getTracks().forEach((t) => t.stop());
        return;
      }
      state.stream = stream;
      el.video.srcObject = stream;
      await el.video.play();
      state.running = true;
      el.btnStart.hidden = true;

      el.video.addEventListener('loadedmetadata', syncCanvasSize);
      syncCanvasSize();
      loop();
    } catch (err) {
      console.error(err);

      if (!state.stream) {
        setBadge('Nao foi possivel acessar a webcam', 'no');
        el.btnStart.hidden = false;
        showError(`Webcam (${err.name || 'erro'}): ${err.message || ''}`);
      }
    } finally {
      state.starting = false;
    }
  }

  function stopCamera() {
    state.running = false;
    clearTimeout(state.timer);
    state.timer = null;
    if (state.stream) {
      state.stream.getTracks().forEach((t) => t.stop());
      state.stream = null;
    }
    el.video.srcObject = null;
    const ctx = el.overlay.getContext('2d');
    ctx.clearRect(0, 0, el.overlay.width, el.overlay.height);
    el.userPanel.classList.remove('simple-user--visible');
  }

  function syncCanvasSize() {
    el.overlay.width = el.video.videoWidth || 640;
    el.overlay.height = el.video.videoHeight || 480;
  }

  async function loop() {
    if (!state.running) return;
    if (!state.inFlight && el.video.readyState >= 2) {
      state.inFlight = true;
      try {
        await tick();
      } catch (err) {
        console.error(err);
      } finally {
        state.inFlight = false;
      }
    }
    state.timer = setTimeout(loop, CONFIG.detectionIntervalMs);
  }

  async function tick() {
    if (!state.roomOpen) {
      stopCamera();
      return;
    }

    const ctx = el.overlay.getContext('2d');

    if (Date.now() < state.pausedUntil) {
      ctx.clearRect(0, 0, el.overlay.width, el.overlay.height);
      const seconds = Math.max(1, Math.ceil((state.pausedUntil - Date.now()) / 1000));
      setBadge(state.presenceMessage || `Aguarde ${seconds}s...`, state.presenceOk ? 'ok' : 'warn');
      return;
    }

    const options = new faceapi.TinyFaceDetectorOptions(CONFIG.tinyFace);
    const result = await faceapi
      .detectSingleFace(el.video, options)
      .withFaceLandmarks()
      .withFaceDescriptor();

    ctx.clearRect(0, 0, el.overlay.width, el.overlay.height);

    if (!result) {
      state.facePresent = false;
      state.glasses = { isGlasses: false, score: 0 };
      state.presenceMessage = '';
      setBadge('Nenhum rosto encontrado', 'idle');
      return;
    }

    state.facePresent = true;
    state.detection = result.detection;
    state.landmarks = result.landmarks;
    state.glasses = GlassesDetector.analyze(el.video, result.landmarks, CONFIG.glasses);

    faceapi.draw.drawDetections(el.overlay, result.detection, { boxColor: '#1d4ed8', lineWidth: 3 });

    if (state.glasses.isGlasses && !state.ignoreGlasses) {
      setBadge('Remova os oculos para continuar', 'warn');
      return;
    }

    const match = matchDescriptor(result.descriptor);
    if (!match) {
      setBadge('Rosto nao reconhecido', 'no');
      showUser(null);
      return;
    }

    if (match.user.classroom !== state.classroom) {
      setBadge(`Aluno de outra sala (${match.user.classroom || 'sem sala'})`, 'warn');
      showUser(null);
      return;
    }

    state.presenceMessage = '';
    state.presenceOk = false;
    hideError();
    setBadge('Rosto reconhecido', 'ok');
    showUser(match);
    markPresence(match.user);
  }

  function matchDescriptor(descriptor) {
    let best = null;
    for (const entry of state.usersIndex) {
      for (const vec of entry.vectors) {
        const d = euclidean(descriptor, vec);
        if (!best || d < best.distance) best = { user: entry.user, distance: d };
      }
    }
    if (best && best.distance <= CONFIG.matchThreshold) return best;
    return null;
  }

  function euclidean(a, b) {
    let sum = 0;
    for (let i = 0; i < a.length; i++) {
      const diff = a[i] - b[i];
      sum += diff * diff;
    }
    return Math.sqrt(sum);
  }

  async function markPresence(student) {

    if (state.marking) {
      if (Date.now() - state.markingSince < 6000) return;
      state.marking = false;
    }
    state.marking = true;
    state.markingSince = Date.now();

    state.pausedUntil = Date.now() + CONFIG.pauseAfterMarkMs;
    state.presenceOk = true;
    state.presenceMessage = 'Registrando presença...';
    updatePresenceLine();

    try {
      const res = await tryMark(student);
      const time = new Date().toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });
      state.presenceOk = true;
      state.presenceMessage = res.newlyMarked
        ? `Presença registrada às ${time}`
        : 'Aluno já está como presente';
      hideError();
      applySheet(res.sheet);
    } catch (err) {
      if (err.status === 409) {
        state.presenceOk = false;
        state.presenceMessage = 'Chamada encerrada. Peça ao professor para reabrir.';
        showError(`A chamada da sala ${state.classroom} está encerrada (ou o tempo acabou).`);
        state.roomOpen = false;
        updateRoomUI();
      } else {

        try {
          const res2 = await tryMark(student);
          state.presenceOk = true;
          state.presenceMessage = res2.newlyMarked
            ? 'Presença registrada'
            : 'Aluno já está como presente';
          hideError();
          applySheet(res2.sheet);
        } catch (err2) {
          state.presenceOk = false;
          state.presenceMessage =
            'Não foi possível registrar: ' + (err2.message || 'erro de conexão');
          showError(
            `Detalhe (${err2.name || 'erro'}): ${err2.message || ''}. ` +
              'Confirme se acessa por http://localhost:3000 e se a chamada está aberta.'
          );
        }
      }
    } finally {
      state.marking = false;
      updatePresenceLine();
    }
  }

  async function tryMark(student) {
    try {
      return await Api.markPresent(student.id);
    } catch (err) {
      if (err.status === 404) {
        await loadUsers();
        const current = state.usersIndex.find((e) => e.user.name === student.name);
        if (current) return await Api.markPresent(current.user.id);
      }
      throw err;
    }
  }

  async function refreshSheet() {
    if (!state.classroom) return;
    try {
      const sheet = await Api.todaySheet(state.classroom);
      applySheet(sheet);
    } catch (_) {

    }
  }

  function applySheet(sheet) {
    state.sheet = sheet;
    state.expiresAt = sheet.session && sheet.session.open ? sheet.session.expiresAt : null;
    el.todayTotals.textContent =
      `Sala ${sheet.classroom} — hoje: ` +
      `${sheet.totals.present} presente(s), ${sheet.totals.pending} aguardando, ` +
      `${sheet.totals.total} aluno(s)`;
    renderPresentList(sheet);
    updateCountdown();
  }

  function updateCountdown() {
    if (!state.roomOpen || !state.expiresAt) {
      el.sessionCountdown.textContent = state.roomOpen ? 'sem tempo limite' : '';
      return;
    }
    const remaining = Date.parse(state.expiresAt) - Date.now();
    if (remaining <= 0) {
      el.sessionCountdown.textContent = 'tempo esgotado';
      return;
    }
    const total = Math.round(remaining / 1000);
    const m = String(Math.floor(total / 60)).padStart(2, '0');
    const s = String(total % 60).padStart(2, '0');
    el.sessionCountdown.textContent = `fecha em ${m}:${s}`;
  }

  function tickCountdown() {
    if (!state.roomOpen) return;
    if (state.expiresAt && Date.parse(state.expiresAt) <= Date.now()) {
      refreshRooms();
    }
    updateCountdown();
  }

  function renderPresentList(sheet) {
    const present = sheet.students.filter((s) => s.present);
    el.presentCount.textContent = `${present.length}/${sheet.students.length}`;
    el.presentList.innerHTML = '';

    if (present.length === 0) {
      const li = document.createElement('li');
      li.className = 'present-list__empty';
      li.textContent = 'Ninguem marcou presenca ainda.';
      el.presentList.appendChild(li);
      return;
    }

    for (const s of present) {
      const li = document.createElement('li');
      const name = document.createElement('span');
      name.textContent = `${s.rollNumber == null ? '-' : s.rollNumber}. ${s.name}`;
      const at = document.createElement('span');
      at.className = 'present-list__time';
      at.textContent = s.at
        ? new Date(s.at).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' })
        : '';
      li.appendChild(name);
      li.appendChild(at);
      el.presentList.appendChild(li);
    }
  }

  function setBadge(text, kind) {
    el.badge.textContent = text;
    el.badge.className = `simple-status__badge simple-status__badge--${kind}`;
    if (kind !== 'ok') el.userPanel.classList.remove('simple-user--visible');
  }

  function showError(text) {
    el.errorDetail.textContent = text;
    el.errorDetail.hidden = false;
  }

  function hideError() {
    el.errorDetail.hidden = true;
    el.errorDetail.textContent = '';
  }

  function showUser(match) {
    const u = match.user;
    el.userName.textContent = u.name;
    el.userRoll.textContent = `Sala ${u.classroom || '-'} · Nº ${u.rollNumber == null ? '-' : u.rollNumber}`;
    const similarity = Math.max(0, Math.round((1 - match.distance / CONFIG.matchThreshold) * 100));
    el.userConfidence.textContent = `Correspondencia: ${similarity}%`;
    if (u.photo) {
      el.userPhoto.src = u.photo;
      el.userPhoto.hidden = false;
    } else {
      el.userPhoto.hidden = true;
    }
    el.userPanel.classList.add('simple-user--visible');
    updatePresenceLine();
  }

  function updatePresenceLine() {
    el.presenceLine.textContent = state.presenceMessage;
    el.presenceLine.className = `line line--presence ${state.presenceOk ? 'is-ok' : 'is-bad'}`;
  }

  async function loadUsers() {
    try {
      const { users } = await Api.listUsers();
      state.usersIndex = users.map((u) => ({
        user: u,
        vectors: (u.descriptors || [])
          .map((s) => {
            try {
              const arr = JSON.parse(s);
              return Array.isArray(arr) && arr.length === 128 ? new Float32Array(arr) : null;
            } catch (_) {
              return null;
            }
          })
          .filter(Boolean),
      }));
    } catch (err) {
      console.error(err);
    }
  }

  el.roomSelect.addEventListener('change', () => {
    state.classroom = el.roomSelect.value;
    state.pausedUntil = 0;
    stopCamera();
    refreshRooms();
  });

  el.btnStart.addEventListener('click', startCamera);
  el.ignoreGlasses.addEventListener('change', () => {
    state.ignoreGlasses = el.ignoreGlasses.checked;
  });

  window.addEventListener('beforeunload', () => {
    clearInterval(state.pollTimer);
    clearInterval(state.tickTimer);
    clearInterval(state.userTimer);
    stopCamera();
  });

  loadModels();
})();
