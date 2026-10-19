// helpers/webAppConfig.js — read / merge / write the Web App's remote
// config.json through a webAppAccess accessor.
//
// The web app stores everything in a config.json at the root of its install
// (accessor.appPath). This module reads that file, lets callers mutate
// specific keys, and writes it back — preserving every key we don't touch
// (including `_comment` strings, SMTP / AWS secrets, and sessionKeys). The
// safety contract: callers always read fresh, mutate, then write, so a save
// only ever changes the specific fields it set. A malformed remote file is
// refused outright (never "repaired" by overwriting it).
//
// Also home to the console-side "restart pending" bookkeeping: the web app
// reads config.json once at boot, so any change written here isn't live
// until it restarts (markWebAppWritten / isRestartPending).

// Join a directory and filename with a single forward slash. The Control
// Plane targets POSIX hosts; for local mode appPath may be relative to the
// admin console's working directory, which is fine with forward slashes.
function joinPath(dir, file) {
  const base = String(dir || '').replace(/\/+$/, '');
  return base ? `${base}/${file}` : file;
}

function remoteConfigPath(accessor) {
  if (!accessor || !accessor.appPath) {
    const err = new Error('No Web App directory path is configured. Set it under Settings → Web App.');
    err.code = 'WA_NO_APPPATH';
    throw err;
  }
  return joinPath(accessor.appPath, 'config.json');
}

async function readRemoteConfig(accessor) {
  const path = remoteConfigPath(accessor);
  let raw;
  try {
    raw = await accessor.readFile(path, { encoding: 'utf8' });
  } catch (err) {
    const e = new Error(`Could not read ${path}: ${err.message || err}`);
    e.code = err.code || 'WA_READ_FAILED';
    throw e;
  }
  let json;
  try {
    json = JSON.parse(raw);
  } catch (err) {
    // Refuse to proceed on a malformed file so a later write can't clobber
    // it with a partial object.
    const e = new Error(`${path} is not valid JSON (${err.message}). Fix it on the Web App before editing here.`);
    e.code = 'WA_BAD_JSON';
    throw e;
  }
  if (!json || typeof json !== 'object' || Array.isArray(json)) {
    const e = new Error(`${path} did not contain a JSON object.`);
    e.code = 'WA_BAD_JSON';
    throw e;
  }
  return { path, json };
}

async function writeRemoteConfig(accessor, json) {
  const path = remoteConfigPath(accessor);
  const out = JSON.stringify(json, null, 2) + '\n';
  await accessor.writeFile(path, out);
  return path;
}

// Deep getter: getPath(obj, 'a.b.c'). Returns undefined if any segment is
// missing.
function getPath(obj, dotted) {
  const parts = String(dotted).split('.');
  let cur = obj;
  for (const p of parts) {
    if (cur == null || typeof cur !== 'object') return undefined;
    cur = cur[p];
  }
  return cur;
}

// Deep setter: setPath(obj, 'a.b.c', value). Creates intermediate plain
// objects as needed. Returns obj.
function setPath(obj, dotted, value) {
  const parts = String(dotted).split('.');
  let cur = obj;
  for (let i = 0; i < parts.length - 1; i++) {
    const k = parts[i];
    if (cur[k] == null || typeof cur[k] !== 'object' || Array.isArray(cur[k])) {
      cur[k] = {};
    }
    cur = cur[k];
  }
  cur[parts[parts.length - 1]] = value;
  return obj;
}

// Record that this console CHANGED the web app's config.json (a Web App
// Settings save, a config restore, a bundle restore). The web app reads its
// config once at boot, so the change isn't live until it restarts: the power
// bar shows "Restart pending" until a successful Start / Restart clears it.
// Mutates appConfig only; the caller owns appConfigModule.save().
function markWebAppWritten(appConfig) {
  const wa = appConfig.webApp = appConfig.webApp || {};
  wa.restartPending = true;
  return wa;
}

function isRestartPending(appConfig) {
  return !!(appConfig && appConfig.webApp && appConfig.webApp.restartPending);
}

module.exports = {
  markWebAppWritten,
  isRestartPending,
  joinPath,
  remoteConfigPath,
  readRemoteConfig,
  writeRemoteConfig,
  getPath,
  setPath
};
