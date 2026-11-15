// Builds docs/index.html: one self-contained file (all JavaScript, the geometry engine and the font inlined),
// plus the small PWA (Progressive Web App) files a browser needs for offline install.
import * as esbuild from 'esbuild';
import fs from 'fs';
import crypto from 'crypto';

const out = 'docs';
fs.mkdirSync(out, { recursive: true });

const res = await esbuild.build({
  entryPoints: ['src/main.js'],
  bundle: true,
  format: 'iife',
  minify: true,
  target: ['es2020', 'safari15'],
  write: false,
  loader: { '.wasm': 'base64', '.json': 'json' },
  external: ['module', 'node:module', 'node:fs', 'node:path', 'node:url', 'fs', 'path', 'url', 'worker_threads', 'node:worker_threads'], // node-only import inside manifold.js, never used in the browser
  logLevel: 'warning',
  legalComments: 'eof',
});
let js = res.outputFiles[0].text.replace(/<\/script/gi, '<\\/script');
const css = fs.readFileSync('src/style.css', 'utf8');
const html = fs.readFileSync('src/index.html', 'utf8')
  .replace('/*CSS*/', () => css)
  .replace('/*JS*/', () => js);
fs.writeFileSync(`${out}/index.html`, html);

const hash = crypto.createHash('sha256').update(html).digest('hex').slice(0, 10);
const sw = `// Service worker: keeps the app working offline. Cache version changes on every build.
const CACHE = 'pocketcad-${hash}';
const FILES = ['./', './index.html', './manifest.webmanifest', './icon-180.png', './icon-192.png', './icon-512.png'];
self.addEventListener('install', (e) => { e.waitUntil(caches.open(CACHE).then((c) => c.addAll(FILES)).then(() => self.skipWaiting())); });
self.addEventListener('activate', (e) => { e.waitUntil(caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))).then(() => self.clients.claim())); });
self.addEventListener('fetch', (e) => {
  if (e.request.method !== 'GET') return;
  e.respondWith(caches.match(e.request, { ignoreSearch: true }).then((hit) => hit || fetch(e.request).then((r) => {
    if (r.ok && new URL(e.request.url).origin === location.origin) { const copy = r.clone(); caches.open(CACHE).then((c) => c.put(e.request, copy)); }
    return r;
  }).catch(() => caches.match('./index.html'))));
});
`;
fs.writeFileSync(`${out}/sw.js`, sw);
fs.writeFileSync(`${out}/manifest.webmanifest`, JSON.stringify({
  name: 'Pocket CAD', short_name: 'Pocket CAD', description: 'Touch-first 3D model editor for 3D printing',
  start_url: './', scope: './', display: 'standalone', orientation: 'any', background_color: '#14171c', theme_color: '#14171c',
  icons: [{ src: 'icon-192.png', sizes: '192x192', type: 'image/png' }, { src: 'icon-512.png', sizes: '512x512', type: 'image/png' }, { src: 'icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' }],
}, null, 2));
fs.writeFileSync(`${out}/.nojekyll`, '');
console.log(`built ${out}/index.html ${(html.length / 1024).toFixed(0)} KB, cache ${hash}`);
