/*
 * Web Push von Hand: Verschlüsselung nach RFC 8291 und VAPID nach RFC 8292.
 *
 * Warum selbst geschrieben und nicht `npm:web-push`: die Bibliothek ließe sich
 * hier nicht prüfen. Eine Push-Nachricht kann man von diesem Rechner aus nicht
 * an ein echtes Telefon schicken — es gäbe also keinen Beweis, dass das Ding
 * im Betrieb tut, was es soll, nur die Hoffnung.
 *
 * Selbst geschrieben gibt es diesen Beweis: RFC 8291 enthält in Abschnitt 5
 * ein vollständiges Beispiel mit festen Schlüsseln, festem Salz und dem exakt
 * erwarteten Ergebnis. `webpush.test.js` rechnet genau dieses Beispiel nach.
 * Stimmt ein Bit nicht, fällt der Test durch. Das ist mehr Sicherheit, als
 * eine ungetestete Abhängigkeit geben könnte — und es kommt ohne aus, was zu
 * diesem Projekt passt.
 *
 * Reines WebCrypto, damit derselbe Code in Deno (im Betrieb) und in Node (beim
 * Prüfen) läuft.
 */

const enc = new TextEncoder();

export function b64urlToBytes(text) {
  const norm = String(text).replace(/-/g, '+').replace(/_/g, '/').replace(/\s+/g, '');
  const padded = norm + '='.repeat((4 - (norm.length % 4)) % 4);
  const raw = atob(padded);
  const out = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
  return out;
}

