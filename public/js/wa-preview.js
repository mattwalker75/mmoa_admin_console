// public/js/wa-preview.js — previews for the Web App Website editor.
//
//   waPreview({ content, label, key })  — section preview (popup window)
//   waImagePreview({ name, url })       — image preview (floating overlay)
//
// The section preview renders the CURRENT (unsaved) HTML fragment in a new
// browser window on the website's v2 dark palette (page #18191a, cards
// #242526, text #e4e6eb, links #8fdc4f, Saira Condensed / Barlow if
// installed), with:
//   * {{tokens}} filled in from the values the page carries in
//     data-wa-tokens (computed server-side from the Web App's config.json
//     the way the website does; HTML-escaped like the website does), and
//   * /content/images/<file> paths pointed at this console's image proxy
//     (/web-app-website/images/<file>) so the pictures show.
// Still an approximation: the site's own component styles are not applied.
(function () {
  'use strict';

  function esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  function tokens() {
    var el = document.querySelector('[data-wa-tokens]');
    if (!el) return {};
    try { return JSON.parse(el.getAttribute('data-wa-tokens')) || {}; } catch (e) { return {}; }
  }

  // Same rules as the website: known tokens are replaced (escaped), unknown
  // ones are left as typed.
  function applyTokens(html, t) {
    return String(html).replace(/\{\{(\w+)\}\}/g, function (m, k) {
      return Object.prototype.hasOwnProperty.call(t, k) ? esc(t[k]) : m;
    });
  }

  // "/content/images/x.jpg" (in src/href attributes or CSS url()) → the
  // console's proxy for that file.
  function rewriteImages(html) {
    return String(html).replace(/(["'(])\/content\/images\/([A-Za-z0-9._-]+)/g, function (m, q, file) {
      return q + '/web-app-website/images/' + encodeURIComponent(file);
    });
  }

  // The full preview document for a fragment (exposed for testing).
  function previewHtml(content, label) {
    var BASE_CSS = [
      '*{box-sizing:border-box}',
      "body{margin:0;font-family:Barlow,system-ui,-apple-system,'Segoe UI',Roboto,sans-serif;background:#18191a;color:#e4e6eb;padding:28px;line-height:1.55}",
      '.pv-note{max-width:1100px;margin:0 auto 20px;font-size:.8rem;color:#a7aeaa;background:#242526;border:1px solid #3a3b3c;border-radius:10px;padding:10px 14px}',
      '.pv-card{max-width:1100px;margin:0 auto;background:#242526;border:1px solid #3a3b3c;border-radius:16px;padding:clamp(20px,4vw,48px)}',
      "h1,h2,h3{font-family:'Saira Condensed',Barlow,sans-serif;font-weight:700;line-height:1.1}",
      'h1,h2{text-transform:uppercase}',
      'a{color:#8fdc4f}a:hover{color:#b5ec86}',
      'img{max-width:100%;height:auto}',
      // the About page's "What we've done" cards (site styles.scss .impact)
      '.impact{list-style:none;padding:0;margin:0;display:grid;gap:10px}',
      '.impact li{background:#242526;border:1px solid #3a3b3c;border-left:4px solid #7cd136;border-radius:12px;padding:12px 16px}'
    ].join('');
    var body = rewriteImages(applyTokens(content || '', tokens()));
    return '<!DOCTYPE html><html lang="en"><head><meta charset="utf-8">'
      + '<meta name="viewport" content="width=device-width, initial-scale=1">'
      + '<title>Preview · ' + esc(label) + '</title>'
      + '<style>' + BASE_CSS + '</style></head><body>'
      + '<div class="pv-note">Preview of <strong>' + esc(label) + '</strong> (unsaved) on the site’s dark palette, with its images and <code>{{tokens}}</code> filled in. '
      + 'Approximate: the site’s own component styles are not applied here.</div>'
      + '<div class="pv-card">' + body + '</div>'
      + '</body></html>';
  }
  window.waPreviewHtml = previewHtml;

  window.waPreview = function (opts) {
    opts = opts || {};
    var label = opts.label || 'Section';
    var win = window.open('', 'wa-preview-' + (opts.key || 'section'), 'width=1024,height=820,scrollbars=yes,resizable=yes');
    if (!win) {
      alert('Preview was blocked by your browser. Allow pop-ups for this site, then click Preview again.');
      return;
    }
    win.document.open();
    win.document.write(previewHtml(opts.content, label));
    win.document.close();
    win.focus();
  };

  // ── Image preview: a floating window over the page ──────────────────────
  var overlay = null;
  function closeImage() {
    if (overlay && overlay.parentNode) overlay.parentNode.removeChild(overlay);
    overlay = null;
    document.removeEventListener('keydown', onKey);
  }
  function onKey(e) { if (e.key === 'Escape') closeImage(); }

  window.waImagePreview = function (opts) {
    opts = opts || {};
    closeImage();
    overlay = document.createElement('div');
    overlay.className = 'wa-img-overlay';
    overlay.setAttribute('role', 'dialog');
    overlay.setAttribute('aria-label', 'Image preview: ' + (opts.name || ''));
    overlay.innerHTML =
      '<div class="wa-img-window">'
      + '<div class="wa-img-bar"><span class="wa-img-name"></span>'
      + '<span class="wa-img-meta"></span>'
      + '<button type="button" class="wa-img-close" aria-label="Close">✕</button></div>'
      + '<div class="wa-img-body"><div class="wa-img-loading" role="status">Loading the image from the Web App…</div><img alt="" hidden><div class="wa-img-err" hidden>The image could not be loaded.</div></div>'
      + '</div>';
    overlay.querySelector('.wa-img-name').textContent = opts.name || '';
    var img = overlay.querySelector('img');
    var meta = overlay.querySelector('.wa-img-meta');
    var loading = overlay.querySelector('.wa-img-loading');
    img.addEventListener('load', function () { loading.hidden = true; img.hidden = false; meta.textContent = img.naturalWidth + ' × ' + img.naturalHeight + ' px'; });
    img.addEventListener('error', function () { loading.hidden = true; img.hidden = true; overlay.querySelector('.wa-img-err').hidden = false; });
    img.src = opts.url || '';
    overlay.querySelector('.wa-img-close').addEventListener('click', closeImage);
    overlay.addEventListener('click', function (e) { if (e.target === overlay) closeImage(); });
    document.addEventListener('keydown', onKey);
    document.body.appendChild(overlay);
    overlay.querySelector('.wa-img-close').focus();
  };
})();
