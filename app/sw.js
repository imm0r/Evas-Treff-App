/*
 * Der Service Worker — nur für Benachrichtigungen.
 *
 * Er hält NICHTS im Zwischenspeicher, und das ist eine bewusste Entscheidung.
 * Ein Service Worker, der Dateien vorhält, beantwortet Anfragen aus seinem
 * eigenen Bestand und liefert dann auch dann noch die alte Fassung aus, wenn
 * längst eine neue veröffentlicht ist — nicht einmal ein harter Neuladen kommt
 * daran vorbei. Genau diese Verwirrung gab es hier schon einmal, als ein
 * Deploy noch lief; sie sich dauerhaft einzubauen wäre der falsche Preis für
 * einen etwas schnelleren Start.
 *
 * Er existiert also aus genau einem Grund: ohne ihn kann der Browser keine
 * Push-Nachricht entgegennehmen, wenn die Seite geschlossen ist.
 */

self.addEventListener('install', function () {
  // Sofort übernehmen, statt auf das Schließen aller alten Tabs zu warten.
  self.skipWaiting();
});

self.addEventListener('activate', function (event) {
  event.waitUntil(self.clients.claim());
});

self.addEventListener('push', function (event) {
  /*
   * Auch ohne lesbaren Inhalt etwas anzeigen.
   *
   * Wenn die Nachricht nicht entschlüsselt werden kann oder leer ankommt, darf
   * NICHTS passieren zu können nicht die Folge sein: Chrome zeigt sonst von
   * sich aus „Diese Website wurde im Hintergrund aktualisiert" — eine Meldung,
   * die niemand versteht und die von uns zu kommen scheint.
   */
  var daten = { titel: 'Evas Treff', text: 'Es gibt etwas Neues.', ziel: 'neues.html' };
  try {
    if (event.data) {
      var roh = event.data.json();
      if (roh.titel) daten.titel = roh.titel;
      if (roh.text) daten.text = roh.text;
      if (roh.ziel) daten.ziel = roh.ziel;
    }
  } catch (error) { /* bei der Voreinstellung bleiben */ }

  event.waitUntil(self.registration.showNotification(daten.titel, {
    body: daten.text,
    icon: 'icon.svg',
    badge: 'icon.svg',
    // Derselbe Kennzeichner für alle: zwei Mitteilungen kurz hintereinander
    // ersetzen einander, statt sich zu stapeln. Auf dem Sperrbildschirm einer
    // Oma sind fünf Zeilen derselben App keine Information, sondern Krach.
    tag: 'evas-treff',
    renotify: true,
    data: { ziel: daten.ziel }
  }));
});

self.addEventListener('notificationclick', function (event) {
  event.notification.close();
  var ziel = new URL((event.notification.data && event.notification.data.ziel) || 'neues.html',
    self.registration.scope).href;

  /*
   * Ein schon offener Tab wird nach vorn geholt, statt einen zweiten zu
   * öffnen. Wer die App auf dem Telefon offen hat, will keinen zweiten
   * Fensterstapel — er will das, worauf er getippt hat.
   */
  event.waitUntil(self.clients.matchAll({ type: 'window', includeUncontrolled: true })
    .then(function (fenster) {
      for (var i = 0; i < fenster.length; i++) {
        if (fenster[i].url.indexOf(self.registration.scope) === 0 && 'focus' in fenster[i]) {
          return fenster[i].navigate ? fenster[i].navigate(ziel).then(function (c) { return c.focus(); })
            : fenster[i].focus();
        }
      }
      return self.clients.openWindow(ziel);
    }));
});
