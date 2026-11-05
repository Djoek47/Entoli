// The site's "Ask Entoli" bar, run by @entoli/sdk (window.Entoli from /entoli.min.js).
(function () {
  'use strict';
  var S = window.__entoliSite; var E = window.Entoli;
  if (!S || !E) return;
  var cfg = window.__entoliConfig || {};
  fetch('/site.skill.json').then(function (r) { return r.json(); }).then(function (skill) {
    var lastSection = 'top';
    E.defineAct('page.go', {}, function (s) { var prev = lastSection; lastSection = s.section; if (s.section === 'top') window.scrollTo(0, 0); else S.go(s.section); return prev; },
      { undo: function (prev) { if (prev === 'top') window.scrollTo(0, 0); else S.go(prev); } });
    E.defineAct('studio.walk', {}, function () { S.go('studio'); S.walkAll(); }, { undo: function () { S.resetMap(); } });
    E.defineAct('studio.tab', {}, function (s) { S.go('studio'); var prev = S.currentTab(); S.tab(s.tab); return prev; }, { undo: function (prev) { S.tab(prev); } });
    E.defineAct('page.theme', {}, function (s) { var prev = document.documentElement.dataset.theme || ''; S.setTheme(s.theme); return prev; }, { undo: function (prev) { S.setTheme(prev); } });
    E.defineAct('account.connect', {}, function () { window.location.href = '/login'; },
      { prepare: function () { return { to: 'GitHub sign-in (read-only profile)' }; } });
    E.mount({ el: '#entoli-bar', skill: skill, mode: 'voice', fonts: false, placeholder: 'Ask Entoli to do anything on this page…', key: cfg.key, endpoint: cfg.endpoint });
    document.querySelectorAll('#suggest button').forEach(function (b) { b.onclick = function () { E.getEntoli().hear(b.textContent); }; });
    document.querySelectorAll('[data-go="connect"]').forEach(function (a) { a.addEventListener('click', function (e) { e.preventDefault(); E.getEntoli().hear('connect github'); }); });
  });
})();
