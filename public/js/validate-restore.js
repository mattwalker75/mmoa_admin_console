// public/js/validate-restore.js — the "Validate" button on every restore
// form of the Backup/Restore page.
//
//   <button type="button" x-on:click="validateRestore($el)">Validate</button>
//
// Sends the form (chosen file + the ticked options) to the same restore
// endpoint with validate=1. The server runs every check the restore would
// run — the file type, every value / checksum / image, and for a database a
// trial load that is always rolled back — and stops before its first
// write, answering { valid, error, summary, warnings[], notes[] }. The
// result is shown in the form's [data-validate-result] box. Nothing on the
// Web App or this console changes. External file: the CSP has no
// 'unsafe-inline'.
(function () {
  'use strict';

  function el(tag, cls, text) {
    var e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text != null) e.textContent = text;
    return e;
  }

  function render(box, r) {
    box.innerHTML = '';
    box.hidden = false;
    var ok = !!r.valid;
    box.className = 'rounded-lg border p-3 text-sm ' + (ok
      ? 'border-emerald-300 bg-emerald-50 text-emerald-900 dark:bg-emerald-950/40 dark:border-emerald-900 dark:text-emerald-100'
      : 'border-red-300 bg-red-50 text-red-900 dark:bg-red-950/40 dark:border-red-900 dark:text-red-100');
    box.appendChild(el('div', 'font-semibold', ok ? '✓ Validated — this restore can be performed. Nothing was changed.' : '✗ This restore would NOT go through. Nothing was changed.'));
    if (r.error) box.appendChild(el('div', 'mt-1', r.error));
    var lines = [].concat(r.summary ? [r.summary] : [], r.details || []);
    if (lines.length) {
      var ul = el('ul', 'mt-2 list-disc pl-5 space-y-0.5');
      lines.forEach(function (t) { ul.appendChild(el('li', '', t)); });
      box.appendChild(ul);
    }
    var warns = [].concat(r.warnings || [], r.notes || [], r.warn ? [r.warn] : []).filter(Boolean);
    if (warns.length) {
      box.appendChild(el('div', 'mt-2 font-semibold', 'Notes:'));
      var wl = el('ul', 'list-disc pl-5 space-y-0.5 text-amber-800 dark:text-amber-200');
      warns.forEach(function (t) { wl.appendChild(el('li', '', t)); });
      box.appendChild(wl);
    }
  }

  window.validateRestore = function (btn) {
    var form = btn && btn.closest('form');
    if (!form) return;
    var box = form.querySelector('[data-validate-result]');
    var file = form.querySelector('input[type="file"]');
    if (!file || !file.files || !file.files[0]) {
      if (box) render(box, { valid: false, error: 'Choose a backup file first.' });
      return;
    }
    if (box) { box.hidden = true; box.innerHTML = ''; } // never show a previous file's result
    var fd = new FormData(form);
    fd.set('validate', '1');
    var label = btn.textContent;
    btn.disabled = true;
    var xhr = new XMLHttpRequest();
    xhr.open('POST', form.getAttribute('action'), true);
    xhr.withCredentials = true;
    xhr.setRequestHeader('Accept', 'application/json');
    xhr.setRequestHeader('X-Restore-Validate', '1');
    var t = window.csrfToken ? window.csrfToken() : '';
    if (t) xhr.setRequestHeader('X-CSRF-Token', t);
    xhr.upload.onprogress = function (ev) {
      if (ev.lengthComputable && ev.total > 0) btn.textContent = 'Uploading ' + Math.floor((ev.loaded / ev.total) * 100) + '%…';
    };
    xhr.upload.onload = function () { btn.textContent = 'Validating…'; };
    function done(r) { btn.disabled = false; btn.textContent = label; if (box) render(box, r); }
    xhr.onload = function () {
      var r;
      try { r = JSON.parse(xhr.responseText); } catch (e) { r = { valid: false, error: 'Unexpected answer from the console (HTTP ' + xhr.status + ').' }; }
      done(r);
    };
    xhr.onerror = function () { done({ valid: false, error: 'The file could not be sent (network error).' }); };
    btn.textContent = 'Uploading…';
    xhr.send(fd);
  };
})();
