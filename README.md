# Pocket CAD

A touch-first 3D model editor that runs in a phone browser and installs to the home screen as a PWA (Progressive Web App) that works offline. Made for editing STL files for a Bambu Lab A1 mini (180 × 180 × 180 mm bed).

**The app is `docs/index.html`**: one self-contained file holding all code, the geometry engine (WebAssembly) and the font. The other files in `docs/` (`sw.js`, `manifest.webmanifest`, icons) are only needed for home-screen install and offline use, because browsers require a service worker to be a separate file.

## Put it on your phone
1. Host the `docs/` folder on any HTTPS site. Easiest: GitHub Pages → repo Settings → Pages → "Deploy from a branch" → pick this branch and the `/docs` folder.
2. Open the page on your phone once.
3. iPhone (Safari): Share → **Add to Home Screen**. Android (Chrome): ⋮ → **Install app**.

## Build and test
```
npm install
npm run build   # writes docs/
npm test        # Node geometry tests + Chromium phone-emulation tests
```

## Parts
- `src/core/stl.js` STL read (binary + ASCII) and write
- `src/core/mesh.js` vertex welding, watertight check, flat-face grouping, edge/corner detection, repair
- `src/core/csg.js` boolean add/cut using [Manifold](https://github.com/elalish/manifold) (`manifold-3d` 3.5.5) and all feature shapes
- `src/core/threemf.js` 3MF export
- `src/main.js` the touch interface (three.js 0.181)

Licences: three.js (MIT), manifold-3d (Apache-2.0), Helvetiker font (MgOpen licence, © 2004 MAGENTA Ltd.).
