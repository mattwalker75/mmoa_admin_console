// helpers/formats.js — a VERBATIM copy of mmoa_web_app/helpers/formats.js (the nonprofit portal's normalizers). Keep the two files identical: the console's Edit profile validates exactly like the portal, so a change there must be copied here (and vice versa).
// helpers/formats.js — normalize + validate the contact fields a nonprofit
// enters in the portal (and at signup). Each normalizer returns the clean,
// stored form; '' for blank; null when the value can't be made valid, so the
// caller can reject it with a friendly message.
//
// The SPA mirrors these rules in frontend/.../core/formats.ts to format as
// people type; THIS file is the gatekeeper — keep the two in step.
//
// The admin console keeps a VERBATIM copy of this file
// (mmoa_admin_console/helpers/formats.js) so its org editor normalizes the
// same way. The two must stay identical — change them together.

'use strict';

// USPS codes for the 50 states, DC and the inhabited territories.
const US_STATES = Object.freeze([
  ['AL', 'Alabama'], ['AK', 'Alaska'], ['AZ', 'Arizona'], ['AR', 'Arkansas'], ['CA', 'California'],
  ['CO', 'Colorado'], ['CT', 'Connecticut'], ['DE', 'Delaware'], ['DC', 'District of Columbia'], ['FL', 'Florida'],
  ['GA', 'Georgia'], ['HI', 'Hawaii'], ['ID', 'Idaho'], ['IL', 'Illinois'], ['IN', 'Indiana'],
  ['IA', 'Iowa'], ['KS', 'Kansas'], ['KY', 'Kentucky'], ['LA', 'Louisiana'], ['ME', 'Maine'],
  ['MD', 'Maryland'], ['MA', 'Massachusetts'], ['MI', 'Michigan'], ['MN', 'Minnesota'], ['MS', 'Mississippi'],
  ['MO', 'Missouri'], ['MT', 'Montana'], ['NE', 'Nebraska'], ['NV', 'Nevada'], ['NH', 'New Hampshire'],
  ['NJ', 'New Jersey'], ['NM', 'New Mexico'], ['NY', 'New York'], ['NC', 'North Carolina'], ['ND', 'North Dakota'],
  ['OH', 'Ohio'], ['OK', 'Oklahoma'], ['OR', 'Oregon'], ['PA', 'Pennsylvania'], ['RI', 'Rhode Island'],
  ['SC', 'South Carolina'], ['SD', 'South Dakota'], ['TN', 'Tennessee'], ['TX', 'Texas'], ['UT', 'Utah'],
  ['VT', 'Vermont'], ['VA', 'Virginia'], ['WA', 'Washington'], ['WV', 'West Virginia'], ['WI', 'Wisconsin'],
  ['WY', 'Wyoming'], ['AS', 'American Samoa'], ['GU', 'Guam'], ['MP', 'Northern Mariana Islands'],
  ['PR', 'Puerto Rico'], ['VI', 'U.S. Virgin Islands']
]);

/** EIN → 'XX-XXXXXXX' (accepts digits with or without the dash). */
function normalizeEin(v) {
  const d = String(v || '').replace(/\D/g, '');
  if (!d) return '';
  return d.length === 9 ? d.slice(0, 2) + '-' + d.slice(2) : null;
}

/** State code or full name (any case) → 'TX'. Blank → 'TX' (the default). */
function normalizeState(v) {
  const s = String(v || '').trim();
  if (!s) return 'TX';
  const hit = US_STATES.find(([code, name]) => code === s.toUpperCase() || name.toLowerCase() === s.toLowerCase());
  return hit ? hit[0] : null;
}

/** US phone → '(123) 456-7890'. Accepts any punctuation and a leading 1. */
function formatPhone(v) {
  let d = String(v || '').replace(/\D/g, '');
  if (!d) return '';
  if (d.length === 11 && d[0] === '1') d = d.slice(1);
  if (d.length !== 10) return null;
  return `(${d.slice(0, 3)}) ${d.slice(3, 6)}-${d.slice(6)}`;
}

/** Phone extension: digits only, 1–6 of them ('' when blank). */
function normalizeExt(v) {
  const s = String(v || '').trim().replace(/^(ext\.?|x)\s*/i, '');
  if (!s) return '';
  return /^\d{1,6}$/.test(s) ? s : null;
}

