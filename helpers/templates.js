// helpers/templates.js — reusable text templates for raffle fields ("How to
// buy", "Claim requirements"), stored as files on THIS console's server:
//
//   <dir>/<kind>/<id>.json   { "name": "Firearm", "content": "…", "updatedAt": "…" }
//
// <dir> is appConfig.templates.dir (Settings → Templates; default
// "templates", relative to the console's folder). <id> is the slugified name
// and is the only thing ever used in a path (validated with ID_RE, joined
// under the kind's folder), so a template name can't escape the directory.
// A kind's folder is created — and seeded with the starter templates — the
// first time it's used; deleting every template afterwards leaves it empty.
// Writes are atomic (temp file + rename).

'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const DEFAULT_DIR = 'templates';
const ID_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
// Own keys only: a bundle naming a kind like "constructor" or "__proto__"
// must not reach Object.prototype.
const isKind = (kind) => Object.prototype.hasOwnProperty.call(KINDS, kind);
const MAX_NAME = 80, MAX_CONTENT = 4000;

// Each kind belongs to a group (the section it's listed under in Settings →
// Templates, e.g. "Raffles").
const GROUP_HINTS = { Raffles: 'Text used on raffle pages — load it from the Templates drop-down above the field when editing a raffle.' };

const KINDS = {
  'how-to-buy': {
    group: 'Raffles',
    label: 'How to buy',
    hint: 'The "How to buy" text on a raffle — tickets are sold in person only (Texas law).',
    seeds: [
      { name: 'In person (default)', content: "Tickets are sold in person only — from any MMoA member or at our booth at upcoming events. Texas law doesn't allow raffle tickets to be sold online." }
    ]
  },
  'claim-requirements': {
    group: 'Raffles',
    label: 'Claim requirements',
    hint: 'What the winner must do to claim the prize — one requirement per line.',
    seeds: [
      { name: 'Firearm', content: [
        'Be the person named on the winning ticket and claim the prize in person',
        'Be of legal age to purchase this firearm (18+ for rifles and shotguns, 21+ for handguns)',
        'Show a valid government-issued photo ID',
        'Complete the transfer through a licensed FFL dealer and pass the federal NICS background check',
        'Not be prohibited by law from owning a firearm',
        'Claim the prize within 30 days of the drawing'
      ].join('\n') },
      { name: 'Standard', content: ['Claim within 30 days of the drawing', 'Show a valid photo ID', 'Need not be present to win'].join('\n') }
    ]
  }
};

class TemplateError extends Error {}

function slugify(name) {
  return String(name || '').toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '')
    .replace(/&/g, ' and ').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60).replace(/-+$/, '');
}

/** The configured directory, absolute (relative paths are from the console folder). */
function baseDir(appConfig) {
  const d = (appConfig.templates && String(appConfig.templates.dir || '').trim()) || DEFAULT_DIR;
  return path.resolve(ROOT, d);
}

function kindDir(appConfig, kind) {
  if (!isKind(kind)) throw new TemplateError('Unknown template type.');
  return path.join(baseDir(appConfig), kind);
}

function writeAtomic(file, data) {
  const tmp = file + '.' + process.pid + '.tmp';
  fs.writeFileSync(tmp, data, { mode: 0o644 });
  fs.renameSync(tmp, file);
}

// Create the kind's folder (and starter templates) the first time.
function ensure(appConfig, kind) {
  const dir = kindDir(appConfig, kind);
  if (fs.existsSync(dir)) return dir;
  fs.mkdirSync(dir, { recursive: true });
  for (const s of KINDS[kind].seeds) {
    writeAtomic(path.join(dir, slugify(s.name) + '.json'), JSON.stringify({ name: s.name, content: s.content, updatedAt: new Date().toISOString() }, null, 2) + '\n');
  }
  return dir;
}

function fileOf(appConfig, kind, id) {
  if (!ID_RE.test(String(id || ''))) throw new TemplateError('Invalid template id.');
  return path.join(ensure(appConfig, kind), id + '.json');
}

