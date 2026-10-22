// helpers/templatePicker.js — the "Templates" drop-down shown above a raffle
// text field ("How to buy", "Claim requirements"). Options:
//   Load a template   → replaces the field's text (asks first if it differs)
//   Save as new…      → an inline name box; saves the field's text as a new template
//   Update “<name>”   → overwrites the template last loaded / saved here
//   Manage templates… → Settings → Templates in a new tab
// Templates live on the console's server (helpers/templates.js); this talks
// to GET /templates/<kind>.json and POST /templates/<kind> (routes/templates.js).
// Loading marks the form as changed (window.mmoaFormDirty) like typing would.

'use strict';

const { escapeHtml } = require('../views/escapeHtml');

function templatePicker(kind, targetId, label) {
  return `<div class="flex items-center gap-2 flex-wrap" data-kind="${escapeHtml(kind)}" data-target="${escapeHtml(targetId)}"
       x-data="{ kind: '', target: '', list: [], current: null, naming: false, name: '', busy: false, msg: '', err: '',
         init() { this.kind = this.$el.dataset.kind; this.target = this.$el.dataset.target; this.refresh(); },
         ta() { return document.getElementById(this.target); },
         async refresh() {
           try { const r = await fetch('/templates/' + this.kind + '.json', { headers: { Accept: 'application/json' } }); const j = await r.json(); this.list = j.templates || []; }
           catch (e) { this.err = 'Templates could not be loaded.'; }
         },
         say(m) { this.msg = m; this.err = ''; setTimeout(() => { if (this.msg === m) this.msg = ''; }, 4000); },
         async choose(v) {
           this.err = '';
           if (v === 'new') { this.naming = true; this.name = ''; this.$nextTick(() => this.$refs.name && this.$refs.name.focus()); return; }
           if (v === 'update') { return this.update(); }
           if (v === 'manage') { window.open('/settings/templates', '_blank', 'noopener'); return; }
           if (v.startsWith('load:')) {
             const t = this.list.find(x => x.id === v.slice(5)); if (!t) return;
             const ta = this.ta(), cur = ta.value.trim();
             if (cur && cur !== t.content.trim() && !(await window.uiConfirm('Replace the current text with the “' + t.name + '” template?', { title: 'Load template', confirmLabel: 'Replace', danger: false }))) return;
             ta.value = t.content; ta.dispatchEvent(new Event('input', { bubbles: true }));
             this.current = { id: t.id, name: t.name }; this.say('Loaded “' + t.name + '”.');
           }
         },
         async post(body) {
           this.busy = true;
           try {
             const r = await fetch('/templates/' + this.kind, { method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/json' }, body: JSON.stringify(body) });
             const j = await r.json().catch(() => ({}));
             if (!r.ok) { this.err = j.error || 'Save failed.'; return null; }
             this.list = j.templates || this.list; this.current = { id: j.id, name: j.name }; return j;
           } catch (e) { this.err = 'Network error — template not saved.'; return null; }
           finally { this.busy = false; }
         },
         async saveNew() {
           const j = await this.post({ name: this.name, content: this.ta().value });
           if (j) { this.naming = false; this.say('Saved as “' + j.name + '”.'); }
         },
         async update() {
           if (!this.current) return;
           if (!(await window.uiConfirm('Overwrite the “' + this.current.name + '” template with the text in this box?', { title: 'Update template', confirmLabel: 'Update', danger: false }))) return;
           const j = await this.post({ id: this.current.id, name: this.current.name, content: this.ta().value });
           if (j) this.say('Updated “' + j.name + '”.');
         } }">
    <label class="sr-only" for="${escapeHtml(targetId)}-tpl">${escapeHtml(label)} templates</label>
    <select id="${escapeHtml(targetId)}-tpl" class="input w-auto py-1 text-xs" x-on:change="choose($event.target.value); $event.target.value = ''">
      <option value="">Templates…</option>
      <optgroup label="Load a template">
        <template x-for="t in list" :key="t.id"><option :value="'load:' + t.id" x-text="t.name"></option></template>
      </optgroup>
      <optgroup label="Save this text">
        <option value="new">Save as new template…</option>
        <option value="update" :disabled="!current" x-text="current ? 'Update “' + current.name + '”' : 'Update (load or save one first)'"></option>
      </optgroup>
      <option value="manage">Manage templates…</option>
    </select>
    <span x-show="naming" x-cloak class="inline-flex items-center gap-1">
      <input x-ref="name" class="input py-1 text-xs w-48" type="text" maxlength="80" placeholder="Template name" x-model="name"
             x-on:keydown.enter.prevent="saveNew()" x-on:keydown.escape.prevent="naming = false" aria-label="New template name">
      <button type="button" class="btn-primary text-xs px-2 py-1" x-on:click="saveNew()" :disabled="busy || !name.trim()">Save</button>
      <button type="button" class="btn-secondary text-xs px-2 py-1" x-on:click="naming = false">Cancel</button>
    </span>
    <span x-show="msg" x-cloak class="text-xs text-emerald-700 dark:text-emerald-300" x-text="msg"></span>
    <span x-show="err" x-cloak class="text-xs text-red-600 dark:text-red-300" role="alert" x-text="err"></span>
  </div>`;
}

module.exports = { templatePicker };
