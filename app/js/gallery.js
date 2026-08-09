/*
 * The gallery: one tree request for the whole album, then thumbnails fetched
 * lazily as they scroll into view.
 *
 * Nothing is loaded eagerly. A private repository means every image costs an
 * authenticated API request, so the difference between "load everything" and
 * "load what is on screen" is the difference between a working album and a
 * rate-limited one halfway through the afternoon.
 */
(function (global) {
  'use strict';

  var PS = global.PS;
  var el = PS.el;

  var TITLE = 'Familie';

  var state = {
    me: null,
    items: [],
    visible: [],
    filter: null,
    pending: null,   // items found by polling but not shown yet
    people: null,    // the album's face map, or null when it has none
    shelf: null,     // every album in the repository
    album: null,     // the one being shown, or null while showing the shelf
    lightbox: -1
  };

  var nodes = {};
  var observer = null;

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
    document.title = TITLE;
    renderShell();
    load(true);

    setInterval(function () {
      if (document.visibilityState === 'visible' && state.lightbox < 0) poll();
    }, 60000);
    document.addEventListener('visibilitychange', function () {
      if (document.visibilityState === 'visible') poll();
    });
  }

  function renderShell() {
    var app = document.getElementById('app');
    app.innerHTML = '';

    nodes.count = el('span', { class: 'topbar__count' });
    nodes.filters = el('div', { class: 'filters' });
    nodes.feed = el('main', { class: 'feed' });
    nodes.newPill = el('button', {
      class: 'pill is-hidden',
      onclick: function () { adopt(); }
    });

    nodes.topTitle = el('h1', { class: 'topbar__title', text: TITLE });
    nodes.back = el('a', { class: 'btn btn--ghost topbar__back is-hidden', href: 'index.html', title: 'Alle Alben' }, ['‹']);
    nodes.addPhotos = el('a', { class: 'btn btn--primary act-add-photos is-hidden', href: 'upload.html' }, [
      // Two labels: on a narrow phone the full wording pushes the album
      // title into an ellipsis, and the title is what tells you where you are.
      el('span', { class: 'btn__wide', text: 'Fotos hinzufügen' }),
      el('span', { class: 'btn__narrow', text: '+ Fotos' })
    ]);
    nodes.newAlbum = el('button', { class: 'btn btn--primary act-new-album is-hidden', onclick: askNewAlbum }, [
      el('span', { class: 'btn__wide', text: 'Neues Album' }),
      el('span', { class: 'btn__narrow', text: '+ Album' })
    ]);

    app.appendChild(el('header', { class: 'topbar' }, [
      el('div', { class: 'topbar__brand' }, [nodes.back, el('div', {}, [nodes.topTitle, nodes.count])]),
      el('div', { class: 'topbar__actions' }, [
        nodes.addPhotos,
        nodes.newAlbum,
        el('button', { class: 'btn btn--ghost', title: 'Neu laden', onclick: function () { load(false); } }, ['⟳'])
      ])
    ]));
    app.appendChild(nodes.filters);
    app.appendChild(nodes.newPill);
    app.appendChild(nodes.feed);
    buildLightbox(app);
    app.appendChild(PS.nav());
  }

  /**
   * ?album=<slug> names one. Without it: a repository holding exactly one
   * album opens it straight away — which is also what the links already in the
   * family's group chat do — and anything else shows the shelf.
   */
  function chooseAlbum(shelf) {
    var wanted = new URLSearchParams(location.search).get('album');
    if (wanted !== null) {
      var hit = null;
      shelf.forEach(function (album) { if (album.slug === wanted) hit = album; });
      return hit;
    }
    return shelf.length === 1 ? shelf[0] : null;
  }

  function albumHref(album, page) {
    var base = page || 'index.html';
    return album && album.slug ? base + '?album=' + encodeURIComponent(album.slug) : base;
  }

  function setStatus(content) {
    nodes.feed.innerHTML = '';
    nodes.feed.appendChild(content);
  }

  async function load(first) {
    if (first) {
      setStatus(el('div', { class: 'status' }, [
        el('div', { class: 'spinner' }),
        el('p', { text: 'Album wird geladen …' })
      ]));
    }
    try {
      state.shelf = await PS.data.albums();
      state.album = chooseAlbum(state.shelf);
      state.items = state.album ? await PS.data.photos(state.album.id) : [];

      if (!state.people) {
        state.people = await PS.people.load();
        // The family photo lands a moment after the grid. Redraw then, so the
        // faces appear beside the names without holding up the album — but
        // only if an album is open, or this would paint one over the shelf.
        if (state.people) PS.people.whenReady(function () {
          if (!state.album) return;
          render();
          refreshLightboxFace();
        });
      }
      state.pending = null;
      nodes.newPill.classList.add('is-hidden');
      if (state.album) render(); else renderShelf();
    } catch (error) {
      setStatus(el('div', { class: 'status status--error' }, [
        el('p', { text: PS.escapeError(error) }),
        el('button', { class: 'btn', onclick: function () { load(true); } }, ['Nochmal versuchen']),
        el('button', {
          class: 'btn btn--ghost',
          onclick: function () { PS.sb.signOut(); location.reload(); }
        }, ['Abmelden'])
      ]));
    }
  }

  /** Background refresh: never disturb the scroll position, just offer the update. */
  async function poll() {
    if (!state.album) return; // nothing ticking on the shelf
    try {
      var next = await PS.data.photos(state.album.id);
      if (next.length === state.items.length) return;
      var known = new Set(state.items.map(function (i) { return i.id; }));
      var fresh = next.filter(function (i) { return !known.has(i.id); }).length;
      if (!fresh) {
        // Nothing new, but the count moved: something was removed straight in
        // the repository. Drop the stale tiles rather than let them 404.
        state.items = next;
        render();
        return;
      }
      state.pending = next;
      nodes.newPill.textContent = PS.plural(fresh, 'neues Foto', 'neue Fotos') + ' — antippen';
      nodes.newPill.classList.remove('is-hidden');
    } catch (error) {
      // A failed background poll is not worth interrupting anyone over.
    }
  }

  function adopt() {
    if (!state.pending) return;
    state.items = state.pending;
    state.pending = null;
    nodes.newPill.classList.add('is-hidden');
    render();
    global.scrollTo({ top: 0, behavior: 'smooth' });
  }

  function render() {
    nodes.topTitle.textContent = state.album ? state.album.title : TITLE;
    nodes.addPhotos.href = albumHref(state.album, 'upload.html');
    nodes.addPhotos.classList.remove('is-hidden');
    nodes.newAlbum.classList.add('is-hidden');
    // Only offer the way back when there is more than one album to go back to.
    nodes.back.classList.toggle('is-hidden', state.shelf.length < 2);

    renderFilters();
    state.visible = state.filter
      ? state.items.filter(function (i) { return i.uploader === state.filter; })
      : state.items;

    nodes.count.textContent = state.items.length
      ? PS.plural(state.items.length, 'Foto', 'Fotos')
      : '';

    if (observer) observer.disconnect();
    observer = new IntersectionObserver(onVisible, { rootMargin: '600px 0px' });

    if (!state.visible.length) {
      setStatus(el('div', { class: 'status' }, [
        el('div', { class: 'status__emoji', text: '📷' }),
        el('p', { text: state.items.length ? 'Von dieser Person ist noch nichts dabei.' : 'Noch keine Fotos hier.' }),
        el('a', { class: 'btn btn--primary', href: albumHref(state.album, 'upload.html') }, ['Das erste Foto hochladen'])
      ]));
      return;
    }

    nodes.feed.innerHTML = '';
    PS.album.byDay(state.visible).forEach(function (group) {
      nodes.feed.appendChild(el('h2', { class: 'day', text: PS.formatDay(group.day) }));
      var grid = el('div', { class: 'grid' });
      group.items.forEach(function (item) {
        grid.appendChild(tileFor(item));
      });
      nodes.feed.appendChild(grid);
    });
  }

  /** The shelf: one card per album, cover and count straight out of the tree. */
  function renderShelf() {
    nodes.filters.innerHTML = '';
    nodes.count.textContent = state.shelf.length
      ? PS.plural(state.shelf.length, 'Album', 'Alben') : '';
    nodes.topTitle.textContent = TITLE;
    nodes.addPhotos.classList.add('is-hidden');
    nodes.newAlbum.classList.remove('is-hidden');

    nodes.feed.innerHTML = '';
    if (!state.shelf.length) {
      setStatus(el('div', { class: 'status' }, [
        el('div', { class: 'status__emoji', text: '📚' }),
        el('p', { text: 'Noch kein Album angelegt.' }),
        el('button', { class: 'btn btn--primary', onclick: askNewAlbum }, ['Erstes Album anlegen'])
      ]));
      return;
    }

    var shelf = el('div', { class: 'shelf' });
    state.shelf.forEach(function (album) {
      var cover = el('div', { class: 'shelf__cover' });
      var card = el('a', { class: 'shelf__card', href: albumHref(album) }, [
        cover,
        el('div', { class: 'shelf__meta' }, [
          el('strong', { class: 'shelf__title', text: album.title }),
          el('span', {
            class: 'shelf__count',
            text: (album.date ? PS.formatDayShort(album.date) + ' · ' : '') +
              PS.plural(album.count, 'Foto', 'Fotos')
          })
        ])
      ]);
      shelf.appendChild(card);
      if (album.coverUrl) {
        cover.style.backgroundImage = 'url(' + album.coverUrl + ')';
        cover.classList.add('is-loaded');
      }
    });
    nodes.feed.appendChild(shelf);
  }

  function askNewAlbum() {
    var title = prompt('Wie soll das Album heißen?');
    if (!title || !title.trim()) return;
    var today = new Date();
    var date = [today.getFullYear(),
      String(today.getMonth() + 1).padStart(2, '0'),
      String(today.getDate()).padStart(2, '0')].join('-');
    PS.data.createAlbum(title.trim(), date, PS.albums.slugify(title.trim())).then(function (album) {
      location.href = albumHref(album, 'upload.html');
    }).catch(function (error) {
      PS.toast(PS.escapeError(error), 'error');
    });
  }

  function renderFilters() {
    var uploaders = [];
    state.items.forEach(function (item) {
      if (uploaders.indexOf(item.uploader) < 0) uploaders.push(item.uploader);
    });
    // Show the spelling the family photo knows, filter on what the paths hold.
    var shownAs = {};
    uploaders.forEach(function (name) { shownAs[name] = PS.people.display(name); });
    uploaders.sort(function (a, b) { return a.localeCompare(b, 'de'); });

    nodes.filters.innerHTML = '';
    if (uploaders.length < 2) return;

    function chip(label, value) {
      var node = el('button', {
        class: 'chip' + (state.filter === value ? ' is-active' : ''),
        onclick: function () { state.filter = value; render(); }
      });
      var face = value && PS.people.avatar(value, 22);
      if (face) { node.appendChild(face); node.classList.add('chip--face'); }
      node.appendChild(document.createTextNode(label));
      return node;
    }
    nodes.filters.appendChild(chip('Alle', null));
    uploaders.forEach(function (name) { nodes.filters.appendChild(chip(shownAs[name], name)); });
  }

  function tileFor(item) {
    var shown = PS.people.display(item.uploader);
    var img = el('img', { alt: 'Foto von ' + shown, loading: 'lazy' });
    var tile = el('button', {
      class: 'tile',
      onclick: function () { openLightbox(state.visible.indexOf(item)); }
    }, [img, el('span', { class: 'tile__by', text: shown })]);
    var tileFace = PS.people.avatar(item.uploader, 24);
    if (tileFace) { tileFace.classList.add('tile__face'); tile.appendChild(tileFace); }
    if (commentCount(item)) {
      tile.appendChild(el('span', { class: 'tile__talk', text: '💬 ' + commentCount(item) }));
    }
    tile._item = item;
    tile._img = img;
    observer.observe(tile);
    return tile;
  }

  function onVisible(entries) {
    entries.forEach(function (entry) {
      if (!entry.isIntersecting) return;
      var tile = entry.target;
      observer.unobserve(tile);
      if (!tile._item.thumbUrl) { tile.classList.add('is-broken'); return; }
      // Signed once for the whole album; the browser fetches and caches it
      // like any other image.
      tile._img.onload = function () { tile.classList.add('is-loaded'); };
      tile._img.onerror = function () { tile.classList.add('is-broken'); };
      tile._img.src = tile._item.thumbUrl;
    });
  }

  // --- lightbox ----------------------------------------------------------

  function buildLightbox(app) {
    nodes.lbImage = el('img', { class: 'lightbox__image', alt: '' });
    nodes.lbFace = el('span', { class: 'lightbox__face is-hidden' });
    nodes.lbCaptionText = el('span');
    nodes.lbCaption = el('div', { class: 'lightbox__caption' }, [nodes.lbFace, nodes.lbCaptionText]);
    nodes.lbDownload = el('a', { class: 'btn btn--ghost', download: '', title: 'Speichern' }, [
      // Same trick as the album's top bar: on a narrow phone the word pushes
      // the caption into an ellipsis, and the caption says who took the photo.
      el('span', { class: 'btn__wide', text: 'Speichern' }),
      el('span', { class: 'btn__narrow', text: '⤓' })
    ]);
    nodes.lbSpinner = el('div', { class: 'spinner spinner--light' });
    nodes.lbComments = el('button', {
      class: 'btn btn--ghost lightbox__comments-toggle',
      onclick: toggleComments
    }, ['💬']);
    nodes.lbDelete = el('button', {
      class: 'btn btn--ghost btn--danger is-hidden',
      onclick: askToDelete
    }, ['Löschen']);
    nodes.confirm = buildConfirm();

    nodes.lightbox = el('div', { class: 'lightbox is-hidden' }, [
      el('div', { class: 'lightbox__bar' }, [
        nodes.lbCaption,
        el('div', { class: 'lightbox__tools' }, [
          nodes.lbComments,
          nodes.lbDelete,
          nodes.lbDownload,
          el('button', { class: 'btn btn--ghost', onclick: closeLightbox }, ['✕'])
        ])
      ]),
      el('div', { class: 'lightbox__stage' }, [
        nodes.lbSpinner,
        nodes.lbImage,
        el('button', { class: 'lightbox__nav lightbox__nav--prev', onclick: function () { step(-1); } }, ['‹']),
        el('button', { class: 'lightbox__nav lightbox__nav--next', onclick: function () { step(1); } }, ['›'])
      ]),
      buildComments(),
      nodes.confirm
    ]);
    app.appendChild(nodes.lightbox);

    document.addEventListener('keydown', function (event) {
      if (state.lightbox < 0) return;
      if (event.key === 'Escape') {
        if (!nodes.confirm.classList.contains('is-hidden')) hideConfirm();
        else if (!nodes.comments.classList.contains('is-hidden')) toggleComments();
        else closeLightbox();
      }
      if (event.key === 'ArrowLeft') step(-1);
      if (event.key === 'ArrowRight') step(1);
    });

    var startX = null;
    nodes.lightbox.addEventListener('pointerdown', function (e) { startX = e.clientX; });
    nodes.lightbox.addEventListener('pointerup', function (e) {
      if (startX === null) return;
      var dx = e.clientX - startX;
      startX = null;
      if (Math.abs(dx) > 60) step(dx > 0 ? -1 : 1);
    });
  }

  function openLightbox(index) {
    if (index < 0) return;
    state.lightbox = index;
    nodes.lightbox.classList.remove('is-hidden');
    document.body.classList.add('is-locked');
    showCurrent();
  }

  function closeLightbox() {
    state.lightbox = -1;
    nodes.lightbox.classList.add('is-hidden');
    nodes.comments.classList.add('is-hidden');
    document.body.classList.remove('is-locked');
    nodes.lbImage.removeAttribute('src');
  }

  function step(delta) {
    var next = state.lightbox + delta;
    if (next < 0 || next >= state.visible.length) return;
    state.lightbox = next;
    showCurrent();
  }

  async function showCurrent() {
    var item = state.visible[state.lightbox];
    var token = item.id;
    nodes.lbImage.classList.add('is-loading');
    nodes.lbSpinner.classList.remove('is-hidden');
    nodes.lbCaptionText.textContent = PS.people.display(item.uploader) + ' · ' + PS.formatDayShort(item.day) +
      ', ' + PS.formatTime(item.time);
    refreshLightboxFace();
    nodes.lbDownload.setAttribute('download', item.day + '_' + item.time + '_' + item.uploader + '.jpg');

    // Only offer deletion on photos this browser uploaded. Everyone shares one
    // token, so this is a courtesy, not a permission: it stops someone tidying
    // up other people's photos by accident, and nothing more.
    // Yours means yours: the account that uploaded it, checked server-side
    // too, rather than a name someone typed.
    nodes.lbDelete.classList.toggle('is-hidden', !mine(item.uploaderId));
    hideConfirm();
    updateCommentButton(item);
    if (!nodes.comments.classList.contains('is-hidden')) renderComments();

    // Show the thumbnail immediately so there is never a blank stage, then
    // let the full size replace it once the browser has it.
    if (item.thumbUrl) nodes.lbImage.src = item.thumbUrl;
    if (!item.photoUrl) {
      nodes.lbImage.classList.remove('is-loading');
      nodes.lbSpinner.classList.add('is-hidden');
      return;
    }
    var full = new Image();
    full.onload = function () {
      if (!state.visible[state.lightbox] || state.visible[state.lightbox].id !== token) return; // moved on
      nodes.lbImage.src = item.photoUrl;
      nodes.lbDownload.href = item.photoUrl;
      nodes.lbImage.classList.remove('is-loading');
      nodes.lbSpinner.classList.add('is-hidden');
    };
    full.onerror = function () {
      nodes.lbImage.classList.remove('is-loading');
      nodes.lbSpinner.classList.add('is-hidden');
    };
    full.src = item.photoUrl;
  }

  function buildComments() {
    nodes.commentList = el('div', { class: 'comments__list' });
    nodes.commentName = el('input', {
      class: 'field field--slim', type: 'text', maxlength: '24',
      placeholder: 'Dein Name', autocomplete: 'name'
    });
    nodes.commentWho = el('button', {
      class: 'btn btn--small is-hidden',
      onclick: function () {
        PS.people.ask(state.people, function (name) {
          PS.name(name);
          renderComments();
        }, function () {
          nodes.commentName.classList.remove('is-hidden');
          nodes.commentName.focus();
        });
      }
    }, ['Wer bist du? Auf dem Foto antippen']);
    nodes.commentName.addEventListener('input', function () {
      PS.name(nodes.commentName.value.trim());
    });
    nodes.commentText = el('textarea', {
      class: 'field field--slim comments__input', rows: '2', maxlength: '500',
      placeholder: 'Etwas dazu schreiben …'
    });
    nodes.commentSend = el('button', { class: 'btn btn--primary', onclick: postComment }, ['Senden']);
    nodes.commentForm = el('div', { class: 'comments__form' }, [
      nodes.commentWho, nodes.commentName, nodes.commentText, nodes.commentSend
    ]);
    nodes.commentNote = el('p', { class: 'comments__note is-hidden' });

    nodes.comments = el('div', { class: 'comments is-hidden' }, [
      el('div', { class: 'comments__bar' }, [
        el('strong', { text: 'Kommentare' }),
        el('button', { class: 'btn btn--ghost btn--small', onclick: toggleComments }, ['Schließen'])
      ]),
      nodes.commentList,
      nodes.commentNote,
      nodes.commentForm
    ]);
    return nodes.comments;
  }

  function toggleComments() {
    var open = nodes.comments.classList.toggle('is-hidden');
    if (!open) renderComments();
  }

  function commentCount(item) {
    return item.comments ? item.comments.length : 0;
  }

  /**
   * Render the thread. Author and time come from the file name, so the list
   * appears instantly; only the text needs fetching, and each one is filled in
   * as it arrives rather than holding up the whole thread.
   */
  function renderComments() {
    var item = state.visible[state.lightbox];
    if (!item) return;

    nodes.commentList.innerHTML = '';
    if (!commentCount(item)) {
      nodes.commentList.appendChild(el('p', { class: 'comments__empty', text: 'Noch nichts geschrieben.' }));
    }

    var me = PS.name();
    item.comments.forEach(function (comment) {
      var body = el('p', { class: 'comment__text' });
      var head = el('div', { class: 'comment__head' }, [
        el('span', { class: 'comment__who', text: PS.people.display(comment.author) }),
        el('span', { class: 'comment__when', text: PS.formatWhen(comment.at) })
      ]);
      var row = el('div', { class: 'comment' }, [head, body]);
      var face = PS.people.avatar(comment.author, 30);
      if (face) { row.classList.add('comment--face'); row.insertBefore(face, head); }
      if (mine(comment.authorId)) {
        row.appendChild(el('button', {
          class: 'comment__remove',
          title: 'Kommentar löschen',
          onclick: function () { removeComment(item, comment); }
        }, ['×']));
      }
      nodes.commentList.appendChild(row);

      body.textContent = comment.body;
    });

    nodes.commentName.value = PS.name();
    // With a face map, the keyboard is the fallback rather than the default.
    nodes.commentWho.classList.toggle('is-hidden', !!PS.name() || !state.people);
    nodes.commentName.classList.toggle('is-hidden', !!PS.name() || !!state.people);
    // Everyone signed in may write; there is no read-only kind of member.
    nodes.commentForm.classList.remove('is-hidden');
    nodes.commentNote.classList.add('is-hidden');
  }

  async function postComment() {
    var item = state.visible[state.lightbox];
    var text = nodes.commentText.value.trim();
    if (!item || !text) return;
    if (!PS.name()) {
      if (state.people) { nodes.commentWho.click(); return; }
      nodes.commentName.classList.remove('is-hidden');
      nodes.commentName.focus();
      PS.toast('Bitte trag deinen Namen ein.');
      return;
    }

    nodes.commentSend.disabled = true;
    nodes.commentSend.textContent = 'Sendet …';

    var saved;
    try {
      saved = await PS.data.addComment(item.id, text, PS.name());
    } catch (error) {
      PS.toast(PS.escapeError(error), 'error');
      nodes.commentSend.disabled = false;
      nodes.commentSend.textContent = 'Senden';
      renderComments();
      return;
    }

    item.comments.push(saved);
    nodes.commentText.value = '';
    nodes.commentSend.disabled = false;
    nodes.commentSend.textContent = 'Senden';
    renderComments();
    updateCommentButton(item);
    render();
  }

  async function removeComment(item, comment) {
    try {
      await PS.data.removeComment(comment);
    } catch (error) {
      PS.toast(PS.escapeError(error), 'error');
      return;
    }
    item.comments = item.comments.filter(function (other) { return other.id !== comment.id; });
    renderComments();
    updateCommentButton(item);
    render();
  }

  /** The caption's face, redrawn whenever the photo or the shown item changes. */
  function refreshLightboxFace() {
    var item = state.visible[state.lightbox];
    if (!nodes.lbFace) return;
    nodes.lbFace.innerHTML = '';
    var face = item && PS.people.avatar(item.uploader, 26);
    nodes.lbFace.classList.toggle('is-hidden', !face);
    if (face) nodes.lbFace.appendChild(face);
  }

  /** Did this account write it? The server enforces the same answer. */
  function mine(authorId) {
    return !!(authorId && state.me && authorId === state.me.id);
  }

  function updateCommentButton(item) {
    var count = commentCount(item);
    nodes.lbComments.textContent = count ? '💬 ' + count : '💬';
  }

  function buildConfirm() {
    nodes.confirmText = el('p', { class: 'confirm__text' });
    nodes.confirmGo = el('button', { class: 'btn btn--danger', onclick: doDelete }, ['Endgültig löschen']);
    return el('div', { class: 'confirm is-hidden' }, [
      el('div', { class: 'confirm__box' }, [
        el('h2', { class: 'confirm__title', text: 'Dieses Foto löschen?' }),
        nodes.confirmText,
        el('div', { class: 'confirm__actions' }, [
          el('button', { class: 'btn', onclick: hideConfirm }, ['Abbrechen']),
          nodes.confirmGo
        ])
      ])
    ]);
  }

  function askToDelete() {
    var item = state.visible[state.lightbox];
    if (!item) return;
    nodes.confirmText.textContent = 'Es verschwindet sofort aus dem Album, ' +
      'zusammen mit allem, was darunter geschrieben wurde. Zurückholen kann man ' +
      'es nicht.';
    nodes.confirm.classList.remove('is-hidden');
  }

  function hideConfirm() {
    nodes.confirm.classList.add('is-hidden');
    nodes.confirmGo.disabled = false;
    nodes.confirmGo.textContent = 'Endgültig löschen';
  }

  async function doDelete() {
    var item = state.visible[state.lightbox];
    if (!item) return;
    nodes.confirmGo.disabled = true;
    nodes.confirmGo.textContent = 'Wird gelöscht …';

    try {
      // The comments go with it on their own: the database cascades them when
      // the photo row disappears.
      await PS.data.removePhoto(item);
    } catch (error) {
      hideConfirm();
      PS.toast(PS.escapeError(error), 'error');
      return;
    }

    state.items = state.items.filter(function (other) { return other.id !== item.id; });
    hideConfirm();
    closeLightbox();
    render();
    PS.toast('Foto gelöscht.');
  }

  PS.requireSignIn(document.getElementById('app'), boot);
})(typeof globalThis !== 'undefined' ? globalThis : this);
