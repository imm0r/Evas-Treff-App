/*
 * Verschickt eine Mitteilung an alle Geräte, die welche haben wollen.
 *
 * Geweckt wird sie von einem Datenbank-Trigger, sobald eine Mitteilung
 * entsteht. Der Trigger schickt die neue Zeile mit; die Funktion holt die
 * Geräte, verschlüsselt für jedes einzeln und räumt dabei auf.
 *
 * Sie arbeitet mit dem DIENSTSCHLÜSSEL, sieht also alle Anmeldungen. Das ist
 * nötig — die Sichtbarkeitsregel an `push_subscriptions` lässt jeden nur seine
 * eigenen sehen, und wer eine Mitteilung schreibt, soll die Geräte der anderen
 * ja gerade nicht kennen.
 *
 * Aufgerufen werden darf sie deshalb nur mit einem Geheimnis, nicht von jedem,
 * der die Adresse kennt: sonst könnte ein Fremder der ganzen Familie
 * Benachrichtigungen schicken.
 */
import { send } from './webpush.js';

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!;
const SERVICE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
const VAPID_PUBLIC = Deno.env.get('VAPID_PUBLIC_KEY')!;
const VAPID_PRIVATE = Deno.env.get('VAPID_PRIVATE_KEY')!;
const HOOK_SECRET = Deno.env.get('PUSH_HOOK_SECRET');
// Wen der Push-Dienst anschreibt, wenn etwas dauerhaft schiefgeht.
const SUBJECT = Deno.env.get('VAPID_SUBJECT') || 'mailto:gdthsupp0rt@gmail.com';

async function rest(pfad: string, init: RequestInit = {}) {
  return fetch(SUPABASE_URL + '/rest/v1/' + pfad, {
    ...init,
    headers: {
      apikey: SERVICE_KEY,
      Authorization: 'Bearer ' + SERVICE_KEY,
      'Content-Type': 'application/json',
      ...(init.headers || {})
    }
  });
}

/** Aus dem Fließtext eine Zeile machen, die auf einen Sperrbildschirm passt. */
function kurz(text: string, max: number) {
  const eine = String(text || '').replace(/\s+/g, ' ').trim();
  return eine.length > max ? eine.slice(0, max - 1) + '…' : eine;
}

Deno.serve(async (req) => {
  /*
   * Zwei verschiedene Gründe für dieselbe Abfuhr — und der Unterschied kostet
   * sonst eine Stunde.
   *
   * Ist das Geheimnis gar nicht hinterlegt, lehnt die Funktion JEDEN Aufruf ab,
   * auch den richtigen. Von außen sieht das aus wie ein falscher Wert, ist aber
   * eine leere Einstellung. Der Text sagt deshalb, welcher der beiden Fälle
   * vorliegt. Verraten wird damit nichts: dass etwas eingerichtet ist, hilft
   * niemandem beim Raten, WAS.
   */
  if (!HOOK_SECRET) {
    return new Response('PUSH_HOOK_SECRET ist nicht gesetzt', { status: 401 });
  }
  if (req.headers.get('x-push-secret') !== HOOK_SECRET) {
    return new Response('nein', { status: 401 });
  }

  let record: { id?: string; body?: string; created_by?: string } = {};
  try {
    const payload = await req.json();
    record = payload.record || payload;
  } catch {
    return new Response('kein JSON', { status: 400 });
  }
  if (!record.body) return new Response('nichts zu senden', { status: 400 });

  // Wer die Mitteilung geschrieben hat, bekommt keine Benachrichtigung dafür.
  const filter = record.created_by ? '&profile_id=neq.' + record.created_by : '';
  const geraete = await (await rest(
    'push_subscriptions?select=id,endpoint,p256dh,auth' + filter)).json();

  const nachricht = JSON.stringify({
    titel: 'Neues von der Familie',
    text: kurz(record.body, 160),
    ziel: 'neues.html'
  });

  const vapid = { publicKey: VAPID_PUBLIC, privateKey: VAPID_PRIVATE };
  const klartext = new TextEncoder().encode(nachricht);

  const angekommen: string[] = [];
  const tot: string[] = [];
  const fehler: string[] = [];

  await Promise.all(geraete.map(async (g: any) => {
    try {
      const antwort = await send(
        { endpoint: g.endpoint, p256dh: g.p256dh, auth: g.auth },
        klartext, vapid, SUBJECT);
      if (antwort.gone) tot.push(g.id);
      else if (antwort.status >= 200 && antwort.status < 300) angekommen.push(g.id);
      else fehler.push(g.id + ':' + antwort.status);
    } catch (error) {
      fehler.push(g.id + ':' + String(error));
    }
  }));

  /*
   * Tote Anmeldungen wegräumen.
   *
   * 404 und 410 heißen: dieses Gerät gibt es nicht mehr. Behielte man sie,
   * würde die Familie ewig Telefone mitschleppen, die längst neu aufgesetzt
   * wurden — und jeder Versand dauerte länger als nötig.
   */
  if (tot.length) {
    await rest('push_subscriptions?id=in.(' + tot.join(',') + ')', { method: 'DELETE' });
  }
  /*
   * Nur die vermerken, bei denen es GEKLAPPT hat.
   *
   * Hier stand einmal ein Filter über alle Zeilen — damit hätte auch ein Gerät
   * ein frisches „zuletzt erreicht" bekommen, das gerade abgelehnt hat. Genau
   * die Spalte, an der man später sieht, wer nichts mehr bekommt, hätte dann
   * gelogen.
   */
  if (angekommen.length) {
    await rest('push_subscriptions?id=in.(' + angekommen.join(',') + ')', {
      method: 'PATCH',
      headers: { Prefer: 'return=minimal' },
      body: JSON.stringify({ last_sent_at: new Date().toISOString() })
    });
  }

  return new Response(JSON.stringify({
    geraete: geraete.length,
    zugestellt: angekommen.length,
    aufgeraeumt: tot.length,
    fehler
  }), { headers: { 'Content-Type': 'application/json' } });
});
