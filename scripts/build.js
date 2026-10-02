#!/usr/bin/env node
'use strict';

// Build the static, server-less version of the app into dist/: the same page,
// which in Chrome/Edge opens local files through the File System Access API.
// Serve dist/ from any static host over HTTPS (or http://localhost).

const fs = require('node:fs');
const path = require('node:path');
const { VENDOR } = require('../src/vendor.js');

const ROOT = path.join(__dirname, '..');
const OUT = path.resolve(process.argv[2] || path.join(ROOT, 'dist'));

fs.rmSync(OUT, { recursive: true, force: true });
fs.mkdirSync(path.join(OUT, 'static'), { recursive: true });
fs.mkdirSync(path.join(OUT, 'vendor'), { recursive: true });

for (const name of fs.readdirSync(path.join(ROOT, 'public'))) {
  const src = path.join(ROOT, 'public', name);
  const dest = name === 'index.html' ? path.join(OUT, name) : path.join(OUT, 'static', name);
  fs.copyFileSync(src, dest);
}
for (const [name, rel] of Object.entries(VENDOR)) {
  fs.copyFileSync(path.join(ROOT, 'node_modules', rel), path.join(OUT, 'vendor', name));
}

console.log(`dist listo en ${OUT}`);
