/*
 * End-to-end smoke test against a fake GitHub API.
 *
 * The app is almost entirely "does the browser do what I think it does" —
 * canvas re-encoding, object URLs, IntersectionObserver, the Content-Security-
 * Policy, the fragment scrubbing. None of that can be checked by reading the
 * source, so this drives a real Chromium against a stubbed api.github.com and
 * asserts on what actually happens.
 *
 * Usage: node photoshare/tools/e2e.mjs      (add --headed to watch it)
 */
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

// Resolve playwright from this checkout first, then from a global install —
// which is what the prepared container in Claude Code on the web has.
function loadPlaywright() {
  for (const base of [import.meta.url, '/opt/node22/lib/node_modules/']) {
    try { return createRequire(base)('playwright'); } catch { /* try the next one */ }
  }
  throw new Error('playwright is missing. Run: cd photoshare && npm install && npx playwright install chromium');
}
const { chromium } = loadPlaywright();

const APP = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../app');
const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.webmanifest': 'application/manifest+json',
  '.wasm': 'application/wasm',
  '.heic': 'image/heic'
};

const checks = [];
function check(name, condition, detail) {
  checks.push({ name, ok: !!condition, detail });
  console.log(`${condition ? 'ok  ' : 'FAIL'}  ${name}${condition || !detail ? '' : `\n        ${detail}`}`);
}

// --- static server --------------------------------------------------------

const server = createServer(async (req, res) => {
  const name = decodeURIComponent(req.url.split('?')[0]);
  const file = path.join(APP, name === '/' ? '/index.html' : name);
  if (!file.startsWith(APP)) { res.writeHead(403).end(); return; }
  try {
    const body = await readFile(file);
    res.writeHead(200, { 'Content-Type': TYPES[path.extname(file)] || 'application/octet-stream' });
    res.end(body);
  } catch {
    res.writeHead(404).end('not found');
  }
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const origin = `http://127.0.0.1:${server.address().port}`;

// --- fake repository ------------------------------------------------------

function makeRepo() {
  return {
    tree: new Map(),      // path -> {sha, bytes}
    puts: [],
    deletes: [],
    blobHits: 0,
    add(p, bytes) {
      this.tree.set(p, { sha: `sha-${this.tree.size}-${p.length}`, bytes, isText: p.endsWith('.txt') });
    }
  };
}

async function stubGitHub(page, repo, { writable = true, noBranch = false, noRepo = false } = {}) {
  await page.route('https://api.github.com/**', async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const json = (status, body, headers = {}) => route.fulfill({
      status, headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body)
    });

    if (!request.headers()['authorization']) return json(401, { message: 'no token' });

    if (/\/repos\/[^/]+\/[^/]+$/.test(url.pathname)) {
      if (noRepo) return json(404, { message: 'Not Found' });
      return json(200, { full_name: 'fam/album', private: true });
    }
    if (url.pathname.includes('/git/trees/')) {
      // A repository with no commits has no branch for the tree endpoint to list.
      if (noBranch || noRepo) return json(404, { message: 'Not Found' });
      return json(200, {
        sha: 'tree', truncated: false,
        tree: [...repo.tree.entries()].map(([p, v]) => ({
          path: p, type: 'blob', sha: v.sha, size: v.bytes.length
        }))
      });
    }
    if (url.pathname.includes('/git/blobs/')) {
      const sha = url.pathname.split('/').pop();
      const entry = [...repo.tree.values()].find((v) => v.sha === sha);
      if (!entry) return json(404, { message: 'no blob' });
      repo.blobHits++;
      const text = request.headers()['accept'] === 'application/vnd.github.raw' && entry.isText;
      return route.fulfill({
        status: 200,
        headers: { 'Content-Type': text ? 'text/plain; charset=utf-8' : 'image/jpeg' },
        body: Buffer.from(entry.bytes)
      });
    }
    if (request.method() === 'DELETE' && url.pathname.includes('/contents/')) {
      if (!writable) return json(403, { message: 'read only' });
      const filePath = decodeURIComponent(url.pathname.split('/contents/')[1]);
      const entry = repo.tree.get(filePath);
      if (!entry) return json(404, { message: 'no such file' });
      if (JSON.parse(request.postData()).sha !== entry.sha) return json(409, { message: 'sha mismatch' });
      repo.deletes.push(filePath);
      repo.tree.delete(filePath);
      return json(200, { commit: {} });
    }
    if (request.method() === 'PUT' && url.pathname.includes('/contents/')) {
      if (!writable) return json(403, { message: 'read only' });
      const body = JSON.parse(request.postData());
      const filePath = decodeURIComponent(url.pathname.split('/contents/')[1]);
      repo.puts.push({
        path: filePath,
        size: Buffer.from(body.content, 'base64').length,
        text: Buffer.from(body.content, 'base64').toString('utf8')
      });
      repo.add(filePath, Buffer.from(body.content, 'base64'));
      return json(201, { content: { path: filePath } });
    }
    return json(404, { message: 'unhandled ' + url.pathname });
  });
}

// --- helpers --------------------------------------------------------------

const browser = await chromium.launch({ headless: !process.argv.includes('--headed') });

async function newPage() {
  const context = await browser.newContext({ viewport: { width: 420, height: 900 } });
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  page._errors = errors;
  return page;
}

// Fixtures are painted on a throwaway page: generating them on a page under
// test would mean navigating it twice, and the second navigation to the same
// document with only a different fragment never reloads.
const fixtureContext = await browser.newContext();
const fixturePage = await fixtureContext.newPage();
await fixturePage.goto('about:blank');

/** A real JPEG, painted and encoded by the browser itself. */
async function makeJpeg(w, h, hue) {
  const page = fixturePage;
  return Buffer.from(await page.evaluate(async ([w, h, hue]) => {
    const canvas = document.createElement('canvas');
    canvas.width = w; canvas.height = h;
    const ctx = canvas.getContext('2d');
    const gradient = ctx.createLinearGradient(0, 0, w, h);
    gradient.addColorStop(0, `hsl(${hue},70%,60%)`);
    gradient.addColorStop(1, `hsl(${(hue + 90) % 360},70%,25%)`);
    ctx.fillStyle = gradient;
    ctx.fillRect(0, 0, w, h);
    ctx.fillStyle = '#fff';
    ctx.font = `${Math.round(h / 6)}px serif`;
    ctx.fillText('Foto', w / 8, h / 2);
    // A smooth gradient compresses to almost nothing, which would make the
    // "did it actually shrink" assertions meaningless. Grain makes the fixture
    // behave like a photo out of a camera.
    const frame = ctx.getImageData(0, 0, w, h);
    for (let i = 0; i < frame.data.length; i += 4) {
      const n = (Math.random() * 52) - 26;
      frame.data[i] += n; frame.data[i + 1] += n; frame.data[i + 2] += n;
    }
    ctx.putImageData(frame, 0, 0);
    const blob = await new Promise((r) => canvas.toBlob(r, 'image/jpeg', 0.9));
    return Array.from(new Uint8Array(await blob.arrayBuffer()));
  }, [w, h, hue]));
}

