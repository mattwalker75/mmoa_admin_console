// routes/templates.js — Settings → Templates: reusable text for raffle fields
// ("How to buy", "Claim requirements"), stored as files on this console's
// server (helpers/templates.js), plus a small JSON API the raffle form's
// Templates drop-down uses.
//
//   GET  /settings/templates                  → where they're saved + manage each kind
//   POST /settings/templates/dir              → change the folder (appConfig.templates.dir)
//   POST /settings/templates/:kind/save       → create (no id) or update (id) — form
//   POST /settings/templates/:kind/:id/delete
//   GET  /templates/:kind.json                → { templates: [{ id, name, content }] }
//   POST /templates/:kind                     → JSON { id?, name, content } → { ok, id, templates }

'use strict';

const express = require('express');
const fs = require('fs');
const path = require('path');
const { page, flash } = require('../views/layout');
const { escapeHtml, jsAttrStr } = require('../views/escapeHtml');
const { requireAdmin } = require('../middleware/auth');
const tpl = require('../helpers/templates');
const { tabsNav } = require('./settings');

const TEXTAREA_CLS = 'block w-full rounded-lg border border-slate-200 bg-white px-3 py-2 text-sm text-slate-900 shadow-sm focus:border-brand-500 focus:outline-none focus:ring-2 focus:ring-brand-500/30 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-100';

function kindCard(kind, items) {
  const k = tpl.KINDS[kind];
  const rows = items.map(t => `
    <details class="rounded-lg border border-slate-200 dark:border-slate-700">
      <summary class="cursor-pointer px-3 py-2 text-sm font-medium text-slate-900 dark:text-slate-100">${escapeHtml(t.name)}
        <span class="ml-2 font-mono text-xs text-slate-400">${escapeHtml(t.id)}.json</span></summary>
      <div class="px-3 pb-3 space-y-2">
        <form method="POST" action="/settings/templates/${kind}/save" class="space-y-2">
          <input type="hidden" name="id" value="${escapeHtml(t.id)}">
          <div><label class="label">Name</label><input class="input" type="text" name="name" required maxlength="80" value="${escapeHtml(t.name)}"></div>
          <div><label class="label">Text</label><textarea name="content" rows="${Math.min(10, Math.max(3, t.content.split('\n').length + 1))}" maxlength="4000" required class="${TEXTAREA_CLS}">${escapeHtml(t.content)}</textarea></div>
          <div class="flex justify-end"><button type="submit" class="btn-primary text-sm">Save</button></div>
        </form>
        <form method="POST" action="/settings/templates/${kind}/${escapeHtml(t.id)}/delete" class="m-0 flex justify-end" x-data
              x-on:submit.prevent="window.uiConfirmSubmit($event.target, ${jsAttrStr('Delete the template "' + t.name + '"? Raffles that already used it keep their text.')}, { title: 'Delete template', confirmLabel: 'Delete' })">
          <button type="submit" class="btn-danger text-xs px-3 py-1">Delete template</button>
        </form>
      </div>
    </details>`).join('');
  return `<section class="card surface-target card-pad space-y-3">
    <div>
      <h2 class="text-base font-semibold text-slate-900 dark:text-slate-100">${escapeHtml(k.label)}</h2>
      <p class="mt-0.5 text-xs text-slate-500 dark:text-slate-400">${escapeHtml(k.hint)} Load these from the Templates drop-down above the field on a raffle.</p>
    </div>
    <div class="space-y-2">${rows || '<p class="text-sm text-slate-400 italic">No templates yet.</p>'}</div>
    <details class="rounded-lg border border-dashed border-slate-300 dark:border-slate-600">
      <summary class="cursor-pointer px-3 py-2 text-sm font-semibold text-brand-600">＋ New ${escapeHtml(k.label.toLowerCase())} template</summary>
      <form method="POST" action="/settings/templates/${kind}/save" class="px-3 pb-3 space-y-2">
        <div><label class="label">Name</label><input class="input" type="text" name="name" required maxlength="80" placeholder="e.g. Firearm — 21+"></div>
        <div><label class="label">Text</label><textarea name="content" rows="4" maxlength="4000" required class="${TEXTAREA_CLS}"></textarea></div>
        <div class="flex justify-end"><button type="submit" class="btn-primary text-sm">Create template</button></div>
      </form>
    </details>
  </section>`;
}

