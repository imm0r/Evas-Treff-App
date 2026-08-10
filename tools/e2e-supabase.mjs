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
import { readFile } from 'node:fs/promises';
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
    '/dates.html', '/rezepte.html']) {
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
