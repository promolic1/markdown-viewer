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
//   assetUrl(rel)           →  URL for a local image/attachment, or null if not
//                              (yet) available; call onAsset() once it is

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
  }

  setActive(rel) {
    this.active = rel;
  }

  assetUrl(rel) {
    return 'files/' + encodePath(rel);
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
}

window.MdSources = { SourceConflict, ServerSource, NullSource, encodePath };
