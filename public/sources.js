'use strict';

// A "source" is where markdown files come from. The app talks only to this
// interface, so the same UI works against the local mdview server, the
// browser's File System Access API, or nothing at all (scratch only).
//
//   kind                       'server' | 'fs' | 'none'
//   info()                  →  { key, display, name, files } | null
//   read(rel)               →  { content: string|null (null = missing), hash }
//   write(rel, content, { baseHash, force })
//                           →  { hash }; throws SourceConflict if the file on
//                              disk is no longer the version `baseHash` names
//   watch({ tree, file, status })
//                              tree(files) · file({ path, content, hash, deleted })
//                              · status(online, message)
//   setActive(rel)             the file the user is looking at
//   assetUrl(rel, { load })  →  URL for a local image/attachment, or null if not
//                              (yet) available; with load (default) the source
//                              fetches it and calls onAsset() when ready
//   assetBlob(rel)          →  the local file's bytes as a Blob, or null
//   close()                    stop watching

class SourceConflict extends Error {
  constructor(content, hash) {
    super('El archivo cambió en disco');
    this.content = content;
    this.hash = hash;
  }
}

const encodePath = (rel) => rel.split('/').map(encodeURIComponent).join('/');

// --- Local mdview server ---------------------------------------------------

class ServerSource {
  constructor(info) {
    this.kind = 'server';
    this._info = info;
  }

  // Resolves to a ServerSource if the page is being served by `mdview`.
  static async detect() {
    try {
      const res = await fetch('api/info', { cache: 'no-store' });
      if (!res.ok || !(res.headers.get('content-type') || '').includes('json')) return null;
      const info = await res.json();
      return info && info.mdview ? new ServerSource(info) : null;
    } catch {
      return null;
    }
  }

  info() {
    const i = this._info;
    return { key: 'server:' + i.root, display: i.display, title: i.root, name: i.name, files: i.files };
  }

  async read(rel) {
    const res = await fetch('api/file?path=' + encodeURIComponent(rel));
    if (res.status === 404) return { content: null, hash: null };
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || res.statusText);
    return data;
  }

  async write(rel, content, { baseHash, force }) {
    const res = await fetch('api/file?path=' + encodeURIComponent(rel), {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ content, baseHash, force }),
    });
    const data = await res.json();
    if (res.status === 409) throw new SourceConflict(data.content, data.hash);
    if (!res.ok) throw new Error(data.error || res.statusText);
    return data;
  }

  watch({ tree, file, status }) {
    const es = new EventSource('api/events');
    let lost = false;
    es.onopen = () => {
      status(true, 'Conectado: los cambios en disco se aplican al instante');
      // Changes may have happened while we were disconnected.
      if (lost && this.active) {
        this.read(this.active)
          .then((d) => file({ path: this.active, content: d.content, hash: d.hash }))
          .catch(() => {});
      }
      lost = false;
    };
    es.onerror = () => {
      lost = true;
      status(false, 'Sin conexión con mdview (¿se cerró el servidor?). Reintentando…');
    };
    es.addEventListener('tree', (e) => tree(JSON.parse(e.data).files));
    es.addEventListener('file', (e) => file(JSON.parse(e.data)));
    this.es = es;
  }

  close() {
    if (this.es) this.es.close();
  }

  setActive(rel) {
    this.active = rel;
  }

  assetUrl(rel) {
    return 'files/' + encodePath(rel);
  }

  async assetBlob(rel) {
    const res = await fetch(this.assetUrl(rel));
    return res.ok ? res.blob() : null;
  }
}

// --- No files: scratch buffer only -------------------------------------------

class NullSource {
  constructor() {
    this.kind = 'none';
  }

  info() {
    return null;
  }

  read() {
    throw new Error('No hay archivos abiertos');
  }

  write() {
    throw new Error('No hay archivos abiertos');
  }

  watch({ status }) {
    status(null, 'Sin archivos locales: solo el borrador del navegador');
  }

  setActive() {}

  assetUrl() {
    return null;
  }

  async assetBlob() {
    return null;
  }

  close() {}
}

// --- Browser File System Access API (Chrome, Edge…) ---------------------------
// No server involved: the page reads and writes the user's files directly
// through handles they granted. There is no change notification we can rely
// on, so we poll the open file's lastModified (cheap: it's a stat).

const MD_RE = /\.(md|markdown|mdown|mkd|mkdn|mdx)$/i;
const IGNORED_DIRS = new Set(['node_modules', '__pycache__', 'venv', 'dist', 'build', 'target', 'vendor']);
const MAX_DIRS = 3000;
const FILE_POLL_MS = 500;
const TREE_POLL_MS = 4000;