/** Long edge of a JPEG, straight out of its SOF marker. */
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

const LINK = (page, extra = '') =>
  `${origin}/${page}#r=fam/album&k=github_pat_testtoken1234567890&t=${encodeURIComponent('Familientreffen')}${extra}`;

// --- 1. gate --------------------------------------------------------------
{
  const page = await newPage();
  await page.goto(`${origin}/index.html`);
  await page.waitForSelector('.gate');
  check('gate: asks for a code when the app has none', await page.isVisible('.gate__title'));

  await page.fill('.gate .field', 'völliger unsinn');
  await page.click('.gate .btn');
  check('gate: rejects nonsense', (await page.textContent('.gate__hint')).includes('kompletten Link'));

  // Tapping the share link while the page is already open is a same-document
  // navigation: the browser does not reload, so the app has to notice itself.
  const repo = makeRepo();
  await stubGitHub(page, repo);
  repo.add('photos/2026-08-07/120000__Jonas__11111111.jpg', await makeJpeg(200, 200, 10));
  repo.add('thumbs/2026-08-07/120000__Jonas__11111111.jpg', await makeJpeg(200, 200, 10));
  await page.goto(LINK('index.html'));
  await page.waitForSelector('.tile', { timeout: 10000 });
  check('gate: a share link tapped on an open page still lets you in', true);
  await page.context().close();
}

// --- 2. gallery -----------------------------------------------------------
{
  const page = await newPage();
  const repo = makeRepo();
  await stubGitHub(page, repo);
  const jpeg = await makeJpeg(400, 300, 30);
  const jpeg2 = await makeJpeg(300, 400, 200);
  for (const [day, time, who, id, bytes] of [
    ['2026-08-07', '153012', 'Oma-Lotte', 'aaaaaaaa', jpeg],
    ['2026-08-07', '161500', 'Jonas', 'bbbbbbbb', jpeg2],
    ['2026-08-06', '090000', 'Oma-Lotte', 'cccccccc', jpeg]
  ]) {
    const name = `${day}/${time}__${who}__${id}.jpg`;
    repo.add(`photos/${name}`, bytes);
    repo.add(`thumbs/${name}`, bytes);
  }
  // A thumbnail whose full-size photo never made it up must stay hidden.
  repo.add('thumbs/2026-08-07/170000__Jonas__dddddddd.jpg', jpeg);

  await page.goto(LINK('index.html'));
  await page.waitForSelector('.tile.is-loaded');

  check('gallery: fragment is scrubbed from the URL', page.url() === `${origin}/index.html`, page.url());
  check('gallery: title comes from the link', (await page.textContent('.topbar__title')) === 'Familientreffen');
  check('gallery: shows only complete photos', (await page.locator('.tile').count()) === 3,
    `found ${await page.locator('.tile').count()} tiles`);
  check('gallery: groups by day, newest first',
    (await page.locator('.day').first().textContent()).includes('7. August 2026'));
  check('gallery: offers a filter per uploader', (await page.locator('.chip').count()) === 3);

  await page.locator('.chip', { hasText: 'Jonas' }).click();
  check('gallery: filter narrows the grid', (await page.locator('.tile').count()) === 1);
  await page.locator('.chip', { hasText: 'Alle' }).click();

  await page.locator('.tile').first().click();
  await page.waitForSelector('.lightbox:not(.is-hidden)');
  await page.waitForFunction(() => {
    const img = document.querySelector('.lightbox__image');
    return img && img.naturalWidth > 0;
  });
  check('lightbox: opens with a decoded photo', true);
  check('lightbox: captions who and when',
    (await page.textContent('.lightbox__caption')).includes('Jonas'),
    await page.textContent('.lightbox__caption'));

  await page.keyboard.press('ArrowRight');
  await page.waitForTimeout(250);
  check('lightbox: arrow keys move on',
    (await page.textContent('.lightbox__caption')).includes('Oma Lotte'),
    await page.textContent('.lightbox__caption'));

  await page.keyboard.press('Escape');
  check('lightbox: escape closes', await page.locator('.lightbox.is-hidden').count() === 1);

  const before = repo.blobHits;
  await page.reload();
  await page.waitForSelector('.tile.is-loaded');
  await page.waitForTimeout(400);
  check('gallery: thumbnails come from cache on the second visit',
    repo.blobHits === before, `${repo.blobHits - before} refetches`);

  check('gallery: no page errors', page._errors.length === 0, page._errors.join('\n'));
  await page.context().close();
}

