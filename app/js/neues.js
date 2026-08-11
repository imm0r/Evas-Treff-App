/*
 * Neues — die Seite, die einen beim Betreten abfängt, wenn es etwas zu sagen
 * gibt.
 *
 * Zwei Dinge stehen hier, und das obere ist der eigentliche Grund:
 *
 *   1. MITTEILUNGEN. Was ein Admin der Familie ausrichten will. Das ist der
 *      Unterschied zur Pinnwand: ein Pinnwandbeitrag wartet darauf, gefunden
 *      zu werden, eine Mitteilung stellt sich in den Weg.
 *   2. WAS SONST PASSIERT IST, seit man das letzte Mal da war — neue Fotos,
 *      Kommentare, Rezepte, Termine. Fällt von selbst an, kostet niemanden
 *      Tipparbeit.
 *
 * Die Seite zeigt AUSSCHLIESSLICH das, was es wirklich gibt. Keine leeren
 * Rubriken, keine Überschrift ohne Inhalt darunter: eine Seite, die „0 neue
 * Fotos" schreibt, hat den Leser um seine Aufmerksamkeit gebracht.
 *
 * Und sie hält niemanden zweimal auf. Beim Anzeigen wird der Merker gesetzt;
 * beim nächsten Betreten führt der Weg direkt in die Alben. Ein Aushang, der
 * noch gilt („Grillfest am Samstag"), bleibt trotzdem lesbar — er stellt sich
 * nur nicht mehr in den Weg.
 */
