/*
 * Move an album out of the GitHub repository and into Supabase.
 *
 * Re-runnable on purpose. Everything it writes is keyed on something stable —
 * the album's slug, the photo's content hash, a comment's original file path —
 * so running it twice adds nothing the second time. That matters because the
 * real run happens on switch-over day, after the family has kept using the old
 * app for a while, and it has to pick up whatever arrived in the meantime.
 *
 * The service role key bypasses row level security, which is exactly what an
 * import needs and exactly why it must not live in a repository or pass
 * through anyone else's hands. Supply it in the environment:
 *
 *   SUPABASE_URL=https://xxxx.supabase.co \
 *   SUPABASE_SERVICE_KEY=eyJ... \
 *   node tools/migrate-to-supabase.mjs ../evas-treff
 *
 * Add --dry-run to see what it would do and touch nothing.
 */
import { readFile, readdir, stat } from 'node:fs/promises';
import path from 'node:path';

const REPO = process.argv[2];
const DRY = process.argv.includes('--dry-run');
const URL_BASE = process.env.SUPABASE_URL;
const KEY = process.env.SUPABASE_SERVICE_KEY;

if (!REPO) {
  console.error('usage: node tools/migrate-to-supabase.mjs <pfad-zum-album-repo> [--dry-run]');
  process.exit(64);
}
if (!DRY && (!URL_BASE || !KEY)) {
  console.error('SUPABASE_URL und SUPABASE_SERVICE_KEY müssen gesetzt sein (oder --dry-run benutzen).');
  process.exit(64);
}

const PHOTO = /^(\d{6})__(.+?)__([0-9a-f]{8})\.jpg$/;
const COMMENT = /^(\d{8}T\d{6})__(.+?)__([0-9a-f]{4})\.txt$/;
const BOARD = /^(\d{8}T\d{6})__(.+?)__([0-9a-f]{4})\.(md|jpg)$/;

const unslug = (s) => s.replace(/-/g, ' ');

async function exists(p) {
  try { await stat(p); return true; } catch { return false; }
}
async function listDir(p) {
  try { return await readdir(p); } catch { return []; }
}

/** Walk one album folder (or the repository root, for the old layout). */
async function readAlbum(root, slug) {
  const base = slug ? path.join(REPO, 'albums', slug) : REPO;
  const manifest = await readFile(path.join(base, 'album.json'), 'utf8').catch(() => null);
  const meta = manifest ? JSON.parse(manifest) : {};
  const photos = [];

  for (const day of (await listDir(path.join(base, 'thumbs'))).sort()) {
    for (const file of (await listDir(path.join(base, 'thumbs', day))).sort()) {
      const m = PHOTO.exec(file);
      if (!m) continue;
      const full = path.join(base, 'photos', day, file);
      if (!(await exists(full))) continue;   // a thumbnail with no photo is half an upload
      const [, time, who, hash] = m;
      photos.push({
        hash,
        uploader: unslug(who),
        takenAt: `${day}T${time.slice(0, 2)}:${time.slice(2, 4)}:${time.slice(4, 6)}`,
        photoFile: full,
        thumbFile: path.join(base, 'thumbs', day, file),
        comments: []
      });
    }
  }

  const byHash = new Map(photos.map((p) => [p.hash, p]));
  for (const id of await listDir(path.join(base, 'comments'))) {
    const target = byHash.get(id);
    for (const file of (await listDir(path.join(base, 'comments', id))).sort()) {
      const m = COMMENT.exec(file);
      if (!m || !target) continue;
      const [, stamp, who] = m;
      target.comments.push({
        at: `${stamp.slice(0, 4)}-${stamp.slice(4, 6)}-${stamp.slice(6, 8)}T` +
            `${stamp.slice(9, 11)}:${stamp.slice(11, 13)}:${stamp.slice(13, 15)}`,
        author: unslug(who),
        path: path.join('comments', id, file),
        body: await readFile(path.join(base, 'comments', id, file), 'utf8')
      });
    }
  }

  return {
    slug: slug || 'album',
    title: meta.title || slug || 'Album',
    date: meta.date || (photos.length ? photos[photos.length - 1].takenAt.slice(0, 10) : null),
    photos
  };
}

async function readBoard() {
  const posts = [];
  const seen = {};
  for (const file of (await listDir(path.join(REPO, 'board'))).sort()) {
    const m = BOARD.exec(file);
    if (!m) continue;
    const [, stamp, who, nonce, kind] = m;
    const id = `${stamp}__${who}__${nonce}`;
    const post = seen[id] || (seen[id] = {
      id,
      at: `${stamp.slice(0, 4)}-${stamp.slice(4, 6)}-${stamp.slice(6, 8)}T` +
          `${stamp.slice(9, 11)}:${stamp.slice(11, 13)}:${stamp.slice(13, 15)}`,
      author: unslug(who), body: '', imageFile: null
    });
    if (kind === 'md') post.body = await readFile(path.join(REPO, 'board', file), 'utf8');
    else post.imageFile = path.join(REPO, 'board', file);
  }
  for (const id of Object.keys(seen)) if (seen[id].body || seen[id].imageFile) posts.push(seen[id]);
  return posts;
}

