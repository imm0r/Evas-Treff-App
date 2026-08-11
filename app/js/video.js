/*
 * Was der Browser über ein Video sagen kann, bevor es hochgeht.
 *
 * Ein Video geht UNVERÄNDERT in den Speicher — anders als ein Foto, das
 * vorher verkleinert wird. Umkodieren ginge im Browser nur mit einer
 * mitgelieferten Bibliothek und Minuten Rechenzeit auf dem Telefon, und ein
 * Dienst dafür ist bewusst nicht Teil dieses Projekts.
 *
 * Daraus folgt die eine unangenehme Wahrheit: iPhones filmen in HEVC/.mov,
 * und das spielt auf Apple-Geräten problemlos, in Chrome oder Firefox auf
 * anderen Systemen aber oft gar nicht. Statt das zu erraten oder das Format
 * abzuweisen (dann könnte die halbe Familie nicht hochladen), macht die App
 * zwei Dinge:
 *
 *   1. Sie zieht hier ein STANDBILD heraus. Das ist ein JPEG wie jedes andere
 *      Vorschaubild — die Galerie sieht also auch dann richtig aus, wenn der
 *      Betrachter das Video selbst nicht abspielen kann.
 *   2. Beim Abspielen sagt sie es ehrlich und bietet den Download an, statt
 *      ein schwarzes Feld hinzustellen.
 *
 * Und wenn schon das Gerät des HOCHLADERS das Video nicht lesen kann, erfährt
 * man das hier — vor dem Upload, mit einem Satz, der das erklärt.
 */
