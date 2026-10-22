# Development guide

Practical notes for editing this app — how the build works, how to
add a page, how to debug Alpine, and the pitfalls we've already
walked into so you don't have to.

## Requirements

- Node.js (project tested on 20+; recently confirmed on 25.x).
- `npm`.
- A working `mmoa_web_app` checkout (or its `mmoa_web_app.db`) if
  you want to see real data; otherwise the console runs offline.

## Install + run

```bash
npm install
./START_APP.sh           # equivalent to `npm start`
```

`npm start` runs the `prestart` hook before booting:

```jsonc
"prestart": "npm run build:css && npm run copy:alpine"
```

That guarantees the built `public/css/tailwind.css` and the
`public/js/alpine.min.js` bundle are fresh before the server serves
them.

Useful scripts in [package.json](../package.json):

| Script              | Does                                                          |
| ------------------- | ------------------------------------------------------------- |
| `npm start`         | `prestart` → `node app.js`                                    |
| `npm run build:css` | Compile `tailwind.input.css` → `public/css/tailwind.css`      |
| `npm run watch:css` | Same, but watch source files for changes                      |
| `npm run copy:alpine` | Copy Alpine bundle from `node_modules` into `public/js/`    |

During active CSS work, leave `npm run watch:css` running in one
terminal and `node app.js` in another. The cache-buster on the
`<link>` tag means the browser picks up new CSS on the next page load
without a hard refresh.

## File layout — quick reference

```
app.js                          Express entry + middleware chain
config.json                     Runtime config (read live by views/layout, theme/webApp/security)
config/appConfig.js             Loader / saver / defaults / deepMerge
db/database.js                  Dual-engine SQLite/MySQL + dead-DB fallback
db/remoteSqlite.js              SQLite on the web-app host via the sqlite3 CLI (ssh / ec2 modes)
middleware/auth.js              requireAdmin, hash/verify, getPasswordRules, validatePassword
middleware/inputLimits.js       Per-field char caps
helpers/localAdmins.js          local_admins.json CRUD
helpers/webAppAccess.js         local / ssh / ec2 transport to the web app host
helpers/webAppConfig.js         read-modify-write of the web app's config.json + restart-pending flag
helpers/dbSchema.js             live-schema introspection (Data Browser, Backup)
helpers/awsSsm.js, awsLog.js, awsClientKey.js   SSM Run Command (ec2 mode only)
views/layout.js                 HTML shell + sidebar + themeCss + asset cache-buster
views/escapeHtml.js             escapeHtml(...) + jsAttrStr(...) for Alpine attributes
routes/                         All route handlers (one file per major section)
scripts/create-local-admin.js   CLI admin seeding
public/css/tailwind.css         Built — do not edit
public/js/alpine.min.js         Copied — do not edit
public/js/flatpickr.min.js      Copied (npm run copy:flatpickr) — do not edit; + public/css/flatpickr.min.css
public/js/date-picker.js        Turns any input[data-datetime] into a calendar + time picker (data-min-from="#id" for "not before")
helpers/sitePreview.js          The Preview button + pop-up and preview-link maker shared by Events and Raffles
public/js/flyer-maker.js        "Generate flyer": draws an event flyer on a canvas from the form + cover photo
public/fonts/*.woff2            Saira Condensed / Barlow (the website's fonts), copied by npm run copy:fonts — do not edit
public/js/ui-confirm.js         window.uiConfirm / uiConfirmSubmit (CSP-safe confirm dialog)
public/js/wa-preview.js         Web App Website section preview popup
public/images/                  Gitignored; runtime-uploaded backgrounds
tailwind.input.css              Tailwind v4 source (with @source + @theme + @layer components)
package.json                    Deps + scripts + _dependencies_info documentation
README.md                       Top-level project README
Docs/                           These detailed docs
```

## How to add a new page

The full flow takes about 5 minutes.