// --- talking to Supabase ---------------------------------------------------

async function rest(pathname, init = {}) {
  const response = await fetch(`${URL_BASE}${pathname}`, {
    ...init,
    headers: {
      apikey: KEY,
      Authorization: `Bearer ${KEY}`,
      'Content-Type': 'application/json',
      ...(init.headers || {})
    }
  });
  if (!response.ok) {
    throw new Error(`${init.method || 'GET'} ${pathname} → ${response.status}: ${await response.text()}`);
  }
  return response.status === 204 ? null : response.json();
}

async function upload(bucket, objectPath, file) {
  const body = await readFile(file);
  const response = await fetch(`${URL_BASE}/storage/v1/object/${bucket}/${objectPath}`, {
    method: 'POST',
    headers: {
      apikey: KEY,
      Authorization: `Bearer ${KEY}`,
      'Content-Type': 'image/jpeg',
      'x-upsert': 'true'          // re-runnable: the same file twice is fine
    },
    body
  });
  if (!response.ok && response.status !== 409) {
    throw new Error(`upload ${objectPath} → ${response.status}: ${await response.text()}`);
  }
}

// --- the run ---------------------------------------------------------------

const slugs = (await listDir(path.join(REPO, 'albums'))).filter((s) => !s.startsWith('.'));
const albums = slugs.length
  ? await Promise.all(slugs.map((slug) => readAlbum(REPO, slug)))
  : [await readAlbum(REPO, '')];
const board = await readBoard();

const photoCount = albums.reduce((n, a) => n + a.photos.length, 0);
const commentCount = albums.reduce((n, a) => n + a.photos.reduce((m, p) => m + p.comments.length, 0), 0);
console.log(`Gefunden: ${albums.length} Alben, ${photoCount} Fotos, ${commentCount} Kommentare, ${board.length} Pinnwand-Beiträge`);
albums.forEach((a) => console.log(`  ${a.slug.padEnd(16)} ${String(a.photos.length).padStart(4)} Fotos  „${a.title}"`));

if (DRY) {
  console.log('\n--dry-run: nichts geschrieben.');
  process.exit(0);
}

for (const album of albums) {
  const [row] = await rest('/rest/v1/albums?on_conflict=slug', {
    method: 'POST',
    headers: { Prefer: 'resolution=merge-duplicates,return=representation' },
    body: JSON.stringify({ slug: album.slug, title: album.title, event_date: album.date })
  });
  console.log(`\nAlbum „${album.title}" → ${row.id}`);

  let added = 0, already = 0;
  for (const photo of album.photos) {
    const objectBase = `${album.slug}/${photo.hash}`;
    await upload('photos', `${objectBase}.jpg`, photo.photoFile);
    await upload('photos', `${objectBase}_thumb.jpg`, photo.thumbFile);

    const inserted = await rest('/rest/v1/photos?on_conflict=album_id,content_hash', {
      method: 'POST',
      headers: { Prefer: 'resolution=merge-duplicates,return=representation' },
      body: JSON.stringify({
        album_id: row.id,
        storage_path: `${objectBase}.jpg`,
        thumb_path: `${objectBase}_thumb.jpg`,
        content_hash: photo.hash,
        taken_at: photo.takenAt,
        uploader_name: photo.uploader,
        bytes: (await stat(photo.photoFile)).size
      })
    });
    const photoId = inserted[0].id;
    if (inserted[0].created_at) added++; else already++;

    for (const comment of photo.comments) {
      // Comments carry no hash, so they are matched on photo + author + time.
      const found = await rest(`/rest/v1/comments?photo_id=eq.${photoId}` +
        `&created_at=eq.${encodeURIComponent(comment.at)}&select=id`);
      if (found.length) continue;
      await rest('/rest/v1/comments', {
        method: 'POST',
        body: JSON.stringify({
          photo_id: photoId, body: comment.body,
          author_name: comment.author, created_at: comment.at
        })
      });
    }
  }
  console.log(`  ${added} Fotos übernommen, ${already} waren schon da`);
}

for (const post of board) {
  const found = await rest(`/rest/v1/board_posts?created_at=eq.${encodeURIComponent(post.at)}` +
    `&author_name=eq.${encodeURIComponent(post.author)}&select=id`);
  if (found.length) continue;
  let imagePath = null;
  if (post.imageFile) {
    imagePath = `board/${post.id}.jpg`;
    await upload('photos', imagePath, post.imageFile);
  }
  await rest('/rest/v1/board_posts', {
    method: 'POST',
    body: JSON.stringify({
      body: post.body, image_path: imagePath,
      author_name: post.author, created_at: post.at
    })
  });
}
if (board.length) console.log(`\nPinnwand: ${board.length} Beiträge geprüft`);

console.log('\nFertig.');