// --- 3. upload ------------------------------------------------------------
{
  const page = await newPage();
  const repo = makeRepo();
  await stubGitHub(page, repo);
  await page.goto(LINK('upload.html'));
  await page.waitForSelector('.drop');

  const big = await makeJpeg(4000, 3000, 120);
  check('upload: fixture is a phone-sized photo', big.length > 1_000_000, `${big.length} bytes`);

  await page.click('.btn--big:not(.btn--camera)');
  check('upload: refuses to start without a name', (await page.locator('.toast').count()) === 1);

  await page.fill('.field', 'Oma Lotte');
  await page.setInputFiles('input[type=file][multiple]', [
    { name: 'IMG_0001.jpg', mimeType: 'image/jpeg', buffer: big }
  ]);
  await page.waitForSelector('.job--done', { timeout: 30000 });

  check('upload: wrote photo and thumbnail', repo.puts.length === 2, JSON.stringify(repo.puts));
  const photo = repo.puts.find((p) => p.path.startsWith('photos/'));
  const thumb = repo.puts.find((p) => p.path.startsWith('thumbs/'));
  check('upload: photo path carries day, time, name and hash',
    /^photos\/\d{4}-\d{2}-\d{2}\/\d{6}__Oma-Lotte__[0-9a-f]{8}\.jpg$/.test(photo.path), photo.path);
  check('upload: thumbnail mirrors the photo path',
    thumb.path === photo.path.replace('photos/', 'thumbs/'), thumb.path);
  check('upload: photo was uploaded before its thumbnail',
    repo.puts[0].path.startsWith('photos/'), repo.puts[0].path);
  // The fixture is far grainier than a real photo (grain is the one thing JPEG
  // cannot throw away), so judge the resize by ratio rather than by an absolute
  // size a real 12 MP photo would beat comfortably.
  check('upload: 12 MP photo shrinks to a fraction of the original',
    photo.size < big.length / 3 && photo.size < 1_500_000,
    `${big.length} bytes in, ${photo.size} bytes out`);
  check('upload: thumbnail is tiny', thumb.size < 80_000, `${thumb.size} bytes`);

  const photoBytes = repo.tree.get(photo.path).bytes;
  const thumbBytes = repo.tree.get(thumb.path).bytes;
  const photoDim = jpegSize(photoBytes), thumbDim = jpegSize(thumbBytes);
  check('upload: photo is scaled to a 2560px long edge',
    Math.max(photoDim.width, photoDim.height) === 2560, JSON.stringify(photoDim));
  check('upload: aspect ratio survives the resize',
    Math.abs(photoDim.width / photoDim.height - 4000 / 3000) < 0.01, JSON.stringify(photoDim));
  check('upload: thumbnail is scaled to a 480px long edge',
    Math.max(thumbDim.width, thumbDim.height) === 480, JSON.stringify(thumbDim));
  check('upload: reports what happened', (await page.textContent('.summary')).includes('Album'));

  // Same file again: content-addressed, so it must be recognised, not duplicated.
  await page.setInputFiles('input[type=file][multiple]', [
    { name: 'kopie.jpg', mimeType: 'image/jpeg', buffer: big }
  ]);
  await page.waitForSelector('.job--skip');
  check('upload: the same photo twice is a no-op', repo.puts.length === 2, JSON.stringify(repo.puts.map(p => p.path)));

  check('upload: no page errors', page._errors.length === 0, page._errors.join('\n'));
  await page.context().close();
}

// --- 3b. taking a photo goes straight into the album ----------------------
{
  // A phone context, so the (hover: none) rules that show the camera button apply.
  const context = await browser.newContext({
    viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true
  });
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  page._errors = errors;

  const repo = makeRepo();
  await stubGitHub(page, repo);
  await page.goto(LINK('upload.html'));
  await page.waitForSelector('.drop');

  const camera = page.locator('input[capture]');
  check('camera: the button is offered on a phone', await page.isVisible('.btn--camera'));
  check('camera: opens the rear camera, not the picker',
    await camera.getAttribute('capture') === 'environment' &&
    await camera.getAttribute('accept') === 'image/*');
  check('camera: shoots one photo at a time', await camera.getAttribute('multiple') === null);

  await page.fill('.field', 'Jonas');
  // setInputFiles on the capture input is exactly what the camera hands back.
  await camera.setInputFiles([{ name: 'image.jpg', mimeType: 'image/jpeg', buffer: await makeJpeg(3000, 4000, 200) }]);
  await page.waitForSelector('.job--done', { timeout: 30000 });
  check('camera: a shot lands in the album like any other photo',
    repo.puts.length === 2 && repo.puts[0].path.startsWith('photos/'),
    JSON.stringify(repo.puts.map((p) => p.path)));
  check('camera: portrait orientation survives',
    (() => { const d = jpegSize(repo.tree.get(repo.puts[0].path).bytes); return d.height > d.width; })(),
    JSON.stringify(jpegSize(repo.tree.get(repo.puts[0].path).bytes)));
  check('camera: no page errors', errors.length === 0, errors.join('\n'));
  await context.close();
}

// --- 3c. no camera button where there is a mouse --------------------------
{
  const page = await newPage();
  await stubGitHub(page, makeRepo());
  await page.goto(LINK('upload.html'));
  await page.waitForSelector('.drop');
  check('desktop: camera button stays hidden', !(await page.isVisible('.btn--camera')));
  check('desktop: the gallery button is still there', await page.isVisible('.btn--big:not(.btn--camera)'));
  await page.context().close();
}

// --- 3d. deleting your own photo ------------------------------------------
{
  const page = await newPage();
  const repo = makeRepo();
  await stubGitHub(page, repo);
  const jpeg = await makeJpeg(400, 300, 40);
  for (const [who, id] of [['Jonas', 'aaaaaaaa'], ['Oma-Lotte', 'bbbbbbbb']]) {
    const name = `2026-08-07/12000${id === 'aaaaaaaa' ? 1 : 2}__${who}__${id}.jpg`;
    repo.add(`photos/${name}`, jpeg);
    repo.add(`thumbs/${name}`, jpeg);
  }

  await page.goto(LINK('upload.html'));
  await page.waitForSelector('.drop');
  await page.fill('.field', 'Jonas');           // this browser belongs to Jonas
  await page.click('.btn--ghost');              // "Zum Album"
  await page.waitForSelector('.tile.is-loaded');

  // Oma Lotte's photo is first (later timestamp): no delete button on it.
  await page.locator('.tile').first().click();
  await page.waitForSelector('.lightbox:not(.is-hidden)');
  check('delete: not offered on someone else\'s photo',
    !(await page.isVisible('.btn--danger')),
    await page.textContent('.lightbox__caption'));

  await page.keyboard.press('ArrowRight');
  await page.waitForTimeout(250);
  check('delete: offered on your own photo', await page.isVisible('.btn--danger'),
    await page.textContent('.lightbox__caption'));

  await page.click('.btn--danger');
  await page.waitForSelector('.confirm:not(.is-hidden)');
  check('delete: asks first, and says the repository keeps a copy',
    (await page.textContent('.confirm__text')).includes('Versionsgeschichte'));

  await page.keyboard.press('Escape');
  check('delete: escape backs out of the confirmation, not the photo',
    await page.locator('.confirm.is-hidden').count() === 1 &&
    await page.locator('.lightbox:not(.is-hidden)').count() === 1);
  check('delete: backing out deletes nothing', repo.deletes.length === 0);

  await page.click('.btn--danger');
  await page.click('.confirm .btn--danger');
  // waitForSelector waits for visibility, and .is-hidden never becomes visible.
  await page.waitForFunction(() => document.querySelector('.lightbox').classList.contains('is-hidden'));

  check('delete: removes thumbnail first, then the photo',
    repo.deletes.length === 2 &&
    repo.deletes[0].startsWith('thumbs/') && repo.deletes[1].startsWith('photos/'),
    JSON.stringify(repo.deletes));
  check('delete: only Jonas\'s photo went', repo.deletes.every((p) => p.includes('__Jonas__')),
    JSON.stringify(repo.deletes));
  check('delete: the tile disappears at once', (await page.locator('.tile').count()) === 1);
  check('delete: no page errors', page._errors.length === 0, page._errors.join('\n'));
  await page.context().close();
}

