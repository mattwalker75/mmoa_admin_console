# Appearance / theming

How dark mode, background images, background colors, and surface
translucency flow from the **Settings → Appearance** form to the
rendered page on every request.

## Where it's stored

All under `appConfig.theme` in `config.json`:

```json
"theme": {
  "mode": "light",                  // "light" | "dark"
  "login": {
    "backgroundImage": "/images/login_background_image-…jpg",
    "backgroundColor": "#0061ff",
    "cardOpacity": 0.79             // 0..1
  },
  "app": {
    "backgroundImage": "",
    "backgroundColor": "#1a1d22",
    "surfaceOpacity": 0.8           // 0..1
  }
}
```

Two independent profiles — `theme.login` controls **unauthenticated**
pages (login / setup), `theme.app` controls **authenticated** pages.

## How it's applied

[views/layout.js](../views/layout.js) renders the page shell on every
request. Two relevant pieces:

1. **`<html class="${themeMode}">`** — adds the `.dark` class when
   `theme.mode === 'dark'`. Tailwind's `dark:` variants are configured
   to look at any ancestor with this class (see the `@custom-variant
   dark` rule in [tailwind.input.css](../tailwind.input.css)).

2. **Inline `<style>` block** — emitted by the `themeCss(appConfig,
   isLoginPage)` helper. Picks the right profile, validates colors and
   image URLs, and writes:

   - `body { background-image: url('…'); … }` — when an image is set
     and passes `cssUrlSafe(...)` (matches `^/images/[A-Za-z0-9._-]+$`).
   - `body { background-color: …; }` — when no image but `isSafeCssColor`
     accepts the color (`#rgb`/`#rrggbb`/`rgba(...)`).
   - `.surface-target, .card, .table-wrap, … { background-color: rgba(…, α); }`
     — when the opacity slider is below 100%, surface elements get an
     `rgba()` overlay so the page background bleeds through. There's
     a `.dark` variant of the same rule with darker `rgb` triplets.

The URL safety regex matters: the inline style is server-rendered, and
a hand-edited or restored `config.json` could otherwise inject CSS via
the image URL. Anything outside `/images/<safe-name>` is dropped
silently and the color fallback (or nothing) is used.

## What "surface opacity" actually affects

The `app.surfaceOpacity` value is applied to every element with the
`surface-target` class — plus a few baseline selectors that are too
common to remember to tag:

- `.card` (login card, settings cards, etc.)
- `.table-wrap` (every data table)
- `.stat-card` (dashboard tiles)
- `aside.app-sidebar` (so the sidebar tints to match the rest)
- The top bar (when present)
- `.flash` banners

The text inside each surface stays fully opaque — the opacity is
applied to `background-color` only, not the `opacity` property. That
matters because lowering CSS `opacity` would also fade text and
make data unreadable.

## The Appearance tab UI

[routes/settings.js](../routes/settings.js) →
`GET /settings/appearance`. The form is one Alpine `x-data` scope
spanning three cards: **App theme**, **Login background**, **App
background**.

### Live preview

Each background block has a 192-px preview frame on the right and a
column of controls on the left. Inside the preview is a tiny mock card
("Login" / "Dashboard") whose `background-color` and `color` are
bound via `:style` to the current opacity + theme mode. As you drag
the slider, the preview tints in real time.

When a new image is picked via the file input, an Alpine `x-on:change`
handler creates an object URL with `URL.createObjectURL(file)` and
stores it in `stagedLogin` / `stagedApp`. The preview's
`backgroundImage` falls through this priority order:

```
stagedLogin (just-picked file)
    ↓ (if not staged)
existing /images/... URL (unless "Remove this image" is checked)
    ↓ (if cleared)
solid backgroundColor
```

This means the preview shows the new image **before** you save. Note
that CSP allows `blob:` in `img-src` so object URLs work.

### Theme toggle

The Light/Dark toggle uses the `.toggle` switch class declared in
[tailwind.input.css](../tailwind.input.css). It's bound via `:checked`
+ `x-on:change` rather than `x-model` so the unchecked value can be
omitted from the form submission entirely (which means
`req.body.mode` is `undefined` for light and `"dark"` for dark — the
POST handler interprets that simply).

