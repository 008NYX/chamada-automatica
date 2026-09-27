'use strict';

window.GlassesDetector = (function () {
  'use strict';

  const LEFT_EYE = [36, 37, 38, 39, 40, 41];
  const RIGHT_EYE = [42, 43, 44, 45, 46, 47];

  const FEATURE_NAMES = [
    'left.darkRatio',
    'left.edgeDensity',
    'left.specularRatio',
    'left.skinRatio',
    'right.darkRatio',
    'right.edgeDensity',
    'right.specularRatio',
    'right.skinRatio',
    'bridge.darkRatio',
    'bridge.specularRatio',
    'bridge.skinRatio',
    'max.darkRatio',
    'max.edgeDensity',
    'max.specularRatio',
  ];

  const INPUT_SIZE = FEATURE_NAMES.length;

  let cachedNet = null;
  let activeModel = null;

  const defaultConfig = {
    enabled: true,
    scoreThreshold: 1.0,
    combine: { max: 0.6, mean: 0.4 },
    eye: { sidePad: 0.4, topPad: 1.0, bottomPad: 0.9 },
    normalize: {
      darkRatio: 0.3,
      edgeDensity: 0.18,
      specularRatio: 0.02,
      bridgeDarkRatio: 0.22,
    },
    weights: { dark: 1.2, edge: 0.9, specular: 0.6, bridge: 0.8 },
    skin: { bridgeRef: 0.45 },
  };

  let canvas = null;
  let ctx = null;

  function ensureCanvas() {
    if (!canvas) {
      canvas = document.createElement('canvas');
      ctx = canvas.getContext('2d', { willReadFrequently: true });
    }
  }

  function clamp(v, min, max) {
    return v < min ? min : v > max ? max : v;
  }

  function mergeConfig(user) {
    const base = defaultConfig;
    return {
      ...base,
      ...user,
      combine: { ...base.combine, ...(user && user.combine) },
      eye: { ...base.eye, ...(user && user.eye) },
      normalize: { ...base.normalize, ...(user && user.normalize) },
      weights: { ...base.weights, ...(user && user.weights) },
      skin: { ...base.skin, ...(user && user.skin) },
    };
  }

  function boundingBox(points, padX, padTop, padBottom, maxW, maxH) {
    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    for (const p of points) {
      if (p.x < minX) minX = p.x;
      if (p.y < minY) minY = p.y;
      if (p.x > maxX) maxX = p.x;
      if (p.y > maxY) maxY = p.y;
    }
    const w = Math.max(1, maxX - minX);
    const h = Math.max(1, maxY - minY);
    const x0 = clamp(minX - w * padX, 0, maxW - 1);
    const x1 = clamp(maxX + w * padX, 1, maxW);
    const y0 = clamp(minY - h * padTop, 0, maxH - 1);
    const y1 = clamp(maxY + h * padBottom, 1, maxH);
    return {
      x: Math.floor(x0),
      y: Math.floor(y0),
      w: Math.max(2, Math.floor(x1 - x0)),
      h: Math.max(2, Math.floor(y1 - y0)),
    };
  }

  function isSkin(r, g, b) {
    const mx = Math.max(r, g, b);
    const mn = Math.min(r, g, b);
    return (
      r > 95 &&
      g > 40 &&
      b > 20 &&
      mx - mn > 15 &&
      Math.abs(r - g) > 15 &&
      r > g &&
      r > b
    );
  }

  function regionStats(video, box) {
    ensureCanvas();
    const { x, y, w, h } = box;
    canvas.width = w;
    canvas.height = h;
    ctx.drawImage(video, x, y, w, h, 0, 0, w, h);

    const img = ctx.getImageData(0, 0, w, h);
    const data = img.data;
    const total = w * h;

    const lum = new Float32Array(total);
    let dark = 0;
    let spec = 0;
    let skin = 0;

    for (let i = 0, p = 0; i < total; i++, p += 4) {
      const r = data[p];
      const g = data[p + 1];
      const b = data[p + 2];
      const l = 0.299 * r + 0.587 * g + 0.114 * b;
      lum[i] = l;
      if (l < 70) dark++;
      if (l > 235) spec++;
      if (isSkin(r, g, b)) skin++;
    }

    let edges = 0;
    let samples = 0;
    for (let yy = 1; yy < h - 1; yy++) {
      const row = yy * w;
      for (let xx = 0; xx < w; xx++) {
        const i = row + xx;
        if (Math.abs(lum[i + w] - lum[i - w]) > 45) edges++;
        samples++;
      }
    }

    return {
      darkRatio: dark / total,
      specularRatio: spec / total,
      skinRatio: skin / total,
      edgeDensity: samples ? edges / samples : 0,
    };
  }

  function excess(value, ref) {
    if (ref <= 0) return 0;
    return Math.max(0, value / ref - 1);
  }

  function computeRegions(video, landmarks, cfg) {
    const vw = video.videoWidth || video.width;
    const vh = video.videoHeight || video.height;
    if (!vw || !vh || !landmarks || !landmarks.positions) return null;

    const pos = landmarks.positions;
    const leftBox = boundingBox(LEFT_EYE.map((i) => pos[i]), cfg.eye.sidePad, cfg.eye.topPad, cfg.eye.bottomPad, vw, vh);
    const rightBox = boundingBox(RIGHT_EYE.map((i) => pos[i]), cfg.eye.sidePad, cfg.eye.topPad, cfg.eye.bottomPad, vw, vh);

    const innerLeft = pos[39];
    const innerRight = pos[42];
    const bx0 = Math.min(innerLeft.x, innerRight.x);
    const bx1 = Math.max(innerLeft.x, innerRight.x);
    const by0 = Math.min(innerLeft.y, innerRight.y);
    const by1 = Math.max(innerLeft.y, innerRight.y);
    const bw = Math.max(2, bx1 - bx0);
    const bh = Math.max(2, by1 - by0);
    const bridgeBox = {
      x: clamp(Math.floor(bx0 - bw * 0.1), 0, vw - 1),
      y: clamp(Math.floor(by0 - bh * 0.25), 0, vh - 1),
      w: Math.max(2, Math.floor(bw * 1.2)),
      h: Math.max(2, Math.floor(bh * 1.5)),
    };

    const left = regionStats(video, leftBox);
    const right = regionStats(video, rightBox);
    const bridge = regionStats(video, bridgeBox);
    return { left, right, bridge };
  }

  function extractFeatures(video, landmarks, userConfig) {
    const regions = computeRegions(video, landmarks, mergeConfig(userConfig));
    if (!regions) return null;
    return featuresFromRegions(regions);
  }

  function featuresFromRegions({ left, right, bridge }) {
    return Float64Array.from([
      left.darkRatio,
      left.edgeDensity,
      left.specularRatio,
      left.skinRatio,
      right.darkRatio,
      right.edgeDensity,
      right.specularRatio,
      right.skinRatio,
      bridge.darkRatio,
      bridge.specularRatio,
      bridge.skinRatio,
      Math.max(left.darkRatio, right.darkRatio),
      Math.max(left.edgeDensity, right.edgeDensity),
      Math.max(left.specularRatio, right.specularRatio),
    ]);
  }

  function setModel(model) {
    activeModel = null;
    cachedNet = null;
    if (!model) return;
    if (!window.GlassesNet || model.inputSize !== INPUT_SIZE) return;
    try {
      cachedNet = window.GlassesNet.fromJSON(model);
      activeModel = model;
    } catch (_) {
      cachedNet = null;
      activeModel = null;
    }
  }

  function getModelInfo() {
    if (!activeModel) return { source: 'heuristic', inputSize: INPUT_SIZE };
    return {
      source: 'neural',
      inputSize: INPUT_SIZE,
      hiddenSize: activeModel.hiddenSize,
      probThreshold: activeModel.probThreshold == null ? 0.5 : activeModel.probThreshold,
      stats: activeModel.stats || null,
      savedAt: activeModel.savedAt || null,
    };
  }

  function analyze(video, landmarks, userConfig) {
    const cfg = mergeConfig(userConfig);

    if (!cfg.enabled || !landmarks || !landmarks.positions) {
      return { isGlasses: false, score: 0, threshold: cfg.scoreThreshold, source: 'disabled', signals: null };
    }

    const regions = computeRegions(video, landmarks, cfg);
    if (!regions) {
      return { isGlasses: false, score: 0, threshold: cfg.scoreThreshold, source: 'none', signals: null };
    }

    const { left, right, bridge } = regions;

    if (cachedNet && activeModel) {
      const features = featuresFromRegions(regions);
      const standardized = window.GlassesNet.standardize(features, activeModel.mean, activeModel.std);
      const prob = window.GlassesNet.predict(cachedNet, standardized);
      const threshold = activeModel.probThreshold == null ? 0.5 : activeModel.probThreshold;
      return {
        isGlasses: prob >= threshold,
        score: Number(prob.toFixed(3)),
        threshold,
        source: 'neural',
        signals: {
          probability: Number(prob.toFixed(3)),
          ...signalsFromRegions(regions),
        },
      };
    }

    const n = cfg.normalize;
    const w = cfg.weights;

    const eyeScore = (s) =>
      w.dark * excess(s.darkRatio, n.darkRatio) +
      w.edge * excess(s.edgeDensity, n.edgeDensity) +
      w.spec * excess(s.specularRatio, n.specularRatio);

    const eyeScores = [eyeScore(left), eyeScore(right)];
    const maxEye = Math.max(eyeScores[0], eyeScores[1]);
    const meanEye = (eyeScores[0] + eyeScores[1]) / 2;

    const bridgeDark = excess(bridge.darkRatio, n.bridgeDarkRatio);
    const bridgeSkinPenalty = clamp((cfg.skin.bridgeRef - bridge.skinRatio) / cfg.skin.bridgeRef, 0, 1);

    const score =
      cfg.combine.max * maxEye + cfg.combine.mean * meanEye + w.bridge * Math.max(bridgeDark, bridgeSkinPenalty);

    return {
      isGlasses: score >= cfg.scoreThreshold,
      score: Number(score.toFixed(3)),
      threshold: cfg.scoreThreshold,
      source: 'heuristic',
      signals: {
        ...signalsFromRegions(regions),
        eyeScores: eyeScores.map((v) => Number(v.toFixed(3))),
        bridgeDark: Number(bridgeDark.toFixed(3)),
        bridgeSkinPenalty: Number(bridgeSkinPenalty.toFixed(3)),
      },
    };
  }

  function signalsFromRegions({ left, right, bridge }) {
    return {
      leftEye: roundStats(left),
      rightEye: roundStats(right),
      bridge: roundStats(bridge),
    };
  }

  function roundStats(s) {
    return {
      darkRatio: Number(s.darkRatio.toFixed(3)),
      edgeDensity: Number(s.edgeDensity.toFixed(3)),
      specularRatio: Number(s.specularRatio.toFixed(3)),
      skinRatio: Number(s.skinRatio.toFixed(3)),
    };
  }

  return {
    defaultConfig,
    FEATURE_NAMES,
    INPUT_SIZE,
    analyze,
    extractFeatures,
    setModel,
    getModelInfo,
  };
})();
