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

/** Everything the app is allowed to know, and a log of what it asked for. */
function makeBackend() {
  return {
    otpRequests: [], inserts: [], deletes: [], uploads: [], signCalls: 0,
    albums: [], photos: [], comments: [], people: [], board: [],
    profile: { id: 'user-1', email: 'ich@example.de', is_admin: true, person_id: 'p1', people: { name: 'Maria' } }
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
      back.otpRequests.push(JSON.parse(request.postData()));
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
    if (p === '/rest/v1/photos' && request.method() === 'GET') {
      if (url.searchParams.get('select') === 'album_id,thumb_path,taken_at') {
        return json(200, back.photos.map((x) => ({ album_id: x.album_id, thumb_path: x.thumb_path, taken_at: x.taken_at })));
      }
      const album = (url.searchParams.get('album_id') || '').replace('eq.', '');
      return json(200, back.photos.filter((x) => x.album_id === album));
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
    if (p === '/rest/v1/people') return json(200, back.people);
    if (p === '/rest/v1/profiles') return json(200, [back.profile]);

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
  check('anmeldung: mit Rücksprung auf dieselbe Seite',
    (back.otpRequests[0].options.email_redirect_to || '').endsWith('/index.html'),
    JSON.stringify(back.otpRequests[0].options));
  check('anmeldung: keine Fehler', errors.length === 0, errors.join('\n'));
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

  check('regal: zeigt beide Alben', (await page.locator('.shelf__card').count()) === 2);
  check('regal: mit Titelbild aus signierter URL',
    (await page.locator('.shelf__cover.is-loaded').count()) >= 1);

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

  await page.locator('.tile').first().click();
  await page.waitForSelector('.lightbox:not(.is-hidden)');
  await page.click('.lightbox__comments-toggle');
  await page.waitForSelector('.comments:not(.is-hidden)');
  check('kommentare: kommen mit dem Foto, ohne Nachladen',
    (await page.textContent('.comment__text')) === 'Schöner Abend!');

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

  check('keine Fehler', errors.length === 0, errors.join('\n'));
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
  const shot = await makeJpeg(scratch, 1200, 900, 120, 'Kuchen');
  await scratch.close();

  await page.setInputFiles('input[type=file]:not([capture])',
    { name: 'IMG_0042.jpg', mimeType: 'image/jpeg', buffer: shot });
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
    { name: 'IMG_0042-kopie.jpg', mimeType: 'image/jpeg', buffer: shot });
  await page.waitForSelector('.job--skip');
  check('hochladen: dasselbe Foto ein zweites Mal kostet nichts',
    back.uploads.length === 2 && back.inserts.filter((i) => i.table === 'photos').length === 1,
    JSON.stringify(back.uploads));

  check('hochladen: keine Fehler', errors.length === 0, errors.join('\n'));
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

  check('pinnwand: keine Fehler', errors.length === 0, errors.join('\n'));
  await context.close();
}

// --- 5. nothing is reachable without a session -----------------------------
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
  for (const where of ['/index.html', '/upload.html', '/board.html']) {
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
