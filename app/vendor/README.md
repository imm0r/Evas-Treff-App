# vendor

The one thing this app does not write itself.

`libheif.js` + `libheif.wasm` are [libheif](https://github.com/strukturag/libheif)
compiled to WebAssembly, taken from the npm package `libheif-js` 1.19.8. They
decode HEIC, the format iPhones and some Android cameras shoot in, which **no
Chromium browser can open** — not through `<img>`, not through
`createImageBitmap`. That is a licensing decision, not a gap a different API
call gets around, so converting a HEIC on the device means carrying a decoder.

Loaded only when someone actually picks a HEIC. Everyone else never downloads
a byte of it.

Licence: LGPL-3.0 (libheif) — see `libheif-LICENSE.txt`. Unmodified.