// Minimal IndexedDB key/value store; FileSystemHandles are structured-cloneable.
const idb = {
  _db: null,
  open() {
    this._db ??= new Promise((resolve, reject) => {
      const req = indexedDB.open('mdview', 1);
      req.onupgradeneeded = () => req.result.createObjectStore('kv');
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
    return this._db;
  },
  async run(mode, fn) {
    const db = await this.open();
    return new Promise((resolve, reject) => {
      const req = fn(db.transaction('kv', mode).objectStore('kv'));
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  },
  get: (key) => idb.run('readonly', (s) => s.get(key)),
  set: (key, value) => idb.run('readwrite', (s) => s.put(value, key)),
};

async function sha1(buf) {
  const digest = await crypto.subtle.digest('SHA-1', buf);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

const isNotFound = (err) => err && (err.name === 'NotFoundError' || err.name === 'TypeMismatchError');

class FsSource {
  static supported() {
    return window.isSecureContext && 'showDirectoryPicker' in window && 'showOpenFilePicker' in window;
  }

  static pickDirectory() {
    return window.showDirectoryPicker({ id: 'mdview', mode: 'readwrite' });
  }

  static async pickFile() {
    const [handle] = await window.showOpenFilePicker({
      id: 'mdview',
      types: [{
        description: 'Markdown',
        accept: { 'text/markdown': ['.md', '.markdown', '.mdown', '.mkd', '.mkdn', '.mdx'] },
      }],
    });
    return handle;
  }

  // 'granted' | 'prompt' | 'denied'. Prompting needs a user gesture.
  static async permission(handle, prompt) {
    const rw = { mode: 'readwrite' };
    const state = await handle.queryPermission(rw);
    if (state === 'granted') return state;
    if (prompt) return handle.requestPermission(rw);
    // Read access alone (e.g. a dropped folder) is enough to open it;
    // createWritable() asks for write access on the first save.
    return (await handle.queryPermission({ mode: 'read' })) === 'granted' ? 'granted' : state;
  }

  // Recently opened folders/files, newest first.
  static async recentRoots() {
    try {
      return (await idb.get('roots')) || [];
    } catch {
      return [];
    }
  }

  static async remember(handle) {
    try {
      const roots = await FsSource.recentRoots();
      const kept = [];
      for (const h of roots) {
        if (h.kind !== handle.kind || !(await h.isSameEntry(handle))) kept.push(h);
      }
      await idb.set('roots', [handle, ...kept].slice(0, 8));
    } catch {}
  }

  constructor(root) {
    this.kind = 'fs';
    this.root = root;
    this.isDir = root.kind === 'directory';
    this.files = [];
    this.known = new Map(); // rel → { lastModified, size, hash } of what we last saw
    this.assets = new Map(); // rel → { url, lastModified, size } | { pending } | { missing }
    this.onAsset = () => {};
    this.active = null;
    this.timers = [];
    this.listeners = [];
    this.lock = Promise.resolve();
    this.misses = 0;
  }

  // Run fn with exclusive access, so a poll never interleaves with a save
  // (a poll that read the old file could otherwise "revert" the editor).
  exclusive(fn) {
    const run = this.lock.then(fn, fn);
    this.lock = run.catch(() => {});
    return run;
  }

  async init() {
    await this.scan();
    await FsSource.remember(this.root);
    return this;
  }

  info() {
    return {
      key: 'fs:' + this.root.name + (this.isDir ? '/' : ''),
      display: this.isDir ? `${this.root.name}/ · carpeta local` : `${this.root.name} · archivo local`,
      title: 'Abierto directamente desde el navegador (File System Access API)',
      name: this.root.name,
      files: this.files,
    };
  }

  async scan() {
    if (!this.isDir) {
      this.files = [this.root.name];
      return this.files;
    }
    const found = [];
    let dirs = 0;
    const walk = async (dir, prefix) => {
      if (++dirs > MAX_DIRS) return;
      const subdirs = [];
      for await (const [name, handle] of dir.entries()) {
        if (handle.kind === 'directory') {
          if (!name.startsWith('.') && !IGNORED_DIRS.has(name)) subdirs.push(walk(handle, prefix + name + '/'));
        } else if (MD_RE.test(name)) {
          found.push(prefix + name);
        }
      }
      await Promise.all(subdirs);
    };
    await walk(this.root, '');
    this.files = found.sort((a, b) => a.localeCompare(b));
    return this.files;
  }

  async fileHandle(rel, create = false) {
    if (!this.isDir) {
      if (rel !== this.root.name) throw new DOMException('Fuera del archivo abierto', 'NotFoundError');
      return this.root;
    }
    const parts = rel.split('/');
    let dir = this.root;
    for (const part of parts.slice(0, -1)) {
      if (!part || part === '.' || part === '..') throw new DOMException('Ruta inválida', 'NotFoundError');
      dir = await dir.getDirectoryHandle(part, { create });
    }
    return dir.getFileHandle(parts[parts.length - 1], { create });
  }

  async _read(rel) {
    let file;
    try {
      file = await (await this.fileHandle(rel)).getFile();
    } catch (err) {
      if (!isNotFound(err)) throw err;
      this.known.delete(rel);
      return { content: null, hash: null, file: null };
    }
    const buf = await file.arrayBuffer();
    const hash = await sha1(buf);
    this.known.set(rel, { lastModified: file.lastModified, size: file.size, hash });
    return { content: new TextDecoder().decode(buf), hash, file };
  }

  read(rel) {
    return this.exclusive(async () => {
      const { content, hash } = await this._read(rel);
      return { content, hash };
    });
  }

  write(rel, content, { baseHash, force }) {
    return this.exclusive(async () => {
      const current = await this._read(rel);
      if (!force && current.hash !== (baseHash ?? null)) {
        throw new SourceConflict(current.content, current.hash);
      }
      const handle = await this.fileHandle(rel, true);
      const writable = await handle.createWritable();
      await writable.write(content);
      await writable.close();
      const file = await handle.getFile();
      const hash = await sha1(new TextEncoder().encode(content));
      this.known.set(rel, { lastModified: file.lastModified, size: file.size, hash });
      if (!this.files.includes(rel)) {
        this.files = [...this.files, rel].sort((a, b) => a.localeCompare(b));
        this.cb && this.cb.tree(this.files);
      }
      return { hash };
    });
  }

  watch(cb) {
    this.cb = cb;
    cb.status(true, 'Vigilando cambios en disco (el navegador revisa el archivo cada medio segundo)');
    const loop = (fn, ms) => {
      const tick = async () => {
        try {
          await fn();
        } catch {}
        this.timers.push(setTimeout(tick, ms));
      };
      this.timers.push(setTimeout(tick, ms));
    };
    loop(() => this.pollFile(), FILE_POLL_MS);
    loop(() => this.pollTree(), TREE_POLL_MS);
    // Background tabs get throttled timers: catch up as soon as we're back.
    const wake = () => {
      if (document.visibilityState === 'visible') this.pollFile().catch(() => {});
    };
    document.addEventListener('visibilitychange', wake);
    window.addEventListener('focus', wake);
    this.listeners.push(() => document.removeEventListener('visibilitychange', wake));
    this.listeners.push(() => window.removeEventListener('focus', wake));
  }

  pollFile() {
    const rel = this.active;
    if (!rel || !this.cb) return Promise.resolve();
    return this.exclusive(async () => {
      if (rel !== this.active) return;
      let file;
      try {
        file = await (await this.fileHandle(rel)).getFile();
      } catch (err) {
        if (err && err.name === 'NotAllowedError') {
          this.cb.status(false, 'El navegador retiró el permiso sobre la carpeta. Vuelve a abrirla.');
          return;
        }
        if (!isNotFound(err) || !this.known.has(rel)) return;
        // Editors that save by delete+create leave a brief gap: insist once.
        if (++this.misses < 2) return;
        this.misses = 0;
        this.known.delete(rel);
        this.cb.file({ path: rel, deleted: true });
        return;
      }
      this.misses = 0;
      const seen = this.known.get(rel);
      if (seen && seen.lastModified === file.lastModified && seen.size === file.size) return;
      const buf = await file.arrayBuffer();
      const hash = await sha1(buf);
      this.known.set(rel, { lastModified: file.lastModified, size: file.size, hash });
      if (seen && seen.hash === hash) return;
      this.cb.file({ path: rel, content: new TextDecoder().decode(buf), hash });
    });
  }

  async pollTree() {
    if (document.visibilityState !== 'visible') return;
    if (this.isDir) {
      const before = this.files.join('\n');
      await this.scan();
      if (this.files.join('\n') !== before) this.cb.tree(this.files);
    }
    // Images that changed on disk, or that were missing and now exist.
    let changed = false;
    for (const [rel, asset] of this.assets) {
      if (asset.pending) continue;
      try {
        const file = await (await this.fileHandle(rel)).getFile();
        if (asset.missing || file.lastModified !== asset.lastModified || file.size !== asset.size) {
          if (asset.url) URL.revokeObjectURL(asset.url);
          this.assets.set(rel, { url: URL.createObjectURL(file), lastModified: file.lastModified, size: file.size });
          changed = true;
        }
      } catch {
        if (!asset.missing) {
          this.assets.set(rel, { missing: true });
          changed = true;
        }
      }
    }
    if (changed) this.onAsset();
  }

  setActive(rel) {
    this.active = rel;
    this.misses = 0;
  }

  assetUrl(rel, { load = true } = {}) {
    const asset = this.assets.get(rel);
    if (asset) return asset.url || null;
    if (load) this.loadAsset(rel);
    return null;
  }

  async assetBlob(rel) {
    try {
      return await (await this.fileHandle(rel)).getFile();
    } catch {
      return null;
    }
  }

  async loadAsset(rel) {
    const cached = this.assets.get(rel);
    if (cached && cached.url) return cached.url;
    this.assets.set(rel, { pending: true });
    try {
      const file = await (await this.fileHandle(rel)).getFile();
      const url = URL.createObjectURL(file);
      this.assets.set(rel, { url, lastModified: file.lastModified, size: file.size });
      this.onAsset();
      return url;
    } catch {
      this.assets.set(rel, { missing: true });
      return null;
    }
  }

  close() {
    for (const t of this.timers) clearTimeout(t);
    for (const off of this.listeners) off();
    for (const asset of this.assets.values()) if (asset.url) URL.revokeObjectURL(asset.url);
    this.timers = [];
    this.listeners = [];
    this.cb = null;
  }
}

window.MdSources = { SourceConflict, ServerSource, NullSource, FsSource, encodePath };
