/*
 * The guest list.
 *
 * Signing up is not open: an address that is not on this list gets no magic
 * link, so this page is the whole membership mechanism. It is also the only
 * place a face on the family photo gets tied to an address before its owner
 * ever signs in — do that here and the app greets them by name on the first
 * visit, with no "wer bist du?" at all.
 *
 * Everything on this page is enforced again by the database: only an admin may
 * read or write `invites`. Hiding it from everyone else is politeness, not
 * security.
 */
(function (global) {
  'use strict';

  var PS = global.PS;
  var el = PS.el;

  var state = { me: null, invites: [], roster: [], people: null, busy: false };
  var nodes = {};

  async function boot() {
    try {
      state.me = await PS.data.me();
    } catch (error) {
      PS.sb.signOut();
      location.reload();
      return;
    }
    document.title = 'Familie';
    renderShell();

    if (!state.me || !state.me.isAdmin) {
      nodes.list.innerHTML = '';
      nodes.list.appendChild(el('div', { class: 'status' }, [
        el('div', { class: 'status__emoji', text: '🔒' }),
        el('p', { text: 'Die Gästeliste darf nur verwalten, wer den Hub eingerichtet hat.' })
      ]));
      nodes.form.classList.add('is-hidden');
      return;
    }
    await load();
  }

  function renderShell() {
    var app = document.getElementById('app');
    app.innerHTML = '';

    nodes.email = el('input', {
      class: 'field', type: 'email', inputmode: 'email', autocomplete: 'off',
      autocapitalize: 'off', spellcheck: 'false', placeholder: 'adresse@beispiel.de'
    });
    nodes.person = el('select', { class: 'field' });
    nodes.admin = el('input', { type: 'checkbox', class: 'check' });
    nodes.add = el('button', { class: 'btn btn--primary', onclick: add }, ['Einladen']);

    nodes.form = el('div', { class: 'compose' }, [
      el('label', { class: 'label' }, ['Wen einladen?']),
      nodes.email,
      nodes.person,
      el('label', { class: 'checkrow' }, [nodes.admin, el('span', { text: 'darf die Gästeliste verwalten' })]),
      el('div', { class: 'compose__actions' }, [nodes.add])
    ]);

    nodes.list = el('main', { class: 'feed guests' });
    // Die Geburtstage stehen auf derselben Seite, weil nur ein Admin `people`
    // ändern darf — und weil beides dasselbe ist: wer zur Familie gehört.
    nodes.birthdays = el('main', { class: 'feed guests' });

    app.appendChild(el('header', { class: 'topbar' }, [
      el('div', { class: 'topbar__brand' }, [el('h1', { class: 'topbar__title', text: 'Familie' })]),
      el('div', { class: 'topbar__actions' }, [
        // Die Sicherung wohnt hier, weil sie dasselbe Recht braucht wie die
        // Gästeliste — und weil eine eigene Leiste unten für etwas, das man
        // einmal im Monat anfasst, den Platz der täglichen Wege wegnähme.
        el('a', { class: 'btn btn--ghost', href: 'sicherung.html', title: 'Alles herunterladen' },
          ['🖫 Sicherung']),
        el('button', { class: 'btn btn--ghost', title: 'Neu laden', onclick: load }, ['⟳'])
      ])
    ]));
    app.appendChild(el('div', { class: 'panel' }, [nodes.form]));
    app.appendChild(nodes.list);
    app.appendChild(nodes.birthdays);
    app.appendChild(PS.nav(state.me));
  }

  async function load() {
    nodes.list.innerHTML = '';
    nodes.list.appendChild(el('div', { class: 'status' }, [el('div', { class: 'spinner' })]));
    try {
      state.invites = await PS.data.invites();
      state.roster = await PS.data.roster();
      if (!state.people) {
        state.people = await PS.people.load();
        if (state.people) PS.people.whenReady(render);
        fillPeople();
      }
      render();
    } catch (error) {
      nodes.list.innerHTML = '';
      nodes.list.appendChild(el('div', { class: 'status status--error' }, [
        el('p', { text: PS.escapeError(error) })
      ]));
    }
  }

  function fillPeople() {
    nodes.person.innerHTML = '';
    nodes.person.appendChild(el('option', { value: '', text: 'Kein Gesicht auf dem Familienfoto' }));
    if (!state.people) return;
    state.people.people.forEach(function (person) {
      nodes.person.appendChild(el('option', { value: person.name, text: person.name }));
    });
  }

  function render() {
    renderInvites();
    renderBirthdays();
  }

  function renderInvites() {
    nodes.list.innerHTML = '';
    if (!state.invites.length) {
      nodes.list.appendChild(el('div', { class: 'status' }, [
        el('div', { class: 'status__emoji', text: '👪' }),
        el('p', { text: 'Noch niemand eingeladen.' })
      ]));
      return;
    }

    state.invites.forEach(function (invite) {
      var name = (invite.people && invite.people.name) || null;
      var row = el('div', { class: 'guest' }, [
        el('div', { class: 'guest__body' }, [
          el('strong', { class: 'guest__name', text: name || invite.email }),
          el('span', { class: 'guest__mail', text: name ? invite.email : '' })
        ]),
        el('span', {
          class: 'guest__state' + (invite.used_at ? ' is-here' : ''),
          // "Angemeldet" is the honest word: the invitation is used up the
          // moment somebody signs in with it, which is what used_at records.
          text: invite.used_at ? 'angemeldet' : 'noch nicht da'
        })
      ]);

      var face = name && PS.people.avatar(name, 36);
      if (face) { row.classList.add('guest--face'); row.insertBefore(face, row.firstChild); }
      if (invite.is_admin) row.appendChild(el('span', { class: 'guest__admin', text: 'Admin' }));

      // Nobody should be able to lock themselves out of their own guest list.
      if (state.me && invite.email.toLowerCase() !== String(state.me.email).toLowerCase()) {
        row.appendChild(el('button', {
          class: 'comment__remove', title: 'Einladung zurückziehen',
          onclick: function () { drop(invite); }
        }, ['×']));
      }

      nodes.list.appendChild(row);
    });
  }

  // --- Geburtstage ----------------------------------------------------------

  /*
   * Ein Feld pro Person, direkt in der Liste, ohne Formular und ohne
   * Speichern-Knopf: elf Zeilen einmal im Leben auszufüllen ist kein Vorgang,
   * der einen eigenen Dialog verdient. Gespeichert wird, sobald ein Feld
   * fertig ist.
   *
   * Das Jahr darf fehlen. Bei den Älteren weiß es niemand mehr, und dann steht
   * eben "am 3. Mai" statt "wird 78" — siehe die Migration.
   */
  function renderBirthdays() {
    nodes.birthdays.innerHTML = '';
    if (!state.roster.length) return;

    nodes.birthdays.appendChild(el('h2', { class: 'day', text: 'Geburtstage' }));
    nodes.birthdays.appendChild(el('p', { class: 'hint', text:
      'Tag, Monat, Jahr. Das Jahr darf fehlen — dann steht im Kalender kein Alter.' }));

    state.roster.forEach(function (person) {
      var day = el('input', {
        class: 'field field--slim birthday__part', type: 'number', min: '1', max: '31',
        placeholder: 'Tag', value: person.birth_day || ''
      });
      var month = el('input', {
        class: 'field field--slim birthday__part', type: 'number', min: '1', max: '12',
        placeholder: 'Monat', value: person.birth_month || ''
      });
      var year = el('input', {
        class: 'field field--slim birthday__part birthday__year', type: 'number',
        min: '1900', max: '2100', placeholder: 'Jahr', value: person.birth_year || ''
      });

      var row = el('div', { class: 'guest guest--birthday' }, [
        el('div', { class: 'guest__body' }, [
          el('strong', { class: 'guest__name', text: person.name })
        ]),
        el('div', { class: 'birthday__fields' }, [day, month, year])
      ]);

      var face = PS.people.avatar(person.name, 36);
      if (face) { row.classList.add('guest--face'); row.insertBefore(face, row.firstChild); }

      [day, month, year].forEach(function (field) {
        field.addEventListener('change', function () { saveBirthday(person, day, month, year, row); });
      });
      nodes.birthdays.appendChild(row);
    });
  }

  async function saveBirthday(person, day, month, year, row) {
    var d = Number(day.value) || null;
    var m = Number(month.value) || null;
    var y = Number(year.value) || null;
    // Der Server lehnt Halbes ohnehin ab; hier steht es nur früher und
    // freundlicher auf dem Bildschirm.
    if ((d && !m) || (m && !d)) { PS.toast('Tag und Monat gehören zusammen.'); return; }
    if (y && !d) { PS.toast('Ein Jahr allein ergibt keinen Geburtstag.'); return; }

    try {
      await PS.data.setBirthday(person.name, d, m, y);
    } catch (error) {
      PS.toast(PS.escapeError(error), 'error');
      return;
    }
    person.birth_day = d; person.birth_month = m; person.birth_year = y;
    row.classList.add('is-saved');
    setTimeout(function () { row.classList.remove('is-saved'); }, 1200);
  }

  async function add() {
    var email = nodes.email.value.trim();
    if (!email || email.indexOf('@') < 1) {
      PS.toast('Bitte eine E-Mail-Adresse eingeben.');
      nodes.email.focus();
      return;
    }
    if (state.busy) return;
    state.busy = true;
    nodes.add.disabled = true;
    nodes.add.textContent = 'Wird eingetragen …';
    try {
      await PS.data.invite(email, nodes.person.value || null, nodes.admin.checked);
    } catch (error) {
      PS.toast(PS.escapeError(error), 'error');
      state.busy = false;
      nodes.add.disabled = false;
      nodes.add.textContent = 'Einladen';
      return;
    }
    nodes.email.value = '';
    nodes.person.value = '';
    nodes.admin.checked = false;
    state.busy = false;
    nodes.add.disabled = false;
    nodes.add.textContent = 'Einladen';
    // The invitation is the permission, not a mail: nothing is sent from here.
    // They ask for their own link on the front page whenever they get round to
    // it, which also means no link ever sits unread in an inbox.
    PS.toast(email + ' kann sich jetzt anmelden.');
    await load();
  }

  async function drop(invite) {
    var name = (invite.people && invite.people.name) || invite.email;
    if (!global.confirm(name + ' aus der Familie entfernen?\n\n' +
      'Fotos und Beiträge bleiben, aber anmelden geht dann nicht mehr.')) return;
    try {
      await PS.data.uninvite(invite.email);
    } catch (error) {
      PS.toast(PS.escapeError(error), 'error');
      return;
    }
    state.invites = state.invites.filter(function (other) { return other.email !== invite.email; });
    render();
  }

  PS.requireSignIn(document.getElementById('app'), boot);
})(typeof globalThis !== 'undefined' ? globalThis : this);
