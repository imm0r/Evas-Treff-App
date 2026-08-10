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

/*
 * JEDE Funktion der Datenschicht einmal aufrufen, nicht eine gepflegte Liste.
 *
 * Vorher stand hier eine Aufzählung, und die veraltete beim ersten neuen Modul
 * still: die Rezepte waren geschrieben, geprüft wurde weiter das, was vorher
 * da war. Eine Liste, die man pflegen muss, bestätigt irgendwann nur noch sich
 * selbst.
 *
 * Alles aufzurufen ist gefahrlos, weil die Schreibwege des Sandkastens
 * Attrappen sind — nur `select` geht wirklich hinaus. Die Argumente sind
 * erfunden und dürfen falsch sein: geprüft wird die FORM der Abfrage, nicht
 * ihr Ergebnis. Was daran scheitert, hat seine Abfrage vorher schon
 * mitgeschrieben.
 */
/*
 * Ein Argument, das gleichzeitig eine ID und ein Objekt ist.
 *
 * Die Datenschicht nimmt an derselben ersten Stelle mal eine ID
 * (`photos(albumId)`) und mal ein ganzes Ding (`removeRecipe(rezept)`). Ein
 * String-Objekt ist beides: es fügt sich als UUID in eine Abfrage ein und hat
 * trotzdem `.id`, `.slug` und `.photos`. Ohne den Kniff müsste hier wieder
 * eine Liste pro Funktion stehen — genau das, was gerade abgeschafft wurde.
 */
const anything = Object.assign(new String(UUID), { id: UUID, slug: UUID, photos: [] });
const args = [anything, anything, anything];

for (const name of Object.keys(PS.data).sort()) {
  if (typeof PS.data[name] !== 'function') continue;
  try {
    await PS.data[name](...args);
  } catch (error) {
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

  /*
   * Aussetzer nochmal versuchen, Absagen nicht.
   *
   * Eine kaputte Abfrage bekommt 300 oder 400, und das kommt beim zweiten Mal
   * genauso zurück — die zu wiederholen verschleiert nur den Befund. Ein
   * abgebrochenes Netz oder eine 5xx sagt dagegen nichts über die Abfrage aus,
   * und weil das hier in CI hängt, würde ein einzelner Aussetzer einen völlig
   * gesunden PR rot färben. Genau das ist beim Bauen einmal passiert: ein Lauf
   * durchgefallen, die drei danach grün.
   */
  let status = 0;
  let body = '';
  for (let versuch = 0; versuch < 3; versuch++) {
    if (versuch) await new Promise((r) => setTimeout(r, 400 * versuch));
    try {
      const response = await fetch(url, { headers: { apikey: KEY } });
      status = response.status;
      body = await response.text();
    } catch (error) {
      status = 0;
      body = 'nicht erreichbar: ' + error.message;
    }
    if (status && status < 500 && status !== 429) break;
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
