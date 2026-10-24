// public/js/sidebar-scroll.js — keep the sidebar's scroll position across
// page loads. Every console page is a full server render, so the sidebar
// <nav> (its own scroll area) would start at the top on each click; its
// scrollTop is saved to sessionStorage as it moves and restored here, right
// after the sidebar markup, before first paint. With nothing saved yet (or
// a restored position that hides it) the current page's link is brought
// into view. External file: the CSP has no 'unsafe-inline'.
(function () {
  'use strict';
  var KEY = 'mmoaSidebarScroll';
  var nav = document.querySelector('.app-sidebar nav');
  if (!nav) return;
  var saved = null;
  try { saved = sessionStorage.getItem(KEY); } catch (e) { /* private mode etc. */ }
  if (saved !== null && saved !== '') nav.scrollTop = parseInt(saved, 10) || 0;
  var active = nav.querySelector('.nav-item.active');
  if (active) {
    var top = active.offsetTop - nav.offsetTop, bottom = top + active.offsetHeight;
    if (top < nav.scrollTop || bottom > nav.scrollTop + nav.clientHeight) {
      nav.scrollTop = Math.max(0, top - nav.clientHeight / 2);
    }
  }
  nav.addEventListener('scroll', function () {
    try { sessionStorage.setItem(KEY, String(nav.scrollTop)); } catch (e) { /* ignore */ }
  }, { passive: true });
})();
