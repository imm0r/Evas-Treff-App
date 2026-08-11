/*
 * The Supabase-backed app, driven in a real browser against a stubbed
 * Supabase: PostgREST, Storage signing and Auth, all faked locally.
 *
 * Signing in for real needs a mailbox, which a test harness has no business
 * having — so the magic link is simulated the way the browser sees it, as a
 * fragment full of tokens. Everything after that is the real client code.
 *
 * Usage: node tools/e2e-supabase.mjs
 */
import { createServer } from 'node:http';
import { readFile, writeFile, mkdtemp } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import os from 'node:os';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

function loadPlaywright() {
  for (const base of [import.meta.url, '/opt/node22/lib/node_modules/']) {
    try { return createRequire(base)('playwright'); } catch { /* next */ }
  }
  throw new Error('playwright fehlt: npm install && npx playwright install chromium');
}
const { chromium } = loadPlaywright();

const APP = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../app');
const TYPES = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml',
  '.webmanifest': 'application/manifest+json', '.jpg': 'image/jpeg', '.wasm': 'application/wasm'
};

const checks = [];
function check(name, ok, detail) {
  checks.push({ name, ok: !!ok });
  console.log(`${ok ? 'ok  ' : 'FAIL'}  ${name}${ok || !detail ? '' : `\n        ${detail}`}`);
}

/*
 * SHOTS=<dir> also writes a picture of each screen.
 *
 * Assertions keep missing what a look would catch straight away: an avatar
 * painted over the text under it, a crop that framed the wrong face. Cheap to
 * leave in, and the only way some of those bugs were ever found.
 */
const SHOTS = process.env.SHOTS || '';
async function shot(page, name) {
  if (!SHOTS) return;
  await page.screenshot({ path: path.join(SHOTS, name + '.png'), fullPage: true });
}

// --- a local stand-in for both the app host and Supabase -------------------

const images = new Map();          // "signed" object path -> jpeg bytes
const server = createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  if (url.pathname.startsWith('/signed/')) {
    const body = images.get(decodeURIComponent(url.pathname.slice('/signed/'.length)));
    if (!body) { res.writeHead(404).end(); return; }
    res.writeHead(200, { 'Content-Type': 'image/jpeg' });
    res.end(body);
    return;
  }
  const file = path.join(APP, url.pathname === '/' ? '/index.html' : url.pathname);
  if (!file.startsWith(APP)) { res.writeHead(403).end(); return; }
  try {
    res.writeHead(200, { 'Content-Type': TYPES[path.extname(file)] || 'application/octet-stream' });
    res.end(await readFile(file));
  } catch { res.writeHead(404).end(); }
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const origin = `http://127.0.0.1:${server.address().port}`;
const SB = 'https://xpkkezwrmqgwgenpqvhq.supabase.co';

const browser = await chromium.launch();

async function makeJpeg(page, w, h, hue, label) {
  return Buffer.from(await page.evaluate(async ([w, h, hue, label]) => {
    const c = document.createElement('canvas');
    c.width = w; c.height = h;
    const x = c.getContext('2d');
    x.fillStyle = `hsl(${hue},55%,45%)`; x.fillRect(0, 0, w, h);
    x.fillStyle = '#fff'; x.font = `${Math.round(h / 6)}px serif`; x.textAlign = 'center';
    x.fillText(label, w / 2, h / 2);
    const b = await new Promise((r) => c.toBlob(r, 'image/jpeg', 0.9));
    return Array.from(new Uint8Array(await b.arrayBuffer()));
  }, [w, h, hue, label]));
}

/*
 * Ein ECHTES Video, im Browser aufgenommen.
 *
 * Kein erfundener Blob mit einem Videonamen: die ganze Kette hängt daran, dass
 * der Browser die Datei wirklich dekodiert — Maße, Dauer, Standbild. Ein
 * Attrappen-Blob würde genau den Teil überspringen, der schiefgehen kann.
 */
async function makeWebm(page, w, h, hue, ms) {
  return Buffer.from(await page.evaluate(async ([w, h, hue, ms]) => {
    const c = document.createElement('canvas');
    c.width = w; c.height = h;
    const x = c.getContext('2d');
    const stream = c.captureStream(25);
    const chunks = [];
    const rec = new MediaRecorder(stream, { mimeType: 'video/webm' });
    rec.ondataavailable = (e) => { if (e.data.size) chunks.push(e.data); };
    const done = new Promise((r) => { rec.onstop = r; });
    rec.start();

    // Etwas Bewegung, damit es nicht ein einziges Standbild ist — und eine
    // kräftige Farbe, an der sich später prüfen lässt, ob das Vorschaubild
    // wirklich aus dem Video kommt und nicht schwarz ist.
    const started = performance.now();
    await new Promise((resolve) => {
      (function frame() {
        const t = performance.now() - started;
        x.fillStyle = `hsl(${hue},90%,50%)`;
        x.fillRect(0, 0, w, h);
        x.fillStyle = '#000';
        x.fillRect((t / ms) * w, h / 3, w / 8, h / 3);
        if (t < ms) requestAnimationFrame(frame); else resolve();
      })();
    });

    rec.stop();
    await done;
    const blob = new Blob(chunks, { type: 'video/webm' });
    return Array.from(new Uint8Array(await blob.arrayBuffer()));
  }, [w, h, hue, ms]));
}

/** Die Farbe in der Mitte eines JPEGs — beantwortet "ist das Bild schwarz?". */
async function centrePixel(page, bytes) {
  return page.evaluate(async (data) => {
    const blob = new Blob([new Uint8Array(data)], { type: 'image/jpeg' });
    const bitmap = await createImageBitmap(blob);
    const c = document.createElement('canvas');
    c.width = bitmap.width; c.height = bitmap.height;
    c.getContext('2d').drawImage(bitmap, 0, 0);
    const p = c.getContext('2d').getImageData(Math.floor(bitmap.width / 2), 4, 1, 1).data;
    return { r: p[0], g: p[1], b: p[2], width: bitmap.width, height: bitmap.height };
  }, Array.from(bytes));
}

/** Width and height straight out of a JPEG's frame header. */
function jpegSize(bytes) {
  for (let i = 2; i + 9 < bytes.length;) {
    if (bytes[i] !== 0xff) return null;
    const marker = bytes[i + 1];
    const length = (bytes[i + 2] << 8) | bytes[i + 3];
    if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
      return { height: (bytes[i + 5] << 8) | bytes[i + 6], width: (bytes[i + 7] << 8) | bytes[i + 8] };
    }
    if (marker === 0xda) return null;
    i += 2 + length;
  }
  return null;
}

/** Everything the app is allowed to know, and a log of what it asked for. */
function makeBackend() {
  return {
    otpRequests: [], inserts: [], deletes: [], uploads: [], signCalls: 0,
    albums: [], photos: [], comments: [], people: [], board: [], invites: [],
    events: [], queries: [], reads: [], patches: [], recipes: [], recipePhotos: [],
    deletes: [],
    announcements: [],
    pushSubs: [],
    // Voreinstellung: gar nichts Neues. Jeder Abschnitt setzt sich hin, was er
    // braucht — so kann kein Test versehentlich von den Daten eines anderen
    // abhängen.
    news: {
      since: '2026-08-01T00:00:00Z',
      announcements: { unread: 0, items: [] },
      photos: { count: 0, albums: [] },
      comments: { count: 0, items: [] },
      posts: { count: 0, items: [] },
      recipes: { count: 0, items: [] },
      events: { count: 0, items: [] }
    },
    profile: { id: 'user-1', email: 'ich@example.de', is_admin: true, person_id: 'p1',
      comments_seen_at: '2026-01-01T00:00:00Z', people: { name: 'Maria' } }
  };
}

async function stub(page, back) {
  await page.route(SB + '/**', async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const p = url.pathname;
    const json = (status, body) => route.fulfill({
      status, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body)
    });
    const auth = request.headers()['authorization'] || '';

    if (p === '/auth/v1/otp') {
      // Where the link comes back to is a query parameter, not a body field -
      // recorded from the URL, because that is the only place Supabase reads it.
      back.otpRequests.push(Object.assign(JSON.parse(request.postData()),
        { redirect_to: url.searchParams.get('redirect_to') }));
      return json(200, {});
    }
    // A signed URL is the whole point: it carries its own permission and is
    // fetched by the browser like any other image, without a header.
    const isSignedFetch = p.startsWith('/storage/v1/object/sign/') && request.method() === 'GET';
    // Nothing else may be reached without a token.
    if (!isSignedFetch && !auth.includes('Bearer ')) return json(401, { message: 'no session' });

    if (p === '/auth/v1/user') return json(200, { id: 'user-1', email: 'ich@example.de' });

    // Serving a signed object: whatever was signed is fetchable, once.
    if (p.startsWith('/storage/v1/object/sign/') && request.method() === 'GET') {
      const key = decodeURIComponent(p.slice('/storage/v1/object/sign/'.length).replace(/^(photos|people)\//, ''));
      const body = images.get(key);
      if (!body) return route.fulfill({ status: 404, body: '' });
      return route.fulfill({ status: 200, headers: { 'Content-Type': 'image/jpeg' }, body });
    }

    if (p === '/storage/v1/object/sign/photos' || p === '/storage/v1/object/sign/people') {
      back.signCalls++;
      const { paths } = JSON.parse(request.postData());
      const bucket = p.endsWith('/people') ? 'people' : 'photos';
      return json(200, paths.map((path) => ({
        path, signedURL: `/object/sign/${bucket}/${path}?token=stub`
      })));
    }

    if (p === '/rest/v1/albums' && request.method() === 'GET') return json(200, back.albums);
    if (p === '/rest/v1/albums' && request.method() === 'POST') {
      const row = JSON.parse(request.postData());
      back.inserts.push({ table: 'albums', row });
      const saved = Object.assign({ id: 'alb-' + (back.albums.length + 1), photos: [{ count: 0 }] }, row);
      back.albums.push(saved);
      return json(201, [saved]);
    }
    if (p === '/rest/v1/albums' && request.method() === 'PATCH') {
      const row = JSON.parse(request.postData());
      back.patches.push({ table: 'albums', row, query: url.search });
      return json(204, {});
    }
    // Der Lesestand: RLS lässt nur die eigenen Zeilen durch, das bildet der
    // Stub nach — sonst prüfte der Test eine Sicht, die es nicht gibt.
    if (p === '/rest/v1/comment_reads' && request.method() === 'GET') {
      return json(200, back.reads.filter((r) => r.profile_id === back.profile.id)
        .map((r) => ({ photo_id: r.photo_id, seen_at: r.seen_at })));
    }
    if (p === '/rest/v1/comment_reads' && request.method() === 'POST') {
      const row = JSON.parse(request.postData());
      back.inserts.push({ table: 'comment_reads', row, query: url.search });
      const old = back.reads.find((r) =>
        r.profile_id === row.profile_id && r.photo_id === row.photo_id);
      if (old) old.seen_at = row.seen_at; else back.reads.push(row);
      return json(201, [row]);
    }
    // Was das Regal fragt: nur die Kommentare seit dem Boden.
    if (p === '/rest/v1/comments' && request.method() === 'GET') {
      const from = (url.searchParams.get('created_at') || '').replace('gt.', '');
      const rows = [];
      back.photos.forEach((photo) => (photo.comments || []).forEach((c) => {
        if (from && c.created_at <= from) return;
        rows.push({ photo_id: photo.id, created_at: c.created_at,
          author_id: c.author_id, photos: { album_id: photo.album_id } });
      }));
      return json(200, rows);
    }
    if (p === '/rest/v1/photos' && request.method() === 'GET') {
      if (url.searchParams.get('select') === 'album_id,thumb_path,taken_at') {
        return json(200, back.photos.map((x) => ({ album_id: x.album_id, thumb_path: x.thumb_path, taken_at: x.taken_at })));
      }
      // Ohne Album-Filter ist ALLES gemeint — so fragt die Sicherung.
      // Vorher lief das in einen Vergleich gegen den leeren String und gab
      // eine leere Liste zurück, also eine Sicherung ohne Fotos.
      if (!url.searchParams.has('album_id')) return json(200, back.photos);
      const album = (url.searchParams.get('album_id') || '').replace('eq.', '');
      return json(200, back.photos.filter((x) => x.album_id === album).map((x) =>
        Object.assign({}, x, {
          comment_reads: back.reads
            .filter((r) => r.profile_id === back.profile.id && r.photo_id === x.id)
            .map((r) => ({ seen_at: r.seen_at }))
        })));
    }
    if (p === '/rest/v1/photos' && request.method() === 'PATCH') {
      const row = JSON.parse(request.postData());
      back.patches.push({ table: 'photos', row, query: url.search });
      const id = (url.searchParams.get('id') || '').replace('eq.', '');
      const photo = back.photos.find((x) => x.id === id);
      if (photo) Object.assign(photo, row);
      return json(204, {});
    }
    if (p === '/rest/v1/photos' && request.method() === 'POST') {
      const row = JSON.parse(request.postData());
      back.inserts.push({ table: 'photos', row });
      const saved = Object.assign({ id: 'ph-' + (back.photos.length + 1), comments: [] }, row);
      back.photos.push(saved);
      return json(201, [saved]);
    }
    if (p.startsWith('/storage/v1/object/photos/') && request.method() === 'POST') {
      const key = decodeURIComponent(p.slice('/storage/v1/object/photos/'.length));
      back.uploads.push(key);
      images.set(key, request.postDataBuffer() || Buffer.alloc(0));
      return json(200, { Key: 'photos/' + key });
    }
    if (p === '/rest/v1/board_posts' && request.method() === 'GET') return json(200, back.board);
    if (p === '/rest/v1/board_posts' && request.method() === 'POST') {
      const row = JSON.parse(request.postData());
      back.inserts.push({ table: 'board_posts', row });
      const saved = Object.assign({ id: 'bp-' + (back.board.length + 1), created_at: new Date().toISOString() }, row);
      back.board.unshift(saved);
      return json(201, [saved]);
    }
    if (p === '/rest/v1/events' && request.method() === 'GET') {
      // Womit gefragt wurde, ist hier die eigentliche Prüfung: der Kalender
      // soll Vergangenes gar nicht erst holen.
      back.queries.push(url.search);
      // Genau wie die generierte Spalte in Postgres: coalesce(ends_on, starts_on).
      const from = (url.searchParams.get('over_on') || '').replace('gte.', '');
      return json(200, back.events.filter((e) =>
        !from || (e.ends_on || e.starts_on) >= from));
    }
    if (p === '/rest/v1/events' && request.method() === 'POST') {
      const row = JSON.parse(request.postData());
      back.inserts.push({ table: 'events', row });
      const saved = Object.assign({ id: 'ev-neu', event_replies: [], profiles: null }, row);
      back.events.push(saved);
      return json(201, [saved]);
    }
    if (p === '/rest/v1/event_replies' && request.method() === 'POST') {
      const row = JSON.parse(request.postData());
      back.inserts.push({ table: 'event_replies', row, query: url.search });
      return json(201, [row]);
    }
    // Auf die Methode prüfen, sonst schluckt der Lese-Zweig das PATCH: das
    // trägt ebenfalls `name=eq.…`, bekäme brav eine 200, und der Test sähe ein
    // Speichern, das nie stattgefunden hat.
    if (p === '/rest/v1/people' && request.method() === 'GET') {
      // The guest list looks a person up by name before it stores an invite.
      const wanted = (url.searchParams.get('name') || '').replace('eq.', '');
      if (wanted) {
        const hit = back.people.find((x) => x.name === decodeURIComponent(wanted));
        return json(200, hit ? [{ id: 'person-' + hit.name }] : []);
      }
      // Dieselbe Tabelle, zwei Fragen: der Kalender will nur die, bei denen ein
      // Geburtstag steht, die Familie-Seite alle — sie ist ja der Ort, an dem
      // man ihn einträgt. Der Filter unterscheidet sie, nicht das select.
      if (url.searchParams.get('birth_day') === 'not.is.null') {
        return json(200, back.people.filter((x) => x.birth_day));
      }
      return json(200, back.people);
    }
    if (p === '/rest/v1/people' && request.method() === 'PATCH') {
      const row = JSON.parse(request.postData());
      const who = decodeURIComponent((url.searchParams.get('name') || '').replace('eq.', ''));
      back.inserts.push({ table: 'people.patch', row: Object.assign({ name: who }, row) });
      const person = back.people.find((x) => x.name === who);
      if (person) Object.assign(person, row);
      return json(204, {});
    }
    if (p === '/rest/v1/recipes' && request.method() === 'GET') {
      const slug = (url.searchParams.get('slug') || '').replace('eq.', '');
      const rows = back.recipes
        .filter((r) => !slug || r.slug === decodeURIComponent(slug))
        .map((r) => Object.assign({}, r, {
          recipe_photos: back.recipePhotos.filter((x) => x.recipe_id === r.id)
        }));
      return json(200, rows);
    }
    if (p === '/rest/v1/recipes' && request.method() === 'POST') {
      const row = JSON.parse(request.postData());
      back.inserts.push({ table: 'recipes', row });
      /*
       * Eine Prüfregel, die von vorn NICHT mehr erreichbar ist, weil das
       * Formular vorher abfängt. Sie muss hier trotzdem geprüft werden: das
       * Auffangnetz ist genau für den Tag da, an dem eine Regel dazukommt, an
       * die das Formular noch nicht denkt — und dann darf da nicht wieder
       * `recipes_servings_check` auf dem Telefon stehen.
       */
      if (row.title === 'Prüfregel') {
        return json(400, { code: '23514', message:
          'new row for relation "recipes" violates check constraint "recipes_servings_check"' });
      }
      // Wie Postgres: der Slug ist eindeutig, und die zweite Zeile fliegt raus.
      if (back.recipes.some((r) => r.slug === row.slug)) {
        return json(409, { code: '23505', message:
          'duplicate key value violates unique constraint "recipes_slug_key"' });
      }
      const saved = Object.assign({ id: 'rz-' + (back.recipes.length + 1), profiles: null }, row);
      back.recipes.push(saved);
      return json(201, [saved]);
    }
    if (p === '/rest/v1/recipes' && request.method() === 'PATCH') {
      const row = JSON.parse(request.postData());
      back.patches.push({ table: 'recipes', row, query: url.search });
      const id = (url.searchParams.get('id') || '').replace('eq.', '');
      const hit = back.recipes.find((r) => r.id === id);
      if (hit) Object.assign(hit, row);
      return json(204, {});
    }
    if (p === '/rest/v1/recipe_photos' && request.method() === 'POST') {
      const row = JSON.parse(request.postData());
      back.inserts.push({ table: 'recipe_photos', row });
      const saved = Object.assign({ id: 'rp-' + (back.recipePhotos.length + 1) }, row);
      back.recipePhotos.push(saved);
      return json(201, [saved]);
    }
    if (p === '/rest/v1/recipe_photos' && request.method() === 'PATCH') {
      const row = JSON.parse(request.postData());
      back.patches.push({ table: 'recipe_photos', row, query: url.search });
      const id = (url.searchParams.get('id') || '').replace('eq.', '');
      const hit = back.recipePhotos.find((x) => x.id === id);
      if (hit) Object.assign(hit, row);
      return json(204, {});
    }
    if (p === '/rest/v1/rpc/news_for_me') {
      return json(200, back.news);
    }
    if (p === '/rest/v1/push_subscriptions' && request.method() === 'GET') {
      return json(200, back.pushSubs);
    }
    if (p === '/rest/v1/push_subscriptions' && request.method() === 'POST') {
      // Für den Fall „Ja gedrückt, aber das Speichern schlägt fehl". Ohne das
      // ließe sich nicht prüfen, dass ein Fehler die Frage NICHT verbraucht.
      if (back.failInsert === 'push_subscriptions') {
        return json(503, { message: 'kein Netz' });
      }
      const row = JSON.parse(request.postData());
      back.inserts.push({ table: 'push_subscriptions', row, prefer: request.headers()['prefer'] || '' });
      back.pushSubs.push(row);
      return json(201, [row]);
    }
    if (p === '/rest/v1/push_subscriptions' && request.method() === 'DELETE') {
      back.deletes.push({ table: 'push_subscriptions', query: url.search });
      back.pushSubs = [];
      return json(204, {});
    }
    if (p === '/rest/v1/announcements' && request.method() === 'GET') {
      return json(200, back.announcements);
    }
    if (p === '/rest/v1/announcements' && request.method() === 'POST') {
      const row = JSON.parse(request.postData());
      back.inserts.push({ table: 'announcements', row });
      return json(201, [Object.assign({ id: 'an-neu' }, row)]);
    }
    if (p === '/rest/v1/announcements' && request.method() === 'DELETE') {
      back.deletes.push({ table: 'announcements', query: url.search });
      return json(204, {});
    }
    if (p === '/rest/v1/profiles' && request.method() === 'PATCH') {
      // Vorher beantwortete dieser Zweig JEDE Methode gleich und schrieb
      // nichts mit — auch das Zuordnen zu einem Gesicht war damit nie geprüft.
      const row = JSON.parse(request.postData());
      back.patches.push({ table: 'profiles', row, query: url.search });
      Object.assign(back.profile, row);
      return json(204, {});
    }
    if (p === '/rest/v1/profiles') return json(200, [back.profile]);

    if (p === '/rest/v1/invites' && request.method() === 'GET') {
      if (!back.profile.is_admin) return json(200, []);
      return json(200, back.invites);
    }
    if (p === '/rest/v1/invites' && request.method() === 'POST') {
      if (!back.profile.is_admin) return json(403, { message: 'not admin' });
      const row = JSON.parse(request.postData());
      back.inserts.push({ table: 'invites', row });
      back.invites.push({
        email: row.email, is_admin: !!row.is_admin, person_id: row.person_id,
        invited_at: new Date().toISOString(), used_at: null,
        people: row.person_id ? { name: String(row.person_id).replace('person-', '') } : null
      });
      return json(201, [row]);
    }

    if (p === '/rest/v1/comments' && request.method() === 'POST') {
      const row = JSON.parse(request.postData());
      back.inserts.push({ table: 'comments', row });
      const saved = { id: 'c-new', body: row.body, author_id: row.author_id,
        author_name: row.author_name, created_at: new Date().toISOString() };
      back.comments.push(saved);
      return json(201, [saved]);
    }
    if (request.method() === 'DELETE') { back.deletes.push(p + '?' + url.search); return json(204, {}); }

    /*
     * Die Sicherung liest JEDE Tabelle einmal komplett — auch die, für die
     * dieser Stub sonst keinen Anlass hatte. Eine Tabelle, von der er nichts
     * weiß, ist leer, nicht nicht vorhanden: mit 404 bräche die Sicherung ab,
     * obwohl in Wirklichkeit nur nichts drinsteht.
     */
    const SICHERUNG = {
      albums: 'albums', photos: 'photos', board_posts: 'posts', events: 'events',
      recipes: 'recipes', recipe_photos: 'recipePhotos', announcements: 'announcements',
      people: 'people', comments: null, event_replies: null
    };
    if (request.method() === 'GET' && p.startsWith('/rest/v1/')) {
      const tabelle = p.slice('/rest/v1/'.length);
      if (Object.prototype.hasOwnProperty.call(SICHERUNG, tabelle)) {
        const feld = SICHERUNG[tabelle];
        return json(200, (feld && back[feld]) || []);
      }
    }

    return json(404, { message: 'unhandled ' + p });
  });
}

