// helpers/flyerButton.js — "✨ Generate flyer" (events and raffles): a button
// beside the flyer upload that draws a flyer in the browser
// (public/js/flyer-maker.js) from the form's CURRENT values + a saved photo,
// shows it in a pop-up, and "Use as flyer" uploads it through the normal
// flyer upload (window.macUploadImage → action). If the form has unsaved
// edits (window.mmoaFormDirty) the form is then saved too; the page reloads
// either way, so nothing is lost. Download saves a copy.
//
// flyerButton({ action, formId, kind: 'event' | 'raffle', photoRel, photoWord, siteUrl })
//   photoRel  uploads/-relative path of the background photo (or '')
//   photoWord how to name it: 'cover photo' / 'first prize photo'
//   siteUrl   the page's address shown on the flyer (no scheme)

'use strict';

const { escapeHtml } = require('../views/escapeHtml');

function flyerButton({ action, formId, kind, photoRel, photoWord, siteUrl }) {
  const noun = kind === 'raffle' ? 'raffle' : 'event';
  const collector = kind === 'raffle' ? 'collectRaffle' : 'collect';
  return `<div class="pt-1 flex items-center gap-2 flex-wrap" data-action="${escapeHtml(action)}" data-form="${escapeHtml(formId)}"
       data-cover="${photoRel ? '/wa-uploads/' + escapeHtml(photoRel) : ''}" data-url="${escapeHtml(siteUrl || '')}"
       x-data="{ cfg: {}, busy: false, err: '', ready: false, dirty: false,
         init() { this.cfg = Object.assign({}, this.$el.dataset); },
         async open() {
           this.err = ''; this.ready = false; this.dirty = !!window.mmoaFormDirty;
           this.$refs.dlg.showModal();
           try {
             const d = window.mmoaFlyer.${collector}(document.getElementById(this.cfg.form), { coverUrl: this.cfg.cover, url: this.cfg.url, orgName: 'Mission Men of Anna' });
             await window.mmoaFlyer.render(this.$refs.cv, d);
             this.ready = true;
           } catch (e) { this.err = 'Could not draw the flyer: ' + (e.message || e); }
         },
         use() {
           this.busy = true; this.err = '';
           this.$refs.cv.toBlob(b => {
             if (!b) { this.err = 'Could not encode the flyer image — try again.'; this.busy = false; return; }
             const file = new File([b], 'generated-flyer.jpg', { type: 'image/jpeg' });
             window.macUploadImage(this.cfg.action, file).then(r => {
               if (!r.ok) { this.err = r.error || 'Upload failed'; this.busy = false; return; }
               if (!this.dirty) { window.location.reload(); return; }
               // Saving the unsaved edits too: an invalid form would make
               // requestSubmit() fail silently behind this dialog, so check
               // first. The flyer is already uploaded — reload shows it.
               const form = document.getElementById(this.cfg.form);
               if (form && form.reportValidity()) { form.requestSubmit(); return; }
               this.err = 'Flyer uploaded. Your other edits were not saved because a field is invalid — reloading…';
               setTimeout(() => window.location.reload(), 2500);
             }).catch(e => { this.err = 'Upload failed: ' + (e && e.message || e); this.busy = false; });
           }, 'image/jpeg', 0.9);
         },
         download() {
           const a = document.createElement('a');
           a.href = this.$refs.cv.toDataURL('image/jpeg', 0.92); a.download = '${noun}-flyer.jpg';
           document.body.appendChild(a); a.click(); a.remove();
         } }">
    <span class="text-xs text-slate-500 dark:text-slate-400">or</span>
    <button type="button" class="btn-secondary text-sm" x-on:click="open()" aria-haspopup="dialog">✨ Generate flyer</button>
    <span class="text-xs text-slate-500 dark:text-slate-400">from this ${noun}'s details${photoRel ? ' and ' + photoWord : ' (add a ' + photoWord + ' for a picture)'}</span>
    <dialog x-ref="dlg" aria-labelledby="fm-title" x-on:click="if ($event.target === $refs.dlg) $refs.dlg.close()"
            class="m-auto p-0 rounded-xl bg-white dark:bg-slate-900 text-slate-900 dark:text-slate-100 shadow-2xl backdrop:bg-black/70 w-[96vw] max-w-[760px] max-h-[94vh]">
      <div class="flex max-h-[94vh] flex-col">
        <div class="flex items-center justify-between gap-3 flex-wrap border-b border-slate-200 dark:border-slate-700 px-4 py-2">
          <div class="min-w-0">
            <strong id="fm-title" class="text-sm">Generated flyer</strong>
            <p class="text-xs text-slate-500 dark:text-slate-400">Made from what's in the form now${photoRel ? ' and the ' + photoWord : ''}. Edit the ${noun} and generate again to change it.</p>
          </div>
          <div class="flex items-center gap-2">
            <button type="button" class="btn-secondary text-xs px-3 py-1.5" x-on:click="download()" :disabled="!ready">Download</button>
            <button type="button" class="btn-primary text-xs px-3 py-1.5" x-on:click="use()" :disabled="!ready || busy">
              <span x-show="!busy">Use as flyer</span><span x-show="busy" x-cloak>Uploading…</span></button>
            <button type="button" class="btn-secondary text-xs px-3 py-1.5" x-on:click="$refs.dlg.close()" autofocus>Close</button>
          </div>
        </div>
        <p class="mx-4 mt-3 text-xs text-amber-700 dark:text-amber-300" x-show="dirty" x-cloak>You have unsaved changes — "Use as flyer" saves them too.</p>
        <div x-show="err" x-cloak class="mx-4 mt-3 flash-error text-sm" role="alert" x-text="err"></div>
        <div class="flex-1 min-h-0 overflow-auto p-4 bg-slate-100 dark:bg-black/40 flex justify-center">
          <canvas x-ref="cv" class="block h-auto max-h-[72vh] w-auto max-w-full rounded-lg shadow" role="img" aria-label="Generated ${noun} flyer"></canvas>
        </div>
      </div>
    </dialog>
  </div>`;
}

module.exports = { flyerButton };
