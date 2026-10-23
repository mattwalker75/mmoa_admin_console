// routes/directory.js — the "Need Help?" directory's lookup lists: service
// categories (Food, Housing & shelter, …) and service cities (Anna, Melissa,
// …). Nonprofits tick these on their profile; visitors search by them.
//
//   GET  /categories-cities                     → both lists
//   POST /categories-cities/:list/add           → list = categories | cities
//   POST /categories-cities/:list/:id/save      → rename (+ slug for categories)
//   POST /categories-cities/:list/:id/move      → dir = up | down
//   POST /categories-cities/:list/:id/active    → state = 1 | 0
//   POST /categories-cities/:list/:id/delete    → only when no organization uses it
//
// Deactivating hides an entry from the website's search and the portal's
// pickers without touching the organizations that already chose it — the
// safe way to retire one that is in use. Hard delete is refused while any
// org_categories / org_cities row points at it.
//
// Category slugs appear in public URLs (/need-help?category=food), so they
// are validated (lowercase letters, digits, dashes) and changing one is
// flagged in the UI.
//
// Built-in categories (BUILTIN_SLUGS) are ones the web app relies on and
// re-creates on every start (its db ROW_MIGRATIONS) — today just "other",
// which the search summary reads as "other needs". They can be renamed,
// reordered and deactivated, but their slug is locked and they can't be
// deleted: either would just make the web app add a duplicate on restart.

const express = require('express');
const { page, flash } = require('../views/layout');
const { escapeHtml, jsAttrStr } = require('../views/escapeHtml');
const { requireAdmin } = require('../middleware/auth');
const kit = require('../helpers/pageKit');

// Table metadata per list. Every identifier here is a code constant.
const LISTS = {
  categories: { table: 'categories', id: 'category_id', join: 'org_categories', label: 'Categories', one: 'category', hasSlug: true },
  cities: { table: 'cities', id: 'city_id', join: 'org_cities', label: 'Cities', one: 'city', hasSlug: false }
};

const BUILTIN_SLUGS = new Set(['other']);
const isBuiltin = (L, r) => !!(L.hasSlug && r && BUILTIN_SLUGS.has(r.slug));

function uniqueMsg(err, L) {
  return /UNIQUE|Duplicate entry/i.test(String(err && err.message))
    ? (L.hasSlug ? 'That name or slug is already used by another category.' : 'That city is already in the list.') : null;
}

