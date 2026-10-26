// helpers/consoleSettingsRestore.js — validate a Console settings backup
// against the same rules the Settings pages enforce, BEFORE anything is
// written, and work out what a restore will change.
//
//   const plan = await planRestore(parsed, appConfig, { sections, restoreConnection });
//   plan.errors   — refuse the restore (nothing is written): a value that
//                   would stop the console starting, lock every admin out,
//                   or that no Settings page would accept
//   plan.warnings — shown on the result banner
//   plan.updates  — { key: newValue } to assign onto appConfig
//   plan.restart  — keys that only take effect after a console restart
//   plan.images   — [{ rel, buf }] appearance images to write
//
// Rules worth knowing:
//   * The file must be a console-settings export (_meta.type).
//   * webApp (how this console reaches the Web App: mode, folder, SSH host
//     and key, EC2 instance / user, and the Start / Stop / Restart commands)
//     is only taken from the file when the operator ticks "restore the
//     connection and commands" — a changed folder or host changes which
//     scripts the power bar runs. restartPending is never restored.
//   * A secret the file doesn't carry (SSH key, AWS secret, MySQL password)
//     keeps the stored one rather than being wiped.

'use strict';

const fs = require('fs');
const net = require('net');
const path = require('path');
const crypto = require('crypto');
const tls = require('tls');

const IMAGES_DIR = path.join(__dirname, '..', 'public', 'images');
const MAX_DEPTH = 12;
const RESTART_KEYS = ['port', 'server', 'sessionKeyMode', 'sessionMaxAgeHours', 'publicBaseUrl', 'database', 'security'];

const isObj = (v) => !!(v && typeof v === 'object' && !Array.isArray(v));
const clone = (v) => (v === undefined ? undefined : JSON.parse(JSON.stringify(v)));
function depth(v, d = 0) {
  if (d > MAX_DEPTH) return d;
  if (!v || typeof v !== 'object') return d;
  let m = d;
  for (const k of Object.keys(v)) m = Math.max(m, depth(v[k], d + 1));
  return m;
}
const intIn = (v, lo, hi) => Number.isInteger(v) && v >= lo && v <= hi;
const sha256 = (b) => crypto.createHash('sha256').update(b).digest('hex');

function sniffImage(buf) {
  if (!buf || buf.length < 12) return null;
  if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) return 'png';
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'jpg';
  if (buf.slice(0, 3).toString('ascii') === 'GIF') return 'gif';
  if (buf.slice(0, 4).toString('ascii') === 'RIFF' && buf.slice(8, 12).toString('ascii') === 'WEBP') return 'webp';
  return null;
}

// Appearance images referenced by a theme ("/images/<file>") that exist on
// disk → { "/images/x.png": { b64, sha256, bytes } } for the export.
function exportImages(theme) {
  const out = {};
  for (const blk of [theme && theme.login, theme && theme.app]) {
    const rel = blk && blk.backgroundImage;
    if (typeof rel !== 'string' || !/^\/images\/[A-Za-z0-9._-]+$/.test(rel)) continue;
    try {
      const buf = fs.readFileSync(path.join(IMAGES_DIR, path.basename(rel)));
      out[rel] = { b64: buf.toString('base64'), sha256: sha256(buf), bytes: buf.length };
    } catch (e) { /* referenced but missing — the export just lacks it */ }
  }
  return out;
}

function portFree(port) {
  return new Promise((resolve) => {
    const s = net.createServer();
    s.once('error', () => resolve(false));
    s.once('listening', () => s.close(() => resolve(true)));
    s.listen(port);
  });
}

