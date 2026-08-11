/*
 * Text formatieren: fett, kursiv, unterstrichen, Links, Listen.
 *
 * GESCHRIEBEN WIRD IM FERTIGEN TEXT.
 *
 * Markieren, „F" drücken, der Text ist fett. Keine Sternchen, keine Vorschau,
 * kein zweites Feld. Die erste Fassung setzte sichtbare Marken in ein
 * gewöhnliches Textfeld und zeigte darunter, was daraus wird — technisch
 * sauber und für jemanden, der einfach etwas schreiben will, eine Zumutung.
 *
 * GESPEICHERT WIRD TROTZDEM NUR TEXT.
 *
 * In der Datenbank steht `**fett**`, nicht `<b>fett</b>`. Das sieht niemand,
 * es kostet also nichts — und es hält drei Dinge heil:
 *
 *   1. Was hereinkopiert wird, muss ohnehin ausgesiebt werden. Ein Absatz aus
 *      WhatsApp oder einer Webseite bringt Schriftarten, Farben, Tabellen und
 *      leere Container mit. Ohne Aussieben sähe die Pinnwand nach drei
 *      Einfügungen aus wie fünf verschiedene Webseiten. Dass dabei auch kein
 *      Schadcode durchkommt, ist ein Nebenprodukt, kein Misstrauen.
 *   2. Die Sicherung bleibt lesbar. In `daten.json` steht weiter etwas, das
 *      ein Mensch entziffern kann.
 *   3. Kein Schema ändert sich, keine Migration, keine Umstellung der
 *      vorhandenen Texte.
 *
 * BEIM ANZEIGEN WIRD NIE `innerHTML` BENUTZT.
 *
 * Dieses Modul baut Knoten (`createElement`, `createTextNode`). Aus Text wird
 * ein Textknoten, niemals Markup.
 *
 * DIE SPRACHE IST ABSICHTLICH KLEIN.
 *
 *   **fett**              __unterstrichen__       - Aufzählung
 *   *kursiv*              [Text](https://…)       1. Nummerierung
 *
 * Sechs Dinge, nicht sechzig. Aufzählungen nur mit `-`, nicht mit `*`: sonst
 * wäre eine Zeile, die mit einem Sternchen beginnt, mal eine Liste und mal der
 * Anfang von kursiv.
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


  // --- der Schreibbereich ------------------------------------------------------

  /*
   * WAS MAN SIEHT, IST DAS ERGEBNIS.
   *
   * Hier stand zuerst ein gewöhnliches Textfeld: Knöpfe setzten `**Sternchen**`
   * in den Text, darunter zeigte eine Vorschau, was daraus wird. Technisch
   * sauber, und für jemanden, der einfach etwas schreiben will, eine Zumutung —
   * zwei Felder, eine fremde Zeichensprache, und der Satz sieht beim Tippen
   * nicht aus wie hinterher.
   *
   * Jetzt wird direkt im fertigen Text geschrieben. Markieren, „F" drücken, der
   * Text ist fett. Keine Marken, keine Vorschau, kein zweites Feld.
   *
   * DAS TEXTFELD BLEIBT TROTZDEM.
   *
   * Es steht unsichtbar dahinter und trägt weiterhin den Wert. Jede Seite liest
   * und schreibt `feld.value` wie bisher — kein Formular musste angefasst
   * werden, und `maxlength` bleibt eine Zahl an genau einer Stelle. Der
   * sichtbare Bereich und das Feld werden in beide Richtungen gekoppelt.
   *
   * GESPEICHERT WIRD WEITER NUR TEXT.
   *
   * Das sieht niemand mehr, es kostet also nichts — und es hält zwei Dinge
   * heil: die Anzeige baut Knoten statt Markup (siehe oben), und die Sicherung
   * bleibt lesbar.
   */

  /*
   * Der ursprüngliche Zugriff auf `value`, bevor wir ihn je Feld abfangen.
   * Einmal am Modul, nicht in jeder Instanz: es ist immer dieselbe Beschreibung.
   */
  var ROH_WERT = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value');

  var ERLAUBT = {
    B: 'strong', STRONG: 'strong', I: 'em', EM: 'em', U: 'u',
    A: 'a', UL: 'ul', OL: 'ol', LI: 'li', BR: 'br', DIV: 'div', P: 'div'
  };

  /**
   * Alles wegräumen, was nicht zu den sechs Auszeichnungen gehört.
   *
   * Das ist KEINE Vorsichtsmaßnahme gegen die eigene Familie, sondern gegen
   * die Zwischenablage. Wer etwas aus WhatsApp, Word oder einer Webseite
   * hereinkopiert, bringt Schriftarten, Farben, Tabellen und leere Container
   * mit. Ohne Aussieben sähe die Pinnwand nach drei Einfügungen aus wie fünf
   * verschiedene Webseiten.
   *
   * Unbekannte Elemente werden AUFGELÖST, nicht gelöscht: der Text darin
   * bleibt. Etwas verschwinden zu lassen, das jemand gerade eingefügt hat,
   * wäre die schlimmere Überraschung.
   */
  function saeubern(wurzel) {
    var kinder = Array.prototype.slice.call(wurzel.childNodes);
    kinder.forEach(function (knoten) {
      if (knoten.nodeType === 3) return;                       // Text bleibt
      if (knoten.nodeType !== 1) { wurzel.removeChild(knoten); return; }

      var name = ERLAUBT[knoten.tagName];
      if (!name) {
        // Auflösen: die Kinder rücken an die Stelle des Elements.
        saeubern(knoten);
        while (knoten.firstChild) wurzel.insertBefore(knoten.firstChild, knoten);
        wurzel.removeChild(knoten);
        return;
      }

      saeubern(knoten);

      // Attribute weg — bis auf ein Linkziel, das man anklicken darf.
      var behalten = null;
      if (name === 'a') {
        var href = adresseOk(knoten.getAttribute('href'));
        if (!href) {
          while (knoten.firstChild) wurzel.insertBefore(knoten.firstChild, knoten);
          wurzel.removeChild(knoten);
          return;
        }
        behalten = href;
      }
      Array.prototype.slice.call(knoten.attributes).forEach(function (a) {
        knoten.removeAttribute(a.name);
      });
      if (behalten) {
        knoten.setAttribute('href', behalten);
        knoten.setAttribute('target', '_blank');
        knoten.setAttribute('rel', 'noopener noreferrer');
      }

      // `<b>` und `<i>` kommen von `execCommand`; vereinheitlichen, damit die
      // Umwandlung nur eine Schreibweise kennen muss.
      if (knoten.tagName.toLowerCase() !== name) {
        var neu = document.createElement(name);
        while (knoten.firstChild) neu.appendChild(knoten.firstChild);
        if (behalten) {
          neu.setAttribute('href', behalten);
          neu.setAttribute('target', '_blank');
          neu.setAttribute('rel', 'noopener noreferrer');
        }
        wurzel.replaceChild(neu, knoten);
      }
    });
  }

  /** Aus dem sichtbaren Bereich wieder Text machen. */
  function alsMarkup(wurzel) {
    var raus = '';

    function inhalt(knoten) {
      var s = '';
      Array.prototype.slice.call(knoten.childNodes).forEach(function (k) { s += stueck(k); });
      return s;
    }

    function stueck(knoten) {
      if (knoten.nodeType === 3) return knoten.nodeValue;
      if (knoten.nodeType !== 1) return '';
      switch (knoten.tagName) {
        case 'BR': return '\n';
        case 'STRONG': case 'B': return '**' + inhalt(knoten) + '**';
        case 'EM': case 'I': return '*' + inhalt(knoten) + '*';
        case 'U': return '__' + inhalt(knoten) + '__';
        case 'A': return '[' + inhalt(knoten) + '](' + (knoten.getAttribute('href') || '') + ')';
        case 'LI': return inhalt(knoten);
        default: return inhalt(knoten);
      }
    }

    Array.prototype.slice.call(wurzel.childNodes).forEach(function (knoten) {
      if (knoten.nodeType === 1 && (knoten.tagName === 'UL' || knoten.tagName === 'OL')) {
        var nummer = 0;
        Array.prototype.slice.call(knoten.children).forEach(function (li) {
          nummer++;
          raus += (knoten.tagName === 'UL' ? '- ' : nummer + '. ') + inhalt(li) + '\n';
        });
        return;
      }
      if (knoten.nodeType === 1 && knoten.tagName === 'DIV') {
        // Ein leeres <div> ist eine Leerzeile — der Browser baut sie beim
        // Drücken der Eingabetaste so.
        raus += inhalt(knoten) + '\n';
        return;
      }
      raus += stueck(knoten);
    });

    // Der Browser hängt am Ende gern noch ein leeres <div> an.
    return raus.replace(/\n+$/, '');
  }

  /**
   * Der Bereich zu einem Textfeld.
   *
   * `opts.listen === false` lässt die beiden Listen-Knöpfe weg — für Felder,
   * die schon eine Liste SIND (Zutaten, Zubereitungsschritte).
   */
  text.feld = function (feld, opts) {
    var mitListen = !opts || opts.listen !== false;
    var bereich = el('div', {
      class: 'schreibbereich', contenteditable: 'true', role: 'textbox',
      'aria-multiline': 'true',
      'data-platzhalter': feld.getAttribute('placeholder') || ''
    });
    feld.classList.add('visually-hidden');
    feld.setAttribute('tabindex', '-1');
    feld.setAttribute('aria-hidden', 'true');

    var grenze = parseInt(feld.getAttribute('maxlength'), 10) || 0;
    var stillstand = false;

    function ausFeld() {
      stillstand = true;
      bereich.textContent = '';
      bereich.appendChild(text.block(feld.value || ''));
      stillstand = false;
    }

    function insFeld() {
      if (stillstand) return;
      saeubern(bereich);
      var wert = alsMarkup(bereich);
      /*
       * `maxlength` gilt für Textfelder, nicht für einen Schreibbereich.
       *
       * Ohne diese Zeile ließe sich beliebig viel tippen, und abgelehnt würde
       * es erst von der Datenbank — nach dem Absenden, mit einer Meldung, die
       * niemandem sagt, was zu tun ist. Genau so ein Fall war der rohe
       * Postgres-Fehler bei „4113 Portionen".
       */
      if (grenze && wert.length > grenze) {
        wert = wert.slice(0, grenze);
        ausFeld();
      }
      ROH_WERT.set.call(feld, wert);
      feld.dispatchEvent(new Event('input', { bubbles: true }));
    }

    /*
     * Den Wert des Feldes abfangen.
     *
     * Die Formulare setzen `nodes.fBody.value = …` beim Öffnen und leeren es
     * nach dem Absenden. Ohne diesen Zugriff bliebe der sichtbare Bereich
     * dabei stehen, wie er war — man öffnete ein Rezept zum Ändern und sähe
     * das vorige.
     */
    Object.defineProperty(feld, 'value', {
      configurable: true,
      get: function () { return ROH_WERT.get.call(feld); },
      set: function (v) { ROH_WERT.set.call(feld, v == null ? '' : v); ausFeld(); }
    });

    bereich.addEventListener('input', insFeld);
    bereich.addEventListener('blur', insFeld);

    /*
     * Eingefügtes zuerst zu Text machen, dann selbst auszeichnen.
     *
     * Der Browser fügt sonst den kompletten HTML-Baum der Quelle ein. Das
     * Aussieben repariert das zwar hinterher, aber für einen Wimpernschlag
     * steht die fremde Formatierung im Bereich und das Fenster springt.
     */
    bereich.addEventListener('paste', function (e) {
      e.preventDefault();
      var eingefuegt = (e.clipboardData || global.clipboardData).getData('text/plain');
      document.execCommand('insertText', false, eingefuegt);
    });

    ausFeld();

    var leiste = el('div', { class: 'schreibhilfe' });
    KNOEPFE.forEach(function (knopf) {
      if (knopf.liste && !mitListen) return;
      leiste.appendChild(el('button', {
        type: 'button',
        class: 'schreibhilfe__knopf ' + knopf.klasse,
        title: knopf.titel,
        'aria-label': knopf.titel,
        // Ohne das verliert der Schreibbereich beim Antippen die Markierung,
        // und der Knopf wüsste nicht mehr, worauf er sich beziehen soll.
        onmousedown: function (e) { e.preventDefault(); },
        onclick: function () {
          bereich.focus();
          knopf.tun();
          insFeld();
        }
      }, [knopf.inhalt]));
    });

    return el('div', { class: 'schreibfeld' }, [leiste, bereich, feld]);
  };

  /*
   * `execCommand` ist offiziell veraltet — und die einzige Möglichkeit, die
   * überall funktioniert.
   *
   * Der Nachfolger heißt `Highlight`/`EditContext` und wird noch nicht von
   * genug Browsern unterstützt, um eine Familie darauf zu stellen. Alles selbst
   * zu machen hieße, Auswahl, Verschachtelung und Rückgängig von Hand zu
   * verwalten — deutlich mehr Code und deutlich mehr Wege, es falsch zu machen.
   */
  function befehl(name, wert) {
    try {
      // Ohne das setzt der Browser `<span style="font-weight:bold">` statt
      // `<b>`, und das Aussieben würde die Auszeichnung anschließend wegwerfen.
      document.execCommand('styleWithCSS', false, false);
    } catch (error) { /* nicht überall vorhanden, dann eben nicht */ }
    document.execCommand(name, false, wert === undefined ? null : wert);
  }

  function linkSetzen() {
    var auswahl = global.getSelection && global.getSelection().toString();
    var ziel = global.prompt('Wohin soll der Link führen?', 'https://');
    if (!ziel) return;
    if (!adresseOk(ziel)) {
      PS.toast('Das sieht nicht nach einer Web-Adresse aus.', 'error');
      return;
    }
    if (!auswahl) {
      // Ohne Markierung gäbe es nichts, worauf der Link liegen könnte.
      befehl('insertText', ziel);
      var s = global.getSelection();
      if (s && s.rangeCount) {
        var r = s.getRangeAt(0);
        r.setStart(r.endContainer, Math.max(0, r.endOffset - ziel.length));
        s.removeAllRanges(); s.addRange(r);
      }
    }
    befehl('createLink', ziel);
  }

  var KNOEPFE = [
    { klasse: 'is-fett', titel: 'Fett', inhalt: 'F', tun: function () { befehl('bold'); } },
    { klasse: 'is-kursiv', titel: 'Kursiv', inhalt: 'K', tun: function () { befehl('italic'); } },
    { klasse: 'is-unter', titel: 'Unterstrichen', inhalt: 'U', tun: function () { befehl('underline'); } },
    { klasse: 'is-link', titel: 'Link', inhalt: '🔗', tun: linkSetzen },
    { klasse: 'is-liste', titel: 'Aufzählung', inhalt: '•', liste: true,
      tun: function () { befehl('insertUnorderedList'); } },
    { klasse: 'is-nummern', titel: 'Nummerierte Liste', inhalt: '1.', liste: true,
      tun: function () { befehl('insertOrderedList'); } }
  ];

  PS.text = text;
})(typeof globalThis !== 'undefined' ? globalThis : this);