1. **Create a router** (or extend an existing one). The smallest
   shape:

   ```js
   // routes/mything.js
   const express = require('express');
   const { page, flash } = require('../views/layout');
   const { requireAdmin } = require('../middleware/auth');

   module.exports = function (appConfig /* , db, ... */) {
     const router = express.Router();

     router.get('/mything', requireAdmin, (req, res) => {
       const user = req.session.user;
       const body = `
         <header class="mb-8">
           <h1 class="text-2xl font-bold text-slate-900 dark:text-slate-100">My thing</h1>
           <p class="mt-1 text-sm text-slate-500 dark:text-slate-400">A new page.</p>
         </header>

         <div class="card surface-target card-pad">
           <p>Hello.</p>
         </div>
       `;
       res.send(page({ title: 'My thing', body, appConfig, user, activeNav: 'mything' }));
     });

     return router;
   };
   ```

2. **Wire it up** in [app.js](../app.js):

   ```js
   app.use('/', require('./routes/mything')(appConfig));
   ```

3. **Add a sidebar entry** in [views/layout.js](../views/layout.js)
   `sidebar(...)`:

   ```js
   ${navItem('/mything', 'My thing', '✦', activeNav === 'mything')}
   ```

   The icon is just a character — match the existing style or pick
   something distinctive.

4. **Rebuild Tailwind** if you used any new utility classes:

   ```bash
   npm run build:css
   ```

   (Or, with `watch:css` running, it rebuilds automatically.)

5. **Restart the server.** Route files are `require`d once at boot;
   changes won't take effect until restart.

## How to add an Alpine interaction

Alpine v3 is loaded once on every page (see
[views/layout.js](../views/layout.js)) and self-initializes on
`DOMContentLoaded`. Sprinkle in `x-data="…"` to create a reactive
scope, then use `x-show`, `x-model`, `x-on:click`, `:class`,
`:style`, `x-text`, etc.

Two things to remember:

1. **`'unsafe-eval'` is in CSP.** Alpine compiles its expressions via
   `new Function(...)`. If you ever tighten CSP further, anything
   using Alpine will silently stop working. There's no graceful
   degradation.

2. **Inline `x-init` runs at scope creation.** You can use `$watch`
   inside it to react to changes:

   ```html
   <div x-data="{ mode: 'light' }"
        x-init="$watch('mode', v => document.documentElement.classList.toggle('dark', v === 'dark'))">
     …
   </div>
   ```

## How to style something new

If a Tailwind utility class already does what you want, just put it
in the HTML — the build step picks it up by scanning the source
files declared in `@source` inside
[tailwind.input.css](../tailwind.input.css).

For frequently-reused composite styles, declare a component class in
the `@layer components` block. Example pattern (already used for
`.card`, `.btn-primary`, `.input`, `.pill-*`):

```css
@layer components {
  .my-thing {
    @apply inline-flex items-center gap-2 rounded-lg px-3 py-1.5
           text-sm font-medium bg-brand-100 text-brand-800
           dark:bg-brand-900/30 dark:text-brand-200;
  }
}
```

> **Note on `@apply` composition.** Tailwind v4 won't let you
> `@apply` one of your own component classes from inside another
> component class. We hit this earlier — the solution is to define
> the shared part as `.btn, .btn-primary, .btn-secondary { … }`
> (multi-selector) rather than `.btn-primary { @apply btn … }`.

After editing `tailwind.input.css`, run `npm run build:css` (or have
`watch:css` running).

## How to add a report

[routes/reports.js](../routes/reports.js) holds the registry. Each
entry has:

```js
'my-slug': {
  label: 'Human-readable name',
  description: 'One sentence shown on the report card.',
  needsDb: true,                 // false if it doesn't touch the DB
  columns: [
    { key: 'foo', label: 'Foo'},
    { key: 'bar', label: 'Bar'}
  ],
  async fetch({ db }) {
    return await db.allAsync(`SELECT foo, bar FROM widgets ORDER BY id`);
  }
}
```

