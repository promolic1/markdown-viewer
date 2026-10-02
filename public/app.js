/* global CodeMirror, markdownit, markdownitFootnote, DOMPurify, hljs, MdSources */
'use strict';

(() => {
  const $ = (sel) => document.querySelector(sel);
  const $$ = (sel) => [...document.querySelectorAll(sel)];

  const store = {
    get(key, fallback) {
      try {
        const v = localStorage.getItem('mdview:' + key);
        return v === null ? fallback : JSON.parse(v);
      } catch {
        return fallback;
      }
    },
    set(key, value) {
      try {
        localStorage.setItem('mdview:' + key, JSON.stringify(value));
      } catch {}
    },
  };

  const MD_RE = /\.(md|markdown|mdown|mkd|mkdn|mdx)$/i;
  const escapeHtml = (s) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
  const basename = (p) => p.slice(p.lastIndexOf('/') + 1);
  const dirname = (p) => (p.includes('/') ? p.slice(0, p.lastIndexOf('/')) : '');
  const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

  // --- UI state (persisted per browser) ------------------------------------

  const prefersDark = matchMedia('(prefers-color-scheme: dark)').matches;
  const ui = {
    theme: store.get('theme', prefersDark ? 'dark' : 'light'),
    layout: store.get('layout', 'split'),
    width: store.get('width', 'full'),
    style: store.get('style', 'github'),
    split: store.get('split', 50),
    panel: store.get('panel', null),
    sync: store.get('sync', true),
    follow: store.get('follow', true),
    autosave: store.get('autosave', false),
  };

  // --- File state ----------------------------------------------------------

  const { SourceConflict, ServerSource, NullSource } = MdSources;

  const state = {
    source: new NullSource(),
    rootKey: '', // identifies the open folder, for per-folder recents
    rootName: '',
    files: [],
    path: null, // null → scratch buffer (lives in localStorage)
    diskHash: null, // hash of the version on disk we are based on
    diskContent: '', // that version's text; dirty = editor differs from it
    exists: true,
    banner: null,
  };

  const isDirty = () => state.path !== null && cm.getValue() !== state.diskContent;

  // --- DOM -----------------------------------------------------------------

  const panes = $('#panes');
  const preview = $('#preview');
  const previewScroll = $('#preview-scroll');
  const sidebar = $('#sidebar');
  const filter = $('#filter');
  const els = {
    filename: $('#filename'),
    dirty: $('#dirty'),
    flash: $('#flash'),
    stats: $('#stats'),
    save: $('#save-btn'),
    reset: $('#reset-btn'),
    copy: $('#copy-btn'),
    autosave: $('#autosave'),
    sync: $('#sync-scroll'),
    theme: $('#theme-btn'),
    live: $('#live-dot'),
    banner: $('#banner'),
    bannerText: $('#banner-text'),
    bannerActions: $('#banner-actions'),
    list: $('#sidebar-list'),
    sidebarTitle: $('#sidebar-title'),
    rootPath: $('#root-path'),
    brandSub: $('#brand-sub'),
  };

  // --- Markdown ------------------------------------------------------------

  function slugify(text) {
    return text
      .trim()
      .toLowerCase()
      .replace(/[^\p{L}\p{N}\s_-]/gu, '')
      .replace(/\s/g, '-');
  }

  // GFM task lists: "- [ ] foo" → checkbox. Clicking one edits the source.
  function taskLists(md) {
    md.core.ruler.push('task_lists', (state) => {
      const t = state.tokens;
      for (let i = 2; i < t.length; i++) {
        if (t[i].type !== 'inline' || t[i - 1].type !== 'paragraph_open' || t[i - 2].type !== 'list_item_open') continue;
        const m = /^\[([ xX])\][ \t]/.exec(t[i].content);
        const first = t[i].children && t[i].children[0];
        if (!m || !first || first.type !== 'text' || !first.content.startsWith(m[0])) continue;
        first.content = first.content.slice(m[0].length);
        const box = new state.Token('html_inline', '', 0);
        box.content = `<input type="checkbox" class="task-list-item-checkbox"${m[1] === ' ' ? '' : ' checked'}> `;
        t[i].children.unshift(box);
        t[i - 2].attrJoin('class', 'task-list-item');
        for (let j = i - 3; j >= 0; j--) {
          if (/^(bullet|ordered)_list_open$/.test(t[j].type) && t[j].level === t[i - 2].level - 1) {
            t[j].attrJoin('class', 'contains-task-list');
            break;
          }
        }
      }
    });
  }

  // Tag every block with its source line (for sync scroll and task toggling)
  // and give headings GitHub-style ids (for #anchor links).
  function sourceMeta(md) {
    md.core.ruler.push('source_meta', (state) => {
      const slugs = new Map();
      const t = state.tokens;
      for (let i = 0; i < t.length; i++) {
        const tok = t[i];
        if (tok.map && tok.block && tok.nesting !== -1) tok.attrSet('data-line', String(tok.map[0]));
        if (tok.type === 'heading_open' && t[i + 1] && t[i + 1].children) {
          const text = t[i + 1].children
            .filter((c) => c.type === 'text' || c.type === 'code_inline')
            .map((c) => c.content)
            .join('');
          let slug = slugify(text) || 'section';
          const n = slugs.get(slug) || 0;
          slugs.set(slug, n + 1);
          if (n) slug += '-' + n;
          tok.attrSet('id', slug);
        }
      }
    });
  }

  const md = markdownit({
    html: true,
    linkify: true,
    highlight(code, lang) {
      lang = (lang || '').trim().toLowerCase();
      if (lang && hljs.getLanguage(lang)) {
        try {
          return hljs.highlight(code, { language: lang, ignoreIllegals: true }).value;
        } catch {}
      }
      return '';
    },
  })
    .use(markdownitFootnote)
    .use(taskLists)
    .use(sourceMeta);

  const PURIFY = { ADD_ATTR: ['target'] };

  function renderMarkdown(src) {
    // YAML front matter: show it as a code block instead of a stray <hr> +
    // setext heading, keeping line numbers aligned for sync scroll.
    const fm = /^---[ \t]*\r?\n([\s\S]*?)\r?\n(?:---|\.\.\.)[ \t]*(?:\r?\n|$)/.exec(src);
    if (!fm) return md.render(src);
    const yaml = hljs.getLanguage('yaml')
      ? hljs.highlight(fm[1], { language: 'yaml', ignoreIllegals: true }).value
      : escapeHtml(fm[1]);
    const lines = fm[0].split('\n').length - 1;
    return `<pre class="front-matter" data-line="0"><code>${yaml}</code></pre>\n`
      + md.render('\n'.repeat(lines) + src.slice(fm[0].length));
  }

  // Resolve a relative link/image reference against the open file's folder.
  function localRef(ref) {
    if (!ref || /^[a-z][a-z0-9+.-]*:/i.test(ref) || ref.startsWith('//')) return null;
    const dir = state.path ? dirname(state.path) : '';
    const base = 'http://root/' + (dir ? dir.split('/').map(encodeURIComponent).join('/') + '/' : '');
    let url;
    let rel;
    try {
      url = new URL(ref, base);
      rel = decodeURIComponent(url.pathname.slice(1));
    } catch {
      return null;
    }
    return { rel, search: url.search, hash: url.hash, md: MD_RE.test(rel) ? rel : null };
  }

  function postProcess(root) {
    for (const img of root.querySelectorAll('img[src]')) {
      const r = localRef(img.getAttribute('src'));
      if (!r) continue;
      const url = state.source.assetUrl(r.rel);
      if (url) img.setAttribute('src', url + r.search);
      else img.removeAttribute('src');
    }
    for (const a of root.querySelectorAll('a[href]')) {
      const href = a.getAttribute('href');
      if (href.startsWith('#')) continue;
      const r = localRef(href);
      if (r && r.md) {
        a.setAttribute('href', '?file=' + encodeURIComponent(r.md) + r.hash);
        a.dataset.md = r.md;
        if (r.hash) a.dataset.hash = r.hash;
      } else {
        const url = r && state.source.assetUrl(r.rel);
        if (url) a.setAttribute('href', url + r.search + r.hash);
        else if (r) a.dataset.asset = r.rel;
        a.target = '_blank';
        a.rel = 'noopener noreferrer';
      }
    }
  }

  // --- Preview patching ----------------------------------------------------
  // Replace only the top-level blocks that changed. Unchanged blocks keep their
  // DOM (so images don't reload and the scroll doesn't jump), and we learn
  // exactly which blocks changed so we can highlight them.

  const sigCache = new WeakMap();
  function sig(node) {
    let s = sigCache.get(node);
    if (s === undefined) {
      s = node.nodeType === 1 ? node.outerHTML.replace(/ data-line="\d+"/g, '')
        : node.nodeType === 3 ? '#' + node.data : '#' + node.nodeType;
      sigCache.set(node, s);
    }
    return s;
  }

  function copyLines(from, to) {
    if (to.nodeType !== 1) return;
    const src = [from, ...from.querySelectorAll('[data-line]')].filter((n) => n.hasAttribute('data-line'));
    const dst = [to, ...to.querySelectorAll('[data-line]')].filter((n) => n.hasAttribute('data-line'));
    for (let i = 0; i < dst.length && i < src.length; i++) {
      const v = src[i].getAttribute('data-line');
      if (dst[i].getAttribute('data-line') !== v) dst[i].setAttribute('data-line', v);
    }
  }

  function patchPreview(html) {
    const tpl = document.createElement('template');
    tpl.innerHTML = html;
    postProcess(tpl.content);
    const next = [...tpl.content.childNodes];
    const prev = [...preview.childNodes];

    let start = 0;
    while (start < next.length && start < prev.length && sig(prev[start]) === sig(next[start])) start++;
    let endP = prev.length;
    let endN = next.length;
    while (endP > start && endN > start && sig(prev[endP - 1]) === sig(next[endN - 1])) {
      endP--;
      endN--;
    }
    // Blocks after the edit keep their DOM but may have shifted lines.
    for (let i = endP, j = endN; i < prev.length; i++, j++) copyLines(next[j], prev[i]);

    const anchor = prev[endP] || null;
    for (let i = start; i < endP; i++) prev[i].remove();
    const inserted = next.slice(start, endN);
    for (const n of inserted) {
      sig(n);
      preview.insertBefore(n, anchor);
    }
    return inserted.filter((n) => n.nodeType === 1);
  }

  let renderTimer = 0;
  let highlightNext = false;

  function scheduleRender(fromDisk) {
    if (fromDisk) highlightNext = true;
    clearTimeout(renderTimer);
    renderTimer = setTimeout(render, cm.lineCount() > 4000 ? 150 : 16);
  }

  function render() {
    clearTimeout(renderTimer);
    const src = cm.getValue();
    let html;
    try {
      html = DOMPurify.sanitize(renderMarkdown(src), PURIFY);
    } catch (err) {
      html = `<pre>${escapeHtml(String(err && err.stack || err))}</pre>`;
    }
    const changed = patchPreview(html);
    lineMapDirty = true;
    updateStats(src);

    const highlight = highlightNext;
    highlightNext = false;
    if (highlight && changed.length) {
      for (const el of changed) el.classList.add('just-changed');
      if (ui.follow) reveal(changed[0]);
    } else if (ui.sync && ui.layout === 'split') {
      editorToPreview();
    }
  }

  preview.addEventListener('animationend', (e) => e.target.classList.remove('just-changed'));
  preview.addEventListener('load', () => (lineMapDirty = true), true);

  function reveal(el) {
    const r = el.getBoundingClientRect();
    const c = previewScroll.getBoundingClientRect();
    if (r.top >= c.top && r.top <= c.bottom - 60) return;
    previewScroll.scrollTop += r.top - c.top - c.height / 3;
  }

  function updateStats(src) {
    const words = (src.match(/[\p{L}\p{N}]+(?:['’-][\p{L}\p{N}]+)*/gu) || []).length;
    els.stats.textContent = words
      ? `${words.toLocaleString()} palabras · ${Math.max(1, Math.round(words / 220))} min`
      : '';
  }

  // --- Sync scroll -----------------------------------------------------------

  let lineMap = [];
  let lineMapDirty = true;

  function buildLineMap() {
    const base = previewScroll.getBoundingClientRect().top - previewScroll.scrollTop;
    const map = [{ line: 0, top: 0 }];
    for (const el of preview.querySelectorAll('[data-line]')) {
      if (!el.offsetParent) continue;
      const line = +el.dataset.line;
      const top = el.getBoundingClientRect().top - base;
      const last = map[map.length - 1];
      if (line <= last.line || top <= last.top) continue;
      map.push({ line, top });
    }
    const end = preview.getBoundingClientRect().bottom - base
      - parseFloat(getComputedStyle(preview).paddingBottom);
    const last = map[map.length - 1];
    if (cm.lineCount() > last.line && end > last.top) map.push({ line: cm.lineCount(), top: end });
    lineMap = map;
    lineMapDirty = false;
  }

  function interpolate(from, to, value) {
    if (lineMapDirty) buildLineMap();
    const m = lineMap;
    let i = 0;
    while (i < m.length - 1 && m[i + 1][from] <= value) i++;
    const a = m[i];
    const b = m[i + 1];
    if (!b) return a[to];
    return a[to] + ((value - a[from]) / (b[from] - a[from])) * (b[to] - a[to]);
  }

  let ignorePreviewScroll = false;
  let ignoreEditorScroll = false;

  function editorToPreview() {
    const info = cm.getScrollInfo();
    const line = cm.lineAtHeight(info.top, 'local');
    const top = cm.heightAtLine(line, 'local');
    const height = cm.getLineHandle(line).height || 1;
    const pos = line + clamp((info.top - top) / height, 0, 1);
    const before = previewScroll.scrollTop;
    previewScroll.scrollTop = interpolate('line', 'top', pos);
    if (previewScroll.scrollTop !== before) ignorePreviewScroll = true;
  }

  function previewToEditor() {
    const pos = interpolate('top', 'line', previewScroll.scrollTop);
    const line = clamp(Math.floor(pos), 0, cm.lineCount() - 1);
    const height = cm.getLineHandle(line).height;
    const before = cm.getScrollInfo().top;
    cm.scrollTo(null, cm.heightAtLine(line, 'local') + (pos - line) * height);
    if (cm.getScrollInfo().top !== before) ignoreEditorScroll = true;
  }

  // --- Editor --------------------------------------------------------------

  const cm = CodeMirror($('#editor-host'), {
    mode: { name: 'gfm', highlightFormatting: true, fencedCodeBlockHighlighting: false },
    lineNumbers: true,
    lineWrapping: true,
    indentUnit: 2,
    tabSize: 4,
    spellcheck: false,
    autofocus: false,
    viewportMargin: 30,
    extraKeys: {
      Enter: 'newlineAndIndentContinueMarkdownList',
      Tab: (c) => (c.somethingSelected() ? c.indentSelection('add') : c.replaceSelection('  ')),
      'Shift-Tab': 'indentLess',
    },
  });

  let scratchTimer = 0;
  let autosaveTimer = 0;

  cm.on('change', (_, change) => {
    scheduleRender(change.origin === '+disk');
    if (state.path === null) {
      clearTimeout(scratchTimer);
      scratchTimer = setTimeout(() => store.set('scratch', cm.getValue()), 300);
    } else if (ui.autosave && change.origin !== '+disk' && change.origin !== 'setValue') {
      clearTimeout(autosaveTimer);
      autosaveTimer = setTimeout(() => save(), 700);
    }
    updateDirty();
  });

  cm.on('scroll', () => {
    if (ignoreEditorScroll) {
      ignoreEditorScroll = false;
      return;
    }
    if (ui.sync && ui.layout === 'split') editorToPreview();
  });

  previewScroll.addEventListener('scroll', () => {
    if (ignorePreviewScroll) {
      ignorePreviewScroll = false;
      return;
    }
    if (ui.sync && ui.layout === 'split') previewToEditor();
  }, { passive: true });

  new ResizeObserver(() => cm.refresh()).observe($('#editor-host'));
  new ResizeObserver(() => (lineMapDirty = true)).observe(preview);

  // Replace only the differing middle of the document, so the cursor, scroll
  // position and undo history survive an update coming from disk.
  function replaceFromDisk(text) {
    const old = cm.getValue();
    if (old === text) return;
    const min = Math.min(old.length, text.length);
    let s = 0;
    while (s < min && old.charCodeAt(s) === text.charCodeAt(s)) s++;
    let e = 0;
    while (e < min - s && old.charCodeAt(old.length - 1 - e) === text.charCodeAt(text.length - 1 - e)) e++;
    cm.replaceRange(text.slice(s, text.length - e), cm.posFromIndex(s), cm.posFromIndex(old.length - e), '+disk');
  }

  // --- Chrome: title, buttons, banner --------------------------------------

  function updateDirty() {
    const dirty = isDirty();
    els.dirty.hidden = !dirty;
    els.save.disabled = state.path === null || (!dirty && state.exists);
    const name = state.path ? basename(state.path) : 'Borrador';
    document.title = `${dirty ? '● ' : ''}${name} — Markdown Viewer`;
  }

  function updateChrome() {
    const scratch = state.path === null;
    els.filename.textContent = scratch ? 'borrador' : state.path + (state.exists ? '' : ' (nuevo)');
    els.filename.title = scratch ? 'Guardado en el navegador' : state.path;
    els.reset.textContent = scratch ? 'Reset' : 'Recargar';
    els.reset.title = scratch ? 'Restaurar el texto de bienvenida' : 'Volver a leer el archivo del disco';
    els.save.hidden = scratch;
    els.autosave.parentElement.hidden = scratch;
    $('#scratch-btn').classList.toggle('active', scratch);
    const url = new URL(location.href);
    if (scratch) url.searchParams.delete('file');
    else url.searchParams.set('file', state.path);
    history.replaceState(null, '', url);
    updateDirty();
    renderSidebar();
  }

  let flashTimer = 0;
  function flash(msg) {
    els.flash.textContent = msg;
    els.flash.classList.add('show');
    clearTimeout(flashTimer);
    flashTimer = setTimeout(() => els.flash.classList.remove('show'), 1400);
  }

  function showBanner(kind, text, actions = [], error = false) {
    state.banner = kind;
    els.bannerText.textContent = text;
    els.bannerActions.replaceChildren(...actions.map(([label, fn]) => {
      const b = document.createElement('button');
      b.className = 'tool';
      b.textContent = label;
      b.onclick = fn;
      return b;
    }));
    els.banner.classList.toggle('error', error);
    els.banner.hidden = false;
  }

  function hideBanner(kind) {
    if (kind && state.banner !== kind) return;
    state.banner = null;
    els.banner.hidden = true;
  }

  // --- Files ---------------------------------------------------------------

  async function fetchFile(rel) {
    return { path: rel, ...(await state.source.read(rel)) };
  }

  async function confirmLeave() {
    if (!isDirty()) return true;
    if (ui.autosave) {
      await save();
      if (!isDirty()) return true;
    }
    return confirm(`«${state.path}» tiene cambios sin guardar. ¿Descartarlos?`);
  }

  function load(path, content, hash) {
    state.path = path;
    state.exists = content !== null;
    state.diskContent = content ?? '';
    state.diskHash = hash;
    state.source.setActive(path);
    hideBanner('conflict');
    hideBanner('deleted');
    els.flash.classList.remove('show');
    els.flash.textContent = '';
    preview.textContent = '';
    cm.setValue(state.diskContent);
    cm.clearHistory();
    cm.scrollTo(0, 0);
    previewScroll.scrollTop = 0;
    render();
    updateChrome();
  }

  async function openFile(rel, hash) {
    if (rel !== state.path && !(await confirmLeave())) return;
    let data;
    try {
      data = await fetchFile(rel);
    } catch (err) {
      showBanner('error', `No se pudo abrir ${rel}: ${err.message}`, [['Cerrar', () => hideBanner()]], true);
      return;
    }
    if (rel !== state.path) {
      load(rel, data.content, data.hash);
      pushRecent(rel);
    }
    if (hash) scrollToAnchor(hash);
  }

  async function openScratch() {
    if (state.path === null || !(await confirmLeave())) return;
    load(null, store.get('scratch', null) ?? (await welcome()), null);
  }

  async function welcome() {
    try {
      return await (await fetch('static/welcome.md')).text();
    } catch {
      return '# Borrador\n';
    }
  }

  // Server says the file on disk is now (content, hash). Decide what to do.
  function onDisk({ path, content, hash, deleted }) {
    if (path !== state.path) return;
    if (deleted || content === null) {
      if (!state.exists) return;
      state.exists = false;
      state.diskHash = null;
      state.diskContent = '';
      updateChrome();
      showBanner('deleted', `«${path}» se eliminó del disco. Su contenido sigue aquí.`, [
        ['Volver a crearlo', () => save({ force: true })],
      ]);
      return;
    }
    if (hash === state.diskHash) return;
    const wasMissing = !state.exists;
    hideBanner('deleted');
    if (content === cm.getValue() || !isDirty()) {
      state.diskHash = hash;
      state.diskContent = content;
      state.exists = true;
      replaceFromDisk(content);
      if (wasMissing) updateChrome();
      hideBanner('conflict');
      flash('actualizado desde disco');
      updateDirty();
    } else {
      conflict(content, hash);
    }
  }

  function conflict(content, hash) {
    showBanner('conflict', `«${basename(state.path)}» cambió en disco y aquí tienes cambios sin guardar.`, [
      ['Cargar la del disco', () => {
        state.diskHash = hash;
        state.diskContent = content ?? '';
        state.exists = content !== null;
        highlightNext = true;
        replaceFromDisk(state.diskContent);
        hideBanner();
        updateChrome();
      }],
      ['Conservar la mía', () => {
        // Rebase onto the disk version: the next save overwrites it.
        state.diskHash = hash;
        state.diskContent = content ?? '';
        state.exists = content !== null;
        hideBanner();
        if (ui.autosave) save();
        else flash('Ctrl+S para sobrescribir');
        updateChrome();
      }],
    ]);
  }

  let saving = null;
  async function save({ force = false } = {}) {
    if (state.path === null) return;
    clearTimeout(autosaveTimer);
    while (saving) await saving;
    const content = cm.getValue();
    if (!force && state.exists && content === state.diskContent) return;
    const path = state.path;
    saving = (async () => {
      let data;
      try {
        data = await state.source.write(path, content, { baseHash: state.exists ? state.diskHash : null, force });
      } catch (err) {
        if (!(err instanceof SourceConflict)) throw err;
        if (path !== state.path) return;
        if (err.content === content) {
          state.exists = true;
          state.diskHash = err.hash;
          state.diskContent = content;
        } else {
          conflict(err.content, err.hash);
        }
        return;
      }
      if (path !== state.path) return;
      const wasMissing = !state.exists;
      state.diskHash = data.hash;
      state.diskContent = content;
      state.exists = true;
      hideBanner('deleted');
      hideBanner('conflict');
      if (wasMissing) updateChrome();
      flash('guardado');
    })()
      .catch((err) => showBanner('error', `Error al guardar: ${err.message}`, [['Reintentar', () => save()]], true))
      .finally(() => {
        saving = null;
        updateDirty();
      });
    return saving;
  }

  // --- Live connection -----------------------------------------------------

  function connect() {
    state.source.watch({
      tree(files) {
        state.files = files;
        renderSidebar();
      },
      file: onDisk,
      status(online, message) {
        els.live.className = 'live-dot' + (online === true ? ' on' : online === false ? ' off' : '');
        els.live.title = message;
      },
    });
  }

  // --- Sidebar -------------------------------------------------------------

  const recentKey = () => 'recent:' + state.rootKey;
  let kbdIndex = 0;
  let visible = [];

  function pushRecent(rel) {
    const list = store.get(recentKey(), []).filter((p) => p !== rel);
    list.unshift(rel);
    store.set(recentKey(), list.slice(0, 20));
  }

  function renderSidebar() {
    const panel = ui.panel;
    sidebar.hidden = !panel;
    for (const b of $$('.rail-btn[data-panel]')) b.classList.toggle('active', b.dataset.panel === panel);
    if (!panel) return;

    const q = filter.value.trim().toLowerCase().split(/\s+/).filter(Boolean);
    let list = panel === 'files' ? state.files : store.get(recentKey(), []);
    if (q.length) list = list.filter((p) => q.every((term) => p.toLowerCase().includes(term)));
    visible = list;
    kbdIndex = clamp(kbdIndex, 0, Math.max(0, list.length - 1));
    els.sidebarTitle.textContent = panel === 'files' ? `Archivos (${state.files.length})` : 'Recientes';

    const frag = document.createDocumentFragment();
    const grouped = panel === 'files' && !q.length;
    let lastDir = null;
    list.forEach((p, i) => {
      const dir = dirname(p);
      if (grouped && dir !== lastDir) {
        const h = document.createElement('div');
        h.className = 'tree-dir';
        h.textContent = dir ? dir + '/' : state.rootName + '/';
        frag.append(h);
        lastDir = dir;
      }
      const b = document.createElement('button');
      b.className = 'tree-file';
      b.title = p;
      b.textContent = basename(p);
      if (!grouped && dir) {
        const s = document.createElement('span');
        s.className = 'sub';
        s.textContent = dir;
        b.append(s);
      }
      if (p === state.path) b.classList.add('current');
      if (q.length && i === kbdIndex) b.classList.add('kbd');
      b.onclick = () => openFile(p);
      frag.append(b);
    });
    if (!list.length) {
      const e = document.createElement('div');
      e.className = 'empty';
      e.textContent = q.length ? 'Sin coincidencias' : panel === 'files' ? 'No hay archivos .md aquí' : 'Nada todavía';
      frag.append(e);
    }
    els.list.replaceChildren(frag);
    const kbd = els.list.querySelector('.kbd');
    if (kbd) kbd.scrollIntoView({ block: 'nearest' });
  }

  function setPanel(panel) {
    ui.panel = panel;
    store.set('panel', panel);
    filter.value = '';
    kbdIndex = 0;
    renderSidebar();
  }

  for (const b of $$('.rail-btn[data-panel]')) {
    b.onclick = () => setPanel(ui.panel === b.dataset.panel ? null : b.dataset.panel);
  }
  $('#sidebar-close').onclick = () => setPanel(null);
  $('#scratch-btn').onclick = () => openScratch();

  filter.addEventListener('input', () => {
    kbdIndex = 0;
    renderSidebar();
  });
  filter.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      kbdIndex = clamp(kbdIndex + (e.key === 'ArrowDown' ? 1 : -1), 0, visible.length - 1);
      if (!filter.value) filter.value = ' ';
      renderSidebar();
    } else if (e.key === 'Enter' && visible[kbdIndex]) {
      openFile(visible[kbdIndex]);
      filter.value = '';
      renderSidebar();
      cm.focus();
    } else if (e.key === 'Escape') {
      if (filter.value) {
        filter.value = '';
        renderSidebar();
      } else {
        setPanel(null);
        cm.focus();
      }
    }
  });

  // --- Preview interactions ------------------------------------------------

  function scrollToAnchor(hash) {
    let id = hash.replace(/^#/, '');
    try {
      id = decodeURIComponent(id);
    } catch {}
    const el = document.getElementById(id) || document.getElementById(id.toLowerCase());
    if (!el || !preview.contains(el)) return;
    const c = previewScroll.getBoundingClientRect();
    previewScroll.scrollTop += el.getBoundingClientRect().top - c.top - 12;
  }

  preview.addEventListener('click', (e) => {
    const box = e.target.closest('input.task-list-item-checkbox');
    if (box) {
      const li = box.closest('li[data-line]');
      if (!li) return;
      const line = +li.dataset.line;
      const m = /^(\s*(?:>\s*)*(?:[-*+]|\d+[.)])\s+\[)([ xX])\]/.exec(cm.getLine(line) || '');
      if (!m) return;
      cm.replaceRange(m[2] === ' ' ? 'x' : ' ', { line, ch: m[1].length }, { line, ch: m[1].length + 1 }, '+task');
      return;
    }
    const a = e.target.closest('a[href]');
    if (!a || e.ctrlKey || e.metaKey || e.shiftKey) return;
    const href = a.getAttribute('href');
    if (href.startsWith('#')) {
      e.preventDefault();
      scrollToAnchor(href);
    } else if (a.dataset.md) {
      e.preventDefault();
      openFile(a.dataset.md, a.dataset.hash);
    }
  });

  // --- Toolbar -------------------------------------------------------------

  els.save.onclick = () => save();

  els.reset.onclick = async () => {
    if (state.path === null) {
      if (!confirm('¿Reemplazar el borrador con el texto de bienvenida?')) return;
      cm.setValue(await welcome());
      return;
    }
    if (isDirty() && !confirm('¿Descartar los cambios sin guardar y recargar desde disco?')) return;
    try {
      const d = await fetchFile(state.path);
      state.diskHash = d.hash;
      state.diskContent = d.content ?? '';
      state.exists = d.content !== null;
      replaceFromDisk(state.diskContent);
      hideBanner();
      updateChrome();
      flash('recargado');
    } catch (err) {
      showBanner('error', `No se pudo recargar: ${err.message}`, [['Cerrar', () => hideBanner()]], true);
    }
  };

  els.copy.onclick = async () => {
    try {
      await navigator.clipboard.writeText(cm.getValue());
      flash('copiado');
    } catch {
      flash('no se pudo copiar');
    }
  };

  els.autosave.onchange = () => {
    ui.autosave = els.autosave.checked;
    store.set('autosave', ui.autosave);
    if (ui.autosave) save();
  };

  els.sync.onchange = () => {
    ui.sync = els.sync.checked;
    store.set('sync', ui.sync);
    if (ui.sync) editorToPreview();
  };

  function applyUi() {
    document.documentElement.dataset.theme = ui.theme;
    const dark = ui.theme === 'dark';
    $('#gh-dark').disabled = !dark;
    $('#hljs-dark').disabled = !dark;
    $('#gh-light').disabled = dark;
    $('#hljs-light').disabled = dark;
    els.theme.textContent = dark ? '🌙 Oscuro' : '☀️ Claro';

    panes.dataset.layout = ui.layout;
    panes.style.setProperty('--split', ui.split + '%');
    previewScroll.dataset.width = ui.width;
    preview.className = ui.style === 'github' ? 'markdown-body' : 'plain';
    for (const b of $$('#layout-seg button')) b.classList.toggle('active', b.dataset.layout === ui.layout);
    for (const b of $$('#width-seg button')) b.classList.toggle('active', b.dataset.width === ui.width);
    for (const b of $$('#style-seg button')) b.classList.toggle('active', b.dataset.style === ui.style);
    els.sync.checked = ui.sync;
    els.autosave.checked = ui.autosave;
    lineMapDirty = true;
  }

  function setUi(key, value) {
    ui[key] = value;
    store.set(key, value);
    applyUi();
    if (key === 'layout') cm.refresh();
    if (ui.sync && ui.layout === 'split') requestAnimationFrame(editorToPreview);
  }

  els.theme.onclick = () => setUi('theme', ui.theme === 'dark' ? 'light' : 'dark');
  for (const b of $$('#layout-seg button')) b.onclick = () => setUi('layout', b.dataset.layout);
  for (const b of $$('#width-seg button')) b.onclick = () => setUi('width', b.dataset.width);
  for (const b of $$('#style-seg button')) b.onclick = () => setUi('style', b.dataset.style);

  // "Follow changes" lives next to the preview's own controls.
  {
    const label = document.createElement('label');
    label.className = 'check';
    label.title = 'Al cambiar el archivo en disco, desplaza la vista hasta el bloque modificado';
    label.innerHTML = '<input type="checkbox"> Seguir cambios';
    const input = label.firstChild;
    input.checked = ui.follow;
    input.onchange = () => {
      ui.follow = input.checked;
      store.set('follow', ui.follow);
    };
    $('#preview-pane .pane-tools').prepend(label);
  }

  // Draggable divider between the panes.
  const divider = $('#divider');
  divider.addEventListener('pointerdown', (e) => {
    e.preventDefault();
    divider.setPointerCapture(e.pointerId);
    divider.classList.add('dragging');
    document.body.classList.add('resizing');
    const rect = panes.getBoundingClientRect();
    const move = (ev) => {
      ui.split = Math.round(clamp(((ev.clientX - rect.left - 12) / (rect.width - 24)) * 1000, 150, 850)) / 10;
      panes.style.setProperty('--split', ui.split + '%');
    };
    const up = () => {
      divider.removeEventListener('pointermove', move);
      divider.classList.remove('dragging');
      document.body.classList.remove('resizing');
      store.set('split', ui.split);
      lineMapDirty = true;
    };
    divider.addEventListener('pointermove', move);
    divider.addEventListener('pointerup', up, { once: true });
  });
  divider.addEventListener('dblclick', () => setUi('split', 50));

  window.addEventListener('keydown', (e) => {
    const mod = e.ctrlKey || e.metaKey;
    if (mod && !e.shiftKey && !e.altKey && e.key.toLowerCase() === 's') {
      e.preventDefault();
      if (state.path === null) flash('el borrador se guarda solo');
      else save();
    } else if (mod && !e.shiftKey && !e.altKey && e.key.toLowerCase() === 'p') {
      e.preventDefault();
      if (ui.panel !== 'files') setPanel('files');
      filter.focus();
      filter.select();
    }
  }, true);

  window.addEventListener('beforeunload', (e) => {
    if (isDirty()) e.preventDefault();
  });

  // --- Boot ----------------------------------------------------------------

  function useSource(source) {
    state.source = source;
    const info = source.info();
    state.rootKey = info ? info.key : '';
    state.rootName = info ? info.name : '';
    state.files = info ? info.files : [];
    els.brandSub.textContent = info ? info.display : 'Vista previa en vivo de archivos locales';
    els.brandSub.title = info ? info.title : '';
    els.rootPath.replaceChildren(Object.assign(document.createElement('span'), { textContent: info ? info.display : '' }));
    els.rootPath.title = info ? info.title : '';
  }

  async function boot() {
    applyUi();
    useSource((await ServerSource.detect()) || new NullSource());
    connect();

    const file = new URLSearchParams(location.search).get('file');
    if (file) {
      state.path = undefined; // force a load even if it matches
      await openFile(file, location.hash || undefined);
      if (state.path === undefined) state.path = null;
    }
    if (state.path === null || state.path === undefined) {
      state.path = null;
      load(null, store.get('scratch', null) ?? (await welcome()), null);
      if (!file && state.files.length && ui.panel === null) setPanel('files');
    }
    cm.focus();
  }

  boot();
})();