function listCard(key, L, rows, usage) {
  const trs = rows.map((r, i) => {
    const id = Number(r[L.id]);
    const used = usage.get(id) || 0;
    const active = !!Number(r.is_active);
    const builtin = isBuiltin(L, r);
    return `<tr class="${active ? '' : 'opacity-60'}" x-data="{ edit: false }">
      <td class="w-16 whitespace-nowrap">
        <form method="POST" action="/categories-cities/${key}/${id}/move" class="inline m-0"><input type="hidden" name="dir" value="up">
          <button type="submit" class="btn-ghost text-xs px-1.5 py-0.5" ${i === 0 ? 'disabled' : ''} aria-label="Move up">▲</button></form>
        <form method="POST" action="/categories-cities/${key}/${id}/move" class="inline m-0"><input type="hidden" name="dir" value="down">
          <button type="submit" class="btn-ghost text-xs px-1.5 py-0.5" ${i === rows.length - 1 ? 'disabled' : ''} aria-label="Move down">▼</button></form>
      </td>
      <td>
        <div x-show="!edit">
          <span class="font-medium text-slate-900 dark:text-slate-100">${escapeHtml(r.name)}</span>
          ${L.hasSlug ? `<span class="ml-2 font-mono text-xs text-slate-400">${escapeHtml(r.slug)}</span>` : ''}
          ${builtin ? `<span class="ml-2 pill-terminated" title="The website relies on this category: it can be renamed or deactivated, but not deleted or given a new slug.">built-in</span>` : ''}
        </div>
        <form x-show="edit" x-cloak method="POST" action="/categories-cities/${key}/${id}/save" class="m-0 flex items-center gap-2 flex-wrap">
          <input class="input max-w-[14rem]" type="text" name="name" required maxlength="100" value="${escapeHtml(r.name)}" aria-label="Name">
          ${L.hasSlug ? `<input class="input max-w-[10rem] font-mono" type="text" name="slug" required maxlength="60" pattern="[a-z0-9-]+" value="${escapeHtml(r.slug)}" aria-label="Slug" ${builtin ? 'readonly title="Built-in category — its slug can\'t be changed"' : 'title="Changing the slug breaks saved links to this category"'}>` : ''}
          <button type="submit" class="btn-primary text-xs px-3 py-1">Save</button>
          <button type="button" class="btn-secondary text-xs px-3 py-1" x-on:click="edit = false">Cancel</button>
        </form>
      </td>
      <td class="text-xs text-slate-500 whitespace-nowrap">${used} org${used === 1 ? '' : 's'}</td>
      <td class="whitespace-nowrap">${active ? '<span class="pill-running">Active</span>' : '<span class="pill-terminated">Inactive</span>'}</td>
      <td class="text-right whitespace-nowrap">
        <button type="button" class="btn-ghost text-xs px-2 py-1" x-on:click="edit = !edit">Rename</button>
        <form method="POST" action="/categories-cities/${key}/${id}/active" class="inline m-0">
          <input type="hidden" name="state" value="${active ? '0' : '1'}">
          <button type="submit" class="btn-ghost text-xs px-2 py-1">${active ? 'Deactivate' : 'Activate'}</button>
        </form>
        ${builtin ? `<span class="text-xs text-slate-400 px-2" title="Built-in category — deactivate it instead">Delete</span>`
          : used ? `<span class="text-xs text-slate-400 px-2" title="In use — deactivate it instead">Delete</span>`
          : `<form method="POST" action="/categories-cities/${key}/${id}/delete" class="inline m-0"
                x-on:submit.prevent="window.uiConfirmSubmit($event.target, ${jsAttrStr('Delete the ' + L.one + ' "' + r.name + '"?')}, { title: 'Delete ${L.one}', confirmLabel: 'Delete' })">
              <button type="submit" class="btn-ghost text-xs px-2 py-1 text-red-600">Delete</button></form>`}
      </td>
    </tr>`;
  }).join('');
  return `<section class="card surface-target card-pad">
    <h2 class="text-base font-semibold text-slate-900 dark:text-slate-100">${L.label}</h2>
    <p class="mt-0.5 text-xs text-slate-500 dark:text-slate-400">Order here is the order on the website. Entries in use can't be deleted — deactivate them instead.</p>
    <form method="POST" action="/categories-cities/${key}/add" class="mt-4 flex items-center gap-2 flex-wrap">
      <input class="input max-w-[16rem]" type="text" name="name" required maxlength="100" placeholder="New ${L.one} name" aria-label="New ${L.one} name">
      ${L.hasSlug ? `<input class="input max-w-[10rem] font-mono" type="text" name="slug" maxlength="60" pattern="[a-z0-9-]*" placeholder="slug (auto)" aria-label="Slug">` : ''}
      <button type="submit" class="btn-primary text-sm">Add</button>
    </form>
    <div class="mt-4 overflow-x-auto">
      <table class="table-base">
        <thead><tr><th>Order</th><th>Name</th><th>Used by</th><th>Status</th><th></th></tr></thead>
        <tbody>${trs || `<tr><td colspan="5" class="text-center py-6 text-slate-400">None yet.</td></tr>`}</tbody>
      </table>
    </div>
  </section>`;
}

