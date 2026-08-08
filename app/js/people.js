/*
 * "Wer bist du?" — answered by tapping your own face.
 *
 * The name under a photo is pure self-declaration either way, so typing it is
 * the worse version of the same thing: slower on a phone, and spelled three
 * different ways by the third relative. A group photo everybody already
 * recognises turns it into one tap.
 *
 * The map lives in the album repository, not in this code:
 *
 *   people/people.json   { "photo": "people/photo.jpg", "people": [...] }
 *   people/photo.jpg     the group photo
 *
 * So it is per-album, editable without touching the app, and — importantly —
 * the photo stays in the PRIVATE repository like every other picture. An album
 * without that file simply keeps the name field, so nothing breaks.
 */
(function (global) {
  'use strict';

  var PS = global.PS || (global.PS = {});
  var MAP_PATH = 'people/people.json';

  // How much of the photo's width the confirmation circle shows. Small enough
  // that one face fills it, wide enough to keep a little context.
  var CROP_FRAME = 0.13;

  var people = {};

  var loaded = { url: null, width: 0, height: 0, map: null };
  var waiting = [];

  /**
   * Where to put the photo so that `person` lands in the middle of a box of
   * `size` pixels. The same arithmetic the confirmation circle uses, and for
   * the same reason it cannot be done in percentages: those align a point of
   * the image with the matching point of the box, which is only the centre at
   * 50%, and a percentage size scales the width alone.
   */
  function framing(person, size) {
    var w = size / CROP_FRAME;
    var h = w * (loaded.height / loaded.width);
    return {
      image: 'url(' + loaded.url + ')',
      size: w + 'px ' + h + 'px',
      position: Math.min(0, Math.max(size - w, size / 2 - person.x * w)) + 'px ' +
                Math.min(0, Math.max(size - h, size / 2 - person.y * h)) + 'px'
    };
  }

  function find(name) {
    if (!loaded.map || !name) return null;
    var wanted = PS.album.slug(name);
    var hit = null;
    loaded.map.people.forEach(function (person) {
      if (PS.album.slug(person.name) === wanted) hit = person;
    });
    return hit;
  }

  /**
   * The spelling from the map, when the name matches someone on the photo.
   *
   * A name survives a file path as a slug, so "Eva-Maria" comes back out as
   * "Eva Maria" — the hyphen is indistinguishable from the space it replaced.
   * The map knows how it is really written; everything else falls through
   * unchanged.
   */
  people.display = function (name) {
    var person = find(name);
    return person ? person.name : name;
  };

  /**
   * A round crop of someone's face, or null when this album has no photo, the
   * name is not on it, or the photo has not arrived yet. Callers treat null as
   * "just show the name" — the face is decoration, never the only label.
   */
  people.avatar = function (name, size) {
    var person = loaded.url && find(name);
    if (!person) return null;
    var node = PS.el('span', { class: 'avatar', title: person.name, 'aria-hidden': 'true' });
    var f = framing(person, size);
    node.style.width = size + 'px';
    node.style.height = size + 'px';
    node.style.backgroundImage = f.image;
    node.style.backgroundSize = f.size;
    node.style.backgroundPosition = f.position;
    return node;
  };

  /** Run `fn` once the group photo is decoded, or right away if it already is. */
  people.whenReady = function (fn) {
    if (loaded.url) fn();
    else waiting.push(fn);
  };

  /**
   * Pull the photo in the background. Awaiting it would hold up the gallery
   * for a third of a megabyte, and the grid is perfectly usable without faces
   * next to the names — they appear when they appear.
   */
  function warm(cfg, map) {
    loaded.map = map;
    PS.gh.blobUrl(cfg, map.photoSha).then(function (url) {
      var probe = new Image();
      probe.onload = function () {
        loaded.url = url;
        loaded.width = probe.naturalWidth;
        loaded.height = probe.naturalHeight;
        waiting.splice(0).forEach(function (fn) { fn(); });
      };
      probe.src = url;
    }).catch(function () { /* no faces, just names */ });
  }

  /**
   * Read the map out of a tree listing the caller already has.
   * Returns null when this album has no photo picker, which is not an error.
   */
  people.load = async function (cfg, entries) {
    var mapEntry = null;
    entries.forEach(function (entry) {
      if (entry.path === MAP_PATH) mapEntry = entry;
    });
    if (!mapEntry) return null;

    var parsed;
    try {
      parsed = JSON.parse(await PS.gh.blobText(cfg, mapEntry.sha));
    } catch (error) {
      return null; // a broken map must not cost anyone the ability to sign in
    }
    if (!parsed || !Array.isArray(parsed.people) || !parsed.people.length) return null;

    var photoSha = null;
    entries.forEach(function (entry) {
      if (entry.path === parsed.photo) photoSha = entry.sha;
    });
    if (!photoSha) return null;

    var map = {
      photoSha: photoSha,
      people: parsed.people.filter(function (p) {
        return p && p.name && typeof p.x === 'number' && typeof p.y === 'number';
      })
    };
    warm(cfg, map);
    return map;
  };

  /**
   * Show the picker. Calls `onPicked(name)` once someone confirms, or
   * `onTypeInstead()` if they are not in the photo.
   */
  people.ask = async function (cfg, map, onPicked, onTypeInstead) {
    var el = PS.el;
    var chosen = null;

    var img = el('img', { class: 'who__image', alt: 'Familienfoto' });
    var spots = el('div', { class: 'who__spots' });
    var stage = el('div', { class: 'who__photo' }, [img, spots]);

    // The confirmation shows a blown-up crop around the tapped face. Eleven
    // targets on a phone screen is a lot of near-misses, and seeing the face
    // large beats trying to hit it precisely in the first place.
    var crop = el('div', { class: 'who__crop' });
    var chosenName = el('div', { class: 'who__name' });
    var confirm = el('button', {
      class: 'btn btn--primary btn--big',
      onclick: function () { if (chosen) { close(); onPicked(chosen.name); } }
    }, ['Das bin ich']);
    var proof = el('div', { class: 'who__proof is-hidden' }, [crop, chosenName, confirm]);

    var overlay = el('div', { class: 'who' }, [
      el('div', { class: 'who__box' }, [
        el('h2', { class: 'who__title', text: 'Wer bist du?' }),
        el('p', { class: 'who__lead', text: 'Tipp dich auf dem Foto an.' }),
        stage,
        proof,
        el('button', {
          class: 'btn btn--ghost btn--small who__opt-out',
          onclick: function () { close(); onTypeInstead(); }
        }, ['Ich bin nicht auf dem Foto'])
      ])
    ]);

    function close() {
      overlay.remove();
      document.body.classList.remove('is-locked');
    }

    map.people.forEach(function (person) {
      var spot = el('button', {
        class: 'who__spot',
        title: person.name,
        'aria-label': person.name,
        onclick: function () { pick(person, spot); }
      });
      spot.style.left = (person.x * 100) + '%';
      spot.style.top = (person.y * 100) + '%';
      spots.appendChild(spot);
    });

    /**
     * Put the face in the middle of the circle.
     *
     * Percentage background-position cannot do this: it aligns the P point of
     * the image with the P point of the box, which only coincides at 50% and
     * drifts further the closer a face sits to an edge. And a percentage
     * background-size scales the width only, so the vertical zoom silently
     * becomes a different one. Both in pixels, both computed.
     */
    function frame(person) {
      var box = crop.getBoundingClientRect();
      if (!box.width || !img.naturalWidth) return;
      // The picker can run before warm() has finished, so measure from the
      // element on screen rather than the cached copy.
      loaded.url = loaded.url || img.src;
      loaded.width = loaded.width || img.naturalWidth;
      loaded.height = loaded.height || img.naturalHeight;
      var f = framing(person, box.width);
      crop.style.backgroundImage = 'url(' + img.src + ')';
      crop.style.backgroundSize = f.size;
      crop.style.backgroundPosition = f.position;
    }

    function pick(person, spot) {
      chosen = person;
      spots.querySelectorAll('.who__spot').forEach(function (other) {
        other.classList.toggle('is-chosen', other === spot);
      });
      chosenName.textContent = person.name;
      // Reveal before measuring: a hidden element has no size, and frame()
      // needs the circle's real width to place the face in its middle.
      proof.classList.remove('is-hidden');
      frame(person);
      proof.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
    }

    document.body.appendChild(overlay);
    document.body.classList.add('is-locked');

    // Someone can tap before the photo has finished decoding, and the crop
    // needs its natural size to do the arithmetic. Redo it once that is known.
    img.addEventListener('load', function () { if (chosen) frame(chosen); });

    try {
      img.src = await PS.gh.blobUrl(cfg, map.photoSha);
    } catch (error) {
      close();
      onTypeInstead();
    }
  };

  PS.people = people;
})(typeof globalThis !== 'undefined' ? globalThis : this);