const SESSION = '#access_token=tok-abc&refresh_token=ref-abc&expires_in=3600&token_type=bearer';

// --- 1. the door -----------------------------------------------------------
{
  const context = await browser.newContext({ viewport: { width: 414, height: 860 } });
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  const back = makeBackend();
  await stub(page, back);

  await page.goto(origin + '/index.html');
  await page.waitForSelector('.gate');
  check('anmeldung: fragt nach der Adresse, nicht nach einem Code',
    (await page.textContent('.gate__lead')).includes('E-Mail'));
  check('anmeldung: kein Passwortfeld', (await page.locator('input[type=password]').count()) === 0);

  await page.fill('.gate .field', 'ich@example.de');
  await page.click('.gate .btn');
  await page.waitForSelector('.gate__title:text("Schau in dein Postfach")');
  check('anmeldung: schickt genau eine Anfrage', back.otpRequests.length === 1);
  check('anmeldung: für die eingegebene Adresse',
    back.otpRequests[0].email === 'ich@example.de', JSON.stringify(back.otpRequests[0]));
  // Im Body würde Supabase das Ziel stillschweigend ignorieren und jeden Link
  // auf die Site URL schicken. Genau so war es gebaut, und genau das hat erst
  // eine echte Mail ans echte Projekt gezeigt - deshalb prüft das hier die URL.
  check('anmeldung: mit Rücksprung auf dieselbe Seite',
    (back.otpRequests[0].redirect_to || '').endsWith('/index.html'),
    JSON.stringify(back.otpRequests[0]));
  check('anmeldung: das Ziel steht in der Query, nicht im Body',
    back.otpRequests[0].options === undefined, JSON.stringify(back.otpRequests[0]));
  // Der Mailserver lehnt ab: nichts, was die Person vor dem Bildschirm
  // verursacht hat oder beheben kann. Also darf da kein englischer Serversatz
  // stehen. Genau so ist es einmal passiert - falsches Gmail-Passwort.
  await page.click('.gate__hint + .btn, .gate .btn--ghost');
  await page.route(SB + '/auth/v1/otp**', (route) => route.fulfill({
    status: 500, headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ code: 500, msg: 'Error sending confirmation email' })
  }));
  await page.fill('.gate .field', 'ich@example.de');
  await page.click('.gate .btn--primary');
  await page.waitForSelector('.gate__hint.is-error');
  check('anmeldung: ein kaputter Mailversand wird nicht englisch durchgereicht',
    (await page.textContent('.gate__hint')).indexOf('nicht an dir') >= 0,
    await page.textContent('.gate__hint'));

  check('anmeldung: keine Fehler', errors.length === 0, errors.join('\n'));
  await shot(page, '1-postfach');
  await context.close();
}

// --- 2. coming back from the mail -----------------------------------------
{
  const context = await browser.newContext({ viewport: { width: 414, height: 860 } });
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  const back = makeBackend();
  await stub(page, back);

  const scratch = await context.newPage();
  await scratch.goto('about:blank');
  const jpeg = await makeJpeg(scratch, 400, 300, 200, 'Foto');
  const group = await makeJpeg(scratch, 800, 500, 40, 'Familie');
  images.set('evas-treff/aaaa1111_thumb.jpg', jpeg);
  images.set('evas-treff/aaaa1111.jpg', jpeg);
  images.set('evas-treff/bbbb2222_thumb.jpg', jpeg);
  images.set('evas-treff/bbbb2222.jpg', jpeg);
  images.set('photo.jpg', group);

  back.albums = [
    { id: 'alb-1', slug: 'evas-treff', title: "Eva's Treff", event_date: '2026-08-07', photos: [{ count: 2 }] },
    { id: 'alb-2', slug: 'weihnachten', title: 'Weihnachten', event_date: '2025-12-24', photos: [{ count: 0 }] }
  ];
  back.photos = [
    { id: 'ph-1', album_id: 'alb-1', storage_path: 'evas-treff/aaaa1111.jpg', thumb_path: 'evas-treff/aaaa1111_thumb.jpg',
      content_hash: 'aaaa1111', taken_at: '2026-08-07T21:33:00Z', uploader_id: 'user-1', uploader_name: 'Maria',
      comments: [{ id: 'c-1', body: 'Schöner Abend!', author_id: 'user-2', author_name: 'Ines', created_at: '2026-08-07T22:00:00Z' }] },
    { id: 'ph-2', album_id: 'alb-1', storage_path: 'evas-treff/bbbb2222.jpg', thumb_path: 'evas-treff/bbbb2222_thumb.jpg',
      content_hash: 'bbbb2222', taken_at: '2026-08-07T20:10:00Z', uploader_id: 'user-9', uploader_name: 'Ines', comments: [] }
  ];
  back.people = [
    { name: 'Maria', face_x: 0.78, face_y: 0.39, aliases: [] },
    { name: 'Ines', face_x: 0.13, face_y: 0.39, aliases: [] }
  ];

  await page.goto(origin + '/index.html' + SESSION);
  await page.waitForSelector('.shelf__card');
  check('rückkehr: der Link meldet an', true);
  check('rückkehr: die Tokens verschwinden aus der Adresszeile',
    page.url() === origin + '/index.html', page.url());
  check('rückkehr: und überleben einen Neuladen',
    await page.evaluate(() => !!JSON.parse(localStorage.getItem('sb:session') || 'null')));

  // Derselbe Link, aber die Seite steht schon offen: der Browser lädt bei
  // einem reinen Fragmentwechsel nicht neu, also muss die App das selbst tun.
  // Genau daran ist die Vorgängerversion einmal gescheitert.
  await page.evaluate(() => localStorage.removeItem('sb:session'));
  await page.evaluate((h) => { location.hash = h; }, SESSION.slice(1));
  let reopened = true;
  try {
    await page.waitForFunction(() => !!localStorage.getItem('sb:session'), null, { timeout: 5000 });
    await page.waitForSelector('.shelf__card', { timeout: 5000 });
  } catch { reopened = false; }
  check('rückkehr: der Link wirkt auch auf einer offenen Seite',
    reopened && page.url() === origin + '/index.html', page.url());

  check('regal: zeigt beide Alben', (await page.locator('.shelf__card').count()) === 2);
  check('regal: mit Titelbild aus signierter URL',
    (await page.locator('.shelf__cover.is-loaded').count()) >= 1);

  // Der Boden im Profil steht auf Anfang 2026, der einzige Kommentar ist von
  // August und von jemand anderem — also genau ein Bild mit Neuem, und nur im
  // ersten Album.
  check('neue kommentare: das Regal sagt, in welchem Album etwas steht',
    (await page.locator('.shelf__new').count()) === 1 &&
    (await page.textContent('.shelf__new')) === '1 Bild mit neuen Kommentaren',
    await page.locator('.shelf__new').allTextContents().then(JSON.stringify));
  check('umbenennen: wird angeboten, wo man darf',
    (await page.locator('.shelf__rename').count()) === 2);
  await shot(page, '2-regal');

  const before = back.signCalls;
  await page.locator('.shelf__card').first().click();
  await page.waitForSelector('.tile.is-loaded');
  check('album: zeigt seine Fotos', (await page.locator('.tile').count()) === 2);
  const forTwo = back.signCalls - before;

  // The number that matters is not how many signing calls there are, but that
  // it does not grow with the album: signing is batched, so twenty photos must
  // cost exactly what two do.
  for (let i = 3; i <= 20; i++) {
    const hash = `cccc${String(i).padStart(4, '0')}`;
    images.set(`evas-treff/${hash}_thumb.jpg`, jpeg);
    images.set(`evas-treff/${hash}.jpg`, jpeg);
    back.photos.push({
      id: 'ph-' + i, album_id: 'alb-1',
      storage_path: `evas-treff/${hash}.jpg`, thumb_path: `evas-treff/${hash}_thumb.jpg`,
      content_hash: hash, taken_at: '2026-08-07T19:00:00Z',
      uploader_id: 'user-9', uploader_name: 'Ines', comments: []
    });
  }
  const beforeMany = back.signCalls;
  await page.reload();
  await page.waitForSelector('.tile.is-loaded');
  const forTwenty = back.signCalls - beforeMany;
  check('album: zwanzig Fotos kosten so viele Signieranfragen wie zwei',
    forTwenty === forTwo && (await page.locator('.tile').count()) === 20,
    `${forTwo} bei 2 Fotos, ${forTwenty} bei 20`);
  // Every uploader in this fixture is on the family photo, so every tile
  // should carry a face - the count moved when the album grew, which is why
  // this compares the two rather than a fixed number.
  check('album: Gesichter neben den Namen',
    (await page.locator('.tile__face').count()) === (await page.locator('.tile').count()),
    `${await page.locator('.tile__face').count()} Gesichter zu ${await page.locator('.tile').count()} Kacheln`);

  // Geometrie statt Klassenname: der Name stand hinter dem Kopf und war
  // unlesbar. Gemessen wird, wo der Text wirklich anfängt — eine Prüfung auf
  // „hat die Klasse" wäre bei jeder anderen Einzugsbreite trotzdem grün.
  const overlap = await page.locator('.tile--face').first().evaluate((tile) => {
    const by = tile.querySelector('.tile__by');
    const face = tile.querySelector('.tile__face');
    const b = by.getBoundingClientRect();
    const f = face.getBoundingClientRect();
    const textStartsAt = b.left + parseFloat(getComputedStyle(by).paddingLeft);
    return { textStartsAt, faceEndsAt: f.right, name: by.textContent };
  });
  check('kachel: der Name steht neben dem Kopf, nicht darunter',
    overlap.textStartsAt >= overlap.faceEndsAt,
    `"${overlap.name}" beginnt bei ${overlap.textStartsAt}, der Kopf endet bei ${overlap.faceEndsAt}`);

  check('neue kommentare: nur die Kachel, auf der etwas steht',
    (await page.locator('.tile__talk.is-new').count()) === 1);

  await page.locator('.tile').first().click();
  await page.waitForSelector('.lightbox:not(.is-hidden)');
  check('verschieben: wird angeboten, wenn es ein Ziel gibt',
    await page.isVisible('.lightbox__tools .btn[title*="Album"]'));
  await page.click('.lightbox__comments-toggle');
  await page.waitForSelector('.comments:not(.is-hidden)');
  check('kommentare: kommen mit dem Foto, ohne Nachladen',
    (await page.textContent('.comment__text')) === 'Schöner Abend!');

  // Gelesen ist, was aufgemacht wurde — nicht, was vorbeigescrollt ist.
  await page.waitForFunction(() => !document.querySelector('.tile__talk.is-new'));
  const read = back.inserts.find((i) => i.table === 'comment_reads');
  check('neue kommentare: aufmachen schreibt den Lesestand, für mich allein',
    read.row.profile_id === 'user-1' && read.row.photo_id === 'ph-1' &&
    read.query.includes('on_conflict=profile_id,photo_id'), JSON.stringify(read));

  await page.fill('.comments__input', 'Fand ich auch');
  await page.click('.comments__form .btn--primary');
  await page.waitForFunction(() => document.querySelectorAll('.comment').length === 2);
  const written = back.inserts.find((i) => i.table === 'comments');
  check('kommentare: werden mit dem eigenen Konto geschrieben',
    written.row.author_id === 'user-1' && written.row.body === 'Fand ich auch', JSON.stringify(written.row));

  check('löschen: wird beim eigenen Foto angeboten', await page.isVisible('.btn--danger'));
  await page.keyboard.press('Escape');
  await page.keyboard.press('Escape');
  await page.locator('.tile').nth(1).click();
  await page.waitForSelector('.lightbox:not(.is-hidden)');
  check('löschen: nicht beim Foto eines anderen', !(await page.isVisible('.btn--danger')));
  // Admin darf auch fremde Fotos umhängen — dieselbe Regel wie in der Datenbank.
  check('verschieben: Admins dürfen auch fremde Fotos umhängen',
    await page.isVisible('.lightbox__tools .btn[title*="Album"]'));

  await page.click('.lightbox__tools .btn[title*="Album"]');
  await page.waitForSelector('.confirm:not(.is-hidden) select');
  check('verschieben: das Album, in dem man steht, steht nicht zur Auswahl',
    (await page.locator('.confirm:not(.is-hidden) option').allTextContents())
      .join('|') === 'Weihnachten');
  const tilesBefore = await page.locator('.tile').count();
  await page.click('.confirm:not(.is-hidden) .btn--primary');
  await page.waitForFunction((n) => document.querySelectorAll('.tile').length === n - 1, tilesBefore);
  const moved = back.patches.find((i) => i.table === 'photos');
  // Nur `album_id` — alles andere darf die Datenbank ohnehin nicht, und die
  // App soll es auch gar nicht erst schicken.
  check('verschieben: schickt nur das Album, nichts sonst',
    JSON.stringify(moved.row) === '{"album_id":"alb-2"}' && moved.query.includes('id=eq.ph-2'),
    JSON.stringify(moved));

  await shot(page, '2-album');
  check('keine Fehler', errors.length === 0, errors.join('\n'));
  await context.close();
}

