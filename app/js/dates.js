/*
 * Termine und Geburtstage — eine Liste, nach Datum, das Nächste zuerst.
 *
 * Kein Monatsraster. Ein Kalendergitter ist auf einem Telefon ein Haufen
 * leerer Kästchen, und die Frage lautet ohnehin nie "was war am 14.", sondern
 * "was kommt als Nächstes". Also eine Liste, und Vergangenes fällt weg.
 *
 * Geburtstage stehen dazwischen, obwohl sie aus einer anderen Tabelle kommen
 * und niemandem gehören. Auf dem Bildschirm sind sie dasselbe: ein Datum, auf
 * das man sich freut.
 */
(function (global) {
  'use strict';

  var PS = global.PS;
  var el = PS.el;

  var ANSWERS = [
    { key: 'ja', label: 'Bin dabei' },
    { key: 'vielleicht', label: 'Vielleicht' },
    { key: 'nein', label: 'Kann nicht' }
  ];

  var state = { me: null, items: [], people: null, busy: false };
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

    document.title = 'Termine';
    renderShell();
    await load(true);
    setInterval(function () {
      if (document.visibilityState === 'visible' && !state.busy) load(false);
    }, 60000);
  }

  function renderShell() {
    var app = document.getElementById('app');
    app.innerHTML = '';

    nodes.feed = el('main', { class: 'feed dates' });

    app.appendChild(el('header', { class: 'topbar' }, [
      el('div', { class: 'topbar__brand' }, [el('h1', { class: 'topbar__title', text: 'Termine' })]),
      el('div', { class: 'topbar__actions' }, [
        el('button', { class: 'btn btn--primary', onclick: openForm }, [
          el('span', { class: 'btn__wide', text: 'Neuer Termin' }),
          el('span', { class: 'btn__narrow', text: '+ Termin' })
        ]),
        el('button', { class: 'btn btn--ghost', title: 'Neu laden', onclick: function () { load(false); } }, ['⟳'])
      ])
    ]));
    app.appendChild(nodes.feed);
    app.appendChild(buildForm());
    app.appendChild(PS.nav(state.me));
  }

  async function load(first) {
    if (first) {
      nodes.feed.innerHTML = '';
      nodes.feed.appendChild(el('div', { class: 'status' }, [el('div', { class: 'spinner' })]));
    }
    try {
      state.items = await PS.data.calendar();
      if (!state.people) {
        state.people = await PS.people.load();
        if (state.people) PS.people.whenReady(render);
      }
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

  /**
   * "heute", "morgen", "in 5 Tagen", sonst das Datum.
   *
   * Wie weit etwas weg ist, will man beim Überfliegen wissen; das genaue
   * Datum steht daneben, sobald es weiter als eine Woche hin ist.
   */
  function howFar(iso) {
    var parts = iso.split('-').map(Number);
    var then = new Date(parts[0], parts[1] - 1, parts[2]);
    var now = new Date();
    var today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    var days = Math.round((then - today) / 86400000);
    // Angefangen und noch nicht vorbei — das gibt es erst, seit ein Termin
    // mehrere Tage dauern kann. Ohne diesen Fall stünde am dritten Tag des
    // Familientreffens nichts oder „vor 2 Tagen" dran.
    if (days < 0) return 'läuft gerade';
    if (days === 0) return 'heute';
    if (days === 1) return 'morgen';
    if (days === 2) return 'übermorgen';
    if (days <= 7) return 'in ' + days + ' Tagen';
    return null;
  }

  function render() {
    nodes.feed.innerHTML = '';
    if (!state.items.length) {
      nodes.feed.appendChild(el('div', { class: 'status' }, [
        el('div', { class: 'status__emoji', text: '📅' }),
        el('p', { text: 'Nichts geplant. Und kein Geburtstag eingetragen.' }),
        el('button', { class: 'btn btn--primary', onclick: openForm }, ['Ersten Termin anlegen'])
      ]));
      return;
    }
    state.items.forEach(function (item) {
      nodes.feed.appendChild(item.kind === 'birthday' ? birthdayCard(item) : eventCard(item));
    });
  }

  function dateLine(item) {
    var parts = [PS.formatRange(item.on, item.until)];
    // Die Uhrzeit gehört zu einem Tag. Bei „5. bis 10. August" hieße „15:00
    // Uhr" wahlweise am ersten Tag, jeden Tag oder gar nichts — also weglassen.
    if (item.at && !item.until) parts.push(item.at + ' Uhr');
    var line = el('div', { class: 'date__when' }, [
      el('span', { class: 'date__day', text: parts.join(' · ') })
    ]);
    var soon = howFar(item.on);
    if (soon) line.appendChild(el('span', { class: 'date__soon', text: soon }));
    return line;
  }

  function birthdayCard(item) {
    var card = el('article', { class: 'date date--birthday' }, [
      dateLine(item),
      el('strong', { class: 'date__title', text: item.title + ' hat Geburtstag' })
    ]);
    if (item.turns) {
      card.appendChild(el('p', { class: 'date__note', text: 'wird ' + item.turns }));
    }
    var face = PS.people.avatar(item.title, 40);
    if (face) { card.classList.add('date--face'); card.insertBefore(face, card.firstChild); }
    else card.insertBefore(el('span', { class: 'date__cake', text: '🎂' }), card.firstChild);
    return card;
  }

  function eventCard(item) {
    var card = el('article', { class: 'date' }, [
      dateLine(item),
      el('strong', { class: 'date__title', text: item.title })
    ]);
    // Von wem der Termin kommt, steht nur bei fremden dran. Beim eigenen wüsste
    // man es ohnehin, und „von dir" unter jedem zweiten Eintrag ist Lärm.
    if (item.host && !mine(item.hostId)) {
      card.appendChild(el('p', { class: 'date__host', text: 'von ' + PS.people.display(item.host) }));
    }
    if (item.place) card.appendChild(el('p', { class: 'date__place', text: '📍 ' + item.place }));
    if (item.note) card.appendChild(el('p', { class: 'date__note', text: item.note }));

    card.appendChild(replyRow(item));
    card.appendChild(guestList(item));

    // Wer ihn angelegt hat, darf ihn wieder wegnehmen. Der Server prüft es
    // nochmal — Admins dürfen auch, damit kein Termin verwaist stehenbleibt.
    if (mine(item.hostId) || (state.me && state.me.isAdmin)) {
      card.appendChild(el('button', {
        class: 'comment__remove', title: 'Termin löschen',
        onclick: function () { removeEvent(item); }
      }, ['×']));
    }
    return card;
  }

  function myAnswer(item) {
    var found = null;
    item.replies.forEach(function (r) { if (mine(r.id)) found = r.answer; });
    return found;
  }

  function replyRow(item) {
    var row = el('div', { class: 'date__answers' });
    var current = myAnswer(item);
    ANSWERS.forEach(function (answer) {
      row.appendChild(el('button', {
        class: 'chip' + (current === answer.key ? ' is-active' : ''),
        onclick: function () { answerWith(item, answer.key); }
      }, [answer.label]));
    });
    return row;
  }

  /** Wer kommt, in einer Zeile — mit Gesichtern, wo es welche gibt. */
  function guestList(item) {
    var yes = item.replies.filter(function (r) { return r.answer === 'ja'; });
    var maybe = item.replies.filter(function (r) { return r.answer === 'vielleicht'; });
    var no = item.replies.filter(function (r) { return r.answer === 'nein'; });

    var row = el('div', { class: 'date__guests' });
    if (!item.replies.length) {
      row.appendChild(el('span', { class: 'date__nobody', text: 'Noch hat niemand geantwortet.' }));
      return row;
    }
    yes.forEach(function (r) {
      var face = r.name && PS.people.avatar(r.name, 26);
      if (face) row.appendChild(face);
      else row.appendChild(el('span', { class: 'date__guest', text: r.name || 'Jemand' }));
    });
    var tail = [];
    if (yes.length) tail.push(PS.plural(yes.length, 'Zusage', 'Zusagen'));
    if (maybe.length) tail.push(maybe.length + '× vielleicht');
    if (no.length) tail.push(no.length + '× abgesagt');
    row.appendChild(el('span', { class: 'date__tally', text: tail.join(', ') }));
    return row;
  }

  async function answerWith(item, answer) {
    state.busy = true;
    try {
      await PS.data.reply(item.id, answer);
    } catch (error) {
      PS.toast(PS.escapeError(error), 'error');
      state.busy = false;
      return;
    }
    // Die eigene Antwort sofort im Bild, ohne auf ein Neuladen zu warten.
    var mineRow = null;
    item.replies.forEach(function (r) { if (mine(r.id)) mineRow = r; });
    if (mineRow) mineRow.answer = answer;
    else item.replies.push({ id: state.me.id, answer: answer, name: state.me.name });
    state.busy = false;
    render();
  }

  async function removeEvent(item) {
    if (!global.confirm('„' + item.title + '" löschen?')) return;
    try {
      await PS.data.removeEvent(item);
    } catch (error) {
      PS.toast(PS.escapeError(error), 'error');
      return;
    }
    state.items = state.items.filter(function (other) { return other.id !== item.id; });
    render();
  }

  function mine(id) {
    return !!(id && state.me && id === state.me.id);
  }

  // --- der neue Termin ------------------------------------------------------

  function buildForm() {
    nodes.title = el('input', { class: 'field', type: 'text', maxlength: '120', placeholder: 'Worum geht es?' });
    nodes.on = el('input', { class: 'field', type: 'date' });
    nodes.until = el('input', { class: 'field', type: 'date' });
    nodes.at = el('input', { class: 'field', type: 'time' });
    nodes.place = el('input', { class: 'field', type: 'text', maxlength: '200', placeholder: 'Wo? (optional)' });
    nodes.note = el('textarea', { class: 'field', rows: '3', maxlength: '2000', placeholder: 'Noch etwas dazu? (optional)' });
    nodes.save = el('button', { class: 'btn btn--primary', onclick: save }, ['Eintragen']);

    nodes.form = el('div', { class: 'confirm is-hidden' }, [
      el('div', { class: 'confirm__box' }, [
        el('h2', { class: 'confirm__title', text: 'Neuer Termin' }),
        nodes.title,
        el('div', { class: 'date__fields' }, [nodes.on, nodes.at]),
        el('p', { class: 'hint', text: 'Uhrzeit leer lassen heißt: den ganzen Tag.' }),
        el('label', { class: 'label', text: 'Geht über mehrere Tage? Dann bis:' }),
        nodes.until,
        nodes.place,
        nodes.note,
        el('div', { class: 'confirm__actions' }, [
          el('button', { class: 'btn', onclick: closeForm }, ['Abbrechen']),
          nodes.save
        ])
      ])
    ]);
    return nodes.form;
  }

  function openForm() {
    nodes.form.classList.remove('is-hidden');
    document.body.classList.add('is-locked');
    nodes.title.focus();
  }

  function closeForm() {
    nodes.form.classList.add('is-hidden');
    document.body.classList.remove('is-locked');
  }

  async function save() {
    var title = nodes.title.value.trim();
    if (!title) { nodes.title.focus(); PS.toast('Der Termin braucht einen Namen.'); return; }
    if (!nodes.on.value) { nodes.on.focus(); PS.toast('Und ein Datum.'); return; }
    // Die Datenbank lehnt es ohnehin ab; hier steht es früher und auf Deutsch.
    if (nodes.until.value && nodes.until.value < nodes.on.value) {
      nodes.until.focus();
      PS.toast('Das Ende liegt vor dem Anfang.');
      return;
    }

    nodes.save.disabled = true;
    nodes.save.textContent = 'Wird eingetragen …';
    try {
      await PS.data.createEvent({
        title: title,
        on: nodes.on.value,
        // Ein „bis" am selben Tag ist kein Zeitraum, sondern derselbe Tag.
        until: (nodes.until.value && nodes.until.value !== nodes.on.value)
          ? nodes.until.value : null,
        at: nodes.at.value || null,
        place: nodes.place.value.trim(),
        note: nodes.note.value.trim()
      });
    } catch (error) {
      PS.toast(PS.escapeError(error), 'error');
      nodes.save.disabled = false;
      nodes.save.textContent = 'Eintragen';
      return;
    }
    [nodes.title, nodes.on, nodes.until, nodes.at, nodes.place, nodes.note]
      .forEach(function (f) { f.value = ''; });
    nodes.save.disabled = false;
    nodes.save.textContent = 'Eintragen';
    closeForm();
    await load(false);
  }

  PS.requireSignIn(document.getElementById('app'), boot);
})(typeof globalThis !== 'undefined' ? globalThis : this);
