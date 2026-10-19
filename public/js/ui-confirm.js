// public/js/ui-confirm.js — shared in-app confirmation dialog.
//
// Loaded as an EXTERNAL script (not inline) on purpose: the app's
// Content-Security-Policy is `script-src 'self' 'unsafe-eval'` with no
// 'unsafe-inline', so an inline <script> would be silently blocked and
// window.uiConfirm would never be defined. Served from /js (which is
// 'self'), this runs normally.
//
// Why this exists at all: native window.confirm() is unreliable on Safari —
// after a few JS dialogs it offers "Don't allow this page to prompt you
// again" and then silently returns false, which made destructive buttons
// (Delete, Unlock, …) appear to do nothing. uiConfirm() renders the
// in-app modal in views/layout.js (#ui-confirm-overlay) and resolves a
// Promise, so it behaves identically across browsers.
(function () {
  var overlay, titleEl, msgEl, okBtn, cancelBtn, resolver = null;

  function settle(val) {
    if (overlay) { overlay.classList.add('hidden'); overlay.classList.remove('flex'); }
    document.removeEventListener('keydown', onKey, true);
    var r = resolver; resolver = null;
    if (r) r(val);
  }

  function onKey(e) {
    if (e.key === 'Escape') { e.preventDefault(); settle(false); }
    else if (e.key === 'Enter') { e.preventDefault(); settle(true); }
  }

  function init() {
    overlay = document.getElementById('ui-confirm-overlay');
    titleEl = document.getElementById('ui-confirm-title');
    msgEl = document.getElementById('ui-confirm-message');
    okBtn = document.getElementById('ui-confirm-ok');
    cancelBtn = document.getElementById('ui-confirm-cancel');
    if (okBtn) okBtn.addEventListener('click', function () { settle(true); });
    if (cancelBtn) cancelBtn.addEventListener('click', function () { settle(false); });
    if (overlay) overlay.addEventListener('click', function (e) { if (e.target === overlay) settle(false); });
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();

  // Promise<boolean>. opts: { title, confirmLabel, cancelLabel, danger }.
  window.uiConfirm = function (message, opts) {
    opts = opts || {};
    return new Promise(function (resolve) {
      // The overlay element may not be parsed yet if uiConfirm is somehow
      // called extremely early; resolve it lazily.
      if (!overlay) overlay = document.getElementById('ui-confirm-overlay');
      if (!overlay) { resolve(window.confirm(message)); return; }
      if (!titleEl) init();
      // Resolve any dialog already open as a cancel before reusing it.
      if (resolver) { var prev = resolver; resolver = null; prev(false); }
      titleEl.textContent = opts.title || 'Please confirm';
      msgEl.textContent = message || '';
      okBtn.textContent = opts.confirmLabel || 'Confirm';
      if (cancelBtn) cancelBtn.textContent = opts.cancelLabel || 'Cancel';
      okBtn.className = (opts.danger === false ? 'btn-primary' : 'btn-danger');
      // Alpine's x-trap.inert marks body-level siblings inert while a modal
      // is open; clear it so this dialog stays clickable when raised from
      // within another modal (e.g. a member modal).
      overlay.removeAttribute('inert');
      overlay.classList.remove('hidden');
      overlay.classList.add('flex');
      resolver = resolve;
      document.addEventListener('keydown', onKey, true);
    });
  };

  // Convenience for form buttons: capture the form element synchronously
  // (so we never rely on Alpine's $el inside the async callback) and submit
  // it programmatically once confirmed. form.submit() bypasses the submit
  // event, so it won't re-trigger this confirmation.
  window.uiConfirmSubmit = function (form, message, opts) {
    if (!form || typeof form.submit !== 'function') return;
    window.uiConfirm(message, opts).then(function (ok) { if (ok) form.submit(); });
  };
})();
