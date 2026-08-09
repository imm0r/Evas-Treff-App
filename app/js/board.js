/*
 * The pinboard: short posts, newest first, with an optional photo.
 *
 * One row per post, and the picture — when there is one — an object in the
 * same bucket the album uses. Nothing is ever rewritten, so two people posting
 * in the same second cannot lose each other's words.
 *
 * The whole board is one query plus one signing call, no matter how many posts
 * carry a picture: the images come back as ordinary URLs the browser fetches
 * and caches by itself.
 */
(function (global) {
  'use strict';

  var PS = global.PS;
  var el = PS.el;

  var IMAGE_EDGE = 1280, IMAGE_QUALITY = 0.82;

  var state = { me: null, posts: [], people: null, busy: false };
  var nodes = {};

  async function boot() {
    try {
      state.me = await PS.data.me();
    } catch (error) {
      PS.sb.signOut();
      location.reload();
      return;
    }
    if (state.me && state.me.name) PS.name(state.me.name);

    document.title = 'Pinnwand';
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
  }

  function askWho() {
    PS.people.ask(state.people, function (name) {
      PS.name(name);
      showName();
      render();
      PS.data.linkMe(name).catch(function () {});
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
      state.posts = await PS.data.posts();
      if (!state.people) {
        state.people = await PS.people.load();
        if (state.people) PS.people.whenReady(function () { showName(); render(); });
      }
      showName();
      render();
    } catch (error) {
      nodes.feed.innerHTML = '';
      nodes.feed.appendChild(el('div', { class: 'status status--error' }, [
        el('p', { text: PS.escapeError(error) }),
        el('button', {
          class: 'btn btn--ghost',
          onclick: function () { PS.sb.signOut(); location.reload(); }
        }, ['Abmelden'])
      ]));
    }
  }

  function render() {
    nodes.feed.innerHTML = '';
    if (!state.posts.length) {
      nodes.feed.appendChild(el('div', { class: 'status' }, [
        el('div', { class: 'status__emoji', text: '📌' }),
        el('p', { text: 'Noch nichts angepinnt.' })
      ]));
      return;
    }

    state.posts.forEach(function (post) {
      var card = el('article', { class: 'post' }, [
        el('div', { class: 'post__head' }, [
          el('span', { class: 'post__who', text: PS.people.display(post.author) }),
          el('span', { class: 'post__when', text: PS.formatWhen(post.at) })
        ]),
        el('p', { class: 'post__text', text: post.body })
      ]);

      var face = PS.people.avatar(post.author, 32);
      if (face) { card.classList.add('post--face'); card.insertBefore(face, card.firstChild); }

      if (post.imageUrl) {
        card.appendChild(el('img', {
          class: 'post__image', alt: 'Bild von ' + post.author,
          loading: 'lazy', src: post.imageUrl
        }));
      }

      // Yours means yours: the account that wrote it, which the server checks
      // again before it deletes anything.
      if (post.authorId && state.me && post.authorId === state.me.id) {
        card.appendChild(el('button', {
          class: 'comment__remove', title: 'Beitrag löschen',
          onclick: function () { remove(post); }
        }, ['×']));
      }

      nodes.feed.appendChild(card);
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

    try {
      var image = null;
      if (file) {
        var buffer = await file.arrayBuffer();
        var decoded = PS.heic && PS.heic.looksLike(buffer)
          ? await PS.heic.decode(buffer, function (m) { nodes.send.textContent = m; })
          : await PS.decodeImage(new Blob([buffer], { type: file.type || 'image/jpeg' }));
        try { image = await PS.encodeJpeg(decoded, IMAGE_EDGE, IMAGE_QUALITY); }
        finally { decoded.release(); }
        nodes.send.textContent = 'Bild wird hochgeladen …';
      }
      await PS.data.addPost(text, image, PS.name());
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
    // Reload rather than splice the new post in: the picture needs a signed
    // URL, and the one request that fetches the board hands out all of them.
    await load(false);
    global.scrollTo({ top: 0, behavior: 'smooth' });
  }

  async function remove(post) {
    if (!global.confirm('Diesen Beitrag löschen?')) return;
    try {
      await PS.data.removePost(post);
    } catch (error) {
      PS.toast(PS.escapeError(error), 'error');
      return;
    }
    state.posts = state.posts.filter(function (other) { return other.id !== post.id; });
    render();
  }

  PS.requireSignIn(document.getElementById('app'), boot);
})(typeof globalThis !== 'undefined' ? globalThis : this);
