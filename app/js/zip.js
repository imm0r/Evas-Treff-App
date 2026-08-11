/*
 * Ein ZIP-Archiv schreiben, ohne Fremdbibliothek.
 *
 * Warum selbst geschrieben: dieses Projekt hat keinen Bauschritt und keine
 * Abhängigkeiten. Eine Bibliothek dafür mitzuschleppen hieße, genau das
 * aufzugeben — für ein Format, dessen unkomprimierte Variante aus drei
 * Datenblöcken und einer Prüfsumme besteht.
 *
 * Warum OHNE Kompression (Methode 0, „store"): drin liegen JPEGs und Videos.
 * Die sind bereits komprimiert; sie nochmal durch den Packer zu schicken
 * kostet auf einem Telefon Minuten und spart ungefähr nichts. Das Archiv ist
 * hier eine Verpackung, kein Verkleinerer.
 *
 * Warum überhaupt ein Archiv statt vieler Einzeldownloads: eine Sicherung ist
 * eine Datei, die man auf eine Festplatte zieht. Zweihundert einzelne
 * Downloads sind keine Sicherung, sondern ein Ordner voller Arbeit.
 *
 * Geschrieben wird strömend: jede Datei geht sofort hinaus, statt sich im
 * Arbeitsspeicher zu sammeln. Sonst wäre bei ein paar Gigabyte Video der
 * Browser-Tab tot, und zwar genau bei der Familie mit den meisten Videos.
 */
