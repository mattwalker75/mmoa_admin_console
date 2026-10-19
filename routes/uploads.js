// routes/uploads.js — two small helpers the content pages share.
//
//   GET  /wa-uploads/:kind/:file  → an image from the Web App's uploads/ tree,
//                                   so the console can show thumbnails of
//                                   flyers, prize photos, nonprofit photos…
//   POST /markdown-preview        → { html } — the description preview,
//                                   rendered by helpers/markdownLite.js (the
//                                   console's copy of the web app's renderer)
//
// Why a proxy instead of <img src="https://site/uploads/…">: the console's
// CSP only allows images from itself (img-src 'self'), the Web App may not be
// publicly reachable yet, and local / SSH mode can read the file directly.
// How the bytes are fetched depends on the access mode:
//   local, ssh — read the file through the transport (any size);
//   ec2        — SSM can only return ~18 KB of file per command, so the image
//                is fetched from the Web App's own public /uploads URL
//                (publicBaseUrl in its config.json); small files fall back to
//                an SSM read.
// The path is validated against the exact uploads contract
// (helpers/webAppUploads.js) before anything is read.

const express = require('express');
const { requireAdmin } = require('../middleware/auth');
const webAppAccess = require('../helpers/webAppAccess');
const uploads = require('../helpers/webAppUploads');
const { webAppPublicUrl } = require('../helpers/pageKit');
const { renderMarkdownLite } = require('../helpers/markdownLite');

async function fetchPublic(base, rel) {
  if (!/^https?:\/\//i.test(base || '')) return null;
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), 10000);
  try {
    const r = await fetch(`${base}/uploads/${rel}`, { signal: ctl.signal, redirect: 'follow' });
    if (!r.ok) return null;
    const buf = Buffer.from(await r.arrayBuffer());
    return uploads.sniffExt(buf) ? buf : null;
  } catch (e) {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

module.exports = function (appConfig) {
  const router = express.Router();

  router.get('/wa-uploads/:kind/:file', requireAdmin, async (req, res) => {
    const rel = `${req.params.kind}/${req.params.file}`;
    if (!uploads.isValidRel(rel)) return res.status(404).send('Not found');
    if (!webAppAccess.isConfigured(appConfig)) return res.status(404).send('Web App access is not configured');
    let buf = null;
    try {
      const accessor = webAppAccess.createAccessorFromConfig(appConfig);
      if (accessor.mode === 'ec2') buf = await fetchPublic(await webAppPublicUrl(appConfig), rel);
      if (!buf) buf = await accessor.readFile(uploads.absPath(accessor, rel));
    } catch (e) {
      return res.status(404).send('Image not available: ' + (e.message || e));
    }
    // Override the app-wide no-store: these files never change (every upload
    // gets a new random name), so a short private cache is safe.
    res.set('Cache-Control', 'private, max-age=600');
    res.type(uploads.mimeOf(rel)).send(buf);
  });

  router.post('/markdown-preview', requireAdmin, (req, res) => {
    const text = (req.body && typeof req.body.text === 'string') ? req.body.text : '';
    res.json({ ok: true, html: renderMarkdownLite(text) });
  });

  return router;
};