// --- 3e. a read-only code cannot delete -----------------------------------
{
  const page = await newPage();
  const repo = makeRepo();
  await stubGitHub(page, repo, { writable: false });
  const jpeg = await makeJpeg(400, 300, 40);
  repo.add('photos/2026-08-07/120000__Jonas__cccccccc.jpg', jpeg);
  repo.add('thumbs/2026-08-07/120000__Jonas__cccccccc.jpg', jpeg);

  await page.goto(LINK('index.html'));
  await page.evaluate(() => localStorage.setItem('ps:name', 'Jonas'));
  await page.reload();
  await page.waitForSelector('.tile.is-loaded');
  await page.locator('.tile').first().click();
  await page.click('.btn--danger');
  await page.click('.confirm .btn--danger');
  await page.waitForSelector('.toast--error');
  check('delete: a view-only code is told what it needs',
    (await page.textContent('.toast--error')).includes('Upload-Link'),
    await page.textContent('.toast--error'));
  check('delete: nothing was removed', repo.deletes.length === 0 && repo.tree.size === 2);

  // The refusal is evidence. A button that has already answered "you may not"
  // must not keep offering itself.
  check('delete: the button withdraws after being refused',
    !(await page.isVisible('.btn--danger')));
  await page.reload();
  await page.waitForSelector('.tile.is-loaded');
  await page.locator('.tile').first().click();
  await page.waitForSelector('.lightbox:not(.is-hidden)');
  check('delete: and stays away after a reload',
    !(await page.isVisible('.btn--danger')));
  await page.context().close();
}

// --- 3f. a writable code keeps the button after switching links -----------
{
  const page = await newPage();
  const repo = makeRepo();
  await stubGitHub(page, repo);
  const jpeg = await makeJpeg(300, 300, 90);
  repo.add('photos/2026-08-07/120000__Jonas__dddddddd.jpg', jpeg);
  repo.add('thumbs/2026-08-07/120000__Jonas__dddddddd.jpg', jpeg);

  await page.goto(LINK('index.html'));
  await page.evaluate(() => localStorage.setItem('ps:name', 'Jonas'));
  await page.reload();
  await page.waitForSelector('.tile.is-loaded');
  await page.locator('.tile').first().click();
  check('delete: offered while nothing is known against the code',
    await page.isVisible('.btn--danger'));
  await page.context().close();
}

// --- 3f2. picking yourself off the family photo ---------------------------
{
  const page = await newPage();
  const repo = makeRepo();
  await stubGitHub(page, repo);
  const group = await makeJpeg(800, 500, 60);
  repo.add('people/photo.jpg', group);
  repo.add('people/people.json', Buffer.from(JSON.stringify({
    photo: 'people/photo.jpg',
    people: [
      { name: 'Ines', x: 0.13, y: 0.39 },
      { name: 'Basti', x: 0.46, y: 0.30 },
      { name: 'Jenny', x: 0.90, y: 0.27 }
    ]
  }), 'utf8'));

  await page.goto(LINK('upload.html'));
  // First visit with no name: the picker should come up by itself.
  await page.waitForSelector('.who', { timeout: 15000 });
  check('who: the picker opens on the first visit', true);
  check('who: one target per person', (await page.locator('.who__spot').count()) === 3);
  check('who: nothing is chosen yet', await page.locator('.who__proof.is-hidden').count() === 1);

  await page.locator('.who__spot').nth(1).click();
  await page.waitForSelector('.who__proof:not(.is-hidden)');
  check('who: tapping proposes a name', (await page.textContent('.who__name')) === 'Basti');
  // Invert what the browser is actually rendering: from the computed
  // background size and offset, work out which point of the photo sits in the
  // middle of the crop. That has to be the face - checking that the style
  // "contains a background-position" would pass with any wrong number in it.
  const centred = await page.evaluate(() => {
    const el = document.querySelector('.who__crop');
    const cs = getComputedStyle(el);
    const box = el.getBoundingClientRect();
    const [sw, sh] = cs.backgroundSize.split(' ').map(parseFloat);
    const [px, py] = cs.backgroundPosition.split(' ').map(parseFloat);
    return { x: (box.width / 2 - px) / sw, y: (box.height / 2 - py) / sh };
  });
  check('who: the crop is centred on the face, not near it',
    Math.abs(centred.x - 0.46) < 0.02 && Math.abs(centred.y - 0.30) < 0.02,
    `Mitte des Ausschnitts liegt bei (${centred.x.toFixed(3)}, ${centred.y.toFixed(3)}), erwartet (0.460, 0.300)`);

  // Wrong person: tapping another face must simply re-propose, not commit.
  await page.locator('.who__spot').nth(2).click();
  check('who: tapping again corrects the choice', (await page.textContent('.who__name')) === 'Jenny');
  check('who: still nothing saved before confirming',
    (await page.evaluate(() => localStorage.getItem('ps:name'))) === null);

  await page.click('.who__proof .btn--primary');
  await page.waitForSelector('.who', { state: 'detached' });
  check('who: confirming saves the name',
    (await page.evaluate(() => localStorage.getItem('ps:name'))) === 'Jenny');

  // And the name really is the one used on the upload.
  await page.setInputFiles('input[type=file][multiple]', [
    { name: 'a.jpg', mimeType: 'image/jpeg', buffer: await makeJpeg(600, 400, 10) }
  ]);
  await page.waitForSelector('.job--done', { timeout: 30000 });
  check('who: the picked name lands in the photo path',
    repo.puts[0].path.includes('__Jenny__'), repo.puts[0].path);
  check('who: no page errors', page._errors.length === 0, page._errors.join('\n'));
  await page.context().close();
}

