// public/js/wa-preview.js — popup preview for the Web App Website editor.
//
// Called from the Alpine section card on /web-app-website:
//   waPreview({ hasWindow, f, defaults, content, label, key })
//
// Renders the CURRENT (unsaved) HTML content inside the window's resolved panel
// chrome, in a new browser window, so an operator can eyeball a change before
// clicking "Save content". `f` is the editor's per-field state (strings; '' or
// '__inherit__' mean "inherit"); `defaults` is the resolved defaults object. We
// mirror the web app's windowStyle()/tag logic so the chrome matches the
// live page. Site-wide content CSS, images, and {{token}} substitution are NOT
// applied here — the window chrome is exact; content styling is approximate.
(function () {
  'use strict';

  function esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }
  // For an inline style="" attribute: only & and " are unsafe to leave raw.
  function attrEsc(s) {
    return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/"/g, '&quot;');
  }

  // Resolve one field's effective value from the editor state + defaults,
  // matching how the web app merges defaults < per-window overrides.
  function effOf(f, def, key, type) {
    var v = f ? f[key] : undefined;
    if (type === 'bool') {
      return (v === '__inherit__' || v === undefined || v === '') ? !!def[key] : (v === 'true' || v === true);
    }
    if (type === 'select') {
      return (v === '__inherit__' || v === '' || v == null) ? (def[key] || '') : v;
    }
    if (v === '' || v == null) return def[key];          // text / color / number → inherit
    if (type === 'number') { var n = parseInt(v, 10); return isNaN(n) ? def[key] : n; }
    return v;
  }

  // Build the panel's inline style — mirrors the web app landing page's windowStyle() (same field set as the reference Control Plane).
  function panelStyle(f, def) {
    var bg = effOf(f, def, 'background') || 'transparent';
    var maxW = effOf(f, def, 'maxWidth', 'number');
    var w = effOf(f, def, 'width', 'number');
    var radius = effOf(f, def, 'radius', 'number');
    var bw = effOf(f, def, 'borderWidth', 'number');
    var bs = effOf(f, def, 'borderStyle', 'select');
    var bc = effOf(f, def, 'borderColor');
    var border = (Number(bw) > 0 && bs !== 'none') ? (bw + 'px ' + bs + ' ' + (bc || 'currentColor')) : 'none';
    var shadow = effOf(f, def, 'shadow', 'bool');
    var tc = effOf(f, def, 'textColor');

    var extra = {};
    if (f && f.style) { try { extra = JSON.parse(f.style) || {}; } catch (e) { extra = {}; } }
    else if (def && def.style) { extra = def.style; }

    var css = 'background:' + bg + ';'
            + 'width:min(' + maxW + 'px,' + w + '%);'
            + 'border-radius:' + radius + 'px;'
            + 'border:' + border + ';';
    if (!shadow) css += 'box-shadow:none;';
    if (tc) css += 'color:' + tc + ';';
    for (var k in extra) {
      if (Object.prototype.hasOwnProperty.call(extra, k)) css += k + ':' + extra[k] + ';';
    }
    return css;
  }

  var BASE_CSS = [
    '*{box-sizing:border-box}',
    "body{margin:0;font-family:'Inter',system-ui,-apple-system,'Segoe UI',Roboto,sans-serif;background:#eef1f6;color:#0f172a;padding:28px;line-height:1.5}",
    '.pv-note{max-width:1140px;margin:0 auto 20px;font-size:.8rem;color:#475569;background:#fff;border:1px solid #e2e8f0;border-radius:10px;padding:10px 14px}',
    '.pv-wrap{display:flex;justify-content:center}',
    // .panel: position/margin/padding match the live site; bg/width/border/radius/shadow come from the inline style.
    '.panel{position:relative;margin:24px auto 0;padding:clamp(26px,4vw,58px) clamp(22px,4vw,60px)}',
    '.bare{width:min(1140px,90%);margin:0 auto}',
    '.panel-tag{position:absolute;top:-12px;left:24px;background:#4f46e5;color:#fff;font-size:.68rem;font-weight:800;letter-spacing:.12em;text-transform:uppercase;padding:4px 11px;border-radius:999px;box-shadow:0 1px 3px rgba(0,0,0,.2)}',
    'img{max-width:100%;height:auto}'
  ].join('');

  window.waPreview = function (opts) {
    opts = opts || {};
    var content = opts.content || '';
    var hasWindow = !!opts.hasWindow;
    var f = opts.f || {};
    var def = opts.defaults || {};
    var label = opts.label || 'Section';

    var panelHtml;
    if (hasWindow) {
      var tagHtml = '';
      var showTag = effOf(f, def, 'showTag', 'bool');
      var tag = effOf(f, def, 'tag');
      if (showTag && tag) tagHtml = '<span class="panel-tag">' + esc(tag) + '</span>';
      panelHtml = '<div class="panel" style="' + attrEsc(panelStyle(f, def)) + '">' + tagHtml + content + '</div>';
    } else {
      panelHtml = '<div class="bare">' + content + '</div>';
    }

    var doc = '<!DOCTYPE html><html lang="en"><head><meta charset="utf-8">'
      + '<meta name="viewport" content="width=device-width, initial-scale=1">'
      + '<title>Preview · ' + esc(label) + '</title>'
      + '<style>' + BASE_CSS + '</style></head><body>'
      + '<div class="pv-note">Preview of <strong>' + esc(label) + '</strong> (unsaved). '
      + 'The window chrome matches the live page; <code>{{tokens}}</code>, site content styles, and images are not applied here.</div>'
      + '<div class="pv-wrap">' + panelHtml + '</div>'
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