// --- 2b. ein einziges Album darf keine Sackgasse sein -----------------------
//
// Genau der Zustand, in dem die Familie saß: ein Album, also sprang die Seite
// immer hinein, das Regal erschien nie — und weil „Neues Album" nur dort
// steht, war ein zweites Album gar nicht anlegbar.
{
  const context = await browser.newContext({ viewport: { width: 414, height: 860 } });
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  const back = makeBackend();
  await stub(page, back);

  back.albums = [
    { id: 'alb-1', slug: 'evas-treff', title: "Eva's Treff", event_date: '2026-08-07', photos: [{ count: 0 }] }
  ];

  await page.goto(origin + '/index.html' + SESSION);
  // Auf das GELADENE Album warten: die Leiste steht sofort da, aber bis der
  // Titel darin steht, vergeht eine Abfrage.
  await page.waitForSelector('.act-add-photos:not(.is-hidden)');
  check('ein Album: die Abkürzung führt weiterhin direkt hinein',
    (await page.textContent('.topbar__title')) === "Eva's Treff");
  check('ein Album: der Weg zurück aufs Regal steht trotzdem da',
    await page.isVisible('.topbar__back'));

  await page.click('.topbar__back');
  await page.waitForSelector('.shelf__card');
  check('ein Album: und führt wirklich aufs Regal',
    (await page.locator('.shelf__card').count()) === 1 &&
    (await page.textContent('.topbar__title')) === 'Familie');

  // Der Knopf, den es vorher nie zu sehen gab.
  page.on('dialog', (d) => d.accept('Ostern 2026'));
  check('ein Album: „Neues Album" ist von hier aus erreichbar',
    await page.isVisible('.act-new-album'));
  await page.click('.act-new-album');
  await page.waitForFunction(() => location.pathname.endsWith('/upload.html'));
  const album = back.inserts.find((i) => i.table === 'albums');
  check('ein Album: das zweite lässt sich anlegen und öffnet sich zum Befüllen',
    album.row.title === 'Ostern 2026' && album.row.created_by === 'user-1' &&
    page.url().includes('album=ostern-2026'),
    JSON.stringify(album.row) + ' → ' + page.url());

  check('ein Album: keine Fehler', errors.length === 0, errors.join('\n'));
  await context.close();
}

// --- 2c. jede Seite lädt, was ihre Bausteine brauchen -----------------------
{
  /*
   * Ein Modul, das ein anderes benutzt, dessen Datei die Seite nicht lädt.
   *
   * Genau das ist passiert: `neues.html` lud `album.js` nicht, `people.js`
   * ruft darin `PS.album.slug()` auf, und heraus kam ein „Cannot read
   * properties of undefined" — aber erst in der echten App, weil der Aufruf
   * hinter einer Bedingung liegt, die im Test nie wahr wurde.
   *
   * Deshalb hier nicht die einzelne Stelle prüfen, sondern die Klasse: JEDE
   * Seite einmal mit vollständigen Daten öffnen und auf Fehler hören. Eine
   * vergessene Skriptzeile fällt dann sofort auf, egal in welchem Modul sie
   * fehlt.
   */
  const seiten = ['/index.html', '/upload.html', '/board.html', '/dates.html',
    '/rezepte.html', '/neues.html', '/admin.html', '/sicherung.html'];

  for (const seite of seiten) {
    const context = await browser.newContext({ viewport: { width: 414, height: 860 } });
    const page = await context.newPage();
    const errors = [];
    page.on('pageerror', (e) => errors.push(String(e)));
    page.on('console', (m) => { if (m.type() === 'error' && !/status of 40[0-9]/.test(m.text())) errors.push(m.text()); });
    const back = makeBackend();
    // Überall etwas zu sehen, damit die Seiten nicht in ihrem Leer-Zweig
    // stehen bleiben und die halbe Zeichenarbeit überspringen.
    back.albums = [
      { id: 'alb-1', slug: 'evas-treff', title: "Eva's Treff", event_date: '2026-08-07', photos: [{ count: 1 }] }
    ];
    back.people = [
      { name: 'Ben',  face_x: 0.5,  face_y: 0.4,  aliases: [] },
      { name: 'Ines', face_x: 0.13, face_y: 0.39, aliases: [] }
    ];
    back.photos = [
      { id: 'ph-1', album_id: 'alb-1', storage_path: 'evas-treff/a.jpg',
        thumb_path: 'evas-treff/a_thumb.jpg', content_hash: 'a', media_type: 'image',
        taken_at: '2026-08-07T21:33:00Z', uploader_id: 'user-1', uploader_name: 'Ben', comments: [] }
    ];
    back.posts = [{ id: 'bp-1', body: 'Hallo', image_path: null, author_id: 'user-9',
      author_name: 'Ines', created_at: '2026-08-07T10:00:00Z' }];
    back.events = [{ id: 'ev-1', title: 'Grillen', starts_on: '2026-09-01', ends_on: null,
      starts_at: null, place: 'Garten', note: null, created_by: 'user-1',
      profiles: { people: { name: 'Ben' } }, event_replies: [] }];
    back.recipes = [{ id: 'rz-1', slug: 'kuchen', title: 'Kuchen', servings: 4,
      ingredients: 'Mehl', steps: 'Backen', note: null, created_by: 'user-1',
      created_at: '2026-08-01T10:00:00Z', profiles: { people: { name: 'Ben' } } }];
    back.announcements = [{ id: 'an-1', body: 'Hallo Familie', until: null,
      created_at: '2026-08-10T09:00:00Z', profiles: { people: { name: 'Ben' } } }];
    back.news.announcements = { unread: 1, items: [
      { id: 'an-1', body: 'Hallo Familie', until: null, author: 'Ben',
        at: '2026-08-10T09:00:00Z', unread: true }] };
    await stub(page, back);

    await page.goto(origin + seite + SESSION);
    await page.waitForSelector('.topbar, .gate, .status', { timeout: 15000 });
    // Kurz laufen lassen: der Fehler von damals kam erst beim Zeichnen der
    // Namen, nicht beim Aufbau des Gerüsts.
    await page.waitForTimeout(700);
    check('aufbau: ' + seite + ' lädt alles, was ihre Bausteine brauchen',
      errors.length === 0, errors.join('\n'));
    await context.close();
  }
}

// --- 3. hochladen ----------------------------------------------------------
{
  const context = await browser.newContext({ viewport: { width: 414, height: 860 } });
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  const back = makeBackend();
  await stub(page, back);

  back.albums = [
    { id: 'alb-1', slug: 'evas-treff', title: "Eva's Treff", event_date: '2026-08-07', photos: [{ count: 0 }] }
  ];
  back.people = [{ name: 'Maria', face_x: 0.78, face_y: 0.39, aliases: [] }];

  await page.goto(origin + '/upload.html' + SESSION);
  // The camera button is hidden on anything with a mouse, so wait on the other.
  await page.waitForSelector('.drop__buttons .btn:not(.btn--camera):not([disabled])');

  // The account already knows who this is, so the page must not ask again -
  // the old version's whole job was collecting a name.
  check('hochladen: der Name kommt aus dem Konto',
    (await page.textContent('.who__current')) === 'Maria');
  check('hochladen: kein Namensfeld mehr', await page.locator('.panel > .field').isHidden());
  check('hochladen: das Album steht im Titel',
    (await page.textContent('.topbar__title')) === "Eva's Treff");

  const scratch = await context.newPage();
  await scratch.goto('about:blank');
  const kuchen = await makeJpeg(scratch, 1200, 900, 120, 'Kuchen');
  await scratch.close();

  await page.setInputFiles('input[type=file]:not([capture])',
    { name: 'IMG_0042.jpg', mimeType: 'image/jpeg', buffer: kuchen });
  await page.waitForSelector('.job--done');

  const row = back.inserts.find((i) => i.table === 'photos').row;
  check('hochladen: landet im geöffneten Album', row.album_id === 'alb-1', JSON.stringify(row));
  check('hochladen: mit dem eigenen Konto als Urheber',
    row.uploader_id === 'user-1' && row.uploader_name === 'Maria', JSON.stringify(row));
  check('hochladen: verkleinert auf die lange Kante',
    row.width === 1200 && row.height === 900, `${row.width}x${row.height}`);

  // Bild vor Zeile, und beide unter demselben Hash: eine Zeile, die auf eine
  // fehlende Datei zeigt, wäre eine Kachel, die sich nicht öffnen lässt.
  check('hochladen: Bild und Vorschau vor der Zeile',
    back.uploads.length === 2 &&
    back.uploads[0] === `evas-treff/${row.content_hash}.jpg` &&
    back.uploads[1] === `evas-treff/${row.content_hash}_thumb.jpg`,
    JSON.stringify(back.uploads));
  check('hochladen: die Zeile zeigt auf genau diese Dateien',
    row.storage_path === back.uploads[0] && row.thumb_path === back.uploads[1]);

  // Dasselbe Foto nochmal: derselbe Inhalt, derselbe Hash, keine zweite Kopie.
  await page.setInputFiles('input[type=file]:not([capture])',
    { name: 'IMG_0042-kopie.jpg', mimeType: 'image/jpeg', buffer: kuchen });
  await page.waitForSelector('.job--skip');
  check('hochladen: dasselbe Foto ein zweites Mal kostet nichts',
    back.uploads.length === 2 && back.inserts.filter((i) => i.table === 'photos').length === 1,
    JSON.stringify(back.uploads));

  await shot(page, '3-hochladen');
  check('hochladen: keine Fehler', errors.length === 0, errors.join('\n'));
  await context.close();
}

// --- 3c. ein Video geht unverändert hoch, mit Standbild ---------------------
{
  const context = await browser.newContext({ viewport: { width: 414, height: 860 } });
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  const back = makeBackend();
  await stub(page, back);
  back.albums = [
    { id: 'alb-1', slug: 'evas-treff', title: "Eva's Treff", event_date: '2026-08-07', photos: [{ count: 0 }] }
  ];

  await page.goto(origin + '/upload.html' + SESSION);
  await page.waitForSelector('.drop__buttons .btn:not(.btn--camera):not([disabled])');

  const scratch = await context.newPage();
  await scratch.goto('about:blank');
  const clip = await makeWebm(scratch, 640, 480, 300, 1200);
  check('video: die Aufnahme ist wirklich ein WebM',
    clip.length > 2000 && clip[0] === 0x1a && clip[1] === 0x45,
    `${clip.length} Bytes, beginnt mit ${clip[0]?.toString(16)} ${clip[1]?.toString(16)}`);

  await page.setInputFiles('input[type=file]:not([capture])',
    { name: 'Geburtstag.webm', mimeType: 'video/webm', buffer: clip });
  await page.waitForSelector('.job--done', { timeout: 60000 });
  await page.waitForFunction(() => document.querySelector('.summary:not(.is-hidden)'));

  const row = back.inserts.find((i) => i.table === 'photos').row;
  check('video: wird als Video eingetragen', row.media_type === 'video', JSON.stringify(row));
  check('video: mit den Maßen aus der Datei',
    row.width === 640 && row.height === 480, `${row.width}x${row.height}`);

  // Die Datei behält ihre Endung: ein .jpg, in dem ein Film steckt, öffnet
  // auf keinem Gerät.
  check('video: liegt unter seiner eigenen Endung',
    row.storage_path.endsWith('.webm') && row.thumb_path.endsWith('_thumb.jpg'),
    row.storage_path + ' / ' + row.thumb_path);
  check('video: unverändert hochgeladen, nicht neu kodiert',
    images.get(row.storage_path).length === clip.length,
    `${images.get(row.storage_path).length} statt ${clip.length}`);

  // Die Laufzeit: frisch aufgenommene WebM melden erst Infinity, und ohne den
  // Umweg über das Dateiende stünde hier gar nichts.
  check('video: die Laufzeit wurde ermittelt, trotz fehlender Angabe in der Datei',
    row.duration_seconds > 0.5 && row.duration_seconds < 5, String(row.duration_seconds));

  /*
   * Der Kern: das Standbild kommt WIRKLICH aus dem Video. Ein schwarzes Bild
   * wäre der Normalfall, wenn man den ersten Moment nimmt — und es sähe in der
   * Galerie aus wie ein kaputtes Foto.
   */
  const poster = await centrePixel(scratch, images.get(row.thumb_path));
  check('video: das Standbild hat die Maße des Videos',
    poster.width === 480 && poster.height === 360, JSON.stringify(poster));
  check('video: und es ist ein echtes Bild, kein schwarzes Feld',
    poster.r + poster.g + poster.b > 120, JSON.stringify(poster));
  await scratch.close();

  // Ein Video ist kein Foto, und der Satz darunter muss das sagen.
  check('video: die Zählung nennt es ein Video, kein Foto',
    (await page.textContent('.hint')) === 'Im Album ist 1 Video.',
    await page.textContent('.hint'));
  check('video: und die Schlusszeile ebenso',
    (await page.textContent('.summary strong')) === '1 Video ist im Album.',
    await page.textContent('.summary strong'));

  await shot(page, '3c-video-hochladen');
  check('video: keine Fehler beim Hochladen', errors.length === 0, errors.join('\n'));
  await context.close();
}