The route + page automatically:

- Show the card on `/reports`.
- Serve `/reports/my-slug.csv` with a timestamped filename and
  RFC-4180 quoting.
- Refuse with a flash error if `needsDb && !db.available`.

## How to add a settings field

Two patterns depending on where it belongs.

### A live setting (theme-ish)

Used by the rendered page on every request — no restart needed. Add:

1. A default value in
   [config/appConfig.js](../config/appConfig.js).
2. A form field in the appropriate `GET /settings/<tab>` route.
3. A handler in the matching `POST /settings/<tab>` route that writes
   it back and calls `appConfigModule.save()`.
4. (Optional) Reading code wherever it's needed (`appConfig.xyz`).

### A boot-time setting (database-ish)

Same four steps, but flash the operator with **"Restart the app for
the change to take effect."** since the middleware that consumes it
is configured at boot.

### A Web App setting (the web app's `config.json`)

Web App Settings is descriptor-driven: add one entry to the tab's list in
`FIELDS` ([routes/webAppSettings.js](../routes/webAppSettings.js)) and the
form, the read-modify-write save and the restart-pending prompt all follow.
Also give the key a default in the **web app's** `config/appConfig.js` and
document it in its `Docs/configuration.md`.

- `path` — dotted key in the web app's `config.json` (also the form name).
- `type` — `text` | `password` | `number` (`min` / `max` / `def`) | `toggle`
  | `tristate` | `select` (`options`) | `textarea` | `heading`.
- `controller: true` — mirrors the live value into the form's Alpine `c` map
  (keyed by path) so other fields can `showWhen: "c['…'] === …"`.
- `guard` (toggles only) — `{ js: () => '<Alpine expression>', server: json
  => message }`: both return an error message, or `''` when it's fine to be
  ON. Switching the toggle on while the browser check fails flips it back
  off and shows the message; the form won't submit while a checked toggle
  fails; and the server re-checks after applying the form and refuses the
  save. Example: **Show the "Donate" button** needs a valid
  `site.donationUrl` (`donationUrlError` / `donationUrlErrorJs`). Guard
  expressions run through Alpine because the CSP allows no inline
  `<script>` (see *CSP and Alpine* below).

## How to add a sidebar tab

See [views/layout.js](../views/layout.js):

```js
nav.innerHTML = `
  ${navItem('/profile', 'Profile', '◉', activeNav === 'profile')}
  ${navItem('/', 'Dashboard', '⌂', activeNav === 'home')}
  …
`;
```

Inserting a new line in the right place + passing the matching
`activeNav` string from your route is enough. Remember that Alpine
expressions live inside double-quoted HTML attributes: put any
server-side string into them with `jsAttrStr()` (views/escapeHtml.js),
never `escapeHtml()` or `JSON.stringify()`. The `nav-item.active`
style highlights the current tab.

## Common pitfalls we've already hit

These are the foot-guns we've stepped on so far — documenting them so
you don't repeat the discovery.

### Morgan + cookie-session

Morgan resolves its tokens **after** the response is finished. Reading
`req.session` at that point causes `cookie-session` to try to refresh
the expiry cookie via `res.setHeader`, which throws
`ERR_HTTP_HEADERS_SENT`. Fix: capture the username on `req._loggedUser`
**during** the request (a small middleware right after `cookieSession`)
and have morgan's `:user` token read from there. See
[app.js](../app.js).

### `path.join` with absolute paths

```js
path.join('/some/relative/base', '..', '/an/absolute/path')
// → '/some/relative/base/an/absolute/path'    ← concatenates, not resets
```

`path.resolve` does the right thing for absolute paths.
`path.join` does not. The fix used by
[db/database.js](../db/database.js):

```js
const final = path.isAbsolute(fname)
  ? fname
  : path.resolve(path.join(__dirname, '..', fname));
```

