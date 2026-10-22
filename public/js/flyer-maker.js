// public/js/flyer-maker.js — draws an event or raffle flyer (1200 × 1600
// JPEG) in the browser from the form's CURRENT values plus a saved photo (the
// event's cover photo / the raffle's first prize photo).
// Used by the "Generate flyer" pop-up on the event edit page
// (routes/events.js → flyerMaker). Uploading it goes through the normal
// flyer upload (window.macUploadImage), so the server sees an ordinary image.
//
// The layout follows the website's dark "Iron & Field" look: cover photo
// across the top fading into the page colour, "MISSION MEN OF ANNA
// PRESENTS", the title (auto-sized to fit), summary, WHEN / WHERE cards, the
// registration note, "Benefiting …" and the event's web address. Fonts are
// the site's own (Saira Condensed / Barlow), self-hosted under /fonts/.
//
//   window.mmoaFlyer.collect(form, extra)       → data from an EVENT form
//   window.mmoaFlyer.collectRaffle(form, extra) → data from a RAFFLE form
//   window.mmoaFlyer.render(canvas, data)       → Promise (draws onto canvas)
//
// data: { coverUrl, kicker?, title, summary, cards? [{label, big, small}],
// note, footer?, url } — an event's cards (WHEN / WHERE) and footer
// ("Benefiting …") are built from its fields when not given.
(function () {
  'use strict';

  var W = 1200, H = 1600;
  var C = { page: '#18191a', card: '#242526', text: '#e4e6eb', muted: '#a7aeaa', soft: '#c9cfcc', green: '#7cd136', link: '#8fdc4f' };
  var HEAD = '"Saira Condensed", "Arial Narrow", sans-serif';
  var BODY = 'Barlow, system-ui, sans-serif';

  // ── Fonts (loaded once) ──────────────────────────────────────────────
  var fontsReady = null;
  function loadFonts() {
    if (fontsReady) return fontsReady;
    var list = [
      ['Saira Condensed', 'saira-condensed-latin-700-normal', '700'],
      ['Saira Condensed', 'saira-condensed-latin-800-normal', '800'],
      ['Barlow', 'barlow-latin-500-normal', '500'],
      ['Barlow', 'barlow-latin-700-normal', '700']
    ];
    fontsReady = Promise.all(list.map(function (f) {
      if (!window.FontFace) return null;
      var face = new FontFace(f[0], 'url(/fonts/' + f[1] + '.woff2)', { weight: f[2] });
      return face.load().then(function (ff) { document.fonts.add(ff); }).catch(function () { /* fall back to system fonts */ });
    }));
    return fontsReady;
  }

  function loadImage(src) {
    return new Promise(function (resolve) {
      if (!src) return resolve(null);
      var img = new Image();
      img.onload = function () { resolve(img); };
      img.onerror = function () { resolve(null); };
      img.src = src;
    });
  }

  // ── Text helpers ─────────────────────────────────────────────────────
  function font(ctx, weight, size, family) { ctx.font = weight + ' ' + size + 'px ' + family; }

  // Greedy word wrap; returns lines (a word longer than the width is kept whole).
  function wrap(ctx, text, maxW) {
    var words = String(text || '').split(/\s+/).filter(Boolean), lines = [], cur = '';
    words.forEach(function (w) {
      var t = cur ? cur + ' ' + w : w;
      if (cur && ctx.measureText(t).width > maxW) { lines.push(cur); cur = w; } else { cur = t; }
    });
    if (cur) lines.push(cur);
    return lines;
  }

  // Largest size (from max down to min) at which `text` fits in maxLines.
  function fitWrap(ctx, text, weight, family, maxSize, minSize, maxW, maxLines) {
    for (var s = maxSize; s >= minSize; s -= 4) {
      font(ctx, weight, s, family);
      var lines = wrap(ctx, text, maxW);
      if (lines.length <= maxLines && lines.every(function (l) { return ctx.measureText(l).width <= maxW; })) return { size: s, lines: lines };
    }
    font(ctx, weight, minSize, family);
    var all = wrap(ctx, text, maxW);
    if (all.length > maxLines) { all = all.slice(0, maxLines); all[maxLines - 1] = all[maxLines - 1].replace(/\s*\S*$/, '') + '…'; }
    return { size: minSize, lines: all };
  }

  // One line, shrunk until it fits maxW.
  function fitLine(ctx, text, weight, family, maxSize, minSize, maxW) {
    var s = maxSize;
    font(ctx, weight, s, family);
    while (s > minSize && ctx.measureText(text).width > maxW) { s -= 2; font(ctx, weight, s, family); }
    return s;
  }

  function roundRect(ctx, x, y, w, h, r) {
    ctx.beginPath();
    ctx.moveTo(x + r, y); ctx.arcTo(x + w, y, x + w, y + h, r); ctx.arcTo(x + w, y + h, x, y + h, r);
    ctx.arcTo(x, y + h, x, y, r); ctx.arcTo(x, y, x + w, y, r); ctx.closePath();
  }

  // ── Dates (form values are local wall time 'YYYY-MM-DDTHH:MM') ───────
  function parseLocal(v) {
    var m = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})/.exec(v || '');
    return m ? new Date(+m[1], +m[2] - 1, +m[3], +m[4], +m[5]) : null;
  }
  function clock(d) {
    var h = d.getHours(), m = d.getMinutes(), ap = h < 12 ? 'AM' : 'PM';
    h = h % 12 || 12;
    return h + (m ? ':' + String(m).padStart(2, '0') : '') + ' ' + ap;
  }
  function sameDay(a, b) { return a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate(); }
  function whenText(startV, endV) {
    var s = parseLocal(startV), e = parseLocal(endV);
    if (!s) return { big: 'Date to be announced', small: '' };
    var long = { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' };
    if (e && !sameDay(s, e)) {
      var short = { weekday: 'short', month: 'short', day: 'numeric' };
      return { big: s.toLocaleDateString('en-US', short) + ' – ' + e.toLocaleDateString('en-US', short) + ', ' + e.getFullYear(),
               small: clock(s) + ' – ' + clock(e) };
    }
    return { big: s.toLocaleDateString('en-US', long), small: e ? clock(s) + ' – ' + clock(e) : 'Starts ' + clock(s) };
  }

  function listNames(names) {
    if (names.length <= 1) return names.join('');
    return names.slice(0, -1).join(', ') + ' & ' + names[names.length - 1];
  }

  // ── Read the event form ──────────────────────────────────────────────
  function collect(form, extra) {
    var v = function (sel) { var el = form.querySelector(sel); return el ? String(el.value || '').trim() : ''; };
    var bens = [];
    form.querySelectorAll('[aria-label="Directory organization"]').forEach(function (sel) {
      var row = sel.closest('div');
      var nameEl = row && row.querySelector('[aria-label="Name"]');
      var name = sel.value ? (sel.selectedOptions[0] ? sel.selectedOptions[0].text.replace(/\s*\((hidden|unverified|rejected)\)\s*$/, '') : '')
                           : (nameEl ? nameEl.value.trim() : '');
      if (name) bens.push(name);
    });
    return Object.assign({
      title: v('[name=title]'), summary: v('[name=summary]'),
      starts: v('[name=starts_at]'), ends: v('[name=ends_at]'),
      venue: v('[name=venue_name]'), address: v('[name=address]'), city: v('[name=city]'),
      note: v('[name=registration_note]'), beneficiaries: bens
    }, extra || {});
  }

  // ── Draw ─────────────────────────────────────────────────────────────
  function render(canvas, d) {
    return Promise.all([loadFonts(), loadImage(d.coverUrl)]).then(function (res) {
      var cover = res[1];
      canvas.width = W; canvas.height = H;
      var ctx = canvas.getContext('2d');
      var X = 70, CW = W - 2 * X;

      ctx.fillStyle = C.page; ctx.fillRect(0, 0, W, H);

      // Cover photo across the top (object-fit: cover into 1200 × 900).
      if (cover) {
        var r = Math.max(W / cover.width, 900 / cover.height);
        var iw = cover.width * r, ih = cover.height * r;
        // Clip to the photo band: a tall (portrait) photo must not run
        // down behind the text and cards.
        ctx.save(); ctx.beginPath(); ctx.rect(0, 0, W, 900); ctx.clip();
        ctx.drawImage(cover, (W - iw) / 2, (900 - ih) / 2, iw, ih);
        ctx.restore();
      } else {
        var glow = ctx.createRadialGradient(W * 0.8, 120, 40, W * 0.8, 120, 900);
        glow.addColorStop(0, 'rgba(124,209,54,.35)'); glow.addColorStop(1, 'rgba(124,209,54,0)');
        ctx.fillStyle = glow; ctx.fillRect(0, 0, W, 900);
      }
      var fade = ctx.createLinearGradient(0, 0, 0, 900);
      fade.addColorStop(0, 'rgba(24,25,26,.7)'); fade.addColorStop(0.18, 'rgba(24,25,26,.25)'); fade.addColorStop(0.55, 'rgba(24,25,26,.45)'); fade.addColorStop(1, 'rgba(24,25,26,1)');
      ctx.fillStyle = fade; ctx.fillRect(0, 0, W, 900);

      ctx.textBaseline = 'alphabetic';

      // Kicker
      font(ctx, 800, 34, HEAD);
      if ('letterSpacing' in ctx) ctx.letterSpacing = '6px';
      ctx.fillStyle = C.link;
      ctx.fillText(d.kicker || (d.orgName || 'Mission Men of Anna').toUpperCase() + ' PRESENTS', X, 100);
      if ('letterSpacing' in ctx) ctx.letterSpacing = '0px';

      // Title (up to 3 lines, auto-sized) + summary, bottom-aligned above the cards.
      var t = fitWrap(ctx, (d.title || 'Event title').toUpperCase(), 800, HEAD, 150, 72, CW, 3);
      var tLine = Math.round(t.size * 0.92);
      font(ctx, 500, 40, BODY);
      var sum = d.summary ? wrap(ctx, d.summary, CW).slice(0, 2) : [];
      var blockBottom = 1010;
      var sumH = sum.length ? 20 + sum.length * 52 : 0;
      var y = blockBottom - sumH - (t.lines.length - 1) * tLine;
      ctx.fillStyle = C.text;
      font(ctx, 800, t.size, HEAD);
      // Soft shadow so the title reads over a busy photo.
      ctx.shadowColor = 'rgba(0,0,0,.55)'; ctx.shadowBlur = 24; ctx.shadowOffsetY = 4;
      t.lines.forEach(function (l, i) { ctx.fillText(l, X, y + i * tLine); });
      ctx.shadowColor = 'transparent'; ctx.shadowBlur = 0; ctx.shadowOffsetY = 0;
      if (sum.length) {
        font(ctx, 500, 40, BODY); ctx.fillStyle = C.soft;
        var sy = y + (t.lines.length - 1) * tLine + 20 + 46;
        sum.forEach(function (l, i) { ctx.fillText(l, X, sy + i * 52); });
      }

      // Info cards: given (raffle: DRAWING / TICKETS) or an event's WHEN / WHERE.
      var cards = d.cards;
      if (!cards) {
        var when = whenText(d.starts, d.ends);
        var whereBig = d.venue || d.city || '';
        var whereSmall = d.venue ? [d.address, d.city ? d.city + ', TX' : ''].filter(Boolean).join(', ') : (d.address || (d.city ? 'Texas' : ''));
        cards = [{ label: 'WHEN', big: when.big, small: when.small }];
        if (whereBig) cards.push({ label: 'WHERE', big: whereBig, small: whereSmall });
      }
      var gap = 24, cardW = (CW - gap * (cards.length - 1)) / cards.length, cardY = 1060, cardH = 220;
      cards.forEach(function (c, i) {
        var cx = X + i * (cardW + gap);
        ctx.fillStyle = C.card; roundRect(ctx, cx, cardY, cardW, cardH, 24); ctx.fill();
        var inner = cardW - 56;
        font(ctx, 700, 26, BODY); ctx.fillStyle = C.muted; ctx.fillText(c.label, cx + 28, cardY + 58);
        ctx.fillStyle = C.text; fitLine(ctx, c.big, 800, HEAD, 50, 28, inner); ctx.fillText(c.big, cx + 28, cardY + 122);
        if (c.small) { ctx.fillStyle = C.soft; fitLine(ctx, c.small, 500, BODY, 32, 20, inner); ctx.fillText(c.small, cx + 28, cardY + 172); }
      });

      // Registration note (accent), e.g. "$25 per car or bike · spectators free"
      if (d.note) {
        var n = fitWrap(ctx, d.note, 700, BODY, 40, 28, CW, 2);
        ctx.fillStyle = C.link;
        n.lines.forEach(function (l, i) { ctx.fillText(l, X, 1360 + i * Math.round(n.size * 1.3)); });
      }

      // Footer: beneficiaries + web address
      ctx.fillStyle = C.muted;
      var footer = d.footer != null ? d.footer : (d.beneficiaries && d.beneficiaries.length ? 'Benefiting ' + listNames(d.beneficiaries) : '');
      if (footer) {
        var b = fitWrap(ctx, footer, 700, BODY, 30, 22, CW, 2);
        var by = d.url ? 1488 : 1530;
        b.lines.forEach(function (l, i) { ctx.fillText(l, X, by - (b.lines.length - 1 - i) * Math.round(b.size * 1.3)); });
      }
      if (d.url) {
        ctx.fillStyle = C.green; fitLine(ctx, d.url, 700, BODY, 32, 20, CW); ctx.fillText(d.url, X, 1540);
      }
    });
  }

  // ── Read a raffle form ───────────────────────────────────────────────
  // Markdown-lite → plain text (first paragraph, for the summary line).
  function plainFirstParagraph(md) {
    var para = String(md || '').replace(/\r\n?/g, '\n').split(/\n\s*\n/).map(function (p) { return p.trim(); })
      .filter(function (p) { return p && !/^- /.test(p); })[0] || '';
    return para.replace(/\[([^\]]+)\]\([^)]*\)/g, '$1').replace(/[*_`]+/g, '').replace(/\s+/g, ' ').trim();
  }
  function firstSentence(t) {
    var s = String(t || '').replace(/\s+/g, ' ').trim();
    var m = /^(.+?[.!?])(\s|$)/.exec(s);
    return m ? m[1] : s;
  }
  function collectRaffle(form, extra) {
    var v = function (sel) { var el = form.querySelector(sel); return el ? String(el.value || '').trim() : ''; };
    var draw = parseLocal(v('[name=drawing_at]'));
    var drawBig = draw ? draw.toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' }) : 'Drawing date to be announced';
    var drawSmall = [draw ? clock(draw) : '', v('[name=drawing_location]')].filter(Boolean).join(' · ');
    var price = v('[name=ticket_price_text]');
    var total = v('[name=total_tickets]');
    var orgSel = form.querySelector('[name=beneficiary_org_id]');
    var orgName = orgSel && orgSel.value && orgSel.selectedOptions[0] ? orgSel.selectedOptions[0].text.replace(/\s*\((unverified|rejected)\)\s*$/, '') : '';
    var benText = v('[name=beneficiary_text]');
    return Object.assign({
      kicker: 'MISSION MEN OF ANNA RAFFLE',
      title: v('[name=title]'),
      summary: plainFirstParagraph(v('[name=prize_description_md]')),
      cards: [
        { label: 'DRAWING', big: drawBig, small: drawSmall },
        { label: 'TICKETS', big: price || 'See any MMoA member', small: total ? Number(total).toLocaleString('en-US') + ' tickets total' : 'Sold in person' }
      ],
      note: firstSentence(v('[name=how_to_buy]')),
      footer: benText || (orgName ? 'Benefiting ' + orgName : '')
    }, extra || {});
  }

  window.mmoaFlyer = { collect: collect, collectRaffle: collectRaffle, render: render, W: W, H: H };
})();