export function bytesToB64url(bytes) {
  let raw = '';
  for (let i = 0; i < bytes.length; i++) raw += String.fromCharCode(bytes[i]);
  return btoa(raw).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function join(...teile) {
  const gesamt = teile.reduce((n, t) => n + t.length, 0);
  const out = new Uint8Array(gesamt);
  let at = 0;
  for (const t of teile) { out.set(t, at); at += t.length; }
  return out;
}

async function hmac(keyBytes, data) {
  const key = await crypto.subtle.importKey(
    'raw', keyBytes, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return new Uint8Array(await crypto.subtle.sign('HMAC', key, data));
}

/*
 * HKDF in einem Block.
 *
 * Alle hier gebrauchten Ausgaben sind höchstens 32 Byte lang, also reicht die
 * erste Runde von HKDF-Expand: HMAC(PRK, info || 0x01). Genau so steht die
 * Rechnung auch in RFC 8291, Abschnitt 3.4, ausgeschrieben.
 */
async function hkdf(salt, ikm, info, laenge) {
  const prk = await hmac(salt, ikm);
  const okm = await hmac(prk, join(info, new Uint8Array([1])));
  return okm.slice(0, laenge);
}

/** Ein frisches P-256-Schlüsselpaar, wie es der Absender je Nachricht braucht. */
async function ephemeral() {
  const pair = await crypto.subtle.generateKey(
    { name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']);
  const pub = new Uint8Array(await crypto.subtle.exportKey('raw', pair.publicKey));
  return { privateKey: pair.privateKey, publicKey: pub };
}

/** Einen festen Absenderschlüssel laden — für die Prüfung gegen die RFC. */
export async function importSender(privateB64url, publicB64url) {
  const pub = b64urlToBytes(publicB64url);
  const privateKey = await crypto.subtle.importKey('jwk', {
    kty: 'EC', crv: 'P-256',
    d: privateB64url.replace(/=+$/, ''),
    x: bytesToB64url(pub.slice(1, 33)),
    y: bytesToB64url(pub.slice(33, 65)),
    ext: true
  }, { name: 'ECDH', namedCurve: 'P-256' }, false, ['deriveBits']);
  return { privateKey: privateKey, publicKey: pub };
}

/**
 * Den Nachrichtenkörper verschlüsseln.
 *
 * Ergebnis ist genau das, was als Rumpf der POST-Anfrage an den Push-Dienst
 * geht: Kopf nach RFC 8188 (Salz, Datensatzgröße, Absenderschlüssel) und
 * dahinter der mit AES-128-GCM verschlüsselte Text.
 */
export async function encrypt(klartext, uaPublicB64url, authSecretB64url, opts) {
  const uaPublic = b64urlToBytes(uaPublicB64url);
  const authSecret = b64urlToBytes(authSecretB64url);
  const salt = (opts && opts.salt) || crypto.getRandomValues(new Uint8Array(16));
  const sender = (opts && opts.sender) || await ephemeral();

  const uaKey = await crypto.subtle.importKey(
    'raw', uaPublic, { name: 'ECDH', namedCurve: 'P-256' }, false, []);
  const ecdhSecret = new Uint8Array(await crypto.subtle.deriveBits(
    { name: 'ECDH', public: uaKey }, sender.privateKey, 256));

  // key_info = "WebPush: info" || 0x00 || ua_public || as_public   (RFC 8291 §3.3)
  const keyInfo = join(enc.encode('WebPush: info'), new Uint8Array([0]), uaPublic, sender.publicKey);
  const ikm = await hkdf(authSecret, ecdhSecret, keyInfo, 32);

  const cek = await hkdf(salt, ikm,
    join(enc.encode('Content-Encoding: aes128gcm'), new Uint8Array([0])), 16);
  const nonce = await hkdf(salt, ikm,
    join(enc.encode('Content-Encoding: nonce'), new Uint8Array([0])), 12);

  // Ein einziger Datensatz, also bekommt der Klartext den Abschluss 0x02.
  const mitEnde = join(klartext, new Uint8Array([2]));
  const aes = await crypto.subtle.importKey('raw', cek, { name: 'AES-GCM' }, false, ['encrypt']);
  const geheim = new Uint8Array(await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv: nonce, tagLength: 128 }, aes, mitEnde));

  // Kopf: Salz(16) | Datensatzgröße(4) | Länge des Schlüssels(1) | Schlüssel(65)
  const rs = new Uint8Array(4);
  new DataView(rs.buffer).setUint32(0, 4096);
  return join(salt, rs, new Uint8Array([sender.publicKey.length]), sender.publicKey, geheim);
}

/**
 * Der VAPID-Kopf, mit dem sich der Absender ausweist (RFC 8292).
 *
 * Ohne ihn nimmt kein Push-Dienst die Nachricht an. `subject` muss eine
 * mailto:- oder https:-Adresse sein, unter der man den Absender erreicht —
 * daran hängt sich der Dienst, wenn etwas schiefgeht.
 */
export async function vapidHeaders(endpoint, subject, vapid, jetzt) {
  const aud = new URL(endpoint).origin;
  const kopf = { typ: 'JWT', alg: 'ES256' };
  const nutz = {
    aud: aud,
    exp: Math.floor((jetzt || Date.now()) / 1000) + 12 * 60 * 60,
    sub: subject
  };
  const teil = bytesToB64url(enc.encode(JSON.stringify(kopf))) + '.' +
    bytesToB64url(enc.encode(JSON.stringify(nutz)));

  const pub = b64urlToBytes(vapid.publicKey);
  const key = await crypto.subtle.importKey('jwk', {
    kty: 'EC', crv: 'P-256',
    d: vapid.privateKey.replace(/=+$/, ''),
    x: bytesToB64url(pub.slice(1, 33)),
    y: bytesToB64url(pub.slice(33, 65)),
    ext: true
  }, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign']);

  const sig = new Uint8Array(await crypto.subtle.sign(
    { name: 'ECDSA', hash: 'SHA-256' }, key, enc.encode(teil)));

  return {
    Authorization: 'vapid t=' + teil + '.' + bytesToB64url(sig) + ', k=' + vapid.publicKey,
    'Content-Encoding': 'aes128gcm',
    'Content-Type': 'application/octet-stream'
  };
}

/**
 * Eine Nachricht an ein Gerät schicken.
 *
 * Gibt zurück, was der Push-Dienst geantwortet hat. 404 und 410 heißen: dieses
 * Gerät gibt es nicht mehr — der Aufrufer soll die Anmeldung wegwerfen, sonst
 * schleppt die Familie ewig tote Telefone mit.
 */
export async function send(subscription, klartext, vapid, subject, ttl) {
  const body = await encrypt(klartext, subscription.p256dh, subscription.auth);
  const headers = await vapidHeaders(subscription.endpoint, subject, vapid);
  headers.TTL = String(ttl === undefined ? 60 * 60 * 24 : ttl);
  // „normal" statt „high": eine Familienmitteilung ist nichts, wofür ein
  // Telefon aus dem Tiefschlaf geholt werden muss.
  headers.Urgency = 'normal';

  const antwort = await fetch(subscription.endpoint, { method: 'POST', headers: headers, body: body });
  return { status: antwort.status, gone: antwort.status === 404 || antwort.status === 410 };
}
