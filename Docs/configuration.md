# Configuration

Two different `config.json` files are involved:

1. **This console's** `config.json` (repo root) — defaults in
   [config/appConfig.js](../config/appConfig.js), edited from **Settings**,
   saved atomically (temp file + rename). Keys starting with `_` are
   stripped on save.
2. **The web app's** `config.json` (`<appPath>/config.json` on the web-app
   host) — edited from **Web App Settings** with read-modify-write.

Missing keys are back-filled from the defaults at load (`deepMerge`), so
a partial file is fine.

## This console's `config.json`

| Key | Default | Restart? | Notes |
| --- | ------- | -------- | ----- |
| `port` | `3005` | yes | |
| `appTitle` | `"MMoA Admin Console"` | no | Sidebar, `<title>`, footer. |
| `appSubtitle` | `""` | no | Reserved. |
| `publicBaseUrl` | `"http://localhost:3005"` | no | Informational. |
| `server.ssl` | `false` | yes | When `true`, `keyPath` + `certPath` must exist or the app refuses to start. |
| `server.keyPath` / `server.certPath` | `""` | yes | PEM files. |
| `server.trustProxy` | `false` | yes | Express `trust proxy` (true → 1 hop). |
| `sessionKeyMode` | `"auto-generate"` | yes | `fixed` uses `sessionKeys`; anything else (or blank / placeholder keys) generates two random keys per boot — sessions end on restart. |
| `sessionKeys` | `["", ""]` | yes | Only with `fixed`. |
| `sessionMaxAgeHours` | `8` | yes | |
| `passwordMinLength` | `8` | no | Legacy mirror of `security.password.minLength`. |
| `templates.dir` | `"templates"` | no | Folder for raffle text templates (Settings → Templates); relative = inside the console folder. Created (with starter templates) on first use; gitignored. |
| `timeZone` | `"America/Chicago"` | no | IANA zone the Events / Raffles date-time fields are entered and shown in; the database stores UTC. Invalid → Chicago. Not in the committed `config.json` (default only). |
| `database.engine` | `"sqlite"` | yes | `sqlite`, `mysql`, or `""` (offline). |
| `database.sqlite.filename` | `"../mmoa_web_app/mmoa_web_app.db"` | yes | **Local mode:** path on this machine, relative to this repo or absolute. The file is never created by the console. **SSH / EC2 mode:** path on the web-app host, relative paths resolve against `webApp.<mode>.appPath` (the default still works there). |
| `database.mysql.host` / `port` / `database` / `user` / `password` | `localhost` / `3306` / `mmoa_web_app` / `mmoa_app` / `""` | yes | Must be reachable from this console. |
| `database.mysql.connectionLimit` | `5` | yes | |
| `security.rateLimiting.auth.windowSeconds` / `maxAttempts` | `300` / `10` | yes | Failed `/login` attempts per IP. |
| `security.headers.enabled` / `contentSecurityPolicy` | `true` / `true` | yes | helmet + CSP. |
| `security.session.secure` / `httpOnly` / `sameSite` | `null` / `true` / `"strict"` | yes | Cookie attributes. `secure: null` = auto — `Secure` whenever the console serves HTTPS (`server.ssl` true or an `https://` `publicBaseUrl`); an explicit `true` / `false` is authoritative. |
| `security.password.minLength` | `8` | no | Applies to console admins **and** to nonprofit passwords set from Nonprofits. |
| `security.password.requireUpper` / `requireLower` / `requireDigit` / `requireSymbol` | `false` | no | |
| `theme.mode` | `"light"` | no | `light` / `dark`. |
| `theme.login.*` / `theme.app.*` | blank / opacity `1` | no | See [appearance.md](appearance.md). |
| `webApp.mode` | `"local"` | DB: yes | `local`, `ssh`, `ec2`. A mode change flips a SQLite DB between direct and remote access, so Settings asks for a restart. |
| `webApp.local.appPath` | `"../mmoa_web_app"` | no | Relative to the console's working directory (START_APP.sh cd's to the repo) or absolute. |
| `webApp.ssh.host` / `port` / `username` / `privateKey` / `appPath` | `""` / `22` / `""` / `""` / `""` | no | Unencrypted PEM key, stored in plain text. |
| `webApp.ec2.runningInAws` | `false` | no | Use the console's instance profile instead of keys. |
| `webApp.ec2.accessKeyId` / `secretAccessKey` | `""` | no | Need `ssm:SendCommand` + `ssm:GetCommandInvocation`. |
| `webApp.ec2.region` / `instanceId` | `"us-east-1"` / `""` | no | |
| `webApp.ec2.appPath` | `"/home/mmoa/mmoa_web_app"` | no | Matches mmoa_web_app_infra. |
| `webApp.ec2.runAsUser` | `"mmoa"` | no | Commands run as `su - mmoa`. Blank = SSM default user. |
| `webApp.commands.start` / `stop` / `restart` | `./START_APP.sh` / `./STOP_APP.sh` / `./RESTART_APP.sh` | no | Run from the web app directory by the power bar. Blank disables a button. |
| `webApp.restartPending` | `false` | — | Bookkeeping: set when this console changed the web app's config.json, cleared by a successful Start / Restart. |

