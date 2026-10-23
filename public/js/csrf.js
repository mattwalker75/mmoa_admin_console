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
      return nativeFetch.call(this, input, init);
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

    window.fetch(action, { method: 'POST', body: fd, credentials: 'same-origin', redirect: 'follow' })
      .then(function (r) {
        if (r.redirected) { window.location.assign(r.url); return; }
        // No redirect (an error page such as 403 / 413): show it in place.
        return r.text().then(function (html) {
          document.open(); document.write(html); document.close();
        });
      })
      .catch(function (err) {
        restore();
        var msg = 'The upload could not be sent: ' + ((err && err.message) || err);
        if (typeof window.uiConfirm === 'function') window.uiConfirm(msg, { title: 'Upload failed', confirmLabel: 'OK', danger: false });
        else window.alert(msg);
      });
  }

  document.addEventListener('submit', submitMultipartViaFetch, false);
})();