// --- 3f3. an album without a family photo keeps the name field ------------
{
  const page = await newPage();
  const repo = makeRepo();
  await stubGitHub(page, repo);
  await page.goto(LINK('upload.html'));
  await page.waitForSelector('.drop');
  await page.waitForTimeout(500);
  check('who: no picker when the album has no photo', (await page.locator('.who').count()) === 0);
  check('who: the name field is still there', await page.isVisible('.field[type=text]'));
  await page.fill('.field[type=text]', 'Oma Lotte');
  await page.setInputFiles('input[type=file][multiple]', [
    { name: 'b.jpg', mimeType: 'image/jpeg', buffer: await makeJpeg(600, 400, 80) }
  ]);
  await page.waitForSelector('.job--done', { timeout: 30000 });
  check('who: typing still works', repo.puts[0].path.includes('__Oma-Lotte__'), repo.puts[0].path);
  await page.context().close();
}

// --- 3f4. faces beside the names ------------------------------------------
{
  const page = await newPage();
  const repo = makeRepo();
  await stubGitHub(page, repo);
  const group = await makeJpeg(800, 500, 60);
  repo.add('people/photo.jpg', group);
  repo.add('people/people.json', Buffer.from(JSON.stringify({
    photo: 'people/photo.jpg',
    people: [
      { name: 'Ines', x: 0.13, y: 0.39 },
      { name: 'Eva-Maria', x: 0.46, y: 0.30 },
      { name: 'Stefan', x: 0.80, y: 0.22, also: ['Stephan'] }
    ]
  }), 'utf8'));
  const jpeg = await makeJpeg(400, 300, 200);
  // The third one was uploaded under a spelling that has since been corrected.
  const uploads = [['Ines', 'a1a1a1a1', '01'], ['Eva-Maria', 'b2b2b2b2', '02'], ['Stephan', 'c3c3c3c3', '00']];
  for (const [who, id, hh] of uploads) {
    const name = `2026-08-07/1200${hh}__${who}__${id}.jpg`;
    repo.add(`photos/${name}`, jpeg);
    repo.add(`thumbs/${name}`, jpeg);
  }
  repo.add('comments/b2b2b2b2/20260807T121000__Eva-Maria__11aa.txt', Buffer.from('Schön!', 'utf8'));

  await page.goto(LINK('index.html'));
  await page.waitForSelector('.tile.is-loaded');
  await page.waitForFunction(() => document.querySelectorAll('.tile__face').length === 3, { timeout: 15000 });
  check('faces: every tile carries its uploader', true);
  check('faces: the filter chips too',
    (await page.locator('.chip--face .avatar').count()) === 3);

  // A corrected spelling must reach backwards: photos already in the album
  // under the old one keep their face and show the name as it is now.
  const chips = (await page.locator('.chip--face').allTextContents()).map((t) => t.trim());
  check('faces: an old spelling shows the corrected name',
    chips.includes('Stefan') && !chips.includes('Stephan'), JSON.stringify(chips));

  // Invert the rendering again: which point of the group photo is in the
  // middle of this avatar? It has to be the face the name belongs to.
  const centre = await page.evaluate(() => {
    const el = document.querySelector('.chip--face .avatar');
    const cs = getComputedStyle(el);
    const box = el.getBoundingClientRect();
    const [sw, sh] = cs.backgroundSize.split(' ').map(parseFloat);
    const [px, py] = cs.backgroundPosition.split(' ').map(parseFloat);
    return { name: el.title, x: (box.width / 2 - px) / sw, y: (box.height / 2 - py) / sh };
  });
  const want = { Ines: [0.13, 0.39], 'Eva-Maria': [0.46, 0.30] }[centre.name];
  check('faces: an avatar is centred on the person it names',
    Math.abs(centre.x - want[0]) < 0.02 && Math.abs(centre.y - want[1]) < 0.02,
    `${centre.name}: (${centre.x.toFixed(3)}, ${centre.y.toFixed(3)}), erwartet (${want[0]}, ${want[1]})`);

  await page.locator('.tile').first().click();
  await page.waitForSelector('.lightbox:not(.is-hidden)');
  check('faces: the lightbox caption shows one',
    await page.isVisible('.lightbox__face .avatar'));

  await page.click('.lightbox__comments-toggle');
  await page.waitForSelector('.comments:not(.is-hidden)');
  check('faces: and every comment', (await page.locator('.comment .avatar').count()) === 1);

  // The avatar is positioned absolutely, so nothing but a padding keeps it off
  // the text. Measure it rather than trust the stylesheet's ordering.
  const overlap = await page.evaluate(() => {
    const face = document.querySelector('.comment .avatar').getBoundingClientRect();
    const who = document.querySelector('.comment__who').getBoundingClientRect();
    const body = document.querySelector('.comment__text').getBoundingClientRect();
    return { gapToName: who.left - face.right, gapToText: body.left - face.right };
  });
  check('faces: the avatar does not sit on the comment',
    overlap.gapToName >= 0 && overlap.gapToText >= 0,
    `Abstand zum Namen ${overlap.gapToName.toFixed(1)}px, zum Text ${overlap.gapToText.toFixed(1)}px`);

  // "Eva-Maria" becomes "Eva-Maria" in the path and would read back as
  // "Eva Maria"; the map knows the hyphen belongs there.
  const chipNames = await page.locator('.chip--face').allTextContents();
  check('faces: a hyphenated name keeps its hyphen in the filters',
    chipNames.some((t) => t.trim() === 'Eva-Maria'), JSON.stringify(chipNames));
  // Same name, three other places it is printed.
  check('faces: and in the caption',
    (await page.textContent('.lightbox__caption')).includes('Eva-Maria'),
    await page.textContent('.lightbox__caption'));
  check('faces: and above a comment',
    (await page.textContent('.comment__who')) === 'Eva-Maria',
    await page.textContent('.comment__who'));
  check('faces: and on the tile',
    (await page.locator('.tile__by').allTextContents()).includes('Eva-Maria'),
    JSON.stringify(await page.locator('.tile__by').allTextContents()));
  check('faces: no page errors', page._errors.length === 0, page._errors.join('\n'));
  await page.context().close();
}

// --- 3f5. an album with no group photo shows plain names ------------------
{
  const page = await newPage();
  const repo = makeRepo();
  await stubGitHub(page, repo);
  const jpeg = await makeJpeg(300, 300, 120);
  for (const who of ['Ines', 'Basti']) {
    const name = `2026-08-07/1200${who === 'Ines' ? '01' : '02'}__${who}__${who === 'Ines' ? 'c3c3c3c3' : 'd4d4d4d4'}.jpg`;
    repo.add(`photos/${name}`, jpeg);
    repo.add(`thumbs/${name}`, jpeg);
  }
  await page.goto(LINK('index.html'));
  await page.waitForSelector('.tile.is-loaded');
  await page.waitForTimeout(400);
  check('faces: none invented when the album has no photo',
    (await page.locator('.avatar').count()) === 0);
  check('faces: the names are still there',
    (await page.locator('.chip').count()) === 3, 'Alle + zwei Personen');
  await page.context().close();
}

