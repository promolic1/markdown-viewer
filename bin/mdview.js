#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { createServer, isMarkdown } = require('../src/server.js');

const HELP = `mdview — visor/editor de Markdown en el navegador con recarga en vivo

Uso:
  mdview [ARCHIVO.md | CARPETA] [opciones]

  Con un archivo, abre ese archivo y usa su carpeta como raíz.
  Con una carpeta (por defecto "."), lista todos los .md que contiene.
  Si el archivo no existe, se crea al guardar por primera vez.

Opciones:
  -p, --port N     Puerto (por defecto 4747; si está ocupado prueba los siguientes)
      --host H     Interfaz donde escuchar (por defecto 127.0.0.1)
  -n, --no-open    No abrir el navegador
  -h, --help       Muestra esta ayuda
`;

function parseArgs(argv) {
  const opts = { target: '.', port: 4747, host: '127.0.0.1', open: true };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '-h' || a === '--help') {
      process.stdout.write(HELP);
      process.exit(0);
    } else if (a === '-p' || a === '--port') {
      opts.port = Number(argv[++i]);
    } else if (a === '--host') {
      opts.host = argv[++i];
    } else if (a === '-n' || a === '--no-open') {
      opts.open = false;
    } else if (a.startsWith('-')) {
      console.error(`Opción desconocida: ${a}\n\n${HELP}`);
      process.exit(2);
    } else {
      opts.target = a;
    }
  }
  if (!Number.isInteger(opts.port) || opts.port < 0 || opts.port > 65535) {
    console.error('Puerto inválido');
    process.exit(2);
  }
  return opts;
}

function listen(server, port, host, attempts = 20) {
  return new Promise((resolve, reject) => {
    const tryPort = (p, left) => {
      const onError = (err) => {
        server.off('listening', onListening);
        if (err.code === 'EADDRINUSE' && left > 0 && port !== 0) tryPort(p + 1, left - 1);
        else reject(err);
      };
      const onListening = () => {
        server.off('error', onError);
        resolve(server.address().port);
      };
      server.once('error', onError);
      server.once('listening', onListening);
      server.listen(p, host);
    };
    tryPort(port, attempts);
  });
}

function openBrowser(url) {
  const cmd = process.platform === 'darwin' ? 'open'
    : process.platform === 'win32' ? 'explorer.exe' : 'xdg-open';
  try {
    spawn(cmd, [url], { detached: true, stdio: 'ignore' }).unref();
  } catch {}
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  const target = path.resolve(opts.target);

  let root;
  let initial = null;
  let stat = null;
  try {
    stat = fs.statSync(target);
  } catch {}

  if (stat && stat.isDirectory()) {
    root = target;
    const readme = fs.readdirSync(root).find((f) => /^readme\.md$/i.test(f));
    if (readme) initial = readme;
  } else if (stat || isMarkdown(target)) {
    if (!isMarkdown(target)) {
      console.error(`No parece un archivo Markdown: ${target}`);
      process.exit(2);
    }
    root = path.dirname(target);
    initial = path.basename(target);
    if (!fs.existsSync(root)) {
      console.error(`No existe la carpeta: ${root}`);
      process.exit(2);
    }
  } else {
    console.error(`No existe: ${target}`);
    process.exit(2);
  }

  const loopback = ['127.0.0.1', 'localhost', '::1'].includes(opts.host);
  const allowedHosts = loopback ? new Set() : null;
  const app = createServer({ root, allowedHosts });
  await app.start();

  const port = await listen(app.server, opts.port, opts.host);
  if (allowedHosts) {
    for (const h of ['127.0.0.1', 'localhost', '[::1]']) allowedHosts.add(`${h}:${port}`);
  }

  const hostForUrl = opts.host === '::1' ? '[::1]' : opts.host === '0.0.0.0' ? '127.0.0.1' : opts.host;
  const url = `http://${hostForUrl}:${port}/` + (initial ? `?file=${encodeURIComponent(initial)}` : '');
  console.log(`mdview sirviendo ${root}`);
  console.log(`  → ${url}`);
  console.log('Ctrl+C para salir.');
  if (opts.open) openBrowser(url);

  const shutdown = () => {
    app.close();
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main().catch((err) => {
  console.error(err.message || err);
  process.exit(1);
});
