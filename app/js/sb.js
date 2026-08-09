/*
 * Everything that talks to Supabase.
 *
 * Hand-rolled against the REST endpoints rather than pulling in the client
 * library: the app has no build step, and PostgREST, Storage and Auth are
 * plain HTTP. It also keeps the Content-Security-Policy narrow — one host,
 * declared, and nothing evaluated.
 *
 * The key below is the publishable one and belongs in public source. It grants
 * nothing on its own: every table is closed by row level security, and a
 * request without a session reads exactly zero rows. That is checked, not
 * assumed - see tools/e2e.mjs and the notes in the schema migration.
 */
(function (global) {
  'use strict';

  var PS = global.PS || (global.PS = {});
  var cfg = global.SUPABASE_CONFIG || {};
  var URL_BASE = cfg.url || '';
  var KEY = cfg.key || '';

  var STORE = 'sb:';
  var session = null;      // { access_token, refresh_token, expires_at, user }
  var refreshing = null;

  function read(name) {
    try { return global.localStorage.getItem(STORE + name) || ''; } catch (e) { return ''; }
  }
  function write(name, value) {
    try {
      if (value) global.localStorage.setItem(STORE + name, value);
      else global.localStorage.removeItem(STORE + name);
    } catch (e) { /* private mode */ }
  }

  var sb = {};

  // --- session ------------------------------------------------------------

  function remember(data) {
    if (!data || !data.access_token) return null;
    session = {
      access_token: data.access_token,
      refresh_token: data.refresh_token,
      // A minute of slack, so a request never leaves with a token that expires
      // while it is in flight.
      expires_at: Date.now() + ((data.expires_in || 3600) - 60) * 1000,
      user: data.user || (session && session.user) || null
    };
    write('session', JSON.stringify(session));
    return session;
  }

  function forget() {
    session = null;
    write('session', '');
  }

  /**
   * Pick the session out of the magic link and scrub it from the address bar.
   *
   * Supabase returns the tokens in the fragment, which never reaches a server —
   * the same reason the old share links used one. Leaving it in the URL would
   * put a working session into every screenshot and browser history entry.
   */
  function absorbHash() {
    var hash = global.location.hash.replace(/^#/, '');
    if (hash.indexOf('access_token=') < 0 && hash.indexOf('error') < 0) return null;
    var params = new URLSearchParams(hash);
    global.history.replaceState(null, '', global.location.pathname + global.location.search);
    if (params.get('error_description')) {
      return { error: params.get('error_description') };
    }
    return remember({
      access_token: params.get('access_token'),
      refresh_token: params.get('refresh_token'),
      expires_in: Number(params.get('expires_in') || 3600)
    });
  }

  sb.start = function () {
    var arrived = absorbHash();
    if (arrived && arrived.error) return { error: arrived.error };
    if (!session) {
      try { session = JSON.parse(read('session') || 'null'); } catch (e) { session = null; }
    }
    return session;
  };

  sb.signedIn = function () { return !!(session && session.refresh_token); };
  sb.user = function () { return session && session.user; };
  sb.signOut = function () { forget(); };

  /**
   * Who the token belongs to.
   *
   * The magic link hands back tokens and nothing else, so the account behind
   * them has to be asked for once. Every insert records its author from this,
   * and the access rules check the same id server-side — so a wrong answer
   * here cannot forge anything, it would only fail.
   */
  sb.loadUser = async function () {
    if (!session) return null;
    if (session.user) return session.user;
    var response = await fetch(URL_BASE + '/auth/v1/user', {
      headers: { apikey: KEY, Authorization: 'Bearer ' + (await token()) }
    });
    if (!response.ok) {
      if (response.status === 401) forget();
      throw new Error('Die Anmeldung ist abgelaufen. Bitte melde dich neu an.');
    }
    session.user = await response.json();
    write('session', JSON.stringify(session));
    return session.user;
  };

  /** Ask for a magic link. `create_user` is false: only invited people exist. */
  sb.requestLink = async function (email, redirectTo) {
    var response = await fetch(URL_BASE + '/auth/v1/otp', {
      method: 'POST',
      headers: { apikey: KEY, 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: email, create_user: true, options: { email_redirect_to: redirectTo } })
    });
    if (!response.ok) {
      var detail = await response.json().catch(function () { return {}; });
      throw new Error(explainAuth(response.status, detail));
    }
  };

  function explainAuth(status, body) {
    var message = (body && (body.msg || body.message || body.error_description)) || '';
    if (/nicht eingeladen/i.test(message)) {
      return 'Diese Adresse ist nicht eingeladen. Frag die Person, die den Hub eingerichtet hat.';
    }
    if (status === 429) return 'Zu viele Versuche. Warte ein paar Minuten.';
    if (status === 422) return 'Diese E-Mail-Adresse sieht nicht richtig aus.';
    return message || ('Die Anmeldung antwortet mit ' + status + '.');
  }

  async function refresh() {
    if (refreshing) return refreshing;
    if (!session || !session.refresh_token) throw new Error('Nicht angemeldet.');
    refreshing = (async function () {
      var response = await fetch(URL_BASE + '/auth/v1/token?grant_type=refresh_token', {
        method: 'POST',
        headers: { apikey: KEY, 'Content-Type': 'application/json' },
        body: JSON.stringify({ refresh_token: session.refresh_token })
      });
      if (!response.ok) {
        forget();
        throw new Error('Die Anmeldung ist abgelaufen. Bitte melde dich neu an.');
      }
      return remember(await response.json());
    })();
    refreshing.catch(function () {}).then(function () { refreshing = null; });
    return refreshing;
  }

  async function token() {
    if (!session) throw new Error('Nicht angemeldet.');
    if (Date.now() >= session.expires_at) await refresh();
    return session.access_token;
  }

  // --- data ---------------------------------------------------------------

  async function call(pathname, init, retried) {
    var options = init || {};
    var response = await fetch(URL_BASE + pathname, {
      method: options.method || 'GET',
      headers: Object.assign({
        apikey: KEY,
        Authorization: 'Bearer ' + (await token()),
        'Content-Type': 'application/json'
      }, options.headers || {}),
      body: options.body
    });

    // A 401 after the clock said the token was fine means it was revoked or the
    // clock is wrong; one refresh, one retry, then give up.
    if (response.status === 401 && !retried) {
      await refresh();
      return call(pathname, init, true);
    }
    if (!response.ok) throw await explain(response);
    return response;
  }

  async function explain(response) {
    var body = await response.json().catch(function () { return {}; });
    if (response.status === 401 || response.status === 403) {
      return new Error('Dafür fehlt dir die Berechtigung.');
    }
    if (response.status === 409) return new Error('Das gibt es schon.');
    return new Error(body.message || body.error || ('Der Server antwortet mit ' + response.status + '.'));
  }

  /** SELECT. `query` is a PostgREST query string without the leading ?. */
  sb.select = async function (table, query) {
    var response = await call('/rest/v1/' + table + (query ? '?' + query : ''));
    return response.json();
  };

  sb.insert = async function (table, rows, options) {
    var response = await call('/rest/v1/' + table + ((options && options.query) ? '?' + options.query : ''), {
      method: 'POST',
      headers: { Prefer: 'return=representation' + ((options && options.upsert) ? ',resolution=merge-duplicates' : '') },
      body: JSON.stringify(rows)
    });
    return response.json();
  };

  sb.patch = async function (table, query, patch) {
    await call('/rest/v1/' + table + '?' + query, {
      method: 'PATCH',
      body: JSON.stringify(patch)
    });
  };

  sb.remove = async function (table, query) {
    await call('/rest/v1/' + table + '?' + query, { method: 'DELETE' });
  };

  // --- files --------------------------------------------------------------

  /**
   * Sign a batch of storage paths in one request.
   *
   * The buckets are private, so a browser cannot fetch an object by path. One
   * call signs the whole grid; after that the images are ordinary URLs the
   * browser caches and re-fetches on its own. Signing each thumbnail
   * separately would put a request behind every tile, which is exactly the
   * cost the GitHub version had to work around.
   */
  sb.signPaths = async function (bucket, paths, seconds) {
    if (!paths.length) return {};
    var response = await call('/storage/v1/object/sign/' + bucket, {
      method: 'POST',
      body: JSON.stringify({ expiresIn: seconds || 3600, paths: paths })
    });
    var signed = {};
    (await response.json()).forEach(function (entry) {
      if (entry.signedURL || entry.signedUrl) {
        signed[entry.path] = URL_BASE + '/storage/v1' + (entry.signedURL || entry.signedUrl);
      }
    });
    return signed;
  };

  sb.upload = async function (bucket, objectPath, blob, contentType) {
    var response = await fetch(URL_BASE + '/storage/v1/object/' + bucket + '/' + objectPath, {
      method: 'POST',
      headers: {
        apikey: KEY,
        Authorization: 'Bearer ' + (await token()),
        'Content-Type': contentType || 'image/jpeg',
        'x-upsert': 'true'
      },
      body: blob
    });
    if (!response.ok) throw await explain(response);
  };

  sb.removeFiles = async function (bucket, paths) {
    await call('/storage/v1/object/' + bucket, {
      method: 'DELETE',
      body: JSON.stringify({ prefixes: paths })
    });
  };

  sb.config = function () { return { url: URL_BASE, key: KEY }; };

  PS.sb = sb;
})(typeof globalThis !== 'undefined' ? globalThis : this);
