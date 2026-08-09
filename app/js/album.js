/*
 * Names and days — the two things the screens agree on.
 *
 * A photo's uploader used to be a path segment, which is why a name has a
 * canonical short form at all. That form outlived the paths: it is still how
 * two spellings of the same person are recognised as one (see people.js), and
 * still what turns an album title into something that fits in a URL.
 */
(function (global) {
  'use strict';

  var PS = global.PS || (global.PS = {});

  PS.album = {
    /**
     * Reduce a display name to something comparable while keeping it
     * readable — umlauts survive, everything that could confuse a URL does not.
     */
    slug: function (name) {
      var cleaned = (name || '').normalize('NFC')
        .replace(/[^\p{L}\p{N}]+/gu, '-')
        .replace(/^-+|-+$/g, '')
        .slice(0, 24);
      return cleaned || 'Anonym';
    },

    /** An album title as it appears in ?album= — ASCII only, so it survives sharing. */
    slugify: function (title) {
      return (title || '').normalize('NFD').replace(/[̀-ͯ]/g, '')
        .toLowerCase()
        .replace(/ä/g, 'ae').replace(/ö/g, 'oe').replace(/ü/g, 'ue').replace(/ß/g, 'ss')
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-+|-+$/g, '')
        .slice(0, 40) || 'album';
    },

    /** Group a sorted item list into [{day, items}], keeping the sort order. */
    byDay: function (items) {
      var groups = [], current = null;
      items.forEach(function (item) {
        if (!current || current.day !== item.day) {
          current = { day: item.day, items: [] };
          groups.push(current);
        }
        current.items.push(item);
      });
      return groups;
    }
  };
})(typeof globalThis !== 'undefined' ? globalThis : this);
