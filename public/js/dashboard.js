// Dashboard: the page arrives with placeholders and this fills them in from
// /dashboard/data. When the console reads the Web App's database on the EC2
// instance each query is an SSM round trip, so the page no longer waits for
// them. Does nothing on other pages.
(function () {
  function run() {
    var status = document.getElementById('dash-status');
    if (!status) return;
    var started = Date.now();
    var slowTimer = setTimeout(function () {
      var t = status.querySelector('span:last-child');
      if (t) t.textContent = 'Still loading from the Web App’s database — the EC2 instance can take several seconds to answer…';
    }, 6000);
    fetch('/dashboard/data', { headers: { 'Accept': 'application/json' }, credentials: 'same-origin' })
      .then(function (r) {
        if (r.redirected || r.status === 401 || r.status === 403) { location.reload(); throw new Error('signed out'); }
        return r.json().then(function (j) { if (!r.ok) throw new Error(j.error || ('HTTP ' + r.status)); return j; });
      })
      .then(function (d) {
        clearTimeout(slowTimer);
        var stats = d.stats || {};
        document.querySelectorAll('[data-stat]').forEach(function (el) {
          var v = stats[el.getAttribute('data-stat')];
          el.textContent = (v === null || v === undefined) ? '—' : String(v);
        });
        document.getElementById('dash-pending').innerHTML = d.pendingHtml || '';
        document.getElementById('dash-recent').innerHTML = d.recentHtml || '';
        document.getElementById('dash-banner').innerHTML = d.bannerHtml || '';
        status.remove();
      })
      .catch(function (e) {
        clearTimeout(slowTimer);
        if (e && e.message === 'signed out') return;
        status.className = 'flash-error mb-6';
        status.textContent = 'Could not load the dashboard data: ' + (e && e.message ? e.message : 'request failed') + '. Reload the page to try again.';
        document.querySelectorAll('[data-stat]').forEach(function (el) { el.textContent = '—'; });
        document.querySelectorAll('[data-dash-loading]').forEach(function (el) { el.textContent = 'Unavailable.'; });
      });
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', run); else run();
})();