// --- 3d. was der Browser nicht lesen kann, geht gar nicht erst hoch ---------
{
  const context = await browser.newContext({ viewport: { width: 414, height: 860 } });
  const page = await context.newPage();
  const back = makeBackend();
  await stub(page, back);
  back.albums = [
    { id: 'alb-1', slug: 'evas-treff', title: "Eva's Treff", event_date: '2026-08-07', photos: [{ count: 0 }] }
  ];

  await page.goto(origin + '/upload.html' + SESSION);
  await page.waitForSelector('.drop__buttons .btn:not(.btn--camera):not([disabled])');

  /*
   * Genau der HEVC-Fall, nur sicher herstellbar: eine Datei, die sich als
   * Video ausgibt und die dieser Browser nicht dekodieren kann. Es darf NICHTS
   * hochgehen — ein Video ohne Standbild wäre in der Galerie eine leere
   * Kachel, und ohne Vorwarnung wären erst 80 MB durch das Datenvolumen.
   */
  await page.setInputFiles('input[type=file]:not([capture])',
    { name: 'Oma.mov', mimeType: 'video/quicktime', buffer: Buffer.alloc(80000, 7) });
  await page.waitForSelector('.job--error', { timeout: 60000 });

  check('video: unlesbares Format lädt gar nichts hoch',
    back.uploads.length === 0 && !back.inserts.some((i) => i.table === 'photos'),
    JSON.stringify(back.uploads));
  const satz = await page.textContent('.job--error .job__state');
  check('video: und sagt auf Deutsch, woran es liegt',
    /Format|lesen/i.test(satz) && !/undefined|\[object/.test(satz), satz);
  await context.close();
}

// --- 3e. in der Galerie: Abzeichen auf der Kachel, Abspieler im Fenster -----
{
  const context = await browser.newContext({ viewport: { width: 900, height: 900 } });
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  const back = makeBackend();
  await stub(page, back);

  const scratch = await context.newPage();
  await scratch.goto('about:blank');
  const clip = await makeWebm(scratch, 320, 240, 200, 900);
  const standbild = await makeJpeg(scratch, 320, 240, 200, '▶');
  await scratch.close();
  images.set('evas-treff/vid1.webm', clip);
  images.set('evas-treff/vid1_thumb.jpg', standbild);
  images.set('evas-treff/foto1.jpg', await (async () => {
    const s2 = await context.newPage(); await s2.goto('about:blank');
    const b = await makeJpeg(s2, 320, 240, 40, 'Foto'); await s2.close(); return b;
  })());
  images.set('evas-treff/foto1_thumb.jpg', images.get('evas-treff/foto1.jpg'));

  back.albums = [
    { id: 'alb-1', slug: 'evas-treff', title: "Eva's Treff", event_date: '2026-08-07', photos: [{ count: 2 }] }
  ];
  back.photos = [
    { id: 'ph-v', album_id: 'alb-1', storage_path: 'evas-treff/vid1.webm',
      thumb_path: 'evas-treff/vid1_thumb.jpg', content_hash: 'vid1',
      media_type: 'video', duration_seconds: 64.2,
      taken_at: '2026-08-07T21:33:00Z', uploader_id: 'user-1', uploader_name: 'Maria', comments: [] },
    { id: 'ph-f', album_id: 'alb-1', storage_path: 'evas-treff/foto1.jpg',
      thumb_path: 'evas-treff/foto1_thumb.jpg', content_hash: 'foto1',
      media_type: 'image', duration_seconds: null,
      taken_at: '2026-08-07T20:10:00Z', uploader_id: 'user-1', uploader_name: 'Maria', comments: [] }
  ];

  await page.goto(origin + '/index.html' + SESSION);
  await page.waitForSelector('.tile');
  check('video: nur das Video bekommt ein Abzeichen',
    (await page.locator('.tile__play').count()) === 1 &&
    (await page.locator('.tile--video').count()) === 1);
  // 64,2 Sekunden sind 1:04 — nicht "64" und nicht "1.07 Minuten".
  check('video: mit der Laufzeit, wie sie auf jedem Abspielknopf steht',
    (await page.textContent('.tile__play')) === '▶ 1:04',
    await page.textContent('.tile__play'));

  await page.locator('.tile--video').click();
  await page.waitForSelector('.lightbox:not(.is-hidden)');
  await page.waitForSelector('.lightbox__video:not(.is-hidden)');

  // Wirklich abspielbar, nicht nur eingebaut: der Browser muss Bilddaten haben.
  const spielt = await page.evaluate(async () => {
    const v = document.querySelector('.lightbox__video');
    if (v.readyState < 2) await new Promise((r) => { v.onloadeddata = r; setTimeout(r, 8000); });
    return { readyState: v.readyState, w: v.videoWidth, h: v.videoHeight, hasPoster: !!v.poster };
  });
  check('video: die Lightbox spielt es wirklich ab',
    spielt.readyState >= 2 && spielt.w === 320 && spielt.h === 240, JSON.stringify(spielt));
  check('video: mit dem Standbild als Vorschau, damit nichts schwarz aufblitzt',
    spielt.hasPoster);
  // Beide liegen im selben Kasten: bleibt das Bild stehen, steht dasselbe
  // Standbild NEBEN dem Abspieler. Genau so sah es zuerst aus.
  check('video: und ohne ein zweites Standbild daneben',
    await page.locator('.lightbox__image').isHidden());
  check('video: der Download behält die Endung des Videos',
    (await page.getAttribute('[title=Speichern]', 'download')).endsWith('.webm'),
    await page.getAttribute('[title=Speichern]', 'download'));
  await shot(page, '3e-video-ansehen');

  // Weiterblättern auf das Foto: der Ton darf nicht weiterlaufen und die
  // Datei nicht weiter geladen werden.
  await page.click('.lightbox__nav--next');
  const danach = await page.evaluate(() => {
    const v = document.querySelector('.lightbox__video');
    return { versteckt: v.classList.contains('is-hidden'), quelle: v.getAttribute('src'), pausiert: v.paused };
  });
  check('video: beim Weiterblättern hört es auf und lädt nicht weiter',
    danach.versteckt && !danach.quelle && danach.pausiert, JSON.stringify(danach));
  // ... und das Foto danach ist wieder da, statt mit dem Video verschwunden
  // zu sein.
  await page.waitForSelector('.lightbox__image:not(.is-hidden)');
  check('video: zurück beim Foto ist das Bild wieder sichtbar',
    await page.locator('.lightbox__image').isVisible());

  check('video: keine Fehler in der Galerie', errors.length === 0, errors.join('\n'));
  await context.close();
}

// --- 3b. ein HEIC kommt als JPEG an ----------------------------------------
{
  const context = await browser.newContext({ viewport: { width: 414, height: 860 } });
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  const back = makeBackend();
  await stub(page, back);
  back.albums = [
    { id: 'alb-1', slug: 'evas-treff', title: "Eva's Treff", event_date: '2026-08-07', photos: [{ count: 0 }] }
  ];

  await page.goto(origin + '/upload.html' + SESSION);
  await page.waitForSelector('.drop__buttons .btn:not(.btn--camera):not([disabled])');

  // A real file out of a HEIF encoder, with a capture date in its metadata -
  // the format no Chromium browser can open on its own.
  const heic = await readFile(new URL('./fixtures/photo-with-exif.heic', import.meta.url));
  check('heic: the fixture really is one',
    heic.subarray(4, 8).toString() === 'ftyp', heic.subarray(4, 12).toString());

  await page.setInputFiles('input[type=file]:not([capture])',
    { name: 'IMG_4711.HEIC', mimeType: 'image/heic', buffer: heic });
  await page.waitForSelector('.job--done', { timeout: 60000 });

  const row = back.inserts.find((i) => i.table === 'photos').row;
  const bytes = images.get(row.storage_path);
  check('heic: it went up as a JPEG', bytes[0] === 0xff && bytes[1] === 0xd8,
    Array.from(bytes.subarray(0, 4)).map((b) => b.toString(16)).join(' '));
  const dim = jpegSize(bytes);
  check('heic: at the right size', dim.width === 1200 && dim.height === 900, JSON.stringify(dim));
  // The capture date lives in a HEIF metadata item, not an APP1 segment. Get
  // that wrong and every iPhone photo is filed under the day it was copied.
  // The row stores UTC, the capture time is local, so compare it the way the
  // gallery will read it back rather than by string.
  const taken = new Date(row.taken_at);
  const day = [taken.getFullYear(), String(taken.getMonth() + 1).padStart(2, '0'),
    String(taken.getDate()).padStart(2, '0')].join('-');
  check('heic: filed under the day it was taken, not today',
    day === '2026-08-07' && taken.getHours() === 21 && taken.getMinutes() === 33,
    `${day} ${taken.getHours()}:${taken.getMinutes()}`);
  check('heic: keine Fehler', errors.length === 0, errors.join('\n'));
  await context.close();
}

// --- 4. die Pinnwand -------------------------------------------------------
{
  const context = await browser.newContext({ viewport: { width: 414, height: 860 } });
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  const back = makeBackend();
  await stub(page, back);

  const scratch = await context.newPage();
  await scratch.goto('about:blank');
  const pinned = await makeJpeg(scratch, 900, 600, 300, 'Zettel');
  const group = await makeJpeg(scratch, 800, 500, 40, 'Familie');
  await scratch.close();
  images.set('board/alt.jpg', pinned);
  images.set('photo.jpg', group);

  back.people = [
    { name: 'Maria', face_x: 0.78, face_y: 0.39, aliases: [] },
    { name: 'Ines', face_x: 0.13, face_y: 0.39, aliases: [] }
  ];
  back.board = [
    { id: 'bp-0', body: 'Sonntag Kaffee bei uns!', image_path: 'board/alt.jpg',
      author_id: 'user-9', author_name: 'Ines', created_at: '2026-08-08T09:00:00Z' }
  ];

  await page.goto(origin + '/board.html' + SESSION);
  await page.waitForSelector('.post');
  check('pinnwand: zeigt die Beiträge',
    (await page.textContent('.post__text')) === 'Sonntag Kaffee bei uns!');
  check('pinnwand: das Bild kommt über eine signierte URL',
    await page.locator('.post__image').evaluate((i) => i.complete && i.naturalWidth > 0));
  check('pinnwand: Gesicht neben dem Namen', (await page.locator('.post .avatar').count()) === 1);
  check('pinnwand: fremde Beiträge lassen sich nicht löschen',
    (await page.locator('.comment__remove').count()) === 0);

  const signsBefore = back.signCalls;
  await page.fill('.compose textarea', 'Bin dabei');
  await page.click('.compose__actions .btn--primary');
  await page.waitForFunction(() => document.querySelectorAll('.post').length === 2);

  const written = back.inserts.find((i) => i.table === 'board_posts').row;
  check('pinnwand: schreibt mit dem eigenen Konto',
    written.author_id === 'user-1' && written.author_name === 'Maria' && written.body === 'Bin dabei',
    JSON.stringify(written));
  check('pinnwand: ein Beitrag ohne Bild lädt nichts hoch', back.uploads.length === 0);
  // Zwei Beiträge, davon einer mit Bild: das ist genau ein Signieraufruf pro
  // Neuladen, nicht einer pro Bild.
  check('pinnwand: signiert die Bilder in einem Aufruf',
    back.signCalls - signsBefore <= 2, `${back.signCalls - signsBefore}`);

  check('pinnwand: der eigene Beitrag lässt sich löschen',
    (await page.locator('.comment__remove').count()) === 1);
  page.on('dialog', (d) => d.accept());
  await page.click('.comment__remove');
  await page.waitForFunction(() => document.querySelectorAll('.post').length === 1);
  check('pinnwand: löschen entfernt die Zeile',
    back.deletes.some((d) => d.startsWith('/rest/v1/board_posts')), JSON.stringify(back.deletes));

  await shot(page, '4-pinnwand');
  check('pinnwand: keine Fehler', errors.length === 0, errors.join('\n'));
  await context.close();
}

// --- 4b. Termine und Geburtstage -------------------------------------------
{
  const context = await browser.newContext({ viewport: { width: 414, height: 860 } });
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  const back = makeBackend();
  await stub(page, back);

  const scratch = await context.newPage();
  await scratch.goto('about:blank');
  images.set('photo.jpg', await makeJpeg(scratch, 800, 500, 40, 'Familie'));
  await scratch.close();

  // Relativ zu heute, nicht auf feste Daten: ein Test, der im September
  // durchfällt, weil das Datum vorbei ist, hat nichts gefunden.
  const day = (offset) => {
    const d = new Date();
    d.setDate(d.getDate() + offset);
    return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') +
      '-' + String(d.getDate()).padStart(2, '0');
  };
  const inFourDays = new Date();
  inFourDays.setDate(inFourDays.getDate() + 4);

  back.people = [
    { name: 'Maria', face_x: 0.78, face_y: 0.39, aliases: [] },
    { name: 'Ines', face_x: 0.13, face_y: 0.39, aliases: [],
      birth_day: inFourDays.getDate(), birth_month: inFourDays.getMonth() + 1, birth_year: 1958 }
  ];
  back.events = [
    { id: 'ev-grillen', title: 'Grillen im Garten', starts_on: day(9), starts_at: null,
      place: null, note: null, created_by: 'user-1', profiles: { people: { name: 'Maria' } },
      event_replies: [] },
    { id: 'ev-kaffee', title: 'Kaffee bei Oma', starts_on: day(2), starts_at: '15:00:00',
      place: 'Bei Eva', note: 'Kuchen bringt Maria mit', created_by: 'user-9',
      profiles: { people: { name: 'Ines' } },
      event_replies: [{ profile_id: 'user-9', answer: 'ja', profiles: { people: { name: 'Ines' } } }] },
    // Vergangenes darf gar nicht erst über die Leitung kommen.
    { id: 'ev-alt', title: 'Letztes Jahr', starts_on: day(-30), starts_at: null,
      place: null, note: null, created_by: 'user-1', profiles: null, event_replies: [] },
    // Angefangen, aber noch nicht vorbei: genau der Fall, den es vor `ends_on`
    // nicht gab und der sonst am zweiten Tag aus dem Kalender fällt.
    { id: 'ev-treffen', title: 'Jahrestreffen', starts_on: day(-1), ends_on: day(3),
      starts_at: null, place: null, note: null, created_by: 'user-1',
      profiles: null, event_replies: [] },
    // Mehrtägig und ganz vorbei — der muss trotzdem wegbleiben.
    { id: 'ev-weg', title: 'Voriges Treffen', starts_on: day(-20), ends_on: day(-15),
      starts_at: null, place: null, note: null, created_by: 'user-1',
      profiles: null, event_replies: [] }
  ];

  await page.goto(origin + '/dates.html' + SESSION);
  await page.waitForSelector('.date');

  check('termine: fragt nach dem Ende, nicht nach dem Anfang',
    back.queries.some((q) => q.includes('over_on=gte.' + day(0))), back.queries.join('\n'));
  check('termine: der alte Termin taucht nicht auf',
    !(await page.textContent('.dates')).includes('Letztes Jahr'));

  // Der Kern von „mehrtägig": angefangen zählt nicht als vorbei.
  const sichtbar = await page.textContent('.dates');
  check('mehrtägig: ein laufender Termin bleibt stehen, obwohl er begonnen hat',
    sichtbar.includes('Jahrestreffen'));
  check('mehrtägig: ein abgelaufener Zeitraum bleibt trotzdem weg',
    !sichtbar.includes('Voriges Treffen'));
  check('mehrtägig: und trägt den Zeitraum, nicht nur den ersten Tag',
    /\d+\. – /.test(await page.locator('.date').nth(0).locator('.date__day').textContent()),
    await page.locator('.date').nth(0).locator('.date__day').textContent());
  check('mehrtägig: „läuft gerade" statt eines Abstands in die Vergangenheit',
    (await page.locator('.date').nth(0).locator('.date__soon').textContent()) === 'läuft gerade');

  check('termine: Termin und Geburtstag in einer Liste',
    (await page.locator('.date').count()) === 4 &&
    (await page.locator('.date--birthday').count()) === 1);

  // Die Reihenfolge ist der ganze Zweck der Seite.
  const titles = await page.locator('.date__title').allTextContents();
  check('termine: das Nächste zuerst',
    titles.join(' | ') ===
    'Jahrestreffen | Kaffee bei Oma | Ines hat Geburtstag | Grillen im Garten',
    JSON.stringify(titles));

  // Ab hier auf die Karte zeigen, nicht auf ihre Position: sonst verschiebt
  // jeder neue Beispieltermin sämtliche Prüfungen darunter.
  const kaffee = page.locator('.date', { hasText: 'Kaffee bei Oma' });

  check('termine: bei fremden Terminen steht dran, von wem sie sind',
    (await page.locator('.date__host').count()) === 1 &&
    (await page.textContent('.date__host')).includes('Ines'));
  check('termine: wie bald es ist, steht dran',
    (await kaffee.locator('.date__soon').textContent()) === 'übermorgen');
  // Ohne Jahr gäbe es kein Alter; mit Jahr muss es stimmen.
  check('geburtstage: das Alter nur, wenn das Jahr bekannt ist',
    (await page.locator('.date--birthday .date__note').textContent())
      === 'wird ' + (inFourDays.getFullYear() - 1958));

  await kaffee.locator('.chip').nth(0).click();
  await page.waitForFunction(() => document.querySelectorAll('.chip.is-active').length === 1);
  const reply = back.inserts.find((i) => i.table === 'event_replies');
  check('termine: die Zusage trägt das eigene Konto',
    reply.row.event_id === 'ev-kaffee' && reply.row.profile_id === 'user-1' &&
    reply.row.answer === 'ja' && reply.query.includes('on_conflict=event_id,profile_id'),
    JSON.stringify(reply));
  check('termine: die Antwort steht sofort im Bild, ohne Neuladen',
    (await kaffee.locator('.date__tally').textContent()).includes('2 Zusagen'));

  // Ein fremder Termin: löschen darf ihn hier nur, weil dieses Konto Admin ist.
  // Drei Termine, einer davon fremd (Kaffee, von user-9) — und auch der trägt
  // ein Kreuz, weil dieses Konto Admin ist.
  check('termine: Admins dürfen auch fremde Termine wegräumen',
    (await page.locator('.date .comment__remove').count()) === 3 &&
    (await kaffee.locator('.comment__remove').count()) === 1);

  await page.click('.topbar__actions .btn--primary');
  await page.fill('.confirm input[type=text]', 'Spaziergang');
  await page.locator('.confirm input[type=date]').nth(0).fill(day(20));
  await page.click('.confirm__actions .btn--primary');
  await page.waitForFunction(() => !!document.querySelector('.confirm.is-hidden'));
  const event = back.inserts.find((i) => i.table === 'events').row;
  check('termine: neuer Termin mit eigenem Konto als Urheber',
    event.title === 'Spaziergang' && event.starts_on === day(20) && event.created_by === 'user-1',
    JSON.stringify(event));
  // Die meisten Familientermine haben keine Uhrzeit, und "00:00" wäre dafür
  // die falsche Antwort — das steht so auch in der Migration.
  check('termine: keine Uhrzeit heißt null, nicht 00:00', event.starts_at === null,
    JSON.stringify(event.starts_at));
  check('mehrtägig: ohne Bis-Datum bleibt der Termin eintägig', event.ends_on === null,
    JSON.stringify(event.ends_on));

  // Und einmal mit Zeitraum — der Fall, um den es ging.
  await page.click('.topbar__actions .btn--primary');
  await page.fill('.confirm input[type=text]', 'Jahrestreffen 2027');
  await page.locator('.confirm input[type=date]').nth(0).fill('2027-08-05');
  await page.locator('.confirm input[type=date]').nth(1).fill('2027-08-10');
  await page.click('.confirm__actions .btn--primary');
  await page.waitForFunction(() => !!document.querySelector('.confirm.is-hidden'));
  const treffen = back.inserts.filter((i) => i.table === 'events').pop().row;
  check('mehrtägig: Anfang und Ende gehen beide raus',
    treffen.starts_on === '2027-08-05' && treffen.ends_on === '2027-08-10',
    JSON.stringify(treffen));

  // Ein „bis" auf demselben Tag ist kein Zeitraum, sondern derselbe Tag.
  await page.click('.topbar__actions .btn--primary');
  await page.fill('.confirm input[type=text]', 'Nur ein Tag');
  await page.locator('.confirm input[type=date]').nth(0).fill(day(40));
  await page.locator('.confirm input[type=date]').nth(1).fill(day(40));
  await page.click('.confirm__actions .btn--primary');
  await page.waitForFunction(() => !!document.querySelector('.confirm.is-hidden'));
  check('mehrtägig: dasselbe Datum zweimal ist kein Zeitraum',
    back.inserts.filter((i) => i.table === 'events').pop().row.ends_on === null);

  // Ein Ende vor dem Anfang gar nicht erst abschicken.
  const vorher = back.inserts.filter((i) => i.table === 'events').length;
  const meldungen = await page.locator('.toast').count();
  await page.click('.topbar__actions .btn--primary');
  await page.fill('.confirm input[type=text]', 'Rückwärts');
  await page.locator('.confirm input[type=date]').nth(0).fill(day(20));
  await page.locator('.confirm input[type=date]').nth(1).fill(day(10));
  await page.click('.confirm__actions .btn--primary');
  await page.waitForFunction((had) => document.querySelectorAll('.toast').length > had, meldungen);
  check('mehrtägig: ein Ende vor dem Anfang wird gar nicht erst geschickt',
    back.inserts.filter((i) => i.table === 'events').length === vorher &&
    (await page.locator('.toast').last().textContent()).includes('vor dem Anfang'),
    await page.locator('.toast').last().textContent());
  await page.click('.confirm:not(.is-hidden) .confirm__actions .btn:not(.btn--primary)');

  await shot(page, '5-termine');
  check('termine: keine Fehler', errors.length === 0, errors.join('\n'));
  await context.close();
}

// --- 5. die Gästeliste -----------------------------------------------------
{
  const context = await browser.newContext({ viewport: { width: 414, height: 860 } });
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  const back = makeBackend();
  await stub(page, back);

  const scratch = await context.newPage();
  await scratch.goto('about:blank');
  images.set('photo.jpg', await makeJpeg(scratch, 800, 500, 40, 'Familie'));
  await scratch.close();

  back.people = [
    { name: 'Maria', face_x: 0.78, face_y: 0.39, aliases: [] },
    { name: 'Ines', face_x: 0.13, face_y: 0.39, aliases: [] }
  ];
  back.invites = [
    { email: 'ich@example.de', is_admin: true, person_id: 'p1',
      invited_at: '2026-08-01T10:00:00Z', used_at: '2026-08-02T10:00:00Z', people: { name: 'Maria' } },
    { email: 'ines@example.de', is_admin: false, person_id: 'p2',
      invited_at: '2026-08-01T10:00:00Z', used_at: null, people: { name: 'Ines' } }
  ];

  await page.goto(origin + '/admin.html' + SESSION);
  await page.waitForSelector('.guest');
  // Die Geburtstagszeilen darunter sind dieselbe Zeilenform und tragen daher
  // auch `.guest` — beim Zählen der Eingeladenen müssen sie draußen bleiben.
  const invited = page.locator('.guest:not(.guest--birthday)');
  check('gästeliste: zeigt alle Eingeladenen', (await invited.count()) === 2);
  check('gästeliste: sagt, wer schon da war',
    (await page.locator('.guest__state.is-here').count()) === 1);
  // Kicking yourself out of your own guest list is the one move that cannot be
  // undone from inside the app, so it is not offered.
  check('gästeliste: die eigene Einladung lässt sich nicht zurückziehen',
    (await page.locator('.comment__remove').count()) === 1);
  check('gästeliste: Gesichter aus dem Familienfoto',
    (await invited.locator('.avatar').count()) === 2);

  await page.fill('.compose input[type=email]', 'lu@example.de');
  await page.selectOption('.compose select', 'Ines');
  await page.click('.compose__actions .btn--primary');
  await page.waitForFunction(
    () => document.querySelectorAll('.guest:not(.guest--birthday)').length === 3);
  const written = back.inserts.find((i) => i.table === 'invites').row;
  check('gästeliste: trägt die Adresse mit dem gewählten Gesicht ein',
    written.email === 'lu@example.de' && written.person_id === 'person-Ines' && written.is_admin === false,
    JSON.stringify(written));

  // Geburtstage stehen auf derselben Seite, weil nur Admins `people` ändern
  // dürfen. Elf Zeilen einmal ausfüllen — ohne Dialog, ohne Speichern-Knopf.
  check('geburtstage: eine Zeile pro Person auf dem Familienfoto',
    (await page.locator('.guest--birthday').count()) === 2);
  await page.locator('.guest--birthday').nth(1).locator('.birthday__part').nth(0).fill('3');
  await page.locator('.guest--birthday').nth(1).locator('.birthday__part').nth(1).fill('5');
  await page.locator('.guest--birthday').nth(1).locator('.birthday__year').fill('1958');
  await page.locator('.guest--birthday').nth(1).locator('.birthday__year').blur();
  await page.waitForFunction(() => document.querySelectorAll('.guest.is-saved').length > 0);
  const saved = back.inserts.filter((i) => i.table === 'people.patch').pop().row;
  check('geburtstage: werden an der Person gespeichert',
    saved.name === 'Ines' && saved.birth_day === 3 && saved.birth_month === 5 &&
    saved.birth_year === 1958, JSON.stringify(saved));

  // Halbes Datum gar nicht erst abschicken: der Server lehnt es ohnehin ab,
  // aber die Meldung soll früher und auf Deutsch kommen.
  const before = back.inserts.filter((i) => i.table === 'people.patch').length;
  // Meldungen stapeln sich; die vom Einladen steht noch da. Also auf eine
  // NEUE warten und die letzte lesen, sonst prüft der Test die alte.
  const toasts = await page.locator('.toast').count();
  await page.locator('.guest--birthday').nth(0).locator('.birthday__part').nth(0).fill('7');
  await page.locator('.guest--birthday').nth(0).locator('.birthday__part').nth(0).blur();
  await page.waitForFunction((had) => document.querySelectorAll('.toast').length > had, toasts);
  const complaint = await page.locator('.toast').last().textContent();
  check('geburtstage: Tag ohne Monat wird gar nicht erst geschickt',
    back.inserts.filter((i) => i.table === 'people.patch').length === before &&
    complaint.includes('gehören zusammen'), complaint);

  // Die Meldungen räumen sich nach ein paar Sekunden selbst weg; für das Bild
  // warten wir das ab, sonst liegen drei Sprechblasen über der Liste.
  await page.waitForFunction(() => document.querySelectorAll('.toast').length === 0);
  await shot(page, '6-gaesteliste');
  check('gästeliste: keine Fehler', errors.length === 0, errors.join('\n'));
  await context.close();
}

// --- 6. ein normales Konto sieht die Gästeliste nicht ----------------------
{
  const context = await browser.newContext({ viewport: { width: 414, height: 860 } });
  const page = await context.newPage();
  const back = makeBackend();
  back.profile.is_admin = false;
  await stub(page, back);

  await page.goto(origin + '/index.html' + SESSION);
  await page.waitForSelector('.nav');
  check('nur für Admins: kein Eintrag in der Leiste',
    (await page.locator('.nav__item[href="admin.html"]').count()) === 0);

  await page.goto(origin + '/admin.html' + SESSION);
  await page.waitForSelector('.status__emoji');
  check('nur für Admins: die Seite selbst weist ab',
    (await page.textContent('.status p')).includes('nur verwalten'));
  check('nur für Admins: und bietet kein Formular an',
    await page.locator('.compose').isHidden());
  await context.close();
}

// --- 6b. Rezepte -----------------------------------------------------------
{
  const context = await browser.newContext({ viewport: { width: 414, height: 860 } });
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  page.on('console', (m) => {
    // Die Zeilen zu den beiden absichtlich provozierten Absagen (Namenskonflikt
    // und Prüfregel) werden unten einzeln gezählt — hier wären sie nur
    // Rauschen. Jede ANDERE Absage bleibt ein Fehler.
    if (m.type() === 'error' && !/status of (400|409)/.test(m.text())) errors.push(m.text());
  });
  const back = makeBackend();
  await stub(page, back);

  /*
   * Der abgewiesene Slug wird vom Browser als Fehler protokolliert, obwohl die
   * App ihn abfängt. Ihn wegzufiltern wäre schade — gezählt beweist er, dass
   * die Wiederholung auf eine ECHTE Absage reagiert und nicht auf eine
   * vorsorglich umbenannte Adresse, die nie irgendwo angeeckt ist.
   */
  const abgelehnt = [];
  page.on('response', (r) => { if (r.status() >= 400) abgelehnt.push(r.status()); });

  const scratch = await context.newPage();
  await scratch.goto('about:blank');
  const kuchen = await makeJpeg(scratch, 900, 700, 25, 'Kuchen');
  await scratch.close();
  images.set('rezepte/omas-apfelkuchen/eins_thumb.jpg', kuchen);
  images.set('rezepte/omas-apfelkuchen/eins.jpg', kuchen);
  images.set('rezepte/omas-apfelkuchen/zwei_thumb.jpg', kuchen);
  images.set('rezepte/omas-apfelkuchen/zwei.jpg', kuchen);

  back.recipes = [
    { id: 'rz-1', slug: 'omas-apfelkuchen', title: "Omas Apfelkuchen", servings: 8,
      ingredients: '500 g Mehl\n\n3 Eier\neine Prise Salz',
      steps: 'Alles verrühren.\nEine Stunde ruhen lassen.',
      note: 'Schmeckt am zweiten Tag besser.',
      created_by: 'user-1', created_at: '2026-08-01T10:00:00Z',
      profiles: { people: { name: 'Maria' } } },
    { id: 'rz-2', slug: 'brotaufstrich', title: 'Brotaufstrich', servings: null,
      ingredients: 'Was da ist', steps: '', note: null,
      created_by: 'user-9', created_at: '2026-08-02T10:00:00Z',
      profiles: { people: { name: 'Ines' } } }
  ];
  // Absichtlich in der falschen Reihenfolge und mit einer Lücke in den Zahlen:
  // sortiert werden muss nach `sort_order`, nicht nach Ankunft.
  back.recipePhotos = [
    { id: 'rp-2', recipe_id: 'rz-1', storage_path: 'rezepte/omas-apfelkuchen/zwei.jpg',
      thumb_path: 'rezepte/omas-apfelkuchen/zwei_thumb.jpg', sort_order: 7, uploaded_by: 'user-9' },
    { id: 'rp-1', recipe_id: 'rz-1', storage_path: 'rezepte/omas-apfelkuchen/eins.jpg',
      thumb_path: 'rezepte/omas-apfelkuchen/eins_thumb.jpg', sort_order: 3, uploaded_by: 'user-1' }
  ];

  await page.goto(origin + '/rezepte.html' + SESSION);
  await page.waitForSelector('.shelf__card');
  await shot(page, '7-rezepte');
  check('rezepte: das Regal zeigt alle', (await page.locator('.shelf__card').count()) === 2);
  check('rezepte: ein Rezept ohne Bild bekommt kein leeres graues Feld',
    (await page.locator('.shelf__cover--none').count()) === 1);
  check('rezepte: für wie viele und von wem',
    (await page.locator('.shelf__count').first().textContent()) === 'für 8 · von Maria',
    await page.locator('.shelf__count').first().textContent());

  await page.locator('.shelf__card').first().click();
  await page.waitForSelector('.rezept');
  check('rezepte: ein Rezept hat eine eigene Adresse',
    page.url().includes('rezept=omas-apfelkuchen'), page.url());

  // Der Kern: eine Zeile ist ein Punkt, leere Zeilen sind keine.
  check('rezepte: Zutaten werden zur Liste, eine Zeile ein Punkt',
    (await page.locator('.rezept__zutaten li').allTextContents()).join('|')
      === '500 g Mehl|3 Eier|eine Prise Salz',
    JSON.stringify(await page.locator('.rezept__zutaten li').allTextContents()));
  check('rezepte: die Zubereitung ist nummeriert',
    (await page.locator('.rezept__schritte li').count()) === 2);
  // "500 g Mehl" bleibt eine Zeile, wie jemand sie aufgeschrieben hat.
  check('rezepte: keine Menge wird aus der Zutat herausgeraten',
    (await page.locator('.rezept__zutaten li').first().textContent()) === '500 g Mehl');

  await shot(page, '7-rezept');
  check('rezepte: das Hauptbild ist das mit der kleinsten Zahl, nicht das erste geladene',
    (await page.locator('.rezept__rahmen').first().locator('img.is-cover').count()) === 1 &&
    (await page.locator('.rezept__bild.is-cover').count()) === 1);

  // Zum Hauptbild machen: unter ALLE anderen, nicht auf eine feste Zahl.
  await page.locator('.rezept__cover').first().click();
  await page.waitForFunction(() => !!document.querySelector('.rezept'));
  const umsortiert = back.patches.filter((i) => i.table === 'recipe_photos').pop();
  check('rezepte: zum Hauptbild machen schiebt es unter alle anderen',
    umsortiert.row.sort_order === 2 && umsortiert.query.includes('id=eq.rp-2'),
    JSON.stringify(umsortiert));

  // Ein fremdes Rezept: dieses Konto ist Admin, darf also trotzdem.
  await page.goto(origin + '/rezepte.html?rezept=brotaufstrich');
  await page.waitForSelector('.rezept');
  check('rezepte: Admins dürfen auch fremde bearbeiten',
    (await page.locator('.rezept__tools .btn--danger').count()) === 1);

  // Aufschreiben.
  await page.goto(origin + '/rezepte.html');
  await page.waitForSelector('.shelf__card');
  await page.click('.topbar__actions .btn--primary');
  await page.fill('.confirm input[type=text]', 'Kartoffelsalat');
  await page.locator('.confirm textarea').nth(0).fill('Kartoffeln\nEssig');
  await page.click('.confirm__actions .btn--primary');
  await page.waitForFunction(() => location.search.includes('rezept='));
  const neu = back.inserts.find((i) => i.table === 'recipes').row;
  check('rezepte: aufschreiben nimmt das eigene Konto und einen sauberen Slug',
    neu.title === 'Kartoffelsalat' && neu.slug === 'kartoffelsalat' &&
    neu.created_by === 'user-1' && neu.ingredients === 'Kartoffeln\nEssig',
    JSON.stringify(neu));
  check('rezepte: und landet direkt beim neuen Rezept',
    page.url().includes('rezept=kartoffelsalat'), page.url());

  // Ohne alles ist es kein Rezept.
  await page.goto(origin + '/rezepte.html');
  await page.waitForSelector('.shelf__card');
  const vorher = back.inserts.filter((i) => i.table === 'recipes').length;
  await page.click('.topbar__actions .btn--primary');
  await page.fill('.confirm input[type=text]', 'Nichts drin');
  await page.click('.confirm__actions .btn--primary');
  await page.waitForSelector('.toast');
  check('rezepte: ohne Zutaten und ohne Zubereitung wird nichts geschickt',
    back.inserts.filter((i) => i.table === 'recipes').length === vorher &&
    (await page.locator('.toast').last().textContent()).includes('kein Rezept'),
    await page.locator('.toast').last().textContent());

  /*
   * Die Datenbank darf nie wörtlich auf dem Telefon landen.
   *
   * Beides ist echt passiert: „für wie viele" mit 4113 beantwortet, und was
   * zurückkam, war `recipes_servings_check`.
   */
  await page.goto(origin + '/rezepte.html');
  await page.waitForSelector('.shelf__card');
  const vorPortionen = back.inserts.filter((i) => i.table === 'recipes').length;
  await page.click('.topbar__actions .btn--primary');
  await page.fill('.confirm input[type=text]', 'Butterbrot');
  await page.fill('.confirm input[type=number]', '4113');
  await page.locator('.confirm textarea').nth(0).fill('3 Scheiben Graubrot');
  await page.click('.confirm__actions .btn--primary');
  await page.waitForSelector('.toast');
  const portionsHinweis = await page.locator('.toast').last().textContent();
  check('rezepte: 4113 Portionen wird gar nicht erst losgeschickt',
    back.inserts.filter((i) => i.table === 'recipes').length === vorPortionen,
    'es ging trotzdem raus');
  check('rezepte: und der Hinweis nennt die erlaubte Spanne, nicht die Prüfregel',
    portionsHinweis.includes('1 bis 99') && !portionsHinweis.includes('_check'),
    portionsHinweis);

  // Eine halbe Portion ist genauso wenig eine Portionszahl. Mit PUNKT, weil
  // ein Zahlenfeld das deutsche Komma schon selbst nicht annimmt — daraus wird
  // ein leeres Feld, und leer heißt zulässigerweise "steht nicht dabei".
  await page.fill('.confirm input[type=number]', '2.5');
  await page.click('.confirm__actions .btn--primary');
  check('rezepte: auch eine krumme Zahl kommt nicht durch',
    back.inserts.filter((i) => i.table === 'recipes').length === vorPortionen);

  // Und leer bleibt erlaubt — auf den meisten Karteikarten steht es nicht.
  await page.fill('.confirm input[type=number]', '');
  await page.click('.confirm__actions .btn--primary');
  await page.waitForFunction(() => location.search.includes('rezept=butterbrot'));
  check('rezepte: ohne Angabe geht es weiterhin durch',
    back.inserts.filter((i) => i.table === 'recipes').pop().row.servings === null);

  /*
   * Zwei Rezepte dürfen gleich heißen. „Weihnachten" gibt es jedes Jahr, und
   * Kartoffelsalat kocht jede Familie zweimal.
   */
  await page.goto(origin + '/rezepte.html');
  await page.waitForSelector('.shelf__card');
  await page.click('.topbar__actions .btn--primary');
  await page.fill('.confirm input[type=text]', 'Butterbrot');
  await page.locator('.confirm textarea').nth(0).fill('Brot');
  await page.click('.confirm__actions .btn--primary');
  await page.waitForFunction(() => location.search.includes('rezept=butterbrot-2'));
  check('rezepte: der gleiche Name nochmal wird -2, nicht "Das gibt es schon"',
    page.url().includes('rezept=butterbrot-2') &&
    (await page.locator('.toast--error').count()) === 0,
    page.url());
  const beideVersuche = back.inserts.filter((i) => i.table === 'recipes' && i.row.title === 'Butterbrot');
  check('rezepte: der Titel bleibt dabei unangetastet',
    beideVersuche.every((i) => i.row.title === 'Butterbrot'));
  check('rezepte: und die Umbenennung folgt auf eine echte Absage, nicht auf Verdacht',
    abgelehnt.filter((s) => s === 409).length === 1, JSON.stringify(abgelehnt));

  await page.goto(origin + '/rezepte.html');
  await page.waitForSelector('.shelf__card');
  await page.click('.topbar__actions .btn--primary');
  await page.fill('.confirm input[type=text]', 'Prüfregel');
  await page.locator('.confirm textarea').nth(0).fill('Irgendwas');
  await page.click('.confirm__actions .btn--primary');
  await page.waitForSelector('.toast--error');
  const roh = await page.locator('.toast--error').last().textContent();
  check('rezepte: eine verletzte Prüfregel kommt auf Deutsch an, nicht als Postgres',
    !/violates|check constraint|_check|relation/.test(roh), roh);
  check('rezepte: und der Satz sagt, um welches Feld es geht',
    roh.includes('für wie viele Personen'), roh);
  await shot(page, '7-rezept-fehler');

  // Genau die beiden provozierten Absagen, keine dritte.
  check('rezepte: sonst hat der Server nichts abgelehnt',
    abgelehnt.length === 2 && abgelehnt.includes(409) && abgelehnt.includes(400),
    JSON.stringify(abgelehnt));
  check('rezepte: keine Fehler', errors.length === 0, errors.join('\n'));
  await context.close();
}

// --- 6c. Neues: die Seite, die einen abfängt --------------------------------
{
  const context = await browser.newContext({ viewport: { width: 414, height: 860 } });
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  const back = makeBackend();
  await stub(page, back);

  const scratch = await context.newPage();
  await scratch.goto('about:blank');
  images.set('evas-treff/n1_thumb.jpg', await makeJpeg(scratch, 200, 200, 90, 'A'));
  images.set('evas-treff/n2_thumb.jpg', await makeJpeg(scratch, 200, 200, 190, 'B'));
  await scratch.close();

  back.albums = [
    { id: 'alb-1', slug: 'evas-treff', title: "Eva's Treff", event_date: '2026-08-07', photos: [{ count: 9 }] }
  ];
  /*
   * Die Gesichter-Karte gehört dazu, auch wenn hier kein Gesicht geprüft wird.
   *
   * Ohne sie steigt `PS.people.display()` sofort wieder aus, und der Weg, der
   * dahinter liegt, wird nie betreten. Genau daran ist der erste Versuch
   * gescheitert: `neues.html` lud `album.js` nicht, `people.js` braucht es —
   * und der Test lief trotzdem grün, weil er nie so weit kam.
   */
  back.people = [
    { name: 'Ben',   face_x: 0.5,  face_y: 0.4, aliases: [] },
    { name: 'Ines',  face_x: 0.13, face_y: 0.39, aliases: [] },
    { name: 'Maria', face_x: 0.78, face_y: 0.39, aliases: [] }
  ];
  back.news = {
    since: '2026-08-01T00:00:00Z',
    announcements: {
      unread: 1,
      items: [
        { id: 'an-1', body: 'Die Oma ist wieder zu Hause.', until: null,
          author: 'Ben', at: '2026-08-10T09:00:00Z', unread: true },
        { id: 'an-2', body: 'Grillfest am Samstag bei uns im Garten.', until: '2026-08-20',
          author: 'Ben', at: '2026-08-02T09:00:00Z', unread: false }
      ]
    },
    photos: { count: 4, albums: [
      { slug: 'evas-treff', title: "Eva's Treff", count: 4, videos: 1,
        thumbs: ['evas-treff/n1_thumb.jpg', 'evas-treff/n2_thumb.jpg'] }
    ] },
    comments: { count: 1, items: [{ author: 'Ines', body: 'Schöner Abend!', photo_id: 'ph-1', album: 'evas-treff' }] },
    posts: { count: 0, items: [] },
    recipes: { count: 1, items: [{ slug: 'omas-apfelkuchen', title: 'Omas Apfelkuchen', author: 'Maria' }] },
    events: { count: 0, items: [] }
  };

  /*
   * Der Kern des Wunsches: beim BETRETEN abgefangen werden, nicht erst wenn
   * man selbst nachsieht.
   */
  await page.goto(origin + '/index.html' + SESSION);
  await page.waitForURL(/neues\.html/, { timeout: 15000 });
  await page.waitForSelector('.aushang');
  check('neues: wer die Seite betritt, landet bei den Neuigkeiten', true);

  // Oben die Mitteilung — der eigentliche Grund für die Seite.
  check('neues: die Mitteilung steht ganz oben',
    (await page.locator('.neues > *').first().evaluate((n) => n.className)).indexOf('aushang') >= 0 ||
    (await page.locator('.aushang').first().textContent()).includes('Oma'),
    await page.locator('.neues > *').first().evaluate((n) => n.className));
  check('neues: ungelesen wird hervorgehoben, gelesen bleibt lesbar',
    (await page.locator('.aushang.is-new').count()) === 1 &&
    (await page.locator('.aushang').count()) === 2);
  check('neues: der gültige Aushang nennt sein Datum',
    (await page.locator('.aushang').nth(1).textContent()).includes('gilt bis'),
    await page.locator('.aushang').nth(1).textContent());

  // Darunter, was von selbst angefallen ist.
  check('neues: neue Aufnahmen mit Vorschau',
    (await page.locator('.neuigkeit__bilder img').count()) === 2);
  // Ein Video ist kein Foto — dieselbe Regel wie beim Hochladen.
  check('neues: und die Zählung trennt Fotos von Videos',
    (await page.locator('.neuigkeit').first().textContent()).includes('3 Fotos und 1 Video'),
    await page.locator('.neuigkeit').first().textContent());

  // NUR was es gibt: Pinnwand und Termine sind leer, also stehen sie nicht da.
  const rubriken = await page.locator('.neuigkeit__head').allTextContents();
  check('neues: leere Rubriken erscheinen gar nicht erst',
    rubriken.length === 3 && !rubriken.join('|').includes('Pinnwand') &&
    !rubriken.join('|').includes('Termin'),
    JSON.stringify(rubriken));

  // Gesehen ist gesehen. Das Merken läuft absichtlich NACH dem Zeichnen und
  // ohne darauf zu warten, also hier kurz nachfassen statt sofort zu urteilen.
  for (let i = 0; i < 50 && !back.patches.some((x) => x.table === 'profiles'); i++) {
    await page.waitForTimeout(100);
  }
  const merker = back.patches.filter((i) => i.table === 'profiles');
  check('neues: das Gesehen-Datum wird gesetzt',
    merker.length === 1 && !!merker[0].row.news_seen_at, JSON.stringify(merker));

  /*
   * Nachlesen können, was schon gelesen ist.
   *
   * Oben steht nur Ungelesenes und noch Gültiges — ohne diesen Weg wäre eine
   * einmal gelesene Mitteilung für immer unsichtbar, obwohl sie in der
   * Datenbank steht.
   */
  back.announcements = [
    { id: 'an-1', body: 'Die Oma ist wieder zu Hause.', until: null,
      created_at: '2026-08-10T09:00:00Z', profiles: { people: { name: 'Ben' } } },
    { id: 'an-2', body: 'Grillfest am Samstag bei uns im Garten.', until: '2026-08-20',
      created_at: '2026-08-02T09:00:00Z', profiles: { people: { name: 'Ben' } } },
    { id: 'an-alt', body: 'Der Zaun ist gestrichen.', until: null,
      created_at: '2026-07-01T09:00:00Z', profiles: { people: { name: 'Ben' } } }
  ];
  /*
   * Ein Knopf, der für elf Leute löscht, darf nicht wie „zumachen" aussehen.
   *
   * Hier stand ein × oben rechts, und genau so wurde es verstanden: „Die News
   * schließe ich über das x?" — worauf die Rückfrage kam, ob gelöscht werden
   * soll. Die Seite hat gar kein Schließen; man geht über „Zu den Alben".
   */
  check('mitteilung: der Löschknopf ist kein Schließen-Kreuz',
    (await page.locator('.aushang__delete').first().textContent()) !== '×' &&
    (await page.locator('.aushang .comment__remove').count()) === 0,
    await page.locator('.aushang__delete').first().textContent());
  check('mitteilung: und sagt im Titel, dass es alle trifft',
    (await page.getAttribute('.aushang__delete', 'title')).includes('für alle'),
    await page.getAttribute('.aushang__delete', 'title'));

  // Die Rückfrage muss dasselbe sagen — und welche Mitteilung gemeint ist.
  let gefragt = null;
  page.once('dialog', (d) => { gefragt = d.message(); d.dismiss(); });
  await page.locator('.aushang__delete').first().click();
  await page.waitForFunction(() => true);
  for (let i = 0; i < 30 && gefragt === null; i++) await page.waitForTimeout(50);
  check('mitteilung: die Rückfrage nennt "für ALLE" und zitiert den Anfang',
    /für ALLE/.test(gefragt || '') && /Oma/.test(gefragt || ''), String(gefragt));
  check('mitteilung: und Abbrechen löscht nichts',
    !back.deletes.some((d) => d.table === 'announcements'),
    JSON.stringify(back.deletes));

  check('archiv: geschlossen, solange niemand fragt',
    (await page.locator('.archiv__open').count()) === 1 &&
    (await page.locator('.archiv .aushang').count()) === 0);

  await page.click('.archiv__open');
  await page.waitForSelector('.archiv .aushang');
  const frueher = await page.locator('.archiv .aushang__text').allTextContents();
  check('archiv: zeigt die alte Mitteilung, die oben nicht mehr steht',
    frueher.length === 1 && frueher[0].includes('Zaun'), JSON.stringify(frueher));
  // Was oben schon steht, darf unten nicht nochmal stehen.
  check('archiv: und wiederholt nicht, was oben schon steht',
    (await page.locator('.aushang__text').allTextContents())
      .filter((t) => t.includes('Oma')).length === 1);

  await shot(page, '8-neues');

  /*
   * Und danach hält sie niemanden mehr auf. Ohne diese Sperre wäre eine
   * Schleife möglich, die die Familie komplett aussperrt.
   */
  back.news.announcements.unread = 0;
  back.news.photos = { count: 0, albums: [] };
  back.news.comments = { count: 0, items: [] };
  back.news.recipes = { count: 0, items: [] };
  await page.goto(origin + '/index.html');
  await page.waitForSelector('.tile, .status');
  check('neues: beim nächsten Mal geht es direkt in die Alben',
    !page.url().includes('neues.html'), page.url());

  check('neues: keine Fehler', errors.length === 0, errors.join('\n'));
  await context.close();
}

// --- 6d. eine kaputte Neuigkeitsabfrage darf die Alben nicht blockieren -----
{
  const context = await browser.newContext({ viewport: { width: 414, height: 860 } });
  const page = await context.newPage();
  const back = makeBackend();
  await stub(page, back);
  back.albums = [
    { id: 'alb-1', slug: 'evas-treff', title: "Eva's Treff", event_date: '2026-08-07', photos: [{ count: 0 }] }
  ];
  // Die Funktion antwortet nicht. Die Alben müssen trotzdem aufgehen — sonst
  // sperrt ein Nebenschauplatz die ganze App zu.
  await page.route(SB + '/rest/v1/rpc/news_for_me', (route) => route.fulfill({
    status: 500, headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ message: 'kaputt' })
  }));

  await page.goto(origin + '/index.html' + SESSION);
  await page.waitForSelector('.topbar__title', { timeout: 15000 });
  check('neues: fällt die Abfrage aus, geht es geradeaus in die Alben',
    !page.url().includes('neues.html'), page.url());
  await context.close();
}

