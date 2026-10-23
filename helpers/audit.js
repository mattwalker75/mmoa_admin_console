// helpers/audit.js — the admin audit trail: one row in the web app's
// `admin_audit` table per console action that changes something (the web
// app creates the table on boot; this console only writes and reads it).
//
//   const audit = require('../helpers/audit')(db);
//   await audit(req, 'event.publish', { kind: 'event', id, label: title, summary: 'Published' });
//
// Never throws and never blocks the action: a failed insert (table missing
// because the web app hasn't restarted yet, remote host down) is logged and
// swallowed, so an audit problem can't stop an admin from working.
//
// action   dotted, lower-case: '<area>.<verb>' — event.create, event.save,
//          event.status, event.delete, raffle.stage, nonprofit.verify,
//          admin.add, backup.restore, settings.save, login.success…
// kind/id  what it acted on (event / raffle / nonprofit / admin / backup /
//          settings / website…) — id as text so file names fit too
// label    a human name for the target (title, org name, bundle name)
// summary  one short sentence; keep secrets and long text out of it

'use strict';

const kit = require('./pageKit');

const MAX = { action: 60, kind: 40, id: 100, label: 300, summary: 1000, ip: 64, admin: 100 };
const clip = (v, n) => (v == null ? null : String(v).slice(0, n));

module.exports = function makeAudit(db) {
  return async function audit(req, action, { kind = null, id = null, label = null, summary = null } = {}) {
    const admin = (req && req.session && req.session.user && req.session.user.username) || 'system';
    const ip = req && req.ip;
    try {
      await db.runAsync(
        'INSERT INTO admin_audit (at, admin, action, target_kind, target_id, target_label, summary, ip) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
        [kit.sqlTime(), clip(admin, MAX.admin), clip(action, MAX.action), clip(kind, MAX.kind), clip(id, MAX.id),
         clip(label, MAX.label), clip(summary, MAX.summary), clip(ip, MAX.ip)]);
    } catch (err) {
      console.warn(`[audit] could not record ${action} by ${admin}: ${(err && err.message) || err}`);
    }
  };
};
