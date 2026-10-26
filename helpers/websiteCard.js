// helpers/websiteCard.js — the green "Website" card with its "Open website"
// button. Shown on Web App Website (above Images) and on Web App Settings
// (under Web App process) — one source so the two never drift.
//
// Which address it opens depends on where the Web App runs
// (resolveWebsiteAddress):
//   - local: the Web App's publicBaseUrl (localhost is fine — same machine).
//   - ec2:   the load balancer the instance is registered with, found through
//            read-only AWS calls (helpers/awsAlb.js). If there isn't one, a
//            non-localhost publicBaseUrl; never localhost.
//   - ssh:   a non-localhost publicBaseUrl, else http://<SSH host>:<app port>.

'use strict';

const { escapeHtml } = require('../views/escapeHtml');
const awsAlb = require('./awsAlb');

function isLocalUrl(u) {
  try {
    const h = new URL(u).hostname.replace(/^\[|\]$/g, '').toLowerCase();
    return h === 'localhost' || h.endsWith('.localhost') || h === '::1' || h === '0.0.0.0' || /^127\./.test(h);
  } catch (e) { return false; }
}

function cleanUrl(u) {
  const s = String(u || '').trim();
  return /^https?:\/\/[^\s<>"']+$/i.test(s) ? s : '';
}

// → { url, note, alt, error, missing }
async function resolveWebsiteAddress(appConfig, waConfigJson) {
  const wa = (appConfig && appConfig.webApp) || {};
  const mode = wa.mode || 'local';
  const configured = cleanUrl(waConfigJson && waConfigJson.publicBaseUrl);
  const configuredPublic = configured && !isLocalUrl(configured) ? configured : '';

  if (mode === 'ec2') {
    const ec2 = wa.ec2 || {};
    try {
      const alb = await awsAlb.findAlbForInstance(ec2);
      if (alb.found) {
        const health = alb.health === 'healthy' ? 'healthy'
          : `${alb.health}${alb.healthReason ? ` — ${alb.healthReason}` : ''}`;
        // An https:// public base URL wins: with it the Web App sends HSTS /
        // upgrade-insecure-requests, so the plain-HTTP load balancer address
        // would no longer load the site (and an https:// load-balancer DNS
        // name wouldn't match a certificate).
        if (/^https:\/\//i.test(configuredPublic)) {
          return {
            url: configuredPublic,
            note: `The Web App's public base URL. Load balancer ${alb.name} (instance ${ec2.instanceId}: ${health}).`,
            warn: alb.health !== 'healthy' ? `The load balancer reports the Web App as ${health}, so the site may not load.` : '',
            alt: ''
          };
        }
        return {
          url: alb.url,
          note: `Load balancer ${alb.name} (target group ${alb.targetGroup}, instance ${ec2.instanceId}: ${health}).`,
          warn: alb.health !== 'healthy' ? `The load balancer reports the Web App as ${health}, so the site may not load.` : '',
          alt: configuredPublic && new URL(configuredPublic).host !== new URL(alb.url).host ? configuredPublic : ''
        };
      }
      if (configuredPublic) return { url: configuredPublic, note: `Instance ${ec2.instanceId} is not behind a load balancer; this is the Web App's public base URL.` };
      return { url: '', missing: `Instance ${escapeHtml(ec2.instanceId || '(not set)')} is not registered with any load balancer, and the Web App's public base URL is ${configured ? escapeHtml(configured) + ' (localhost — only reachable on the instance itself)' : 'not set'}.` };
    } catch (e) {
      const why = e && (e.name === 'AccessDenied' || e.name === 'AccessDeniedException' || /not authorized/i.test(e.message || ''))
        ? 'the AWS credentials are not allowed to read load balancers (needs elasticloadbalancing:DescribeTargetGroups, DescribeTargetHealth and DescribeLoadBalancers — in the mmoa_admin_console policy)'
        : (e && e.message) || 'AWS lookup failed';
      if (configuredPublic) return { url: configuredPublic, note: "The Web App's public base URL.", error: `Could not look up the load balancer: ${why}.` };
      return { url: '', missing: `Could not look up the load balancer: ${escapeHtml(why)}.` };
    }
  }

  if (mode === 'ssh') {
    if (configuredPublic) return { url: configuredPublic, note: "The Web App's public base URL." };
    const host = ((wa.ssh || {}).host || '').trim();
    const port = Number(waConfigJson && waConfigJson.port) || 3004;
    if (host) {
      const ssl = !!(waConfigJson && waConfigJson.server && waConfigJson.server.ssl);
      const h = host.includes(':') && !host.startsWith('[') ? `[${host}]` : host;
      return { url: `${ssl ? 'https' : 'http'}://${h}:${port}`, note: `The SSH host on the Web App's port (its public base URL is ${configured ? 'localhost' : 'not set'}).` };
    }
    return { url: '', missing: 'No SSH host is set under Settings → Web App.' };
  }

  // local — same machine, so localhost is right.
  return configured ? { url: configured } : { url: '' };
}

function websiteLinkCard(addr) {
  const a = (addr && typeof addr === 'object') ? addr : { url: cleanUrl(addr) };
  const url = String(a.url || '').trim();
  const body = url
    ? `<div class="mt-3 flex flex-wrap items-center gap-3">
        <a href="${escapeHtml(url)}" target="_blank" rel="noopener" class="font-mono text-sm font-semibold text-emerald-700 dark:text-emerald-300 hover:underline break-all">${escapeHtml(url)}</a>
        <a href="${escapeHtml(url)}" target="_blank" rel="noopener" class="inline-flex items-center gap-1.5 rounded-lg bg-emerald-600 px-4 py-2 text-sm font-semibold text-white shadow-sm hover:bg-emerald-700 focus:outline-none focus-visible:ring-2 focus-visible:ring-emerald-500">Open website <span aria-hidden="true">↗</span></a>
      </div>
      ${a.note ? `<p class="mt-2 text-xs text-slate-500 dark:text-slate-400">${escapeHtml(a.note)}</p>` : ''}
      ${a.alt ? `<p class="mt-1 text-xs text-slate-500 dark:text-slate-400">Public base URL: <a href="${escapeHtml(a.alt)}" target="_blank" rel="noopener" class="font-mono text-emerald-700 dark:text-emerald-300 hover:underline break-all">${escapeHtml(a.alt)}</a></p>` : ''}
      ${a.warn ? `<div class="mt-3 flash-error text-sm">${escapeHtml(a.warn)}</div>` : ''}
      ${a.error ? `<div class="mt-3 flash-error text-sm">${escapeHtml(a.error)}</div>` : ''}`
    : `<div class="mt-3 flash-error text-sm">${a.missing
        ? `${a.missing} Set <code class="font-mono">publicBaseUrl</code> under <a class="underline" href="/web-app-settings/general">Web App Settings → General</a>.`
        : `No public address is configured yet. Set <code class="font-mono">publicBaseUrl</code> under <a class="underline" href="/web-app-settings/general">Web App Settings → General</a>.`}</div>`;
  return `<div class="card surface-target card-pad border-2 border-emerald-500 dark:border-emerald-600">
    <h2 class="text-base font-semibold text-emerald-800 dark:text-emerald-200">Website</h2>
    <p class="mt-0.5 text-xs text-slate-500 dark:text-slate-400">The live site as visitors see it. Opens in a new browser window.</p>
    ${body}
  </div>`;
}

// Start the load balancer lookup early (EC2 mode) so it runs alongside the
// page's own reads; resolveWebsiteAddress then picks up the same request.
function prefetchWebsiteAddress(appConfig) {
  const wa = (appConfig && appConfig.webApp) || {};
  if (wa.mode === 'ec2') awsAlb.findAlbForInstance(wa.ec2 || {}).catch(() => {});
}

module.exports = { websiteLinkCard, resolveWebsiteAddress, prefetchWebsiteAddress, isLocalUrl };