(function (global) {
  'use strict';

  var PS = global.PS || (global.PS = {});

  // --- CRC32 ------------------------------------------------------------------
  //
  // Das ZIP-Format verlangt für jede Datei eine Prüfsumme. Ohne sie öffnet
  // kein Entpackprogramm das Archiv — und genau daran merkt man später, ob die
  // Sicherung heil ist.
  var CRC_TABLE = (function () {
    var table = new Uint32Array(256);
    for (var i = 0; i < 256; i++) {
      var c = i;
      for (var k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
      table[i] = c >>> 0;
    }
    return table;
  })();

  function crc32(bytes, seed) {
    var c = (seed === undefined ? 0xFFFFFFFF : seed);
    for (var i = 0; i < bytes.length; i++) {
      c = CRC_TABLE[(c ^ bytes[i]) & 0xFF] ^ (c >>> 8);
    }
    return c >>> 0;
  }

  function bytesOf(text) {
    return new TextEncoder().encode(text);
  }

  /*
   * MS-DOS-Zeitstempel. ZIP stammt aus 1989 und speichert das Datum in zwei
   * 16-Bit-Wörtern mit Zwei-Sekunden-Auflösung; Jahre zählen ab 1980. Wer das
   * weglässt, bekommt Dateien von 1980 in der Sicherung.
   */
  function dosTime(date) {
    var jahr = Math.max(1980, date.getFullYear());
    return {
      time: (date.getHours() << 11) | (date.getMinutes() << 5) | (date.getSeconds() >> 1),
      date: ((jahr - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate()
    };
  }

  function u16(view, at, value) { view.setUint16(at, value, true); }
  function u32(view, at, value) { view.setUint32(at, value >>> 0, true); }

  /**
   * Ein Archiv, das seine Teile sofort weiterreicht.
   *
   * `write(chunk)` bekommt jedes Stück in der Reihenfolge, in der es in die
   * Datei gehört. Wer streamt, hängt es an eine Datei; wer nicht kann, sammelt
   * es in einer Liste und macht am Ende ein Blob daraus.
   */
  PS.zip = function (write) {
    var eintraege = [];
    var offset = 0;

    async function put(chunk) {
      await write(chunk);
      offset += chunk.length;
    }

    return {
      /** Eine Datei anhängen. `data` ist ein Uint8Array. */
      add: async function (name, data, when) {
        var nameBytes = bytesOf(name);
        var summe = crc32(data) ^ 0xFFFFFFFF;
        var stamp = dosTime(when || new Date());
        var start = offset;

        var kopf = new Uint8Array(30 + nameBytes.length);
        var v = new DataView(kopf.buffer);
        u32(v, 0, 0x04034b50);      // "PK\3\4"
        u16(v, 4, 20);              // braucht Version 2.0
        // Bit 11: der Name ist UTF-8. Ohne das Bit rät der Entpacker eine
        // alte Codepage, und aus "Eva's Treff" wird Buchstabensalat.
        u16(v, 6, 0x0800);
        u16(v, 8, 0);               // Methode 0 = unkomprimiert
        u16(v, 10, stamp.time);
        u16(v, 12, stamp.date);
        u32(v, 14, summe);
        u32(v, 18, data.length);    // gepackt
        u32(v, 22, data.length);    // ungepackt — bei Methode 0 dasselbe
        u16(v, 26, nameBytes.length);
        u16(v, 28, 0);              // kein Zusatzfeld
        kopf.set(nameBytes, 30);

        await put(kopf);
        await put(data);

        eintraege.push({
          name: nameBytes, crc: summe, size: data.length, offset: start, stamp: stamp
        });
      },

      /**
       * Das Inhaltsverzeichnis ans Ende schreiben.
       *
       * Ein ZIP wird von HINTEN gelesen: ohne diesen Abschluss ist die Datei
       * für jedes Entpackprogramm kein Archiv, egal wie vollständig der Inhalt
       * davor ist.
       */
      finish: async function () {
        var start = offset;
        for (var i = 0; i < eintraege.length; i++) {
          var e = eintraege[i];
          var satz = new Uint8Array(46 + e.name.length);
          var v = new DataView(satz.buffer);
          u32(v, 0, 0x02014b50);    // "PK\1\2"
          u16(v, 4, 20);            // geschrieben von Version 2.0
          u16(v, 6, 20);            // braucht Version 2.0
          u16(v, 8, 0x0800);        // Name ist UTF-8
          u16(v, 10, 0);            // unkomprimiert
          u16(v, 12, e.stamp.time);
          u16(v, 14, e.stamp.date);
          u32(v, 16, e.crc);
          u32(v, 20, e.size);
          u32(v, 24, e.size);
          u16(v, 28, e.name.length);
          u16(v, 30, 0);            // Zusatzfeld
          u16(v, 32, 0);            // Kommentar
          u16(v, 34, 0);            // Datenträger
          u16(v, 36, 0);            // interne Attribute
          u32(v, 38, 0);            // externe Attribute
          u32(v, 42, e.offset);
          satz.set(e.name, 46);
          await put(satz);
        }

        var ende = new Uint8Array(22);
        var ev = new DataView(ende.buffer);
        u32(ev, 0, 0x06054b50);     // "PK\5\6"
        u16(ev, 4, 0);              // Datenträger
        u16(ev, 6, 0);
        u16(ev, 8, eintraege.length);
        u16(ev, 10, eintraege.length);
        u32(ev, 12, offset - start);
        u32(ev, 16, start);
        u16(ev, 20, 0);             // kein Archivkommentar
        await put(ende);
      },

      count: function () { return eintraege.length; },
      bytes: function () { return offset; }
    };
  };

  /*
   * Wohin geschrieben wird.
   *
   * Kann der Browser „Speichern unter" (File System Access API), geht jedes
   * Stück sofort auf die Platte — dann ist die Größe der Sicherung egal.
   * Firefox und Safari können das nicht; dort sammelt sich alles im
   * Arbeitsspeicher und wird am Ende als Download angeboten. Das geht bis in
   * den unteren Gigabyte-Bereich gut und darüber nicht mehr, deshalb sagt die
   * Seite vorher, welcher Weg genommen wird.
   */
  PS.zip.streamable = function () {
    return typeof global.showSaveFilePicker === 'function';
  };

  PS.zip.saver = async function (dateiname) {
    if (PS.zip.streamable()) {
      var handle = await global.showSaveFilePicker({
        suggestedName: dateiname,
        types: [{ description: 'ZIP-Archiv', accept: { 'application/zip': ['.zip'] } }]
      });
      var writable = await handle.createWritable();
      return {
        streamed: true,
        write: function (chunk) { return writable.write(chunk); },
        done: async function () { await writable.close(); return null; }
      };
    }

    var teile = [];
    return {
      streamed: false,
      write: function (chunk) { teile.push(chunk); },
      done: async function () {
        var blob = new Blob(teile, { type: 'application/zip' });
        var url = URL.createObjectURL(blob);
        var a = document.createElement('a');
        a.href = url;
        a.download = dateiname;
        document.body.appendChild(a);
        a.click();
        a.remove();
        // Erst freigeben, wenn der Download angelaufen ist — sofort widerrufen
        // heißt auf manchen Browsern: leere Datei.
        setTimeout(function () { URL.revokeObjectURL(url); }, 60000);
        return blob;
      }
    };
  };
})(typeof globalThis !== 'undefined' ? globalThis : this);
