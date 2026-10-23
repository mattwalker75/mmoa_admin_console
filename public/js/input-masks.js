// public/js/input-masks.js — "format as you type" helpers for console
// forms, mirrored from the web app's frontend core/formats.ts so an admin
// typing in the console sees exactly what a nonprofit sees on the site.
// Used from Alpine handlers: x-on:input="$el.value = window.typeEin($el.value)".
// External file (not inline) because the CSP has no 'unsafe-inline'.
(function () {
  'use strict';
  /** EIN as typed: digits only, '12-3456789' (dash added after 2 digits). */
  window.typeEin = function (v) {
    var d = String(v || '').replace(/\D/g, '').slice(0, 9);
    return d.length > 2 ? d.slice(0, 2) + '-' + d.slice(2) : d;
  };
})();