// --- 3g. comments ---------------------------------------------------------
{
  const page = await newPage();
  const repo = makeRepo();
  await stubGitHub(page, repo);
  const jpeg = await makeJpeg(400, 400, 150);
  repo.add('photos/2026-08-07/120000__Maria__eeeeeeee.jpg', jpeg);
  repo.add('thumbs/2026-08-07/120000__Maria__eeeeeeee.jpg', jpeg);
  repo.add('comments/eeeeeeee/20260807T120500__Oma-Lotte__1a2b.txt',
    Buffer.from('Schönes Bild! Grüße von der Omä.', 'utf8'));

  await page.goto(LINK('index.html'));
  await page.waitForSelector('.tile.is-loaded');
  check('comments: the tile shows a thread exists',
    (await page.textContent('.tile__talk')).includes('1'));

  await page.locator('.tile').first().click();
  await page.waitForSelector('.lightbox:not(.is-hidden)');
  check('comments: the count is on the button',
    (await page.textContent('.lightbox__comments-toggle')).includes('1'));

  await page.click('.lightbox__comments-toggle');
  await page.waitForSelector('.comments:not(.is-hidden)');
  check('comments: author and time come from the file name, no fetch needed',
    (await page.textContent('.comment__who')) === 'Oma Lotte');
  await page.waitForFunction(() => {
    const t = document.querySelector('.comment__text');
    return t && t.textContent !== '…';
  });
  check('comments: umlauts survive the round trip',
    (await page.textContent('.comment__text')) === 'Schönes Bild! Grüße von der Omä.',
    await page.textContent('.comment__text'));

  await page.fill('.comments .field[type=text]', 'Jonas');
  await page.fill('.comments__input', 'Das war ein schöner Tag ☀️');
  await page.click('.comments__form .btn--primary');
  await page.waitForFunction(() => document.querySelectorAll('.comment').length === 2);

  const posted = repo.puts.find((p) => p.path.startsWith('comments/'));
  check('comments: written as its own file under the photo id',
    /^comments\/eeeeeeee\/\d{8}T\d{6}__Jonas__[0-9a-f]{4}\.txt$/.test(posted.path), posted.path);
  check('comments: the text goes up as written', posted.text === 'Das war ein schöner Tag ☀️', posted.text);
  check('comments: it appears without waiting for a refresh',
    (await page.locator('.comment').count()) === 2);

  // Two people typing at the same second must both survive - the reason
  // comments are separate files rather than one shared JSON.
  await page.fill('.comments__input', 'Ich auch!');
  await page.click('.comments__form .btn--primary');
  await page.waitForFunction(() => document.querySelectorAll('.comment').length === 3);
  const written = repo.puts.filter((p) => p.path.startsWith('comments/'));
  check('comments: a second one in the same second gets its own path',
    written.length === 2 && written[0].path !== written[1].path,
    JSON.stringify(written.map((p) => p.path)));

  check('comments: no page errors', page._errors.length === 0, page._errors.join('\n'));
  await page.context().close();
}

// --- 3h. comments are read-only without the upload code -------------------
{
  const page = await newPage();
  const repo = makeRepo();
  await stubGitHub(page, repo, { writable: false });
  const jpeg = await makeJpeg(300, 300, 20);
  repo.add('photos/2026-08-07/120000__Maria__ffffffff.jpg', jpeg);
  repo.add('thumbs/2026-08-07/120000__Maria__ffffffff.jpg', jpeg);
  repo.add('comments/ffffffff/20260807T120500__Maria__9c3d.txt', Buffer.from('Da waren alle da.', 'utf8'));

  await page.goto(LINK('index.html'));
  await page.waitForSelector('.tile.is-loaded');
  await page.locator('.tile').first().click();
  await page.click('.lightbox__comments-toggle');
  await page.waitForSelector('.comments:not(.is-hidden)');
  check('comments: a view-only code can still read the thread',
    (await page.locator('.comment').count()) === 1);
  await page.waitForFunction(() => {
    const t = document.querySelector('.comment__text');
    return t && t.textContent !== '…';
  });
  check('comments: and sees the text', (await page.textContent('.comment__text')) === 'Da waren alle da.');
  await page.context().close();
}

// --- 3i. a HEIC arrives as a JPEG -----------------------------------------
{
  const page = await newPage();
  const repo = makeRepo();
  await stubGitHub(page, repo);
  await page.goto(LINK('upload.html'));
  await page.waitForSelector('.drop');
  await page.fill('.field[type=text]', 'Jenny');

  // A real file out of a HEIF encoder, with a capture date in its metadata -
  // the format no Chromium browser can open on its own.
  const heic = await readFile(new URL('./fixtures/photo-with-exif.heic', import.meta.url));
  check('heic: the fixture really is one',
    heic.subarray(4, 8).toString() === 'ftyp', heic.subarray(4, 12).toString());

  await page.setInputFiles('input[type=file][multiple]', [
    { name: 'IMG_4711.HEIC', mimeType: 'image/heic', buffer: heic }
  ]);
  await page.waitForSelector('.job--done', { timeout: 60000 });

  const photo = repo.puts.find((p) => p.path.startsWith('photos/'));
  const bytes = repo.tree.get(photo.path).bytes;
  check('heic: it went up as a JPEG', bytes[0] === 0xff && bytes[1] === 0xd8,
    Array.from(bytes.subarray(0, 4)).map((b) => b.toString(16)).join(' '));
  const dim = jpegSize(bytes);
  check('heic: at the right size', dim.width === 1200 && dim.height === 900, JSON.stringify(dim));
  // The capture date lives in a HEIF metadata item, not an APP1 segment. Get
  // that wrong and every iPhone photo is filed under the day it was copied.
  check('heic: filed under the day it was taken, not today',
    photo.path.startsWith('photos/2026-08-07/2133'), photo.path);
  check('heic: no page errors', page._errors.length === 0, page._errors.join('\n'));
  await page.context().close();
}

