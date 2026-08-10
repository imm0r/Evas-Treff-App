/*
 * Fragt der App ihre eigenen Abfragen ab — gegen das echte Supabase.
 *
 * Der Grund für diese Datei ist ein Fehler, der bis auf den Bildschirm der
 * Familie durchkam: die Kalenderabfrage bat um `profiles(...)` an `events`,
 * und PostgREST antwortete mit PGRST201, weil es ZWEI Wege zwischen den
 * beiden Tabellen gibt — `events.created_by` direkt, und über `event_replies`
 * noch einmal. Ein Fremdschlüsselname (`profiles!events_created_by_fkey`)
 * löst das auf.
 *
 * Warum die e2e-Tests das nicht gefunden haben: dort steht ein Stub, der auf
 * `/rest/v1/events` fertiges JSON zurückgibt. Er liest den `select` gar nicht,
 * also kann er auch nicht wissen, ob PostgREST ihn beantworten könnte. Ein
 * Stub bestätigt immer nur, was man ihm beigebracht hat.
 *
 * Hier wird deshalb das echte Gegenüber gefragt. Ohne Anmeldung: Row Level
 * Security liefert dann überall `[]`, aber der Bauplan der Abfrage wird
 * VORHER geprüft — ein kaputtes `select` antwortet mit 300 oder 400, ein
 * gültiges mit 200 und einer leeren Liste. Genau die Unterscheidung, die
 * gefehlt hat, und keine Zeile echter Familiendaten dafür nötig.
 *
 * Die Abfragen werden nicht abgeschrieben, sondern `app/js/data.js` wird
 * ausgeführt — mit einem PS, das jedes `select` mitschreibt statt es zu
 * schicken. Eine abgeschriebene Liste wäre nach dem zweiten Modul veraltet
 * und würde dann das Falsche bestätigen.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import vm from 'node:vm';

const here = path.dirname(fileURLToPath(import.meta.url));
const app = path.join(here, '..', 'app');

// Beide Werte stehen öffentlich im Repo: ohne Sitzung geben sie nichts her.
const config = readFileSync(path.join(app, 'supabase.js'), 'utf8');
const URL_BASE = /url:\s*'([^']+)'/.exec(config)[1];
const KEY = /key:\s*'([^']+)'/.exec(config)[1];

const UUID = '00000000-0000-0000-0000-000000000000';

const asked = [];

/**
 * Ein PS, das sich wie das echte verhält, aber nichts verschickt.
 *
 * Die Schreibwege sind mit Absicht Attrappen: dieses Werkzeug liest, und ein
 * Prüflauf darf nichts in der Familiendatenbank hinterlassen.
 */
function makeSandbox() {
  const PS = {
    sb: {
      // Eine Zeile, nicht keine: mit `[]` wird jeder Zweig hinter „wenn es
      // Treffer gibt" nie betreten, und genau dort steht oft die zweite
      // Abfrage. Der Inhalt ist egal — mitgeschrieben wird die Frage.
      select: async (table, query) => { asked.push({ table, query }); return [{}]; },
      insert: async () => [{}],
      patch: async () => undefined,
      remove: async () => undefined,
      signPaths: async () => ({}),
      upload: async () => undefined,
      removeFiles: async () => undefined,
      user: () => ({ id: UUID }),
      loadUser: async () => ({ id: UUID })
    }
  };
  const sandbox = { PS, window: {}, console };
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(readFileSync(path.join(app, 'js', 'data.js'), 'utf8'), sandbox,
    { filename: 'data.js' });
  return sandbox.PS;
}

const PS = makeSandbox();

// Jede lesende Funktion einmal aufrufen. Die Argumente sind erfunden; geprüft
// wird die FORM der Abfrage, nicht das Ergebnis.
const CALLS = [
  ['albums', () => PS.data.albums()],
  ['photos', () => PS.data.photos(UUID)],
  ['knownHashes', () => PS.data.knownHashes(UUID)],
  ['posts', () => PS.data.posts()],
  ['people', () => PS.data.people()],
  ['me', () => PS.data.me()],
  ['linkMe', () => PS.data.linkMe('Ines')],
  ['invites', () => PS.data.invites()],
  ['invite', () => PS.data.invite('wer@example.de', 'Ines', false)],
  ['calendar', () => PS.data.calendar()],
  ['roster', () => PS.data.roster()]
];

for (const [name, run] of CALLS) {
  try {
    await run();
  } catch (error) {
    // Eine Attrappe, die zu wenig zurückgibt, ist kein Befund über die
    // Abfragen — die bereits mitgeschriebenen zählen trotzdem.
    if (process.env.VERBOSE) console.error(name + ': ' + error.message);
  }
}

if (!asked.length) {
  console.error('Keine einzige Abfrage gefunden — data.js hat sich geändert.');
  process.exit(1);
}

let failed = 0;
const seen = new Set();

for (const { table, query } of asked) {
  const key = table + '?' + query;
  if (seen.has(key)) continue;
  seen.add(key);

  // Eine Zeile reicht, um den Bauplan zu prüfen, und ohne Sitzung kommt
  // ohnehin keine.
  const url = URL_BASE + '/rest/v1/' + table + '?' + query + '&limit=1';
  let status = 0;
  let body = '';
  try {
    const response = await fetch(url, { headers: { apikey: KEY } });
    status = response.status;
    body = await response.text();
  } catch (error) {
    console.log('FEHLER ' + table + ' — nicht erreichbar: ' + error.message);
    failed++;
    continue;
  }

  if (status === 200) {
    console.log('ok    ' + table + '  ' + query.slice(0, 76));
  } else {
    failed++;
    console.log('FEHLT ' + table + '  ' + query);
    console.log('      ' + status + ': ' + body.slice(0, 400));
  }
}

console.log('');
console.log(failed
  ? failed + ' von ' + seen.size + ' Abfragen beantwortet Supabase nicht'
  : seen.size + ' Abfragen, alle beantwortbar');
process.exit(failed ? 1 : 0);
