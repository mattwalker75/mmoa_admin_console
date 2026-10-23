// middleware/inputLimits.js — per-field body length cap.
// Same shape as car_show_admin_console's; the cap table is trimmed to the
// forms this console actually has.

const DEFAULT_MAX = 1000;

const FIELD_CAPS = {
  email: 255,
  name: 100,
  password: 256,
  password_confirm: 256,
  current_password: 256,
  new_password: 256,
  confirm_password: 256,
  // Pasted SSH private key (Settings → Web App). PEM keys run a few KB;
  // allow headroom for comments/longer key types. Without this the
  // DEFAULT_MAX (1000) would reject the form before the handler runs.
  sshPrivateKey: 20000,
  // Web App lifecycle commands (Settings → Web App) — short shell commands,
  // but allow headroom for su/ssh wrappers.
  cmd_start: 4000,
  cmd_stop: 4000,
  cmd_restart: 4000,
  // Web App Website — an HTML fragment posted by the editor. Generous cap
  // (still bounded by app.js's 64 KB body limit).
  html: 200000,
  // Data Browser row-key envelope (JSON of the primary-key values).
  key: 4000,
  // Events / Raffles: Markdown-lite descriptions (+ the JSON preview call),
  // the beneficiaries editor's JSON, and the longer plain-text fields.
  description_md: 20000,
  prize_description_md: 20000,
  text: 20000,
  beneficiaries_json: 20000,
  beneficiaries_text: 2000,
  how_to_buy: 4000,
  claim_requirements: 4000,
  // Nonprofits: verification note; Edit profile (the portal's limits —
  // routes/nonprofits.js readProfile) and Create (org_name).
  note: 2000,
  org_name: 200,
  what_to_bring: 2000,
  search_tags: 4000,
  contacts_json: 20000
};

// Data Browser edit / insert forms post one value per column as v__<n>
// (n = the column's position in the live schema). TEXT columns such as
// events.description can hold a few paragraphs, so they get a larger cap
// than DEFAULT_MAX. Still bounded by app.js's 64 KB body limit.
const PATTERN_CAPS = [
  { re: /^v__\d+$/, cap: 20000 }
];

function capFor(key) {
  if (FIELD_CAPS[key] !== undefined) return FIELD_CAPS[key];
  const p = PATTERN_CAPS.find(x => x.re.test(key));
  return p ? p.cap : DEFAULT_MAX;
}

function enforceInputLimits(req, res, next) {
  if (!req.body || typeof req.body !== 'object') return next();
  for (const key of Object.keys(req.body)) {
    const v = req.body[key];
    if (typeof v !== 'string') continue;
    const cap = capFor(key);
    if (v.length > cap) {
      const msg = `The "${key}" field is too long. Maximum ${cap} characters.`;
      const wantsJson = (req.get('accept') || '').includes('application/json') ||
                        (req.get('x-requested-with') === 'XMLHttpRequest') ||
                        (req.get('content-type') || '').includes('application/json');
      if (wantsJson) return res.status(400).json({ success: false, error: msg });
      return res.status(400).send(
        `<!DOCTYPE html><html><head><title>Input too long</title></head>` +
        `<body style="font-family:system-ui;padding:24px;max-width:520px;margin:auto;">` +
        `<h2>Input too long</h2><p>${msg}</p>` +
        // A plain link: the CSP (script-src without 'unsafe-inline') blocks
        // javascript: URLs, so history.back() here would do nothing.
        `<p><a href="/">← Home</a></p></body></html>`
      );
    }
  }
  next();
}

module.exports = { enforceInputLimits, FIELD_CAPS, DEFAULT_MAX };