### Tailwind `@apply` chaining

Tailwind v4 won't let you `@apply foo-bar` where `foo-bar` is one of
your own component classes. Use a multi-selector instead. See
"How to style something new" above.

### Alpine `:style` URLs

When binding `background-image` via `:style`, the URL inside `url()`
must be quoted because blob URLs contain colons. Pattern used in
[routes/settings.js](../routes/settings.js) Appearance preview:

```js
backgroundImage: image ? "url('" + image + "')" : ''
```

### Browser caching

Static assets are served with `Cache-Control: max-age=3600`. For
built assets ([tailwind.css](../public/css/tailwind.css) and
[alpine.min.js](../public/js/alpine.min.js)),
[views/layout.js](../views/layout.js) appends `?v=<mtime>` so a fresh
build invalidates the cache without a hard refresh. Layout JS is
required once at boot, so layout changes need a server restart to
appear.

### CSP and Alpine

If you ever tighten CSP, remember:

- `script-src` must include `'unsafe-eval'` for Alpine to run. It has no
  `'unsafe-inline'`, so an inline `<script>` in a page is **blocked** — put
  page logic in an Alpine expression or a file under `public/`.
- `img-src` must include `blob:` for the Appearance live preview to
  show newly-picked images.
- `style-src` must include `'unsafe-inline'` for the inline `<style>`
  block that carries theme colors.

## Debugging the running app

- **Server logs.** Tail the morgan stream + `console.*` calls. Search
  for subsystem tags: `[db]`, `[settings]`, `[nonprofits]`, `[events]`, `[raffles]`,
  `[uploads]`, `[data]`,
  `[reports]`, `[login]`, `[profile]`, `[admin]`, `[setup]`,
  `[backup]`, `[boot]`, `[session]`, `[localAdmins]`.
- **Alpine devtools.** The browser DevTools console can inspect any
  element's `_x_dataStack` to see Alpine's current state for that
  scope. Or just sprinkle `console.log` inside an `x-init` /
  `x-on:click` while debugging.
- **DB queries.** Drop a `console.log` next to the `db.allAsync(...)`
  call you're tracing, or temporarily switch to the non-`Async`
  variants which expose the row count via the callback's second arg.
- **404 page.** A request that doesn't match any route lands on the
  minimal "Not found" page in [app.js](../app.js). Check that route
  files are mounted in the right order; ordering matters when paths
  overlap (e.g. `/users/:id` vs `/users/me`).

## Git and house-keeping

- The `_dependencies_info` block in [package.json](../package.json) is
  the canonical comment for every dependency. Update it whenever you
  `npm install` something.
- `.gitignore` already covers `local_admins.json`,
  `public/images/`, and the usual. Add patterns there if you create
  more local-only files (e.g. a `*.db` cache, a `tmp/` dir).
- Commit `public/css/tailwind.css`, `public/js/alpine.min.js` and the
  flatpickr copies?
  Today, **yes** — they're regenerated on every `npm start` so they
  don't drift, but committing them lets the app run without a build
  step in environments where you can't reach npm. If you're
  uncomfortable with that, gitignore them and run `npm install &&
  npm run build:css && npm run copy:alpine` on deploy.

## What "done" looks like for a change

Reasonable bar for landing an edit:

- [ ] `node --check` passes for every edited `.js` file.
- [ ] `npm run build:css` runs cleanly.
- [ ] The page renders in both light and dark mode.
- [ ] The page renders with the DB offline (any DB call wrapped in
      `safeGet` / `safeAll`).
- [ ] Forms validate on the server, not just in the browser.
- [ ] Output that comes from user-controlled data is passed through
      `escapeHtml(...)`.
- [ ] Per-field caps in
      [middleware/inputLimits.js](../middleware/inputLimits.js) are
      reasonable for any new textarea.
- [ ] If you added a new dep, the `_dependencies_info` block is
      updated.
