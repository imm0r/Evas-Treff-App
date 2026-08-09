/*
 * The door: an address, a mail, a link.
 *
 * No password field anywhere, on purpose. Nobody in this family should have to
 * invent or remember one, and a password is the part of a login that gets
 * reused, written down and leaked. A link in your own inbox proves the same
 * thing with less to lose.
 */
(function (global) {
  'use strict';

  var PS = global.PS || (global.PS = {});
  var el = PS.el;

  /**
   * Show the sign-in screen unless there is already a session, then hand over.
   * The whole app hangs off this, exactly like the access-code gate did.
   */
  PS.requireSignIn = function (mount, onReady) {
    var started = PS.sb.start();

    if (started && started.error) {
      render(mount, started.error);
      return;
    }
    if (PS.sb.signedIn()) { onReady(); return; }
    render(mount, null);
  };

  function render(mount, problem) {
    var input = el('input', {
      class: 'field', type: 'email', inputmode: 'email',
      autocomplete: 'email', autocapitalize: 'off', spellcheck: 'false',
      placeholder: 'deine@adresse.de'
    });
    var hint = el('p', { class: 'gate__hint', text: problem || 'Du bekommst einen Link per Mail. Kein Passwort nötig.' });
    if (problem) hint.classList.add('is-error');

    var button = el('button', { class: 'btn btn--primary', onclick: submit }, ['Link schicken']);

    async function submit() {
      var email = input.value.trim();
      if (!email || email.indexOf('@') < 1) {
        hint.textContent = 'Bitte eine E-Mail-Adresse eingeben.';
        hint.classList.add('is-error');
        return;
      }
      button.disabled = true;
      button.textContent = 'Wird geschickt …';
      try {
        // Back to the page they started on, so a link opened on the phone
        // lands where they were rather than always on the front page.
        await PS.sb.requestLink(email, location.origin + location.pathname);
      } catch (error) {
        hint.textContent = PS.escapeError(error);
        hint.classList.add('is-error');
        button.disabled = false;
        button.textContent = 'Link schicken';
        return;
      }
      sent(mount, email);
    }

    input.addEventListener('keydown', function (event) { if (event.key === 'Enter') submit(); });

    mount.innerHTML = '';
    mount.appendChild(el('div', { class: 'gate' }, [
      el('div', { class: 'gate__icon', text: '👋' }),
      el('h1', { class: 'gate__title', text: 'Familie' }),
      el('p', { class: 'gate__lead', text: 'Melde dich mit deiner E-Mail-Adresse an.' }),
      input, button, hint
    ]));
    input.focus();
  }

  function sent(mount, email) {
    mount.innerHTML = '';
    mount.appendChild(el('div', { class: 'gate' }, [
      el('div', { class: 'gate__icon', text: '📬' }),
      el('h1', { class: 'gate__title', text: 'Schau in dein Postfach' }),
      el('p', { class: 'gate__lead', text: 'Wir haben einen Link an ' + email + ' geschickt. Antippen, fertig.' }),
      el('p', { class: 'gate__hint', text: 'Nichts angekommen? Der Spam-Ordner ist der übliche Verdächtige. Sonst nochmal versuchen.' }),
      el('button', { class: 'btn btn--ghost', onclick: function () { render(mount, null); } }, ['Andere Adresse'])
    ]));
  }
})(typeof globalThis !== 'undefined' ? globalThis : this);
