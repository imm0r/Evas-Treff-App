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

  /*
   * Ab wann ein Kommentar als neu gilt, wenn zu einem Foto noch nie jemand
   * hingesehen hat.
   *
   * Steht im eigenen Profil und wird von `me()` hier abgelegt, damit die
   * Fotoabfrage ihn nicht jedes Mal durchgereicht bekommen muss. Ohne Profil
   * — etwa im Abfrage-Prüfer — ist alles alt, nicht alles neu: ein Hinweis,
   * der beim ersten Aufruf über allem klebt, wäre schon kaputt.
   */
  var seenFloor = '1970-01-01T00:00:00Z';

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
      'select=id,slug,title,event_date,created_by,photos(count)&order=event_date.desc,title.asc');

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

    var fresh = await unreadByAlbum();

    return rows.map(function (row) {
      return {
        id: row.id,
        slug: row.slug,
        title: row.title,
        date: row.event_date || '',
        ownerId: row.created_by,
        count: (row.photos && row.photos[0] && row.photos[0].count) || 0,
        coverUrl: signed[coverFor[row.id]] || null,
        unread: fresh[row.id] || 0
      };
    });
  };

  /**
   * Wie viele Fotos je Album etwas Ungelesenes tragen.
   *
   * Der Boden macht das billig: gefragt wird nur nach Kommentaren, die jünger
   * sind als er, und das sind ein paar — nicht die ganze Geschichte. Ohne ihn
   * müsste diese Abfrage jedes Mal alles holen, um dann fast alles wegzuwerfen.
   */
  async function unreadByAlbum() {
    var mine = PS.sb.user() && PS.sb.user().id;
    var comments = await PS.sb.select('comments',
      'select=photo_id,created_at,author_id,photos(album_id)' +
      '&created_at=gt.' + encodeURIComponent(seenFloor));
    if (!comments.length) return {};

    var reads = await readsByPhoto();
    var perAlbum = {};
    var counted = {};
    comments.forEach(function (row) {
      // Was man selbst geschrieben hat, ist für einen selbst nichts Neues.
      if (row.author_id === mine) return;
      if (row.created_at <= (reads[row.photo_id] || seenFloor)) return;
      var album = row.photos && row.photos.album_id;
      if (!album || counted[row.photo_id]) return;
      // Gezählt werden Fotos, nicht Kommentare: "3 Bilder mit Neuem" führt
      // irgendwohin, "17 neue Kommentare" ist nur eine Zahl.
      counted[row.photo_id] = true;
      perAlbum[album] = (perAlbum[album] || 0) + 1;
    });
    return perAlbum;
  }

  /** Wann ich welches Foto zuletzt aufgemacht habe. Fremde Zeilen sperrt RLS. */
  async function readsByPhoto() {
    var rows = await PS.sb.select('comment_reads', 'select=photo_id,seen_at');
    var seen = {};
    rows.forEach(function (row) { seen[row.photo_id] = row.seen_at; });
    return seen;
  }

  /*
   * Anlegen, und wenn der Name schon vergeben ist, mit einer Nummer nochmal.
   *
   * Der Slug ist eindeutig, weil er in der Adresse steht — aber die NAMEN sind
   * es nicht: „Weihnachten" gibt es jedes Jahr, und Kartoffelsalat kocht jede
   * Familie zweimal. Ohne das hier bekam die zweite Person „Das gibt es
   * schon." und war fertig, obwohl sie nichts falsch gemacht hatte.
   *
   * Über den Fehler des Servers statt über eine vorherige Abfrage: zwei Leute,
   * die gleichzeitig anlegen, kämen sonst beide durch die Prüfung und einer
   * scheiterte trotzdem. So gewinnt der eine und der andere wird `-2`.
   */
  async function insertWithFreeSlug(table, row) {
    var base = row.slug;
    for (var n = 2; n <= 50; n++) {
      try {
        return (await PS.sb.insert(table, row))[0];
      } catch (error) {
        // Auf den CODE prüfen, nicht auf den deutschen Text — der darf sich
        // ändern, ohne dass das Anlegen still aufhört zu funktionieren.
        if (error.code !== '23505' && error.status !== 409) throw error;
        row.slug = base + '-' + n;
      }
    }
    throw new Error('Diesen Namen gibt es schon sehr oft. Nimm bitte einen anderen.');
  }

  data.createAlbum = async function (title, date, slug) {
    return insertWithFreeSlug('albums', {
      slug: slug, title: title, event_date: date || null,
      created_by: PS.sb.user() && PS.sb.user().id
    });
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
      'media_type,duration_seconds,' +
      'comments(id,body,author_id,author_name,created_at),comment_reads(seen_at)' +
      '&album_id=eq.' + albumId + '&order=taken_at.desc');

    var paths = [];
    rows.forEach(function (row) { paths.push(row.thumb_path, row.storage_path); });
    var signed = await PS.sb.signPaths('photos', paths, SIGN_SECONDS);

    var mine = PS.sb.user() && PS.sb.user().id;

    return rows.map(function (row) {
      var when = dayAndTime(row.taken_at);
      // RLS lässt von `comment_reads` nur die eigene Zeile durch, also ist die
      // erste — wenn es sie gibt — immer meine.
      var seen = (row.comment_reads && row.comment_reads[0] &&
        row.comment_reads[0].seen_at) || seenFloor;
      var unread = (row.comments || []).filter(function (c) {
        return c.author_id !== mine && c.created_at > seen;
      }).length;
      return {
        id: row.id,
        unread: unread,
        hash: row.content_hash,
        isVideo: row.media_type === 'video',
        duration: row.duration_seconds === null || row.duration_seconds === undefined
          ? null : Number(row.duration_seconds),
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

  /*
   * Was im Album schon liegt: die Hashes gegen Doppelte, und wie viel wovon.
   *
   * Die Zählung kommt aus derselben Abfrage, statt aus einer zweiten. Sie wird
   * gebraucht, seit ein Album auch Videos enthalten kann — "Im Album sind
   * 3 Fotos" wäre schlicht falsch, wenn zwei davon Filme sind.
   */
  data.albumIndex = async function (albumId) {
    var rows = await PS.sb.select('photos',
      'select=content_hash,media_type&album_id=eq.' + albumId);
    var index = { hashes: new Set(), photos: 0, videos: 0 };
    rows.forEach(function (row) {
      index.hashes.add(row.content_hash);
      if (row.media_type === 'video') index.videos++; else index.photos++;
    });
    return index;
  };

  data.addPhoto = async function (album, photo) {
    var base = album.slug + '/' + photo.hash;
    /*
     * Ein Video geht mit SEINER Endung und SEINEM Typ hinauf, ein Foto wie
     * bisher als JPEG. Der Speicher liefert eine Datei später mit dem Typ aus,
     * den er beim Hochladen bekommen hat — ein `.jpg`, in dem ein Film steckt,
     * öffnet auf keinem Gerät.
     */
    var endung = photo.extension || '.jpg';

    // Picture before row, mirroring the old upload order for the same reason:
    // a row pointing at a file that is not there shows a broken tile, while a
    // file with no row is merely invisible.
    await PS.sb.upload('photos', base + endung, photo.full, photo.contentType || 'image/jpeg');
    await PS.sb.upload('photos', base + '_thumb.jpg', photo.thumb);
    var rows = await PS.sb.insert('photos', {
      album_id: album.id,
      storage_path: base + endung,
      thumb_path: base + '_thumb.jpg',
      content_hash: photo.hash,
      taken_at: photo.takenAt.toISOString(),
      uploader_id: PS.sb.user() && PS.sb.user().id,
      uploader_name: photo.uploader,
      media_type: photo.isVideo ? 'video' : 'image',
      // Die Tabelle verbietet eine Dauer an einem Foto, und ein Video, dessen
      // Länge das Gerät nicht hergab, darf trotzdem hoch.
      duration_seconds: photo.isVideo && photo.duration ? photo.duration : null,
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

  /** Ein Foto in ein anderes Album hängen. Die Datei bleibt, wo sie liegt. */
  data.movePhoto = async function (photo, albumId) {
    await PS.sb.patch('photos', 'id=eq.' + photo.id, { album_id: albumId });
  };

  data.renameAlbum = async function (album, title) {
    await PS.sb.patch('albums', 'id=eq.' + album.id, { title: title });
  };

  /**
   * „Ich habe die Kommentare dieses Fotos gesehen."
   *
   * Ein Upsert, weil man dasselbe Foto immer wieder aufmacht — und weil der
   * Primärschlüssel (Konto, Foto) daraus ohnehin eine einzige Zeile macht.
   */
  data.markRead = async function (photoId) {
    await PS.sb.insert('comment_reads', {
      profile_id: PS.sb.user() && PS.sb.user().id,
      photo_id: photoId,
      seen_at: new Date().toISOString()
    }, { upsert: true, query: 'on_conflict=profile_id,photo_id' });
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

  // --- the calendar ---------------------------------------------------------

  /** "2026-08-10" for today, in local time — `toISOString` would use UTC. */
  function todayISO() {
    var now = new Date();
    return now.getFullYear() + '-' + two(now.getMonth() + 1) + '-' + two(now.getDate());
  }

  /**
   * The next time this day-and-month comes around, today included.
   *
   * A birthday has no year of its own on the calendar: it is simply the next
   * 3rd of May, which is this year until the 3rd of May has passed.
   */
  function nextOccurrence(day, month) {
    var now = new Date();
    var today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    var next = new Date(now.getFullYear(), month - 1, day);
    if (next < today) next = new Date(now.getFullYear() + 1, month - 1, day);
    return next;
  }

  function isoOf(date) {
    return date.getFullYear() + '-' + two(date.getMonth() + 1) + '-' + two(date.getDate());
  }

  /**
   * Everything ahead, in one list, nearest first.
   *
   * Two tables, because an event and a birthday have nothing in common behind
   * the screen — one is owned and one-off, the other belongs to a person and
   * comes back every year. On screen they are the same thing, so they are
   * merged here rather than in the page.
   *
   * Past events are dropped by the query, not by the browser: there is no
   * reason to ship years of them over the wire to throw them away.
   */
  data.calendar = async function () {
    var today = todayISO();
    var rows = await PS.sb.select('events',
      // `over_on` statt `starts_on`: ein mehrtägiger Termin soll am dritten Tag
      // noch dastehen und nicht verschwinden, weil sein ANFANG vorbei ist.
      'select=id,title,starts_on,ends_on,starts_at,place,note,created_by,' +
      // Den Fremdschlüssel benennen, sonst weiß PostgREST nicht, welchen Weg es
      // nehmen soll: `events.created_by` zeigt auf `profiles`, und über
      // `event_replies` sind dieselben zwei Tabellen ein zweites Mal
      // verbunden. Ohne `!events_created_by_fkey` antwortet es mit PGRST201.
      'profiles!events_created_by_fkey(people(name)),' +
      'event_replies(profile_id,answer,profiles(people(name)))' +
      '&over_on=gte.' + today + '&order=starts_on.asc');

    var items = rows.map(function (row) {
      return {
        kind: 'event',
        id: row.id,
        title: row.title,
        on: row.starts_on,
        until: row.ends_on || null,
        // Postgres hands back "15:00:00"; the seconds are never interesting.
        at: row.starts_at ? row.starts_at.slice(0, 5) : null,
        place: row.place || '',
        note: row.note || '',
        hostId: row.created_by,
        host: (row.profiles && row.profiles.people && row.profiles.people.name) || null,
        replies: (row.event_replies || []).map(function (r) {
          return {
            id: r.profile_id,
            answer: r.answer,
            name: (r.profiles && r.profiles.people && r.profiles.people.name) || null
          };
        })
      };
    });

    var birthdays = await PS.sb.select('people',
      'select=name,birth_day,birth_month,birth_year&birth_day=not.is.null&order=sort_order');
    birthdays.forEach(function (person) {
      var when = nextOccurrence(person.birth_day, person.birth_month);
      items.push({
        kind: 'birthday',
        id: 'geb-' + person.name,
        title: person.name,
        on: isoOf(when),
        at: null,
        // Only when the year is actually known. An age nobody told us is a
        // guess, and a guessed age is worse than no age.
        turns: person.birth_year ? when.getFullYear() - person.birth_year : null,
        replies: []
      });
    });

    return items.sort(function (a, b) {
      if (a.on !== b.on) return a.on < b.on ? -1 : 1;
      // Same day: the timed thing first, then the all-day one.
      return (a.at || '99:99') < (b.at || '99:99') ? -1 : 1;
    });
  };

  data.createEvent = async function (event) {
    var rows = await PS.sb.insert('events', {
      title: event.title,
      starts_on: event.on,
      ends_on: event.until || null,
      starts_at: event.at || null,
      place: event.place || null,
      note: event.note || null,
      created_by: PS.sb.user() && PS.sb.user().id
    });
    return rows[0];
  };

  data.removeEvent = async function (event) {
    await PS.sb.remove('events', 'id=eq.' + event.id);
  };

  /**
   * Answering again replaces the earlier answer instead of adding one.
   *
   * The primary key is (event, person), so an upsert is the whole mechanism —
   * changing your mind is the normal case, not an edge case.
   */
  data.reply = async function (eventId, answer) {
    await PS.sb.insert('event_replies', {
      event_id: eventId,
      profile_id: PS.sb.user() && PS.sb.user().id,
      answer: answer
    }, { upsert: true, query: 'on_conflict=event_id,profile_id' });
  };

  // --- birthdays, on the family page ----------------------------------------

  /** Everyone on the group photo, with whatever birthday is already known. */
  data.roster = async function () {
    return PS.sb.select('people',
      'select=name,birth_day,birth_month,birth_year&order=sort_order');
  };

  data.setBirthday = async function (personName, day, month, year) {
    await PS.sb.patch('people', 'name=eq.' + encodeURIComponent(personName), {
      birth_day: day || null,
      birth_month: month || null,
      birth_year: year || null
    });
  };

  // --- Rezepte ----------------------------------------------------------------

  /*
   * Die Rezeptliste. Ein Bild pro Karte, und das ist immer das erste.
   *
   * Bilder kommen eingebettet mit, statt in einer zweiten Abfrage: es sind
   * wenige pro Rezept, und sie werden hier ohnehin nur zum Aussuchen des
   * Hauptbildes gebraucht.
   */
  data.recipes = async function () {
    var rows = await PS.sb.select('recipes',
      'select=id,slug,title,servings,created_by,created_at,' +
      'profiles(people(name)),recipe_photos(thumb_path,sort_order)' +
      '&order=title.asc');

    var paths = [];
    rows.forEach(function (row) {
      var first = cover(row);
      if (first) paths.push(first);
    });
    var signed = await PS.sb.signPaths('photos', paths, SIGN_SECONDS);

    return rows.map(function (row) {
      var first = cover(row);
      return {
        id: row.id,
        slug: row.slug,
        title: row.title,
        servings: row.servings || null,
        ownerId: row.created_by,
        owner: (row.profiles && row.profiles.people && row.profiles.people.name) || null,
        photos: (row.recipe_photos || []).length,
        coverUrl: first ? (signed[first] || null) : null
      };
    });
  };

  /** Das Vorschaubild mit der kleinsten `sort_order` — sonst keins. */
  function cover(row) {
    var best = null;
    (row.recipe_photos || []).forEach(function (photo) {
      if (!best || photo.sort_order < best.sort_order) best = photo;
    });
    return best && best.thumb_path;
  }

  data.recipe = async function (slug) {
    var rows = await PS.sb.select('recipes',
      'select=id,slug,title,servings,ingredients,steps,note,created_by,created_at,' +
      'profiles(people(name)),' +
      'recipe_photos(id,storage_path,thumb_path,sort_order,uploaded_by)' +
      '&slug=eq.' + encodeURIComponent(slug));
    if (!rows.length) return null;
    var row = rows[0];

    var photos = (row.recipe_photos || []).slice().sort(function (a, b) {
      return a.sort_order - b.sort_order;
    });
    var paths = [];
    photos.forEach(function (p) { paths.push(p.thumb_path, p.storage_path); });
    var signed = await PS.sb.signPaths('photos', paths, SIGN_SECONDS);

    return {
      id: row.id,
      slug: row.slug,
      title: row.title,
      servings: row.servings || null,
      ingredients: row.ingredients || '',
      steps: row.steps || '',
      note: row.note || '',
      ownerId: row.created_by,
      owner: (row.profiles && row.profiles.people && row.profiles.people.name) || null,
      photos: photos.map(function (p, index) {
        return {
          id: p.id,
          isCover: index === 0,
          sortOrder: p.sort_order,
          uploaderId: p.uploaded_by,
          storagePath: p.storage_path,
          thumbPath: p.thumb_path,
          thumbUrl: signed[p.thumb_path] || null,
          photoUrl: signed[p.storage_path] || null
        };
      })
    };
  };

  data.createRecipe = async function (recipe) {
    return insertWithFreeSlug('recipes', {
      slug: recipe.slug,
      title: recipe.title,
      servings: recipe.servings || null,
      ingredients: recipe.ingredients || '',
      steps: recipe.steps || '',
      note: recipe.note || null,
      created_by: PS.sb.user() && PS.sb.user().id
    });
  };

  data.updateRecipe = async function (recipe, fields) {
    await PS.sb.patch('recipes', 'id=eq.' + recipe.id, fields);
  };

  data.removeRecipe = async function (recipe) {
    // Erst die Zeile: die Bildzeilen hängen per Cascade dran, und eine Datei
    // ohne Zeile ist unsichtbar, während eine Zeile ohne Datei ein Loch ist.
    var paths = [];
    (recipe.photos || []).forEach(function (p) { paths.push(p.storagePath, p.thumbPath); });
    await PS.sb.remove('recipes', 'id=eq.' + recipe.id);
    if (paths.length) await PS.sb.removeFiles('photos', paths);
  };

  /**
   * Ein Bild an ein Rezept hängen.
   *
   * Ans Ende, nicht an den Anfang: das erste hochgeladene bleibt das Hauptbild,
   * bis jemand ausdrücklich ein anderes dazu macht. Sonst würde das letzte
   * Schritt-für-Schritt-Foto stillschweigend zum Aushängeschild.
   */
  data.addRecipePhoto = async function (recipe, full, thumb, order) {
    var base = 'rezepte/' + recipe.slug + '/' + objectId();
    await PS.sb.upload('photos', base + '.jpg', full);
    await PS.sb.upload('photos', base + '_thumb.jpg', thumb);
    var rows = await PS.sb.insert('recipe_photos', {
      recipe_id: recipe.id,
      storage_path: base + '.jpg',
      thumb_path: base + '_thumb.jpg',
      sort_order: typeof order === 'number' ? order : 0,
      uploaded_by: PS.sb.user() && PS.sb.user().id
    });
    return rows[0];
  };

  data.removeRecipePhoto = async function (photo) {
    await PS.sb.remove('recipe_photos', 'id=eq.' + photo.id);
    await PS.sb.removeFiles('photos', [photo.storagePath, photo.thumbPath]);
  };

  /**
   * Unter alle anderen schieben — das Hauptbild ist das mit der kleinsten Zahl.
   *
   * Eine absteigende Zahl statt einer Umnummerierung aller Bilder: das ist ein
   * einziges UPDATE statt einer Schleife, die mittendrin abbrechen kann und
   * dann zwei Hauptbilder oder keins hinterlässt.
   */
  data.makeCover = async function (recipe, photo, lowest) {
    await PS.sb.patch('recipe_photos', 'id=eq.' + photo.id, { sort_order: lowest - 1 });
  };

  // --- Neuigkeiten ------------------------------------------------------------

  /*
   * Was es für mich Neues gibt — Mitteilungen zuerst, dann der Rest.
   *
   * Eine einzige Rundreise: die Datenbankfunktion beantwortet alles auf
   * einmal. Nur die Vorschaubilder müssen danach noch unterschrieben werden,
   * und das ist derselbe Sammelaufruf wie überall sonst.
   */
  data.news = async function () {
    var raw = await PS.sb.rpc('news_for_me');

    var paths = [];
    (raw.photos.albums || []).forEach(function (album) {
      (album.thumbs || []).forEach(function (path) { if (path) paths.push(path); });
    });
    var signed = await PS.sb.signPaths('photos', paths, SIGN_SECONDS);

    var announcements = (raw.announcements.items || []).map(function (row) {
      return {
        id: row.id,
        body: row.body,
        until: row.until || null,
        author: row.author || null,
        at: new Date(row.at),
        unread: !!row.unread
      };
    });

    return {
      since: raw.since ? new Date(raw.since) : null,
      announcements: announcements,
      // Nur Ungelesenes öffnet die Seite von selbst. Ein Aushang, der noch
      // gilt, steht darauf — hält aber niemanden mehr auf.
      unreadAnnouncements: Number(raw.announcements.unread) || 0,
      photos: {
        count: Number(raw.photos.count) || 0,
        albums: (raw.photos.albums || []).map(function (album) {
          return {
            slug: album.slug,
            title: album.title,
            count: Number(album.count) || 0,
            videos: Number(album.videos) || 0,
            thumbs: (album.thumbs || []).map(function (path) { return signed[path] || null; })
              .filter(Boolean)
          };
        })
      },
      comments: { count: Number(raw.comments.count) || 0, items: raw.comments.items || [] },
      posts: { count: Number(raw.posts.count) || 0, items: raw.posts.items || [] },
      recipes: { count: Number(raw.recipes.count) || 0, items: raw.recipes.items || [] },
      events: { count: Number(raw.events.count) || 0, items: raw.events.items || [] }
    };
  };

  /** Was die Seite aufhält: Ungelesenes. Alles andere steht nur da. */
  data.newsPending = function (news) {
    return news.unreadAnnouncements + news.photos.count + news.comments.count +
      news.posts.count + news.recipes.count + news.events.count;
  };

  data.markNewsSeen = async function () {
    var user = PS.sb.user();
    if (!user) return;
    await PS.sb.patch('profiles', 'id=eq.' + user.id,
      { news_seen_at: new Date().toISOString() });
  };

  data.addAnnouncement = async function (body, until) {
    var rows = await PS.sb.insert('announcements', {
      body: body,
      until: until || null,
      created_by: PS.sb.user() && PS.sb.user().id
    });
    return rows[0];
  };

  data.removeAnnouncement = async function (id) {
    await PS.sb.remove('announcements', 'id=eq.' + id);
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
      'select=id,email,is_admin,person_id,comments_seen_at,people(name)&id=eq.' + user.id);
    if (!rows.length) return null;
    var row = rows[0];
    if (row.comments_seen_at) seenFloor = row.comments_seen_at;
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
