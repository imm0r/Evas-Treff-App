/*
 * Rechnet das Beispiel aus RFC 8291 nach.
 *
 * Die Verschlüsselung für Web Push ist selbst geschrieben, und selbst
 * geschriebene Kryptographie glaubt man sich nicht. Die RFC liefert in
 * Abschnitt 5 ein vollständiges Beispiel: feste Schlüssel, festes Salz, ein
 * fester Klartext — und den exakt erwarteten Nachrichtenkörper. Wenn dieselben
 * Eingaben hier dasselbe Ergebnis liefern, stimmt jeder Schritt: die
 * ECDH-Ableitung, beide HKDF-Runden, der Kopf nach RFC 8188 und AES-128-GCM.
 *
 * Eine echte Push-Nachricht an ein echtes Telefon lässt sich von hier aus
 * nicht schicken. Das ist der Ersatz, und zwar ein strengerer als ein
 * Rauchtest: er prüft nicht, DASS etwas herauskommt, sondern dass genau das
 * Richtige herauskommt.
 *
 * Aufruf: node supabase/functions/push/webpush.test.js
 */
import { encrypt, importSender, b64urlToBytes, bytesToB64url } from './webpush.js';

// Alle Werte wörtlich aus RFC 8291, Abschnitt 5 und Anhang A.
const KLARTEXT = 'When I grow up, I want to be a watermelon';
const AS_PRIVATE = 'yfWPiYE-n46HLnH0KqZOF1fJJU3MYrct3AELtAQ-oRw';
const AS_PUBLIC = 'BP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A8';
const UA_PUBLIC = 'BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4';
const AUTH_SECRET = 'BTBZMqHH6r4Tts7J_aSIgg';
const SALT = 'DGv6ra1nlYgDCS1FRnbzlw';

const ERWARTET =
  'DGv6ra1nlYgDCS1FRnbzlwAAEABBBP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27ml' +
  'mlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A_yl95bQpu6cVPT' +
  'pK4Mqgkf1CXztLVBSt2Ks3oZwbuwXPXLWyouBWLVWGNWQexSgSxsj_Qulcy4a-fN';

let schlecht = 0;
function pruefe(was, bedingung, detail) {
  console.log((bedingung ? 'ok    ' : 'FAIL  ') + was);
  if (!bedingung) { schlecht++; if (detail) console.log('      ' + detail); }
}

const sender = await importSender(AS_PRIVATE, AS_PUBLIC);
pruefe('der feste Absenderschlüssel lädt und passt zum öffentlichen Teil',
  bytesToB64url(sender.publicKey) === AS_PUBLIC, bytesToB64url(sender.publicKey));

const body = await encrypt(
  new TextEncoder().encode(KLARTEXT), UA_PUBLIC, AUTH_SECRET,
  { salt: b64urlToBytes(SALT), sender: sender });

const bekommen = bytesToB64url(body);
pruefe('der Nachrichtenkörper ist Byte für Byte der aus RFC 8291 §5',
  bekommen === ERWARTET, 'bekommen: ' + bekommen + '\n      erwartet:  ' + ERWARTET);
/*
 * 144, nicht 145.
 *
 * Im Beispiel der RFC steht „Content-Length: 145", der abgedruckte
 * Nachrichtenkörper ist aber 144 Byte lang — und mit dem stimmt das Ergebnis
 * oben Byte für Byte überein. Das ist kein Fehler hier, sondern Errata 5230,
 * gemeldet vom Autor der RFC selbst zwei Monate nach Erscheinen.
 *
 * Nachgesehen statt weggelassen: eine Prüfung, die man streicht, weil sie
 * unbequem ist, hätte auch einen echten Fehler verschwinden lassen.
 */
pruefe('und ist 144 Byte lang (RFC 8291 Errata 5230 — im Text steht 145)',
  body.length === 144, String(body.length));

// Ohne festes Salz muss jede Nachricht anders aussehen — sonst wäre der
// Zufall keiner, und zwei gleiche Texte ergäben zweimal denselben Geheimtext.
const a = bytesToB64url(await encrypt(new TextEncoder().encode('hallo'), UA_PUBLIC, AUTH_SECRET));
const b = bytesToB64url(await encrypt(new TextEncoder().encode('hallo'), UA_PUBLIC, AUTH_SECRET));
pruefe('zweimal derselbe Text ergibt zwei verschiedene Geheimtexte', a !== b);

console.log('');
console.log(schlecht ? schlecht + ' Prüfung(en) fehlgeschlagen' : 'Die Verschlüsselung stimmt mit der RFC überein.');
process.exit(schlecht ? 1 : 0);
