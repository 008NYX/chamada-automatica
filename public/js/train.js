'use strict';

(function () {
  'use strict';

  const CONFIG = {
    detectionIntervalMs: 180,
    maxSamples: 1200,
    tinyFace: { inputSize: 320, scoreThreshold: 0.45 },
    glasses: { ...window.GlassesDetector.defaultConfig },
  };

  const $ = (id) => document.getElementById(id);

  const el = {
    video: $('video'),
    overlay: $('overlay'),
    banner: $('banner'),
    btnStart: $('btn-start'),
    modelStatus: $('model-status'),
    modelStatusText: $('model-status-text'),

    recWith: $('rec-with'),
    recWithout: $('rec-without'),
    countWith: $('count-with'),
    countWithout: $('count-without'),
    btnClear: $('btn-clear'),
    faceHint: $('face-hint'),

    hiddenSize: $('hidden-size'),
    epochs: $('epochs'),
    warmStart: $('warm-start'),
    btnTrain: $('btn-train'),
    metricTrainAcc: $('metric-train-acc'),
    metricValAcc: $('metric-val-acc'),
    metricLoss: $('metric-loss'),
    accProgress: $('acc-progress'),
    accProgressLabel: $('acc-progress-label'),
    accMessage: $('acc-message'),

    liveLabel: $('live-label'),
    liveBar: $('live-bar'),
    liveProb: $('live-prob'),
    glassesDebug: $('glasses-debug'),

    modelInfo: $('model-info'),
    btnSave: $('btn-save'),
    btnDelete: $('btn-delete'),
    saveStatus: $('save-status'),
  };

  const state = {
    modelsReady: false,
    cameraReady: false,
    running: false,
    inFlight: false,
    timer: null,
    recording: null,
    samples: [],
    net: null,
    mean: null,
    std: null,
    hiddenSize: 8,
    sessionModel: null,
    savedModel: null,
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

      state.modelsReady = true;
      setModelStatus('ok', 'Modelos carregados');
      el.btnStart.disabled = false;
    } catch (err) {
      console.error(err);
      setModelStatus('error', 'Falha ao carregar modelos (rode "npm install")');
    }
  }

  function setModelStatus(kind, text) {
    el.modelStatus.className = `dot dot--${kind}`;
    el.modelStatusText.textContent = text;
  }

  async function startCamera() {
    try {
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
      el.recWith.disabled = false;
      el.recWithout.disabled = false;

      el.video.addEventListener('loadedmetadata', syncCanvasSize);
      syncCanvasSize();

      await loadSavedModel();
      loop();
    } catch (err) {
      console.error(err);
      setBanner('Nao foi possivel acessar a webcam: ' + err.message, 'danger');
    }
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
        console.error('tick', err);
      } finally {
        state.inFlight = false;
      }
    }
    state.timer = setTimeout(loop, CONFIG.detectionIntervalMs);
  }

  async function tick() {
    const options = new faceapi.TinyFaceDetectorOptions(CONFIG.tinyFace);
    const result = await faceapi.detectSingleFace(el.video, options).withFaceLandmarks();

    const ctx = el.overlay.getContext('2d');
    ctx.clearRect(0, 0, el.overlay.width, el.overlay.height);

    if (!result) {
      el.faceHint.textContent = 'Nenhum rosto encontrado.';
      el.liveLabel.textContent = '--';
      el.liveLabel.className = 'live-label';
      el.liveBar.style.width = '0%';
      el.liveProb.textContent = '--';
      return;
    }

    faceapi.draw.drawDetections(el.overlay, result.detection, { boxColor: '#3b82f6', lineWidth: 2 });
    faceapi.draw.drawFaceLandmarks(el.overlay, result.landmarks, { color: '#3b82f6', lineWidth: 1 });

    const features = GlassesDetector.extractFeatures(el.video, result.landmarks, CONFIG.glasses);
    if (!features) return;

    if (state.recording && state.samples.length < CONFIG.maxSamples) {
      state.samples.push({ x: features, y: state.recording === 'with' ? 1 : 0 });
      updateCounters();
      el.faceHint.textContent =
        state.recording === 'with' ? 'Gravando COM oculos...' : 'Gravando SEM oculos...';
    } else if (!state.recording) {
      el.faceHint.textContent = 'Rosto detectado. Escolha COM ou SEM oculos para gravar.';
    } else {
      el.faceHint.textContent = 'Limite de amostras atingido.';
    }

    if (state.net) {
      const std = GlassesNet.standardize(features, state.mean, state.std);
      const prob = GlassesNet.predict(state.net, std);
      const pct = Math.round(prob * 100);
      const withGlasses = prob >= 0.5;
      el.liveLabel.textContent = withGlasses ? 'COM oculos' : 'SEM oculos';
      el.liveLabel.className = `live-label ${withGlasses ? 'live-label--with' : 'live-label--without'}`;
      el.liveBar.style.width = `${pct}%`;
      el.liveBar.className = `progress__bar ${withGlasses ? 'progress__bar--with' : 'progress__bar--without'}`;
      el.liveProb.textContent = `${pct}%`;

      const g = GlassesDetector.analyze(el.video, result.landmarks, CONFIG.glasses);
      el.glassesDebug.textContent = JSON.stringify(g.signals, null, 2);
    }
  }

  function toggleRecording(mode) {
    state.recording = state.recording === mode ? null : mode;
    el.recWith.classList.toggle('record-btn--active', state.recording === 'with');
    el.recWithout.classList.toggle('record-btn--active', state.recording === 'without');
    if (!state.recording) el.faceHint.textContent = '';
    if (state.samples.length) el.btnClear.disabled = false;
  }

  function updateCounters() {
    const withCount = state.samples.filter((s) => s.y === 1).length;
    const withoutCount = state.samples.length - withCount;
    el.countWith.textContent = withCount;
    el.countWithout.textContent = withoutCount;
    el.btnClear.disabled = state.samples.length === 0;
    el.btnTrain.disabled = !(withCount >= 6 && withoutCount >= 6);
  }

  function clearSamples() {
    state.samples = [];
    state.recording = null;
    el.recWith.classList.remove('record-btn--active');
    el.recWithout.classList.remove('record-btn--active');
    updateCounters();
    setMetrics(null);
    el.faceHint.textContent = 'Amostras apagadas.';
  }

  function splitTrainValidation(samples) {
    const byClass = { 0: [], 1: [] };
    for (const s of samples) byClass[s.y].push(s);
    for (const key of ['0', '1']) shuffle(byClass[key]);

    const train = [];
    const val = [];
    for (const key of ['0', '1']) {
      const list = byClass[key];
      const valCount = list.length >= 8 ? Math.max(1, Math.round(list.length * 0.2)) : 0;
      val.push(...list.slice(0, valCount));
      train.push(...list.slice(valCount));
    }
    shuffle(train);
    shuffle(val);
    return { train, val };
  }

  function shuffle(arr) {
    for (let i = arr.length - 1; i > 0; i--) {
      const j = (Math.random() * (i + 1)) | 0;
      const t = arr[i];
      arr[i] = arr[j];
      arr[j] = t;
    }
  }

  function trainModel() {
    if (!state.modelsReady) return;

    const withCount = state.samples.filter((s) => s.y === 1).length;
    const withoutCount = state.samples.length - withCount;
    if (withCount < 6 || withoutCount < 6) {
      setAccMessage('Grave pelo menos 6 amostras COM e 6 SEM oculos.', 'warn');
      return;
    }

    el.btnTrain.disabled = true;
    el.btnTrain.textContent = 'Treinando...';

    setTimeout(() => {
      try {
        const hiddenSize = clampInt(el.hiddenSize.value, 2, 32, 8);
        const epochs = clampInt(el.epochs.value, 50, 5000, 400);

        const { train, val } = splitTrainValidation(state.samples);
        const inputSize = GlassesDetector.INPUT_SIZE;
        const shape = (list) => ({ X: list.map((s) => s.x), Y: list.map((s) => s.y) });
        const tr = shape(train);
        const va = shape(val);

        const canWarm =
          el.warmStart.checked &&
          state.savedModel &&
          state.savedModel.inputSize === inputSize &&
          state.savedModel.hiddenSize === hiddenSize;

        let net;
        let mean;
        let std;
        if (canWarm) {
          net = GlassesNet.fromJSON(state.savedModel);
          mean = Float64Array.from(state.savedModel.mean);
          std = Float64Array.from(state.savedModel.std);
        } else {
          net = GlassesNet.create(inputSize, hiddenSize);
          const stats = GlassesNet.computeStats(tr.X);
          mean = stats.mean;
          std = stats.std;
        }

        const stdTrX = tr.X.map((x) => GlassesNet.standardize(x, mean, std));
        const stdVaX = va.X.map((x) => GlassesNet.standardize(x, mean, std));

        const { loss } = GlassesNet.train(net, stdTrX, tr.Y, { epochs, lr: 0.05, l2: 0.0005, batchSize: 16 });

        const trainAcc = GlassesNet.accuracy(net, stdTrX, tr.Y);
        const valAcc = va.X.length ? GlassesNet.accuracy(net, stdVaX, va.Y) : null;

        state.net = net;
        state.mean = mean;
        state.std = std;
        state.hiddenSize = hiddenSize;

        state.sessionModel = {
          ...GlassesNet.toJSON(net),
          mean: Array.from(mean),
          std: Array.from(std),
          probThreshold: 0.5,
          stats: {
            samples: state.samples.length,
            withGlasses: withCount,
            withoutGlasses: withoutCount,
            trainSamples: tr.X.length,
            validationSamples: va.X.length,
            epochs,
            loss: Number(loss.toFixed(4)),
            trainAccuracy: round4(trainAcc),
            validationAccuracy: valAcc == null ? null : round4(valAcc),
            trainedAt: new Date().toISOString(),
          },
        };

        GlassesDetector.setModel(state.sessionModel);
        setMetrics(state.sessionModel.stats);
        el.btnSave.disabled = false;
        updateSavedInfo();
      } catch (err) {
        console.error(err);
        setAccMessage('Erro no treino: ' + err.message, 'danger');
      } finally {
        el.btnTrain.disabled = false;
        el.btnTrain.textContent = 'Treinar rede';
      }
    }, 30);
  }

  function setMetrics(stats) {
    if (!stats) {
      el.metricTrainAcc.textContent = '--';
      el.metricValAcc.textContent = '--';
      el.metricLoss.textContent = '--';
      el.accProgress.style.width = '0%';
      el.accProgressLabel.textContent = '0%';
      return;
    }
    const trainPct = Math.round(stats.trainAccuracy * 100);
    const valPct = stats.validationAccuracy == null ? null : Math.round(stats.validationAccuracy * 100);

    el.metricTrainAcc.textContent = `${trainPct}%`;
    el.metricValAcc.textContent = valPct == null ? 'sem validacao' : `${valPct}%`;
    el.metricLoss.textContent = stats.loss;

    const display = valPct == null ? trainPct : valPct;
    el.accProgress.style.width = `${display}%`;
    el.accProgressLabel.textContent = `${display}%`;

    if (display >= 100) {
      setAccMessage('100% de acerto! Salve o modelo para usar na pagina principal.', 'success');
    } else {
      setAccMessage(
        'Ainda nao chegou a 100%. Grave mais amostras variando luz, distancia e angulo, e treine novamente.',
        'warn'
      );
    }
  }

  function setAccMessage(text, kind) {
    el.accMessage.textContent = text;
    el.accMessage.className = `muted acc-message acc-message--${kind || 'info'}`;
  }

  async function loadSavedModel() {
    try {
      const { model } = await Api.getGlassesModel();
      state.savedModel = model || null;
      if (model) {
        state.net = GlassesNet.fromJSON(model);
        state.mean = Float64Array.from(model.mean);
        state.std = Float64Array.from(model.std);
        state.hiddenSize = model.hiddenSize;
        GlassesDetector.setModel(model);
        el.btnDelete.disabled = false;
      }
      updateSavedInfo();
    } catch (err) {
      console.error(err);
    }
  }

  function updateSavedInfo() {
    const m = state.savedModel;
    if (!m) {
      el.modelInfo.textContent = state.sessionModel
        ? 'Modelo treinado nesta sessao (ainda nao salvo).'
        : 'Nenhum modelo treinado nesta sessao.';
      return;
    }
    const s = m.stats || {};
    const acc = s.validationAccuracy == null ? s.trainAccuracy : s.validationAccuracy;
    el.modelInfo.textContent =
      `Modelo salvo em ${m.savedAt ? new Date(m.savedAt).toLocaleString('pt-BR') : '?'} ` +
      `| amostras: ${s.samples || '?'} | acuracia: ${acc == null ? '?' : Math.round(acc * 100) + '%'} ` +
      `| neuronios ocultos: ${m.hiddenSize}`;
  }

  async function saveModel() {
    if (!state.sessionModel) return;
    el.btnSave.disabled = true;
    el.btnSave.textContent = 'Salvando...';
    try {
      const { model } = await Api.saveGlassesModel(state.sessionModel);
      state.savedModel = model;
      el.btnDelete.disabled = false;
      el.saveStatus.textContent = 'Modelo salvo com sucesso. A pagina principal ja usa a rede neural.';
      updateSavedInfo();
    } catch (err) {
      el.saveStatus.textContent = 'Erro ao salvar: ' + err.message;
    } finally {
      el.btnSave.disabled = false;
      el.btnSave.textContent = 'Salvar modelo';
    }
  }

  async function deleteModel() {
    if (!confirm('Apagar o modelo salvo? A deteccao volta a usar a heuristica.')) return;
    try {
      await Api.deleteGlassesModel();
      state.savedModel = null;
      state.sessionModel = null;
      state.net = null;
      GlassesDetector.setModel(null);
      el.btnDelete.disabled = true;
      el.btnSave.disabled = true;
      el.saveStatus.textContent = 'Modelo apagado.';
      setMetrics(null);
      updateSavedInfo();
    } catch (err) {
      el.saveStatus.textContent = 'Erro ao apagar: ' + err.message;
    }
  }

  function clampInt(value, min, max, fallback) {
    const n = parseInt(value, 10);
    if (!Number.isFinite(n)) return fallback;
    return Math.min(max, Math.max(min, n));
  }

  function round4(v) {
    return Math.round(v * 10000) / 10000;
  }

  function setBanner(text, kind) {
    el.banner.textContent = text;
    el.banner.className = `banner banner--${kind}`;
  }

  el.btnStart.addEventListener('click', startCamera);
  el.recWith.addEventListener('click', () => toggleRecording('with'));
  el.recWithout.addEventListener('click', () => toggleRecording('without'));
  el.btnClear.addEventListener('click', clearSamples);
  el.btnTrain.addEventListener('click', trainModel);
  el.btnSave.addEventListener('click', saveModel);
  el.btnDelete.addEventListener('click', deleteModel);

  window.addEventListener('beforeunload', () => {
    state.running = false;
    clearTimeout(state.timer);
  });

  loadModels();
})();