// --- 3j. several albums under one roof ------------------------------------
{
  const page = await newPage();
  const repo = makeRepo();
  await stubGitHub(page, repo);
  const jpeg = await makeJpeg(400, 300, 90);

  repo.add('people/photo.jpg', await makeJpeg(600, 400, 30));
  repo.add('people/people.json', Buffer.from(JSON.stringify({
    photo: 'people/photo.jpg', people: [{ name: 'Ines', x: 0.3, y: 0.4 }]
  }), 'utf8'));
  repo.add('albums/evas-treff/album.json',
    Buffer.from(JSON.stringify({ title: "Eva's Treff", date: '2026-08-07' }), 'utf8'));
  repo.add('albums/weihnachten/album.json',
    Buffer.from(JSON.stringify({ title: 'Weihnachten 2025', date: '2025-12-24' }), 'utf8'));
  for (const [album, time, id] of [
    ['evas-treff', '120001', 'aaaaaaaa'], ['evas-treff', '120002', 'bbbbbbbb'],
    ['weihnachten', '180000', 'cccccccc']
  ]) {
    const day = album === 'evas-treff' ? '2026-08-07' : '2025-12-24';
    const name = `${day}/${time}__Ines__${id}.jpg`;
    repo.add(`albums/${album}/photos/${name}`, jpeg);
    repo.add(`albums/${album}/thumbs/${name}`, jpeg);
  }

  await page.goto(LINK('index.html'));
  await page.waitForSelector('.shelf__card');
  check('albums: the shelf shows both', (await page.locator('.shelf__card').count()) === 2);
  const titles = await page.locator('.shelf__title').allTextContents();
  check('albums: newest first', titles[0] === "Eva's Treff" && titles[1] === 'Weihnachten 2025',
    JSON.stringify(titles));
  const counts = await page.locator('.shelf__count').allTextContents();
  check('albums: each counts its own photos',
    counts[0].includes('2 Fotos') && counts[1].includes('1 Foto'), JSON.stringify(counts));
  check('albums: no photos leak onto the shelf', (await page.locator('.tile').count()) === 0);

  // The family photo arrives after the shelf. Its redraw must not paint an
  // album over it.
  await page.waitForTimeout(600);
  check('albums: the shelf survives the faces loading',
    (await page.locator('.shelf__card').count()) === 2 && !(await page.isVisible('.act-add-photos')));

  await page.locator('.shelf__card').nth(1).click();
  await page.waitForSelector('.tile.is-loaded');
  check('albums: opening one shows only its photos', (await page.locator('.tile').count()) === 1,
    page.url());
  check('albums: and names it', (await page.textContent('.topbar__title')) === 'Weihnachten 2025');
  check('albums: with a way back', await page.isVisible('.topbar__back'));

  // Uploading has to land inside the album that was open, not at the root.
  await page.click('.act-add-photos');
  await page.waitForSelector('.drop');
  await page.fill('.field[type=text]', 'Basti');
  await page.setInputFiles('input[type=file][multiple]', [
    { name: 'x.jpg', mimeType: 'image/jpeg', buffer: await makeJpeg(500, 400, 10) }
  ]);
  await page.waitForSelector('.job--done', { timeout: 30000 });
  check('albums: the upload goes into the open album',
    repo.puts.every((p) => p.path.startsWith('albums/weihnachten/')),
    JSON.stringify(repo.puts.map((p) => p.path)));
  check('albums: no page errors', page._errors.length === 0, page._errors.join('\n'));
  await page.context().close();
}

// --- 3k. making a new album -----------------------------------------------
{
  const page = await newPage();
  const repo = makeRepo();
  await stubGitHub(page, repo);
  const jpeg = await makeJpeg(300, 300, 30);
  repo.add('albums/alt/album.json', Buffer.from(JSON.stringify({ title: 'Alt', date: '2020-01-01' }), 'utf8'));
  repo.add('albums/alt/photos/2020-01-01/120000__Ines__11111111.jpg', jpeg);
  repo.add('albums/alt/thumbs/2020-01-01/120000__Ines__11111111.jpg', jpeg);
  repo.add('albums/zwei/album.json', Buffer.from(JSON.stringify({ title: 'Zwei', date: '2021-01-01' }), 'utf8'));

  page.on('dialog', (d) => d.accept('Sommerurlaub 2027'));
  await page.goto(LINK('index.html'));
  await page.waitForSelector('.shelf__card');
  await page.click('.act-new-album');
  await page.waitForURL(/upload\.html\?album=sommerurlaub-2027/, { timeout: 15000 });

  const made = repo.puts.find((p) => p.path.endsWith('album.json'));
  check('albums: a new one is a manifest and nothing else',
    made.path === 'albums/sommerurlaub-2027/album.json', made.path);
  check('albums: the title is kept as typed',
    JSON.parse(made.text).title === 'Sommerurlaub 2027', made.text);
  check('albums: and it opens ready to fill', page.url().includes('upload.html?album=sommerurlaub-2027'));
  await page.context().close();
}

// --- 3l. a repository from before albums existed --------------------------
{
  const page = await newPage();
  const repo = makeRepo();
  await stubGitHub(page, repo);
  const jpeg = await makeJpeg(300, 300, 200);
  repo.add('photos/2026-08-07/120000__Ines__99999999.jpg', jpeg);
  repo.add('thumbs/2026-08-07/120000__Ines__99999999.jpg', jpeg);

  await page.goto(LINK('index.html'));
  await page.waitForSelector('.tile.is-loaded');
  check('albums: the old layout opens straight into its photos',
    (await page.locator('.tile').count()) === 1 && (await page.locator('.shelf__card').count()) === 0);
  check('albums: and hides a way back that leads nowhere',
    !(await page.isVisible('.topbar__back')));
  await page.context().close();
}