// --- 6e. eine Mitteilung schreiben (nur Admins) -----------------------------
{
  const context = await browser.newContext({ viewport: { width: 414, height: 860 } });
  const page = await context.newPage();
  const back = makeBackend();
  await stub(page, back);

  await page.goto(origin + '/neues.html' + SESSION);
  await page.waitForSelector('.neues__tools');
  await page.click('.neues__tools .btn');
  await page.fill('.confirm textarea', 'Am Sonntag Kaffee bei Oma.');
  await page.fill('.confirm input[type=date]', '2026-08-30');
  await page.click('.confirm__actions .btn--primary');
  await page.waitForFunction(() => !document.querySelector('.confirm:not(.is-hidden)'));

  const row = back.inserts.find((i) => i.table === 'announcements').row;
  check('neues: die Mitteilung geht mit Text und Gültigkeit raus',
    row.body === 'Am Sonntag Kaffee bei Oma.' && row.until === '2026-08-30' &&
    row.created_by === 'user-1', JSON.stringify(row));

  // Ohne Text gibt es nichts mitzuteilen.
  const vorher = back.inserts.filter((i) => i.table === 'announcements').length;
  await page.click('.neues__tools .btn');
  await page.click('.confirm__actions .btn--primary');
  await page.waitForSelector('.toast');
  check('neues: ohne Text wird nichts ausgehängt',
    back.inserts.filter((i) => i.table === 'announcements').length === vorher);
  await context.close();
}

