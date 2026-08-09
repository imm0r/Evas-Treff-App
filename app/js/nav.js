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
    { page: 'board.html', label: 'Pinnwand', icon: '📌' }
  ];

  PS.nav = function () {
    var here = location.pathname.split('/').pop() || 'index.html';
    var bar = PS.el('nav', { class: 'nav' });
    SECTIONS.forEach(function (section) {
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
