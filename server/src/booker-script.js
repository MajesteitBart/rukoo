// GET /booker.js (/meet/assets/booker.js without BOOKING_ORIGIN): the booking pages' only script, served from this
// server (script-src 'self'). The pages work without it. With it:
//   - a page that showed the host's zone, or the locale's clock, opens again in the browser's zone and with the clock
//     this browser picked before. It runs in <head>, so the times never show in the wrong zone first.
//   - days and months load without a full reload; the new times are announced through the page's live region.
// Any failure leaves the page as the server wrote it, and a failed load falls back to opening the link.
//
// The booking form's tz is always the zone the page was written in. It never takes the browser's zone directly: a
// zone the server can't read (Etc/Unknown, or one newer than its time zone data) would then be posted with every try.
//
// It is kept as text, in plain ES5 without template literals, so it needs no build step and runs as written.

export const BOOKER_JS = String.raw`(function () {
  'use strict';
  var root = document.documentElement;
  var CLOCK = 'rukoo.booking.clock';

  function stored() {
    try {
      return localStorage.getItem(CLOCK);
    } catch (e) {
      return null;
    }
  }

  function remember(value) {
    try {
      localStorage.setItem(CLOCK, value);
    } catch (e) {
      // Storage may be off; the link itself still switches the clock.
    }
  }

  function browserZone() {
    try {
      return Intl.DateTimeFormat().resolvedOptions().timeZone || null;
    } catch (e) {
      return null;
    }
  }

  // Before anything shows. The server writes every time; this only adds tz or clock to the address. A zone the server
  // doesn't know comes back without data-zone matching it, but tz is then in the address already, so it asks once.
  try {
    if (root.hasAttribute('data-switch')) {
      var url = new URL(location.href);
      var zone = browserZone();
      var clock = stored();
      var changed = false;
      if (root.hasAttribute('data-auto-zone') && zone && zone !== root.getAttribute('data-zone') && url.searchParams.get('tz') !== zone) {
        url.searchParams.set('tz', zone);
        changed = true;
      }
      if (root.hasAttribute('data-auto-clock') && (clock === '12' || clock === '24') && clock !== root.getAttribute('data-clock') && url.searchParams.get('clock') !== clock) {
        url.searchParams.set('clock', clock);
        changed = true;
      }
      if (changed) {
        root.classList.add('switching');
        location.replace(url.href);
        return;
      }
    }
  } catch (e) {
    root.classList.remove('switching');
  }

  var swapped = false;
  var pending = null;

  // A day or month without a full reload: the same address from the server, its booker put in place of this one.
  function swap(href, key) {
    var box = document.getElementById('booker');
    if (!box) {
      location.href = href;
      return;
    }
    if (pending) pending.abort();
    var controller = window.AbortController ? new AbortController() : null;
    pending = controller;
    box.setAttribute('aria-busy', 'true');
    fetch(href, { headers: { accept: 'text/html' }, credentials: 'same-origin', signal: controller ? controller.signal : undefined })
      .then(function (res) {
        if (!res.ok || res.redirected) throw new Error('Open the link instead');
        return res.text();
      })
      .then(function (html) {
        var next = new DOMParser().parseFromString(html, 'text/html').getElementById('booker');
        if (!next) throw new Error('Open the link instead');
        next = document.importNode(next, true);
        next.setAttribute('data-swapped', '');
        box.parentNode.replaceChild(next, box);
        history.pushState({ booker: true }, '', href);
        swapped = true;
        var times = next.querySelector('.times');
        var live = document.getElementById('live');
        if (live && times) live.textContent = times.getAttribute('data-status') || '';
        var safe = window.CSS && CSS.escape ? CSS.escape(key) : key;
        var focus = next.querySelector('[data-swap="' + safe + '"]') || next.querySelector(key === 'prev' || key === 'next' ? '#month-title' : '#times-title');
        if (focus) {
          if (focus.tagName !== 'A') focus.setAttribute('tabindex', '-1');
          focus.focus();
        }
      })
      .catch(function (err) {
        if (err && err.name === 'AbortError') return;
        location.href = href;
      });
  }

  function ready() {
    document.addEventListener('click', function (event) {
      var target = event.target;
      if (!target || !target.closest) return;
      var clock = target.closest('a[data-clock]');
      if (clock) remember(clock.getAttribute('data-clock'));
      var link = target.closest('#booker a[data-swap]');
      if (!link || event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
      if (!window.fetch || !window.DOMParser || !window.history || !history.pushState) return;
      event.preventDefault();
      swap(link.href, link.getAttribute('data-swap'));
    });

    window.addEventListener('popstate', function () {
      if (swapped) location.reload();
    });
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', ready);
  else ready();
})();
`;
