/*
 * What the screens ask for, in the shapes they already use.
 *
 * The gallery, the lightbox, the comments and the faces were all written
 * against files in a git repository. None of that has to change because the
 * store did: this module answers the same questions against Postgres and
 * Storage, and hands back the same objects — a photo still has a day, a time,
 * an uploader and its comments.
 *
 * Two things genuinely differ, and both are improvements:
 *
 *   * Images arrive as signed URLs, batch-signed once per screen, instead of
 *     one authenticated download per tile.
 *   * A comment's text comes with the comment. It used to be a separate file
 *     and therefore a separate request.
 */
(function (global) {
  'use strict';

  var PS = global.PS || (global.PS = {});
  var data = {};

  var SIGN_SECONDS = 3600;

  function two(n) { return String(n).padStart(2, '0'); }

  /** Split a timestamp the way the file names used to, so the UI is unchanged. */
  function dayAndTime(iso) {
    var at = new Date(iso);
    return {
      at: at,
      day: at.getFullYear() + '-' + two(at.getMonth() + 1) + '-' + two(at.getDate()),
      time: two(at.getHours()) + two(at.getMinutes()) + two(at.getSeconds())
    };
  }

  // --- albums ---------------------------------------------------------------

  data.albums = async function () {
    var rows = await PS.sb.select('albums',
      'select=id,slug,title,event_date,photos(count)&order=event_date.desc,title.asc');

    // One cover per album: its newest photo. A second small query rather than a
    // lateral join keeps the first one readable, and both are indexed.
    var covers = await PS.sb.select('photos',
      'select=album_id,thumb_path,taken_at&order=album_id,taken_at.desc');
    var coverFor = {};
    covers.forEach(function (row) {
      if (!coverFor[row.album_id]) coverFor[row.album_id] = row.thumb_path;
    });

    var paths = Object.keys(coverFor).map(function (id) { return coverFor[id]; });
    var signed = await PS.sb.signPaths('photos', paths, SIGN_SECONDS);

    return rows.map(function (row) {
      return {
        id: row.id,
        slug: row.slug,
        title: row.title,
        date: row.event_date || '',
        count: (row.photos && row.photos[0] && row.photos[0].count) || 0,
        coverUrl: signed[coverFor[row.id]] || null
      };
    });
  };

  data.createAlbum = async function (title, date, slug) {
    var rows = await PS.sb.insert('albums', {
      slug: slug, title: title, event_date: date || null,
      created_by: PS.sb.user() && PS.sb.user().id
    });
    return rows[0];
  };

  // --- photos ---------------------------------------------------------------

  /**
   * Every photo in an album, newest first, comments included.
   *
   * One query for the photos with their comments nested, one signing call for
   * all the images. Two requests for a whole album, regardless of its size.
   */
  data.photos = async function (albumId) {
    var rows = await PS.sb.select('photos',
      'select=id,storage_path,thumb_path,content_hash,taken_at,uploader_id,uploader_name,' +
      'comments(id,body,author_id,author_name,created_at)' +
      '&album_id=eq.' + albumId + '&order=taken_at.desc');

    var paths = [];
    rows.forEach(function (row) { paths.push(row.thumb_path, row.storage_path); });
    var signed = await PS.sb.signPaths('photos', paths, SIGN_SECONDS);

    return rows.map(function (row) {
      var when = dayAndTime(row.taken_at);
      return {
        id: row.id,
        hash: row.content_hash,
        day: when.day,
        time: when.time,
        at: when.at,
        uploader: row.uploader_name,
        uploaderId: row.uploader_id,
        thumbUrl: signed[row.thumb_path] || null,
        photoUrl: signed[row.storage_path] || null,
        storagePath: row.storage_path,
        thumbPath: row.thumb_path,
        comments: (row.comments || [])
          .map(function (c) {
            return {
              id: c.id, body: c.body, author: c.author_name,
              authorId: c.author_id, at: new Date(c.created_at)
            };
          })
          .sort(function (a, b) { return a.at - b.at; })
      };
    });
  };

  data.knownHashes = async function (albumId) {
    var rows = await PS.sb.select('photos', 'select=content_hash&album_id=eq.' + albumId);
    var seen = new Set();
    rows.forEach(function (row) { seen.add(row.content_hash); });
    return seen;
  };

  data.addPhoto = async function (album, photo) {
    var base = album.slug + '/' + photo.hash;
    // Picture before row, mirroring the old upload order for the same reason:
    // a row pointing at a file that is not there shows a broken tile, while a
    // file with no row is merely invisible.
    await PS.sb.upload('photos', base + '.jpg', photo.full);
    await PS.sb.upload('photos', base + '_thumb.jpg', photo.thumb);
    var rows = await PS.sb.insert('photos', {
      album_id: album.id,
      storage_path: base + '.jpg',
      thumb_path: base + '_thumb.jpg',
      content_hash: photo.hash,
      taken_at: photo.takenAt.toISOString(),
      uploader_id: PS.sb.user() && PS.sb.user().id,
      uploader_name: photo.uploader,
      width: photo.width, height: photo.height, bytes: photo.full.size
    });
    return rows[0];
  };

  data.removePhoto = async function (photo) {
    // The row goes first: comments cascade with it, and a leftover file is
    // invisible while a leftover row is a tile that opens into nothing.
    await PS.sb.remove('photos', 'id=eq.' + photo.id);
    await PS.sb.removeFiles('photos', [photo.storagePath, photo.thumbPath]);
  };

  // --- comments -------------------------------------------------------------

  data.addComment = async function (photoId, body, author) {
    var rows = await PS.sb.insert('comments', {
      photo_id: photoId, body: body,
      author_id: PS.sb.user() && PS.sb.user().id, author_name: author
    });
    var row = rows[0];
    return { id: row.id, body: row.body, author: row.author_name, authorId: row.author_id, at: new Date(row.created_at) };
  };

  data.removeComment = async function (comment) {
    await PS.sb.remove('comments', 'id=eq.' + comment.id);
  };

  // --- the pinboard ---------------------------------------------------------

  /**
   * A name for a file nothing else will ever claim.
   *
   * The photos are named by their content, which makes a re-upload a no-op —
   * exactly what you want there. A pinboard picture is the opposite: two posts
   * may legitimately share a picture, and deleting one must not blank the
   * other, so each gets its own object.
   */
  function objectId() {
    if (global.crypto && global.crypto.randomUUID) return global.crypto.randomUUID();
    return Date.now().toString(36) + '-' + Math.floor(Math.random() * 1e9).toString(36);
  }

  data.posts = async function () {
    var rows = await PS.sb.select('board_posts',
      'select=id,body,image_path,author_id,author_name,created_at&order=created_at.desc');

    var paths = [];
    rows.forEach(function (row) { if (row.image_path) paths.push(row.image_path); });
    var signed = await PS.sb.signPaths('photos', paths, SIGN_SECONDS);

    return rows.map(function (row) {
      return {
        id: row.id,
        body: row.body || '',
        author: row.author_name,
        authorId: row.author_id,
        at: new Date(row.created_at),
        imagePath: row.image_path || null,
        imageUrl: row.image_path ? (signed[row.image_path] || null) : null
      };
    });
  };

  data.addPost = async function (body, image, author) {
    var path = null;
    // Picture first, same order and same reason as a photo: a post that says
    // "look at this" with no picture yet reads as finished and is not.
    if (image) {
      path = 'board/' + objectId() + '.jpg';
      await PS.sb.upload('photos', path, image);
    }
    var rows = await PS.sb.insert('board_posts', {
      body: body || '', image_path: path,
      author_id: PS.sb.user() && PS.sb.user().id, author_name: author
    });
    var row = rows[0];
    return {
      id: row.id, body: row.body || '', author: row.author_name, authorId: row.author_id,
      at: new Date(row.created_at), imagePath: path, imageUrl: null
    };
  };

  data.removePost = async function (post) {
    await PS.sb.remove('board_posts', 'id=eq.' + post.id);
    if (post.imagePath) await PS.sb.removeFiles('photos', [post.imagePath]);
  };

  // --- people ---------------------------------------------------------------

  data.people = async function () {
    var rows = await PS.sb.select('people', 'select=name,face_x,face_y,aliases&order=sort_order');
    if (!rows.length) return null;
    var signed = await PS.sb.signPaths('people', ['photo.jpg'], SIGN_SECONDS);
    if (!signed['photo.jpg']) return null;
    return {
      photoUrl: signed['photo.jpg'],
      people: rows.map(function (row) {
        return { name: row.name, x: row.face_x, y: row.face_y, also: row.aliases || [] };
      })
    };
  };

  /** Who am I, and which face is mine. */
  data.me = async function () {
    var user = await PS.sb.loadUser();
    if (!user) return null;
    // Everyone may read every profile, so this must name the row explicitly -
    // "the first one" would happily be somebody else.
    var rows = await PS.sb.select('profiles',
      'select=id,email,is_admin,person_id,people(name)&id=eq.' + user.id);
    if (!rows.length) return null;
    var row = rows[0];
    return {
      id: row.id, email: row.email, isAdmin: row.is_admin,
      name: (row.people && row.people.name) || null
    };
  };

  /** Tie this account to a face on the group photo. */
  data.linkMe = async function (personName) {
    var user = await PS.sb.loadUser();
    var rows = await PS.sb.select('people', 'select=id&name=eq.' + encodeURIComponent(personName));
    if (!rows.length) return null;
    await PS.sb.patch('profiles', 'id=eq.' + user.id, { person_id: rows[0].id });
    return personName;
  };

  // --- the guest list -------------------------------------------------------

  data.invites = async function () {
    return PS.sb.select('invites',
      'select=email,is_admin,invited_at,used_at,person_id,people(name)&order=invited_at');
  };

  data.invite = async function (email, personName, isAdmin) {
    var personId = null;
    if (personName) {
      var rows = await PS.sb.select('people', 'select=id&name=eq.' + encodeURIComponent(personName));
      personId = rows.length ? rows[0].id : null;
    }
    return PS.sb.insert('invites',
      { email: email, person_id: personId, is_admin: !!isAdmin },
      { upsert: true, query: 'on_conflict=email' });
  };

  data.uninvite = async function (email) {
    await PS.sb.remove('invites', 'email=eq.' + encodeURIComponent(email));
  };

  PS.data = data;
})(typeof globalThis !== 'undefined' ? globalThis : this);
