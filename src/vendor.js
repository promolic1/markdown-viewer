'use strict';

// Browser builds from node_modules that the page loads from vendor/.
// Shared by the local server and the static build.
const VENDOR = {
  'markdown-it.js': 'markdown-it/dist/browser/markdown-it.umd.min.js',
  'markdown-it-footnote.js': 'markdown-it-footnote/dist/markdown-it-footnote.min.js',
  'purify.js': 'dompurify/dist/purify.min.js',
  'highlight.js': '@highlightjs/cdn-assets/highlight.min.js',
  'hljs-light.css': '@highlightjs/cdn-assets/styles/github.min.css',
  'hljs-dark.css': '@highlightjs/cdn-assets/styles/github-dark.min.css',
  'gh-light.css': 'github-markdown-css/github-markdown-light.css',
  'gh-dark.css': 'github-markdown-css/github-markdown-dark.css',
  'gh-auto.css': 'github-markdown-css/github-markdown.css',
  'codemirror.js': 'codemirror/lib/codemirror.js',
  'codemirror.css': 'codemirror/lib/codemirror.css',
  'cm-overlay.js': 'codemirror/addon/mode/overlay.js',
  'cm-markdown.js': 'codemirror/mode/markdown/markdown.js',
  'cm-gfm.js': 'codemirror/mode/gfm/gfm.js',
  'cm-continuelist.js': 'codemirror/addon/edit/continuelist.js',
};

module.exports = { VENDOR };
