/*
 * Rezepte.
 *
 * Das, was sonst auf einer Karteikarte in Omas Handschrift steht und beim
 * Weiterreichen verloren geht.
 *
 * Zwei Ansichten in einer Datei, wie bei den Alben: das Regal mit allen
 * Rezepten, und ein einzelnes unter `?rezept=<slug>`. Ein Rezept ist etwas,
 * das man verschickt („koch das mal"), also braucht es eine eigene Adresse.
 *
 * Zutaten und Zubereitung sind je ein Textfeld mit Zeilenumbrüchen und werden
 * hier zu einer Liste. Was die App NICHT tut, ist „500 g Mehl" in Menge und
 * Zutat zerlegen: Familienrezepte sagen „eine Prise", „2-3 Äpfel", „Mehl bis
 * es geht". Jede Zerlegung davon rät, und geraten wird hier nicht.
 */
(function (global) {
  'use strict';

  var PS = global.PS;
  var el = PS.el;

  var IMAGE_EDGE = 2560;
  var THUMB_EDGE = 480;
  var IMAGE_QUALITY = 0.82;

  // Dieselbe Obergrenze wie die Prüfregel an der Tabelle. Steht sie an zwei
  // Orten, dürfen sie nicht auseinanderlaufen — deshalb hier eine Konstante
  // mit Namen und nicht eine 99 mitten im Text.
  var MAX_SERVINGS = 99;

  var state = { me: null, list: null, recipe: null, people: null, busy: false };
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
    await load(true);
  }

  function wanted() {
    return new URLSearchParams(location.search).get('rezept');
  }

  function href(recipe) {
    return 'rezepte.html?rezept=' + encodeURIComponent(recipe.slug);
  }

  function renderShell() {
    var app = document.getElementById('app');
    app.innerHTML = '';

    nodes.feed = el('main', { class: 'feed rezepte' });
    nodes.title = el('h1', { class: 'topbar__title', text: 'Rezepte' });
    nodes.back = el('a', {
      class: 'btn btn--ghost topbar__back is-hidden',
      href: 'rezepte.html', title: 'Alle Rezepte'
    }, ['‹']);
    nodes.add = el('button', { class: 'btn btn--primary', onclick: openForm }, [
      el('span', { class: 'btn__wide', text: 'Neues Rezept' }),
      el('span', { class: 'btn__narrow', text: '+ Rezept' })
    ]);

    app.appendChild(el('header', { class: 'topbar' }, [
      el('div', { class: 'topbar__brand' }, [nodes.back, nodes.title]),
      el('div', { class: 'topbar__actions' }, [
        nodes.add,
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
      var slug = wanted();
      if (slug) {
        state.recipe = await PS.data.recipe(slug);
        state.list = null;
      } else {
        state.list = await PS.data.recipes();
        state.recipe = null;
      }
      if (!state.people) {
        state.people = await PS.people.load();
        if (state.people) PS.people.whenReady(render);
      }
      render();
    } catch (error) {
      nodes.feed.innerHTML = '';
      nodes.feed.appendChild(el('div', { class: 'status status--error' }, [
        el('p', { text: PS.escapeError(error) }),
        el('button', { class: 'btn', onclick: function () { load(true); } }, ['Nochmal versuchen'])
      ]));
    }
  }

  function render() {
    if (state.recipe) renderOne();
    else if (state.list) renderList();
    else renderMissing();
  }

  function renderMissing() {
    nodes.feed.innerHTML = '';
    nodes.title.textContent = 'Rezepte';
    nodes.feed.appendChild(el('div', { class: 'status' }, [
      el('div', { class: 'status__emoji', text: '🤷' }),
      el('p', { text: 'Dieses Rezept gibt es nicht (mehr).' }),
      el('a', { class: 'btn btn--primary', href: 'rezepte.html' }, ['Alle Rezepte'])
    ]));
  }

  // --- das Regal --------------------------------------------------------------

  function renderList() {
    nodes.feed.innerHTML = '';
    nodes.title.textContent = 'Rezepte';
    nodes.back.classList.add('is-hidden');
    nodes.add.classList.remove('is-hidden');

    if (!state.list.length) {
      nodes.feed.appendChild(el('div', { class: 'status' }, [
        el('div', { class: 'status__emoji', text: '🍰' }),
        el('p', { text: 'Noch kein Rezept aufgeschrieben.' }),
        el('button', { class: 'btn btn--primary', onclick: openForm }, ['Das erste aufschreiben'])
      ]));
      return;
    }

    var shelf = el('div', { class: 'shelf' });
    state.list.forEach(function (recipe) {
      var cover = el('div', { class: 'shelf__cover' });
      var unten = [];
      if (recipe.servings) unten.push('für ' + recipe.servings);
      if (recipe.owner) unten.push('von ' + PS.people.display(recipe.owner));

      var card = el('a', { class: 'shelf__card', href: href(recipe) }, [
        cover,
        el('div', { class: 'shelf__meta' }, [
          el('strong', { class: 'shelf__title', text: recipe.title }),
          el('span', { class: 'shelf__count', text: unten.join(' · ') })
        ])
      ]);
      shelf.appendChild(card);

      if (recipe.coverUrl) {
        cover.style.backgroundImage = 'url(' + recipe.coverUrl + ')';
        cover.classList.add('is-loaded');
      } else {
        // Kein Bild ist der Normalfall bei einer abgetippten Karteikarte, und
        // ein leeres graues Feld sähe aus wie ein Ladefehler.
        cover.classList.add('shelf__cover--none');
        cover.appendChild(el('span', { class: 'shelf__none', text: '🍲' }));
        cover.classList.add('is-loaded');
      }
    });
    nodes.feed.appendChild(shelf);
  }

  // --- ein Rezept -------------------------------------------------------------

  /** Eine Zeile ist ein Punkt. Leere Zeilen sind Tippfehler, keine Punkte. */
  function lines(text) {
    return (text || '').split('\n')
      .map(function (line) { return line.trim(); })
      .filter(function (line) { return line.length > 0; });
  }

  function mayEdit() {
    return !!(state.me && state.recipe &&
      (state.recipe.ownerId === state.me.id || state.me.isAdmin));
  }

  function renderOne() {
    var recipe = state.recipe;
    nodes.feed.innerHTML = '';
    nodes.title.textContent = recipe.title;
    document.title = recipe.title;
    nodes.back.classList.remove('is-hidden');
    nodes.add.classList.add('is-hidden');

    var card = el('article', { class: 'rezept' });

    if (recipe.photos.length) card.appendChild(gallery(recipe));

    var unten = [];
    if (recipe.servings) unten.push('für ' + recipe.servings);
    if (recipe.owner) unten.push('von ' + PS.people.display(recipe.owner));
    if (unten.length) card.appendChild(el('p', { class: 'rezept__who', text: unten.join(' · ') }));

    var zutaten = lines(recipe.ingredients);
    if (zutaten.length) {
      card.appendChild(el('h2', { class: 'rezept__head', text: 'Zutaten' }));
      var ul = el('ul', { class: 'rezept__zutaten' });
      zutaten.forEach(function (line) { ul.appendChild(el('li', { text: line })); });
      card.appendChild(ul);
    }

    var schritte = lines(recipe.steps);
    if (schritte.length) {
      card.appendChild(el('h2', { class: 'rezept__head', text: 'Zubereitung' }));
      var ol = el('ol', { class: 'rezept__schritte' });
      schritte.forEach(function (line) { ol.appendChild(el('li', { text: line })); });
      card.appendChild(ol);
    }

    if (recipe.note) {
      card.appendChild(el('p', { class: 'rezept__note', text: recipe.note }));
    }

    if (mayEdit()) {
      card.appendChild(el('div', { class: 'rezept__tools' }, [
        el('button', { class: 'btn', onclick: function () { openForm(recipe); } }, ['Bearbeiten']),
        el('button', { class: 'btn', onclick: function () { nodes.file.click(); } }, ['📷 Bild dazu']),
        el('button', { class: 'btn btn--ghost btn--danger', onclick: removeRecipe }, ['Löschen'])
      ]));
    }

    nodes.feed.appendChild(card);
  }

  function gallery(recipe) {
    var box = el('div', { class: 'rezept__bilder' });
    recipe.photos.forEach(function (photo) {
      var img = el('img', {
        class: 'rezept__bild' + (photo.isCover ? ' is-cover' : ''),
        alt: recipe.title, loading: 'lazy'
      });
      if (photo.thumbUrl) img.src = photo.thumbUrl;
      var frame = el('div', { class: 'rezept__rahmen' }, [img]);

      // Umsortieren darf, wem das Rezept gehört — der Server prüft es nochmal.
      if (mayEdit()) {
        if (!photo.isCover) {
          frame.appendChild(el('button', {
            class: 'rezept__cover', title: 'Zum Hauptbild machen',
            onclick: function () { makeCover(photo); }
          }, ['★']));
        }
        frame.appendChild(el('button', {
          class: 'comment__remove', title: 'Bild entfernen',
          onclick: function () { removePhoto(photo); }
        }, ['×']));
      }
      box.appendChild(frame);
    });
    return box;
  }

  async function makeCover(photo) {
    // Die tatsächlich kleinste Zahl, nicht einfach 0: nach dem zweiten
    // „zum Hauptbild machen" stünden sonst zwei Bilder auf -1, und welches
    // vorn steht, entschiede der Zufall.
    var lowest = state.recipe.photos[0].sortOrder;
    state.recipe.photos.forEach(function (p) {
      if (p.sortOrder < lowest) lowest = p.sortOrder;
    });
    try {
      await PS.data.makeCover(state.recipe, photo, lowest);
    } catch (error) {
      PS.toast(PS.escapeError(error), 'error');
      return;
    }
    await load(false);
  }

  async function removePhoto(photo) {
    if (!global.confirm('Dieses Bild entfernen?')) return;
    try {
      await PS.data.removeRecipePhoto(photo);
    } catch (error) {
      PS.toast(PS.escapeError(error), 'error');
      return;
    }
    await load(false);
  }

  async function removeRecipe() {
    if (!global.confirm('„' + state.recipe.title + '" löschen?\n\n' +
      'Die Bilder gehen mit. Zurückholen kann man es nicht.')) return;
    try {
      await PS.data.removeRecipe(state.recipe);
    } catch (error) {
      PS.toast(PS.escapeError(error), 'error');
      return;
    }
    location.href = 'rezepte.html';
  }

  // --- aufschreiben und ändern ------------------------------------------------

  function buildForm() {
    nodes.fTitle = el('input', { class: 'field', type: 'text', maxlength: '120', placeholder: 'Wie heißt es?' });
    nodes.fServings = el('input', {
      class: 'field field--slim', type: 'number', min: '1', max: String(MAX_SERVINGS),
      inputmode: 'numeric', placeholder: 'für wie viele?'
    });
    nodes.fIngredients = el('textarea', {
      class: 'field', rows: '7', maxlength: '4000',
      placeholder: '500 g Mehl\n3 Eier\neine Prise Salz'
    });
    nodes.fSteps = el('textarea', {
      class: 'field', rows: '7', maxlength: '8000',
      placeholder: 'Mehl und Eier verrühren.\nEine Stunde ruhen lassen.'
    });
    nodes.fNote = el('textarea', {
      class: 'field', rows: '2', maxlength: '2000', placeholder: 'Noch ein Hinweis? (optional)'
    });
    nodes.fSave = el('button', { class: 'btn btn--primary', onclick: save }, ['Aufschreiben']);
    nodes.fHead = el('h2', { class: 'confirm__title', text: 'Neues Rezept' });

    // Das Bild geht denselben Weg wie auf der Pinnwand: verkleinern auf dem
    // Gerät, HEIC vorher übersetzen, dann hochladen.
    nodes.file = el('input', { type: 'file', accept: 'image/*', class: 'visually-hidden' });
    nodes.file.addEventListener('change', function () { addPhoto(); });

    nodes.form = el('div', { class: 'confirm is-hidden' }, [
      el('div', { class: 'confirm__box confirm__box--tall' }, [
        nodes.fHead,
        nodes.fTitle,
        el('label', { class: 'label', text: 'Für wie viele Personen? (optional)' }),
        nodes.fServings,
        el('label', { class: 'label', text: 'Zutaten — eine pro Zeile' }),
        nodes.fIngredients,
        el('label', { class: 'label', text: 'Zubereitung — ein Schritt pro Zeile' }),
        nodes.fSteps,
        nodes.fNote,
        el('div', { class: 'confirm__actions' }, [
          el('button', { class: 'btn', onclick: closeForm }, ['Abbrechen']),
          nodes.fSave
        ])
      ])
    ]);

    var wrap = el('div', {}, [nodes.form, nodes.file]);
    return wrap;
  }

  function openForm(recipe) {
    var editing = recipe && recipe.id ? recipe : null;
    nodes.form._editing = editing;
    nodes.fHead.textContent = editing ? 'Rezept ändern' : 'Neues Rezept';
    nodes.fSave.textContent = editing ? 'Speichern' : 'Aufschreiben';
    nodes.fTitle.value = editing ? editing.title : '';
    nodes.fServings.value = editing && editing.servings ? editing.servings : '';
    nodes.fIngredients.value = editing ? editing.ingredients : '';
    nodes.fSteps.value = editing ? editing.steps : '';
    nodes.fNote.value = editing ? editing.note : '';
    nodes.form.classList.remove('is-hidden');
    document.body.classList.add('is-locked');
    nodes.fTitle.focus();
  }

  function closeForm() {
    nodes.form.classList.add('is-hidden');
    document.body.classList.remove('is-locked');
  }

  async function save() {
    var title = nodes.fTitle.value.trim();
    if (!title) { nodes.fTitle.focus(); PS.toast('Das Rezept braucht einen Namen.'); return; }
    if (!nodes.fIngredients.value.trim() && !nodes.fSteps.value.trim()) {
      nodes.fIngredients.focus();
      PS.toast('Ohne Zutaten und ohne Zubereitung ist es kein Rezept.');
      return;
    }

    /*
     * Die Portionen hier prüfen, nicht erst in der Datenbank.
     *
     * `min`/`max` am Feld hält der Browser beim Tippen nicht auf, und der Wert
     * wird auch nicht abgeschnitten — wer 4113 eintippt, kam bis hierher
     * durch. Die Datenbank sagte dann nein, und was auf dem Telefon stand, war
     * `recipes_servings_check`. Der Satz unten ist derselbe Riegel, nur
     * rechtzeitig und auf Deutsch.
     */
    var servings = nodes.fServings.value.trim() ? Number(nodes.fServings.value) : null;
    if (servings !== null &&
        (!Number.isInteger(servings) || servings < 1 || servings > MAX_SERVINGS)) {
      nodes.fServings.focus();
      PS.toast('Für wie viele Personen? Bitte eine ganze Zahl von 1 bis ' + MAX_SERVINGS + '.');
      return;
    }

    var editing = nodes.form._editing;
    var fields = {
      title: title,
      servings: servings,
      ingredients: nodes.fIngredients.value.trim(),
      steps: nodes.fSteps.value.trim(),
      note: nodes.fNote.value.trim() || null
    };

    nodes.fSave.disabled = true;
    nodes.fSave.textContent = 'Wird gespeichert …';
    try {
      if (editing) {
        await PS.data.updateRecipe(editing, fields);
      } else {
        fields.slug = PS.album.slugify(title);
        var created = await PS.data.createRecipe(fields);
        closeForm();
        nodes.fSave.disabled = false;
        nodes.fSave.textContent = 'Aufschreiben';
        location.href = href(created);
        return;
      }
    } catch (error) {
      PS.toast(PS.escapeError(error), 'error');
      nodes.fSave.disabled = false;
      nodes.fSave.textContent = editing ? 'Speichern' : 'Aufschreiben';
      return;
    }
    nodes.fSave.disabled = false;
    nodes.fSave.textContent = 'Speichern';
    closeForm();
    await load(false);
  }

  async function addPhoto() {
    var file = nodes.file.files && nodes.file.files[0];
    if (!file || !state.recipe) return;
    state.busy = true;
    PS.toast('Bild wird vorbereitet …');
    try {
      var buffer = await file.arrayBuffer();
      var decoded = PS.heic && PS.heic.looksLike(buffer)
        ? await PS.heic.decode(buffer)
        : await PS.decodeImage(new Blob([buffer], { type: file.type || 'image/jpeg' }));
      var full, thumb;
      try {
        full = await PS.encodeJpeg(decoded, IMAGE_EDGE, IMAGE_QUALITY);
        thumb = await PS.encodeJpeg(decoded, THUMB_EDGE, IMAGE_QUALITY);
      } finally { decoded.release(); }

      // Ans Ende der Reihe, damit das erste Bild das Hauptbild bleibt. Nach der
      // größten vergebenen Zahl, nicht nach der Anzahl: die beiden laufen
      // auseinander, sobald ein Bild gelöscht oder nach vorn geholt wurde.
      var highest = state.recipe.photos.length ? state.recipe.photos[0].sortOrder : 0;
      state.recipe.photos.forEach(function (p) {
        if (p.sortOrder > highest) highest = p.sortOrder;
      });
      await PS.data.addRecipePhoto(state.recipe, full, thumb, highest + 1);
    } catch (error) {
      PS.toast(PS.escapeError(error), 'error');
      state.busy = false;
      nodes.file.value = '';
      return;
    }
    nodes.file.value = '';
    state.busy = false;
    await load(false);
  }

  PS.requireSignIn(document.getElementById('app'), boot);
})(typeof globalThis !== 'undefined' ? globalThis : this);
