/*
 * The upload page — the part relatives actually touch.
 *
 * Design constraint: someone's aunt, on a phone, on hotel wifi. So: one button
 * and nothing to fill in. Who you are comes from the account you signed in
 * with, not from a text field, so a name can no longer be typed three
 * different ways by the third relative.
 *
 * Each photo is shrunk on the device before it goes anywhere, which is what
 * makes uploading forty holiday photos over a bad connection survivable.
 */
(function (global) {
  'use strict';

  var PS = global.PS;
  var el = PS.el;

  var PHOTO_EDGE = 2560, PHOTO_QUALITY = 0.85;
  var THUMB_EDGE = 480, THUMB_QUALITY = 0.7;

  var state = {
    me: null,
    album: null,      // which album the photos go into
    people: null,     // the face map, or null when the hub has no group photo
    typing: false,    // someone chose to type their name instead
    known: new Set(), // content hashes already in the album
    jobs: [],
    running: 0,
    uploaded: 0,
    savedBytes: 0
  };

  var nodes = {};

  async function boot() {
    try {
      state.me = await PS.data.me();
    } catch (error) {
      PS.sb.signOut();
      location.reload();
      return;
    }
    // The account's own name wins over anything typed on this device: it comes
    // from the invitation, and the server records it on everything you write.
    if (state.me && state.me.name) PS.name(state.me.name);

    renderShell();

    try {
      var shelf = await PS.data.albums();
      state.album = chooseAlbum(shelf);
      if (!state.album) {
        nodes.status.textContent = shelf.length
          ? 'Welches Album? Bitte über die Übersicht auswählen.'
          : 'Es gibt noch kein Album. Leg auf der Übersicht eins an.';
        nodes.status.classList.add('is-error');
        nodes.back.href = 'index.html';
        return;
      }
      nodes.title.textContent = state.album.title;
      document.title = 'Hochladen · ' + state.album.title;
      nodes.back.href = 'index.html?album=' + encodeURIComponent(state.album.slug);

      state.known = await PS.data.knownHashes(state.album.id);
      state.people = await PS.people.load();
      showCount();
    } catch (error) {
      nodes.status.textContent = PS.escapeError(error);
      nodes.status.classList.add('is-error');
      return;
    }

    nodes.shoot.disabled = false;
    nodes.pick.disabled = false;
    applyPeople();
    PS.people.whenReady(showName);
    showName();

    // Signed in, but the account is not tied to a face yet: ask once, by
    // tapping the group photo, and remember the answer on the profile so no
    // other device ever asks again.
    if (!PS.name() && state.people) askWho();
  }

  /** Kept in step with every upload, so it never contradicts the summary below it. */
  function showCount() {
    nodes.status.textContent = state.known.size
      ? 'Im Album sind ' + PS.plural(state.known.size, 'Foto', 'Fotos') + '.'
      : 'Noch keine Fotos im Album — mach den Anfang.';
  }

  function applyPeople() {
    if (!state.people) return;
    nodes.whoButton.classList.remove('is-hidden');
    nodes.name.classList.toggle('is-hidden', !!PS.name() || state.typing);
  }

  function askWho() {
    PS.people.ask(state.people, function (name) {
      PS.name(name);
      nodes.name.value = name;
      state.typing = false;
      showName();
      updatePickState();
      // Best effort: the upload works either way, and a face that failed to
      // stick is a question asked twice, not a lost photo.
      PS.data.linkMe(name).catch(function () {});
    }, function () {
      state.typing = true;
      nodes.name.classList.remove('is-hidden');
      nodes.name.focus();
    });
  }

  function showName() {
    nodes.whoFace.innerHTML = '';
    var face = PS.people.avatar(PS.name(), 34);
    nodes.whoFace.classList.toggle('is-hidden', !face);
    if (face) nodes.whoFace.appendChild(face);
    nodes.whoLabel.textContent = PS.name() ? PS.name() : 'Wer bist du?';
    nodes.whoButton.textContent = PS.name() ? 'Nicht ' + PS.name() + '?' : 'Auf dem Foto antippen';
    nodes.name.classList.toggle('is-hidden', !!PS.name() && !state.typing);
  }

  /** Same rule as the gallery: ?album names one, a lone album needs no naming. */
  function chooseAlbum(shelf) {
    var wanted = new URLSearchParams(location.search).get('album');
    if (wanted !== null) {
      var hit = null;
      shelf.forEach(function (album) { if (album.slug === wanted) hit = album; });
      return hit;
    }
    return shelf.length === 1 ? shelf[0] : null;
  }

  function renderShell() {
    var app = document.getElementById('app');
    app.innerHTML = '';

    nodes.name = el('input', {
      class: 'field',
      type: 'text',
      maxlength: '24',
      placeholder: 'z. B. Oma Lotte',
      value: PS.name(),
      autocomplete: 'name'
    });
    nodes.name.addEventListener('input', function () {
      PS.name(nodes.name.value.trim());
      updatePickState();
      nodes.whoLabel.textContent = PS.name() || 'Wer bist du?';
    });

    nodes.whoFace = el('span', { class: 'who__face is-hidden' });
    nodes.whoLabel = el('strong', { class: 'who__current', text: PS.name() || 'Wer bist du?' });
    nodes.whoButton = el('button', {
      class: 'btn btn--small is-hidden',
      onclick: askWho
    }, ['Auf dem Foto antippen']);

    // Two file inputs, because they open different things. Without `capture`
    // the phone shows its picker (gallery, and camera somewhere in there);
    // with it, the camera opens straight away. At a party the second one is
    // what people actually want, so it gets to be the big button — and the
    // photo is in the album seconds after the shutter.
    nodes.input = el('input', { type: 'file', accept: 'image/*', multiple: 'multiple', class: 'visually-hidden' });
    nodes.camera = el('input', { type: 'file', accept: 'image/*', capture: 'environment', class: 'visually-hidden' });

    [nodes.input, nodes.camera].forEach(function (input) {
      input.addEventListener('change', function () {
        accept(Array.from(input.files || []));
        input.value = ''; // so the same file can be picked twice in a row
      });
    });

    function opens(input) {
      return function () {
        if (!requireName()) return;
        input.click();
      };
    }

    // Hidden on anything with a mouse: a desktop has no camera worth using,
    // and the button would open a webcam nobody pointed at the cake.
    nodes.shoot = el('button', {
      class: 'btn btn--primary btn--big btn--camera',
      disabled: 'disabled',
      onclick: opens(nodes.camera)
    }, ['📷 Foto aufnehmen']);

    nodes.pick = el('button', {
      class: 'btn btn--primary btn--big',
      disabled: 'disabled',
      onclick: opens(nodes.input)
    }, ['Fotos auswählen']);

    nodes.status = el('p', { class: 'hint', text: 'Album wird geladen …' });
    nodes.list = el('div', { class: 'queue' });
    nodes.summary = el('div', { class: 'summary is-hidden' });

    var drop = el('div', { class: 'drop' }, [
      el('div', { class: 'drop__emoji', text: '📸' }),
      el('div', { class: 'drop__buttons' }, [nodes.shoot, nodes.pick]),
      el('p', { class: 'drop__hint', text: 'oder Fotos einfach hierher ziehen' })
    ]);
    ['dragenter', 'dragover'].forEach(function (type) {
      drop.addEventListener(type, function (e) { e.preventDefault(); drop.classList.add('is-over'); });
    });
    ['dragleave', 'drop'].forEach(function (type) {
      drop.addEventListener(type, function (e) { e.preventDefault(); drop.classList.remove('is-over'); });
    });
    drop.addEventListener('drop', function (e) {
      if (!requireName()) return;
      accept(Array.from(e.dataTransfer.files || []));
    });

    nodes.title = el('h1', { class: 'topbar__title', text: 'Hochladen' });
    nodes.back = el('a', { class: 'btn btn--ghost', href: 'index.html' }, ['Zum Album']);
    app.appendChild(el('header', { class: 'topbar' }, [
      el('div', { class: 'topbar__brand' }, [nodes.title]),
      el('div', { class: 'topbar__actions' }, [nodes.back])
    ]));
    app.appendChild(el('div', { class: 'panel' }, [
      el('label', { class: 'label' }, ['Wer lädt hoch?']),
      el('div', { class: 'whorow' }, [nodes.whoFace, nodes.whoLabel, nodes.whoButton]),
      nodes.name,
      drop,
      nodes.status,
      nodes.input,
      nodes.camera,
      nodes.summary,
      nodes.list
    ]));

    updatePickState();
  }

  function updatePickState() {
    var waiting = !PS.name();
    nodes.pick.classList.toggle('is-waiting', waiting);
    nodes.shoot.classList.toggle('is-waiting', waiting);
  }

  function requireName() {
    if (PS.name()) return true;
    if (state.people) { askWho(); return false; }
    nodes.name.focus();
    nodes.name.classList.add('is-error');
    setTimeout(function () { nodes.name.classList.remove('is-error'); }, 1600);
    PS.toast('Bitte zuerst den Namen eintragen — dann weiß man später, wer das Foto gemacht hat.');
    return false;
  }

  function accept(files) {
    var images = files.filter(function (file) {
      return file.type.indexOf('image/') === 0 || /\.(jpe?g|png|heic|heif|webp|gif)$/i.test(file.name);
    });
    if (!images.length) {
      PS.toast('Darin waren keine Bilder.');
      return;
    }
    images.forEach(function (file) {
      var job = { file: file, state: 'warten', error: null, node: null, uploader: PS.name() };
      state.jobs.push(job);
      job.node = jobNode(job);
      nodes.list.appendChild(job.node);
    });
    pump();
  }

  function jobNode(job) {
    var label = el('div', { class: 'job__name', text: job.file.name });
    var status = el('div', { class: 'job__state', text: 'wartet' });
    var bar = el('div', { class: 'job__bar' }, [el('i')]);
    var node = el('div', { class: 'job' }, [
      el('div', { class: 'job__thumb' }),
      el('div', { class: 'job__body' }, [label, status, bar])
    ]);
    job._status = status;
    job._node = node;
    job._thumb = node.querySelector('.job__thumb');
    return node;
  }

  function mark(job, text, cls) {
    job._status.textContent = text;
    job._node.className = 'job' + (cls ? ' job--' + cls : '');
  }

  function pump() {
    while (state.running < 2) {
      var job = state.jobs.find(function (j) { return j.state === 'warten'; });
      if (!job) break;
      job.state = 'läuft';
      state.running++;
      run(job).catch(function () { /* run() records its own failures */ }).then(function () {
        state.running--;
        pump();
        finishIfDone();
      });
    }
    guardNavigation();
  }

  async function run(job) {
    try {
      mark(job, 'wird verkleinert …', 'busy');
      var buffer = await job.file.arrayBuffer();
      var hash = await PS.sha8(buffer);

      if (state.known.has(hash)) {
        job.state = 'doppelt';
        mark(job, 'war schon im Album', 'skip');
        return;
      }

      // HEIC needs a decoder the browser does not ship, and keeps its capture
      // date somewhere else, so both come from the same pass.
      var converted = null;
      if (PS.heic.looksLike(buffer)) {
        converted = await PS.heic.decode(buffer, function (message) { mark(job, message, 'busy'); });
        mark(job, 'wird verkleinert …', 'busy');
      }

      var taken = (converted && converted.takenAt) || PS.exifDate(buffer) ||
        new Date(job.file.lastModified || Date.now());

      var decoded = converted ||
        await PS.decodeImage(new Blob([buffer], { type: job.file.type || 'image/jpeg' }));
      var photo, thumb, size;
      try {
        size = PS.fitSize(decoded, PHOTO_EDGE);
        photo = await PS.encodeJpeg(decoded, PHOTO_EDGE, PHOTO_QUALITY);
        thumb = await PS.encodeJpeg(decoded, THUMB_EDGE, THUMB_QUALITY);
      } finally {
        decoded.release();
      }

      job._thumb.style.backgroundImage = 'url(' + URL.createObjectURL(thumb) + ')';

      mark(job, 'wird hochgeladen … (' + PS.formatBytes(photo.size) + ')', 'busy');
      await PS.data.addPhoto(state.album, {
        hash: hash,
        full: photo,
        thumb: thumb,
        takenAt: taken,
        uploader: job.uploader,
        width: size.width,
        height: size.height
      });

      state.known.add(hash);
      showCount();
      state.uploaded++;
      state.savedBytes += Math.max(0, job.file.size - photo.size - thumb.size);
      job.state = 'fertig';
      mark(job, 'fertig', 'done');
    } catch (error) {
      job.state = 'fehler';
      job.error = PS.escapeError(error);
      mark(job, job.error, 'error');
      job._node.appendChild(el('button', {
        class: 'btn btn--ghost btn--small',
        onclick: function () {
          this.remove();
          job.state = 'warten';
          mark(job, 'wartet');
          pump();
        }
      }, ['Nochmal versuchen']));
    }
  }

  function finishIfDone() {
    var open = state.jobs.some(function (j) { return j.state === 'warten' || j.state === 'läuft'; });
    guardNavigation();
    if (open || !state.jobs.length) return;

    var failed = state.jobs.filter(function (j) { return j.state === 'fehler'; }).length;
    nodes.summary.className = 'summary' + (failed ? ' summary--warn' : ' summary--ok');
    nodes.summary.innerHTML = '';
    nodes.summary.appendChild(el('strong', {
      text: state.uploaded
        ? PS.plural(state.uploaded, 'Foto ist im Album', 'Fotos sind im Album') + '.'
        : 'Es wurde nichts Neues hochgeladen.'
    }));
    if (state.savedBytes > 0) {
      nodes.summary.appendChild(el('span', {
        text: ' Dabei ' + PS.formatBytes(state.savedBytes) + ' Datenvolumen gespart.'
      }));
    }
    if (failed) {
      nodes.summary.appendChild(el('span', {
        text: ' ' + PS.plural(failed, 'Foto hat', 'Fotos haben') + ' nicht geklappt.'
      }));
    }
    nodes.summary.appendChild(el('a', {
      class: 'btn btn--primary',
      href: state.album && state.album.slug ? 'index.html?album=' + encodeURIComponent(state.album.slug) : 'index.html'
    }, ['Album ansehen']));
  }

  var guarded = false;
  function guardNavigation() {
    var busy = state.jobs.some(function (j) { return j.state === 'warten' || j.state === 'läuft'; });
    if (busy === guarded) return;
    guarded = busy;
    if (busy) global.addEventListener('beforeunload', warn);
    else global.removeEventListener('beforeunload', warn);
  }
  function warn(event) {
    event.preventDefault();
    event.returnValue = '';
  }

  PS.requireSignIn(document.getElementById('app'), boot);
})(typeof globalThis !== 'undefined' ? globalThis : this);