module.exports = function (appConfig, appConfigModule) {
  const router = express.Router();
  const KIND_RE = new RegExp('^(' + Object.keys(tpl.KINDS).join('|') + ')$');
  const back = '/settings/templates';

  router.get('/settings/templates', requireAdmin, (req, res) => {
    let cards = '', err = null;
    try { cards = Object.keys(tpl.KINDS).map(k => kindCard(k, tpl.list(appConfig, k))).join(''); }
    catch (e) { err = e.message || String(e); }
    const configured = (appConfig.templates && appConfig.templates.dir) || tpl.DEFAULT_DIR;
    const body = `
      <header class="mb-6">
        <h1 class="text-2xl font-bold text-slate-900 dark:text-slate-100">Settings</h1>
        <p class="mt-1 text-sm text-slate-500 dark:text-slate-400">Reusable text for raffles — "How to buy" and "Claim requirements".</p>
      </header>
      ${tabsNav('templates')}
      ${flash('error', req.query.error || (err ? 'Templates could not be read: ' + err : ''))}
      ${flash('success', req.query.msg)}
      <div class="max-w-3xl space-y-6">
        <section class="card surface-target card-pad space-y-3">
          <h2 class="text-base font-semibold text-slate-900 dark:text-slate-100">Where templates are saved</h2>
          <p class="text-xs text-slate-500 dark:text-slate-400">A folder on this admin console's server (one sub-folder per field, one <code>.json</code> file per template). A relative path is inside the console's folder. Changing it doesn't move existing templates — copy the files across yourself.</p>
          <form method="POST" action="/settings/templates/dir" class="flex items-end gap-2 flex-wrap">
            <div class="flex-1 min-w-[16rem]"><label class="label" for="tpl-dir">Folder</label>
              <input id="tpl-dir" class="input font-mono" type="text" name="dir" required maxlength="300" value="${escapeHtml(configured)}"></div>
            <button type="submit" class="btn-primary">Save folder</button>
          </form>
          <p class="text-xs text-slate-500 dark:text-slate-400">Currently: <code class="font-mono">${escapeHtml(tpl.baseDir(appConfig))}</code></p>
        </section>
        ${cards}
      </div>`;
    res.send(page({ title: 'Settings — Templates', body, appConfig, user: req.session.user, activeNav: 'settings' }));
  });

  router.post('/settings/templates/dir', requireAdmin, (req, res) => {
    const dir = String((req.body && req.body.dir) || '').trim();
    if (!dir || dir.length > 300 || /[\0\n\r]/.test(dir)) return res.redirect(back + '?error=' + encodeURIComponent('Enter a folder path.'));
    const abs = path.resolve(path.join(__dirname, '..'), dir);
    try { fs.mkdirSync(abs, { recursive: true }); fs.accessSync(abs, fs.constants.W_OK); }
    catch (e) { return res.redirect(back + '?error=' + encodeURIComponent(`Can't use that folder: ${e.message}`)); }
    appConfig.templates = Object.assign({}, appConfig.templates, { dir });
    appConfigModule.save();
    res.redirect(back + '?msg=' + encodeURIComponent(`Templates are now saved in ${abs}.`));
  });

  router.post('/settings/templates/:kind/save', requireAdmin, (req, res) => {
    const kind = req.params.kind;
    if (!KIND_RE.test(kind)) return res.redirect(back + '?error=Unknown+template+type');
    try {
      const b = req.body || {};
      const r = tpl.save(appConfig, kind, { id: b.id || null, name: b.name, content: b.content });
      res.redirect(back + '?msg=' + encodeURIComponent(`Template “${r.name}” saved.`));
    } catch (e) {
      res.redirect(back + '?error=' + encodeURIComponent(e instanceof tpl.TemplateError ? e.message : 'Save failed: ' + (e.message || e)));
    }
  });

  router.post('/settings/templates/:kind/:id/delete', requireAdmin, (req, res) => {
    const kind = req.params.kind;
    if (!KIND_RE.test(kind)) return res.redirect(back + '?error=Unknown+template+type');
    try { tpl.remove(appConfig, kind, req.params.id); res.redirect(back + '?msg=Template+deleted.'); }
    catch (e) { res.redirect(back + '?error=' + encodeURIComponent(e instanceof tpl.TemplateError ? e.message : 'Delete failed: ' + (e.message || e))); }
  });

  // ── JSON for the raffle form's Templates drop-down ─────────────────────
  router.get('/templates/:kind.json', requireAdmin, (req, res) => {
    if (!KIND_RE.test(req.params.kind)) return res.status(404).json({ error: 'Unknown template type' });
    try { res.json({ templates: tpl.list(appConfig, req.params.kind) }); }
    catch (e) { res.status(500).json({ error: 'Templates could not be read: ' + (e.message || e) }); }
  });

  router.post('/templates/:kind', requireAdmin, express.json({ limit: '32kb' }), (req, res) => {
    const kind = req.params.kind;
    if (!KIND_RE.test(kind)) return res.status(404).json({ error: 'Unknown template type' });
    try {
      const b = req.body || {};
      const r = tpl.save(appConfig, kind, { id: b.id || null, name: b.name, content: b.content });
      res.json({ ok: true, id: r.id, name: r.name, templates: tpl.list(appConfig, kind) });
    } catch (e) {
      res.status(e instanceof tpl.TemplateError ? 400 : 500).json({ error: e instanceof tpl.TemplateError ? e.message : 'Save failed: ' + (e.message || e) });
    }
  });

  return router;
};
