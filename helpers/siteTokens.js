// helpers/siteTokens.js — the {{tokens}} the website fills into its HTML
// sections, computed from the Web App's config.json the same way the web
// app does (routes/public.js siteFacts + contentTokens there — keep the two
// in step). Used by the Web App Website page so "Preview" shows a section
// with its tokens filled in. Values are plain strings; the preview escapes
// them like the website does.

'use strict';

function safeHttpUrl(u) {
  const s = String(u || '').trim();
  return /^https?:\/\/[^\s<>"']+$/i.test(s) ? s : '';
}

/** @param cfg the web app's config.json (parsed) @param extra { eventCount } */
function siteTokens(cfg, { eventCount = 0 } = {}) {
  const c = cfg || {};
  const site = c.site || {};
  const str = (v) => (v == null ? '' : String(v).trim());
  const line1 = str(site.addressLine1), line2 = str(site.addressLine2);
  const city = str(site.city), state = str(site.state), zip = str(site.zip);
  const cityLine = [city, [state, zip].filter(Boolean).join(' ')].filter(Boolean).join(', ');
  const phone = str(site.phone);
  const digits = phone.replace(/\D/g, '');
  return {
    appTitle: c.appTitle || 'Mission Men of Anna',
    appSubtitle: str(c.appSubtitle),
    orgName: c.orgName || 'Mission Men of Anna Inc',
    tagline: str(site.tagline),
    foundedYear: str(site.foundedYear),
    phone,
    phoneTel: digits.length === 10 ? '+1' + digits : digits,
    email: str(site.email),
    ein: str(site.ein),
    addressLine1: line1, addressLine2: line2, city, state, zip,
    address: [line1, line2, cityLine].filter(Boolean).join(', '),
    meetingInfo: str(site.meetingInfo),
    facebookUrl: safeHttpUrl(site.facebookUrl),
    instagramUrl: safeHttpUrl(site.instagramUrl),
    youtubeUrl: safeHttpUrl(site.youtubeUrl),
    xUrl: safeHttpUrl(site.xUrl),
    nextdoorUrl: safeHttpUrl(site.nextdoorUrl),
    donationUrl: (site.donationEnabled === true && safeHttpUrl(site.donationUrl)) || '',
    year: String(new Date().getFullYear()),
    eventCount: String(eventCount || 0)
  };
}

module.exports = { siteTokens };