// --- 3m. the pinboard ------------------------------------------------------
{
  const page = await newPage();
  const repo = makeRepo();
  await stubGitHub(page, repo);
  repo.add('people/photo.jpg', await makeJpeg(600, 400, 30));
  repo.add('people/people.json', Buffer.from(JSON.stringify({
    photo: 'people/photo.jpg', people: [{ name: 'Ines', x: 0.3, y: 0.4 }, { name: 'Stefan', x: 0.7, y: 0.3 }]
  }), 'utf8'));
  repo.add('board/20260807T210000__Ines__1a2b.md', Buffer.from('Danke fürs Ausrichten! ❤️', 'utf8'));
  repo.add('board/20260806T090000__Stefan__7f3c.md', Buffer.from('Wer hat den Grill?', 'utf8'));
  repo.add('board/20260806T090000__Stefan__7f3c.jpg', await makeJpeg(500, 400, 210));

  await page.goto(LINK('board.html'));
  await page.waitForSelector('.post');
  check('board: shows the posts', (await page.locator('.post').count()) === 2);
  check('board: newest first',
    (await page.locator('.post__who').first().textContent()) === 'Ines');
  await page.waitForFunction(() => [...document.querySelectorAll('.post__text')].every((t) => t.textContent !== '…'));
  check('board: the text arrives',
    (await page.locator('.post__text').first().textContent()) === 'Danke fürs Ausrichten! ❤️');
  await page.waitForFunction(() => {
    const i = document.querySelector('.post__image');
    return i && i.naturalWidth > 0;
  }, { timeout: 15000 });
  check('board: a post can carry a picture', true);
  check('board: with the faces beside the names',
    (await page.locator('.post .avatar').count()) === 2);
  check('board: and a bar to get back to the albums',
    await page.isVisible('.nav__item[href="index.html"]'));

  // Posting
  await page.evaluate(() => localStorage.setItem('ps:name', 'Stefan'));
  await page.reload();
  await page.waitForSelector('.post');
  await page.fill('.compose textarea', 'Nächstes Jahr wieder!');
  await page.click('.compose .btn--primary');
  await page.waitForFunction(() => document.querySelectorAll('.post').length === 3, { timeout: 20000 });

  const written = repo.puts.filter((p) => p.path.startsWith('board/'));
  check('board: a post is one file',
    written.length === 1 && /^board\/\d{8}T\d{6}__Stefan__[0-9a-f]{4}\.md$/.test(written[0].path),
    JSON.stringify(written.map((p) => p.path)));
  check('board: with the text as written', written[0].text === 'Nächstes Jahr wieder!', written[0].text);

  // Deleting: only your own, and the picture goes with it.
  const mine = await page.locator('.post', { has: page.locator('.comment__remove') }).count();
  check('board: only your own posts offer a delete', mine === 2, `${mine} von 3`);
  page.on('dialog', (d) => d.accept());
  await page.locator('.post', { hasText: 'Wer hat den Grill?' }).locator('.comment__remove').click();
  await page.waitForFunction(() => document.querySelectorAll('.post').length === 2, { timeout: 15000 });
  check('board: deleting takes the picture with it',
    repo.deletes.length === 2 && repo.deletes.some((p) => p.endsWith('.jpg')) &&
    repo.deletes.some((p) => p.endsWith('.md')),
    JSON.stringify(repo.deletes));
  check('board: no page errors', page._errors.length === 0, page._errors.join('\n'));
  await page.context().close();
}

// --- 3n. a view-only code reads the board but cannot post -----------------
{
  const page = await newPage();
  const repo = makeRepo();
  await stubGitHub(page, repo, { writable: false });
  repo.add('board/20260807T210000__Ines__1a2b.md', Buffer.from('Hallo!', 'utf8'));
  await page.goto(LINK('board.html'));
  await page.waitForSelector('.post');
  await page.evaluate(() => localStorage.setItem('ps:ability', 'read'));
  check('board: a view-only code still reads it', (await page.locator('.post').count()) === 1);
  await page.context().close();
}

// --- 4. a read-only code cannot upload ------------------------------------
{
  const page = await newPage();
  const repo = makeRepo();
  await stubGitHub(page, repo, { writable: false });
  await page.goto(LINK('upload.html'));
  await page.fill('.field', 'Jonas');
  const jpeg = await makeJpeg(800, 600, 300);
  await page.setInputFiles('input[type=file][multiple]', [{ name: 'a.jpg', mimeType: 'image/jpeg', buffer: jpeg }]);
  await page.waitForSelector('.job--error');
  check('upload: read-only code gets a usable explanation',
    (await page.textContent('.job__state')).includes('Upload-Link'),
    await page.textContent('.job__state'));
  await page.context().close();
}

// --- 4b. a brand new, still empty album -----------------------------------
{
  const page = await newPage();
  await stubGitHub(page, makeRepo(), { noBranch: true });
  await page.goto(LINK('index.html'));
  await page.waitForSelector('.status', { timeout: 10000 });
  const text = await page.textContent('.status');
  check('empty album: says it is empty, not that access is missing',
    text.includes('Noch keine Fotos') && !text.includes('Kein Zugriff'), text.trim());
  await page.context().close();
}

// --- 4c. a repository the code cannot reach -------------------------------
{
  const page = await newPage();
  await stubGitHub(page, makeRepo(), { noRepo: true });
  await page.goto(LINK('index.html'));
  await page.waitForSelector('.status--error', { timeout: 10000 });
  const denied = await page.textContent('.status--error');
  check('unreachable album: names the album and the likely cause',
    denied.includes('fam/album') && denied.includes('Repository access'), denied.trim());
  await page.context().close();
}

// --- 5. share page --------------------------------------------------------
{
  const page = await newPage();
  await page.goto(`${origin}/share.html`);
  await page.waitForSelector('.card--view');
  await page.fill('.formrow:nth-of-type(1) .field', 'fam/album');
  const inputs = page.locator('.panel .field');
  await inputs.nth(0).fill('fam/album');
  await inputs.nth(2).fill('Familientreffen 2026');
  await inputs.nth(3).fill('github_pat_view_1234567890');
  await inputs.nth(4).fill('github_pat_write_1234567890');
  await page.waitForSelector('.card--view .qr svg');

  const viewLink = await page.textContent('.card--view .urlbox');
  const uploadLink = await page.textContent('.card--upload .urlbox');
  check('share: view link points at the gallery', viewLink.includes('index.html#') && viewLink.includes('k=github_pat_view'), viewLink);
  check('share: upload link points at the uploader', uploadLink.includes('upload.html#') && uploadLink.includes('k=github_pat_write'), uploadLink);
  check('share: renders a QR code for each link', (await page.locator('.qr svg').count()) === 2);
  check('share: never calls GitHub', page._errors.length === 0, page._errors.join('\n'));
  await page.context().close();
}

// --- 6. opened straight from disk ----------------------------------------
{
  const page = await newPage();
  await page.goto('file://' + path.join(APP, 'index.html'));
  await page.waitForSelector('.gate', { timeout: 5000 }).catch(() => {});
  check('file://: the app still boots without a web server',
    await page.locator('.gate').count() === 1,
    page._errors.join('\n') || 'no .gate rendered');
  await page.context().close();
}

await fixtureContext.close();
await browser.close();
server.close();

const failed = checks.filter((c) => !c.ok);
console.log(`\n${checks.length - failed.length}/${checks.length} checks passed`);
process.exit(failed.length ? 1 : 0);
