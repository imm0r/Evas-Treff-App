/*
 * Textauszeichnung: fett, kursiv, unterstrichen, Links, Listen.
 *
 * WAS GESPEICHERT WIRD, IST WEITER NUR TEXT.
 *
 * In der Datenbank steht `**fett**`, nicht `<b>fett</b>`. Das ist die
 * wichtigste Entscheidung hier, und sie hat drei Gründe:
 *
 *   1. Gespeichertes HTML muss man beim Anzeigen wieder entschärfen. Ein
 *      einziger vergessener Pfad, und jemand kann der Familie Schadcode
 *      unterschieben. Text kann das nicht.
 *   2. Die Sicherung bleibt lesbar. In `daten.json` und in `LIESMICH.txt`
 *      steht dann immer noch etwas, das ein Mensch entziffern kann.
 *   3. Kein Schema ändert sich. Keine Migration, keine Umstellung von
 *      74 vorhandenen Texten.
 *
 * BEIM ANZEIGEN WIRD NIE `innerHTML` BENUTZT.
 *
 * Dieses Modul baut Knoten (`createElement`, `createTextNode`). Damit ist ein
 * eingeschleustes `<script>` keine Frage von Sorgfalt beim Maskieren, sondern
 * strukturell unmöglich: aus Text wird ein Textknoten, niemals Markup.
 *
 * DIE SPRACHE IST ABSICHTLICH KLEIN.
 *
 *   **fett**              __unterstrichen__       - Aufzählung
 *   *kursiv*              [Text](https://…)       1. Nummerierung
 *
 * Kein `#` für Überschriften, kein Code, keine Zitate, keine Tabellen. Wer
 * der Familie etwas schreibt, braucht sechs Dinge, nicht sechzig — und jede
 * weitere Regel ist eine weitere Art, wie ein normaler Satz versehentlich
 * anders aussieht als getippt.
 *
 * Aufzählungen nur mit `-`, nicht mit `*`: sonst wäre eine Zeile, die mit
 * einem Sternchen beginnt, mal eine Liste und mal der Anfang von kursiv.
 */
