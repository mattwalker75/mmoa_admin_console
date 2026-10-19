// helpers/markdownLite.js — tiny, safe "markdown-lite" → HTML renderer.
//
// Used for event descriptions, raffle prize descriptions and nonprofit
// profile descriptions. The admin console keeps a VERBATIM copy of this file
// (mmoa_admin_console/helpers/markdownLite.js) for its live preview — the two
// copies must stay byte-identical, so change both or neither.
//
// Supported (and nothing else):
//   blank line         → new paragraph
//   single line break  → <br>
//   **bold**           → <strong>
//   *italic*           → <em>
//   [text](url)        → link; url must be http://, https:// or mailto:
//                        (opens in a new tab, rel="noopener noreferrer")
//   "- " at line start → bullet list (consecutive lines form one <ul>)
//
// Safety: the WHOLE input is HTML-escaped FIRST, so any tag, attribute or
// entity the author typed comes out as inert text. Only the markup this file
// itself emits is real HTML. Link URLs are checked against the allowlist
// AFTER escaping and are emitted inside a double-quoted attribute, where the
// escaping already neutralised quotes — so `javascript:`, `data:`, quote
// break-outs and the like can't get through.
//
// No dependencies — plain CommonJS, runs on Node 18+.

'use strict';

const MAX_INPUT = 20000; // longer input is truncated (DB fields are smaller anyway)

function escapeHtml(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

// Allowlisted link targets. The URL has already been HTML-escaped, so '&'
// appears as '&amp;' (correct inside an attribute). No whitespace allowed.
const SAFE_URL_RE = /^(https?:\/\/[^\s]+|mailto:[^\s]+)$/i;

// Inline formatting on an already-escaped line.
function inline(escaped) {
  let out = escaped;
  // Links first, so * inside a URL isn't read as emphasis. Text may not
  // contain ']' and the URL may not contain ')' or whitespace.
  out = out.replace(/\[([^\]\n]{1,300})\]\(([^)\s]{1,2000})\)/g, (m, text, url) => {
    if (!SAFE_URL_RE.test(url)) return m; // not allowlisted → leave as plain text
    return `<a href="${url}" target="_blank" rel="noopener noreferrer">${text}</a>`;
  });
  // Split around the links we just made so emphasis never touches an href.
  const parts = out.split(/(<a href="[^"]*" target="_blank" rel="noopener noreferrer">|<\/a>)/);
  for (let i = 0; i < parts.length; i += 2) {
    parts[i] = parts[i]
      .replace(/\*\*([^*\n]+?)\*\*/g, '<strong>$1</strong>')
      .replace(/(^|[^*])\*([^*\n]+?)\*(?!\*)/g, '$1<em>$2</em>');
  }
  return parts.join('');
}

/**
 * Render markdown-lite text to safe HTML. Returns '' for empty input.
 * @param {string} src
 * @returns {string}
 */
function renderMarkdownLite(src) {
  if (src == null) return '';
  let text = String(src).replace(/\r\n?/g, '\n');
  if (text.length > MAX_INPUT) text = text.slice(0, MAX_INPUT);
  text = escapeHtml(text);

  const blocks = text.split(/\n[ \t]*\n+/);
  const html = [];
  for (const block of blocks) {
    const lines = block.split('\n').map(l => l.replace(/[ \t]+$/, ''));
    if (!lines.some(l => l.trim())) continue;
    // Walk the block, grouping "- " lines into <ul> and the rest into <p>.
    let para = [];
    let list = [];
    const flushPara = () => {
      if (para.length) html.push('<p>' + para.map(inline).join('<br>') + '</p>');
      para = [];
    };
    const flushList = () => {
      if (list.length) html.push('<ul>' + list.map(li => '<li>' + inline(li) + '</li>').join('') + '</ul>');
      list = [];
    };
    for (const line of lines) {
      const m = line.match(/^\s*- (.*)$/);
      if (m) { flushPara(); list.push(m[1]); }
      else if (line.trim()) { flushList(); para.push(line.trim()); }
    }
    flushPara();
    flushList();
  }
  return html.join('\n');
}

module.exports = { renderMarkdownLite, escapeHtml };