(function (global) {
  'use strict';

  var PS = global.PS;
  var el = PS.el;

  var state = { me: null, news: null, people: null, archiv: null };
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

    renderShell();
    await load();
  }

  function renderShell() {
    var app = document.getElementById('app');
    app.innerHTML = '';

    nodes.feed = el('main', { class: 'feed neues' });
    nodes.title = el('h1', { class: 'topbar__title', text: 'Neues' });

    app.appendChild(el('header', { class: 'topbar' }, [
      el('div', { class: 'topbar__brand' }, [nodes.title]),
      el('div', { class: 'topbar__actions' }, [
        el('a', { class: 'btn btn--ghost', href: 'index.html' }, ['Zu den Alben'])
      ])
    ]));
    app.appendChild(nodes.feed);
    app.appendChild(buildForm());
    app.appendChild(PS.nav(state.me));
  }

  async function load() {
    nodes.feed.innerHTML = '';
    nodes.feed.appendChild(el('div', { class: 'status' }, [el('div', { class: 'spinner' })]));
    try {
      state.news = await PS.data.news();
      if (!state.people) {
        state.people = await PS.people.load();
        if (state.people) PS.people.whenReady(render);
      }
      render();

      /*
       * Gesehen ist gesehen — aber erst NACH dem Zeichnen.
       *
       * Andersherum wäre der Merker gesetzt und die Seite trotzdem leer, wenn
       * das Zeichnen scheitert: die Neuigkeiten wären dann weg, ohne dass sie
       * jemand gelesen hat. Und wenn das Merken scheitert, ist die einzige
       * Folge, dass die Seite noch einmal erscheint — das ist die harmlosere
       * Richtung.
       */
      PS.data.markNewsSeen().catch(function () {});
    } catch (error) {
      nodes.feed.innerHTML = '';
      nodes.feed.appendChild(el('div', { class: 'status status--error' }, [
        el('p', { text: PS.escapeError(error) }),
        el('button', { class: 'btn', onclick: load }, ['Nochmal versuchen'])
      ]));
    }
  }

  function render() {
    var news = state.news;
    nodes.feed.innerHTML = '';

    if (state.me && state.me.isAdmin) {
      nodes.feed.appendChild(el('div', { class: 'neues__tools' }, [
        el('button', { class: 'btn btn--primary', onclick: openForm }, ['✎ Mitteilung schreiben'])
      ]));
    }

    var etwas = false;
    news.announcements.forEach(function (item) {
      etwas = true;
      nodes.feed.appendChild(announcement(item));
    });

    [fotos(news), kommentare(news), pinnwand(news), rezepte(news), termine(news)]
      .forEach(function (block) { if (block) { etwas = true; nodes.feed.appendChild(block); } });

    if (!etwas) nodes.feed.appendChild(nichts());

    nodes.feed.appendChild(archivBereich());
  }

  // --- frühere Mitteilungen ---------------------------------------------------

  /*
   * Nachlesen, was schon gelesen ist.
   *
   * Oben steht nur, was ungelesen oder noch aktuell ist — sonst stünde bei
   * jedem Betreten die ganze Familienchronik da. Ohne diesen Weg wäre „Die Oma
   * ist wieder zu Hause" nach einem einzigen Blick für immer unsichtbar,
   * obwohl die Zeile in der Datenbank steht.
   *
   * Erst auf Klick, nicht beim Laden: die Seite liegt im Weg zur App, und
   * niemand soll auf eine Liste warten, die er meistens nicht sehen will.
   */
  function archivBereich() {
    var box = el('section', { class: 'archiv' });

    if (state.archiv) {
      // Was oben schon steht, kommt nicht nochmal — sonst läse man dieselbe
      // Mitteilung zweimal untereinander.
      var obenSchon = {};
      state.news.announcements.forEach(function (item) { obenSchon[item.id] = true; });
      var frueher = state.archiv.filter(function (item) { return !obenSchon[item.id]; });

      box.appendChild(el('h2', { class: 'neuigkeit__head' }, [
        el('span', { class: 'neuigkeit__icon', text: '🗄' }),
        el('span', { text: 'Frühere Mitteilungen' })
      ]));
      if (!frueher.length) {
        box.appendChild(el('p', { class: 'hint', text: 'Es gibt keine früheren Mitteilungen.' }));
      } else {
        frueher.forEach(function (item) { box.appendChild(announcement(item)); });
      }
      return box;
    }

    box.appendChild(el('button', {
      class: 'btn btn--ghost archiv__open', onclick: openArchiv
    }, ['🗄 Frühere Mitteilungen ansehen']));
    return box;
  }

  async function openArchiv() {
    try {
      state.archiv = await PS.data.announcements();
    } catch (error) {
      PS.toast(PS.escapeError(error), 'error');
      return;
    }
    render();
  }

  function nichts() {
    return el('div', { class: 'status' }, [
      el('div', { class: 'status__emoji', text: '☕' }),
      el('p', { text: 'Nichts Neues — du bist auf dem Laufenden.' }),
      el('a', { class: 'btn btn--primary', href: 'index.html' }, ['Zu den Alben'])
    ]);
  }

  // --- Mitteilungen -----------------------------------------------------------

  function announcement(item) {
    var meta = [];
    if (item.author) meta.push('von ' + PS.people.display(item.author));
    meta.push(PS.formatDayShort(dayOf(item.at)));
    if (item.until) meta.push('gilt bis ' + PS.formatDayShort(item.until));

    var card = el('article', {
      class: 'aushang' + (item.unread ? ' is-new' : '')
    }, [
      el('p', { class: 'aushang__text', text: item.body }),
      el('p', { class: 'aushang__meta', text: meta.join(' · ') })
    ]);

    /*
     * Ein Mülleimer, kein Kreuz.
     *
     * Hier stand ein × oben rechts an der Karte, und das liest jeder als
     * „zumachen" — es löscht aber die Mitteilung für die GANZE Familie. Genau
     * so ist es passiert: „Die News schließe ich über das x?" Nein.
     *
     * Die Seite hat gar kein Schließen. Man verlässt sie über „Zu den Alben",
     * und sie hält einen beim nächsten Mal von selbst nicht mehr auf.
     */
    if (state.me && state.me.isAdmin) {
      card.appendChild(el('button', {
        class: 'aushang__delete', title: 'Diese Mitteilung für alle löschen',
        onclick: function () { removeAnnouncement(item); }
      }, ['🗑']));
    }
    return card;
  }

  function dayOf(date) {
    return date.getFullYear() + '-' +
      String(date.getMonth() + 1).padStart(2, '0') + '-' +
      String(date.getDate()).padStart(2, '0');
  }

  async function removeAnnouncement(item) {
    // Sagen, was wirklich passiert, und WELCHE es trifft. „Diese Mitteilung
    // entfernen?" verschweigt beides — und wer mehrere untereinander stehen
    // hat, weiß sonst nicht, an welcher er gerade gezogen hat.
    var kurz = item.body.replace(/\s+/g, ' ').slice(0, 60);
    if (item.body.length > 60) kurz += ' …';
    if (!global.confirm(
      'Diese Mitteilung für ALLE löschen?\n\n„' + kurz + '"\n\n' +
      'Sie verschwindet auch bei denen, die sie noch nicht gelesen haben. ' +
      'Das lässt sich nicht rückgängig machen.')) return;
    try {
      await PS.data.removeAnnouncement(item.id);
    } catch (error) {
      PS.toast(PS.escapeError(error), 'error');
      return;
    }
    // Wenn das Archiv offen ist, bleibt es offen — sonst klappt es einem beim
    // Aufräumen nach jedem Löschen vor der Nase zu.
    if (state.archiv) state.archiv = await PS.data.announcements();
    await load();
  }

  // --- was sonst passiert ist -------------------------------------------------

  function block(icon, headline, children) {
    return el('section', { class: 'neuigkeit' }, [
      el('h2', { class: 'neuigkeit__head' }, [
        el('span', { class: 'neuigkeit__icon', text: icon }),
        el('span', { text: headline })
      ])
    ].concat(children));
  }

  function fotos(news) {
    if (!news.photos.count) return null;
    var rows = news.photos.albums.map(function (album) {
      var bilder = el('div', { class: 'neuigkeit__bilder' });
      album.thumbs.forEach(function (url) {
        var img = el('img', { alt: '', loading: 'lazy' });
        img.src = url;
        bilder.appendChild(img);
      });
      // „3 Fotos und 1 Video" — ein Video ist kein Foto, und die Kachel unten
      // sagt es ja auch.
      var fotos = album.count - album.videos;
      var was = [];
      if (fotos) was.push(PS.plural(fotos, 'Foto', 'Fotos'));
      if (album.videos) was.push(PS.plural(album.videos, 'Video', 'Videos'));

      return el('a', {
        class: 'neuigkeit__zeile',
        href: 'index.html?album=' + encodeURIComponent(album.slug)
      }, [
        bilder,
        el('span', { class: 'neuigkeit__wort', text: was.join(' und ') + ' in „' + album.title + '"' })
      ]);
    });
    return block('📷', PS.plural(news.photos.count, 'Neue Aufnahme', 'Neue Aufnahmen'), rows);
  }

  function kommentare(news) {
    if (!news.comments.count) return null;
    var rows = news.comments.items.map(function (item) {
      return el('a', {
        class: 'neuigkeit__zeile',
        href: 'index.html?album=' + encodeURIComponent(item.album)
      }, [
        el('span', { class: 'neuigkeit__wer', text: PS.people.display(item.author) }),
        el('span', { class: 'neuigkeit__wort', text: item.body })
      ]);
    });
    return block('💬', PS.plural(news.comments.count, 'Neuer Kommentar', 'Neue Kommentare'), rows);
  }

  function pinnwand(news) {
    if (!news.posts.count) return null;
    var rows = news.posts.items.map(function (item) {
      return el('a', { class: 'neuigkeit__zeile', href: 'board.html' }, [
        el('span', { class: 'neuigkeit__wer', text: PS.people.display(item.author) }),
        el('span', { class: 'neuigkeit__wort', text: item.body })
      ]);
    });
    return block('📌', PS.plural(news.posts.count, 'Neuer Pinnwandbeitrag', 'Neue Pinnwandbeiträge'), rows);
  }

  function rezepte(news) {
    if (!news.recipes.count) return null;
    var rows = news.recipes.items.map(function (item) {
      return el('a', {
        class: 'neuigkeit__zeile',
        href: 'rezepte.html?rezept=' + encodeURIComponent(item.slug)
      }, [
        el('span', { class: 'neuigkeit__wort', text: item.title }),
        item.author ? el('span', { class: 'neuigkeit__wer', text: 'von ' + PS.people.display(item.author) }) : null
      ].filter(Boolean));
    });
    return block('🍰', PS.plural(news.recipes.count, 'Neues Rezept', 'Neue Rezepte'), rows);
  }

  function termine(news) {
    if (!news.events.count) return null;
    var rows = news.events.items.map(function (item) {
      var was = [PS.formatDayShort(item.starts_on)];
      if (item.place) was.push(item.place);
      return el('a', { class: 'neuigkeit__zeile', href: 'dates.html' }, [
        el('span', { class: 'neuigkeit__wort', text: item.title }),
        el('span', { class: 'neuigkeit__wer', text: was.join(' · ') })
      ]);
    });
    return block('📅', PS.plural(news.events.count, 'Neuer Termin', 'Neue Termine'), rows);
  }

  // --- schreiben (nur Admins) -------------------------------------------------

  function buildForm() {
    nodes.fBody = el('textarea', {
      class: 'field', rows: '5', maxlength: '2000',
      placeholder: 'Was soll die Familie wissen?'
    });
    nodes.fUntil = el('input', { class: 'field field--slim', type: 'date' });
    nodes.fSave = el('button', { class: 'btn btn--primary', onclick: save }, ['Aushängen']);

    nodes.form = el('div', { class: 'confirm is-hidden' }, [
      el('div', { class: 'confirm__box' }, [
        el('h2', { class: 'confirm__title', text: 'Mitteilung an die Familie' }),
        nodes.fBody,
        el('label', { class: 'label', text: 'Bis wann ist das aktuell? (optional)' }),
        nodes.fUntil,
        el('p', { class: 'hint', text:
          'Ohne Datum verschwindet die Mitteilung, sobald jemand sie gelesen hat. ' +
          'Mit Datum bleibt sie bis dahin stehen — hält aber niemanden mehr auf.' }),
        el('div', { class: 'confirm__actions' }, [
          el('button', { class: 'btn', onclick: closeForm }, ['Abbrechen']),
          nodes.fSave
        ])
      ])
    ]);
    return nodes.form;
  }

  function openForm() {
    nodes.fBody.value = '';
    nodes.fUntil.value = '';
    nodes.form.classList.remove('is-hidden');
    document.body.classList.add('is-locked');
    nodes.fBody.focus();
  }

  function closeForm() {
    nodes.form.classList.add('is-hidden');
    document.body.classList.remove('is-locked');
  }

  async function save() {
    var body = nodes.fBody.value.trim();
    if (!body) { nodes.fBody.focus(); PS.toast('Ohne Text gibt es nichts mitzuteilen.'); return; }

    nodes.fSave.disabled = true;
    nodes.fSave.textContent = 'Wird ausgehängt …';
    try {
      await PS.data.addAnnouncement(body, nodes.fUntil.value || null);
    } catch (error) {
      PS.toast(PS.escapeError(error), 'error');
      nodes.fSave.disabled = false;
      nodes.fSave.textContent = 'Aushängen';
      return;
    }
    nodes.fSave.disabled = false;
    nodes.fSave.textContent = 'Aushängen';
    closeForm();
    await load();
  }

  PS.requireSignIn(document.getElementById('app'), boot);
})(typeof globalThis !== 'undefined' ? globalThis : this);
