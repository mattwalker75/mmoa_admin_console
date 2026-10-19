// public/js/wa-preview.js — popup preview for the Web App Website editor.
//
// Called from the Alpine section card on /web-app-website:
//   waPreview({ content, label, key })
//
// Renders the CURRENT (unsaved) HTML fragment in a new browser window on the
// website's v2 dark palette (page #18191a, cards #242526, text #e4e6eb, links
// #8fdc4f, Saira Condensed / Barlow if installed), so an operator can eyeball
// a change before clicking "Save content". It is an approximation: the site's
// own component styles, {{token}} substitution and relative image paths are
// not applied here.
(function () {
  'use strict';

  function esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  var BASE_CSS = [
    '*{box-sizing:border-box}',
    "body{margin:0;font-family:Barlow,system-ui,-apple-system,'Segoe UI',Roboto,sans-serif;background:#18191a;color:#e4e6eb;padding:28px;line-height:1.55}",
    '.pv-note{max-width:1100px;margin:0 auto 20px;font-size:.8rem;color:#a7aeaa;background:#242526;border:1px solid #3a3b3c;border-radius:10px;padding:10px 14px}',
    '.pv-card{max-width:1100px;margin:0 auto;background:#242526;border:1px solid #3a3b3c;border-radius:16px;padding:clamp(20px,4vw,48px)}',
    "h1,h2,h3{font-family:'Saira Condensed',Barlow,sans-serif;font-weight:700;line-height:1.1}",
    'h1,h2{text-transform:uppercase}',
    'a{color:#8fdc4f}a:hover{color:#b5ec86}',
    'img{max-width:100%;height:auto}'
  ].join('');

  window.waPreview = function (opts) {
    opts = opts || {};
    var content = opts.content || '';
    var label = opts.label || 'Section';
    var doc = '<!DOCTYPE html><html lang="en"><head><meta charset="utf-8">'
      + '<meta name="viewport" content="width=device-width, initial-scale=1">'
      + '<title>Preview · ' + esc(label) + '</title>'
      + '<style>' + BASE_CSS + '</style></head><body>'
      + '<div class="pv-note">Preview of <strong>' + esc(label) + '</strong> (unsaved) on the site’s dark palette. '
      + 'Approximate: <code>{{tokens}}</code>, the site’s component styles and relative image paths are not applied here.</div>'
      + '<div class="pv-card">' + content + '</div>'
      + '</body></html>';

    var win = window.open('', 'wa-preview-' + (opts.key || 'section'), 'width=1024,height=820,scrollbars=yes,resizable=yes');
    if (!win) {
      alert('Preview was blocked by your browser. Allow pop-ups for this site, then click Preview again.');
      return;
    }
    win.document.open();
    win.document.write(doc);
    win.document.close();
    win.focus();
  };
})();
