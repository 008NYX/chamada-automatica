'use strict';

(function () {
  'use strict';

  const CONFIG = {
    detectionIntervalMs: 220,
    noFaceTimeoutMs: 1500,
    matchThreshold: 0.55,
    maxRegistrationSamples: 5,
    captureTimeoutMs: 4000,
    tinyFace: { inputSize: 320, scoreThreshold: 0.45 },
    glasses: { ...window.GlassesDetector.defaultConfig },
    showGuide: true,
    mirror: false,
  };

  const $ = (id) => document.getElementById(id);

  const el = {
    videoWrap: $('video-wrap'),
    video: $('video'),
    overlay: $('overlay'),
    videoPlaceholder: $('video-placeholder'),
    banner: $('banner'),
    btnStart: $('btn-start'),
    btnRegister: $('btn-register'),
    overrideGlasses: $('override-glasses'),
    cameraInfo: $('camera-info'),
    modelStatus: $('model-status'),
    modelStatusText: $('model-status-text'),
    statusText: $('status-text'),
    userCard: $('user-card'),
    userAvatar: $('user-avatar'),
    userName: $('user-name'),
    userRoll: $('user-roll'),
    userPresent: $('user-present'),
    userConfidence: $('user-confidence'),
    userCount: $('user-count'),
    userList: $('user-list'),
    modal: $('modal'),
    modalError: $('modal-error'),
    sampleCount: $('sample-count'),
    capturePhoto: $('capture-photo'),
    captureStatusText: $('capture-status-text'),
    form: $('register-form'),
    fieldName: $('field-name'),
    fieldClassroom: $('field-classroom'),
    fieldRoll: $('field-roll'),
    btnSave: $('btn-save'),
    glassesDebug: $('glasses-debug'),
    glassesSource: $('glasses-source'),
    glassesEnabled: $('glasses-enabled'),
    glassesThreshold: $('glasses-threshold'),
    glassesThresholdValue: $('glasses-threshold-value'),
    debugBody: $('debug-body'),
    btnDebugToggle: $('btn-debug-toggle'),

    diagBody: $('diag-body'),
    btnDiagToggle: $('btn-diag-toggle'),
    detectThreshold: $('detect-threshold'),
    detectThresholdValue: $('detect-threshold-value'),
    detectRate: $('detect-rate'),
    detectRateValue: $('detect-rate-value'),
    detectInputsize: $('detect-inputsize'),
    showGuide: $('show-guide'),
    mirror: $('mirror'),
    diagChecklist: $('diag-checklist'),
    diagDump: $('diag-dump'),
  };

  const state = {
    modelsReady: false,
    cameraReady: false,
    running: false,
    loopTimer: null,
    userTimer: null,
    inFlight: false,
    lastFaceAt: 0,
    facePresent: false,
    descriptor: null,
    landmarks: null,
    detection: null,
    detectionScore: null,
    glasses: { isGlasses: false, score: 0, signals: null, source: 'none' },
    matched: null,
    usersIndex: [],
    isTeacher: false,
    modalOpen: false,
    capturing: false,
    captureStartedAt: 0,
    capturedDescriptors: [],
    capturedPhoto: null,
    registrationDescriptors: [],
    registrationPhoto: null,
    overrideGlasses: false,
    fps: 0,
    lastTickAt: 0,
    tickCount: 0,
    lastError: null,
  };

  function glassesBlocking() {
    return state.glasses.isGlasses && !state.overrideGlasses;
  }

  function faceInsideGuide() {
    if (!state.detection) return false;
    const { cx, cy, rx, ry } = guideGeometry();
    const box = state.detection.box;
    const bx = box.x + box.width / 2;
    const by = box.y + box.height / 2;
    return ((bx - cx) / rx) ** 2 + ((by - cy) / ry) ** 2 <= 1;
  }

  function guideGeometry() {
    const W = el.overlay.width || 640;
    const H = el.overlay.height || 480;
    return { W, H, cx: W / 2, cy: H * 0.52, rx: W * 0.26, ry: H * 0.4 };
  }

  async function loadModels() {
    try {
      if (window.faceapi.tf) {
        try {
          await window.faceapi.tf.setBackend('webgl');
        } catch (_) {

        }
        await window.faceapi.tf.ready();
      }

      const base = '/models';
      await faceapi.nets.tinyFaceDetector.loadFromUri(base);
      await faceapi.nets.faceLandmark68Net.loadFromUri(base);
      await faceapi.nets.faceRecognitionNet.loadFromUri(base);

      state.modelsReady = true;
      setModelStatus('ok', 'Modelos carregados');
      el.btnStart.disabled = false;
    } catch (err) {
      console.error(err);
      state.lastError = 'Falha ao carregar modelos: ' + err.message;
      setModelStatus('error', 'Falha ao carregar modelos (rode "npm install")');
    }
  }

  function setModelStatus(kind, text) {
    el.modelStatus.className = `dot dot--${kind}`;
    el.modelStatusText.textContent = text;
  }

  async function startCamera() {
    try {
      if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
        throw new Error('Este navegador nao expoe getUserMedia.');
      }

      const stream = await navigator.mediaDevices.getUserMedia({
        video: { width: { ideal: 640 }, height: { ideal: 480 }, facingMode: 'user' },
        audio: false,
      });
      el.video.srcObject = stream;
      await el.video.play();

      state.cameraReady = true;
      state.running = true;
      el.btnStart.disabled = true;
      el.btnStart.textContent = 'Camera ativa';
      el.videoPlaceholder.classList.add('video-placeholder--hidden');

      el.video.addEventListener('loadedmetadata', () => {
        syncCanvasSize();
        updateCameraInfo();
      });
      syncCanvasSize();
      updateCameraInfo();

      await Promise.all([loadUsers(), loadAuthState(), loadClassrooms()]);
      await loadGlassesModel();

      state.userTimer = setInterval(loadUsers, 15000);
      loop();
    } catch (err) {
      console.error(err);
      state.lastError = 'Erro de camera: ' + err.message;
      setBanner('Nao foi possivel acessar a webcam: ' + err.message, 'danger');
      el.statusText.textContent = 'Erro de camera.';
      el.cameraInfo.textContent = 'Erro: ' + err.message;
    }
  }

  function syncCanvasSize() {
    el.overlay.width = el.video.videoWidth || 640;
    el.overlay.height = el.video.videoHeight || 480;
  }

  function updateCameraInfo() {
    const w = el.video.videoWidth;
    const h = el.video.videoHeight;
    const fps = state.fps ? Math.round(state.fps) : '--';
    el.cameraInfo.textContent = state.cameraReady
      ? `Previa da camera: ${w}x${h} · deteccao ~${fps} fps`
      : '';
  }

  async function loop() {
    if (!state.running) return;
    if (!state.inFlight && el.video.readyState >= 2) {
      state.inFlight = true;
      try {
        await tick();
      } catch (err) {
        console.error('tick', err);
        state.lastError = 'Erro no loop: ' + err.message;
      } finally {
        state.inFlight = false;
      }
    }
    state.loopTimer = setTimeout(loop, CONFIG.detectionIntervalMs);
  }

  async function tick() {
    measureFps();

    const options = new faceapi.TinyFaceDetectorOptions(CONFIG.tinyFace);
    const result = await faceapi
      .detectSingleFace(el.video, options)
      .withFaceLandmarks()
      .withFaceDescriptor();

    const now = Date.now();
    state.tickCount++;

    if (result) {
      state.facePresent = true;
      state.lastFaceAt = now;
      state.detection = result.detection;
      state.detectionScore = result.detection.score;
      state.landmarks = result.landmarks;
      state.descriptor = result.descriptor;
      state.glasses = GlassesDetector.analyze(el.video, result.landmarks, CONFIG.glasses);
    } else {
      state.facePresent = false;
      state.detection = null;
      state.detectionScore = null;
      state.landmarks = null;
      state.descriptor = null;
      state.glasses = { isGlasses: false, score: 0, signals: null, source: 'none' };
    }

    if (state.descriptor && !glassesBlocking()) {
      state.matched = matchDescriptor(state.descriptor);
    } else {
      state.matched = null;
    }

    if (state.capturing) handleCaptureTick(now);

    drawOverlay();
    updateGlassesDebug();
    updateDiagnostics();
    render();
  }

  function measureFps() {
    const now = performance.now();
    if (state.lastTickAt) {
      const dt = now - state.lastTickAt;
      if (dt > 0) {
        const instant = 1000 / dt;
        state.fps = state.fps ? state.fps * 0.85 + instant * 0.15 : instant;
      }
    }
    state.lastTickAt = now;
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

  function drawOverlay() {
    const ctx = el.overlay.getContext('2d');
    const W = el.overlay.width;
    const H = el.overlay.height;
    ctx.clearRect(0, 0, W, H);

    if (state.detection) {
      const boxColor = glassesBlocking() ? '#f59e0b' : state.matched ? '#22c55e' : '#3b82f6';
      ctx.save();
      if (CONFIG.mirror) {
        ctx.translate(W, 0);
        ctx.scale(-1, 1);
      }
      faceapi.draw.drawDetections(el.overlay, state.detection, { boxColor, lineWidth: 3 });
      faceapi.draw.drawFaceLandmarks(el.overlay, state.landmarks, { color: boxColor, lineWidth: 1 });
      ctx.restore();
    }

    if (CONFIG.showGuide) drawGuide(ctx, W, H);
  }

  function drawGuide(ctx, W, H) {
    const { cx, cy, rx, ry } = guideGeometry();
    const inside = faceInsideGuide();

    let color = 'rgba(255, 255, 255, 0.5)';
    if (state.detection) color = inside ? '#22c55e' : '#f59e0b';

    ctx.save();
    ctx.setLineDash([12, 9]);
    ctx.lineWidth = 3;
    ctx.strokeStyle = color;
    ctx.beginPath();
    ctx.ellipse(cx, cy, rx, ry, 0, 0, Math.PI * 2);
    ctx.stroke();
    ctx.restore();

    ctx.save();
    ctx.fillStyle = 'rgba(255, 255, 255, 0.9)';
    ctx.font = 'bold 15px system-ui, -apple-system, sans-serif';
    ctx.textAlign = 'center';
    ctx.shadowColor = 'rgba(0,0,0,0.65)';
    ctx.shadowBlur = 5;
    let label = '';
    if (!state.detection) label = 'Posicione o rosto dentro do guia';
    else if (!inside) label = 'Ajuste o rosto dentro do guia';
    if (label) ctx.fillText(label, cx, cy - ry - 14);
    ctx.restore();
  }

  function deriveState(now) {
    const graceActive = now - state.lastFaceAt < 700;
    if (state.facePresent || graceActive) {
      if (glassesBlocking() && state.facePresent) return 'glasses';
      if (state.matched) return 'matched';
      return 'unknown';
    }
    if (now - state.lastFaceAt > CONFIG.noFaceTimeoutMs) return 'no-face';
    return 'searching';
  }

  function render() {
    if (!state.cameraReady) return;
    const now = Date.now();
    const ui = deriveState(now);

    if (state.capturing) {
      const n = state.capturedDescriptors.length;
      setBanner(`Capturando rosto... ${n}/${CONFIG.maxRegistrationSamples}`, 'info');
      setStatus('Mantenha o rosto por um instante. Nao precisa ficar depois de abrir o formulario.', 'success');
      el.btnRegister.hidden = true;
      return;
    }

    switch (ui) {
      case 'glasses':
        setBanner('Por favor, remova os óculos para continuar', 'danger');
        setStatus(
          'Detector de oculos bloqueou. Se voce esta SEM oculos, marque "Estou sem oculos" ao lado.',
          'danger'
        );
        showUserCard(null);
        break;

      case 'matched':
        setBanner('Rosto reconhecido', 'success');
        setStatus('Usuario identificado com sucesso.', 'success');
        showUserCard(state.matched);
        break;

      case 'unknown':
        setBanner('Rosto detectado, mas nao cadastrado', 'warn');
        setStatus('Rosto nao cadastrado. Clique em "Cadastrar novo rosto" para capturar.', 'warn');
        showUserCard(null);
        break;

      case 'no-face':
        setBanner('Nenhum rosto encontrado', 'danger');
        setStatus('Nenhum rosto encontrado. Posicione o rosto dentro do guia.', 'danger');
        showUserCard(null);
        break;

      default:
        setBanner('Procurando rosto...', 'info');
        setStatus('Procurando rosto...', 'idle');
        showUserCard(null);
        break;
    }

    const canRegister =
      state.isTeacher &&
      state.modelsReady &&
      state.cameraReady &&
      !glassesBlocking() &&
      !state.modalOpen &&
      (ui === 'no-face' || ui === 'unknown');
    el.btnRegister.hidden = !canRegister;

    if (!state.isTeacher && (ui === 'no-face' || ui === 'unknown')) {
      setStatus('Para cadastrar alunos, entre como professor em /login.', 'warn');
    }
  }

  function setBanner(text, kind) {
    el.banner.textContent = text;
    el.banner.className = `banner banner--${kind}`;
  }

  function setStatus(text, kind) {
    el.statusText.textContent = text;
    el.statusText.className = `status-text status-text--${kind}`;
  }

  function showUserCard(match) {
    if (!match) {
      el.userCard.hidden = true;
      return;
    }
    const u = match.user;
    el.userCard.hidden = false;
    el.userAvatar.textContent = (u.name || '?').charAt(0).toUpperCase();
    el.userName.textContent = u.name;
    el.userRoll.textContent = `Sala ${u.classroom || '-'} · Nº ${u.rollNumber == null ? '-' : u.rollNumber}`;
    el.userPresent.textContent = '';
    const similarity = Math.max(0, Math.round((1 - match.distance / CONFIG.matchThreshold) * 100));
    el.userConfidence.textContent = `Correspondencia: ${similarity}% (distancia ${match.distance.toFixed(2)})`;
  }

  function updateDiagnostics() {
    updateCameraInfo();

    const now = Date.now();
    const info = GlassesDetector.getModelInfo();
    const g = state.glasses;

    const items = [];
    const add = (label, status, detail) => items.push({ label, status, detail });

    add(
      'Modelos de IA carregados',
      state.modelsReady ? 'ok' : 'fail',
      state.modelsReady ? 'tiny_face_detector + landmarks + recognition' : state.lastError || 'aguardando /models'
    );

    add(
      'Camera ativa',
      state.cameraReady ? 'ok' : 'fail',
      state.cameraReady
        ? `${el.video.videoWidth}x${el.video.videoHeight} · readyState=${el.video.readyState} · ~${Math.round(state.fps)} fps`
        : state.lastError || 'clique em "Iniciar camera" e autorize o navegador'
    );

    add(
      'Rosto detectado',
      state.facePresent ? 'ok' : 'fail',
      state.facePresent
        ? `score ${Number(state.detectionScore).toFixed(3)} · enquadramento ${faceInsideGuide() ? 'dentro do guia' : 'FORA do guia'}`
        : state.cameraReady
          ? 'nenhum rosto acima do limiar. Abaixe a sensibilidade ou aproxime-se'
          : '-'
    );

    add(
      'Pontos faciais (68 landmarks)',
      state.landmarks ? 'ok' : 'fail',
      state.landmarks ? 'encontrados' : 'nao encontrados'
    );

    let glassesStatus = 'ok';
    let glassesDetail = 'sem oculos';
    if (g.isGlasses && state.overrideGlasses) {
      glassesStatus = 'warn';
      glassesDetail = `detectado (${g.source}, score ${g.score}) mas IGNORADO pelo debug`;
    } else if (g.isGlasses) {
      glassesStatus = 'fail';
      glassesDetail = `detectado (${g.source}, score ${g.score}, limiar ${g.threshold}). Se voce esta sem oculos, marque a caixa "Estou sem oculos"`;
    } else if (state.facePresent) {
      glassesDetail = `nada detectado (${g.source}, score ${g.score})`;
    } else {
      glassesDetail = 'sem rosto para avaliar';
    }
    add('Sem oculos (ou ignorado)', glassesStatus, glassesDetail);

    const hasData = state.registrationDescriptors.length >= 1 || state.capturedDescriptors.length >= 1;
    if (state.capturing) {
      add(
        'Captura de dados faciais',
        'warn',
        `capturando... ${state.capturedDescriptors.length}/${CONFIG.maxRegistrationSamples} (mantenha o rosto)`
      );
    } else if (state.modalOpen) {
      add(
        'Dados faciais capturados',
        hasData ? 'ok' : 'fail',
        `${state.registrationDescriptors.length} vetor(es) - preencha sem precisar da camera`
      );
    }

    const blockers = [];
    if (!state.modelsReady) blockers.push('modelos');
    if (!state.cameraReady) blockers.push('camera');
    if (!state.capturing && !hasData) {
      if (!state.facePresent) blockers.push('rosto');
      if (!state.landmarks) blockers.push('landmarks');
    }
    if (glassesBlocking()) blockers.push('oculos bloqueando');
    if (state.capturing) blockers.push('capturando (aguarde)');
    if (state.modalOpen && !hasData) blockers.push('dados faciais');
    add(
      'Cadastro liberado',
      blockers.length === 0 ? 'ok' : 'fail',
      blockers.length === 0 ? 'sim, pode salvar' : 'faltando: ' + blockers.join(', ')
    );

    if (!el.diagBody.hidden) {
      renderChecklist(items);
      el.diagDump.textContent = JSON.stringify(
        {
          fps: Math.round(state.fps),
          ticks: state.tickCount,
          facePresent: state.facePresent,
          detectionScore: state.detectionScore,
          insideGuide: faceInsideGuide(),
          landmarks: state.landmarks ? state.landmarks.positions.length : 0,
          glasses: { source: g.source, isGlasses: g.isGlasses, score: g.score, threshold: g.threshold },
          glassesSignals: g.signals,
          modelSource: info.source,
          overrideGlasses: state.overrideGlasses,
          detectionConfig: CONFIG.tinyFace,
          intervalMs: CONFIG.detectionIntervalMs,
          error: state.lastError,
        },
        null,
        2
      );
    }
  }

  function renderChecklist(items) {
    el.diagChecklist.innerHTML = '';
    for (const item of items) {
      const li = document.createElement('li');
      li.className = `diag-${item.status}`;
      const icon = document.createElement('span');
      icon.className = 'diag-icon';
      icon.textContent = item.status === 'ok' ? 'OK' : item.status === 'warn' ? '!' : 'X';
      const text = document.createElement('span');
      const label = document.createElement('strong');
      label.textContent = item.label;
      const detail = document.createElement('span');
      detail.className = 'diag-detail';
      detail.textContent = item.detail || '';
      text.appendChild(label);
      text.appendChild(detail);
      li.appendChild(icon);
      li.appendChild(text);
      el.diagChecklist.appendChild(li);
    }
  }

  function updateGlassesDebug() {
    const info = GlassesDetector.getModelInfo();
    if (el.glassesSource) {
      el.glassesSource.textContent =
        info.source === 'neural'
          ? `Fonte: rede neural treinada (${info.hiddenSize} neuronios ocultos)`
          : 'Fonte: heuristica (treine em /train.html para usar a rede)';
    }
    if (el.debugBody.hidden) return;

    const g = state.glasses;
    if (!g.signals) {
      el.glassesDebug.textContent = `fonte: ${g.source || info.source}\nscore: ${g.score}\nsem rosto`;
      return;
    }
    el.glassesDebug.textContent = JSON.stringify(
      {
        fonte: g.source || info.source,
        oculos: g.isGlasses,
        score: g.score,
        threshold: g.threshold,
        ...g.signals,
      },
      null,
      2
    );
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
      renderUserList(users);
    } catch (err) {
      console.error(err);
      state.lastError = 'Erro ao carregar usuarios: ' + err.message;
    }
  }

  async function loadClassrooms() {
    try {
      const cfg = await Api.config();
      el.fieldClassroom.innerHTML = '';
      const placeholder = document.createElement('option');
      placeholder.value = '';
      placeholder.textContent = 'Selecione a sala';
      el.fieldClassroom.appendChild(placeholder);
      for (const room of cfg.classrooms) {
        const opt = document.createElement('option');
        opt.value = room;
        opt.textContent = room;
        el.fieldClassroom.appendChild(opt);
      }
    } catch (_) {

    }
  }

  async function loadAuthState() {
    try {
      const me = await Api.me();
      state.isTeacher = !!me.authenticated;
    } catch (_) {
      state.isTeacher = false;
    }
  }

  async function loadGlassesModel() {
    try {
      const { model } = await Api.getGlassesModel();
      GlassesDetector.setModel(model || null);
    } catch (err) {
      console.error('glasses model', err);
    }
  }

  function renderUserList(users) {
    el.userCount.textContent = users.length;
    el.userList.innerHTML = '';
    for (const u of users) {
      const li = document.createElement('li');

      const info = document.createElement('div');
      const strong = document.createElement('strong');
      strong.textContent = u.name;
      const meta = document.createElement('div');
      meta.className = 'u-meta';
      meta.textContent = `Sala ${u.classroom || '-'} · Nº ${u.rollNumber == null ? '-' : u.rollNumber} · ${u.sampleCount || 0} vetor(es)`;
      info.appendChild(strong);
      info.appendChild(meta);

      const del = document.createElement('button');
      del.type = 'button';
      del.textContent = 'remover';
      del.addEventListener('click', () => removeUser(u));

      li.appendChild(info);
      li.appendChild(del);
      el.userList.appendChild(li);
    }
  }

  async function removeUser(user) {
    if (!confirm(`Remover ${user.name}?`)) return;
    try {
      await Api.deleteUser(user.id);
      await loadUsers();
    } catch (err) {
      alert(err.message);
    }
  }

  function captureFaceThumbnail() {
    if (!state.detection) return null;
    const box = state.detection.box;
    const vw = el.video.videoWidth;
    const vh = el.video.videoHeight;
    if (!vw || !vh) return null;

    const pad = 0.4;
    const sx = Math.max(0, box.x - box.width * pad);
    const sy = Math.max(0, box.y - box.height * pad);
    const sw = Math.min(vw - sx, box.width * (1 + pad * 2));
    const sh = Math.min(vh - sy, box.height * (1 + pad * 2));

    const size = 220;
    const canvas = document.createElement('canvas');
    canvas.width = size;
    canvas.height = size;
    const ctx = canvas.getContext('2d');
    ctx.drawImage(el.video, sx, sy, sw, sh, 0, 0, size, size);
    return canvas.toDataURL('image/jpeg', 0.8);
  }

  function startRegistration() {
    if (state.capturing || state.modalOpen) return;

    if (!state.facePresent) {
      setBanner('Posicione o rosto na camera para capturar os dados.', 'warn');
      return;
    }
    if (glassesBlocking()) {
      setBanner('Por favor, remova os óculos para continuar', 'danger');
      return;
    }

    state.capturing = true;
    state.capturedDescriptors = [];
    state.capturedPhoto = null;
    state.captureStartedAt = Date.now();
    el.btnRegister.hidden = true;
  }

  function handleCaptureTick(now) {
    if (state.descriptor && !glassesBlocking()) {
      if (state.capturedDescriptors.length === 0) state.capturedPhoto = captureFaceThumbnail();
      if (state.capturedDescriptors.length < CONFIG.maxRegistrationSamples) {
        state.capturedDescriptors.push(Array.from(state.descriptor));
      }
    }

    const enough = state.capturedDescriptors.length >= CONFIG.maxRegistrationSamples;
    const timeout = now - state.captureStartedAt > CONFIG.captureTimeoutMs;

    if (enough || (timeout && state.capturedDescriptors.length >= 1)) {
      finishCapture();
      return;
    }
    if (timeout) {
      cancelCapture('Nao consegui capturar o rosto. Posicione-o no guia e tente novamente.');
    }
  }

  function finishCapture() {
    state.capturing = false;
    state.registrationDescriptors = state.capturedDescriptors.slice();
    state.registrationPhoto = state.capturedPhoto;
    openModal();
  }

  function cancelCapture(message) {
    state.capturing = false;
    state.capturedDescriptors = [];
    state.capturedPhoto = null;
    setBanner(message, 'danger');
  }

  function openModal() {
    state.modalOpen = true;
    el.modalError.hidden = true;
    el.sampleCount.textContent = `${state.registrationDescriptors.length} vetor(es) faciais`;
    el.captureStatusText.textContent = 'Rosto capturado';
    if (state.registrationPhoto) {
      el.capturePhoto.src = state.registrationPhoto;
      el.capturePhoto.hidden = false;
    } else {
      el.capturePhoto.hidden = true;
    }
    el.modal.hidden = false;
    el.fieldName.focus();
  }

  function closeModal() {
    state.modalOpen = false;
    state.registrationDescriptors = [];
    state.registrationPhoto = null;
    el.modal.hidden = true;
    el.form.reset();
    el.modalError.hidden = true;
  }

  async function submitRegistration(event) {
    event.preventDefault();
    el.modalError.hidden = true;

    if (!state.registrationDescriptors.length) {
      showModalError('Nenhum dado facial capturado. Feche e clique em "Cadastrar novo rosto" novamente.');
      return;
    }

    const payload = {
      name: el.fieldName.value.trim(),
      classroom: el.fieldClassroom.value,
      rollNumber: Number(el.fieldRoll.value),
      descriptors: state.registrationDescriptors.map((arr) => JSON.stringify(arr)),
      photo: state.registrationPhoto || null,
    };

    if (!payload.name) return showModalError('Informe o nome completo do aluno.');
    if (!payload.classroom) return showModalError('Selecione a sala do aluno.');
    if (!Number.isInteger(payload.rollNumber) || payload.rollNumber < 1 || payload.rollNumber > 9999) {
      return showModalError('Informe um numero de chamada valido (1 a 9999).');
    }

    el.btnSave.disabled = true;
    el.btnSave.textContent = 'Salvando...';
    try {
      await Api.createUser(payload);
      closeModal();
      await loadUsers();
      setBanner('Aluno cadastrado com sucesso!', 'success');
    } catch (err) {
      if (err.status === 401) {
        showModalError('Acesso restrito ao professor. Entre em /login e tente novamente.');
      } else {
        showModalError(err.message);
      }
    } finally {
      el.btnSave.disabled = false;
      el.btnSave.textContent = 'Salvar aluno';
    }
  }

  function showModalError(message) {
    el.modalError.textContent = message;
    el.modalError.hidden = false;
  }

  el.btnStart.addEventListener('click', startCamera);
  el.btnRegister.addEventListener('click', startRegistration);
  el.form.addEventListener('submit', submitRegistration);

  el.modal.querySelectorAll('[data-close-modal]').forEach((node) => {
    node.addEventListener('click', closeModal);
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && state.modalOpen) closeModal();
  });

  el.btnDiagToggle.addEventListener('click', () => {
    el.diagBody.hidden = !el.diagBody.hidden;
    el.btnDiagToggle.textContent = el.diagBody.hidden ? 'mostrar' : 'ocultar';
    updateDiagnostics();
  });

  el.detectThreshold.addEventListener('input', () => {
    const value = Number(el.detectThreshold.value);
    CONFIG.tinyFace.scoreThreshold = value;
    el.detectThresholdValue.textContent = value.toFixed(2);
  });

  el.detectRate.addEventListener('input', () => {
    const value = Number(el.detectRate.value);
    CONFIG.detectionIntervalMs = value;
    el.detectRateValue.textContent = String(value);
  });

  el.detectInputsize.addEventListener('change', () => {
    CONFIG.tinyFace.inputSize = Number(el.detectInputsize.value);
  });

  el.showGuide.addEventListener('change', () => {
    CONFIG.showGuide = el.showGuide.checked;
  });

  el.mirror.addEventListener('change', () => {
    CONFIG.mirror = el.mirror.checked;
    el.videoWrap.classList.toggle('is-mirrored', CONFIG.mirror);
  });

  el.overrideGlasses.addEventListener('change', () => {
    state.overrideGlasses = el.overrideGlasses.checked;
  });

  el.btnDebugToggle.addEventListener('click', () => {
    el.debugBody.hidden = !el.debugBody.hidden;
    el.btnDebugToggle.textContent = el.debugBody.hidden ? 'mostrar' : 'ocultar';
    updateGlassesDebug();
  });

  el.glassesEnabled.addEventListener('change', () => {
    CONFIG.glasses.enabled = el.glassesEnabled.checked;
  });

  el.glassesThreshold.addEventListener('input', () => {
    const value = Number(el.glassesThreshold.value);
    CONFIG.glasses.scoreThreshold = value;
    el.glassesThresholdValue.textContent = value.toFixed(2);
  });

  window.addEventListener('beforeunload', () => {
    state.running = false;
    clearTimeout(state.loopTimer);
    clearInterval(state.userTimer);
  });

  loadModels();
})();