(function (global) {
  'use strict';

  var PS = global.PS || (global.PS = {});
  var el = PS.el;
  var text = {};

  /*
   * Die Reihenfolge in dieser Alternative entscheidet.
   *
   * `**` steht vor `*`, sonst würde der erste Stern von `**fett**` als Beginn
   * von kursiv gelesen und der Rest bliebe stehen. Links stehen ganz vorn,
   * damit eine Adresse mit Unterstrichen nicht mitten im Pfad unterstrichen
   * wird.
   *
   * `[^…]` statt `.` bei den Inhalten: eine Auszeichnung endet an der Zeile.
   * Ein einzelnes Sternchen mitten im Satz soll ein Sternchen bleiben und
   * nicht die nächsten drei Absätze kursiv setzen.
   *
   * ALS QUELLTEXT, NICHT ALS FERTIGES OBJEKT — und das ist keine Stilfrage.
   *
   * Ein Regex mit `g` trägt seinen Zustand (`lastIndex`) mit sich. `zeile()`
   * ruft sich für den INHALT einer Auszeichnung selbst auf; teilten sich
   * äußerer und innerer Lauf dasselbe Objekt, setzte der innere `lastIndex`
   * beim Beenden auf 0 zurück, und die äußere Schleife läse wieder von vorn.
   * Sie fände dieselbe Stelle, riefe sich wieder auf — endlos.
   *
   * Genau das ist passiert, und es sah nicht nach einer Endlosschleife aus:
   * der Testlauf wurde bloß „langsam", bis ein Chromium-Prozess 14 GB hielt,
   * weil die Seite ununterbrochen Knoten baute. Schon `**fett**` genügte.
   *
   * Jede Auswertung bekommt deshalb ihr eigenes Objekt.
   */
  /*
   * Klammern IN der Adresse.
   *
   * `[^)\s]+` hörte bei der ersten Klammer auf. Aus
   * `https://de.wikipedia.org/wiki/Apfel_(Frucht)` wurde damit ein Link auf
   * `…/Apfel_(Frucht` und ein übrig gebliebenes `)` daneben — und so eine
   * Adresse steht schnell in einem Rezept. Deshalb sind PAARE von Klammern
   * ausdrücklich erlaubt: entweder ein Zeichen, das keine Klammer ist, oder
   * eine geöffnete samt ihrer geschlossenen.
   */
  var IN_ADRESSE = '(?:[^()\\s]|\\([^()\\s]*\\))+';

  var MUSTER_QUELLE = [
    '\\[([^\\]\\n]+)\\]\\((' + IN_ADRESSE + ')\\)',   // [Text](Adresse)
    '(https?://' + IN_ADRESSE + ')',            // nackte Adresse
    '\\*\\*([^*\\n]+)\\*\\*',                   // **fett**
    '__([^_\\n]+)__',                           // __unterstrichen__
    '\\*([^*\\n]+)\\*'                          // *kursiv*
  ].join('|');

  /**
   * Nur Adressen, die man gefahrlos anklicken kann.
   *
   * `javascript:` als Ziel eines Links führt Code aus, sobald jemand darauf
   * tippt. Deshalb keine Sperrliste (die vergisst immer etwas), sondern eine
   * Erlaubnisliste mit genau zwei Einträgen.
   */
  function adresseOk(roh) {
    try {
      var u = new URL(roh, global.location && global.location.href);
      return (u.protocol === 'http:' || u.protocol === 'https:') ? u.href : null;
    } catch (error) {
      return null;
    }
  }

  function linkNode(beschriftung, ziel) {
    var href = adresseOk(ziel);
    // Kein gültiges Ziel: dann steht da eben, was getippt wurde. Etwas
    // wegzulassen wäre schlimmer als es unverlinkt zu zeigen.
    if (!href) return document.createTextNode(beschriftung);
    return el('a', {
      class: 'text-link', href: href, target: '_blank',
      // `noopener` trennt die neue Seite von unserer; ohne das könnte sie
      // dieses Fenster umleiten, während man wegsieht.
      rel: 'noopener noreferrer', text: beschriftung
    });
  }

  /**
   * Eine Zeile mit Auszeichnungen in Knoten verwandeln.
   *
   * `tiefe` bricht Verschachtelung ab. Ohne die Grenze könnte ein böswillig
   * oder versehentlich verschachtelter Text die Seite in eine sehr tiefe
   * Rekursion schicken; drei Ebenen sind mehr, als ein Mensch je tippt.
   */
  text.zeile = function (roh, tiefe) {
    var frag = document.createDocumentFragment();
    var rest = String(roh == null ? '' : roh);
    if ((tiefe || 0) > 3) {
      frag.appendChild(document.createTextNode(rest));
      return frag;
    }

    var at = 0;
    var treffer;
    var muster = new RegExp(MUSTER_QUELLE, 'g');
    while ((treffer = muster.exec(rest)) !== null) {
      if (treffer.index > at) {
        frag.appendChild(document.createTextNode(rest.slice(at, treffer.index)));
      }
      if (treffer[1] !== undefined) {
        frag.appendChild(linkNode(treffer[1], treffer[2]));
      } else if (treffer[3] !== undefined) {
        frag.appendChild(linkNode(treffer[3], treffer[3]));
      } else if (treffer[4] !== undefined) {
        frag.appendChild(el('strong', {}, [text.zeile(treffer[4], (tiefe || 0) + 1)]));
      } else if (treffer[5] !== undefined) {
        frag.appendChild(el('u', {}, [text.zeile(treffer[5], (tiefe || 0) + 1)]));
      } else if (treffer[6] !== undefined) {
        frag.appendChild(el('em', {}, [text.zeile(treffer[6], (tiefe || 0) + 1)]));
      }
      at = treffer.index + treffer[0].length;
    }
    if (at < rest.length) frag.appendChild(document.createTextNode(rest.slice(at)));
    return frag;
  };

  var AUFZAEHLUNG = /^\s*-\s+(.*)$/;
  var NUMMERIERUNG = /^\s*\d+[.)]\s+(.*)$/;

  /**
   * Ein ganzer Fließtext: Absätze, Aufzählungen, Nummerierungen.
   *
   * Zeilenumbrüche INNERHALB eines Absatzes bleiben Umbrüche. Bisher wurden
   * alle diese Texte mit `white-space: pre-wrap` angezeigt — wer heute in
   * einer Mitteilung eine Zeile umbricht, hat das so gemeint, und das darf
   * durch die Formatierung nicht verlorengehen.
   */
  text.block = function (roh) {
    var frag = document.createDocumentFragment();
    var zeilen = String(roh == null ? '' : roh).split('\n');
    var absatz = null;
    var liste = null;
    var listenArt = null;

    function absatzSchliessen() {
      absatz = null;
    }
    function listeSchliessen() {
      liste = null;
      listenArt = null;
    }

    zeilen.forEach(function (zeile) {
      var auf = AUFZAEHLUNG.exec(zeile);
      var num = auf ? null : NUMMERIERUNG.exec(zeile);

      if (auf || num) {
        absatzSchliessen();
        var art = auf ? 'ul' : 'ol';
        if (listenArt !== art) {
          listeSchliessen();
          liste = el(art, { class: 'text-liste' });
          listenArt = art;
          frag.appendChild(liste);
        }
        liste.appendChild(el('li', {}, [text.zeile((auf || num)[1])]));
        return;
      }

      listeSchliessen();

      if (!zeile.trim()) {
        // Eine Leerzeile trennt Absätze — sie erzeugt aber keinen leeren.
        absatzSchliessen();
        return;
      }
      if (!absatz) {
        absatz = el('p', { class: 'text-absatz' });
        frag.appendChild(absatz);
      } else {
        absatz.appendChild(el('br'));
      }
      absatz.appendChild(text.zeile(zeile));
    });

    return frag;
  };

  /**
   * Die Auszeichnungen entfernen und nur den Text behalten.
   *
   * Gebraucht, wo kein Platz für Formatierung ist: die Zeile auf dem
   * Sperrbildschirm einer Benachrichtigung, der Anriss in der Übersicht
   * „was ist neu". Dort wäre `**fett**` kein fetter Text, sondern vier
   * Sternchen, die niemand tippen wollte.
   */
  text.roh = function (quelle) {
    var s = String(quelle == null ? '' : quelle);
    s = s.replace(/\[([^\]\n]+)\]\(([^)\s]+)\)/g, '$1');
    s = s.replace(/\*\*([^*\n]+)\*\*/g, '$1');
    s = s.replace(/__([^_\n]+)__/g, '$1');
    s = s.replace(/\*([^*\n]+)\*/g, '$1');
    s = s.replace(/^\s*[-]\s+/gm, '');
    return s;
  };

  /** Steht in diesem Text überhaupt eine Auszeichnung? */
  text.hatAuszeichnung = function (quelle) {
    var s = String(quelle == null ? '' : quelle);
    return /\*\*[^*\n]+\*\*|__[^_\n]+__|\*[^*\n]+\*|\[[^\]\n]+\]\([^)\s]+\)|^\s*(-|\d+[.)])\s+/m.test(s);
  };

  // --- die Knopfleiste über dem Schreibfeld ------------------------------------

  /*
   * Ein Textfeld mit Knöpfen, kein WYSIWYG-Editor.
   *
   * `contenteditable` sähe vertrauter aus und wäre eine andere Größenordnung
   * an Aufwand und Fehlern: jeder Browser baut daraus anderes HTML, Einfügen
   * aus Word schleppt Formatvorlagen ein, und am Ende steht doch wieder die
   * Frage, wie man das gefahrlos speichert. Knöpfe, die Zeichen einsetzen,
   * tun genau eine Sache und tun sie überall gleich.
   *
   * Damit trotzdem niemand raten muss, wie `**so etwas**` aussehen wird,
   * blendet sich unter dem Feld eine Vorschau ein — aber erst, sobald wirklich
   * eine Auszeichnung im Text steht. Wer einfach nur schreibt, sieht sie nie.
   */

  function ersetze(feld, von, bis, neu, markiereVon, markiereBis) {
    var wert = feld.value;
    feld.value = wert.slice(0, von) + neu + wert.slice(bis);
    feld.focus();
    feld.setSelectionRange(markiereVon, markiereBis);
    // Von Hand gesetzte Werte lösen kein `input` aus — die Vorschau und jede
    // Zeichenzählung hingen sonst hinterher.
    feld.dispatchEvent(new Event('input', { bubbles: true }));
  }

  /** Auszeichnung um die Auswahl legen — oder wieder entfernen. */
  function umschliessen(feld, marke) {
    var von = feld.selectionStart;
    var bis = feld.selectionEnd;
    var wert = feld.value;
    var innen = wert.slice(von, bis);
    var laenge = marke.length;

    // Schon ausgezeichnet? Dann wieder abnehmen, statt zu verdoppeln.
    if (wert.slice(von - laenge, von) === marke && wert.slice(bis, bis + laenge) === marke) {
      ersetze(feld, von - laenge, bis + laenge, innen, von - laenge, bis - laenge);
      return;
    }
    if (innen.slice(0, laenge) === marke && innen.slice(-laenge) === marke &&
        innen.length > laenge * 2) {
      var ohne = innen.slice(laenge, -laenge);
      ersetze(feld, von, bis, ohne, von, von + ohne.length);
      return;
    }

    ersetze(feld, von, bis, marke + innen + marke,
      von + laenge, von + laenge + innen.length);
  }

  /** Jede angefasste Zeile vorn kennzeichnen. */
  function zeilenweise(feld, praefix) {
    var wert = feld.value;
    var von = wert.lastIndexOf('\n', feld.selectionStart - 1) + 1;
    var endeRoh = wert.indexOf('\n', feld.selectionEnd);
    var bis = endeRoh === -1 ? wert.length : endeRoh;

    var zeilen = wert.slice(von, bis).split('\n');
    var neu = zeilen.map(function (z, i) {
      var sauber = z.replace(/^\s*(?:-\s+|\d+[.)]\s+)/, '');
      return sauber ? praefix(i + 1) + sauber : z;
    }).join('\n');

    ersetze(feld, von, bis, neu, von, von + neu.length);
  }

  function linkEinsetzen(feld) {
    var von = feld.selectionStart;
    var bis = feld.selectionEnd;
    var innen = feld.value.slice(von, bis);
    var beschriftung = innen || 'Text';
    var neu = '[' + beschriftung + '](https://)';
    // Der Zeiger landet hinter `https://`, also genau dort, wo als Nächstes
    // die Adresse hingehört.
    var zeigerAuf = von + neu.length - 1;
    ersetze(feld, von, bis, neu, zeigerAuf, zeigerAuf);
  }

  var KNOEPFE = [
    { klasse: 'is-fett', titel: 'Fett', inhalt: 'F', tun: function (f) { umschliessen(f, '**'); } },
    { klasse: 'is-kursiv', titel: 'Kursiv', inhalt: 'K', tun: function (f) { umschliessen(f, '*'); } },
    { klasse: 'is-unter', titel: 'Unterstrichen', inhalt: 'U', tun: function (f) { umschliessen(f, '__'); } },
    { klasse: 'is-link', titel: 'Link', inhalt: '🔗', tun: linkEinsetzen },
    { klasse: 'is-liste', titel: 'Aufzählung', inhalt: '•', liste: true,
      tun: function (f) { zeilenweise(f, function () { return '- '; }); } },
    { klasse: 'is-nummern', titel: 'Nummerierte Liste', inhalt: '1.', liste: true,
      tun: function (f) { zeilenweise(f, function (n) { return n + '. '; }); } }
  ];

  /**
   * Die Leiste zu einem Schreibfeld.
   *
   * `opts.listen === false` lässt die beiden Listen-Knöpfe weg — für Felder,
   * die schon eine Liste SIND. Zutaten und Zubereitungsschritte werden Zeile
   * für Zeile zu Listenpunkten; dort wäre ein „- " im Text nur ein Strich,
   * der vor dem Punkt steht.
   */
  text.werkzeuge = function (feld, opts) {
    var mitListen = !opts || opts.listen !== false;
    var leiste = el('div', { class: 'schreibhilfe' });

    KNOEPFE.forEach(function (knopf) {
      if (knopf.liste && !mitListen) return;
      leiste.appendChild(el('button', {
        type: 'button',
        class: 'schreibhilfe__knopf ' + knopf.klasse,
        title: knopf.titel,
        'aria-label': knopf.titel,
        // `mousedown` verhindern, sonst verliert das Textfeld die Auswahl,
        // bevor der Knopf sie überhaupt lesen kann.
        onmousedown: function (e) { e.preventDefault(); },
        onclick: function () { knopf.tun(feld); }
      }, [knopf.inhalt]));
    });

    return leiste;
  };

  /**
   * Die Vorschau unter dem Feld — sie zeigt sich nur, wenn es etwas zu zeigen
   * gibt.
   */
  text.vorschau = function (feld) {
    var box = el('div', { class: 'schreibvorschau' });

    function auffrischen() {
      var wert = feld.value || '';
      if (!text.hatAuszeichnung(wert)) {
        box.className = 'schreibvorschau';
        box.textContent = '';
        return;
      }
      box.className = 'schreibvorschau is-da';
      box.textContent = '';
      box.appendChild(el('span', { class: 'schreibvorschau__marke', text: 'So sieht es aus:' }));
      var inhalt = el('div', { class: 'schreibvorschau__inhalt' });
      inhalt.appendChild(text.block(wert));
      box.appendChild(inhalt);
    }

    feld.addEventListener('input', auffrischen);
    auffrischen();
    return box;
  };

  /**
   * Leiste, Feld und Vorschau in einem Rahmen — der Aufruf bleibt eine Zeile.
   *
   * Ein Rahmen statt „hinter dem Feld einhängen": die Formulare hier bauen
   * ihre Kinder als Liste auf, und da gibt es zum Zeitpunkt des Aufrufs noch
   * gar kein Elternelement, in das man etwas einfügen könnte.
   */
  text.feld = function (feld, opts) {
    return el('div', { class: 'schreibfeld' }, [
      text.werkzeuge(feld, opts), feld, text.vorschau(feld)
    ]);
  };

  PS.text = text;
})(typeof globalThis !== 'undefined' ? globalThis : this);
