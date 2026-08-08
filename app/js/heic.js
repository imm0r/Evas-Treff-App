/*
 * HEIC, turned into something the browser can actually draw.
 *
 * iPhones and a few Android cameras shoot HEIC, and no Chromium browser can
 * open it — not `<img>`, not `createImageBitmap`. That is a codec licensing
 * decision rather than a gap another API call slips through, so the only way
 * to accept those photos is to bring a decoder along: libheif compiled to
 * WebAssembly, in vendor/.
 *
 * It is a megabyte, so nothing here is loaded until someone actually picks a
 * HEIC. A family where everyone shoots JPEG never downloads a byte of it.
 */
(function (global) {
  'use strict';

  var PS = global.PS || (global.PS = {});
  var heic = {};
  var pending = null;

  /**
   * Recognise HEIC by its container, not by its name.
   *
   * A file arrives named IMG_0001.HEIC, or image.heic, or with no extension at
   * all and a MIME type the phone invented. The bytes are not negotiable:
   * ISOBMFF puts a four-byte length, then "ftyp", then the brand.
   */
  heic.looksLike = function (buffer) {
    var bytes = new Uint8Array(buffer, 0, Math.min(24, buffer.byteLength));
    if (bytes.length < 12) return false;
    var box = String.fromCharCode(bytes[4], bytes[5], bytes[6], bytes[7]);
    if (box !== 'ftyp') return false;
    var brand = String.fromCharCode(bytes[8], bytes[9], bytes[10], bytes[11]);
    return ['heic', 'heix', 'heim', 'heis', 'hevc', 'hevx', 'mif1', 'msf1'].indexOf(brand) >= 0;
  };

  function loadScript(src) {
    return new Promise(function (resolve, reject) {
      var tag = document.createElement('script');
      tag.src = src;
      tag.onload = resolve;
      tag.onerror = function () { reject(new Error('Der HEIC-Umwandler ließ sich nicht laden.')); };
      document.head.appendChild(tag);
    });
  }

  /** Fetch and start the decoder once; every later call reuses it. */
  function decoder() {
    if (pending) return pending;
    pending = (async function () {
      await loadScript('vendor/libheif.js');
      // Emscripten would fetch the .wasm itself and guess at the path; handing
      // over the bytes keeps it to one request we control.
      var response = await fetch('vendor/libheif.wasm');
      if (!response.ok) throw new Error('Der HEIC-Umwandler ließ sich nicht laden.');
      return await global.libheif({ wasmBinary: await response.arrayBuffer() });
    })();
    pending.catch(function () { pending = null; }); // let a failed load be retried
    return pending;
  }

  /**
   * Decode to a canvas, shaped like what PS.decodeImage returns so the rest of
   * the upload pipeline cannot tell the difference.
   *
   * `onProgress` is called before the slow parts: the first HEIC of a session
   * pays for a megabyte of decoder over whatever wifi the party has.
   */
  heic.decode = async function (buffer, onProgress) {
    if (onProgress) onProgress('HEIC wird vorbereitet …');
    var mod = await decoder();

    if (onProgress) onProgress('HEIC wird umgewandelt …');
    var images = new mod.HeifDecoder().decode(new Uint8Array(buffer));
    if (!images || !images.length) throw new Error('In dieser HEIC-Datei ist kein Bild.');

    var image = images[0];
    var width = image.get_width();
    var height = image.get_height();
    if (!width || !height) throw new Error('Diese HEIC-Datei hat keine lesbare Größe.');

    var canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    var ctx = canvas.getContext('2d');
    var frame = ctx.createImageData(width, height);
    await new Promise(function (resolve, reject) {
      image.display(frame, function (ok) {
        if (ok) resolve();
        else reject(new Error('Diese HEIC-Datei ließ sich nicht umwandeln.'));
      });
    });
    ctx.putImageData(frame, 0, 0);

    return {
      img: canvas,            // drawImage takes a canvas exactly like an <img>
      width: width,
      height: height,
      takenAt: exifDate(buffer),
      release: function () { canvas.width = canvas.height = 0; }
    };
  };

  /**
   * The capture date, which HEIF keeps as a metadata item rather than in the
   * APP1 segment a JPEG uses. Without it, every HEIC would be filed under the
   * day it was copied off the phone.
   *
   * Found by scanning for a TIFF header and letting the EXIF reader decide.
   * The decoder's own metadata calls are not on the object it hands back, and
   * walking the ISOBMFF boxes to reach the item properly is a lot of parsing
   * for one date. A scan is safe here because the check is not "these four
   * bytes look right" but "a complete EXIF block parses out of this position
   * and yields a plausible date" — which random image data does not do.
   */
  function exifDate(buffer) {
    var bytes = new Uint8Array(buffer);
    for (var i = 0; i + 8 < bytes.length; i++) {
      var little = bytes[i] === 0x49 && bytes[i + 1] === 0x49 && bytes[i + 2] === 0x2a && bytes[i + 3] === 0x00;
      var big = bytes[i] === 0x4d && bytes[i + 1] === 0x4d && bytes[i + 2] === 0x00 && bytes[i + 3] === 0x2a;
      if (!little && !big) continue;
      var date = PS.exifDateFromTiff(bytes.subarray(i));
      if (date) return date;
    }
    return null;
  }

  PS.heic = heic;
})(typeof globalThis !== 'undefined' ? globalThis : this);
