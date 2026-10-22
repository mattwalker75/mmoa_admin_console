// public/js/date-picker.js — calendar + time picker for the console's date
// fields, built on flatpickr (self-hosted: /js/flatpickr.min.js).
//
// Any <input data-datetime> becomes a picker. The form still submits the
// same 'YYYY-MM-DDTHH:MM' value a datetime-local input would (in the
// organization's time zone — the server converts it), so routes need no
// change; people see a friendly "Sat, Dec 5, 2026 · 9:00 AM" and can still
// type a date.
//
// Options (data attributes on the input):
//   data-min-from="#other"   this field can't be earlier than #other's value
//                            (e.g. Ends ≥ Starts); kept in step as #other changes
//
// window.mmoaDatePicker(el) returns the flatpickr instance (or null) so page
// code can set / clear a value.
(function () {
  'use strict';
  if (!window.flatpickr) return; // script missing → plain text input still works

  var VALUE_FMT = 'Y-m-d\\TH:i';

  function init(el) {
    if (el._flatpickr) return el._flatpickr;
    var fp = window.flatpickr(el, {
      enableTime: true,
      dateFormat: VALUE_FMT,
      altInput: true,
      altFormat: 'D, M j, Y · h:i K',
      allowInput: true,
      minuteIncrement: 15,
      time_24hr: false,
      monthSelectorType: 'static',
      // Re-read the typed text when the field loses focus.
      onClose: function (sel, str, inst) { if (inst.altInput && inst.altInput.value === '') inst.clear(); }
    });
    // The visible (alt) input takes over the label's for= target.
    if (fp.altInput && el.id) {
      fp.altInput.id = el.id + '-display';
      var lbl = document.querySelector('label[for="' + el.id + '"]');
      if (lbl) lbl.setAttribute('for', fp.altInput.id);
      if (el.required) fp.altInput.required = true;
    }
    return fp;
  }

  function linkMin(el) {
    var src = document.querySelector(el.getAttribute('data-min-from'));
    if (!src || !src._flatpickr || !el._flatpickr) return;
    var apply = function () { el._flatpickr.set('minDate', src._flatpickr.selectedDates[0] || null); };
    src._flatpickr.config.onChange.push(apply);
    apply();
  }

  var inputs = document.querySelectorAll('input[data-datetime]');
  inputs.forEach(init);
  inputs.forEach(function (el) { if (el.hasAttribute('data-min-from')) linkMin(el); });

  window.mmoaDatePicker = function (el) { return el ? (el._flatpickr || init(el)) : null; };
})();
