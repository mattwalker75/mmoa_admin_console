// public/js/csrf.js — sends the page's CSRF token with every state-changing
// request. Loaded FIRST (plain, non-deferred) in both layouts in
// views/layout.js so the fetch wrapper is in place before Alpine or any
// other script runs. See middleware/csrf.js for the server side.
//
//   window.csrfToken()  → the token from <meta name="csrf-token">
//
// 1. window.fetch is wrapped: a same-origin request whose method is not
//    GET / HEAD / OPTIONS gets an X-CSRF-Token header unless the caller
//    already set one. Every fetch in the console (Alpine x-data handlers,
//    image-upload.js, the backup / website / settings pages) goes through
//    the global fetch, so no caller needs to change.
// 2. Plain <form method="POST"> submissions carry the token as a hidden
//    _csrf input that views/layout.js injects — nothing to do here — EXCEPT
//    multipart/form-data forms: the server validates the token before multer
//    parses the multipart body, so a hidden input there is invisible to it.
//    Those forms (backup restore / bundle upload, Settings → Appearance,
//    Web App Website image upload) are submitted here through fetch instead,
//    which adds the header; the response is followed like a normal
//    submission (every such route redirects back to its page).
//
// External file (not inline) because the CSP has no 'unsafe-inline'.
(function () {
  'use strict';

  var HEADER = 'X-CSRF-Token';
  var SAFE_METHODS = { GET: true, HEAD: true, OPTIONS: true };

  function token() {
    var m = document.querySelector('meta[name="csrf-token"]');
    return (m && m.getAttribute('content')) || '';
  }
  window.csrfToken = token;

  function sameOrigin(url) {
    try { return new URL(String(url), window.location.href).origin === window.location.origin; }
    catch (e) { return false; }
  }

  // ── fetch wrapper ───────────────────────────────────────────────────────
  if (typeof window.fetch === 'function' && typeof window.Headers === 'function') {
    var nativeFetch = window.fetch;
    window.fetch = function (input, init) {
      try {
        var isRequest = (typeof Request === 'function') && (input instanceof Request);
        var url = isRequest ? input.url : (input && typeof input.url === 'string' ? input.url : String(input));
        var method = String((init && init.method) || (isRequest && input.method) || 'GET').toUpperCase();
        var t = token();
        if (t && !SAFE_METHODS[method] && sameOrigin(url)) {
          if (init || !isRequest) {
            init = Object.assign({}, init);
            var h = new Headers(init.headers || (isRequest ? input.headers : undefined));
            if (!h.has(HEADER)) h.set(HEADER, t);
            init.headers = h;
          } else {
            // A bare Request object: rebuild it with the extra header.
            var rh = new Headers(input.headers);
            if (!rh.has(HEADER)) rh.set(HEADER, t);
            input = new Request(input, { headers: rh });
          }
        }
      } catch (e) { /* never let the wrapper break a request */ }
      // Always call the real fetch on the window. Alpine (and any bare
      // `fetch(...)` call) can hand us an undefined or foreign receiver, and
      // Safari refuses to run fetch on anything but the window.
      return nativeFetch.call(window, input, init);
    };
  }

  // ── native multipart forms → fetch ──────────────────────────────────────
  function attr(el, name) { return (el.getAttribute(name) || '').trim(); }

  function submitMultipartViaFetch(e) {
    var form = e.target;
    if (!form || form.tagName !== 'FORM' || e.defaultPrevented) return;
    if (attr(form, 'method').toUpperCase() !== 'POST') return;
    if (attr(form, 'enctype').toLowerCase() !== 'multipart/form-data') return;
    if (typeof FormData !== 'function' || typeof window.fetch !== 'function') return;
    var sub = e.submitter || null;
    var action = (sub && sub.hasAttribute('formaction')) ? attr(sub, 'formaction') : (attr(form, 'action') || window.location.href);
    if (!sameOrigin(action)) return;
    if (form.dataset.csrfSubmitting === '1') { e.preventDefault(); return; }
    e.preventDefault();
    form.dataset.csrfSubmitting = '1';

    var fd = new FormData(form);
    if (sub && sub.name) fd.append(sub.name, sub.value || '');
    var buttons = form.querySelectorAll('button[type="submit"], input[type="submit"], button:not([type])');
    var wasDisabled = [];
    for (var i = 0; i < buttons.length; i++) { wasDisabled.push(buttons[i].disabled); buttons[i].disabled = true; }
    function restore() {
      delete form.dataset.csrfSubmitting;
      for (var j = 0; j < buttons.length; j++) buttons[j].disabled = wasDisabled[j];
    }

    // XHR rather than fetch so a long upload (a backup file can be large)
    // shows its progress on the button, then a "restoring" state until the
    // server answers. The CSRF header is added here (XHR doesn't go through
    // the fetch wrapper).
    var label = buttons.length ? buttons[buttons.length - 1] : null;
    var labelText = label ? label.textContent : '';
    function say(t) { if (label) label.textContent = t; }
    function restoreAll() { restore(); say(labelText); document.body.style.cursor = ''; }
    function failed(msg) {
      restoreAll();
      if (typeof window.uiConfirm === 'function') window.uiConfirm(msg, { title: 'Upload failed', confirmLabel: 'OK', danger: false });
      else window.alert(msg);
    }
    try {
      var xhr = new XMLHttpRequest();
      xhr.open('POST', action, true);
      xhr.withCredentials = true;
      var t = token();
      if (t) xhr.setRequestHeader(HEADER, t);
      xhr.upload.onprogress = function (ev) {
        if (ev.lengthComputable && ev.total > 0) say('Uploading ' + Math.floor((ev.loaded / ev.total) * 100) + '%…');
      };
      xhr.upload.onload = function () { say('Working — keep this page open…'); };
      xhr.onload = function () {
        var finalUrl = xhr.responseURL || '';
        if (finalUrl && finalUrl.split('#')[0] !== new URL(action, window.location.href).href) { window.location.assign(finalUrl); return; }
        // No redirect (an error page such as 403 / 413): show it in place.
        document.open(); document.write(xhr.responseText); document.close();
      };
      xhr.onerror = function () { failed('The upload could not be sent (network error).'); };
      xhr.onabort = function () { failed('The upload was cancelled.'); };
      document.body.style.cursor = 'progress';
      say('Uploading…');
      xhr.send(fd);
    } catch (err) {
      failed('The upload could not be sent: ' + ((err && err.message) || err));
    }
  }

  document.addEventListener('submit', submitMultipartViaFetch, false);
})();
