const { chromium, devices } = require('playwright'); const http = require('http'); const fs = require('fs'); const path = require('path');
const root = path.resolve('docs');
const types = { '.html': 'text/html', '.js': 'text/javascript', '.png': 'image/png', '.webmanifest': 'application/manifest+json' };
const server = http.createServer((q, r) => { let f = path.join(root, q.url.split('?')[0]); if (f.endsWith('/')) f += 'index.html'; fs.readFile(f, (e, d) => { if (e) { r.writeHead(404); r.end(); return; } r.writeHead(200, { 'Content-Type': types[path.extname(f)] || 'application/octet-stream' }); r.end(d); }); }).listen(8125);
(async () => {
  const b = await chromium.launch(); const ctx = await b.newContext({ ...devices['iPhone 13'] }); const p = await ctx.newPage();
  await p.goto('http://localhost:8125/'); await p.waitForSelector('#splash.hidden', { state: 'attached' });
  await p.evaluate(() => navigator.serviceWorker.ready);
  await p.reload(); await p.waitForSelector('#splash.hidden', { state: 'attached' });
  server.close(); await ctx.setOffline(true);
  await p.reload(); await p.waitForSelector('#splash.hidden', { state: 'attached', timeout: 20000 });
  const ok = await p.evaluate(() => !!window.PocketCAD && document.title);
  console.log(ok ? 'PASS app reloads and starts with the network off (' + ok + ')' : 'FAIL offline');
  const m = await p.evaluate(async () => { const r = await fetch('manifest.webmanifest'); return (await r.json()).name; });
  console.log('PASS manifest served from cache offline:', m);
  await b.close(); process.exit(0);
})().catch((e) => { console.error('FAIL', e.message); process.exit(1); });
