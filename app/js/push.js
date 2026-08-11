/*
 * Benachrichtigungen einschalten — pro Gerät.
 *
 * Die Neues-Seite fängt einen erst ab, wenn man die App von sich aus öffnet.
 * Für „Die Oma ist wieder zu Hause" reicht das nicht: das soll ankommen, ohne
 * dass jemand nachsehen muss.
 *
 * Drei Dinge, die hier wehtun und deshalb erklärt gehören:
 *
 *   1. IPHONE. Apple lässt Web-Push nur zu, wenn die Seite zum Startbildschirm
 *      hinzugefügt wurde. Im normalen Safari-Tab gibt es `PushManager` gar
 *      nicht. Deshalb sagt die Oberfläche das AUSDRÜCKLICH, statt einen Knopf
 *      zu zeigen, der nichts tut.
 *   2. EINE FRAGE, EIN LEBEN LANG. Wer die Browser-Nachfrage einmal ablehnt,
 *      wird nie wieder gefragt — die App kann das nicht rückgängig machen, nur
 *      der Mensch in den Browsereinstellungen. Deshalb wird die Frage erst auf
 *      Knopfdruck gestellt und nicht beim Laden der Seite.
 *   3. JE GERÄT. Handy, Tablet und Laptop sind drei Anmeldungen. Wer auf dem
 *      Telefon einschaltet, bekommt am Rechner nichts, und das ist richtig so.
 */