(function (global) {
  'use strict';

  var PS = global.PS || (global.PS = {});
  var video = {};

  // Wonach im Video für das Standbild gesucht wird. Nicht der allererste
  // Moment: Kameras fangen dunkel an und regeln die Belichtung erst nach, ein
  // Standbild bei 0.0 s ist deshalb oft schwarz. Eine halbe Sekunde später
  // steht das Bild, und bei einem sehr kurzen Clip nimmt es eben die Mitte.
  var POSTER_AT = 0.5;
  var POSTER_EDGE = 480;
  var POSTER_QUALITY = 0.7;

  // Wie lange auf ein Gerät gewartet wird, das gar nicht antworten will.
  // Ohne das bliebe der Upload bei einem Format, das der Browser weder
  // abspielen NOCH ablehnen kann, für immer bei "wird gelesen ..." stehen.
  var GEDULD_MS = 20000;

  video.looksLike = function (file) {
    return (file.type || '').indexOf('video/') === 0 ||
      /\.(mp4|mov|m4v|webm|avi|mkv|3gp)$/i.test(file.name || '');
  };

  /**
   * Maße, Dauer und ein Standbild.
   *
   * Wirft, wenn der Browser das Video nicht dekodieren kann — das ist ein
   * Ergebnis, keine Panne, und der Aufrufer macht daraus einen lesbaren Satz.
   */
  video.inspect = function (file) {
    return new Promise(function (resolve, reject) {
      var url = URL.createObjectURL(file);
      var el = document.createElement('video');
      var fertig = false;
      var gemessen = false;   // der Sprung ans Ende ist schon passiert

      function aufräumen() {
        clearTimeout(uhr);
        el.removeAttribute('src');
        el.load();
        URL.revokeObjectURL(url);
      }
      function gelungen(value) { if (!fertig) { fertig = true; aufräumen(); resolve(value); } }
      function gescheitert(message) { if (!fertig) { fertig = true; aufräumen(); reject(new Error(message)); } }

      var uhr = setTimeout(function () {
        gescheitert('Das Video ließ sich nicht lesen — dein Gerät braucht dafür zu lange.');
      }, GEDULD_MS);

      el.preload = 'metadata';
      // Stumm und "inline" ist keine Kosmetik: iOS weigert sich, ein Video mit
      // Ton ohne Zutun abzuspielen, und ohne Abspielen gibt es kein Bild zum
      // Abzeichnen.
      el.muted = true;
      el.playsInline = true;
      el.setAttribute('muted', '');
      el.setAttribute('playsinline', '');

      el.onerror = function () {
        gescheitert('Dieses Videoformat kann dein Browser nicht lesen.');
      };

      el.onloadedmetadata = function () {
        /*
         * Frisch aufgenommene Dateien melden `Infinity` als Dauer.
         *
         * Ein Rekorder schreibt die Länge erst in den Kopf der Datei, wenn er
         * fertig ist — bei Streaming-Formaten (WebM aus dem Browser, manche
         * .mov) steht sie deshalb gar nicht drin. Der Browser rechnet sie aus,
         * sobald man einmal ans Ende springt. Ohne diesen Umweg stünde an
         * jedem am Telefon aufgenommenen Video keine Laufzeit.
         */
        if (!isFinite(el.duration) && !gemessen) {
          gemessen = true;
          el.ondurationchange = function () {
            if (isFinite(el.duration)) { el.ondurationchange = null; el.onloadedmetadata(); }
          };
          try {
            el.currentTime = 1e101;
          } catch (error) {
            el.ondurationchange = null;
            weiter(null);
          }
          return;
        }
        weiter(isFinite(el.duration) && el.duration > 0 ? el.duration : null);
      };

      function weiter(dauer) {
        var ziel = dauer ? Math.min(POSTER_AT, dauer / 2) : 0;

        el.onseeked = async function () {
          try {
            // Erst das Bild fertig machen, DANN melden: ein noch offenes
            // Versprechen im Ergebnis abzuliefern hieße, dass ein Scheitern
            // hier unbemerkt am Aufrufer vorbeiläuft.
            var poster = await zeichne(el);
            gelungen({
              width: el.videoWidth,
              height: el.videoHeight,
              duration: dauer,
              poster: poster
            });
          } catch (error) {
            gescheitert('Aus dem Video ließ sich kein Vorschaubild gewinnen.');
          }
        };
        // Ohne Maße gibt es nichts abzuzeichnen — das ist eine Tonspur oder
        // eine kaputte Datei.
        if (!el.videoWidth || !el.videoHeight) {
          gescheitert('In dieser Datei ist kein Bild, nur Ton.');
          return;
        }
        try {
          el.currentTime = ziel;
        } catch (error) {
          gescheitert('Das Video ließ sich nicht an die richtige Stelle spulen.');
        }
      }

      el.src = url;
    });
  };

  /** Den aktuellen Bildinhalt als JPEG, auf Vorschaugröße gebracht. */
  function zeichne(el) {
    var scale = Math.min(1, POSTER_EDGE / Math.max(el.videoWidth, el.videoHeight));
    var canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.round(el.videoWidth * scale));
    canvas.height = Math.max(1, Math.round(el.videoHeight * scale));
    canvas.getContext('2d').drawImage(el, 0, 0, canvas.width, canvas.height);
    return new Promise(function (resolve, reject) {
      canvas.toBlob(function (blob) {
        if (blob) resolve(blob);
        else reject(new Error('Das Vorschaubild ließ sich nicht speichern.'));
      }, 'image/jpeg', POSTER_QUALITY);
    });
  }

  /** "1:04" statt "64 Sekunden" — so steht es auf jedem Abspielknopf. */
  video.formatDuration = function (seconds) {
    if (!seconds && seconds !== 0) return '';
    var ganz = Math.round(Number(seconds));
    var min = Math.floor(ganz / 60);
    var sek = ganz % 60;
    return min + ':' + (sek < 10 ? '0' : '') + sek;
  };

  /**
   * Die Dateiendung, unter der das Video abgelegt wird.
   *
   * Sie muss zum Inhalt passen: der Speicher liefert die Datei später mit dem
   * Typ aus, den er beim Hochladen bekommen hat, und ein heruntergeladenes
   * `.jpg`, in dem ein Film steckt, öffnet auf keinem Gerät.
   */
  video.extensionFor = function (file) {
    var type = (file.type || '').toLowerCase();
    if (type === 'video/mp4') return '.mp4';
    if (type === 'video/quicktime') return '.mov';
    if (type === 'video/webm') return '.webm';
    var hit = /\.([a-z0-9]+)$/i.exec(file.name || '');
    return hit ? '.' + hit[1].toLowerCase() : '.mp4';
  };

  PS.video = video;
})(typeof globalThis !== 'undefined' ? globalThis : this);
