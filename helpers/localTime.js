// helpers/localTime.js — convert between the database's UTC timestamps and
// the organization's local wall-clock time.
//
// The web app stores every timestamp (events.starts_at, raffles.drawing_at, …)
// as a JS-computed UTC 'YYYY-MM-DD HH:MM:SS' string. Board members, though,
// think in Anna, Texas time: "the car show starts at 10 AM". So the console's
// date/time inputs are read and written in ONE fixed zone — appConfig.timeZone
// (default America/Chicago) — no matter where the console itself (a laptop,
// an EC2 instance in UTC) or the operator's browser happens to be. DST is
// handled by asking Intl for the zone's offset at that instant.
//
// No dependency: Node's built-in Intl has the IANA zone database.

const DEFAULT_ZONE = 'America/Chicago';

function zoneOf(appConfig) {
  const z = appConfig && typeof appConfig.timeZone === 'string' && appConfig.timeZone.trim();
  if (!z) return DEFAULT_ZONE;
  try { new Intl.DateTimeFormat('en-US', { timeZone: z }); return z; }
  catch (e) { return DEFAULT_ZONE; }
}

// Wall-clock parts of instant `ms` in `zone`.
function partsIn(ms, zone) {
  const f = new Intl.DateTimeFormat('en-US', {
    timeZone: zone, hourCycle: 'h23',
    year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit'
  });
  const o = {};
  for (const p of f.formatToParts(new Date(ms))) o[p.type] = p.value;
  return { y: +o.year, mo: +o.month, d: +o.day, h: +o.hour % 24, mi: +o.minute, s: +o.second };
}

// Offset (ms) of `zone` from UTC at instant `ms` (e.g. -5h during CDT).
function offsetAt(ms, zone) {
  const p = partsIn(ms, zone);
  return Date.UTC(p.y, p.mo - 1, p.d, p.h, p.mi, p.s) - Math.floor(ms / 1000) * 1000;
}

const pad = (n) => String(n).padStart(2, '0');

// '2027-03-13T10:00' (a <input type="datetime-local"> value, local to the
// zone) → '2027-03-13 15:00:00' UTC. Blank → null. Invalid → undefined.
function localInputToUtc(value, appConfig) {
  const v = String(value == null ? '' : value).trim();
  if (!v) return null;
  const m = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})(?::(\d{2}))?$/.exec(v);
  if (!m) return undefined;
  const zone = zoneOf(appConfig);
  const guess = Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +(m[6] || 0));
  if (!Number.isFinite(guess)) return undefined;
  // Date.UTC rolls out-of-range fields over (2026-02-31 → March 3, 25:00 →
  // next day 01:00); the input is only valid if it reads back unchanged.
  const g = new Date(guess);
  if (g.getUTCFullYear() !== +m[1] || g.getUTCMonth() !== +m[2] - 1 || g.getUTCDate() !== +m[3] ||
      g.getUTCHours() !== +m[4] || g.getUTCMinutes() !== +m[5] || g.getUTCSeconds() !== +(m[6] || 0)) return undefined;
  // Two passes settle the offset across a DST boundary.
  let utc = guess - offsetAt(guess, zone);
  utc = guess - offsetAt(utc, zone);
  return new Date(utc).toISOString().replace('T', ' ').replace(/\..+/, '');
}

// Parse a stored UTC 'YYYY-MM-DD HH:MM:SS' (or a Date) → epoch ms, or null.
function utcMs(stored) {
  if (stored == null || stored === '') return null;
  if (stored instanceof Date) return stored.getTime();
  const m = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})(?::(\d{2}))?/.exec(String(stored));
  if (!m) return null;
  return Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +(m[6] || 0));
}

// Stored UTC → '2027-03-13T10:00' for a datetime-local input ('' if none).
function utcToLocalInput(stored, appConfig) {
  const ms = utcMs(stored);
  if (ms == null) return '';
  const p = partsIn(ms, zoneOf(appConfig));
  return `${p.y}-${pad(p.mo)}-${pad(p.d)}T${pad(p.h)}:${pad(p.mi)}`;
}

// Stored UTC → 'Sat, Mar 13, 2027, 10:00 AM CDT' for display ('' if none).
function formatLocal(stored, appConfig, opts) {
  const ms = utcMs(stored);
  if (ms == null) return '';
  const o = Object.assign({
    timeZone: zoneOf(appConfig), weekday: 'short', year: 'numeric', month: 'short', day: 'numeric',
    hour: 'numeric', minute: '2-digit', timeZoneName: 'short'
  }, opts || {});
  return new Intl.DateTimeFormat('en-US', o).format(new Date(ms));
}

module.exports = { DEFAULT_ZONE, zoneOf, localInputToUtc, utcToLocalInput, utcMs, formatLocal };