module.exports = function (db, appConfig) {
  const router = express.Router();
  const back = '/categories-cities';
  const audit = require('../helpers/audit')(db);
  // Name of a list row for an audit label; null if gone / DB down.
  const nameOf = (L, id) => db.getAsync(`SELECT name FROM ${L.table} WHERE ${L.id} = ?`, [id]).then(r => (r && r.name) || null).catch(() => null);

  router.get('/categories-cities', requireAdmin, async (req, res) => {
    const user = req.session.user;
    const cards = [];
    let firstErr = null;
    for (const [key, L] of Object.entries(LISTS)) {
      const { rows, err } = await kit.safeAll(db, `SELECT * FROM ${L.table} ORDER BY sort, ${L.id}`, []);
      const u = await kit.safeAll(db, `SELECT ${L.id} AS id, COUNT(*) AS c FROM ${L.join} GROUP BY ${L.id}`, []);
      firstErr = firstErr || err || u.err;
      cards.push(listCard(key, L, rows, new Map(u.rows.map(x => [Number(x.id), Number(x.c)]))));
    }
    const body = `
      ${kit.pageHeader('Categories & Cities', 'The services and service areas nonprofits pick on their profile, and visitors search by on "Need Help?".')}
      ${flash('error', req.query.error)}
      ${flash('success', req.query.msg)}
      ${kit.dbBanner(firstErr)}
      <div class="max-w-5xl space-y-6">${cards.join('')}</div>`;
    res.send(page({ title: 'Categories & Cities', body, appConfig, user, activeNav: 'categories-cities' }));
  });

  function listOf(req, res) {
    // Own keys only: ':list' = 'constructor' must not hit Object.prototype.
    const L = Object.hasOwn(LISTS, req.params.list) ? LISTS[req.params.list] : null;
    if (!L) { res.redirect(back + '?error=Unknown+list'); return null; }
    return L;
  }

  router.post('/categories-cities/:list/add', requireAdmin, async (req, res) => {
    const L = listOf(req, res); if (!L) return;
    const name = kit.str(req.body.name, 100);
    if (!name) return res.redirect(back + '?error=Name+is+required');
    try {
      const sort = await kit.nextSort(db, L.table);
      if (L.hasSlug) {
        const slug = kit.slugify(kit.str(req.body.slug, 60) || name).slice(0, 60);
        if (!kit.SLUG_RE.test(slug)) return res.redirect(back + '?error=' + encodeURIComponent('Slugs may only contain lowercase letters, digits and dashes.'));
        await db.runAsync(`INSERT INTO ${L.table} (slug, name, sort, is_active) VALUES (?, ?, ?, 1)`, [slug, name, sort]);
      } else {
        await db.runAsync(`INSERT INTO ${L.table} (name, sort, is_active) VALUES (?, ?, 1)`, [name, sort]);
      }
      await audit(req, `${L.one}.add`, { kind: L.one, label: name, summary: `Added ${L.one} "${name}"` });
      res.redirect(back + '?msg=' + encodeURIComponent(`Added "${name}".`));
    } catch (err) {
      res.redirect(back + '?error=' + encodeURIComponent(uniqueMsg(err, L) || ('Add failed: ' + (err.message || err))));
    }
  });

  router.post('/categories-cities/:list/:id/save', requireAdmin, async (req, res) => {
    const L = listOf(req, res); if (!L) return;
    const id = kit.idParam(req.params.id);
    const name = kit.str(req.body.name, 100);
    if (!id || !name) return res.redirect(back + '?error=Name+is+required');
    try {
      let r;
      const oldName = await nameOf(L, id);
      if (L.hasSlug) {
        const slug = kit.str(req.body.slug, 60);
        if (!slug || !kit.SLUG_RE.test(slug)) return res.redirect(back + '?error=' + encodeURIComponent('Slugs may only contain lowercase letters, digits and dashes.'));
        const cur = await db.getAsync(`SELECT slug FROM ${L.table} WHERE ${L.id} = ?`, [id]);
        if (isBuiltin(L, cur) && slug !== cur.slug) {
          return res.redirect(back + '?error=' + encodeURIComponent(`"${cur.slug}" is a built-in category — its slug can't be changed (the name can).`));
        }
        r = await db.runAsync(`UPDATE ${L.table} SET name = ?, slug = ? WHERE ${L.id} = ?`, [name, slug, id]);
      } else {
        r = await db.runAsync(`UPDATE ${L.table} SET name = ? WHERE ${L.id} = ?`, [name, id]);
      }
      if (!r.changes) return res.redirect(back + '?error=Not+found');
      await audit(req, `${L.one}.rename`, { kind: L.one, id, label: name,
        summary: oldName && oldName !== name ? `Renamed "${oldName}" → "${name}"` : `Saved "${name}"${L.hasSlug ? ' (name / slug)' : ''}` });
      res.redirect(back + '?msg=' + encodeURIComponent(`Saved "${name}".`));
    } catch (err) {
      res.redirect(back + '?error=' + encodeURIComponent(uniqueMsg(err, L) || ('Save failed: ' + (err.message || err))));
    }
  });

  router.post('/categories-cities/:list/:id/move', requireAdmin, async (req, res) => {
    const L = listOf(req, res); if (!L) return;
    const id = kit.idParam(req.params.id);
    if (!id) return res.redirect(back + '?error=Invalid+id');
    try {
      const dir = req.body && req.body.dir === 'up' ? 'up' : 'down';
      const moved = await kit.moveRow(db, L.table, L.id, id, dir);
      if (moved) await audit(req, `${L.one}.move`, { kind: L.one, id, label: await nameOf(L, id), summary: `Moved ${dir}` });
      res.redirect(back);
    } catch (err) {
      res.redirect(back + '?error=' + encodeURIComponent('Reorder failed: ' + (err.message || err)));
    }
  });

  router.post('/categories-cities/:list/:id/active', requireAdmin, async (req, res) => {
    const L = listOf(req, res); if (!L) return;
    const id = kit.idParam(req.params.id);
    if (!id) return res.redirect(back + '?error=Invalid+id');
    const on = (req.body && req.body.state) === '1';
    try {
      const r = await db.runAsync(`UPDATE ${L.table} SET is_active = ? WHERE ${L.id} = ?`, [on ? 1 : 0, id]);
      if (!r.changes) return res.redirect(back + '?error=Not+found');
      await audit(req, `${L.one}.active`, { kind: L.one, id, label: await nameOf(L, id), summary: on ? 'Activated' : 'Deactivated' });
      res.redirect(back + '?msg=' + encodeURIComponent(on ? 'Activated.' : 'Deactivated — hidden from the website and the portal.'));
    } catch (err) {
      res.redirect(back + '?error=' + encodeURIComponent('Update failed: ' + (err.message || err)));
    }
  });

  router.post('/categories-cities/:list/:id/delete', requireAdmin, async (req, res) => {
    const L = listOf(req, res); if (!L) return;
    const id = kit.idParam(req.params.id);
    if (!id) return res.redirect(back + '?error=Invalid+id');
    try {
      const row = await db.getAsync(`SELECT * FROM ${L.table} WHERE ${L.id} = ?`, [id]);
      if (isBuiltin(L, row)) {
        return res.redirect(back + '?error=' + encodeURIComponent('Built-in categories can\'t be deleted (the website would add it back on its next restart) — deactivate it instead.'));
      }
      const used = await db.getAsync(`SELECT COUNT(*) AS c FROM ${L.join} WHERE ${L.id} = ?`, [id]);
      if (used && Number(used.c) > 0) {
        return res.redirect(back + '?error=' + encodeURIComponent(`In use by ${used.c} organization(s) — deactivate it instead.`));
      }
      // Re-check inside the DELETE itself so an org that picked it a moment
      // ago isn't orphaned (portable NOT EXISTS; no read inside a transaction).
      const r = await db.runAsync(`DELETE FROM ${L.table} WHERE ${L.id} = ? AND NOT EXISTS (SELECT 1 FROM ${L.join} WHERE ${L.join}.${L.id} = ?)`, [id, id]);
      if (!r.changes) return res.redirect(back + '?error=' + encodeURIComponent('Not deleted — it is in use (or already gone).'));
      await audit(req, `${L.one}.delete`, { kind: L.one, id, label: row && row.name, summary: `Deleted ${L.one}` });
      res.redirect(back + '?msg=Deleted.');
    } catch (err) {
      res.redirect(back + '?error=' + encodeURIComponent('Delete failed: ' + (err.message || err)));
    }
  });

  return router;
};
