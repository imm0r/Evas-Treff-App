/*
 * Die Sicherung: alles, was der Familie gehört, in einer Datei.
 *
 * Der Grund steht in der Dokumentation von Supabase, wörtlich: „Database
 * backups do not include objects you store via the Storage API." Die tägliche
 * Sicherung dort umfasst also die Datenbank — Alben, Kommentare, Rezepte —,
 * aber NICHT die Fotos und Videos. Genau das Unersetzliche fehlt. Dazu reicht
 * sie sieben Tage zurück und verschwindet mit dem Projekt: „When you delete a
 * project, we permanently remove all associated data, including any backups."
 *
 * Deshalb diese Seite. Sie macht eine Kopie, die niemandem gehört außer dem,
 * der sie herunterlädt.
 *
 * Zwei Entscheidungen prägen das Ergebnis:
 *
 *   1. LESBARE NAMEN. Im Speicher heißt ein Bild `evas-treff/a3f81c22.jpg` —
 *      das ist für die Software richtig und für einen Menschen nichts. Im
 *      Archiv liegt es unter `Alben/Eva's Treff/2026-08-07_2133_Maria.jpg`.
 *      Eine Sicherung, die man ohne die App nicht ansehen kann, ist keine.
 *   2. VOLLSTÄNDIG STATT HÜBSCH. Neben den lesbaren Bildern liegt `daten.json`
 *      mit allen Tabellen, und die Vorschaubilder behalten ihre
 *      Original-Pfade. Damit lässt sich der Stand wiederherstellen und nicht
 *      nur anschauen.
 */
