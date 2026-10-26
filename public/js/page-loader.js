// Page shell loader (see middleware/pageShell.js). On a shell page — a slow
// tab's frame with the "Loading…" line — set a one-time cookie for this URL
// and load it again; the browser keeps the shell (and its spinner) on screen
// until the real page arrives. Does nothing on other pages.
(function () {
  var shell = document.getElementById('page-shell');
  if (!shell) return;
  var key = shell.getAttribute('data-key');
  var url = location.pathname + location.search;
  // Same hash as the server (djb2 → base36).
  var h = 5381;
  for (var i = 0; i < url.length; i++) h = ((h * 33) ^ url.charCodeAt(i)) >>> 0;
  if (!key) key = 'pl_' + h.toString(36); // the server's key is the one it checks

  // Loop guard: if the shell keeps coming back (cookies blocked, say), stop
  // and offer a plain link instead of reloading forever.
  var tries = 0;
  try { tries = Number(sessionStorage.getItem(key) || 0) + 1; sessionStorage.setItem(key, String(tries)); } catch (e) {}
  if (tries > 3) {
    try { sessionStorage.removeItem(key); } catch (e) {}
    shell.className = 'flash-error mb-6';
    shell.textContent = 'This page could not finish loading. ';
    var a = document.createElement('a');
    a.href = url; a.textContent = 'Try again'; a.className = 'underline';
    shell.appendChild(a);
    return;
  }

  setTimeout(function () {
    var t = shell.querySelector('span:last-child');
    if (t) t.textContent = 'Still loading from the Web App’s database — the connection can take several seconds to answer…';
  }, 6000);

  document.cookie = key + '=1; Path=/; Max-Age=60; SameSite=Strict';
  location.replace(location.href);
})();

// On the real page, clear the loop counter for it.
(function () {
  if (document.getElementById('page-shell')) return;
  var url = location.pathname + location.search, h = 5381;
  for (var i = 0; i < url.length; i++) h = ((h * 33) ^ url.charCodeAt(i)) >>> 0;
  try { sessionStorage.removeItem('pl_' + h.toString(36)); } catch (e) {}
})();
