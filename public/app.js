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
    panel: store.get('panel', undefined), // undefined: never chosen
    sync: store.get('sync', true),
    follow: store.get('follow', true),
    autosave: store.get('autosave', false),
  };

  // --- File state ----------------------------------------------------------

  const { SourceConflict, ServerSource, NullSource, FsSource } = MdSources;
  const canUseFs = FsSource.supported();

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
    download: $('#download-btn'),
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
    sourceBar: $('#source-bar'),
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

  const withQuery = (url, search) => (!search ? url
    : url + (url.includes('?') ? '&' + search.slice(1) : search));

  function postProcess(root) {
    for (const img of root.querySelectorAll('img[src]')) {
      const r = localRef(img.getAttribute('src'));
      if (!r) continue;
      const url = state.source.assetUrl(r.rel);
      if (url) img.setAttribute('src', withQuery(url, r.search));
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
        const url = r && state.source.assetUrl(r.rel, { load: false });
        if (url) a.setAttribute('href', withQuery(url, r.search) + r.hash);
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

  // `confirmed`: the caller already dealt with unsaved changes (or there is
  // nothing to lose, e.g. when switching folders), so always (re)load.
  async function openFile(rel, hash, { confirmed = false } = {}) {
    if (rel !== state.path && !confirmed && !(await confirmLeave())) return false;
    let data;
    try {
      data = await fetchFile(rel);
    } catch (err) {
      showBanner('error', `No se pudo abrir ${rel}: ${err.message}`, [['Cerrar', () => hideBanner()]], true);
      return false;
    }
    if (rel !== state.path || confirmed) {
      load(rel, data.content, data.hash);
      pushRecent(rel);
    }
    if (hash) scrollToAnchor(hash);
    return true;
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

  function button(label, onclick, className = 'tool') {
    const b = document.createElement('button');
    b.className = className;
    b.textContent = label;
    b.onclick = onclick;
    return b;
  }

  function renderSourceBar() {
    const bar = els.sourceBar;
    const kind = state.source.kind;
    const items = [];
    const note = (html) => {
      const p = document.createElement('p');
      p.className = 'source-note';
      p.innerHTML = html;
      items.push(p);
    };
    const offline = agentMissing && (kind === 'none' || kind === 'fs');
    if (offline) note('No encuentro <code>mdview</code>. Ejecútalo en tu máquina (en la carpeta que quieras) y pulsa Reintentar.');
    if (canUseFs && kind !== 'server') {
      items.push(button('Abrir carpeta', () => pickRoot('dir')), button('Abrir archivo', () => pickRoot('file')));
    } else if (!offline && (kind === 'none' || kind === 'fs')) {
      note('Para abrir archivos locales ejecuta <code>mdview --web</code> en la carpeta que quieras, o usa <b>Chrome</b> o <b>Edge</b>.');
    }
    if (offline) items.push(button('Reintentar', () => connectAgent()));
    bar.hidden = !items.length;
    bar.classList.toggle('stacked', items.some((el) => el.tagName === 'P'));
    bar.replaceChildren(...items);
  }

  // --- File tree --------------------------------------------------------------
  // Folders start collapsed, except those leading to the open file; whatever
  // the user expands or collapses is remembered per root.

  const foldKey = () => 'folds:' + state.rootKey;

  function buildTree(paths) {
    const root = { dirs: new Map(), files: [], count: 0 };
    for (const p of paths) {
      let node = root;
      node.count++;
      for (const part of p.split('/').slice(0, -1)) {
        if (!node.dirs.has(part)) node.dirs.set(part, { dirs: new Map(), files: [], count: 0 });
        node = node.dirs.get(part);
        node.count++;
      }
      node.files.push(p);
    }
    return root;
  }

  function isOpen(dir, folds) {
    if (dir in folds) return folds[dir];
    return state.path !== null && state.path.startsWith(dir + '/');
  }

  function toggleDir(dir) {
    const folds = store.get(foldKey(), {});
    folds[dir] = !isOpen(dir, folds);
    store.set(foldKey(), folds);
    renderSidebar();
  }

  function renderTree(node, prefix, depth, frag, expandAll, fileButton) {
    const folds = store.get(foldKey(), {});
    const byName = (a, b) => a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' });
    for (const name of [...node.dirs.keys()].sort(byName)) {
      const child = node.dirs.get(name);
      const dir = prefix + name;
      const open = expandAll || isOpen(dir, folds);
      const row = document.createElement('button');
      row.className = 'tree-folder';
      row.style.setProperty('--depth', depth);
      row.title = dir + '/';
      row.setAttribute('aria-expanded', String(open));
      row.innerHTML = '<span class="chev" aria-hidden="true"></span><span class="name"></span><span class="count"></span>';
      row.querySelector('.name').textContent = name;
      row.querySelector('.count').textContent = open ? '' : child.count;
      row.onclick = () => toggleDir(dir);
      frag.append(row);
      if (open) renderTree(child, dir + '/', depth + 1, frag, expandAll, fileButton);
    }
    for (const p of [...node.files].sort((a, b) => byName(basename(a), basename(b)))) {
      frag.append(fileButton(p, basename(p), depth));
    }
  }

  function renderSidebar() {
    const panel = ui.panel;
    sidebar.hidden = !panel;
    for (const b of $$('.rail-btn[data-panel]')) b.classList.toggle('active', b.dataset.panel === panel);
    if (!panel) return;
    renderSourceBar();

    const q = filter.value.trim().toLowerCase().split(/\s+/).filter(Boolean);
    let list = panel === 'files' ? state.files : store.get(recentKey(), []);
    if (q.length) list = list.filter((p) => q.every((term) => p.toLowerCase().includes(term)));
    els.sidebarTitle.textContent = panel === 'files' ? `Archivos (${state.files.length})` : 'Recientes';

    const frag = document.createDocumentFragment();
    visible = []; // files in display order, for keyboard navigation
    const fileButton = (p, label, depth) => {
      const b = document.createElement('button');
      b.className = 'tree-file';
      b.title = p;
      b.textContent = label;
      if (depth === undefined) b.classList.add('flat');
      else b.style.setProperty('--depth', depth);
      if (p === state.path) b.classList.add('current');
      if (q.length && visible.length === kbdIndex) b.classList.add('kbd');
      b.onclick = () => openFile(p);
      visible.push(p);
      return b;
    };
    if (panel === 'files') {
      renderTree(buildTree(list), '', 0, frag, q.length > 0, fileButton);
    } else {
      for (const p of list) {
        const b = fileButton(p, basename(p));
        if (dirname(p)) {
          const sub = document.createElement('span');
          sub.className = 'sub';
          sub.textContent = dirname(p);
          b.append(sub);
        }
        frag.append(b);
      }
    }
    kbdIndex = clamp(kbdIndex, 0, Math.max(0, visible.length - 1));
    if (!list.length) {
      const e = document.createElement('div');
      e.className = 'empty';
      e.textContent = q.length ? 'Sin coincidencias'
        : panel === 'recent' ? 'Nada todavía'
        : state.source.kind === 'none' ? (canUseFs ? 'Abre una carpeta para ver sus archivos .md' : 'No hay archivos abiertos')
        : 'No hay archivos .md aquí';
      frag.append(e);
    }
    // Folders/files opened before through the browser, to reopen in one click.
    const roots = panel === 'recent' && state.source.kind !== 'server'
      ? fsRoots.filter((h) => q.every((term) => h.name.toLowerCase().includes(term)))
      : [];
    if (roots.length) {
      const h = document.createElement('div');
      h.className = 'tree-dir';
      h.textContent = 'Carpetas y archivos';
      frag.append(h);
      for (const handle of roots) {
        const b = button((handle.kind === 'directory' ? '📁 ' : '📄 ') + handle.name, () => openRoot(handle), 'tree-file flat');
        b.title = handle.kind === 'directory' ? 'Carpeta local' : 'Archivo local';
        frag.append(b);
      }
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
    } else if (a.dataset.asset && state.source.loadAsset) {
      // Local attachment in File System Access mode: open it as a blob.
      e.preventDefault();
      const rel = a.dataset.asset;
      state.source.loadAsset(rel).then((url) => (url ? window.open(url, '_blank') : flash(`no existe ${rel}`)));
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

  // --- Download -------------------------------------------------------------
  // Both formats use what's in the editor, unsaved changes included.

  function downloadBlob(name, blob) {
    const url = URL.createObjectURL(blob);
    const a = Object.assign(document.createElement('a'), { href: url, download: name });
    document.body.append(a);
    a.click();
    a.remove();
    // Firefox reads the blob after click() returns; give it time.
    setTimeout(() => URL.revokeObjectURL(url), 10000);
  }

  const blobToDataUrl = (blob) => new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(blob);
  });

  // A single self-contained page: GitHub styles (following the reader's
  // light/dark preference), highlighted code and local images embedded as
  // data: URIs. Relative links are kept, so they work next to the .md files.
  async function exportHtml(src) {
    const tpl = document.createElement('template');
    tpl.innerHTML = DOMPurify.sanitize(renderMarkdown(src), PURIFY);
    const body = tpl.content;
    for (const el of body.querySelectorAll('[data-line]')) el.removeAttribute('data-line');
    for (const box of body.querySelectorAll('input[type=checkbox]')) box.setAttribute('disabled', '');
    for (const a of body.querySelectorAll('a[href]')) {
      if (localRef(a.getAttribute('href')) === null && !a.getAttribute('href').startsWith('#')) {
        a.target = '_blank';
        a.rel = 'noopener noreferrer';
      }
    }
    await Promise.all([...body.querySelectorAll('img[src]')].map(async (img) => {
      const r = localRef(img.getAttribute('src'));
      if (!r) return;
      try {
        const blob = await state.source.assetBlob(r.rel);
        if (blob) img.setAttribute('src', await blobToDataUrl(blob));
      } catch {}
    }));

    const css = async (name) => (await fetch('vendor/' + name)).text();
    const [gh, hlLight, hlDark] = await Promise.all([css('gh-auto.css'), css('hljs-light.css'), css('hljs-dark.css')]);
    const name = state.path ? basename(state.path) : 'borrador.md';
    const h1 = body.querySelector('h1');
    const title = (h1 && h1.textContent.trim()) || name.replace(/\.[^.]+$/, '');
    const wrap = document.createElement('div');
    wrap.append(body);
    return `<!doctype html>
<html lang="${document.documentElement.lang}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="generator" content="Markdown Viewer">
<title>${escapeHtml(title)}</title>
<style>
${gh}
${hlLight}
:root { color-scheme: light dark; }
body { margin: 0; background: #fff; }
.markdown-body { box-sizing: border-box; max-width: 980px; margin: 0 auto; padding: 45px; }
@media (max-width: 767px) { .markdown-body { padding: 15px; } }
@media (prefers-color-scheme: dark) {
body { background: #0d1117; }
${hlDark}
}
</style>
</head>
<body>
<article class="markdown-body">
${wrap.innerHTML}
</article>
</body>
</html>
`;
  }

  async function download(format) {
    const src = cm.getValue();
    const name = state.path ? basename(state.path) : 'borrador.md';
    if (format === 'html') {
      try {
        const html = await exportHtml(src);
        downloadBlob(name.replace(/\.[^.]+$/, '') + '.html', new Blob([html], { type: 'text/html;charset=utf-8' }));
        flash('HTML descargado');
      } catch (err) {
        showBanner('error', `No se pudo exportar a HTML: ${err.message}`, [['Cerrar', () => hideBanner()]], true);
      }
    } else {
      downloadBlob(name, new Blob([src], { type: 'text/markdown;charset=utf-8' }));
      flash('descargado');
    }
  }

  const downloadList = $('#download-list');
  els.download.onclick = (e) => {
    e.stopPropagation();
    downloadList.hidden = !downloadList.hidden;
  };
  for (const b of downloadList.querySelectorAll('button')) {
    b.onclick = () => {
      downloadList.hidden = true;
      download(b.dataset.format);
    };
  }
  document.addEventListener('click', (e) => {
    if (!downloadList.hidden && !$('#download-menu').contains(e.target)) downloadList.hidden = true;
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') downloadList.hidden = true;
  });

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
    source.onAsset = () => scheduleRender(false);
    const info = source.info();
    state.rootKey = info ? info.key : '';
    state.rootName = info ? info.name : '';
    state.files = info ? info.files : [];
    els.brandSub.textContent = info ? info.display : 'Vista previa en vivo de archivos locales';
    els.brandSub.title = info ? info.title : '';
    els.rootPath.replaceChildren(Object.assign(document.createElement('span'), { textContent: info ? info.display : '' }));
    els.rootPath.title = info ? info.title : '';
    connect();
    renderSidebar();
  }

  async function loadScratch() {
    load(null, store.get('scratch', null) ?? (await welcome()), null);
  }

  // --- File System Access mode (Chrome, Edge…) -------------------------------

  let fsRoots = [];

  async function switchSource(source, preferred) {
    if (!(await confirmLeave())) {
      source.close();
      return false;
    }
    state.source.close();
    useSource(source);
    const files = state.files;
    const last = store.get(recentKey(), []).find((f) => files.includes(f));
    const pick = (preferred && files.includes(preferred) && preferred)
      || last
      || (source.isDir ? files.find((f) => /^readme\.md$/i.test(f)) : files[0]);
    if (!pick || !(await openFile(pick, undefined, { confirmed: true }))) {
      await loadScratch();
      if (files.length) setPanel('files');
    }
    return true;
  }

  // Open a folder or file handle, asking for permission if needed. Without a
  // user gesture (`prompt: false`) we can only check; if access must be asked
  // for, offer a button so the click provides the gesture.
  async function openRoot(handle, { preferred, prompt = true } = {}) {
    let perm;
    try {
      perm = await FsSource.permission(handle, prompt);
    } catch {
      perm = 'prompt';
    }
    if (perm !== 'granted') {
      if (prompt) {
        showBanner('error', `El navegador no dio permiso para abrir «${handle.name}».`, [['Cerrar', () => hideBanner()]], true);
      } else {
        showBanner('reopen', `¿Volver a abrir «${handle.name}»? El navegador necesita tu permiso.`, [
          ['Abrir', () => {
            hideBanner();
            openRoot(handle, { preferred });
          }],
          ['Ahora no', () => hideBanner()],
        ]);
      }
      return false;
    }
    hideBanner('reopen');
    let source;
    try {
      source = await new FsSource(handle).init();
    } catch (err) {
      showBanner('error', `No se pudo leer «${handle.name}»: ${err.message}`, [['Cerrar', () => hideBanner()]], true);
      return false;
    }
    const ok = await switchSource(source, preferred);
    fsRoots = await FsSource.recentRoots();
    renderSidebar();
    return ok;
  }

  async function pickRoot(kind) {
    let handle;
    try {
      handle = kind === 'dir' ? await FsSource.pickDirectory() : await FsSource.pickFile();
    } catch (err) {
      if (err.name !== 'AbortError') {
        showBanner('error', `No se pudo abrir: ${err.message}`, [['Cerrar', () => hideBanner()]], true);
      }
      return;
    }
    await openRoot(handle);
  }

  // Drop a folder or .md file anywhere on the page to open it. Capture phase,
  // so CodeMirror doesn't paste the file's text into the editor instead.
  if (canUseFs) {
    const droppable = (e) => state.source.kind !== 'server'
      && [...e.dataTransfer.items].some((item) => item.kind === 'file');
    window.addEventListener('dragover', (e) => {
      if (!droppable(e)) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = 'copy';
      document.body.classList.add('dropping');
    }, true);
    window.addEventListener('dragleave', (e) => {
      if (!e.relatedTarget) document.body.classList.remove('dropping');
    }, true);
    window.addEventListener('drop', (e) => {
      document.body.classList.remove('dropping');
      if (!droppable(e)) return;
      const item = [...e.dataTransfer.items].find((it) => it.kind === 'file');
      if (!item.getAsFileSystemHandle) return;
      e.preventDefault();
      // Must be requested synchronously, while the drop data is accessible.
      item.getAsFileSystemHandle().then((handle) => {
        if (!handle) return;
        if (handle.kind === 'file' && !MD_RE.test(handle.name)) flash('solo carpetas o archivos Markdown');
        else openRoot(handle, { prompt: false });
      });
    }, true);
  }

  // Debugging/automation hook: open a FileSystemHandle programmatically.
  window.mdview = { openHandle: (handle) => openRoot(handle, { prompt: false }) };

  // --- Local mdview from the web version ("agent") ---------------------------
  // `mdview --web` opens this page with #agent=…&token=…[&file=…]. The
  // fragment never leaves the browser; we keep the pairing for next time.

  let agentMissing = false;

  function takePairing() {
    const hash = new URLSearchParams(location.hash.slice(1));
    const agent = hash.get('agent');
    const token = hash.get('token');
    if (!agent || !token) return null;
    history.replaceState(null, '', location.pathname + location.search);
    if (!ServerSource.isAgentUrl(agent)) return null;
    store.set('agent', { url: agent, token });
    return { file: hash.get('file') };
  }

  async function findAgent() {
    const saved = store.get('agent', null);
    if (!saved || !ServerSource.isAgentUrl(saved.url)) return null;
    const source = await ServerSource.detect(saved.url, saved.token, 2500);
    agentMissing = !source;
    return source;
  }

  async function connectAgent() {
    const source = await findAgent();
    if (!source) {
      renderSidebar();
      flash('mdview no responde');
      return;
    }
    await switchSource(source);
  }

  // --- Boot ----------------------------------------------------------------

  async function boot() {
    applyUi();
    const params = new URLSearchParams(location.search);
    const pairing = takePairing();
    const file = params.get('file') || (pairing && pairing.file);
    // Served by mdview itself, or the web version with a local mdview.
    const server = (await ServerSource.detect()) || (await findAgent());
    useSource(server || new NullSource());

    if (!(server && file && (await openFile(file, location.hash || undefined, { confirmed: true })))) {
      await loadScratch();
      if (server && !file && state.files.length && ui.panel == null) setPanel('files');
    }
    // First visit to the web version: show where "Abrir carpeta" lives.
    if (!server && (ui.panel === undefined || agentMissing)) setPanel('files');
    if (!server && canUseFs) {
      fsRoots = await FsSource.recentRoots();
      renderSidebar();
      // Reopen the last folder: silently if the browser kept the permission,
      // otherwise via a one-click banner.
      if (fsRoots[0]) await openRoot(fsRoots[0], { preferred: file, prompt: false });
    }
    cm.focus();
  }

  boot();
})();