A separate `x-init` watcher on the form's `x-data` keeps the
`<html>.dark` class in sync as you toggle, so the rest of the
Appearance page also reflects the change immediately:

```html
<form x-data="{ mode, … }" x-init="$watch('mode', v => document.documentElement.classList.toggle('dark', v === 'dark'))">
```

That's preview-only — until you click **Save appearance** the change
isn't persisted, and reloading would revert.

## Image uploads

[`multer`](https://github.com/expressjs/multer) handles
`multipart/form-data` on the appearance form. Configured with disk
storage targeting `public/images/`, with a generated filename:

```
<field>-<Date.now()>.<ext>
```

E.g. `login_background_image-1778986691230.jpg`. The fieldname is
sanitized (`[^a-z0-9_-]/gi` stripped) and the extension is whitelisted
to PNG / JPEG / GIF / WebP / SVG, defaulting to `.bin` otherwise. Total
file size capped at 8 MB.

### Replacing an existing image

The POST handler:

```js
if (newLoginImg) {                          // a new file was uploaded
  safeUnlinkUpload(login.backgroundImage);  // delete the old file
  login.backgroundImage = '/images/' + newLoginImg.filename;
} else if (b.login_background_image_clear === '1') {
  safeUnlinkUpload(login.backgroundImage);
  login.backgroundImage = '';
}
```

`safeUnlinkUpload(relUrl)` (see [routes/settings.js](../routes/settings.js)):

- Refuses anything that isn't `^/images/[A-Za-z0-9._-]+$`.
- `path.join`s with the absolute `imagesDir`, then double-checks the
  result starts with `imagesDir + path.sep` (defense in depth — `path.join`
  alone wouldn't catch a malicious filename that contains `..`).
- Uses `fs.unlinkSync` so the deletion completes before the response
  redirects (otherwise on a slow disk you can race and the file
  appears to still exist immediately after save).
- Logs the outcome: `deleted`, `already gone (ENOENT)`, or
  `failed: <reason>`.

### "Remove this image" UX

The checkbox stays visible (and uncheckable) once clicked: the
thumbnail dims (`opacity-30 grayscale`) and the label flips from
"Remove this image" to "Will be removed when saved". This avoids the
earlier UX issue where the whole thumbnail container would disappear
on the first click and the operator couldn't reverse course without
reloading.

## Files on disk

Background images live in [`public/images/`](../public/images/), which
is **gitignored**. The directory is created at runtime by
`routes/settings.js` if it doesn't exist:

```js
const imagesDir = path.join(__dirname, '..', 'public', 'images');
if (!fs.existsSync(imagesDir)) {
  try { fs.mkdirSync(imagesDir, { recursive: true }); } catch (e) {}
}
```

The static handler in [app.js](../app.js) serves
`public/images/<name>` at the URL `/images/<name>`, with
`Cache-Control: max-age=3600`. That's fine — uploaded filenames
include a timestamp so URLs are effectively content-addressed.

## Backup considerations

The Backup/Restore feature exports `theme` along with the rest of
Settings. **Background images themselves are NOT exported** — only the
URLs to them. Restoring a backup on a fresh machine without the image
files will result in broken image references; the layout's
`cssUrlSafe` guard silently drops them and falls back to the color (or
nothing). Re-upload the images after restore.

## Customizing the look further

Two ways:

1. **Use the Appearance tab** — for theme mode, backgrounds, opacity.
   No code changes needed.

2. **Edit Tailwind components** — see
   [tailwind.input.css](../tailwind.input.css). The `@theme` block
   declares the `brand-*` palette (currently violet — `#7c3aed` for
   `brand-600`); change those values and rerun `npm run build:css` to
   shift the accent color globally. Component classes like
   `.btn-primary`, `.card`, `.input` are also in there.

The `@source` directives in `tailwind.input.css` tell the CLI which
files to scan for class names, so as long as your new utility classes
appear somewhere under `routes/`, `views/`, `helpers/`, `middleware/`,
`scripts/`, `public/js/`, or `app.js`, they'll be compiled into the output CSS automatically.
