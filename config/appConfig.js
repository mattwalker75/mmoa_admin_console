// config/appConfig.js — loads and saves config.json.
// Same pattern as car_show_admin_console/config/appConfig.js (and the web
// app's own config/appConfig.js) so changes to either repo's config layer
// can be cross-applied: defaults live here, config.json on disk overrides
// them, and deepMerge back-fills any key the file is missing.

const fs = require('fs');
const path = require('path');

const configPath = path.join(__dirname, '..', 'config.json');

const defaults = {
  port: 3005,
  appTitle: 'MMoA Admin Console',
  appSubtitle: '',
  publicBaseUrl: 'http://localhost:3005',
  server: { ssl: false, keyPath: '', certPath: '', trustProxy: false },
  sessionKeyMode: 'auto-generate',
  sessionKeys: ['', ''],
  sessionMaxAgeHours: 8,
  passwordMinLength: 8,

  // The zone event / raffle date-time fields are entered and shown in
  // (helpers/localTime.js). The database stores UTC; Anna, Texas is Central
  // time. Any IANA zone name works; an invalid one falls back to Chicago.
  timeZone: 'America/Chicago',

  // Reusable raffle text ("How to buy", "Claim requirements") — Settings →
  // Templates. A folder on this console's server; relative = inside the
  // console's folder. See helpers/templates.js.
  templates: { dir: 'templates' },

  // The console reads and writes the WEB APP's database (nonprofits, events,
  // raffles, board, directory lists, tokens, lockouts). How it is reached follows webApp.mode below: in local
  // mode the SQLite file is opened directly; in ssh / ec2 mode SQLite queries
  // run ON the web-app host through the transport (db/remoteSqlite.js).
  // MySQL is always a direct connection from this console.
  database: {
    engine: 'sqlite',
    sqlite: { filename: '../mmoa_web_app/mmoa_web_app.db' },
    mysql: { host: 'localhost', port: 3306, database: 'mmoa_web_app', user: 'mmoa_app', password: '', connectionLimit: 5 }
  },
  security: {
    rateLimiting: { auth: { windowSeconds: 300, maxAttempts: 10 } },
    headers: { enabled: true, contentSecurityPolicy: true },
    session: { secure: false, httpOnly: true, sameSite: 'strict' },
    password: {
      // Complexity rules applied at admin creation / password change time,
      // and to nonprofit passwords set from the Nonprofits page. (Login itself
      // doesn't re-check rules — the bcrypt hash is the source of truth —
      // but new/changed passwords must satisfy these.)
      minLength: 8,
      requireUpper: false,
      requireLower: false,
      requireDigit: false,
      requireSymbol: false
    }
  },
  theme: {
    mode: 'light',
    login: {
      backgroundImage: '',
      backgroundColor: '',
      cardOpacity: 1
    },
    app: {
      backgroundImage: '',
      backgroundColor: '',
      surfaceOpacity: 1
    }
  },

  // How this console reaches the Web App (a separate mmoa_web_app install)
  // to run commands, read files, and write files. Three access modes — see
  // helpers/webAppAccess.js:
  //   local — same host: current OS user + local fs/commands.
  //   ssh   — remote host over SSH/SFTP using a pasted private key.
  //   ec2   — remote EC2 instance driven via AWS SSM Run Command.
  // Each mode keeps its own sub-block so switching modes doesn't lose the
  // others' values (mirrors database.sqlite / database.mysql). `appPath` is
  // the root directory of the mmoa_web_app install on the target.
  webApp: {
    mode: 'local',
    local: {
      // Relative to this console's working directory (START_APP.sh cd's to
      // the repo root), or absolute.
      appPath: '../mmoa_web_app'
    },
    ssh: {
      host: '',
      port: 22,
      username: '',
      // Pasted PEM private key. Stored in plain text in config.json — lock
      // down file permissions. Must be an UNENCRYPTED key (no passphrase).
      privateKey: '',
      appPath: ''
    },
    ec2: {
      // When true, use the attached instance profile (no access key).
      runningInAws: false,
      accessKeyId: '',
      secretAccessKey: '',
      region: 'us-east-1',
      instanceId: '',
      appPath: '/home/mmoa/mmoa_web_app',
      // User to switch to before running commands (the web app's service
      // account on EC2). Blank = run as the default SSM user.
      runAsUser: 'mmoa'
    },
    // Shell commands run on the Web App host (via the access mode above) by
    // the Start / Stop / Restart buttons on the Web App Settings page. Each
    // runs FROM the web app directory. Blank disables the corresponding button.
    commands: {
      start: './START_APP.sh',
      stop: './STOP_APP.sh',
      restart: './RESTART_APP.sh'
    },
    // Set when this console changed the web app's config.json; the web app
    // reads its config once at boot, so the change isn't live until a
    // restart. Cleared by a successful Start / Restart from the power bar.
    restartPending: false
  }
};

function deepMerge(target, source) {
  for (const k of Object.keys(source)) {
    if (source[k] && typeof source[k] === 'object' && !Array.isArray(source[k])) {
      target[k] = deepMerge(target[k] && typeof target[k] === 'object' ? target[k] : {}, source[k]);
    } else if (target[k] === undefined) {
      target[k] = source[k];
    }
  }
  return target;
}

const appConfig = {};

function load() {
  let onDisk = {};
  if (fs.existsSync(configPath)) {
    try { onDisk = JSON.parse(fs.readFileSync(configPath, 'utf8')); }
    catch (e) { console.error('[config] Failed to parse config.json:', e.message); }
  } else {
    console.warn('[config] config.json not found — using defaults');
  }
  for (const k of Object.keys(appConfig)) delete appConfig[k];
  Object.assign(appConfig, onDisk);
  deepMerge(appConfig, JSON.parse(JSON.stringify(defaults)));
}

function save() {
  function strip(obj) {
    if (obj && typeof obj === 'object' && !Array.isArray(obj)) {
      const out = {};
      for (const k of Object.keys(obj)) {
        if (k.startsWith('_')) continue;
        out[k] = strip(obj[k]);
      }
      return out;
    }
    return obj;
  }
  // Atomic write: serialize to a temp file, then rename into place. rename is
  // atomic on POSIX, so a crash/kill mid-write can never leave config.json
  // truncated — which would otherwise make the next boot silently fall back to
  // all-defaults (losing Web App access, SSH key, DB engine, etc.).
  const data = JSON.stringify(strip(appConfig), null, 2);
  const tmp = configPath + '.tmp';
  fs.writeFileSync(tmp, data);
  fs.renameSync(tmp, configPath);
}

load();

module.exports = { appConfig, load, save, defaults };