// --- 6f. ein normales Konto darf nichts aushängen ---------------------------
{
  const context = await browser.newContext({ viewport: { width: 414, height: 860 } });
  const page = await context.newPage();
  const back = makeBackend();
  back.profile = Object.assign({}, back.profile, { is_admin: false });
  await stub(page, back);

  await page.goto(origin + '/neues.html' + SESSION);
  await page.waitForSelector('.neues');
  // Der Knopf ist weg — die Datenbank sagt ohnehin nein, aber ein Knopf, der
  // nur "geht nicht" kann, gehört nicht hin.
  check('neues: ohne Adminrecht kein Schreibknopf',
    (await page.locator('.neues__tools').count()) === 0);
  await context.close();
}

// --- 6h. die Sicherung ------------------------------------------------------
{
  const context = await browser.newContext({
    viewport: { width: 900, height: 900 }, acceptDownloads: true
  });
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  const back = makeBackend();
  await stub(page, back);

  /*
   * Den „Speichern unter"-Dialog wegnehmen.
   *
   * Chromium kann direkt auf die Platte schreiben, aber diesen Dialog kann
   * kein Test bedienen. Also wird hier der andere Weg geprüft — derselbe, den
   * Firefox und Safari ohnehin gehen: alles im Arbeitsspeicher sammeln und als
   * Download anbieten. Das ZIP entsteht in beiden Fällen aus demselben Code,
   * verschieden ist nur, wohin die fertigen Stücke fließen.
   */
  await page.addInitScript(() => {
    Object.defineProperty(window, 'showSaveFilePicker', { value: undefined, configurable: true });
  });

  const scratch = await context.newPage();
  await scratch.goto('about:blank');
  const bild = await makeJpeg(scratch, 400, 300, 30, 'Kuchen');
  const clip = await makeWebm(scratch, 240, 180, 200, 700);
  await scratch.close();
  images.set('evas-treff/aaaa1111.jpg', bild);
  images.set('evas-treff/aaaa1111_thumb.jpg', bild);
  images.set('evas-treff/bbbb2222.webm', clip);
  images.set('evas-treff/bbbb2222_thumb.jpg', bild);
  images.set('photo.jpg', bild);

  back.albums = [
    { id: 'alb-1', slug: 'evas-treff', title: "Eva's Treff", event_date: '2026-08-07' }
  ];
  back.photos = [
    { id: 'ph-1', album_id: 'alb-1', storage_path: 'evas-treff/aaaa1111.jpg',
      thumb_path: 'evas-treff/aaaa1111_thumb.jpg', content_hash: 'aaaa1111',
      media_type: 'image', duration_seconds: null, bytes: bild.length,
      taken_at: '2026-08-07T21:33:00Z', uploader_id: 'user-1', uploader_name: 'Maria', comments: [] },
    { id: 'ph-2', album_id: 'alb-1', storage_path: 'evas-treff/bbbb2222.webm',
      thumb_path: 'evas-treff/bbbb2222_thumb.jpg', content_hash: 'bbbb2222',
      media_type: 'video', duration_seconds: 0.7, bytes: clip.length,
      taken_at: '2026-08-07T20:10:00Z', uploader_id: 'user-1', uploader_name: 'Ines', comments: [] }
  ];
  back.people = [{ name: 'Maria', face_x: 0.7, face_y: 0.4, aliases: [] }];

  await page.goto(origin + '/sicherung.html' + SESSION);
  await page.waitForSelector('.sicherung .btn--big');
  check('sicherung: sagt vorher, was hineinkommt',
    (await page.textContent('.sicherung .panel')).includes('5 Dateien'),
    (await page.textContent('.sicherung .panel')).slice(0, 160));
  // Und sagt ehrlich, welchen Weg dieser Browser nimmt.
  check('sicherung: warnt, wenn der Browser nicht direkt auf die Platte schreiben kann',
    (await page.textContent('.sicherung .panel')).includes('Arbeitsspeicher'));

  await shot(page, '9-sicherung');
  const download = page.waitForEvent('download', { timeout: 60000 });
  await page.click('.sicherung .btn--big');
  const datei = await download;
  await page.waitForSelector('.sicherung__fertig', { timeout: 60000 });

  const ordner = await mkdtemp(path.join(os.tmpdir(), 'sicherung-'));
  const ziel = path.join(ordner, 'sicherung.zip');
  await datei.saveAs(ziel);

  /*
   * Von einem ECHTEN Entpacker prüfen lassen.
   *
   * Der ZIP-Schreiber ist selbst geschrieben. Ihn mit dem eigenen Leser zu
   * prüfen hieße, sich seine eigenen Fehler bestätigen zu lassen — eine
   * Sicherung, die nur diese App öffnen kann, ist keine Sicherung. Also
   * entscheidet Pythons `zipfile`, inklusive aller CRC-Prüfsummen.
   */
  const bericht = JSON.parse(execFileSync('python3', ['-c', `
import zipfile, json, sys
z = zipfile.ZipFile(sys.argv[1])
kaputt = z.testzip()
namen = z.namelist()
print(json.dumps({
  'kaputt': kaputt,
  'namen': namen,
  'daten': json.loads(z.read('daten.json').decode()) and True,
  'alben': sorted(n for n in namen if n.startswith('Alben/')),
  'jpeg': z.read([n for n in namen if n.startswith('Alben/') and n.endswith('.jpg')][0])[:2].hex(),
  'webm': z.read([n for n in namen if n.endswith('.webm')][0])[:2].hex(),
  'liesmich': z.read('LIESMICH.txt').decode()[:40]
}))
`, ziel], { encoding: 'utf8' }));

  check('sicherung: ein echtes Entpackprogramm öffnet die Datei',
    bericht.kaputt === null, 'kaputter Eintrag: ' + bericht.kaputt);
  check('sicherung: die Bilder liegen unter lesbaren Namen statt unter Hashes',
    bericht.alben.length === 2 &&
    bericht.alben.every((n) => n.startsWith("Alben/Eva's Treff/2026-08-07_")) &&
    bericht.alben.some((n) => n.includes('Maria')) &&
    bericht.alben.some((n) => n.includes('Ines')),
    JSON.stringify(bericht.alben));
  check('sicherung: das Video ist als Video drin, das Foto als JPEG',
    bericht.jpeg === 'ffd8' && bericht.webm === '1a45',
    bericht.jpeg + ' / ' + bericht.webm);
  check('sicherung: die Tabellen liegen als daten.json bei', bericht.daten === true);
  check('sicherung: mit einer LIESMICH, die erklärt was das ist',
    bericht.liesmich.includes('Sicherung von Evas Treff'), bericht.liesmich);
  check('sicherung: die Vorschaubilder behalten ihren Original-Pfad',
    bericht.namen.some((n) => n === 'Vorschaubilder/evas-treff/aaaa1111_thumb.jpg'),
    JSON.stringify(bericht.namen));
  check('sicherung: und das Gruppenfoto ist dabei',
    bericht.namen.includes('Familie/Gruppenfoto.jpg'), JSON.stringify(bericht.namen));

  check('sicherung: keine Fehler', errors.length === 0, errors.join('\n'));
  await context.close();
}

// --- 6i. ohne Adminrecht gibt es keine Sicherung ----------------------------
{
  const context = await browser.newContext({ viewport: { width: 414, height: 860 } });
  const page = await context.newPage();
  const back = makeBackend();
  back.profile = Object.assign({}, back.profile, { is_admin: false });
  await stub(page, back);

  await page.goto(origin + '/sicherung.html' + SESSION);
  await page.waitForSelector('.status');
  check('sicherung: ohne Adminrecht kein Knopf',
    (await page.locator('.btn--big').count()) === 0 &&
    (await page.textContent('.status')).includes('Administratoren'),
    await page.textContent('.status'));
  await context.close();
}