(function (global) {
  'use strict';

  var PS = global.PS;
  var el = PS.el;

  var state = { me: null, plan: null, laeuft: false };
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

    if (!state.me || !state.me.isAdmin) {
      zeigeStatus('Diese Seite ist für Administratoren.', 'error');
      return;
    }
    await planen();
  }

  function renderShell() {
    var app = document.getElementById('app');
    app.innerHTML = '';

    nodes.feed = el('main', { class: 'feed sicherung' });
    app.appendChild(el('header', { class: 'topbar' }, [
      el('div', { class: 'topbar__brand' }, [el('h1', { class: 'topbar__title', text: 'Sicherung' })]),
      el('div', { class: 'topbar__actions' }, [
        el('a', { class: 'btn btn--ghost', href: 'admin.html' }, ['Zurück'])
      ])
    ]));
    app.appendChild(nodes.feed);
    app.appendChild(PS.nav(state.me));
  }

  function zeigeStatus(text, art) {
    nodes.feed.innerHTML = '';
    nodes.feed.appendChild(el('div', { class: 'status' + (art ? ' status--' + art : '') }, [
      el('p', { text: text })
    ]));
  }

  // --- vorher zeigen, was passiert --------------------------------------------

  /*
   * Erst zählen, dann anbieten.
   *
   * Wer auf „Sicherung erstellen" drückt, soll vorher wissen, wie viele
   * Dateien und wie viele Megabyte das werden — sonst wartet er bei einem
   * Familienvideo-Album minutenlang vor einem Balken, ohne zu ahnen, ob das
   * normal ist.
   */
  async function planen() {
    zeigeStatus('Wird zusammengestellt …');
    try {
      var tabellen = await PS.data.backupTables();
      state.plan = planAus(tabellen);
      renderPlan();
    } catch (error) {
      nodes.feed.innerHTML = '';
      nodes.feed.appendChild(el('div', { class: 'status status--error' }, [
        el('p', { text: PS.escapeError(error) }),
        el('button', { class: 'btn', onclick: planen }, ['Nochmal versuchen'])
      ]));
    }
  }

  /** Aus den Tabellen die Dateiliste mit ihren Namen im Archiv bauen. */
  function planAus(t) {
    var albumVon = {};
    (t.albums || []).forEach(function (a) { albumVon[a.id] = a; });
    var rezeptVon = {};
    (t.recipes || []).forEach(function (r) { rezeptVon[r.id] = r; });

    var dateien = [];
    var bytes = 0;

    (t.photos || []).forEach(function (p) {
      var album = albumVon[p.album_id];
      var ordner = 'Alben/' + sauber((album && album.title) || 'Ohne Album');
      var wann = new Date(p.taken_at);
      var name = tag(wann) + '_' + uhr(wann) + '_' + sauber(p.uploader_name || 'unbekannt');
      dateien.push({
        bucket: 'photos', path: p.storage_path,
        name: ordner + '/' + name + endung(p.storage_path), at: wann
      });
      // Vorschaubilder unter ihrem Original-Pfad: sie sind für Menschen
      // uninteressant, aber ohne sie fehlt beim Wiederherstellen die halbe
      // Galerie, und neu erzeugen kann sie hier niemand.
      dateien.push({
        bucket: 'photos', path: p.thumb_path,
        name: 'Vorschaubilder/' + p.thumb_path, at: wann
      });
      bytes += Number(p.bytes) || 0;
    });

    (t.board_posts || []).forEach(function (b) {
      if (!b.image_path) return;
      var wann = new Date(b.created_at);
      dateien.push({
        bucket: 'photos', path: b.image_path,
        name: 'Pinnwand/' + tag(wann) + '_' + sauber(b.author_name || 'unbekannt') +
          endung(b.image_path), at: wann
      });
    });

    (t.recipe_photos || []).forEach(function (rp, i) {
      var rezept = rezeptVon[rp.recipe_id];
      var wann = new Date(rp.created_at);
      dateien.push({
        bucket: 'photos', path: rp.storage_path,
        name: 'Rezepte/' + sauber((rezept && rezept.title) || 'Ohne Titel') + '/' +
          (rp.sort_order === 0 ? 'Hauptbild' : 'Bild-' + (i + 1)) + endung(rp.storage_path),
        at: wann
      });
      dateien.push({
        bucket: 'photos', path: rp.thumb_path,
        name: 'Vorschaubilder/' + rp.thumb_path, at: wann
      });
    });

    if ((t.people || []).length) {
      dateien.push({ bucket: 'people', path: 'photo.jpg', name: 'Familie/Gruppenfoto.jpg', at: new Date() });
    }

    // Derselbe Pfad kann mehrfach vorkommen (dasselbe Bild in zwei Beiträgen).
    // Zweimal herunterladen wäre Datenvolumen für nichts.
    var gesehen = {};
    dateien = dateien.filter(function (d) {
      if (!d.path || gesehen[d.bucket + '|' + d.path + '|' + d.name]) return false;
      gesehen[d.bucket + '|' + d.path + '|' + d.name] = true;
      return true;
    });

    return { tabellen: t, dateien: dateien, bytes: bytes };
  }

  function renderPlan() {
    var plan = state.plan;
    nodes.feed.innerHTML = '';

    var zeilen = Object.keys(plan.tabellen).map(function (name) {
      return el('li', { text: plan.tabellen[name].length + ' × ' + name });
    });

    nodes.feed.appendChild(el('div', { class: 'panel' }, [
      el('h2', { class: 'sicherung__head', text: 'Was gesichert wird' }),
      el('p', {
        text: PS.plural(plan.dateien.length, 'Datei', 'Dateien') + ' (Fotos, Videos, ' +
          'Vorschaubilder und das Gruppenfoto), dazu alle Tabellen als daten.json.'
      }),
      plan.bytes ? el('p', { class: 'hint', text: 'Ungefähr ' + PS.formatBytes(plan.bytes) +
        ' — das Herunterladen zählt auf euer Datenvolumen.' }) : null,
      el('ul', { class: 'sicherung__liste' }, zeilen),
      el('p', { class: 'hint', text: PS.zip.streamable()
        ? 'Dein Browser kann direkt auf die Festplatte schreiben — die Größe spielt keine Rolle.'
        : 'Dein Browser sammelt die Sicherung erst im Arbeitsspeicher. Bei sehr vielen '
          + 'Videos besser Chrome oder Edge nehmen, die schreiben direkt auf die Platte.' }),
      el('button', { class: 'btn btn--primary btn--big', onclick: starten }, ['Sicherung erstellen'])
    ].filter(Boolean)));

    nodes.feed.appendChild(el('p', { class: 'hint sicherung__warnung', text:
      'In der Sicherung stehen auch die E-Mail-Adressen der Familie — ohne sie ließe ' +
      'sich die Gästeliste nicht wiederherstellen. Bitte entsprechend aufbewahren.' }));
  }

  // --- die eigentliche Arbeit -------------------------------------------------

  async function starten() {
    if (state.laeuft) return;
    state.laeuft = true;

    var balken = el('i');
    var zeile = el('p', { class: 'sicherung__stand', text: 'Wird vorbereitet …' });
    nodes.feed.innerHTML = '';
    nodes.feed.appendChild(el('div', { class: 'panel' }, [
      el('h2', { class: 'sicherung__head', text: 'Sicherung läuft' }),
      zeile,
      el('div', { class: 'job__bar' }, [balken]),
      el('p', { class: 'hint', text: 'Bitte das Fenster offen lassen.' })
    ]));

    function melde(text, anteil) {
      zeile.textContent = text;
      balken.style.width = Math.round(anteil * 100) + '%';
    }

    var speicher;
    try {
      var name = 'evas-treff-sicherung-' + tag(new Date()) + '.zip';
      speicher = await PS.zip.saver(name);
    } catch (error) {
      // Der Speichern-Dialog wurde abgebrochen. Das ist kein Fehler.
      state.laeuft = false;
      renderPlan();
      return;
    }

    var fehlend = [];
    try {
      var archiv = PS.zip(speicher.write);
      var plan = state.plan;

      await archiv.add('daten.json',
        new TextEncoder().encode(JSON.stringify(plan.tabellen, null, 2)), new Date());
      await archiv.add('LIESMICH.txt', new TextEncoder().encode(liesmich(plan)), new Date());

      melde('Adressen werden geholt …', 0.02);
      var proBucket = {};
      plan.dateien.forEach(function (d) {
        (proBucket[d.bucket] = proBucket[d.bucket] || []).push(d.path);
      });
      var signiert = {};
      for (var bucket in proBucket) {
        signiert[bucket] = await PS.data.signMany(bucket, proBucket[bucket]);
      }

      for (var i = 0; i < plan.dateien.length; i++) {
        var d = plan.dateien[i];
        melde('Datei ' + (i + 1) + ' von ' + plan.dateien.length + ' · ' + d.name,
          0.05 + 0.94 * (i / plan.dateien.length));

        var url = signiert[d.bucket] && signiert[d.bucket][d.path];
        if (!url) { fehlend.push(d.path); continue; }
        var antwort = await fetch(url);
        if (!antwort.ok) { fehlend.push(d.path); continue; }
        await archiv.add(d.name, new Uint8Array(await antwort.arrayBuffer()), d.at);
      }

      /*
       * Fehlendes ins Archiv schreiben, nicht bloß auf den Bildschirm.
       *
       * Eine Sicherung wird angesehen, wenn das Original weg ist — dann ist
       * jede Meldung von heute längst zugeklickt. Was fehlt, muss IN der Datei
       * stehen.
       */
      if (fehlend.length) {
        await archiv.add('FEHLENDE-DATEIEN.txt',
          new TextEncoder().encode(
            'Diese Dateien standen in der Datenbank, waren im Speicher aber nicht\n' +
            'abrufbar. Sie fehlen in dieser Sicherung:\n\n' + fehlend.join('\n') + '\n'),
          new Date());
      }

      melde('Wird abgeschlossen …', 0.99);
      await archiv.finish();
      await speicher.done();

      fertig(archiv, fehlend);
    } catch (error) {
      nodes.feed.innerHTML = '';
      nodes.feed.appendChild(el('div', { class: 'status status--error' }, [
        el('p', { text: 'Die Sicherung ist nicht fertig geworden: ' + PS.escapeError(error) }),
        el('p', { class: 'hint', text: 'Die angefangene Datei ist unbrauchbar — bitte löschen und neu versuchen.' }),
        el('button', { class: 'btn btn--primary', onclick: planen }, ['Nochmal versuchen'])
      ]));
    }
    state.laeuft = false;
  }

  function fertig(archiv, fehlend) {
    nodes.feed.innerHTML = '';
    nodes.feed.appendChild(el('div', { class: 'summary summary--ok sicherung__fertig' }, [
      el('strong', { text: 'Sicherung fertig.' }),
      el('span', { text: ' ' + archiv.count() + ' Einträge, ' + PS.formatBytes(archiv.bytes()) + '.' })
    ]));
    if (fehlend.length) {
      nodes.feed.appendChild(el('div', { class: 'status status--error' }, [
        el('p', { text: PS.plural(fehlend.length, 'Eine Datei war', 'Dateien waren') +
          ' nicht abrufbar und fehlen. Welche, steht in FEHLENDE-DATEIEN.txt im Archiv.' })
      ]));
    }
    nodes.feed.appendChild(el('p', { class: 'hint', text:
      'Leg die Datei auf eine Festplatte, die nicht im selben Haus steht wie der Rechner, ' +
      'auf dem sie gerade liegt.' }));
    nodes.feed.appendChild(el('button', { class: 'btn', onclick: planen }, ['Noch eine erstellen']));
  }

  // --- Kleinkram --------------------------------------------------------------

  function liesmich(plan) {
    return [
      'Sicherung von Evas Treff',
      'Erstellt am ' + new Date().toLocaleString('de-DE'),
      '',
      'WAS HIER DRIN IST',
      '',
      '  Alben/            die Fotos und Videos, nach Album sortiert, mit',
      '                    Datum, Uhrzeit und dem Namen dessen, der sie',
      '                    hochgeladen hat. Die kann man einfach ansehen.',
      '  Pinnwand/         die Bilder von der Pinnwand.',
      '  Rezepte/          die Bilder zu den Rezepten.',
      '  Familie/          das Gruppenfoto.',
      '  Vorschaubilder/   die kleinen Vorschauen unter ihren technischen',
      '                    Pfaden. Für Menschen uninteressant, zum',
      '                    Wiederherstellen aber nötig.',
      '  daten.json        alle Tabellen: Alben, Kommentare, Termine,',
      '                    Rezepte, Mitteilungen, Gästeliste.',
      '',
      'ES ENTHÄLT E-MAIL-ADRESSEN',
      '',
      '  In daten.json stehen die Adressen der Familie, weil sich sonst die',
      '  Gästeliste nicht wiederherstellen ließe. Bitte nicht weitergeben.',
      '',
      'WAS ES NICHT ENTHÄLT',
      '',
      '  Die Konten selbst. Anmeldungen laufen über E-Mail-Links; wer den Hub',
      '  neu aufsetzt, lädt die Familie neu ein. Die Zuordnung, wer wer ist,',
      '  steht in daten.json.',
      '',
      'Zum Zeitpunkt der Sicherung: ' + plan.dateien.length + ' Dateien, ' +
        Object.keys(plan.tabellen).length + ' Tabellen.',
      ''
    ].join('\n');
  }

  /** Was in einem Dateinamen nichts zu suchen hat. */
  function sauber(text) {
    return String(text || '')
      .replace(/[\/\\:*?"<>|]/g, '-')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 60) || 'ohne-namen';
  }

  function endung(pfad) {
    var hit = /(\.[a-z0-9]+)$/i.exec(pfad || '');
    return hit ? hit[1].toLowerCase() : '';
  }

  function zwei(n) { return String(n).padStart(2, '0'); }
  function tag(d) { return d.getFullYear() + '-' + zwei(d.getMonth() + 1) + '-' + zwei(d.getDate()); }
  function uhr(d) { return zwei(d.getHours()) + zwei(d.getMinutes()); }

  PS.requireSignIn(document.getElementById('app'), boot);
})(typeof globalThis !== 'undefined' ? globalThis : this);
