/*
 * The shelf the albums stand on.
 *
 *   albums/<slug>/album.json    { "title": "...", "date": "2026-08-07" }
 *   albums/<slug>/photos|thumbs|comments/...
 *   people/                     shared by every album
 *
 * A repository from before there were several albums keeps its photos at the
 * root. That still reads, as one album named after the repository, so nothing
 * has to be moved for the app to open it.
 *
 * The whole shelf — titles, dates, how many photos each holds and which one to
 * show on its cover — comes out of the tree listing the app already fetches.
 * Opening the hub costs no requests beyond that one.
 */
(function (global) {
  'use strict';

  var PS = global.PS || (global.PS = {});
  var albums = {};

  var ROOT = 'albums/';
  var MANIFEST = 'album.json';

  albums.slugify = function (title) {
    return (title || '').normalize('NFD').replace(/[̀-ͯ]/g, '')
      .toLowerCase()
      .replace(/ä/g, 'ae').replace(/ö/g, 'oe').replace(/ü/g, 'ue').replace(/ß/g, 'ss')
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 40) || 'album';
  };

  albums.manifestPath = function (slug) { return ROOT + slug + '/' + MANIFEST; };

  /**
   * Read the shelf out of a tree listing.
   *
   * Titles come from each album.json, which needs one blob read apiece — but
   * only for albums, of which there are a handful, not photos, of which there
   * are hundreds. An album whose manifest will not parse still shows up, named
   * after its folder: a broken file should not hide someone's photos.
   */
  albums.load = async function (cfg, entries) {
    var manifests = [];
    var byAlbum = {};

    entries.forEach(function (entry) {
      if (entry.path.slice(0, ROOT.length) !== ROOT) return;
      var rest = entry.path.slice(ROOT.length);
      var cut = rest.indexOf('/');
      if (cut < 0) return;
      var slug = rest.slice(0, cut);
      var tail = rest.slice(cut + 1);
      var album = byAlbum[slug] || (byAlbum[slug] = { slug: slug, count: 0, cover: null, coverKey: '' });
      if (tail === MANIFEST) { manifests.push({ slug: slug, sha: entry.sha }); return; }
      if (tail.slice(0, 7) !== 'thumbs/') return;
      album.count++;
      // Newest thumbnail wins the cover; the path sorts chronologically.
      if (tail > album.coverKey) { album.coverKey = tail; album.cover = entry.sha; }
    });

    var found = Object.keys(byAlbum).map(function (slug) { return byAlbum[slug]; });

    /*
     * No albums/ folder: either a repository from before there were several,
     * with its photos at the root, or a brand new one with nothing in it at
     * all. Both are one album — the empty case matters, because a repository
     * straight out of tools/setup.sh has to be uploadable before anybody has
     * thought about naming anything.
     */
    if (!found.length) {
      var legacy = { slug: '', count: 0, cover: null, coverKey: '', title: cfg.title, date: '', legacy: true };
      entries.forEach(function (entry) {
        if (entry.path.slice(0, 7) !== 'thumbs/') return;
        legacy.count++;
        if (entry.path > legacy.coverKey) { legacy.coverKey = entry.path; legacy.cover = entry.sha; }
      });
      return [legacy];
    }

    await Promise.all(manifests.map(async function (m) {
      try {
        var parsed = JSON.parse(await PS.gh.blobText(cfg, m.sha));
        byAlbum[m.slug].title = parsed.title || m.slug;
        byAlbum[m.slug].date = parsed.date || '';
      } catch (error) {
        byAlbum[m.slug].title = m.slug;
      }
    }));

    found.forEach(function (album) {
      if (!album.title) album.title = album.slug;
      album.date = album.date || '';
    });

    // Newest first, by the date on the album, then by name.
    found.sort(function (a, b) {
      if (a.date !== b.date) return a.date < b.date ? 1 : -1;
      return a.title.localeCompare(b.title, 'de');
    });
    return found;
  };

  /** Where an album's files live: "albums/<slug>/", or "" for the old layout. */
  albums.prefix = function (album) {
    return album && album.slug ? ROOT + album.slug + '/' : '';
  };

  /** Create one. The manifest is the album — the folders appear with the photos. */
  albums.create = async function (cfg, title, date) {
    var slug = albums.slugify(title);
    var body = JSON.stringify({ title: title, date: date || '' }, null, 2) + '\n';
    await PS.gh.putFile(cfg, albums.manifestPath(slug),
      await PS.toBase64(new Blob([body], { type: 'application/json' })),
      'Album angelegt: ' + title);
    return { slug: slug, title: title, date: date || '', count: 0, cover: null };
  };

  PS.albums = albums;
})(typeof globalThis !== 'undefined' ? globalThis : this);