(function (global) {
  'use strict';

  var PS = global.PS || (global.PS = {});
  var push = {};

  push.möglich = function () {
    return 'serviceWorker' in global.navigator &&
      'PushManager' in global &&
      'Notification' in global;
  };

  /*
   * Ein iPhone, das nicht auf dem Startbildschirm liegt.
   *
   * Erkennbar an: es ist ein Apple-Gerät mit Touch, aber die Seite läuft nicht
   * als installierte App. Dann fehlt `PushManager`, und der Grund dafür ist
   * kein Fehler, sondern eine Regel von Apple, die man mit zwei Handgriffen
   * umgehen kann.
   */
  push.brauchtStartbildschirm = function () {
    var apple = /iPad|iPhone|iPod/.test(global.navigator.userAgent) ||
      (global.navigator.platform === 'MacIntel' && global.navigator.maxTouchPoints > 1);
    var installiert = global.matchMedia && global.matchMedia('(display-mode: standalone)').matches;
    return apple && !installiert && !('PushManager' in global);
  };

  push.erlaubnis = function () {
    return ('Notification' in global) ? Notification.permission : 'unsupported';
  };

  function toBytes(base64url) {
    var norm = base64url.replace(/-/g, '+').replace(/_/g, '/');
    var raw = atob(norm + '='.repeat((4 - (norm.length % 4)) % 4));
    var out = new Uint8Array(raw.length);
    for (var i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
    return out;
  }

  function toB64url(buffer) {
    var bytes = new Uint8Array(buffer);
    var raw = '';
    for (var i = 0; i < bytes.length; i++) raw += String.fromCharCode(bytes[i]);
    return btoa(raw).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  }

  /** Ein Name, an dem man das Gerät in der Liste wiedererkennt. */
  function geraet() {
    var ua = global.navigator.userAgent;
    if (/iPhone/.test(ua)) return 'iPhone';
    if (/iPad/.test(ua)) return 'iPad';
    if (/Android/.test(ua)) return 'Android-Handy';
    if (/Macintosh/.test(ua)) return 'Mac';
    if (/Windows/.test(ua)) return 'Windows-Rechner';
    return 'Gerät';
  }

  push.registrierung = async function () {
    if (!push.möglich()) return null;
    return global.navigator.serviceWorker.register('sw.js');
  };

  /** Ist auf DIESEM Gerät schon eingeschaltet? */
  push.angemeldet = async function () {
    if (!push.möglich() || Notification.permission !== 'granted') return null;
    var reg = await global.navigator.serviceWorker.getRegistration();
    if (!reg) return null;
    return reg.pushManager.getSubscription();
  };

  /**
   * Einschalten. Muss aus einem Klick heraus aufgerufen werden.
   *
   * Wirft mit einem lesbaren Satz, wenn es nicht geht — der Aufrufer zeigt ihn
   * einfach an, statt „NotAllowedError" auf den Bildschirm zu bringen.
   */
  push.einschalten = async function () {
    if (!push.möglich()) {
      throw new Error('Dieser Browser kann keine Benachrichtigungen anzeigen.');
    }
    var erlaubnis = await Notification.requestPermission();
    if (erlaubnis === 'denied') {
      throw new Error('Du hast Benachrichtigungen abgelehnt. Das lässt sich nur in den ' +
        'Einstellungen des Browsers wieder ändern — die App darf nicht nochmal fragen.');
    }
    if (erlaubnis !== 'granted') throw new Error('Die Nachfrage wurde abgebrochen.');

    var reg = await global.navigator.serviceWorker.register('sw.js');
    await global.navigator.serviceWorker.ready;

    var vorhanden = await reg.pushManager.getSubscription();
    var sub = vorhanden || await reg.pushManager.subscribe({
      // Ohne dieses Häkchen weigern sich die Browser: eine Anmeldung, mit der
      // man auch STILL etwas tun könnte, gäbe es nicht. Jede Nachricht muss
      // sichtbar sein — was zu einem Familienhub ohnehin passt.
      userVisibleOnly: true,
      applicationServerKey: toBytes((global.SUPABASE_CONFIG || {}).vapidPublicKey)
    });

    var roh = sub.toJSON();
    await PS.data.savePushSubscription({
      endpoint: sub.endpoint,
      p256dh: (roh.keys && roh.keys.p256dh) || toB64url(sub.getKey('p256dh')),
      auth: (roh.keys && roh.keys.auth) || toB64url(sub.getKey('auth')),
      device: geraet()
    });
    return sub;
  };

  /** Auf diesem Gerät wieder abschalten. */
  push.ausschalten = async function () {
    var sub = await push.angemeldet();
    if (!sub) return;
    await PS.data.removePushSubscription(sub.endpoint);
    await sub.unsubscribe();
  };

  /*
   * DIE VORFRAGE
   * ============
   *
   * Der Schalter auf der Neues-Seite reicht nicht: dorthin kommt man nur,
   * wenn es gerade etwas Neues gibt. Wer nichts verpasst hat, landet direkt
   * in den Alben und findet den Schalter nie. Gemeldet als „hier wird es für
   * die meisten schwer, das zu finden" — zu Recht.
   *
   * Also fragt die App von sich aus. Aber NICHT mit dem Browser-Dialog:
   *
   *   1. Auf dem iPhone geht das gar nicht. WebKit, wörtlich: „As with other
   *      privileged features of the web platform, requesting a push
   *      subscription requires an explicit user gesture." Ein Aufruf beim
   *      Laden der Seite tut dort schlicht nichts.
   *   2. Und selbst wo es ginge, wäre es die schlechteste Variante. Ein
   *      unerwarteter Systemdialog wird reflexhaft weggetippt — und ein Nein
   *      gilt FÜR IMMER. Danach darf die App nie wieder fragen, das kann nur
   *      noch der Mensch in den Browsereinstellungen zurückdrehen.
   *
   * Deshalb erst eine eigene Karte, die erklärt, worum es geht. Der echte
   * Dialog kommt nur, wenn jemand darauf „Ja" drückt — dann ist es ein Klick,
   * die Frage ist erwartet, und ein Nein kostet nichts: es bleibt bei uns.
   */

  /*
   * Gemerkt wird JE GERÄT UND JE PERSON, nicht in der Datenbank.
   *
   * Je Gerät, weil die Anmeldung selbst je Gerät gilt — wer am Rechner
   * zugestimmt hat, muss am Handy nochmal gefragt werden, sonst bekommt er
   * dort nie etwas. Je Person zusätzlich, weil auf dem Familien-Tablet
   * mehrere Konten benutzt werden und die Frage sonst nur einer von ihnen
   * gestellt würde.
   *
   * Nebeneffekt auf dem iPhone, und er ist erwünscht: die zum Startbildschirm
   * hinzugefügte App hat einen eigenen Speicher. Wer den Hinweis im
   * Safari-Tab weggeklickt und die App dann installiert hat, wird dort erneut
   * gefragt — genau dann, wenn es zum ersten Mal funktionieren kann.
   */
  function merker(profileId) {
    return 'ps-push-gefragt:' + (profileId || 'unbekannt');
  }

  push.schonGefragt = function (profileId) {
    try {
      return global.localStorage.getItem(merker(profileId)) === '1';
    } catch (error) {
      // Ein Browser ohne localStorage (privater Modus mancher Geräte) darf
      // hier nicht abstürzen. Dann eben keine Vorfrage — lieber gar nicht
      // fragen als bei jedem Laden erneut.
      return true;
    }
  };

  push.merkeGefragt = function (profileId) {
    try {
      global.localStorage.setItem(merker(profileId), '1');
    } catch (error) { /* siehe oben */ }
  };

  /**
   * Die Karte — oder `null`, wenn hier nichts zu fragen ist.
   *
   * Nichts zu fragen ist bei: einem Browser ohne Benachrichtigungen, einer
   * bereits getroffenen Entscheidung (ja wie nein) und einem Gerät, das schon
   * gefragt wurde. In all diesen Fällen kommt `null` zurück und die Seite
   * sieht aus wie vorher.
   */
  push.vorfrage = function (profileId, fertig) {
    if (push.schonGefragt(profileId)) return null;

    var el = PS.el;
    var iphone = push.brauchtStartbildschirm();
    if (!iphone && !push.möglich()) return null;
    // 'granted' wie 'denied' heißt: die Frage ist längst beantwortet.
    if (!iphone && push.erlaubnis() !== 'default') return null;

    var karte = el('div', { class: 'vorfrage' });

    function weg() {
      push.merkeGefragt(profileId);
      if (karte.parentNode) karte.parentNode.removeChild(karte);
      if (fertig) fertig();
    }

    if (iphone) {
      karte.appendChild(el('p', { class: 'vorfrage__text', text:
        '🔔 Möchtest du Bescheid bekommen, wenn jemand der Familie etwas ausrichtet? ' +
        'Auf dem iPhone geht das nur, wenn diese Seite auf dem Startbildschirm liegt: ' +
        'unten auf „Teilen" tippen, dann „Zum Home-Bildschirm". Danach die App von dort ' +
        'öffnen — sie fragt dich dann.' }));
      karte.appendChild(el('div', { class: 'vorfrage__knoepfe' }, [
        el('button', { class: 'btn btn--small', onclick: weg }, ['Verstanden'])
      ]));
      return karte;
    }

    karte.appendChild(el('p', { class: 'vorfrage__text', text:
      '🔔 Sollen wir dich benachrichtigen, wenn es etwas Neues gibt? Dann bekommst du ' +
      'eine Mitteilung aufs Gerät, auch wenn die Seite gar nicht offen ist.' }));

    var ja = el('button', { class: 'btn btn--primary btn--small', onclick: async function () {
      ja.disabled = true;
      try {
        await push.einschalten();
      } catch (error) {
        ja.disabled = false;
        PS.toast(PS.escapeError(error), 'error');
        /*
         * Hier NICHT merken.
         *
         * Ein Fehler ist keine Entscheidung. Wer auf „Ja" gedrückt hat und
         * an einem Netzausfall gescheitert ist, will offensichtlich
         * Benachrichtigungen — dem die Frage für immer wegzunehmen wäre
         * genau falsch herum.
         *
         * Die Ausnahme kostet nichts: hat der Browser die Erlaubnis
         * verweigert, steht sie danach auf 'denied', und die Karte kommt
         * beim nächsten Laden von allein nicht mehr.
         */
        return;
      }
      PS.toast('Benachrichtigungen sind auf diesem Gerät an.');
      weg();
    } }, ['Ja, gern']);

    karte.appendChild(el('div', { class: 'vorfrage__knoepfe' }, [
      ja,
      el('button', { class: 'btn btn--ghost btn--small', onclick: weg }, ['Nein danke'])
    ]));
    return karte;
  };

  PS.push = push;
})(typeof globalThis !== 'undefined' ? globalThis : this);
