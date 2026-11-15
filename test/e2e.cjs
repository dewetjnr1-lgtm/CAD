// End-to-end test in Chromium emulating an iPhone: load cube STL, select face, push/pull (drag + typed),
// add M3 hole, fillet an edge, export STL, check watertight, reload (autosave), measure, new scene + box.
const { chromium, devices } = require('playwright');
const fs = require('fs'); const path = require('path'); const http = require('http');
const OUT = process.env.SHOTS || 'test/out';
fs.mkdirSync(OUT, { recursive: true });
const root = path.resolve('docs');
const types = { '.html': 'text/html', '.js': 'text/javascript', '.png': 'image/png', '.webmanifest': 'application/manifest+json' };
const server = http.createServer((q, r) => { let f = path.join(root, decodeURIComponent(q.url.split('?')[0])); if (f.endsWith('/')) f += 'index.html'; fs.readFile(f, (e, d) => { if (e) { r.writeHead(404); r.end(); return; } r.writeHead(200, { 'Content-Type': types[path.extname(f)] || 'application/octet-stream' }); r.end(d); }); }).listen(8123);
// 20 mm binary cube
function cubeSTL() {
  const V = [[0,0,0],[20,0,0],[20,20,0],[0,20,0],[0,0,20],[20,0,20],[20,20,20],[0,20,20]];
  const F = [[0,2,1],[0,3,2],[4,5,6],[4,6,7],[0,1,5],[0,5,4],[1,2,6],[1,6,5],[2,3,7],[2,7,6],[3,0,4],[3,4,7]];
  const b = Buffer.alloc(84 + F.length * 50); b.writeUInt32LE(F.length, 80);
  F.forEach((f, i) => { let o = 84 + i * 50 + 12; for (const v of f) for (const c of V[v]) { b.writeFloatLE(c, o); o += 4; } });
  return b;
}
fs.writeFileSync(path.join(OUT, 'cube.stl'), cubeSTL());
let fails = 0; const ok = (c, m) => { console.log((c ? 'PASS ' : 'FAIL ') + m); if (!c) fails++; };
(async () => {
  const browser = await chromium.launch();
  const ctx = await browser.newContext({ ...devices['iPhone 13'], acceptDownloads: true });
  const page = await ctx.newPage();
  const errors = [];
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  page.on('pageerror', (e) => errors.push(String(e)));
  await page.goto('http://localhost:8123/');
  await page.waitForSelector('#splash.hidden', { state: 'attached', timeout: 30000 });
  await page.screenshot({ path: `${OUT}/01-help.png` });
  ok(await page.isVisible('#modal'), 'help screen shows on first start');
  await page.click('#modal .modal-buttons button');
  // load STL
  await page.setInputFiles('#fileInput', path.join(OUT, 'cube.stl'));
  await page.waitForFunction(() => window.PocketCAD.S.model && window.PocketCAD.S.model.tri.length === 36);
  ok(true, 'cube STL loaded (12 triangles)');
  ok((await page.textContent('#sizeLabel')).includes('20 × 20 × 20 mm'), 'size label shows 20 × 20 × 20 mm');
  ok((await page.textContent('#badge')).includes('Watertight'), 'watertight badge shown');
  const view = await page.$('#view'); const vb = await view.boundingBox();
  const V3 = await page.evaluate(() => typeof window.PocketCAD.Vector3);
  ok(V3 === 'function', 'test hook available');
  const tapAt = async (p) => { const s = await page.evaluate((p) => window.PocketCAD.toScreen(new window.PocketCAD.Vector3(...p)), p); await page.touchscreen.tap(vb.x + s.x, vb.y + s.y); return s; };
  // tap top face centre (slightly off-centre)
  await tapAt([3, 4, 20]);
  await page.waitForTimeout(200);
  let sel = await page.evaluate(() => window.PocketCAD.S.sel);
  ok(sel && sel.kind === 'face', 'tap on top face selects a face');
  const fnorm = await page.evaluate(() => window.PocketCAD.ensureFaces().faces[window.PocketCAD.S.sel.id].normal);
  ok(fnorm[2] > 0.99, 'selected face is the top face (normal up)');
  await page.screenshot({ path: `${OUT}/02-face-selected.png` });
  // drag the arrow up with the mouse (pointer events): arrow base at tap point
  const base = await page.evaluate(() => { const a = window.PocketCAD.arrowPos(); return a; });
  const p0 = await page.evaluate((p) => window.PocketCAD.toScreen(new window.PocketCAD.Vector3(...p)), [base[0], base[1], base[2] + 0.5 * base[3]]);
  const p1 = await page.evaluate((p) => window.PocketCAD.toScreen(new window.PocketCAD.Vector3(...p)), [base[0], base[1], base[2] + 0.5 * base[3] + 5]);
  await page.mouse.move(vb.x + p0.x, vb.y + p0.y);
  await page.mouse.down();
  for (let i = 1; i <= 10; i++) await page.mouse.move(vb.x + p0.x + (p1.x - p0.x) * i / 10, vb.y + p0.y + (p1.y - p0.y) * i / 10);
  await page.screenshot({ path: `${OUT}/03-dragging.png` });
  await page.mouse.up();
  await page.waitForTimeout(200);
  let h = await page.evaluate(() => { const S = window.PocketCAD.S; let mx = -1e9; for (let i = 2; i < S.model.pos.length; i += 3) mx = Math.max(mx, S.model.pos[i]); return mx; });
  ok(Math.abs(h - 25) < 0.01, 'arrow drag pulled top face up by 5 mm (height ' + h.toFixed(2) + ')');
  ok(await page.evaluate(() => window.PocketCAD.S.check.ok), 'still watertight after drag');
  // typed push/pull -3
  await page.fill('#ppField input', '-3');
  await page.press('#ppField input', 'Enter');
  await page.click('#sheet .row .btn.primary');
  await page.waitForTimeout(200);
  h = await page.evaluate(() => { const S = window.PocketCAD.S; let mx = -1e9; for (let i = 2; i < S.model.pos.length; i += 3) mx = Math.max(mx, S.model.pos[i]); return mx; });
  ok(Math.abs(h - 22) < 0.01, 'typed −3 mm pushed face in (height ' + h.toFixed(2) + ')');
  // push in too far should be refused
  await page.fill('#ppField input', '-30'); await page.press('#ppField input', 'Enter');
  await page.click('#sheet .row .btn.primary');
  await page.waitForTimeout(200);
  h = await page.evaluate(() => { const S = window.PocketCAD.S; let mx = -1e9; for (let i = 2; i < S.model.pos.length; i += 3) mx = Math.max(mx, S.model.pos[i]); return mx; });
  ok(Math.abs(h - 22) < 0.01 && (await page.textContent('#toast')).includes("Can't push"), 'pushing through the whole part is refused with a message');
  // hole: Add/cut here -> Hole (M3 default, through)
  await page.click('text=Add / cut here');
  await page.click('.tile:has-text("Hole")');
  await page.waitForTimeout(300);
  await page.screenshot({ path: `${OUT}/04-hole-preview.png` });
  // pick counterbore
  await page.click('.seg button:has-text("Counterbore")');
  await page.click('text=Centre on face');
  await page.waitForTimeout(200);
  const volBefore = await page.evaluate(() => window.PocketCAD.S.check.volume);
  await page.click('#sheet .row.end .btn.primary');
  await page.waitForFunction((v) => window.PocketCAD.S.check.volume < v - 1, volBefore, { timeout: 10000 });
  ok(await page.evaluate(() => window.PocketCAD.S.check.ok), 'M3 counterbored through-hole cut, model watertight');
  await page.screenshot({ path: `${OUT}/05-hole-done.png` });
  // select an edge: top front edge midpoint (y = -10 after centering, z = 22)
  await page.evaluate(() => window.PocketCAD.fitView());
  await tapAt([0, -10, 22]);
  await page.waitForTimeout(300);
  sel = await page.evaluate(() => window.PocketCAD.S.sel);
  ok(sel && sel.kind === 'edge', 'tap on top-front edge selects an edge (' + (sel && sel.kind) + ')');
  if (sel && sel.kind === 'edge') {
    await page.click('.seg button:has-text("Fillet")');
    const f = await page.$('#sheet .row .field input'); await f.fill('2'); await f.press('Enter');
    await page.waitForTimeout(200);
    await page.screenshot({ path: `${OUT}/06-fillet-preview.png` });
    const v0 = await page.evaluate(() => window.PocketCAD.S.check.volume);
    await page.click('#sheet .row .btn.primary');
    await page.waitForFunction((v) => window.PocketCAD.S.check.volume < v - 1, v0, { timeout: 10000 });
    ok(await page.evaluate(() => window.PocketCAD.S.check.ok), 'fillet 2 mm applied, watertight');
  }
  // corner
  await tapAt([10, -10, 0.0]);
  await page.waitForTimeout(200);
  sel = await page.evaluate(() => window.PocketCAD.S.sel);
  ok(sel && sel.kind === 'corner', 'tap on bottom corner selects a corner (' + (sel && sel.kind) + ')');
  // undo / redo
  const nHist = await page.evaluate(() => window.PocketCAD.S.hIndex);
  await page.click('#btnUndo');
  ok(await page.evaluate((n) => window.PocketCAD.S.hIndex === n - 1, nHist), 'undo steps back');
  await page.click('#btnRedo');
  ok(await page.evaluate((n) => window.PocketCAD.S.hIndex === n, nHist), 'redo steps forward');
  // export STL via download
  await page.click('#tbExport');
  await page.screenshot({ path: `${OUT}/07-export.png` });
  const [dl] = await Promise.all([page.waitForEvent('download'), page.click('text=Download STL')]);
  const stlPath = path.join(OUT, 'exported.stl'); await dl.saveAs(stlPath);
  const [dl2] = await Promise.all([page.waitForEvent('download'), page.click('text=Download 3MF')]);
  await dl2.saveAs(path.join(OUT, 'exported.3mf'));
  ok(fs.statSync(stlPath).size > 84, 'STL downloaded (' + dl.suggestedFilename() + ', ' + fs.statSync(stlPath).size + ' bytes)');
  // measure
  await page.click('#sheet .close');
  await page.click('#tbMeasure');
  await page.waitForTimeout(300); // let the view resize after the sheet opens
  await tapAt([-8, -10, 5]); await page.waitForTimeout(150);
  await tapAt([8, -10, 5]); await page.waitForTimeout(200);
  const meas = await page.textContent('#measOut');
  ok(/16\.00 mm/.test(meas), 'measure two points 16 mm apart on the front face = 16.00 mm (' + meas.trim() + ')');
  await page.screenshot({ path: `${OUT}/08-measure.png` });
  await page.click('#tbMeasure');
  // arrange sheet screenshot
  await page.click('#tbArrange');
  await page.screenshot({ path: `${OUT}/09-arrange.png` });
  await page.click('text=Z +90°');
  await page.waitForTimeout(200);
  ok(await page.evaluate(() => window.PocketCAD.S.check.ok), 'rotate Z +90 keeps watertight');
  // reload -> autosave restore
  await page.waitForTimeout(1200);
  const triBefore = await page.evaluate(() => window.PocketCAD.S.model.tri.length);
  await page.reload();
  await page.waitForSelector('#splash.hidden', { state: 'attached', timeout: 30000 });
  const triAfter = await page.evaluate(() => window.PocketCAD.S.model && window.PocketCAD.S.model.tri.length);
  ok(triAfter === triBefore, 'auto-save restored the model after reload (' + triAfter / 3 + ' triangles)');
  // new scene + cylinder create, then text emboss
  await page.click('#btnMenu'); await page.click('text=New blank scene');
  await page.click('#modal .btn.primary');
  await page.click('.tile:has-text("Cylinder")');
  await page.waitForTimeout(200);
  await page.screenshot({ path: `${OUT}/10-shape.png` });
  await page.click('#sheet .row.end .btn.primary');
  await page.waitForFunction(() => window.PocketCAD.S.model && window.PocketCAD.S.model.tri.length > 0);
  ok(await page.evaluate(() => window.PocketCAD.S.check.ok), 'new cylinder created, watertight');
  await page.click('#tbAdd'); await page.click('.tile:has-text("Text")');
  await tapAt([0, 0, 20]); await page.waitForTimeout(400);
  await page.screenshot({ path: `${OUT}/11-text.png` });
  const v1 = await page.evaluate(() => window.PocketCAD.S.check.volume);
  await page.click('#sheet .row.end .btn.primary');
  await page.waitForFunction((v) => window.PocketCAD.S.check.volume > v + 1, v1, { timeout: 15000 });
  ok(await page.evaluate(() => window.PocketCAD.S.check.ok), 'text emboss on cylinder top, watertight');
  await page.screenshot({ path: `${OUT}/12-text-done.png` });
  // service worker registered?
  const sw = await page.evaluate(async () => { const r = await navigator.serviceWorker.getRegistration(); return !!r; });
  ok(sw, 'service worker registered (offline support)');
  ok(errors.length === 0, 'no console errors' + (errors.length ? ': ' + errors.join(' | ') : ''));
  await browser.close(); server.close();
  console.log(fails ? fails + ' FAILED' : 'ALL PASSED');
  process.exit(fails ? 1 : 0);
})().catch((e) => { console.error(e); server.close(); process.exit(1); });
