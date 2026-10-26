// Slow-page notice. Most console pages read the Web App's database, and when
// that database is on the EC2 instance each read is an SSM round trip, so a
// page can take a few seconds. If the next page hasn't arrived after a
// moment, show a small notice so it's clear the console is working.
(function () {
  var DELAY = 700, timer = null, box = null;
  function ensureBox() {
    if (box) return box;
    box = document.createElement('div');
    box.id = 'nav-progress';
    box.setAttribute('role', 'status');
    box.setAttribute('aria-live', 'polite');
    box.style.cssText = 'position:fixed;left:50%;top:16px;transform:translateX(-50%);z-index:9999;display:none;' +
      'max-width:min(560px,calc(100vw - 32px));padding:12px 16px;border-radius:12px;font-size:14px;line-height:1.4;' +
      'background:#0f172a;color:#f8fafc;box-shadow:0 10px 30px rgba(0,0,0,.25);align-items:center;gap:10px';
    box.innerHTML = '<span style="flex:none;width:16px;height:16px;border-radius:50%;border:2px solid #94a3b8;border-top-color:transparent;animation:navspin .8s linear infinite"></span>' +
      '<span><strong>Loading…</strong> fetching data from the Web App. Over the EC2 connection this can take a few seconds.</span>';
    var st = document.createElement('style');
    st.textContent = '@keyframes navspin{to{transform:rotate(360deg)}}';
    document.head.appendChild(st);
    document.body.appendChild(box);
    return box;
  }
  function show() { ensureBox().style.display = 'flex'; }
  function hide() { clearTimeout(timer); timer = null; if (box) box.style.display = 'none'; }
  function arm() { clearTimeout(timer); timer = setTimeout(show, DELAY); }
  // Downloads (backups, exports, CSV reports) don't replace the page, so no
  // pageshow would ever hide the notice — leave those alone.
  function isDownload(path) {
    return /\/(export|download)(\/|$)|\/bundle\/console-settings\/|\/api\//.test(path) ||
      /\.(json|csv|zip|gz|png|jpe?g|svg|pdf)$/i.test(path);
  }

  document.addEventListener('click', function (e) {
    if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
    var a = e.target.closest && e.target.closest('a[href]');
    if (!a || a.target === '_blank' || a.hasAttribute('download')) return;
    var href = a.getAttribute('href') || '';
    if (href.charAt(0) === '#' || /^(javascript|mailto|tel):/i.test(href)) return;
    var url;
    try { url = new URL(a.href, location.href); } catch (err) { return; }
    if (url.origin !== location.origin) return;
    if (url.pathname === location.pathname && url.search === location.search && url.hash) return;
    if (isDownload(url.pathname)) return;
    // Let other click handlers (confirm dialogs, Alpine) run first; only arm
    // if the browser is really about to navigate.
    setTimeout(function () { if (!e.defaultPrevented) arm(); }, 0);
  });
  document.addEventListener('submit', function (e) {
    var f = e.target;
    if (!f || f.target === '_blank' || f.hasAttribute('data-no-progress')) return;
    var action;
    try { action = new URL(f.getAttribute('action') || location.href, location.href); } catch (err) { return; }
    if (action.origin !== location.origin || isDownload(action.pathname)) return;
    setTimeout(function () { if (!e.defaultPrevented) arm(); }, 0);
  });
  window.addEventListener('pageshow', hide);
  window.addEventListener('pagehide', function () { clearTimeout(timer); });
})();
