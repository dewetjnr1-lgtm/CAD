const { chromium, devices } = require('playwright'); const http = require('http'); const fs = require('fs'); const path = require('path');
const root = path.resolve('docs');
const server = http.createServer((q, r) => { let f = path.join(root, q.url.split('?')[0]); if (f.endsWith('/')) f += 'index.html'; fs.readFile(f, (e, d) => { if (e) { r.writeHead(404); r.end(); return; } r.writeHead(200, { 'Content-Type': f.endsWith('.html') ? 'text/html' : 'application/octet-stream' }); r.end(d); }); }).listen(8124);
(async () => {
  const b = await chromium.launch(); const ctx = await b.newContext({ ...devices['Pixel 7'] }); const p = await ctx.newPage();
  // throttle CPU 4x to roughly imitate a mid-range phone (an approximation only)
  const cdp = await ctx.newCDPSession(p); await cdp.send('Emulation.setCPUThrottlingRate', { rate: 4 });
  await p.goto('http://localhost:8124/'); await p.waitForSelector('#splash.hidden', { state: 'attached', timeout: 60000 });
  await p.evaluate(() => document.querySelector('#modal').classList.add('hidden'));
  let t = Date.now();
  await p.setInputFiles('#fileInput', 'test/out/big-sphere.stl');
  await p.waitForFunction(() => window.PocketCAD.S.model && window.PocketCAD.S.model.tri.length > 0, null, { timeout: 120000 });
  console.log('load + weld + check, ms:', Date.now() - t, 'triangles', await p.evaluate(() => window.PocketCAD.S.model.tri.length / 3));
  console.log('modal shown (big mesh warning):', await p.isVisible('#modal'));
  await p.evaluate(() => document.querySelector('#modal').classList.add('hidden'));
  const vb = await (await p.$('#view')).boundingBox();
  t = Date.now(); await p.touchscreen.tap(vb.x + vb.width / 2, vb.y + vb.height / 2); await p.waitForTimeout(50);
  console.log('first tap (faces + edges computed), ms:', Date.now() - t, 'sel', await p.evaluate(() => JSON.stringify(window.PocketCAD.S.sel && window.PocketCAD.S.sel.kind)));
  // frame time while orbiting
  const fps = await p.evaluate(async () => { const c = window.PocketCAD; let n = 0; const t0 = performance.now(); while (performance.now() - t0 < 2000) { await new Promise((r) => requestAnimationFrame(r)); c.fitView(); n++; } return n / 2; });
  console.log('frames/s while re-rendering (throttled, headless software GPU):', fps.toFixed(1));
  await b.close(); server.close();
})();
