// helpers/webAppUploads.js — images the console stores in the Web App's
// uploads/ directory (event flyers + covers, raffle flyers + prize photos,
// nonprofit photos, board photos).
//
// Contract with mmoa_web_app (DO NOT change one side only):
//   * Files live at <appPath>/uploads/<kind>/<random 16-hex>.<jpg|png|webp>,
//     kind ∈ events | raffles | orgs | board. The web app serves that tree
//     read-only at /uploads.
//   * The DB stores the RELATIVE path, e.g. 'events/3f9c0a1b2c3d4e5f.jpg'.
//   * Only JPEG / PNG / WebP, verified by MAGIC BYTES (the browser's
//     Content-Type and the filename are ignored), at most 8 MB.
//   * Deleting a row / image deletes its file, best effort.
//
// Writes go through webAppAccess.writeFileChunked (local atomic write, SFTP,
// or base64 pieces over SSM — see helpers/webAppAccess.js); deletes are a
// `rm -f` through runCommand. Every path is rebuilt from a validated relative
// path, so nothing from a request (or a DB row someone edited by hand) can
// point outside uploads/.

const crypto = require('crypto');
const webAppAccess = require('./webAppAccess');
const waConfig = require('./webAppConfig');

const KINDS = ['events', 'raffles', 'orgs', 'board'];
const MAX_BYTES = 8 * 1024 * 1024;
const REL_RE = /^(events|raffles|orgs|board)\/[0-9a-f]{16}\.(jpg|png|webp)$/;
const MIME = { jpg: 'image/jpeg', png: 'image/png', webp: 'image/webp' };

// Sniff the real format. Returns 'jpg' | 'png' | 'webp' | null.
function sniffExt(buf) {
  if (!Buffer.isBuffer(buf) || buf.length < 12) return null;
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'jpg';
  if (buf.slice(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'png';
  if (buf.slice(0, 4).toString('latin1') === 'RIFF' && buf.slice(8, 12).toString('latin1') === 'WEBP') return 'webp';
  return null;
}

// A stored relative path is usable only if it matches the exact shape the
// web app and this console write. Anything else is treated as "no file".
function isValidRel(rel) {
  return typeof rel === 'string' && REL_RE.test(rel);
}

function mimeOf(rel) {
  const m = /\.(jpg|png|webp)$/.exec(String(rel || ''));
  return m ? MIME[m[1]] : 'application/octet-stream';
}

function uploadsDir(accessor) {
  if (!accessor || !accessor.appPath) {
    const e = new Error('No Web App directory path is configured. Set it under Settings → Web App.');
    e.code = 'WA_NO_APPPATH';
    throw e;
  }
  return waConfig.joinPath(accessor.appPath, 'uploads');
}

function absPath(accessor, rel) {
  if (!isValidRel(rel)) throw new Error('Invalid upload path.');
  return waConfig.joinPath(uploadsDir(accessor), rel);
}

// Validate + store one image. Returns { rel, bytes, chunks }.
async function saveImage(appConfig, kind, buffer) {
  if (!KINDS.includes(kind)) throw new Error('Unknown upload kind.');
  if (!Buffer.isBuffer(buffer) || !buffer.length) throw new Error('No file received.');
  if (buffer.length > MAX_BYTES) throw new Error('Image is larger than 8 MB.');
  const ext = sniffExt(buffer);
  if (!ext) throw new Error('Only JPEG, PNG or WebP images are allowed.');
  if (!webAppAccess.isConfigured(appConfig)) throw new Error('Web App access is not configured (Settings → Web App).');
  const accessor = webAppAccess.createAccessorFromConfig(appConfig);
  const rel = `${kind}/${crypto.randomBytes(8).toString('hex')}.${ext}`;
  const r = await accessor.writeFileChunked(absPath(accessor, rel), buffer);
  console.log(`[uploads] stored ${rel} (${buffer.length} bytes, ${r && r.chunks} transfer(s)) via ${accessor.mode}`);
  return { rel, bytes: buffer.length, chunks: r && r.chunks };
}

// Best-effort delete of one or more stored relative paths. Never throws;
// returns the number of paths it attempted. Invalid / blank paths are skipped.
async function removeFiles(appConfig, rels) {
  const list = (Array.isArray(rels) ? rels : [rels]).filter(isValidRel);
  if (!list.length || !webAppAccess.isConfigured(appConfig)) return 0;
  try {
    const accessor = webAppAccess.createAccessorFromConfig(appConfig);
    const args = list.map(rel => webAppAccess.shQuote(absPath(accessor, rel))).join(' ');
    const r = await accessor.runCommand(`rm -f -- ${args}`, { timeoutMs: 30000, comment: 'Admin console upload delete' });
    if (r.code !== 0) console.warn('[uploads] rm failed:', (r.stderr || '').trim() || r.code);
  } catch (e) {
    console.warn('[uploads] delete failed:', e.message || e);
  }
  return list.length;
}

module.exports = { KINDS, MAX_BYTES, sniffExt, isValidRel, mimeOf, uploadsDir, absPath, saveImage, removeFiles };
