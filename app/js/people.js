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

  var people = {};

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

    return {
      photoSha: photoSha,
      people: parsed.people.filter(function (p) {
        return p && p.name && typeof p.x === 'number' && typeof p.y === 'number';
      })
    };
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

    function pick(person, spot) {
      chosen = person;
      spots.querySelectorAll('.who__spot').forEach(function (other) {
        other.classList.toggle('is-chosen', other === spot);
      });
      // background-size 500% then shifted so the face lands in the middle.
      crop.style.backgroundImage = img.style.backgroundImage || ('url(' + img.src + ')');
      crop.style.backgroundPosition = (person.x * 100) + '% ' + (person.y * 100) + '%';
      chosenName.textContent = person.name;
      proof.classList.remove('is-hidden');
      proof.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
    }

    document.body.appendChild(overlay);
    document.body.classList.add('is-locked');

    try {
      img.src = await PS.gh.blobUrl(cfg, map.photoSha);
      crop.style.backgroundImage = 'url(' + img.src + ')';
    } catch (error) {
      close();
      onTypeInstead();
    }
  };

  PS.people = people;
})(typeof globalThis !== 'undefined' ? globalThis : this);
