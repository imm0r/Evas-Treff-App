/*
 * Shared plumbing: who is looking at the hub, and the small DOM and formatting
 * helpers every page has in common.
 *
 * Classic script, not an ES module, on purpose: modules are blocked under the
 * file:// origin, and "just open index.html" has to keep working when GitHub
 * Pages is not set up (or is down).
 */
(function (global) {
  'use strict';

  var PS = global.PS || (global.PS = {});
  var STORE = 'ps:';

  function read(key) {
    try { return global.localStorage.getItem(STORE + key) || ''; } catch (e) { return ''; }
  }
  function write(key, value) {
    try {
      if (value) global.localStorage.setItem(STORE + key, value);
      else global.localStorage.removeItem(STORE + key);
    } catch (e) { /* private mode: settings just do not survive the tab */ }
  }

  /*
   * The display name on this device.
   *
   * The account is the authority — every row records its author server-side —
   * but the name shown next to a photo is still this, because an account tied
   * to a face knows the family's spelling and an account without one has only
   * whatever its owner typed. Kept here so all four pages agree.
   */
  PS.name = function (value) {
    if (value === undefined) return read('name');
    write('name', value);
    return value;
  };

  // --- DOM helpers -------------------------------------------------------

  PS.el = function (tag, attrs, children) {
    var node = document.createElement(tag);
    Object.keys(attrs || {}).forEach(function (key) {
      if (key === 'class') node.className = attrs[key];
      else if (key === 'text') node.textContent = attrs[key];
      else if (key.slice(0, 2) === 'on') node.addEventListener(key.slice(2), attrs[key]);
      else if (attrs[key] !== null && attrs[key] !== undefined) node.setAttribute(key, attrs[key]);
    });
    (children || []).forEach(function (child) {
      node.appendChild(typeof child === 'string' ? document.createTextNode(child) : child);
    });
    return node;
  };

  PS.toast = function (message, kind) {
    var host = document.querySelector('.toasts');
    if (!host) {
      host = PS.el('div', { class: 'toasts' });
      document.body.appendChild(host);
    }
    var node = PS.el('div', { class: 'toast' + (kind ? ' toast--' + kind : ''), text: message });
    host.appendChild(node);
    setTimeout(function () { node.classList.add('is-leaving'); }, kind === 'error' ? 6000 : 3000);
    setTimeout(function () { node.remove(); }, kind === 'error' ? 6400 : 3400);
  };

  var WEEKDAYS = ['Sonntag', 'Montag', 'Dienstag', 'Mittwoch', 'Donnerstag', 'Freitag', 'Samstag'];
  var MONTHS = ['Januar', 'Februar', 'März', 'April', 'Mai', 'Juni', 'Juli',
    'August', 'September', 'Oktober', 'November', 'Dezember'];

  /** "2026-08-07" -> "Freitag, 7. August 2026", without pulling in Intl edge cases. */
  PS.formatDay = function (iso) {
    var parts = iso.split('-').map(Number);
    var date = new Date(parts[0], parts[1] - 1, parts[2]);
    if (isNaN(date.getTime())) return iso;
    return WEEKDAYS[date.getDay()] + ', ' + parts[2] + '. ' + MONTHS[parts[1] - 1] + ' ' + parts[0];
  };

  /**
   * "2026-08-07" -> "7. Aug.", for places where the full day does not fit.
   * The year only appears when it is not the current one: at a party this
   * year, printing it costs the width the caption needs for the time.
   */
  PS.formatDayShort = function (iso) {
    var parts = iso.split('-').map(Number);
    if (!MONTHS[parts[1] - 1]) return iso;
    var month = MONTHS[parts[1] - 1];
    var short = month.length > 5 ? month.slice(0, 3) + '.' : month;
    var year = parts[0] === new Date().getFullYear() ? '' : ' ' + parts[0];
    return parts[2] + '. ' + short + year;
  };

  /**
   * „5. – 10. August 2027", und nur so viel, wie sich wirklich unterscheidet.
   *
   * Der Monat zweimal zu nennen, wenn es derselbe ist, macht die Zeile länger
   * ohne sie genauer zu machen — und auf einem Telefon ist Länge das Einzige,
   * was knapp ist.
   */
  PS.formatRange = function (fromIso, toIso) {
    if (!toIso || toIso === fromIso) return PS.formatDay(fromIso);
    var a = fromIso.split('-').map(Number);
    var b = toIso.split('-').map(Number);
    var from = new Date(a[0], a[1] - 1, a[2]);
    if (isNaN(from.getTime())) return fromIso;

    var head = WEEKDAYS[from.getDay()] + ', ' + a[2] + '.';
    if (a[0] !== b[0]) head += ' ' + MONTHS[a[1] - 1] + ' ' + a[0];
    else if (a[1] !== b[1]) head += ' ' + MONTHS[a[1] - 1];
    return head + ' – ' + PS.formatDay(toIso);
  };

  PS.formatTime = function (hhmmss) {
    return hhmmss.slice(0, 2) + ':' + hhmmss.slice(2, 4);
  };

  PS.plural = function (n, one, many) {
    return n + ' ' + (n === 1 ? one : many);
  };

  /** "vor 5 Minuten", "gestern, 21:03" — a timestamp people read without doing sums. */
  PS.formatWhen = function (date) {
    var seconds = Math.round((Date.now() - date.getTime()) / 1000);
    if (seconds < 60) return 'gerade eben';
    if (seconds < 3600) return 'vor ' + PS.plural(Math.round(seconds / 60), 'Minute', 'Minuten');
    if (seconds < 21600) return 'vor ' + PS.plural(Math.round(seconds / 3600), 'Stunde', 'Stunden');

    var time = String(date.getHours()).padStart(2, '0') + ':' + String(date.getMinutes()).padStart(2, '0');
    var today = new Date();
    var sameDay = function (a, b) {
      return a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
    };
    if (sameDay(date, today)) return time + ' Uhr';
    var yesterday = new Date(today.getFullYear(), today.getMonth(), today.getDate() - 1);
    if (sameDay(date, yesterday)) return 'gestern, ' + time;
    return PS.formatDayShort([
      date.getFullYear(),
      String(date.getMonth() + 1).padStart(2, '0'),
      String(date.getDate()).padStart(2, '0')
    ].join('-')) + ', ' + time;
  };

  /**
   * „84,2 MB" statt „88293376".
   *
   * Lag früher in imaging.js, weil es dort zuerst gebraucht wurde. Das hat
   * gereicht, bis die Sicherungsseite eine Größe anzeigen wollte und dafür
   * die komplette Bilddekodierung hätte laden müssen — ein Zahlenformatierer
   * gehört zu den allgemeinen Helfern.
   */
  PS.formatBytes = function (bytes) {
    if (bytes < 1024) return bytes + ' B';
    if (bytes < 1024 * 1024) return Math.round(bytes / 1024) + ' KB';
    return (bytes / 1024 / 1024).toFixed(1).replace('.', ',') + ' MB';
  };

  PS.escapeError = function (error) {
    return (error && error.message) ? error.message : String(error);
  };
})(typeof globalThis !== 'undefined' ? globalThis : this);