// --- 6j. Benachrichtigungen: der Schalter je Gerät --------------------------
{
  /*
   * Die Browser-Schnittstellen werden hier NACHGEBAUT.
   *
   * Eine echte Anmeldung bei Google oder Apple lässt sich aus einem Testlauf
   * nicht herstellen — `pushManager.subscribe` bräuchte einen echten
   * Push-Dienst. Was sich prüfen lässt und worauf es ankommt: dass die
   * Oberfläche für jeden Zustand das Richtige zeigt, und dass die Anmeldung
   * mit den richtigen Werten in der Datenbank landet.
   *
   * Die Verschlüsselung selbst hängt nicht an diesem Test: die rechnet das
   * Beispiel aus RFC 8291 nach (`npm run check:push`).
   */
  const faelle = [
    {
      was: 'iPhone im Safari-Tab', erwartet: 'Startbildschirm',
      skript: () => {
        Object.defineProperty(navigator, 'userAgent',
          { get: () => 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X)' });
        delete window.PushManager;
      }
    },
    {
      was: 'Browser ohne Benachrichtigungen', erwartet: null,
      skript: () => { delete window.PushManager; delete window.Notification; }
    }
  ];

  for (const fall of faelle) {
    const context = await browser.newContext({ viewport: { width: 414, height: 860 } });
    const page = await context.newPage();
    const back = makeBackend();
    await stub(page, back);
    await page.addInitScript(fall.skript);
    await page.goto(origin + '/neues.html' + SESSION);
    /*
     * Auf den Archiv-Bereich warten — der steht IMMER am Ende von `render()`.
     *
     * Zwei Anläufe waren falsch. Erst auf die Glocke: die ist bei einem
     * Browser ohne Push ein leeres <div>, und leere Glocken blendet das CSS
     * aus — der Testlauf wartete auf etwas, das nie sichtbar wird. Dann auf
     * „kein Ladekreisel mehr": das trifft auch VOR seinem Erscheinen zu, also
     * las der Test die noch leere Seite.
     *
     * Was gebraucht wird, ist ein Zeichen dafür, dass gezeichnet WURDE.
     */
    await page.waitForSelector('.neues .archiv');
    const text = await page.textContent('.neues');
    check('push: ' + fall.was + ' → ' + (fall.erwartet || 'gar kein Schalter'),
      fall.erwartet ? text.includes(fall.erwartet)
        : (!text.includes('Benachrichtigungen einschalten') && !text.includes('Startbildschirm')),
      'gezeigt wurde: ' + JSON.stringify(text.slice(0, 200)));
    await context.close();
  }

  // Ein Gerät, das es kann: einschalten muss die Anmeldung wirklich speichern.
  {
    const context = await browser.newContext({ viewport: { width: 414, height: 860 } });
    const page = await context.newPage();
    const errors = [];
    page.on('pageerror', (e) => errors.push(String(e)));
    const back = makeBackend();
    await stub(page, back);

    await page.addInitScript(() => {
      Object.defineProperty(navigator, 'userAgent',
        { get: () => 'Mozilla/5.0 (Linux; Android 14) Chrome/120' });
      let angemeldet = null;
      const fakeSub = {
        endpoint: 'https://fcm.example/abc123',
        toJSON: () => ({ keys: { p256dh: 'PPPP', auth: 'AAAA' } }),
        unsubscribe: async () => { angemeldet = null; return true; }
      };
      const reg = {
        pushManager: {
          getSubscription: async () => angemeldet,
          subscribe: async (opts) => {
            window.__key = new Uint8Array(opts.applicationServerKey).length;
            angemeldet = fakeSub;
            return fakeSub;
          }
        }
      };
      Object.defineProperty(navigator, 'serviceWorker', {
        configurable: true,
        get: () => ({ register: async () => reg, getRegistration: async () => reg, ready: Promise.resolve(reg) })
      });
      window.PushManager = function () {};
      window.Notification = { permission: 'default', requestPermission: async () => {
        window.Notification.permission = 'granted'; return 'granted';
      } };
    });

    await page.goto(origin + '/neues.html' + SESSION);
    await page.waitForSelector('.glocke .btn');
    check('push: ein fähiges Gerät bekommt den Einschalter',
      (await page.textContent('.glocke')).includes('einschalten'));

    await page.click('.glocke .btn');
    await page.waitForSelector('.glocke__an');
    const row = back.inserts.find((i) => i.table === 'push_subscriptions').row;
    check('push: die Anmeldung landet mit Adresse und beiden Schlüsseln in der Datenbank',
      row.endpoint === 'https://fcm.example/abc123' && row.p256dh === 'PPPP' &&
      row.auth === 'AAAA' && row.profile_id === 'user-1', JSON.stringify(row));
    check('push: als Upsert auf die Adresse, damit dasselbe Gerät nicht doppelt zählt',
      /on_conflict=endpoint/.test(JSON.stringify(back.queries)) ||
      /merge-duplicates/.test(back.inserts[back.inserts.length - 1].prefer || ''),
      JSON.stringify(back.inserts[back.inserts.length - 1].prefer));
    // Der Schlüssel muss der unkomprimierte P-256-Punkt sein: 65 Byte.
    check('push: der Anmeldung wird der öffentliche VAPID-Schlüssel mitgegeben (65 Byte)',
      (await page.evaluate(() => window.__key)) === 65,
      String(await page.evaluate(() => window.__key)));
    check('push: das Gerät wird benannt, damit man es wiedererkennt',
      row.device === 'Android-Handy', row.device);

    await page.click('.glocke .btn--ghost');
    await page.waitForSelector('.glocke .btn:not(.btn--ghost)');
    check('push: ausschalten meldet das Gerät auch in der Datenbank ab',
      back.deletes.some((d) => d.table === 'push_subscriptions'), JSON.stringify(back.deletes));

    check('push: keine Fehler', errors.length === 0, errors.join('\n'));
    await context.close();
  }
}

// --- 6k. die Vorfrage: die Frage findet EINEN, nicht umgekehrt ---------------
{
  /*
   * Der Schalter auf der Neues-Seite reicht nicht — dorthin kommt man nur,
   * wenn es gerade etwas Neues gibt. Also fragt die Alben-Seite von sich aus,
   * einmal je Gerät und Person.
   *
   * Der Browser-Dialog selbst wird hier NACHGEBAUT (siehe 6j): eine echte
   * Anmeldung bei Google gibt es im Testlauf nicht. Geprüft wird das, worauf
   * es ankommt — wann die Karte kommt, wann nicht, und dass ein „Ja" wirklich
   * anmeldet.
   */

  /*
   * Ein Gerät, das Benachrichtigungen kann. `erlaubnis` ist der Startzustand.
   *
   * Als ARGUMENT von `addInitScript` übergeben, nicht als Closure eingefangen.
   * Playwright überträgt nur den Quelltext der Funktion in die Seite; eine
   * eingefangene Variable ist dort nicht definiert. Genau darüber bin ich hier
   * gestolpert: die Seite warf „erlaubnis is not defined", der echte
   * Notification-Zustand blieb stehen, und der Test las 'denied' statt
   * 'default'. Das sah aus wie ein Fehler im Code und war einer im Test.
   */
  const faehig = (erlaubnis) => {
    Object.defineProperty(navigator, 'userAgent',
      { get: () => 'Mozilla/5.0 (Linux; Android 14) Chrome/120' });
    let angemeldet = null;
    const fakeSub = {
      endpoint: 'https://fcm.example/vorfrage',
      toJSON: () => ({ keys: { p256dh: 'PPPP', auth: 'AAAA' } }),
      unsubscribe: async () => { angemeldet = null; return true; }
    };
    const reg = {
      pushManager: {
        getSubscription: async () => angemeldet,
        subscribe: async () => { angemeldet = fakeSub; return fakeSub; }
      }
    };
    Object.defineProperty(navigator, 'serviceWorker', {
      configurable: true,
      get: () => ({ register: async () => reg, getRegistration: async () => reg, ready: Promise.resolve(reg) })
    });
    window.PushManager = function () {};
    window.Notification = {
      permission: erlaubnis,
      requestPermission: async () => { window.Notification.permission = 'granted'; return 'granted'; }
    };
  };

  // Wer noch nie gefragt wurde, wird gefragt — ohne etwas suchen zu müssen.
  {
    const context = await browser.newContext({ viewport: { width: 414, height: 860 } });
    const page = await context.newPage();
    const errors = [];
    page.on('pageerror', (e) => errors.push(String(e)));
    page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
    const back = makeBackend();
    await stub(page, back);
    await page.addInitScript(faehig, 'default');

    await page.goto(origin + '/index.html' + SESSION);
    await page.waitForSelector('.vorfrage');
    check('vorfrage: sie erscheint auf der Alben-Seite von allein',
      (await page.textContent('.vorfrage')).includes('benachrichtigen'),
      await page.textContent('.vorfrage'));

    /*
     * Über den Filtern, nicht darunter.
     *
     * Eine Frage, die man erst nach dem Scrollen sieht, ist keine gestellte
     * Frage — und genau das war der Mangel, den die Vorfrage beheben soll.
     */
    const oben = await page.evaluate(() => {
      const f = document.querySelector('.vorfrage');
      const g = document.querySelector('.filters') || document.querySelector('.feed');
      return f.compareDocumentPosition(g) & Node.DOCUMENT_POSITION_FOLLOWING ? 1 : 0;
    });
    check('vorfrage: sie steht vor dem Inhalt, nicht darunter', oben === 1);

    await page.click('.vorfrage .btn--primary');
    await page.waitForSelector('.vorfrage', { state: 'detached' });
    const row = (back.inserts.find((i) => i.table === 'push_subscriptions') || {}).row;
    check('vorfrage: „Ja" meldet das Gerät wirklich an',
      !!row && row.endpoint === 'https://fcm.example/vorfrage', JSON.stringify(row));

    // Und die Frage ist damit erledigt — auch nach einem Neuladen.
    await page.goto(origin + '/index.html' + SESSION);
    await page.waitForSelector('.feed');
    check('vorfrage: nach dem Ja kommt sie nicht wieder',
      (await page.locator('.vorfrage').count()) === 0);
    check('vorfrage: keine Fehler', errors.length === 0, errors.join('\n'));
    await context.close();
  }

  // „Nein danke" heißt nein — und zwar auch beim nächsten Öffnen.
  {
    const context = await browser.newContext({ viewport: { width: 414, height: 860 } });
    const page = await context.newPage();
    const back = makeBackend();
    await stub(page, back);
    await page.addInitScript(faehig, 'default');

    await page.goto(origin + '/index.html' + SESSION);
    await page.waitForSelector('.vorfrage');
    await page.click('.vorfrage .btn--ghost');
    await page.waitForSelector('.vorfrage', { state: 'detached' });
    check('vorfrage: „Nein danke" meldet nichts an',
      !back.inserts.some((i) => i.table === 'push_subscriptions'), JSON.stringify(back.inserts));

    await page.goto(origin + '/index.html' + SESSION);
    await page.waitForSelector('.feed');
    check('vorfrage: und sie fragt danach nicht wieder',
      (await page.locator('.vorfrage').count()) === 0);
    await context.close();
  }

  /*
   * Ein Fehler ist keine Entscheidung.
   *
   * Wer auf „Ja" drückt und an einem Netzausfall scheitert, will offensichtlich
   * Benachrichtigungen. Ihm die Frage für immer wegzunehmen wäre genau falsch
   * herum — hier hätte ein `merkeGefragt()` an der falschen Stelle gereicht.
   */
  {
    const context = await browser.newContext({ viewport: { width: 414, height: 860 } });
    const page = await context.newPage();
    const back = makeBackend();
    back.failInsert = 'push_subscriptions';
    await stub(page, back);
    await page.addInitScript(faehig, 'default');

    await page.goto(origin + '/index.html' + SESSION);
    await page.waitForSelector('.vorfrage');
    await page.click('.vorfrage .btn--primary');
    await page.waitForSelector('.toast');
    check('vorfrage: scheitert das Anmelden, bleibt die Frage stehen',
      (await page.locator('.vorfrage').count()) === 1);

    await page.goto(origin + '/index.html' + SESSION);
    await page.waitForSelector('.feed');
    check('vorfrage: und sie wird beim nächsten Mal wieder gestellt',
      (await page.locator('.vorfrage').count()) === 1);
    await context.close();
  }

  // Je Person: auf dem Familien-Tablet darf die Frage nicht nur einer bekommen.
  {
    const context = await browser.newContext({ viewport: { width: 414, height: 860 } });
    const page = await context.newPage();
    const back = makeBackend();
    await stub(page, back);
    await page.addInitScript(faehig, 'default');

    await page.goto(origin + '/index.html' + SESSION);
    await page.waitForSelector('.vorfrage');
    await page.click('.vorfrage .btn--ghost');
    await page.waitForSelector('.vorfrage', { state: 'detached' });

    // Dasselbe Gerät, anderes Konto.
    back.profile = Object.assign({}, back.profile, { id: 'user-2', email: 'oma@example.de' });
    await page.goto(origin + '/index.html' + SESSION);
    await page.waitForSelector('.vorfrage');
    check('vorfrage: die nächste Person am selben Gerät wird trotzdem gefragt',
      (await page.locator('.vorfrage').count()) === 1);
    await context.close();
  }

  // Wo nichts zu fragen ist, wird auch nicht gefragt.
  const stumm = [
    {
      was: 'schon erlaubt', erwartet: 0,
      skript: faehig, arg: 'granted'
    },
    {
      was: 'schon abgelehnt', erwartet: 0,
      skript: faehig, arg: 'denied'
    },
    {
      was: 'Browser ohne Benachrichtigungen', erwartet: 0,
      skript: () => { delete window.PushManager; delete window.Notification; }
    }
  ];
  for (const fall of stumm) {
    const context = await browser.newContext({ viewport: { width: 414, height: 860 } });
    const page = await context.newPage();
    const back = makeBackend();
    await stub(page, back);
    await page.addInitScript(fall.skript, fall.arg);
    await page.goto(origin + '/index.html' + SESSION);
    await page.waitForSelector('.feed');
    check('vorfrage: ' + fall.was + ' → keine Karte',
      (await page.locator('.vorfrage').count()) === fall.erwartet);
    await context.close();
  }

  // iPhone im Safari-Tab: die Anleitung statt eines Knopfes, der nichts tut.
  {
    const context = await browser.newContext({ viewport: { width: 414, height: 860 } });
    const page = await context.newPage();
    const back = makeBackend();
    await stub(page, back);
    await page.addInitScript(() => {
      Object.defineProperty(navigator, 'userAgent',
        { get: () => 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X)' });
      delete window.PushManager;
    });
    await page.goto(origin + '/index.html' + SESSION);
    await page.waitForSelector('.vorfrage');
    const text = await page.textContent('.vorfrage');
    check('vorfrage: iPhone im Tab bekommt die Anleitung zum Startbildschirm',
      text.includes('Home-Bildschirm') && !text.includes('Ja, gern'), text.slice(0, 160));
    await context.close();
  }

  /*
   * Der Service Worker muss sich auf JEDER Seite anmelden dürfen, die fragt.
   *
   * Alle Prüfungen oben bauen `navigator.serviceWorker` nach — nötig, weil es
   * keinen echten Push-Dienst gibt, aber damit prüfen sie die
   * Sicherheitsrichtlinie der Seite gerade NICHT.
   *
   * Und die ist hier nicht offensichtlich: `worker-src` fällt zurück auf
   * `child-src`, dann auf `script-src`, erst dann auf `default-src` (CSP
   * Level 3). Weil `script-src 'self'` dasteht, ist der Worker also auch ohne
   * eigenes `worker-src` erlaubt — ich hatte das Gegenteil vermutet und lag
   * falsch. Eine vierstufige Rückfallkette ist nichts, was man beim Lesen
   * einer Richtlinie im Kopf haben sollte, also steht `worker-src 'self'`
   * trotzdem ausdrücklich da, und diese Prüfung sagt, was tatsächlich gilt.
   *
   * Dafür wird der ECHTE Worker angemeldet, ohne Attrappe.
   */
  for (const seite of ['index.html', 'neues.html']) {
    const context = await browser.newContext({ viewport: { width: 414, height: 860 } });
    const page = await context.newPage();
    const back = makeBackend();
    await stub(page, back);
    await page.goto(origin + '/' + seite + SESSION);
    await page.waitForSelector('.feed, .neues');
    const ergebnis = await page.evaluate(async () => {
      try {
        const reg = await navigator.serviceWorker.register('sw.js');
        return reg && reg.scope ? 'ok' : 'keine Registrierung';
      } catch (error) { return String(error); }
    });
    check('csp: ' + seite + ' darf den Service Worker anmelden', ergebnis === 'ok', ergebnis);
    await context.close();
  }
}

// --- 6l. Textauszeichnung: der Umwandler ------------------------------------
{
  /*
   * Der Umwandler baut DOM-Knoten und braucht deshalb einen Browser. Er läuft
   * hier IN der Seite, gegen dieselbe Datei, die auch ausgeliefert wird.
   *
   * Geprüft werden drei Dinge, und das dritte ist das wichtigste:
   *   1. dass die sechs Auszeichnungen das Richtige ergeben,
   *   2. dass ein normaler Satz unverändert bleibt,
   *   3. dass sich kein Markup einschleusen lässt.
   */
  const context = await browser.newContext({ viewport: { width: 900, height: 900 } });
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  const back = makeBackend();
  await stub(page, back);
  await page.goto(origin + '/board.html' + SESSION);
  await page.waitForSelector('.compose');

  /*
   * Jede Auswertung mit einer Frist.
   *
   * Ohne die hier war ein Fehler im Umwandler nicht als Fehler zu erkennen:
   * `zeile()` teilte sich ein Regex-Objekt mit seinem eigenen rekursiven
   * Aufruf, las nach jeder Rückkehr wieder von vorn und baute endlos Knoten.
   * Der Testlauf „hing" nicht — er wurde einfach nicht fertig, während ein
   * Chromium-Prozess auf 14 GB wuchs.
   *
   * Fünf Sekunden sind für das Umwandeln eines Satzes grotesk viel. Wer sie
   * überschreitet, hat keine langsame Maschine, sondern eine Schleife.
   */
  const mitFrist = (versprechen, was) => Promise.race([
    versprechen,
    new Promise((_, weg) => setTimeout(
      () => weg(new Error('länger als 5 s: ' + was + ' — vermutlich eine Endlosschleife')), 5000))
  ]);

  /** Den Text durch den Umwandler schicken und das erzeugte HTML zurückgeben. */
  const html = (quelle) => mitFrist(page.evaluate((q) => {
    const box = document.createElement('div');
    box.appendChild(window.PS.text.block(q));
    return box.innerHTML;
  }, quelle), JSON.stringify(quelle));

  const faelle = [
    ['**fett**', '<p class="text-absatz"><strong>fett</strong></p>'],
    ['*kursiv*', '<p class="text-absatz"><em>kursiv</em></p>'],
    ['__unter__', '<p class="text-absatz"><u>unter</u></p>'],
    // Ein gewöhnlicher Satz darf durch die Formatierung NICHT anders werden.
    ['Hallo ihr Lieben', '<p class="text-absatz">Hallo ihr Lieben</p>'],
    // Zeilenumbruch innerhalb eines Absatzes bleibt ein Umbruch: bisher wurde
    // alles mit pre-wrap gezeigt, und wer umbricht, meint das auch so.
    ['eins\nzwei', '<p class="text-absatz">eins<br>zwei</p>'],
    // Leerzeile trennt Absätze — und erzeugt keinen leeren dazwischen.
    ['eins\n\nzwei', '<p class="text-absatz">eins</p><p class="text-absatz">zwei</p>'],
    ['- Milch\n- Brot',
      '<ul class="text-liste"><li>Milch</li><li>Brot</li></ul>'],
    ['1. erst\n2. dann',
      '<ol class="text-liste"><li>erst</li><li>dann</li></ol>'],
    // Fett vor kursiv: sonst läse der erste Stern von ** den Rest als kursiv.
    ['**a** und *b*',
      '<p class="text-absatz"><strong>a</strong> und <em>b</em></p>'],
    // Ein einzelnes Sternchen ist ein Sternchen.
    ['3 * 4 = 12', '<p class="text-absatz">3 * 4 = 12</p>'],
    // Eine Auszeichnung endet an der Zeile, sie frisst nicht den Rest.
    ['*offen\nnächste Zeile', '<p class="text-absatz">*offen<br>nächste Zeile</p>']
  ];
  for (const [quelle, erwartet] of faelle) {
    check('text: ' + JSON.stringify(quelle) + ' → ' + erwartet.slice(0, 60),
      (await html(quelle)) === erwartet, await html(quelle));
  }

  // Links
  check('text: [Text](Adresse) wird ein Link',
    (await html('[hier](https://example.com/x)')) ===
    '<p class="text-absatz"><a class="text-link" href="https://example.com/x" ' +
    'target="_blank" rel="noopener noreferrer">hier</a></p>',
    await html('[hier](https://example.com/x)'));
  check('text: eine nackte Adresse wird auch verlinkt',
    (await html('siehe https://example.com')).includes('<a class="text-link" href="https://example.com/"'),
    await html('siehe https://example.com'));

  /*
   * DER WICHTIGSTE TEIL.
   *
   * Gespeichert wird Text, angezeigt werden gebaute Knoten — eingeschleustes
   * Markup ist damit strukturell unmöglich, nicht bloß wegmaskiert. Diese
   * Prüfungen sind der Beweis, dass das auch stimmt.
   */
  /*
   * Gesucht wird ein ÖFFNENDES TAG, nicht das bloße Wort.
   *
   * Erster Anlauf verbot schlicht die Zeichenfolge „script". Damit fielen
   * ausgerechnet die beiden Fälle durch, die richtig funktionierten: aus
   * `<script>` wird `&lt;script&gt;`, also harmloser Text — in dem das Wort
   * natürlich weiter vorkommt. Der Test hätte also verlangt, dass der Text
   * verschwindet, statt dass er ungefährlich ist. Das ist etwas anderes.
   */
  const angriffe = [
    ['<script>alert(1)</script>', '<script'],
    ['<img src=x onerror=alert(1)>', '<img'],
    ['[klick](javascript:alert(1))', 'javascript:'],
    ['[klick](JaVaScRiPt:alert(1))', 'javascript:'],
    ['[klick](data:text/html,<script>alert(1)</script>)', 'data:'],
    ['**<b>fett</b>**', '<b>']
  ];
  for (const [quelle, verboten] of angriffe) {
    const raus = await html(quelle);
    check('text: ' + JSON.stringify(quelle.slice(0, 34)) + ' schleust nichts ein',
      !raus.toLowerCase().includes(verboten.toLowerCase()), raus);
  }
  // Und zwar wirklich: es entsteht kein einziges Element dieser Art.
  const gefaehrlich = await mitFrist(page.evaluate(() => {
    const box = document.createElement('div');
    box.appendChild(window.PS.text.block(
      '<script>alert(1)</script>\n<img src=x onerror=alert(1)>\n<iframe src=x></iframe>'));
    return box.querySelectorAll('script, img, iframe, object, embed').length;
  }), 'Elementprobe');
  check('text: aus eingeschleustem Markup entsteht kein einziges Element',
    gefaehrlich === 0, String(gefaehrlich));
  // Und der Text selbst geht dabei nicht verloren.
  check('text: eingeschleustes Markup bleibt als Text sichtbar',
    (await html('<script>alert(1)</script>')).includes('&lt;script&gt;'),
    await html('<script>alert(1)</script>'));
  check('text: ein Link mit unerlaubtem Ziel bleibt lesbarer Text',
    (await html('[klick](javascript:alert(1))')) === '<p class="text-absatz">klick</p>',
    await html('[klick](javascript:alert(1))'));
  /*
   * Klammern in der Adresse.
   *
   * Diese Prüfung hat einen echten Mangel gefunden: das erste Adressmuster
   * hörte bei der ersten Klammer auf. Aus einem Wikipedia-Link wurde ein
   * abgeschnittener Link und ein übrig gebliebenes „)" daneben — in einem
   * Rezept keine ausgedachte Lage.
   */
  check('text: eine Adresse mit Klammern bleibt vollständig',
    (await html('[Apfel](https://de.wikipedia.org/wiki/Apfel_(Frucht))')) ===
    '<p class="text-absatz"><a class="text-link" ' +
    'href="https://de.wikipedia.org/wiki/Apfel_(Frucht)" target="_blank" ' +
    'rel="noopener noreferrer">Apfel</a></p>',
    await html('[Apfel](https://de.wikipedia.org/wiki/Apfel_(Frucht))'));

  // Die Kurzfassung für Sperrbildschirm und Übersicht.
  const roh = await page.evaluate(() =>
    window.PS.text.roh('- **Oma** ist *wieder* [zu Hause](https://example.com)'));
  check('text: roh() lässt nur den Satz übrig',
    roh === 'Oma ist wieder zu Hause', JSON.stringify(roh));

  check('text: keine Fehler', errors.length === 0, errors.join('\n'));
  await context.close();
}

// --- 6m. Textauszeichnung: die Knopfleiste ----------------------------------
{
  const context = await browser.newContext({ viewport: { width: 900, height: 900 } });
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  const back = makeBackend();
  await stub(page, back);
  await page.goto(origin + '/board.html' + SESSION);
  await page.waitForSelector('.compose .schreibhilfe');

  const feld = '.compose textarea';
  const wert = () => page.inputValue(feld);

  // Auswahl umschließen.
  await page.fill(feld, 'Oma ist da');
  await page.evaluate((s) => document.querySelector(s).setSelectionRange(0, 3),
    '.compose textarea');
  await page.click('.compose .is-fett');
  check('schreibhilfe: Fett legt sich um die Auswahl', (await wert()) === '**Oma** ist da', await wert());

  // Nochmal derselbe Knopf nimmt sie wieder ab, statt sie zu verdoppeln.
  await page.click('.compose .is-fett');
  check('schreibhilfe: nochmal Fett nimmt sie wieder ab', (await wert()) === 'Oma ist da', await wert());

  // Ohne Auswahl: Marken einsetzen und den Zeiger dazwischen stellen.
  await page.fill(feld, '');
  await page.click('.compose .is-kursiv');
  await page.type(feld, 'so');
  check('schreibhilfe: ohne Auswahl schreibt man zwischen die Marken',
    (await wert()) === '*so*', await wert());

  // Listen: jede angefasste Zeile bekommt ihr Zeichen.
  await page.fill(feld, 'Milch\nBrot\nEier');
  await page.evaluate((s) => document.querySelector(s).setSelectionRange(0, 15),
    '.compose textarea');
  await page.click('.compose .is-liste');
  check('schreibhilfe: Aufzählung kennzeichnet jede Zeile',
    (await wert()) === '- Milch\n- Brot\n- Eier', JSON.stringify(await wert()));

  await page.evaluate((s) => document.querySelector(s).setSelectionRange(0, 21),
    '.compose textarea');
  await page.click('.compose .is-nummern');
  check('schreibhilfe: Nummerierung zählt hoch und ersetzt die Striche',
    (await wert()) === '1. Milch\n2. Brot\n3. Eier', JSON.stringify(await wert()));

  // Der Link-Knopf stellt den Zeiger dorthin, wo die Adresse hingehört.
  await page.fill(feld, '');
  await page.click('.compose .is-link');
  await page.type(feld, 'example.com');
  check('schreibhilfe: der Zeiger landet hinter https://',
    (await wert()) === '[Text](https://example.com)', await wert());

  /*
   * Die Vorschau.
   *
   * Sie ist der Grund, warum ein Textfeld mit Marken überhaupt zumutbar ist:
   * niemand muss raten, was `**so**` wird. Aber sie zeigt sich erst, wenn es
   * etwas zu zeigen gibt — wer einfach nur schreibt, soll kein zweites Feld
   * unter dem ersten sehen.
   */
  await page.fill(feld, 'ganz normaler Satz');
  check('vorschau: bei gewöhnlichem Text bleibt sie weg',
    !(await page.locator('.compose .schreibvorschau').first().isVisible()));

  await page.fill(feld, 'jetzt **fett**');
  await page.waitForSelector('.compose .schreibvorschau.is-da');
  check('vorschau: sobald etwas ausgezeichnet ist, zeigt sie das Ergebnis',
    (await page.locator('.compose .schreibvorschau strong').textContent()) === 'fett');

  check('schreibhilfe: keine Fehler', errors.length === 0, errors.join('\n'));
  await context.close();
}

// --- 6n. die Auszeichnung kommt überall an, wo man schreiben kann ------------
{
  /*
   * Eine Leiste, die auf einer Seite fehlt, fällt niemandem auf — außer der
   * Person, die dort gerade schreiben wollte. Also wird jede Stelle einzeln
   * nachgesehen, statt sich auf „ist ja dasselbe Modul" zu verlassen.
   */
  const stellen = [
    { seite: 'board.html', oeffnen: null, feld: '.compose', listen: true, was: 'Pinnwand' },
    { seite: 'neues.html', oeffnen: '.neues__tools .btn', feld: '.confirm__box', listen: true,
      was: 'Mitteilung' },
    // Diese beiden Knöpfe tragen keine eigene Klasse, nur ihre Beschriftung.
    { seite: 'dates.html', oeffnen: 'button:has-text("Neuer Termin")', feld: '.confirm__box',
      listen: true, was: 'Termin-Notiz' },
    // Zutaten und Schritte SIND schon Listen — dort wäre ein „- " nur ein
    // Strich, der vor dem Listenpunkt steht.
    { seite: 'rezepte.html', oeffnen: 'button:has-text("Neues Rezept")', feld: '.confirm__box',
      listen: false, was: 'Rezept' }
  ];

  for (const stelle of stellen) {
    const context = await browser.newContext({ viewport: { width: 900, height: 900 } });
    const page = await context.newPage();
    const errors = [];
    page.on('pageerror', (e) => errors.push(String(e)));
    const back = makeBackend();
    await stub(page, back);
    await page.goto(origin + '/' + stelle.seite + SESSION);
    if (stelle.oeffnen) {
      await page.waitForSelector(stelle.oeffnen);
      await page.click(stelle.oeffnen);
    }
    await page.waitForSelector(stelle.feld + ' .schreibhilfe');
    check('überall: ' + stelle.was + ' hat eine Schreibhilfe',
      (await page.locator(stelle.feld + ' .schreibhilfe .is-fett').count()) >= 1);
    check('überall: ' + stelle.was + ' — Listenknöpfe ' + (stelle.listen ? 'da' : 'weg'),
      ((await page.locator(stelle.feld + ' .schreibhilfe .is-liste').count()) > 0) === stelle.listen);
    check('überall: ' + stelle.was + ' ohne Fehler', errors.length === 0, errors.join('\n'));
    await context.close();
  }

  /*
   * Kommentare liegen in der Lightbox und brauchen einen eigenen Weg dorthin.
   *
   * Die Fotozeile muss dieselbe Form haben wie die echte Antwort der
   * Datenbank — mit `media_type`, `uploader_id` und `comments`. Mein erster
   * Anlauf ließ die weg, es entstand keine einzige Kachel, und der Test lief
   * in eine Zeitüberschreitung statt in eine Aussage.
   */
  {
    const context = await browser.newContext({ viewport: { width: 900, height: 900 } });
    const page = await context.newPage();
    const back = makeBackend();
    back.albums = [
      { id: 'alb-1', slug: 'evas-treff', title: "Eva's Treff", event_date: '2026-08-07',
        photos: [{ count: 1 }] }
    ];
    back.photos = [
      { id: 'ph-1', album_id: 'alb-1', storage_path: 'evas-treff/foto1.jpg',
        thumb_path: 'evas-treff/foto1_thumb.jpg', content_hash: 'foto1',
        media_type: 'image', duration_seconds: null,
        taken_at: '2026-08-07T20:10:00Z', uploader_id: 'user-1', uploader_name: 'Maria',
        comments: [] }
    ];
    await stub(page, back);
    await page.goto(origin + '/index.html' + SESSION);
    await page.waitForSelector('.tile');
    await page.click('.tile');
    await page.waitForSelector('.lightbox:not(.is-hidden)');
    await page.click('.lightbox__comments-toggle');
    await page.waitForSelector('.comments__form .schreibhilfe');
    check('überall: Kommentare haben eine Schreibhilfe',
      (await page.locator('.comments__form .schreibhilfe .is-fett').count()) === 1);
    await context.close();
  }
}

// --- 6o. am Telefon verdeckt die Leiste nichts ------------------------------
{
  /*
   * Die Navigationsleiste liegt FEST über dem Inhalt. Am Ende jeder Seite muss
   * deshalb Platz für sie frei bleiben — sonst liegt dort, wo man aufhört zu
   * scrollen, das letzte Element unter der Leiste.
   *
   * Genau das ist passiert, und es war nicht als Layoutfehler zu erkennen:
   * gemeldet wurde „das Archiv wird am Handy nicht angezeigt". Der Knopf war
   * da, vollständig gerendert, klickbar — nur eben unter der Leiste. Auf einem
   * breiten Fenster passte alles ohne Scrollen auf den Schirm, dort fiel es
   * nie auf.
   *
   * Ursache war die Kurzschreibweise: jede Seite setzt ihren Rand als
   * `padding: 0 var(--pad)`, und die setzt den unteren Wert immer mit. Bei
   * gleicher Spezifität gewann die spätere Regel.
   *
   * Diese Prüfung nimmt jede Seite mit genug Inhalt zum Scrollen und misst, ob
   * das letzte Element frei liegt. Eine neue Seite, die den Freiraum wieder
   * überschreibt, fällt hier durch.
   */
  const lang = (n) => Array.from({ length: n }, (_, i) =>
    'Zeile ' + (i + 1) + ' mit genug Text, damit die Seite auf einem Telefon wirklich scrollt.'
  ).join('\n');

  for (const seite of ['neues.html', 'dates.html', 'rezepte.html', 'admin.html', 'board.html']) {
    const context = await browser.newContext({ viewport: { width: 390, height: 844 } });
    const page = await context.newPage();
    const back = makeBackend();
    back.announcements = [
      { id: 'a1', body: lang(12), until: null, created_at: '2026-08-10T10:00:00Z',
        profiles: { people: { name: 'Maria' } } },
      { id: 'a2', body: lang(12), until: null, created_at: '2026-08-01T10:00:00Z',
        profiles: { people: { name: 'Maria' } } }
    ];
    back.news = Object.assign({}, back.news, {
      announcements: { unread: 1, items: [back.announcements[0]] }
    });
    back.events = Array.from({ length: 8 }, (_, i) => ({
      id: 'e' + i, title: 'Termin ' + i, starts_on: '2026-09-0' + (i + 1), ends_on: null,
      starts_at: null, place: 'Irgendwo', note: lang(3), created_by: 'user-1',
      profiles: { people: { name: 'Maria' } }, event_replies: []
    }));
    back.recipes = Array.from({ length: 10 }, (_, i) => ({
      id: 'r' + i, slug: 'r' + i, title: 'Rezept ' + i, servings: 4, created_by: 'user-1',
      created_at: '2026-08-01T10:00:00Z', profiles: { people: { name: 'Maria' } },
      recipe_photos: []
    }));
    back.invites = Array.from({ length: 12 }, (_, i) => ({
      email: 'p' + i + '@example.de', is_admin: false, invited_at: '2026-08-01T10:00:00Z',
      used_at: null, person_id: null, people: null
    }));
    await stub(page, back);
    await page.goto(origin + '/' + seite + SESSION);
    await page.waitForSelector('main.feed');
    await page.waitForFunction(() => !document.querySelector('main.feed .spinner'));

    const m = await page.evaluate(() => {
      const feed = document.querySelector('main.feed');
      const nav = document.querySelector('.nav');
      window.scrollTo(0, document.documentElement.scrollHeight);
      const letztes = feed.lastElementChild;
      const lr = letztes.getBoundingClientRect();
      return {
        scrollt: document.documentElement.scrollHeight > window.innerHeight + 2,
        verdeckt: Math.max(0, Math.round(lr.bottom - nav.getBoundingClientRect().top))
      };
    });
    // Scrollt eine Seite gar nicht, kann nichts unter der Leiste liegen — dann
    // sagt die Messung nichts, und das soll sie auch zugeben.
    check('leiste: ' + seite + ' verdeckt nichts' + (m.scrollt ? '' : ' (scrollt nicht)'),
      m.verdeckt === 0, m.verdeckt + ' px unter der Leiste');
    await context.close();
  }
}

// --- 7. nothing is reachable without a session -----------------------------
{
  const context = await browser.newContext({ viewport: { width: 414, height: 860 } });
  const page = await context.newPage();
  const back = makeBackend();
  const reached = [];
  await page.route(SB + '/**', async (route) => {
    const auth = route.request().headers()['authorization'] || '';
    if (!auth.includes('Bearer ')) reached.push(new URL(route.request().url()).pathname);
    return route.fulfill({ status: 401, headers: { 'Content-Type': 'application/json' }, body: '{}' });
  });
  for (const where of ['/index.html', '/upload.html', '/board.html', '/admin.html',
    '/dates.html', '/rezepte.html', '/neues.html', '/sicherung.html']) {
    await page.goto(origin + where);
    await page.waitForSelector('.gate');
    await page.waitForTimeout(300);
    check('ohne Anmeldung: ' + where + ' fragt nichts ab',
      reached.length === 0, JSON.stringify(reached));
  }
  await context.close();
}

await browser.close();
server.close();

const failed = checks.filter((c) => !c.ok);
console.log(`\n${checks.length - failed.length}/${checks.length} Prüfungen bestanden`);
process.exit(failed.length ? 1 : 0);