async function planRestore(parsed, live, opts = {}) {
  const errors = [], warnings = [], updates = {}, restart = [], images = [];
  const meta = isObj(parsed) && isObj(parsed._meta) ? parsed._meta : null;
  if (!meta || meta.type !== 'admin-console-settings') {
    errors.push(`this is not a Console settings backup (type "${(meta && meta.type) || 'none'}") — use the matching restore on this page`);
    return { errors, warnings, updates, restart, images };
  }
  const sections = (opts.sections || []).filter(k => Object.prototype.hasOwnProperty.call(parsed, k));
  const httpsServed = !!(live.server && live.server.ssl) || /^https:/i.test(String(live.publicBaseUrl || ''));

  for (const k of sections) {
    const v = parsed[k];
    if (depth(v) >= MAX_DEPTH) { errors.push(`${k}: nested too deeply`); continue; }
    switch (k) {
      case 'port': {
        if (!intIn(v, 1, 65535)) { errors.push(`port: must be a whole number 1–65535 (got ${JSON.stringify(v)})`); break; }
        // The port this console is listening on right now is "in use" by
        // the console itself — going back to it (say after restoring a file
        // with a different port) is fine and needs no restart.
        if (v !== Number(live.port) && v !== Number(opts.runningPort)) {
          if (!(await portFree(v))) { errors.push(`port: ${v} is already in use on this machine — the console could not start on it`); break; }
          restart.push('port');
        }
        updates.port = v; break;
      }
      case 'appTitle': case 'appSubtitle': {
        if (typeof v !== 'string' || v.length > 200) { errors.push(`${k}: must be text up to 200 characters`); break; }
        updates[k] = v; break;
      }
      case 'publicBaseUrl': {
        if (v !== '' && (typeof v !== 'string' || !/^https?:\/\/[^\s<>"']+$/i.test(v) || v.length > 500)) { errors.push('publicBaseUrl: must be empty or an http(s) address'); break; }
        if (/^https:/i.test(v) && !(live.server && live.server.ssl) && !/^https:/i.test(String(live.publicBaseUrl || ''))) {
          warnings.push(`publicBaseUrl is https (${v}) but this console is served over plain http — only restore it if a proxy in front serves it over HTTPS, otherwise pages won't load after a restart`);
        }
        if (v !== live.publicBaseUrl) restart.push('publicBaseUrl');
        updates.publicBaseUrl = v; break;
      }
      case 'server': {
        if (!isObj(v)) { errors.push('server: must be an object'); break; }
        if (v.ssl === true) {
          try {
            const key = fs.readFileSync(String(v.keyPath || '')), cert = fs.readFileSync(String(v.certPath || ''));
            tls.createSecureContext({ key, cert });
          } catch (e) {
            errors.push(`server: TLS is on but its key / certificate (${v.keyPath || '?'} / ${v.certPath || '?'}) can't be used on this machine (${e.message}) — the console would not start`);
            break;
          }
        }
        if (JSON.stringify(v) !== JSON.stringify(live.server)) restart.push('server');
        updates.server = clone(v); break;
      }
      case 'sessionKeyMode': {
        if (!['auto-generate', 'fixed'].includes(v)) { errors.push('sessionKeyMode: must be "auto-generate" or "fixed"'); break; }
        if (v === 'fixed' && !(Array.isArray(live.sessionKeys) && live.sessionKeys.length)) warnings.push('sessionKeyMode "fixed" but this console has no session keys of its own (they are never in a backup) — it falls back to generated keys, so admins sign in again after each restart');
        if (v !== live.sessionKeyMode) restart.push('sessionKeyMode');
        updates.sessionKeyMode = v; break;
      }
      case 'sessionMaxAgeHours': {
        if (typeof v !== 'number' || !(v > 0) || v > 8760) { errors.push('sessionMaxAgeHours: must be a number of hours above 0 (at most 8760)'); break; }
        if (v !== live.sessionMaxAgeHours) restart.push('sessionMaxAgeHours');
        updates.sessionMaxAgeHours = v; break;
      }
      case 'passwordMinLength': {
        if (!intIn(v, 6, 128)) { errors.push('passwordMinLength: must be a whole number 6–128'); break; }
        updates.passwordMinLength = v; break;
      }
      case 'timeZone': {
        try { new Intl.DateTimeFormat('en-US', { timeZone: String(v) }); } catch (e) { errors.push(`timeZone: "${v}" is not a time zone`); break; }
        updates.timeZone = String(v); break;
      }
      case 'security': {
        if (!isObj(v)) { errors.push('security: must be an object'); break; }
        const s = clone(v);
        const sess = isObj(s.session) ? s.session : {};
        if (sess.sameSite !== undefined && !['strict', 'lax', 'none'].includes(sess.sameSite)) { errors.push('security.session.sameSite: must be strict, lax or none'); break; }
        if (sess.secure === true && !httpsServed) { errors.push('security.session.secure is on, but this console is served over plain http — every admin would be locked out (cookies would never be sent)'); break; }
        const auth = isObj(s.rateLimiting) && isObj(s.rateLimiting.auth) ? s.rateLimiting.auth : null;
        if (auth) {
          if (auth.maxAttempts !== undefined && !intIn(auth.maxAttempts, 1, 1000)) { errors.push('security.rateLimiting.auth.maxAttempts: must be 1–1000'); break; }
          if (auth.windowSeconds !== undefined && !intIn(auth.windowSeconds, 60, 86400)) { errors.push('security.rateLimiting.auth.windowSeconds: must be 60–86400'); break; }
        }
        const pw = isObj(s.password) ? s.password : null;
        if (pw && pw.minLength !== undefined && !intIn(pw.minLength, 1, 128)) { errors.push('security.password.minLength: must be 1–128'); break; }
        if (JSON.stringify(s) !== JSON.stringify(live.security)) restart.push('security');
        updates.security = s; break;
      }
      case 'database': {
        if (!isObj(v)) { errors.push('database: must be an object'); break; }
        const d = clone(v);
        if (!['sqlite', 'mysql', 'none', ''].includes(d.engine || '')) { errors.push(`database.engine: "${d.engine}" is not sqlite or mysql`); break; }
        if (isObj(d.sqlite) && d.sqlite.filename !== undefined && (typeof d.sqlite.filename !== 'string' || /\0/.test(d.sqlite.filename) || !/\.(db|sqlite3?)$/i.test(d.sqlite.filename))) { errors.push('database.sqlite.filename: must be a .db / .sqlite file name'); break; }
        if (isObj(d.mysql)) {
          if (d.mysql.port !== undefined && !intIn(Number(d.mysql.port), 1, 65535)) { errors.push('database.mysql.port: must be 1–65535'); break; }
          const lm = (live.database && live.database.mysql) || {};
          if (!d.mysql.password && lm.password) { d.mysql.password = lm.password; warnings.push('database.mysql.password not in the file — the stored one was kept'); }
        }
        if (JSON.stringify(d) !== JSON.stringify(live.database)) restart.push('database');
        updates.database = d; break;
      }
      case 'templates': {
        if (!isObj(v) || (v.dir !== undefined && (typeof v.dir !== 'string' || /\0/.test(v.dir) || v.dir.split(/[\\/]/).includes('..')))) { errors.push('templates.dir: must be a folder path without ".."'); break; }
        if (v.dir && path.isAbsolute(v.dir)) warnings.push(`templates.dir is an absolute path (${v.dir}) — make sure that folder exists on this machine`);
        updates.templates = clone(v); break;
      }
      case 'theme': break; // handled by the caller's sanitizeTheme (+ images below)
      case 'webApp': {
        if (!isObj(v)) { errors.push('webApp: must be an object'); break; }
        if (!opts.restoreConnection) {
          warnings.push('Web App access (connection: mode, folder, SSH / EC2 settings, and the Start / Stop / Restart commands) kept as it is — tick the box to take it from the file');
          break;
        }
        const w = clone(v);
        delete w.restartPending;
        if (!['local', 'ssh', 'ec2'].includes(w.mode)) { errors.push(`webApp.mode: "${w.mode}" is not local, ssh or ec2`); break; }
        const e = isObj(w.ec2) ? w.ec2 : null, sh = isObj(w.ssh) ? w.ssh : null, lw = live.webApp || {};
        if (e) {
          if (e.runAsUser && !/^[a-z_][a-z0-9_-]*\$?$/.test(e.runAsUser)) { errors.push('webApp.ec2.runAsUser: not a valid Linux user name'); break; }
          if (e.instanceId && !/^i-[0-9a-f]{8,17}$/.test(e.instanceId)) { errors.push('webApp.ec2.instanceId: not an EC2 instance id (i-…)'); break; }
          if (e.region && !/^[a-z]{2}(-gov)?-[a-z]+-\d$/.test(e.region)) { errors.push('webApp.ec2.region: not an AWS region'); break; }
          const le = lw.ec2 || {};
          if (!e.secretAccessKey && le.secretAccessKey) { e.secretAccessKey = le.secretAccessKey; warnings.push('webApp.ec2.secretAccessKey not in the file — the stored one was kept'); }
        }
        if (sh) {
          if (sh.host && !/^[A-Za-z0-9.-]+$/.test(sh.host)) { errors.push('webApp.ssh.host: not a host name'); break; }
          if (sh.port !== undefined && !intIn(Number(sh.port), 1, 65535)) { errors.push('webApp.ssh.port: must be 1–65535'); break; }
          if (sh.user && !/^[a-z_][a-z0-9_.-]*\$?$/i.test(sh.user)) { errors.push('webApp.ssh.user: not a valid user name'); break; }
          const ls = lw.ssh || {};
          if (!sh.privateKey && ls.privateKey) { sh.privateKey = ls.privateKey; warnings.push('webApp.ssh.privateKey not in the file — the stored one was kept'); }
        }
        if (w.mode !== lw.mode) restart.push('webApp.mode');
        w.restartPending = !!lw.restartPending;
        updates.webApp = w; break;
      }
      default: warnings.push(`${k}: not a console setting — ignored`);
    }
  }

  // Appearance images carried by the file (export v2): written back when
  // missing or different, only as plain files under public/images/.
  if (sections.includes('theme') && isObj(parsed._images)) {
    for (const rel of Object.keys(parsed._images)) {
      const it = parsed._images[rel];
      if (!/^\/images\/[A-Za-z0-9._-]+$/.test(rel) || !isObj(it) || typeof it.b64 !== 'string') { warnings.push(`appearance image ${rel}: ignored (bad name)`); continue; }
      const buf = Buffer.from(it.b64, 'base64');
      if ((it.sha256 && sha256(buf) !== it.sha256) || !sniffImage(buf)) { errors.push(`appearance image ${rel}: damaged or not an image`); continue; }
      images.push({ rel, buf });
    }
  }
  return { errors, warnings, updates, restart, images };
}

function writeImages(images) {
  let n = 0;
  fs.mkdirSync(IMAGES_DIR, { recursive: true });
  for (const { rel, buf } of images) {
    const abs = path.join(IMAGES_DIR, path.basename(rel));
    if (!abs.startsWith(IMAGES_DIR + path.sep)) continue;
    let same = false;
    try { same = sha256(fs.readFileSync(abs)) === sha256(buf); } catch (e) { /* missing */ }
    if (same) continue;
    const tmp = abs + '.tmp-' + crypto.randomBytes(4).toString('hex');
    fs.writeFileSync(tmp, buf); fs.renameSync(tmp, abs); n++;
  }
  return n;
}

function imageMissing(rel) {
  if (typeof rel !== 'string' || !/^\/images\/[A-Za-z0-9._-]+$/.test(rel)) return false;
  return !fs.existsSync(path.join(IMAGES_DIR, path.basename(rel)));
}

module.exports = { planRestore, exportImages, writeImages, imageMissing, RESTART_KEYS };