/** All templates of a kind, sorted by name: [{ id, name, content, updatedAt }]. */
function list(appConfig, kind) {
  const dir = ensure(appConfig, kind);
  const out = [];
  for (const f of fs.readdirSync(dir)) {
    const m = /^([a-z0-9-]+)\.json$/.exec(f);
    if (!m || !ID_RE.test(m[1])) continue;
    try {
      // Regular files only (lstat): a symlink dropped in the folder must not
      // be read through to wherever it points.
      if (!fs.lstatSync(path.join(dir, f)).isFile()) continue;
      const j = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
      out.push({ id: m[1], name: String(j.name || m[1]), content: String(j.content || ''), updatedAt: j.updatedAt || null });
    } catch (e) { /* skip an unreadable file */ }
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

/** Create or update. { id } = update that template (renaming it if the name
 *  changed); no id = create (refused if the name is already taken). */
function save(appConfig, kind, { id, name, content }) {
  const nm = String(name || '').replace(/\s+/g, ' ').trim();
  if (!nm) throw new TemplateError('Give the template a name.');
  if (nm.length > MAX_NAME) throw new TemplateError(`Template names are up to ${MAX_NAME} characters.`);
  const text = String(content || '').replace(/\r\n?/g, '\n').trim();
  if (!text) throw new TemplateError('The template is empty.');
  if (text.length > MAX_CONTENT) throw new TemplateError(`Templates are up to ${MAX_CONTENT} characters.`);
  const newId = slugify(nm);
  if (!newId) throw new TemplateError('Use some letters or digits in the name.');
  const target = fileOf(appConfig, kind, newId);
  if (id) {
    const old = fileOf(appConfig, kind, id);
    if (!fs.existsSync(old)) throw new TemplateError('That template no longer exists.');
    if (newId !== id && fs.existsSync(target)) throw new TemplateError(`A template called “${nm}” already exists.`);
    writeAtomic(target, JSON.stringify({ name: nm, content: text, updatedAt: new Date().toISOString() }, null, 2) + '\n');
    if (newId !== id) fs.unlinkSync(old);
  } else {
    if (fs.existsSync(target)) throw new TemplateError(`A template called “${nm}” already exists — pick another name, or load it and use “Update”.`);
    writeAtomic(target, JSON.stringify({ name: nm, content: text, updatedAt: new Date().toISOString() }, null, 2) + '\n');
  }
  return { id: newId, name: nm };
}

function remove(appConfig, kind, id) {
  const f = fileOf(appConfig, kind, id);
  if (!fs.existsSync(f)) throw new TemplateError('That template no longer exists.');
  fs.unlinkSync(f);
}

// ── Backup / Restore ─────────────────────────────────────────────────────
// Every template of every kind, in the shape a Web App bundle carries:
//   { '<kind>': [{ id, name, content, updatedAt }, …], … }
function exportAll(appConfig) {
  const out = {};
  for (const kind of Object.keys(KINDS)) out[kind] = list(appConfig, kind);
  return out;
}

// Write the templates from a bundle into the configured folder: a file per
// (kind, id), REPLACING a same-id file and leaving every other file alone.
// Only known kinds and ids that match ID_RE are written (a crafted bundle
// can't name a path); name / content are clipped to the editor's limits.
// Returns { written, skipped: [reason…] }.
function importAll(appConfig, data) {
  let written = 0;
  const skipped = [];
  const src = (data && typeof data === 'object' && !Array.isArray(data)) ? data : {};
  for (const kind of Object.keys(src)) {
    if (!isKind(kind)) { skipped.push(`unknown template type "${String(kind).slice(0, 40)}"`); continue; }
    const items = Array.isArray(src[kind]) ? src[kind] : [];
    for (const t of items) {
      const id = t && String(t.id || '');
      if (!ID_RE.test(id)) { skipped.push(`${kind}: bad template id`); continue; }
      const name = String((t && t.name) || id).replace(/\s+/g, ' ').trim().slice(0, MAX_NAME) || id;
      const content = String((t && t.content) || '').replace(/\r\n?/g, '\n').slice(0, MAX_CONTENT);
      const updatedAt = (t && typeof t.updatedAt === 'string') ? t.updatedAt : new Date().toISOString();
      writeAtomic(fileOf(appConfig, kind, id), JSON.stringify({ name, content, updatedAt }, null, 2) + '\n');
      written++;
    }
  }
  return { written, skipped };
}

module.exports = { KINDS, GROUP_HINTS, DEFAULT_DIR, TemplateError, baseDir, list, save, remove, slugify, exportAll, importAll };
