/*
 * The pinboard: short posts, newest first, with an optional photo.
 *
 * One post, one file — the same shape as a comment, for the same reason:
 *
 *   board/20260808T041500__Maria__4f2a.md    the text
 *   board/20260808T041500__Maria__4f2a.jpg   the picture, when there is one
 *
 * Two files sharing a stem rather than a folder, so the tree listing says who
 * posted, when, and whether there is a photo — without reading anything. Only
 * the text and the image itself cost a request, and only for posts actually on
 * screen.
 *
 * Nothing is ever rewritten, so two people posting in the same second cannot
 * lose each other's words.
 */
(function (global) {
  'use strict';

  var PS = global.PS;
  var el = PS.el;

  var DIR = 'board';
  var PATTERN = /^(\d{8}T\d{6})__(.+?)__([0-9a-f]{4})\.(md|jpg)$/;
  var IMAGE_EDGE = 1280, IMAGE_QUALITY = 0.82;

  var state = { cfg: null, posts: [], people: null, busy: false };
  var nodes = {};
  var observer = null;

  function stamp(when) {
    return [
      when.getFullYear(),
      String(when.getMonth() + 1).padStart(2, '0'),
      String(when.getDate()).padStart(2, '0'), 'T',
      String(when.getHours()).padStart(2, '0'),
      String(when.getMinutes()).padStart(2, '0'),
      String(when.getSeconds()).padStart(2, '0')
    ].join('');
  }

  function parse(entry) {
    if (entry.path.slice(0, DIR.length + 1) !== DIR + '/') return null;
    var match = PATTERN.exec(entry.path.slice(DIR.length + 1));
    if (!match) return null;
    var t = match[1];
    return {
      id: t + '__' + match[2] + '__' + match[3],
      stamp: t,
      at: new Date(+t.slice(0, 4), +t.slice(4, 6) - 1, +t.slice(6, 8),
        +t.slice(9, 11), +t.slice(11, 13), +t.slice(13, 15)),
      author: PS.album.unslug(match[2]),
      kind: match[4],
      path: entry.path,
      sha: entry.sha
    };
  }

  /** Fold the .md and .jpg of each post back together, newest first. */
  function fromTree(entries) {
    var byId = {};
    entries.forEach(function (entry) {
      var part = parse(entry);
      if (!part) return;
      var post = byId[part.id] || (byId[part.id] = {
        id: part.id, stamp: part.stamp, at: part.at, author: part.author,
        textPath: null, textSha: null, imagePath: null, imageSha: null
      });
      if (part.kind === 'md') { post.textPath = part.path; post.textSha = part.sha; }
      else { post.imagePath = part.path; post.imageSha = part.sha; }
    });
    return Object.keys(byId).map(function (id) { return byId[id]; })
      // A post is its text; an image without one is half an upload, not a post.
      .filter(function (post) { return post.textSha; })
      .sort(function (a, b) { return a.stamp < b.stamp ? 1 : -1; });
  }

  async function boot(cfg) {
    state.cfg = cfg;
    document.title = 'Pinnwand · ' + cfg.title;
    renderShell();
    await load(true);
    setInterval(function () {
      if (document.visibilityState === 'visible' && !state.busy) load(false);
    }, 60000);
  }

  function renderShell() {
    var app = document.getElementById('app');
    app.innerHTML = '';

    nodes.text = el('textarea', {
      class: 'field comments__input', rows: '3', maxlength: '2000',
      placeholder: 'Was gibt es Neues?'
    });
    nodes.file = el('input', { type: 'file', accept: 'image/*', class: 'visually-hidden' });
    nodes.file.addEventListener('change', function () { showPicked(); });
    nodes.picked = el('div', { class: 'compose__picked is-hidden' });
    nodes.send = el('button', { class: 'btn btn--primary', onclick: post }, ['Anpinnen']);
    nodes.whoFace = el('span', { class: 'who__face is-hidden' });
    nodes.whoLabel = el('strong', { class: 'who__current' });
    nodes.whoButton = el('button', { class: 'btn btn--small', onclick: askWho }, ['Wer bist du?']);
    nodes.name = el('input', {
      class: 'field field--slim is-hidden', type: 'text', maxlength: '24', placeholder: 'Dein Name'
    });
    nodes.name.addEventListener('input', function () {
      PS.name(nodes.name.value.trim());
      showName();
    });

    nodes.compose = el('div', { class: 'compose' }, [
      el('div', { class: 'whorow' }, [nodes.whoFace, nodes.whoLabel, nodes.whoButton]),
      nodes.name,
      nodes.text,
      nodes.picked,
      el('div', { class: 'compose__actions' }, [
        el('button', { class: 'btn', onclick: function () { nodes.file.click(); } }, ['📷 Bild']),
        nodes.send
      ]),
      nodes.file
    ]);

    nodes.feed = el('main', { class: 'feed board' });

    app.appendChild(el('header', { class: 'topbar' }, [
      el('div', { class: 'topbar__brand' }, [el('h1', { class: 'topbar__title', text: 'Pinnwand' })]),
      el('div', { class: 'topbar__actions' }, [
        el('button', { class: 'btn btn--ghost', title: 'Neu laden', onclick: function () { load(false); } }, ['⟳'])
      ])
    ]));
    app.appendChild(el('div', { class: 'panel' }, [nodes.compose]));
    app.appendChild(nodes.feed);
    app.appendChild(PS.nav());
    showName();
  }

  function showName() {
    nodes.whoFace.innerHTML = '';
    var face = PS.people.avatar(PS.name(), 32);
    nodes.whoFace.classList.toggle('is-hidden', !face);
    if (face) nodes.whoFace.appendChild(face);
    nodes.whoLabel.textContent = PS.name() ? PS.people.display(PS.name()) : 'Wer bist du?';
    nodes.whoButton.classList.toggle('is-hidden', !state.people);
    nodes.whoButton.textContent = PS.name() ? 'Nicht ' + PS.people.display(PS.name()) + '?' : 'Auf dem Foto antippen';
    nodes.name.classList.toggle('is-hidden', !!PS.name() || !!state.people);
    nodes.compose.classList.toggle('is-readonly', !PS.mayWrite());
  }

  function askWho() {
    PS.people.ask(state.cfg, state.people, function (name) {
      PS.name(name);
      showName();
      render();
    }, function () {
      nodes.name.classList.remove('is-hidden');
      nodes.name.focus();
    });
  }

  function showPicked() {
    var file = nodes.file.files && nodes.file.files[0];
    nodes.picked.innerHTML = '';
    nodes.picked.classList.toggle('is-hidden', !file);
    if (!file) return;
    nodes.picked.appendChild(el('span', { text: file.name }));
    nodes.picked.appendChild(el('button', {
      class: 'btn btn--ghost btn--small',
      onclick: function () { nodes.file.value = ''; showPicked(); }
    }, ['✕']));
  }

  async function load(first) {
    if (first) {
      nodes.feed.innerHTML = '';
      nodes.feed.appendChild(el('div', { class: 'status' }, [el('div', { class: 'spinner' })]));
    }
    try {
      var tree = await PS.gh.tree(state.cfg);
      state.posts = fromTree(tree.entries);
      if (!state.people) {
        state.people = await PS.people.load(state.cfg, tree.entries);
        if (state.people) PS.people.whenReady(function () { showName(); render(); });
      }
      showName();
      render();
    } catch (error) {
      nodes.feed.innerHTML = '';
      nodes.feed.appendChild(el('div', { class: 'status status--error' }, [
        el('p', { text: PS.escapeError(error) })
      ]));
    }
  }

  function render() {
    if (observer) observer.disconnect();
    observer = new IntersectionObserver(onVisible, { rootMargin: '600px 0px' });

    nodes.feed.innerHTML = '';
    if (!state.posts.length) {
      nodes.feed.appendChild(el('div', { class: 'status' }, [
        el('div', { class: 'status__emoji', text: '📌' }),
        el('p', { text: 'Noch nichts angepinnt.' })
      ]));
      return;
    }

    var me = PS.name();
    state.posts.forEach(function (post) {
      var body = el('p', { class: 'post__text', text: post.text === undefined ? '…' : post.text });
      var card = el('article', { class: 'post' }, [
        el('div', { class: 'post__head' }, [
          el('span', { class: 'post__who', text: PS.people.display(post.author) }),
          el('span', { class: 'post__when', text: PS.formatWhen(post.at) })
        ]),
        body
      ]);

      var face = PS.people.avatar(post.author, 32);
      if (face) { card.classList.add('post--face'); card.insertBefore(face, card.firstChild); }

      if (post.imageSha) {
        var img = el('img', { class: 'post__image', alt: 'Bild von ' + post.author, loading: 'lazy' });
        card.appendChild(img);
        card._img = img;
        card._post = post;
        observer.observe(card);
      }

      if (me && PS.album.slug(me) === PS.album.slug(post.author) && PS.mayWrite()) {
        card.appendChild(el('button', {
          class: 'comment__remove', title: 'Beitrag löschen',
          onclick: function () { remove(post); }
        }, ['×']));
      }

      nodes.feed.appendChild(card);

      if (post.text === undefined) {
        PS.gh.blobText(state.cfg, post.textSha).then(function (text) {
          post.text = text;
          body.textContent = text;
        }).catch(function () { body.textContent = '(Text konnte nicht geladen werden)'; });
      }
    });
  }

  function onVisible(entries) {
    entries.forEach(function (entry) {
      if (!entry.isIntersecting) return;
      var card = entry.target;
      observer.unobserve(card);
      PS.gh.blobUrl(state.cfg, card._post.imageSha).then(function (url) {
        card._img.src = url;
      }).catch(function () { card._img.remove(); });
    });
  }

  async function post() {
    var text = nodes.text.value.trim();
    var file = nodes.file.files && nodes.file.files[0];
    if (!text && !file) return;
    if (!PS.name()) {
      if (state.people) askWho();
      else { nodes.name.classList.remove('is-hidden'); nodes.name.focus(); }
      PS.toast('Bitte trag deinen Namen ein.');
      return;
    }

    state.busy = true;
    nodes.send.disabled = true;
    nodes.send.textContent = 'Wird angepinnt …';
    var when = new Date();
    var nonce = Math.floor(Math.random() * 0x10000).toString(16).padStart(4, '0');
    var stem = DIR + '/' + stamp(when) + '__' + PS.album.slug(PS.name()) + '__' + nonce;

    try {
      // Picture first: a post whose text is up but whose image is not looks
      // finished and is not. The other way round shows nothing at all.
      if (file) {
        var buffer = await file.arrayBuffer();
        var decoded = PS.heic && PS.heic.looksLike(buffer)
          ? await PS.heic.decode(buffer, function (m) { nodes.send.textContent = m; })
          : await PS.decodeImage(new Blob([buffer], { type: file.type || 'image/jpeg' }));
        var image;
        try { image = await PS.encodeJpeg(decoded, IMAGE_EDGE, IMAGE_QUALITY); }
        finally { decoded.release(); }
        nodes.send.textContent = 'Bild wird hochgeladen …';
        await PS.gh.putFile(state.cfg, stem + '.jpg', await PS.toBase64(image), 'Pinnwand-Bild von ' + PS.name());
      }
      await PS.gh.putFile(state.cfg, stem + '.md',
        await PS.toBase64(new Blob([text || ''], { type: 'text/plain' })),
        'Pinnwand-Beitrag von ' + PS.name());
    } catch (error) {
      PS.toast(PS.escapeError(error), 'error');
      state.busy = false;
      nodes.send.disabled = false;
      nodes.send.textContent = 'Anpinnen';
      return;
    }

    nodes.text.value = '';
    nodes.file.value = '';
    showPicked();
    state.busy = false;
    nodes.send.disabled = false;
    nodes.send.textContent = 'Anpinnen';
    await load(false);
    global.scrollTo({ top: 0, behavior: 'smooth' });
  }

  async function remove(post) {
    if (!global.confirm('Diesen Beitrag löschen?')) return;
    try {
      if (post.imageSha) await PS.gh.deleteFile(state.cfg, post.imagePath, post.imageSha, 'Pinnwand-Beitrag entfernt');
      await PS.gh.deleteFile(state.cfg, post.textPath, post.textSha, 'Pinnwand-Beitrag entfernt');
    } catch (error) {
      PS.toast(PS.escapeError(error), 'error');
      return;
    }
    state.posts = state.posts.filter(function (other) { return other.id !== post.id; });
    render();
  }

  PS.requireAccess(document.getElementById('app'), boot);
})(typeof globalThis !== 'undefined' ? globalThis : this);
