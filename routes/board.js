// routes/board.js — the board of directors shown on the website's About page
// (the web app's `board_members` table: one row per ROLE, with the person
// who currently holds it).
//
//   GET  /board                     → every role, in website order
//   POST /board/add                 → new role (title + description)
//   POST /board/:id/save            → role title, description, person name
//   POST /board/:id/move            → dir = up | down
//   POST /board/:id/photo           → upload the person's photo (multipart "image")
//   POST /board/:id/photo/remove    → clear the photo (deletes the file)
//   POST /board/:id/delete          → remove the role (and its photo file)
//
// Seeded by the web app with Chair, Vice Chair, Secretary, Treasurer,
// Community Chair and Sergeant at Arms, names blank. A blank person_name
// shows the role as open on the website.

const express = require('express');
const { page, flash } = require('../views/layout');
const { escapeHtml, jsAttrStr } = require('../views/escapeHtml');
const { requireAdmin } = require('../middleware/auth');
const kit = require('../helpers/pageKit');
const uploads = require('../helpers/webAppUploads');

module.exports = function (db, appConfig) {
  const router = express.Router();
  const back = '/board';
  const audit = require('../helpers/audit')(db);
  // "Role — Person" for an audit label; null if gone / DB down.
  const roleLabel = (id) => db.getAsync('SELECT role_title, person_name FROM board_members WHERE board_id = ?', [id])
    .then(r => r ? [r.role_title, r.person_name].filter(Boolean).join(' — ') : null).catch(() => null);

  router.get('/board', requireAdmin, async (req, res) => {
    const user = req.session.user;
    const { rows, err } = await kit.safeAll(db, 'SELECT board_id, role_title, role_description, person_name, photo_path, sort FROM board_members ORDER BY sort, board_id', []);
    const cards = rows.map((b, i) => {
      const id = Number(b.board_id);
      return `<section class="card surface-target card-pad">
        <div class="flex items-start gap-4 flex-wrap md:flex-nowrap">
          <div class="shrink-0 w-28 space-y-2">
            ${b.photo_path ? `<a href="/wa-uploads/${escapeHtml(b.photo_path)}" target="_blank" rel="noopener">${kit.uploadImg(b.photo_path, b.person_name || b.role_title, 'h-28 w-28 rounded-full object-cover border border-slate-200 dark:border-slate-700')}</a>`
              : `<div class="h-28 w-28 rounded-full bg-slate-100 dark:bg-slate-800 flex items-center justify-center text-3xl text-slate-400" aria-hidden="true">☺</div>`}
            ${b.photo_path ? `<form method="POST" action="/board/${id}/photo/remove" class="m-0 text-center" x-data
                x-on:submit.prevent="window.uiConfirmSubmit($event.target, 'Remove this photo? The file is deleted from the Web App.', { title: 'Remove photo', confirmLabel: 'Remove' })">
                <button type="submit" class="btn-ghost text-xs px-2 py-1 text-red-600">Remove photo</button></form>` : ''}
          </div>
          <div class="flex-1 min-w-0 space-y-3">
            <form method="POST" action="/board/${id}/save" class="grid sm:grid-cols-2 gap-3">
              <div><label class="label" for="bd-role-${id}">Role *</label>
                <input id="bd-role-${id}" class="input" type="text" name="role_title" required maxlength="100" value="${escapeHtml(b.role_title || '')}"></div>
              <div><label class="label" for="bd-name-${id}">Person</label>
                <input id="bd-name-${id}" class="input" type="text" name="person_name" maxlength="200" value="${escapeHtml(b.person_name || '')}" placeholder="(open — leave blank)"></div>
              <div class="sm:col-span-2"><label class="label" for="bd-desc-${id}">Role description</label>
                <input id="bd-desc-${id}" class="input" type="text" name="role_description" maxlength="500" value="${escapeHtml(b.role_description || '')}"></div>
              <div class="sm:col-span-2 flex items-center justify-end"><button type="submit" class="btn-primary text-sm">Save</button></div>
            </form>
            ${kit.uploadForm(`/board/${id}/photo`, b.photo_path ? 'Replace photo' : 'Upload photo')}
          </div>
          <div class="shrink-0 flex md:flex-col items-center gap-1">
            <form method="POST" action="/board/${id}/move" class="m-0"><input type="hidden" name="dir" value="up">
              <button type="submit" class="btn-ghost text-xs px-2 py-1" ${i === 0 ? 'disabled' : ''} aria-label="Move up">▲</button></form>
            <form method="POST" action="/board/${id}/move" class="m-0"><input type="hidden" name="dir" value="down">
              <button type="submit" class="btn-ghost text-xs px-2 py-1" ${i === rows.length - 1 ? 'disabled' : ''} aria-label="Move down">▼</button></form>
            <form method="POST" action="/board/${id}/delete" class="m-0" x-data
                  x-on:submit.prevent="window.uiConfirmSubmit($event.target, ${jsAttrStr('Remove the "' + (b.role_title || '') + '" role from the board?' + (b.photo_path ? ' Its photo file is deleted too.' : ''))}, { title: 'Remove role', confirmLabel: 'Remove' })">
              <button type="submit" class="btn-ghost text-xs px-2 py-1 text-red-600" aria-label="Remove role">✕</button></form>
          </div>
        </div>
      </section>`;
    }).join('');
    const body = `
      ${kit.pageHeader('Board', 'Board roles and the people who hold them, shown on the website\'s About page in this order.')}
      ${flash('error', req.query.error)}
      ${flash('success', req.query.msg)}
      ${kit.dbBanner(err)}
      <div class="max-w-4xl space-y-4">
        ${cards || `<p class="text-sm text-slate-400 italic">${err ? 'Unavailable.' : 'No roles yet.'}</p>`}
        <section class="card surface-target card-pad">
          <h2 class="text-sm font-semibold text-slate-900 dark:text-slate-100">Add a role</h2>
          <form method="POST" action="/board/add" class="mt-3 grid sm:grid-cols-3 gap-3 items-end">
            <div><label class="label" for="bd-new-role">Role *</label><input id="bd-new-role" class="input" type="text" name="role_title" required maxlength="100"></div>
            <div class="sm:col-span-2"><label class="label" for="bd-new-desc">Description</label><input id="bd-new-desc" class="input" type="text" name="role_description" maxlength="500"></div>
            <div class="sm:col-span-3 flex justify-end"><button type="submit" class="btn-primary text-sm">Add role</button></div>
          </form>
        </section>
        <p class="text-xs text-slate-500 dark:text-slate-400">Photos: JPEG, PNG or WebP; your browser shrinks them to 1600 px before uploading. A square, head-and-shoulders photo looks best.</p>
      </div>`;
    res.send(page({ title: 'Board', body, appConfig, user, activeNav: 'board' }));
  });

  router.post('/board/add', requireAdmin, async (req, res) => {
    const title = kit.str(req.body.role_title, 100);
    if (!title) return res.redirect(back + '?error=Role+is+required');
    try {
      const sort = await kit.nextSort(db, 'board_members');
      const ins = await db.runAsync('INSERT INTO board_members (role_title, role_description, person_name, photo_path, sort) VALUES (?, ?, NULL, NULL, ?)',
        [title, kit.str(req.body.role_description, 500), sort]);
      await audit(req, 'board.add', { kind: 'board', id: ins && ins.lastID ? Number(ins.lastID) : null, label: title, summary: `Added board role "${title}"` });
      res.redirect(back + '?msg=' + encodeURIComponent(`Added "${title}".`));
    } catch (err) {
      res.redirect(back + '?error=' + encodeURIComponent('Add failed: ' + (err.message || err)));
    }
  });

  router.post('/board/:id/save', requireAdmin, async (req, res) => {
    const id = kit.idParam(req.params.id);
    const title = kit.str(req.body.role_title, 100);
    if (!id || !title) return res.redirect(back + '?error=Role+is+required');
    try {
      const person = kit.str(req.body.person_name, 200);
      const r = await db.runAsync('UPDATE board_members SET role_title = ?, role_description = ?, person_name = ? WHERE board_id = ?',
        [title, kit.str(req.body.role_description, 500), person, id]);
      if (!r.changes) return res.redirect(back + '?error=Role+not+found');
      await audit(req, 'board.save', { kind: 'board', id, label: [title, person].filter(Boolean).join(' — '), summary: 'Role, description or person saved' });
      res.redirect(back + '?msg=' + encodeURIComponent(`Saved "${title}".`));
    } catch (err) {
      res.redirect(back + '?error=' + encodeURIComponent('Save failed: ' + (err.message || err)));
    }
  });

  router.post('/board/:id/move', requireAdmin, async (req, res) => {
    const id = kit.idParam(req.params.id);
    if (!id) return res.redirect(back + '?error=Invalid+id');
    try {
      const dir = req.body && req.body.dir === 'up' ? 'up' : 'down';
      const moved = await kit.moveRow(db, 'board_members', 'board_id', id, dir);
      if (moved) await audit(req, 'board.move', { kind: 'board', id, label: await roleLabel(id), summary: `Moved ${dir}` });
      res.redirect(back);
    } catch (err) {
      res.redirect(back + '?error=' + encodeURIComponent('Reorder failed: ' + (err.message || err)));
    }
  });

  router.post('/board/:id/photo', requireAdmin, kit.withImage(back, async (req, res) => {
    const id = kit.idParam(req.params.id);
    if (!id) return kit.reply(req, res, back, false, 'Invalid id.');
    const b = await db.getAsync('SELECT photo_path FROM board_members WHERE board_id = ?', [id]);
    if (!b) return kit.reply(req, res, back, false, 'Role not found.');
    let saved;
    try { saved = await uploads.saveImage(appConfig, 'board', req.file && req.file.buffer); }
    catch (err) { return kit.reply(req, res, back, false, err.message || 'Upload failed'); }
    try {
      await db.runAsync('UPDATE board_members SET photo_path = ? WHERE board_id = ?', [saved.rel, id]);
    } catch (err) {
      await uploads.removeFiles(appConfig, saved.rel);
      return kit.reply(req, res, back, false, 'Saving failed: ' + (err.message || err));
    }
    if (b.photo_path && b.photo_path !== saved.rel) await uploads.removeFiles(appConfig, b.photo_path);
    await audit(req, 'board.photo', { kind: 'board', id, label: await roleLabel(id), summary: `Photo ${b.photo_path ? 'replaced' : 'uploaded'}` });
    kit.reply(req, res, back, true, 'Photo uploaded.');
  }));

  router.post('/board/:id/photo/remove', requireAdmin, async (req, res) => {
    const id = kit.idParam(req.params.id);
    if (!id) return res.redirect(back + '?error=Invalid+id');
    try {
      const b = await db.getAsync('SELECT photo_path FROM board_members WHERE board_id = ?', [id]);
      if (!b) return res.redirect(back + '?error=Role+not+found');
      await db.runAsync('UPDATE board_members SET photo_path = NULL WHERE board_id = ?', [id]);
      await uploads.removeFiles(appConfig, b.photo_path);
      await audit(req, 'board.photo', { kind: 'board', id, label: await roleLabel(id), summary: 'Photo removed' });
      res.redirect(back + '?msg=Photo+removed.');
    } catch (err) {
      res.redirect(back + '?error=' + encodeURIComponent('Remove failed: ' + (err.message || err)));
    }
  });

  router.post('/board/:id/delete', requireAdmin, async (req, res) => {
    const id = kit.idParam(req.params.id);
    if (!id) return res.redirect(back + '?error=Invalid+id');
    try {
      const b = await db.getAsync('SELECT role_title, person_name, photo_path FROM board_members WHERE board_id = ?', [id]);
      if (!b) return res.redirect(back + '?error=Role+not+found');
      await db.runAsync('DELETE FROM board_members WHERE board_id = ?', [id]);
      await uploads.removeFiles(appConfig, b.photo_path);
      await audit(req, 'board.delete', { kind: 'board', id, label: [b.role_title, b.person_name].filter(Boolean).join(' — '), summary: `Removed board role${b.photo_path ? ' and its photo' : ''}` });
      res.redirect(back + '?msg=' + encodeURIComponent(`Removed "${b.role_title}".`));
    } catch (err) {
      res.redirect(back + '?error=' + encodeURIComponent('Remove failed: ' + (err.message || err)));
    }
  });

  return router;
};
