'use strict';

const http = require('node:http');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const os = require('node:os');

const PUBLIC_DIR = path.join(__dirname, '..', 'public');
const NODE_MODULES = path.join(__dirname, '..', 'node_modules');

// Whitelisted browser builds served under /vendor/.
const VENDOR = {
  'markdown-it.js': 'markdown-it/dist/browser/markdown-it.umd.min.js',
  'markdown-it-footnote.js': 'markdown-it-footnote/dist/markdown-it-footnote.min.js',
  'purify.js': 'dompurify/dist/purify.min.js',
  'highlight.js': '@highlightjs/cdn-assets/highlight.min.js',
  'hljs-light.css': '@highlightjs/cdn-assets/styles/github.min.css',
  'hljs-dark.css': '@highlightjs/cdn-assets/styles/github-dark.min.css',
  'gh-light.css': 'github-markdown-css/github-markdown-light.css',
  'gh-dark.css': 'github-markdown-css/github-markdown-dark.css',
  'codemirror.js': 'codemirror/lib/codemirror.js',
  'codemirror.css': 'codemirror/lib/codemirror.css',
  'cm-overlay.js': 'codemirror/addon/mode/overlay.js',
  'cm-markdown.js': 'codemirror/mode/markdown/markdown.js',
  'cm-gfm.js': 'codemirror/mode/gfm/gfm.js',
  'cm-continuelist.js': 'codemirror/addon/edit/continuelist.js',
};

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.md': 'text/markdown; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.avif': 'image/avif',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.bmp': 'image/bmp',
  '.pdf': 'application/pdf',
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
  '.mp3': 'audio/mpeg',
  '.ogg': 'audio/ogg',
  '.wav': 'audio/wav',
};

const MD_EXT = new Set(['.md', '.markdown', '.mdown', '.mkd', '.mkdn', '.mdx']);
const IGNORED_DIRS = new Set([
  'node_modules', '__pycache__', 'venv', 'dist', 'build', 'target', 'vendor',
]);
const MAX_DIRS = 4000;

const isMarkdown = (p) => MD_EXT.has(path.extname(p).toLowerCase());
const isIgnoredDir = (name) => name.startsWith('.') || IGNORED_DIRS.has(name);
const hashOf = (buf) => crypto.createHash('sha1').update(buf).digest('hex');
const toPosix = (p) => p.split(path.sep).join('/');

