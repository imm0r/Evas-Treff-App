/*
 * The bar along the bottom, once there is more than one thing here.
 *
 * Bottom rather than top because this is used one-handed on a phone, and the
 * bottom is where a thumb already is. It knows which page it is on from the
 * file name, so nothing has to be passed in.
 */
(function (global) {
  'use strict';

  var PS = global.PS || (global.PS = {});

  var SECTIONS = [
    { page: 'index.html', label: 'Alben', icon: '📷' },
    { page: 'dates.html', label: 'Termine', icon: '📅' },
    { page: 'board.html', label: 'Pinnwand', icon: '📌' }
  ];

  // Only an admin can do anything on the guest list, and the rules say so
  // server-side — hiding it is about not offering a dead end, not security.
  var ADMIN = { page: 'admin.html', label: 'Familie', icon: '👪' };

  PS.nav = function (me) {
    var here = location.pathname.split('/').pop() || 'index.html';
    var bar = PS.el('nav', { class: 'nav' });
    SECTIONS.concat(me && me.isAdmin ? [ADMIN] : []).forEach(function (section) {
      var current = section.page === here;
      bar.appendChild(PS.el('a', {
        class: 'nav__item' + (current ? ' is-current' : ''),
        href: section.page,
        'aria-current': current ? 'page' : null
      }, [
        PS.el('span', { class: 'nav__icon', text: section.icon }),
        PS.el('span', { class: 'nav__label', text: section.label })
      ]));
    });
    return bar;
  };
})(typeof globalThis !== 'undefined' ? globalThis : this);