"Restart?" means a restart of **this console**. The Settings → Web App
page pops a "Restart required" dialog when a save changed something the
DB connection depends on.

## The web app's `config.json` (Web App Settings)

Edited fields, by tab. Every other key in the file (including
`_comment` notes and `sessionKeys`) is preserved untouched. Changes take
effect after a **web app** restart — the page prompts for one.

| Tab | Keys |
| --- | ---- |
| General | `appTitle`, `appSubtitle`, `orgName`, `publicBaseUrl`, `port`, `sessionKeyMode`, `sessionMaxAgeHours`, `passwordResetTokenTtlHours`, `allowMemberRegistration` (nonprofit sign-ups), `maintenanceCommand`, and **Public site info**: `site.phone`, `site.ein`, `site.facebookUrl`, `site.donationEnabled` + `site.donationUrl` (the website's "Donate" button — the switch refuses to turn on without a valid http(s) link, in the browser and again on save), `uploads.maxMb` (1–8) |
| Email | `email.transport` (`console` / `smtp` / `ses`), `email.from`, `email.replyTo`, **`email.showLinksInBrowser`** (TESTING / TEMPORARY — the web app also returns verification / reset links in its JSON and shows them on screen; turn off once email works), `email.smtp.*`, and the **AWS (SES credentials)** group: `aws.runningInAws`, `aws.accessKeyId`, `aws.secretAccessKey`, `aws.region` |
| Security | `passwordMinLength`, `security.verificationLinkExpiresMinutes`, `security.rateLimiting.auth.*`, `security.loginLockout.enabled` / `maxFailures` / `lockoutSeconds`, `security.session.secure` (Auto = `null` follows `server.ssl` / On / Off), `security.session.httpOnly` / `sameSite`, `security.headers.*` |
| Database | `database.engine`, `database.sqlite.filename`, `database.mysql.*` (the web app's own connection — the console's is under Settings → Web App) |
| Server | `server.ssl`, `server.keyPath`, `server.certPath`, `server.trustProxy` (hop count; 0 = off) |

The Maintenance Mode card on **Web App Website** runs
`maintenanceCommand` (default `./scripts/maintenance.sh`) from the web
app directory with `--enable --title '<t>' --message '<m>'`, `--disable`
or `--status`. Title and message are single-quoted for the shell.

## Files

| File | Tracked? | Contents |
| ---- | -------- | -------- |
| `config.json` | yes — committed with defaults and **blank secrets** | Fill in locally; don't commit real keys. Holds the Web App SSH private key / AWS secret and the MySQL password once set, so the console writes it at `0600` on every save (temp file created `0600` + rename + chmod). A fresh clone is `0644` until the first save — `chmod 0600 config.json` after cloning. It stays tracked because the infra scripts depend on it; keep the committed copy scrubbed. |
| `local_admins.json` | no (gitignored) | bcrypt hashes, `0600`. |
| `backups/` | no (gitignored) | Rebuild bundles — the web app's secrets, nonprofit password hashes and uploaded images — plus a `<bundle>.json.meta.json` summary sidecar per bundle (what the list page shows, so bundles aren't re-parsed on every view). Directory `0700`, files `0600`. |
| `public/images/` | no (gitignored) | Uploaded background images. |