/** Basic email shape: something@something.something, no spaces. Lower-cased. */
function normalizeEmail(v) {
  const s = String(v || '').trim().toLowerCase();
  if (!s) return '';
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s) && s.length <= 255 ? s : null;
}

/** Web address: adds https:// when no scheme was typed; http(s) with a dotted host only. */
function normalizeUrl(v) {
  let s = String(v == null ? '' : v).trim();
  if (!s) return '';
  if (!/^[a-z][a-z0-9+.-]*:/i.test(s)) s = 'https://' + s.replace(/^\/+/, '');
  try {
    const u = new URL(s);
    if (u.protocol !== 'https:' && u.protocol !== 'http:') return null;
    if (!/\.[a-z]{2,}$/i.test(u.hostname)) return null;
    const out = u.toString();
    return out.length <= 500 ? out : null;
  } catch (e) { return null; }
}

const FB_HOSTS = new Set(['facebook.com', 'www.facebook.com', 'm.facebook.com', 'web.facebook.com', 'fb.com', 'www.fb.com']);
/** Facebook page → 'https://www.facebook.com/<page>'. Accepts a full link,
 *  'facebook.com/page', 'fb.com/page', '@page' or just 'page'. */
function normalizeFacebook(v) {
  let s = String(v || '').trim();
  if (!s) return '';
  if (/^@?[A-Za-z0-9.\-]{2,80}$/.test(s) && !/\.(com|org|net)$/i.test(s)) s = 'facebook.com/' + s.replace(/^@/, '');
  if (!/^https?:\/\//i.test(s)) s = 'https://' + s;
  try {
    const u = new URL(s);
    if (!FB_HOSTS.has(u.hostname.toLowerCase())) return null;
    const path = u.pathname.replace(/\/+$/, '');
    if (!path || path === '/') return null;
    if (path === '/profile.php') {
      const id = u.searchParams.get('id');
      return id && /^\d+$/.test(id) ? `https://www.facebook.com/profile.php?id=${id}` : null;
    }
    if (!/^\/[A-Za-z0-9.\-_/]+$/.test(path)) return null;
    return 'https://www.facebook.com' + path;
  } catch (e) { return null; }
}

/** Instagram → 'https://www.instagram.com/<handle>/'. Accepts a full link,
 *  'instagram.com/handle', '@handle' or just 'handle'. */
function normalizeInstagram(v) {
  let s = String(v || '').trim();
  if (!s) return '';
  let handle;
  if (/^@?[A-Za-z0-9._]{1,30}$/.test(s)) handle = s.replace(/^@/, '');
  else {
    if (!/^https?:\/\//i.test(s)) s = 'https://' + s;
    try {
      const u = new URL(s);
      if (!['instagram.com', 'www.instagram.com', 'instagr.am', 'm.instagram.com'].includes(u.hostname.toLowerCase())) return null;
      handle = u.pathname.split('/').filter(Boolean)[0] || '';
    } catch (e) { return null; }
  }
  if (!/^[A-Za-z0-9._]{1,30}$/.test(handle)) return null;
  return `https://www.instagram.com/${handle}/`;
}

const MAX_TAGS = 40, MAX_TAG_LEN = 50;
/** Private search keywords: split on commas / new lines, tidy spaces, drop
 *  repeats (any case) → 'food bank, groceries, snap'. '' for none; null when
 *  there are too many or one is too long. */
function normalizeSearchTags(v) {
  const seen = new Set();
  const tags = [];
  for (const raw of String(v || '').split(/[,\n]+/)) {
    const t = raw.replace(/\s+/g, ' ').trim();
    if (!t || seen.has(t.toLowerCase())) continue;
    if (t.length > MAX_TAG_LEN) return null;
    seen.add(t.toLowerCase());
    tags.push(t);
  }
  return tags.length > MAX_TAGS ? null : tags.join(', ');
}

module.exports = {
  US_STATES, normalizeEin, normalizeState, formatPhone, normalizeExt, normalizeEmail,
  normalizeUrl, normalizeFacebook, normalizeInstagram, normalizeSearchTags, MAX_TAGS, MAX_TAG_LEN
};