function createServer({ root, allowedHosts }) {
  root = path.resolve(root);
  const clients = new Set();
  const dirWatchers = new Map(); // abs dir -> FSWatcher
  const known = new Map(); // rel md path -> last broadcast hash
  const pending = new Map(); // rel path -> timeout
  let treeTimer = null;
  let files = [];

  // Resolve a client-supplied relative path, refusing anything outside root.
  function resolveSafe(rel) {
    if (typeof rel !== 'string') return null;
    const abs = path.resolve(root, '.' + path.sep + rel);
    if (abs !== root && !abs.startsWith(root + path.sep)) return null;
    return abs;
  }

  function broadcast(event, data) {
    const msg = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
    for (const res of clients) res.write(msg);
  }

  // --- Watching -----------------------------------------------------------
  // fs.watch on directories (not files): editors like vim save by renaming,
  // which would silently orphan a watcher attached to the old inode.

  function watchDir(dir) {
    if (dirWatchers.has(dir) || dirWatchers.size >= MAX_DIRS) return;
    let w;
    try {
      w = fs.watch(dir, { persistent: true }, (type, name) => {
        if (!name) return scheduleTree();
        onFsEvent(path.join(dir, name.toString()));
      });
    } catch {
      return;
    }
    w.on('error', () => {
      w.close();
      dirWatchers.delete(dir);
    });
    dirWatchers.set(dir, w);
  }

  function onFsEvent(abs) {
    const rel = toPosix(path.relative(root, abs));
    if (isMarkdown(abs)) scheduleFile(rel, abs);
    // Anything may have been created/removed/renamed: new dirs, new md files.
    scheduleTree();
  }

  function scheduleFile(rel, abs, delay = 60, retry = true) {
    clearTimeout(pending.get(rel));
    pending.set(rel, setTimeout(async () => {
      pending.delete(rel);
      let buf;
      try {
        buf = await fsp.readFile(abs);
      } catch {
        // Editors that save by delete+create (e.g. vim's backup dance) leave
        // a brief gap; look again before announcing a deletion.
        if (retry) return scheduleFile(rel, abs, 250, false);
        if (known.has(rel)) {
          known.delete(rel);
          broadcast('file', { path: rel, deleted: true });
        }
        return;
      }
      const hash = hashOf(buf);
      if (known.get(rel) === hash) return;
      known.set(rel, hash);
      broadcast('file', { path: rel, hash, content: buf.toString('utf8') });
    }, delay));
  }

  function scheduleTree() {
    clearTimeout(treeTimer);
    treeTimer = setTimeout(async () => {
      const next = await scan();
      if (JSON.stringify(next) !== JSON.stringify(files)) {
        files = next;
        broadcast('tree', { files });
      }
    }, 250);
  }

  // Walk the tree, (re)attaching directory watchers and collecting md files.
  async function scan() {
    const found = [];
    const seenDirs = new Set();
    const queue = [root];
    while (queue.length && seenDirs.size < MAX_DIRS) {
      const dir = queue.shift();
      seenDirs.add(dir);
      watchDir(dir);
      let entries;
      try {
        entries = await fsp.readdir(dir, { withFileTypes: true });
      } catch {
        continue;
      }
      for (const e of entries) {
        const abs = path.join(dir, e.name);
        if (e.isDirectory()) {
          if (!isIgnoredDir(e.name)) queue.push(abs);
        } else if ((e.isFile() || e.isSymbolicLink()) && isMarkdown(e.name)) {
          found.push(toPosix(path.relative(root, abs)));
        }
      }
    }
    for (const [dir, w] of dirWatchers) {
      if (!seenDirs.has(dir)) {
        w.close();
        dirWatchers.delete(dir);
      }
    }
    return found.sort((a, b) => a.localeCompare(b));
  }

  // --- HTTP ---------------------------------------------------------------

  function send(res, status, body, type = 'application/json; charset=utf-8') {
    const data = typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body);
    res.writeHead(status, { 'Content-Type': type, 'Cache-Control': 'no-store' });
    res.end(data);
  }

  async function serveFile(res, abs, cache = 'no-cache') {
    let buf;
    try {
      buf = await fsp.readFile(abs);
    } catch {
      return send(res, 404, 'Not found', 'text/plain');
    }
    const type = MIME[path.extname(abs).toLowerCase()] || 'application/octet-stream';
    res.writeHead(200, { 'Content-Type': type, 'Cache-Control': cache });
    res.end(buf);
  }

  function readBody(req, limit = 50 * 1024 * 1024) {
    return new Promise((resolve, reject) => {
      const chunks = [];
      let size = 0;
      req.on('data', (c) => {
        size += c.length;
        if (size > limit) {
          reject(new Error('Body too large'));
          req.destroy();
        } else {
          chunks.push(c);
        }
      });
      req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
      req.on('error', reject);
    });
  }

  async function handleApiFile(req, res, url) {
    const rel = url.searchParams.get('path');
    const abs = resolveSafe(rel);
    if (!abs || !isMarkdown(abs)) return send(res, 400, { error: 'Ruta inválida' });

    if (req.method === 'GET') {
      let buf;
      try {
        buf = await fsp.readFile(abs);
      } catch {
        return send(res, 404, { error: 'No existe' });
      }
      const hash = hashOf(buf);
      known.set(rel, hash);
      return send(res, 200, { path: rel, content: buf.toString('utf8'), hash });
    }

    if (req.method === 'PUT') {
      let body;
      try {
        body = JSON.parse(await readBody(req));
      } catch {
        return send(res, 400, { error: 'JSON inválido' });
      }
      if (typeof body.content !== 'string') return send(res, 400, { error: 'Falta content' });

      let current = null;
      try {
        current = await fsp.readFile(abs);
      } catch {}
      const currentHash = current ? hashOf(current) : null;
      if (!body.force && currentHash !== (body.baseHash ?? null)) {
        return send(res, 409, {
          error: 'El archivo cambió en disco',
          hash: currentHash,
          content: current ? current.toString('utf8') : null,
        });
      }
      const buf = Buffer.from(body.content, 'utf8');
      await fsp.mkdir(path.dirname(abs), { recursive: true });
      // Write in place (not rename) so the inode, permissions and any other
      // program's watcher on this file survive.
      await fsp.writeFile(abs, buf);
      const hash = hashOf(buf);
      known.set(rel, hash);
      return send(res, 200, { path: rel, hash });
    }

    return send(res, 405, { error: 'Método no permitido' });
  }

  function handleEvents(req, res) {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-store',
      Connection: 'keep-alive',
    });
    res.write(`retry: 1000\nevent: tree\ndata: ${JSON.stringify({ files })}\n\n`);
    clients.add(res);
    const ping = setInterval(() => res.write(': ping\n\n'), 25000);
    req.on('close', () => {
      clearInterval(ping);
      clients.delete(res);
    });
  }

  const server = http.createServer(async (req, res) => {
    // Reject DNS-rebinding style requests: only answer to our own host names.
    if (allowedHosts && !allowedHosts.has(req.headers.host)) {
      return send(res, 403, 'Forbidden host', 'text/plain');
    }
    const url = new URL(req.url, 'http://localhost');
    const p = decodeURIComponent(url.pathname);
    try {
      if (p === '/' || p === '/index.html') return serveFile(res, path.join(PUBLIC_DIR, 'index.html'));
      if (p === '/api/info') {
        const home = os.homedir();
        const display = root === home || root.startsWith(home + path.sep) ? '~' + root.slice(home.length) : root;
        return send(res, 200, { mdview: true, root, display, name: path.basename(root) || root, files });
      }
      if (p === '/api/file') return await handleApiFile(req, res, url);
      if (p === '/api/events') return handleEvents(req, res);
      if (p.startsWith('/vendor/')) {
        const target = VENDOR[p.slice('/vendor/'.length)];
        if (!target) return send(res, 404, 'Not found', 'text/plain');
        return serveFile(res, path.join(NODE_MODULES, target), 'max-age=86400');
      }
      if (p.startsWith('/files/')) {
        const abs = resolveSafe(p.slice('/files/'.length));
        if (!abs) return send(res, 403, 'Forbidden', 'text/plain');
        return serveFile(res, abs);
      }
      if (p.startsWith('/static/')) {
        const abs = path.resolve(PUBLIC_DIR, '.' + p.slice('/static'.length));
        if (!abs.startsWith(PUBLIC_DIR + path.sep)) return send(res, 403, 'Forbidden', 'text/plain');
        return serveFile(res, abs);
      }
      send(res, 404, 'Not found', 'text/plain');
    } catch (err) {
      send(res, 500, { error: String(err && err.message || err) });
    }
  });

  async function start() {
    files = await scan();
  }

  function close() {
    for (const w of dirWatchers.values()) w.close();
    for (const res of clients) res.end();
    server.close();
  }

  return { server, start, close, root };
}

module.exports = { createServer, isMarkdown };
