'use strict';

window.GlassesNet = (function () {
  'use strict';

  function zeros(n) {
    return new Float64Array(n);
  }

  function randn() {
    let u = 0;
    let v = 0;
    while (u === 0) u = Math.random();
    while (v === 0) v = Math.random();
    return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
  }

  function sigmoid(z) {
    return 1 / (1 + Math.exp(-z));
  }

  function create(inputSize, hiddenSize) {
    const h = hiddenSize || 8;
    const s1 = Math.sqrt(2 / inputSize);
    const s2 = Math.sqrt(2 / h);

    const W1 = Array.from({ length: inputSize }, () => {
      const row = zeros(h);
      for (let j = 0; j < h; j++) row[j] = randn() * s1;
      return row;
    });
    const W2 = Array.from({ length: h }, () => {
      const row = zeros(1);
      row[0] = randn() * s2;
      return row;
    });

    return { inputSize, hiddenSize: h, W1, b1: zeros(h), W2, b2: zeros(1) };
  }

  function forward(net, x) {
    const h = net.hiddenSize;
    const H = new Float64Array(h);
    for (let j = 0; j < h; j++) {
      let z = net.b1[j];
      for (let i = 0; i < net.inputSize; i++) z += x[i] * net.W1[i][j];
      H[j] = Math.tanh(z);
    }
    let z = net.b2[0];
    for (let j = 0; j < h; j++) z += H[j] * net.W2[j][0];
    return { H, logit: z, p: sigmoid(z) };
  }

  function predict(net, x) {
    return forward(net, x).p;
  }

  function train(net, X, Y, opts) {
    opts = opts || {};
    const epochs = opts.epochs || 600;
    const lr = opts.lr || 0.05;
    const l2 = opts.l2 == null ? 0.0005 : opts.l2;
    const batchSize = Math.max(1, Math.min(opts.batchSize || 16, X.length));
    const n = X.length;
    const h = net.hiddenSize;

    const gW1 = Array.from({ length: net.inputSize }, () => zeros(h));
    const gb1 = zeros(h);
    const gW2 = Array.from({ length: h }, () => zeros(1));
    const gb2 = zeros(1);
    const idx = Array.from({ length: n }, (_, i) => i);
    let lastLoss = 0;

    for (let epoch = 0; epoch < epochs; epoch++) {
      for (let i = n - 1; i > 0; i--) {
        const j = (Math.random() * (i + 1)) | 0;
        const tmp = idx[i];
        idx[i] = idx[j];
        idx[j] = tmp;
      }

      let epochLoss = 0;
      for (let start = 0; start < n; start += batchSize) {
        const end = Math.min(start + batchSize, n);
        const bs = end - start;

        for (let i = 0; i < net.inputSize; i++) gW1[i].fill(0);
        gb1.fill(0);
        for (let j = 0; j < h; j++) gW2[j].fill(0);
        gb2.fill(0);

        for (let k = start; k < end; k++) {
          const sampleIdx = idx[k];
          const xi = X[sampleIdx];
          const yi = Y[sampleIdx];
          const { H, p } = forward(net, xi);
          const dl = p - yi;
          epochLoss += -(yi * Math.log(p + 1e-9) + (1 - yi) * Math.log(1 - p + 1e-9));

          for (let j = 0; j < h; j++) gW2[j][0] += dl * H[j];
          gb2[0] += dl;

          for (let j = 0; j < h; j++) {
            const dh = dl * net.W2[j][0] * (1 - H[j] * H[j]);
            gb1[j] += dh;
            for (let i = 0; i < net.inputSize; i++) gW1[i][j] += dh * xi[i];
          }
        }

        const scale = lr / bs;
        for (let i = 0; i < net.inputSize; i++) {
          for (let j = 0; j < h; j++) {
            net.W1[i][j] -= scale * (gW1[i][j] + l2 * net.W1[i][j]);
          }
        }
        for (let j = 0; j < h; j++) {
          net.b1[j] -= scale * gb1[j];
          net.W2[j][0] -= scale * (gW2[j][0] + l2 * net.W2[j][0]);
        }
        net.b2[0] -= scale * gb2[0];
      }
      lastLoss = epochLoss / n;
    }

    return { loss: lastLoss };
  }

  function accuracy(net, X, Y, threshold) {
    const t = threshold == null ? 0.5 : threshold;
    let correct = 0;
    for (let i = 0; i < X.length; i++) {
      if ((predict(net, X[i]) >= t ? 1 : 0) === Y[i]) correct++;
    }
    return X.length ? correct / X.length : 0;
  }

  function computeStats(X) {
    const n = X.length;
    const d = X[0] ? X[0].length : 0;
    const mean = zeros(d);
    const std = zeros(d);

    for (const x of X) for (let i = 0; i < d; i++) mean[i] += x[i];
    for (let i = 0; i < d; i++) mean[i] /= n || 1;

    for (const x of X) {
      for (let i = 0; i < d; i++) {
        const df = x[i] - mean[i];
        std[i] += df * df;
      }
    }
    for (let i = 0; i < d; i++) std[i] = Math.sqrt(std[i] / (n || 1)) || 1;

    return { mean, std };
  }

  function standardize(x, mean, std) {
    const out = new Float64Array(x.length);
    for (let i = 0; i < x.length; i++) out[i] = (x[i] - mean[i]) / (std[i] || 1);
    return out;
  }

  function toJSON(net) {
    return {
      inputSize: net.inputSize,
      hiddenSize: net.hiddenSize,
      W1: net.W1.map((r) => Array.from(r)),
      b1: Array.from(net.b1),
      W2: net.W2.map((r) => Array.from(r)),
      b2: Array.from(net.b2),
    };
  }

  function fromJSON(obj) {
    return {
      inputSize: obj.inputSize,
      hiddenSize: obj.hiddenSize,
      W1: obj.W1.map((r) => Float64Array.from(r)),
      b1: Float64Array.from(obj.b1),
      W2: obj.W2.map((r) => Float64Array.from(r)),
      b2: Float64Array.from(obj.b2),
    };
  }

  return {
    create,
    forward,
    predict,
    train,
    accuracy,
    computeStats,
    standardize,
    toJSON,
    fromJSON,
  };
})();
