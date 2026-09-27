'use strict';

const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const srcBase = path.join(root, 'node_modules', '@vladmandic', 'face-api');
const publicDir = path.join(root, 'public');

const copies = [
  { from: path.join(srcBase, 'dist'), to: path.join(publicDir, 'face-api') },
  { from: path.join(srcBase, 'model'), to: path.join(publicDir, 'models') },
];

for (const { from, to } of copies) {
  if (!fs.existsSync(from)) {
    console.log('[copy-models] origem ausente, pulando:', path.relative(root, from));
    continue;
  }
  fs.mkdirSync(to, { recursive: true });
  fs.cpSync(from, to, { recursive: true });
  console.log('[copy-models] copiado ->', path.relative(root, to));
}
