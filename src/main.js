// Pocket CAD - touch-first 3D model editor.
import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { TransformControls } from 'three/examples/jsm/controls/TransformControls.js';
import { Font } from 'three/examples/jsm/loaders/FontLoader.js';
import fontJson from 'three/examples/fonts/helvetiker_bold.typeface.json';
import wasmB64 from 'manifold-3d/manifold.wasm';
import { parseSTL, exportSTL } from './core/stl.js';
import { weld, checkWatertight, computeFaces, computeEdges, moveVerts, bbox, planeFrame, faceBounds2D, transformModel, repair, cloneModel } from './core/mesh.js';
import { initCSG, featureWorld, shapeWorld, applySolid, frameMatrix, toolMesh, freeSolid, edgeTool, cornerTool, planeCut, mirrorModel, simplifyModel, SCREWS } from './core/csg.js';
import { export3MF } from './core/threemf.js';

const BED = 180; // Bambu Lab A1 mini build volume, mm
const BIG_MESH = 300000;
const $ = (id) => document.getElementById(id);

// ---------- tiny DOM helper ----------
function h(tag, attrs, ...kids) {
  const el = document.createElement(tag);
  if (attrs) for (const [k, v] of Object.entries(attrs)) {
    if (v == null || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else if (k === 'html') el.innerHTML = v;
    else el.setAttribute(k, v === true ? '' : v);
  }
  for (const c of kids.flat()) if (c != null && c !== false) el.append(c.nodeType ? c : document.createTextNode(String(c)));
  return el;
}
const fmt = (x, d = 1) => (Math.abs(x) < 1e-9 ? 0 : x).toFixed(d);
const parseNum = (s) => { const v = parseFloat(String(s).replace(',', '.').replace(/[^0-9.+-eE]/g, '')); return Number.isFinite(v) ? v : NaN; };

// ---------- app state ----------
const S = {
  model: null, name: 'model',
  history: [], hIndex: -1,
  faces: null, edges: null, check: null,
  sel: null,           // {kind:'face'|'edge'|'corner', id, point}
  mode: 'select',      // select | measure | feature | shape | planecut
  snap: 1,
  feature: null, shape: null, plane: null, measure: null,
};

// ---------- three.js scene ----------
const view = $('view');
const renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: 'high-performance' });
renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
view.prepend(renderer.domElement);
const scene = new THREE.Scene();
scene.background = new THREE.Color(0x14171c);
const camera = new THREE.PerspectiveCamera(40, 1, 0.5, 8000);
camera.up.set(0, 0, 1);
camera.position.set(160, -200, 150);
scene.add(camera);
scene.add(new THREE.HemisphereLight(0xffffff, 0x30343c, 1.6));
const sun = new THREE.DirectionalLight(0xffffff, 1.6);
sun.position.set(0.4, 0.8, 1);
camera.add(sun);

// TransformControls first so it can claim touches before orbiting starts.
const tc = new TransformControls(camera, renderer.domElement);
tc.setSize(1.5);
tc.addEventListener('dragging-changed', (e) => { orbit.enabled = !e.value; });
tc.addEventListener('change', requestRender);
tc.addEventListener('objectChange', () => { onShapeMoved(); });
scene.add(tc.getHelper());
const orbit = new OrbitControls(camera, renderer.domElement);
orbit.enableDamping = false;
orbit.addEventListener('change', requestRender);
orbit.touches = { ONE: THREE.TOUCH.ROTATE, TWO: THREE.TOUCH.DOLLY_PAN };

// bed
const bedGroup = new THREE.Group();
{
  const plate = new THREE.Mesh(new THREE.PlaneGeometry(BED, BED), new THREE.MeshBasicMaterial({ color: 0x1d2229 }));
  plate.position.z = -0.05;
  bedGroup.add(plate);
  const grid = new THREE.GridHelper(BED, 18, 0x3a4250, 0x2a303a);
  grid.rotation.x = Math.PI / 2;
  bedGroup.add(grid);
  const half = BED / 2;
  const box = new THREE.LineSegments(new THREE.EdgesGeometry(new THREE.BoxGeometry(BED, BED, BED)), new THREE.LineBasicMaterial({ color: 0x2c3440, transparent: true, opacity: 0.6 }));
  box.position.z = half;
  bedGroup.add(box);
  const ax = (to, col) => new THREE.Line(new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(-half, -half, 0.1), new THREE.Vector3(...to)]), new THREE.LineBasicMaterial({ color: col }));
  bedGroup.add(ax([-half + 25, -half, 0.1], 0xff5a5f), ax([-half, -half + 25, 0.1], 0x3ddc97), ax([-half, -half, 25], 0x3b9eff));
}
scene.add(bedGroup);

const modelMat = new THREE.MeshStandardMaterial({ color: 0xa9b6c6, roughness: 0.55, metalness: 0.05, polygonOffset: true, polygonOffsetFactor: 1, polygonOffsetUnits: 1 });
const modelMesh = new THREE.Mesh(new THREE.BufferGeometry(), modelMat);
scene.add(modelMesh);
const edgeLines = new THREE.LineSegments(new THREE.BufferGeometry(), new THREE.LineBasicMaterial({ color: 0x1b2028 }));
scene.add(edgeLines);
const hiFace = new THREE.Mesh(new THREE.BufferGeometry(), new THREE.MeshBasicMaterial({ color: 0x3b9eff, transparent: true, opacity: 0.55, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2 }));
hiFace.renderOrder = 2;
scene.add(hiFace);
const hiGroup = new THREE.Group(); // edge / corner highlight
scene.add(hiGroup);
const previewGroup = new THREE.Group();
scene.add(previewGroup);
const measureGroup = new THREE.Group();
scene.add(measureGroup);

// push/pull arrow
const arrow = new THREE.Group();
{
  const mat = new THREE.MeshBasicMaterial({ color: 0x3b9eff, depthTest: false });
  const shaft = new THREE.Mesh(new THREE.CylinderGeometry(0.05, 0.05, 0.7, 12), mat);
  shaft.rotation.x = Math.PI / 2; shaft.position.z = 0.35;
  const head = new THREE.Mesh(new THREE.ConeGeometry(0.15, 0.3, 20), mat);
  head.rotation.x = Math.PI / 2; head.position.z = 0.85;
  const knob = new THREE.Mesh(new THREE.SphereGeometry(0.09, 16, 12), mat);
  const hit = new THREE.Mesh(new THREE.CylinderGeometry(0.22, 0.22, 1.2, 8), new THREE.MeshBasicMaterial({ visible: false }));
  hit.rotation.x = Math.PI / 2; hit.position.z = 0.55; hit.name = 'arrowHit';
  for (const o of [shaft, head, knob]) o.renderOrder = 10;
  arrow.add(shaft, head, knob, hit);
  arrow.visible = false;
}
scene.add(arrow);

let needsRender = true;
function requestRender() { needsRender = true; }
function resize() {
  const w = view.clientWidth, hh = view.clientHeight;
  if (!w || !hh) return;
  renderer.setSize(w, hh, false);
  renderer.domElement.style.width = w + 'px';
  renderer.domElement.style.height = hh + 'px';
  camera.aspect = w / hh;
  camera.updateProjectionMatrix();
  requestRender();
}
new ResizeObserver(resize).observe(view);
function screenScale(pos) { return camera.position.distanceTo(pos) * 0.13; }
function loop() {
  requestAnimationFrame(loop);
  if (!needsRender) return;
  needsRender = false;
  if (arrow.visible) arrow.scale.setScalar(screenScale(arrow.position));
  for (const o of measureGroup.children) if (o.userData.screenSized) o.scale.setScalar(screenScale(o.position) * 0.06);
  for (const o of hiGroup.children) if (o.userData.screenSized) o.scale.setScalar(screenScale(o.position) * 0.06);
  renderer.render(scene, camera);
  updateLabels();
}
requestAnimationFrame(loop);

// ---------- floating HTML labels ----------
const labels = [];
function addLabel(text, pos, cls = '') {
  const el = h('div', { class: 'label3d ' + cls }, text);
  $('labels').append(el);
  const L = { el, pos: pos.clone() };
  labels.push(L);
  requestRender();
  return L;
}
function clearLabels(filter) {
  for (let i = labels.length - 1; i >= 0; i--) {
    if (filter && !filter(labels[i])) continue;
    labels[i].el.remove(); labels.splice(i, 1);
  }
}
const _v = new THREE.Vector3();
function toScreen(p) {
  _v.copy(p).project(camera);
  return { x: (_v.x + 1) / 2 * view.clientWidth, y: (1 - _v.y) / 2 * view.clientHeight, front: _v.z < 1 };
}
function updateLabels() {
  for (const L of labels) {
    const s = toScreen(L.pos);
    L.el.style.display = s.front ? '' : 'none';
    L.el.style.transform = `translate(${s.x}px, ${s.y}px) translate(-50%, -130%)`;
  }
}

// ---------- UI basics ----------
let toastTimer = 0;
function toast(msg, kind = '') {
  const t = $('toast');
  t.textContent = msg;
  t.className = 'show ' + kind;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { t.className = ''; }, Math.max(2600, msg.length * 55));
}
async function busy(text, fn) {
  $('busyText').textContent = text;
  $('busy').classList.remove('hidden');
  await new Promise((r) => setTimeout(r, 40));
  try { return await fn(); } catch (e) {
    console.error(e);
    toast(e.message || String(e), 'error');
    return undefined;
  } finally { $('busy').classList.add('hidden'); }
}
function openModal(title, body, buttons = [{ label: 'Close' }]) {
  const card = $('modalCard');
  card.innerHTML = '';
  card.append(h('h2', null, title), h('div', { class: 'modal-body' }, body),
    h('div', { class: 'modal-buttons' }, buttons.map((b) => h('button', { class: 'btn ' + (b.primary ? 'primary' : ''), onclick: () => { closeModal(); b.onClick && b.onClick(); } }, b.label))));
  $('modal').classList.remove('hidden');
}
function closeModal() { $('modal').classList.add('hidden'); }
$('modal').addEventListener('click', (e) => { if (e.target.id === 'modal') closeModal(); });

// number field row: label, text input with decimal keypad, unit, +/- button
function numField(label, value, onChange, opts = {}) {
  const input = h('input', { type: 'text', inputmode: 'decimal', value: fmt(value, opts.digits ?? 1), 'aria-label': label, enterkeyhint: 'done' });
  const commit = (live) => {
    let v = parseNum(input.value);
    if (!Number.isFinite(v)) return;
    if (opts.min != null && v < opts.min) v = opts.min;
    if (opts.max != null && v > opts.max) v = opts.max;
    if (opts.int) v = Math.round(v);
    onChange(v, live);
  };
  let t = 0;
  input.addEventListener('input', () => { clearTimeout(t); t = setTimeout(() => commit(true), 250); });
  input.addEventListener('change', () => commit(false));
  input.addEventListener('keydown', (e) => { if (e.key === 'Enter') { input.blur(); } });
  input.addEventListener('focus', () => setTimeout(() => input.select(), 10));
  const row = h('label', { class: 'field' }, h('span', { class: 'flabel' }, label, opts.help ? h('small', null, opts.help) : null), h('span', { class: 'finput' }, input, h('span', { class: 'unit' }, opts.unit ?? 'mm')));
  if (opts.sign !== false && (opts.min == null || opts.min < 0)) {
    row.querySelector('.finput').append(h('button', { class: 'sign', type: 'button', 'aria-label': 'Change sign', onclick: (e) => { e.preventDefault(); const v = parseNum(input.value); if (Number.isFinite(v)) { input.value = fmt(-v, opts.digits ?? 1); commit(false); } } }, '±'));
  }
  row.setValue = (v) => { if (document.activeElement !== input) input.value = fmt(v, opts.digits ?? 1); };
  row.input = input;
  return row;
}
function choice(label, options, value, onChange) {
  const wrap = h('div', { class: 'seg' });
  const btns = options.map(([v, text]) => h('button', { type: 'button', class: v === value ? 'on' : '', onclick: () => { for (const b of btns) b.classList.remove('on'); btns[options.findIndex((o) => o[0] === v)].classList.add('on'); onChange(v); } }, text));
  wrap.append(...btns);
  return h('div', { class: 'field col' }, label ? h('span', { class: 'flabel' }, label) : null, wrap);
}
function toggle(label, value, onChange) {
  const input = h('input', { type: 'checkbox' });
  input.checked = !!value;
  input.addEventListener('change', () => onChange(input.checked));
  return h('label', { class: 'field toggle' }, h('span', { class: 'flabel' }, label), input, h('span', { class: 'switch' }));
}
const btn = (label, onClick, cls = '') => h('button', { class: 'btn ' + cls, type: 'button', onclick: onClick }, label);

function showSheet(title, content, { onClose } = {}) {
  const sh = $('sheet');
  sh.innerHTML = '';
  sh.append(h('div', { class: 'sheet-head' }, h('h3', null, title), h('button', { class: 'icon close', 'aria-label': 'Close', onclick: () => { onClose ? onClose() : closeSheet(); } }, '✕')), h('div', { class: 'sheet-body' }, content));
  sh.classList.remove('hidden');
  sh.scrollTop = 0;
}
function closeSheet() {
  $('sheet').classList.add('hidden');
  $('sheet').innerHTML = '';
}
function hint(text) {
  const el = $('hint');
  el.textContent = text || '';
  el.classList.toggle('show', !!text);
}

// ---------- model, display, history ----------
function setDisplay(model) {
  const g = new THREE.BufferGeometry();
  if (model && model.tri.length) {
    const { pos, tri } = model;
    const P = new Float32Array(tri.length * 3);
    for (let i = 0; i < tri.length; i++) { const v = tri[i] * 3; P[i * 3] = pos[v]; P[i * 3 + 1] = pos[v + 1]; P[i * 3 + 2] = pos[v + 2]; }
    g.setAttribute('position', new THREE.BufferAttribute(P, 3));
    g.computeVertexNormals(); // non-indexed: flat normals per triangle
    g.computeBoundingSphere(); g.computeBoundingBox();
  }
  modelMesh.geometry.dispose();
  modelMesh.geometry = g;
  edgeLines.geometry.dispose();
  edgeLines.geometry = model && model.tri.length / 3 < 150000 ? new THREE.EdgesGeometry(g, 25) : new THREE.BufferGeometry();
  edgeLines.visible = true;
  requestRender();
}

function historyBytes() { return S.history.reduce((s, e) => s + (e.model ? e.model.pos.byteLength + e.model.tri.byteLength : 0), 0); }

function commit(label, model, opts = {}) {
  S.history.length = S.hIndex + 1;
  S.history.push({ label, model, time: Date.now() });
  S.hIndex = S.history.length - 1;
  // memory guard: drop the oldest steps above ~350 MB
  while (S.history.length > 2 && historyBytes() > 350e6) { S.history.shift(); S.hIndex--; S.droppedHistory = true; }
  loadState(model, opts);
  scheduleAutosave();
}
function loadState(model, opts = {}) {
  S.model = model;
  S.faces = null; S.edges = null;
  if (!opts.keepSel) clearSelection();
  setDisplay(model);
  S.check = model && model.tri.length ? checkWatertight(model) : null;
  updateTopBar();
  if (opts.warnCheck !== false && S.check && !S.check.ok) toast('Warning: the model has gaps (not watertight). Tap the red badge for help.', 'error');
}
function undo() {
  if (S.hIndex <= 0) { toast('Nothing to undo'); return; }
  cancelModes();
  S.hIndex--;
  loadState(S.history[S.hIndex].model, { warnCheck: false });
  toast('Undo: ' + S.history[S.hIndex + 1].label);
  scheduleAutosave();
}
function redo() {
  if (S.hIndex >= S.history.length - 1) { toast('Nothing to redo'); return; }
  cancelModes();
  S.hIndex++;
  loadState(S.history[S.hIndex].model, { warnCheck: false });
  toast('Redo: ' + S.history[S.hIndex].label);
  scheduleAutosave();
}
function ensureFaces() {
  if (!S.faces && S.model) S.faces = computeFaces(S.model);
  return S.faces;
}
function ensureEdges() {
  if (!S.edges && S.model) S.edges = computeEdges(S.model, ensureFaces());
  return S.edges;
}
function sceneSize() {
  if (!S.model) return 50;
  const b = bbox(S.model);
  return Math.max(10, Math.hypot(...b.size));
}

function updateTopBar() {
  $('fileName').textContent = S.model ? S.name : 'No model yet';
  const sl = $('sizeLabel');
  const badge = $('badge');
  $('btnUndo').disabled = S.hIndex <= 0;
  $('btnRedo').disabled = S.hIndex >= S.history.length - 1;
  if (!S.model || !S.model.tri.length) {
    sl.textContent = 'Open an STL or add a shape';
    sl.className = '';
    badge.innerHTML = '<b>—</b><small>Check</small>'; badge.className = 'badge';
    return;
  }
  const b = bbox(S.model);
  const too = b.size.some((x) => x > BED + 1e-6);
  const c = (x) => fmt(x).replace(/\.0$/, '');
  sl.textContent = `${c(b.size[0])} × ${c(b.size[1])} × ${c(b.size[2])} mm` + (too ? ' — too big!' : '');
  sl.className = too ? 'warn' : '';
  badge.innerHTML = '';
  if (S.check.ok) { badge.append(h('b', null, '✓'), h('small', null, 'Watertight')); badge.className = 'badge ok'; }
  else { badge.append(h('b', null, '⚠ ' + (S.check.open + S.check.nonManifold + S.check.flipped)), h('small', null, 'gaps')); badge.className = 'badge bad'; }
}

function fitView(dir, boxOverride) {
  const box = new THREE.Box3();
  if (boxOverride) box.copy(boxOverride);
  else if (S.model && S.model.tri.length) box.copy(modelMesh.geometry.boundingBox);
  else box.set(new THREE.Vector3(-BED / 2, -BED / 2, 0), new THREE.Vector3(BED / 2, BED / 2, 20));
  const c = box.getCenter(new THREE.Vector3());
  const r = Math.max(5, box.getSize(new THREE.Vector3()).length() / 2);
  const d = dir || camera.position.clone().sub(orbit.target).normalize();
  if (d.lengthSq() < 1e-6) d.set(0.6, -0.8, 0.6);
  const dist = r / Math.sin((camera.fov * Math.PI / 180) / 2) * 1.15;
  orbit.target.copy(c);
  camera.position.copy(c).add(d.normalize().multiplyScalar(dist));
  camera.near = Math.max(0.05, dist / 1000);
  camera.far = dist * 50;
  camera.updateProjectionMatrix();
  orbit.update();
  requestRender();
}
const VIEWS = [['3D', [0.6, -0.8, 0.6]], ['Top', [0, -0.001, 1]], ['Front', [0, -1, 0.001]], ['Right', [1, 0, 0.001]]];
let viewIdx = 0;

// ---------- selection ----------
function clearSelection() {
  S.sel = null;
  hiFace.visible = false;
  hiGroup.clear();
  arrow.visible = false;
  clearLabels((l) => l.el.classList.contains('dragLabel'));
  requestRender();
}
function highlightFace(fid) {
  const f = ensureFaces().faces[fid];
  const src = modelMesh.geometry.attributes.position.array;
  const P = new Float32Array(f.tris.length * 9);
  f.tris.forEach((t, i) => P.set(src.subarray(t * 9, t * 9 + 9), i * 9));
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(P, 3));
  hiFace.geometry.dispose();
  hiFace.geometry = g;
  hiFace.visible = true;
  requestRender();
}
function tube(a, b, r, color) {
  const A = new THREE.Vector3(...a), B = new THREE.Vector3(...b);
  const len = A.distanceTo(B);
  const m = new THREE.Mesh(new THREE.CylinderGeometry(r, r, len, 8), new THREE.MeshBasicMaterial({ color, depthTest: false }));
  m.position.copy(A).add(B).multiplyScalar(0.5);
  m.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), B.clone().sub(A).normalize());
  m.renderOrder = 5;
  return m;
}
function highlightEdge(e) {
  hiGroup.clear();
  const r = Math.max(0.12, sceneSize() * 0.004);
  for (let i = 1; i < e.pts.length; i++) hiGroup.add(tube(e.pts[i - 1], e.pts[i], r, e.straight ? 0x3b9eff : 0xffb020));
  requestRender();
}
function dot(p, color = 0x3b9eff) {
  const m = new THREE.Mesh(new THREE.SphereGeometry(1, 16, 12), new THREE.MeshBasicMaterial({ color, depthTest: false }));
  m.position.copy(p);
  m.renderOrder = 6;
  m.userData.screenSized = true;
  return m;
}

const raycaster = new THREE.Raycaster();
function rayAt(x, y) {
  const ndc = new THREE.Vector2(x / view.clientWidth * 2 - 1, -(y / view.clientHeight) * 2 + 1);
  raycaster.setFromCamera(ndc, camera);
  return raycaster.ray.clone();
}
function pickModel(x, y) {
  if (!S.model) return null;
  rayAt(x, y);
  const hits = raycaster.intersectObject(modelMesh, false);
  return hits[0] || null;
}
function isVisible(p) {
  const P = new THREE.Vector3(...p);
  const dir = P.clone().sub(camera.position);
  const dist = dir.length();
  raycaster.set(camera.position, dir.normalize());
  const hit = raycaster.intersectObject(modelMesh, false)[0];
  return !hit || hit.distance >= dist - Math.max(0.05, sceneSize() * 0.003);
}
function segDist2D(p, a, b) {
  const dx = b.x - a.x, dy = b.y - a.y;
  const l2 = dx * dx + dy * dy || 1;
  let t = ((p.x - a.x) * dx + (p.y - a.y) * dy) / l2;
  t = Math.max(0, Math.min(1, t));
  return { d: Math.hypot(p.x - a.x - dx * t, p.y - a.y - dy * t), t };
}

function selectAt(x, y) {
  if (!S.model) return;
  const hit = pickModel(x, y);
  const ed = ensureEdges();
  const tap = { x, y };
  // corners first (within 22 px)
  let best = null;
  for (const c of ed.corners) {
    const s = toScreen(new THREE.Vector3(...c.p));
    if (!s.front) continue;
    const d = Math.hypot(s.x - x, s.y - y);
    if (d < 22 && (!best || d < best.d) && isVisible(c.p)) best = { d, kind: 'corner', id: c.id };
  }
  if (!best) {
    for (const e of ed.edges) {
      for (let i = 1; i < e.pts.length; i++) {
        const a = toScreen(new THREE.Vector3(...e.pts[i - 1])), b = toScreen(new THREE.Vector3(...e.pts[i]));
        if (!a.front || !b.front) continue;
        const r = segDist2D(tap, a, b);
        if (r.d < 16 && (!best || r.d < best.d)) {
          const p = e.pts[i - 1].map((q, k) => q + (e.pts[i][k] - q) * r.t);
          if (isVisible(p)) best = { d: r.d, kind: 'edge', id: e.id };
        }
      }
    }
  }
  if (best) { selectThing(best.kind, best.id); return; }
  if (hit) { selectThing('face', ensureFaces().faceOf[hit.faceIndex], hit.point); return; }
  clearSelection(); closeSheet();
}

function selectThing(kind, id, point) {
  clearSelection();
  S.sel = { kind, id, point: point ? point.clone() : null };
  if (kind === 'face') { highlightFace(id); showFaceSheet(); }
  else if (kind === 'edge') { highlightEdge(ensureEdges().edges[id]); showEdgeSheet(); }
  else if (kind === 'corner') {
    const c = ensureEdges().corners[id];
    hiGroup.add(dot(new THREE.Vector3(...c.p)));
    requestRender();
    showCornerSheet();
  }
}

// ---------- push / pull ----------
let drag = null;
function faceVertsSet(fid) { return new Set(ensureFaces().faces[fid].verts); }
function showArrow(fid, point) {
  const f = ensureFaces().faces[fid];
  const base = point ? point.clone() : new THREE.Vector3(...f.centroid);
  arrow.position.copy(base);
  arrow.quaternion.setFromUnitVectors(new THREE.Vector3(0, 0, 1), new THREE.Vector3(...f.normal));
  arrow.visible = true;
  requestRender();
}
function maxInward(fid) {
  const f = ensureFaces().faces[fid];
  const own = new Set(f.tris);
  const n = new THREE.Vector3(...f.normal);
  const back = n.clone().negate();
  const pts = [f.centroid];
  const step = Math.max(1, Math.floor(f.verts.length / 60));
  for (let i = 0; i < f.verts.length; i += step) { const v = f.verts[i] * 3; pts.push([S.model.pos[v], S.model.pos[v + 1], S.model.pos[v + 2]]); }
  let best = Infinity;
  modelMat.side = THREE.DoubleSide; // the opposite wall is seen from behind, so count back faces too
  for (const p of pts) {
    // start slightly inside the face, nudged toward the centroid so edge rays do not graze side walls
    const P = new THREE.Vector3(...p).lerp(new THREE.Vector3(...f.centroid), 0.02).addScaledVector(back, 1e-3);
    raycaster.set(P, back);
    raycaster.far = Infinity;
    const hits = raycaster.intersectObject(modelMesh, false);
    for (const hh of hits) { if (own.has(hh.faceIndex) || hh.distance < 1e-4) continue; best = Math.min(best, hh.distance); break; }
  }
  modelMat.side = THREE.FrontSide;
  raycaster.far = Infinity;
  return best;
}
function startPushPull(e) {
  const fid = S.sel.id;
  const f = ensureFaces().faces[fid];
  const verts = faceVertsSet(fid);
  // display indices whose vertex moves, and triangles to re-shade
  const tri = S.model.tri;
  const idx = [], trisTouched = new Set();
  for (let i = 0; i < tri.length; i++) if (verts.has(tri[i])) { idx.push(i); trisTouched.add((i / 3) | 0); }
  const posAttr = modelMesh.geometry.attributes.position;
  drag = {
    fid, n: new THREE.Vector3(...f.normal), base: arrow.position.clone(), idx, tris: [...trisTouched],
    orig: posAttr.array.slice(), limit: -(maxInward(fid) - 0.2), dist: 0,
    t0: null, label: addLabel('0.0 mm', arrow.position, 'dragLabel'), pointerId: e.pointerId,
  };
  drag.t0 = lineParam(e);
  edgeLines.visible = false;
  hiFace.visible = false;
  orbit.enabled = false;
}
function lineParam(e) {
  const r = view.getBoundingClientRect();
  const ray = rayAt(e.clientX - r.left, e.clientY - r.top);
  // closest point on the line (base + n t) to the pointer ray
  const w0 = drag.base.clone().sub(ray.origin);
  const a = drag.n.dot(drag.n), b = drag.n.dot(ray.direction), c = ray.direction.dot(ray.direction);
  const d = drag.n.dot(w0), ee = ray.direction.dot(w0);
  const den = a * c - b * b;
  if (Math.abs(den) < 1e-6) return drag.t0 ?? 0;
  return (b * ee - c * d) / den;
}
function snapVal(x) { return S.snap > 0 ? Math.round(x / S.snap) * S.snap : Math.round(x * 100) / 100; }
function previewPushPull(dist) {
  const arr = modelMesh.geometry.attributes.position.array;
  arr.set(drag.orig);
  for (const i of drag.idx) { arr[i * 3] += drag.n.x * dist; arr[i * 3 + 1] += drag.n.y * dist; arr[i * 3 + 2] += drag.n.z * dist; }
  const g = modelMesh.geometry;
  g.attributes.position.needsUpdate = true;
  g.computeVertexNormals();
  g.computeBoundingSphere();
  arrow.position.copy(drag.base).addScaledVector(drag.n, dist);
  drag.label.pos.copy(arrow.position);
  drag.label.el.textContent = (dist > 0 ? '+' : '') + fmt(dist) + ' mm ' + (dist > 0 ? '(pull out)' : dist < 0 ? '(push in)' : '');
  requestRender();
}
function movePushPull(e) {
  let d = snapVal(lineParam(e) - drag.t0);
  if (d < drag.limit) d = Math.ceil(drag.limit / (S.snap || 0.01)) * (S.snap || 0.01);
  drag.dist = d;
  previewPushPull(d);
  const fld = document.querySelector('#ppField input');
  if (fld) fld.value = fmt(d);
}
function endPushPull() {
  const d = drag.dist, fid = drag.fid;
  drag.label.el.remove(); labels.splice(labels.indexOf(drag.label), 1);
  orbit.enabled = true;
  const dd = drag; drag = null;
  if (Math.abs(d) < 1e-6) { setDisplay(S.model); highlightFace(fid); showArrow(fid, dd.base); return; }
  applyPushPull(fid, d);
}
function applyPushPull(fid, d) {
  const f = ensureFaces().faces[fid];
  const lim = maxInward(fid);
  if (d < 0 && -d >= lim - 0.01) { toast(`Can't push in that far: only ${fmt(lim)} mm of material behind this face.`, 'error'); setDisplay(S.model); return; }
  const verts = f.verts;
  const anyTri = f.tris[0];
  const point = (S.sel && S.sel.point ? S.sel.point.clone() : new THREE.Vector3(...f.centroid)).addScaledVector(new THREE.Vector3(...f.normal), d);
  const m = moveVerts(S.model, verts, f.normal, d);
  commit(`Push/pull ${d > 0 ? '+' : ''}${fmt(d)} mm`, m, { keepSel: true });
  // reselect the same face (vertex numbers are unchanged by push/pull)
  const fd = ensureFaces();
  const nid = fd.faceOf[anyTri];
  S.sel = { kind: 'face', id: nid, point };
  highlightFace(nid);
  showFaceSheet();
}

// capture-phase pointer handling so the arrow wins over orbiting
let tapStart = null, multi = false, tcAxisAtDown = null;
view.addEventListener('pointerdown', (e) => {
  if (arrow.visible && S.mode === 'select' && S.sel && S.sel.kind === 'face' && !drag) {
    const r = view.getBoundingClientRect();
    rayAt(e.clientX - r.left, e.clientY - r.top);
    const hit = raycaster.intersectObject(arrow, true).find((x) => x.object.name === 'arrowHit');
    if (hit) {
      e.stopPropagation(); e.preventDefault();
      startPushPull(e);
      return;
    }
  }
}, true);
window.addEventListener('pointermove', (e) => { if (drag && e.pointerId === drag.pointerId) movePushPull(e); });
window.addEventListener('pointerup', (e) => { if (drag && e.pointerId === drag.pointerId) endPushPull(); });
window.addEventListener('pointercancel', (e) => { if (drag && e.pointerId === drag.pointerId) { drag.dist = 0; endPushPull(); } });

const activePointers = new Set();
view.addEventListener('pointerdown', (e) => {
  if (e.isPrimary) activePointers.clear(); // a new primary pointer means earlier touches have ended
  activePointers.add(e.pointerId);
  if (activePointers.size > 1) multi = true;
  if (activePointers.size === 1) { multi = false; tapStart = { x: e.clientX, y: e.clientY, t: performance.now(), id: e.pointerId }; }
  tcAxisAtDown = tc.axis;
});
const endPointer = (e) => {
  activePointers.delete(e.pointerId);
  if (!tapStart || e.pointerId !== tapStart.id) return;
  const moved = Math.hypot(e.clientX - tapStart.x, e.clientY - tapStart.y);
  const dt = performance.now() - tapStart.t;
  const ok = !multi && moved < 9 && dt < 600 && e.type === 'pointerup' && !tcAxisAtDown;
  tapStart = null;
  if (ok) {
    const r = view.getBoundingClientRect();
    onTap(e.clientX - r.left, e.clientY - r.top);
  }
};
view.addEventListener('pointerup', endPointer);
view.addEventListener('pointercancel', endPointer);

function onTap(x, y) {
  if (drag) return;
  switch (S.mode) {
    case 'select':
      // the first tap after an edit finds faces and edges; on big models that takes a moment
      if (!S.edges && S.model && S.model.tri.length / 3 > 40000) busy('Finding faces and edges…', () => selectAt(x, y));
      else selectAt(x, y);
      break;
    case 'measure': measureTap(x, y); break;
    case 'feature': featureTap(x, y); break;
    case 'shape': shapeTap(x, y); break;
    default: break;
  }
}

// ---------- face / edge / corner sheets ----------
function faceInfo(fid) {
  const f = ensureFaces().faces[fid];
  const fr = planeFrame(f.normal);
  const b = faceBounds2D(S.model, f, fr);
  return { f, fr, b };
}
function showFaceSheet() {
  const fid = S.sel.id;
  const { f, b } = faceInfo(fid);
  showArrow(fid, S.sel.point);
  let dist = 0;
  const pp = numField('Push / pull distance', 0, (v) => { dist = v; }, { help: '+ pulls the face out, − pushes it in' });
  pp.id = 'ppField';
  const flat = Math.abs(f.normal[2]) > 0.999 ? (f.normal[2] < 0 ? 'facing down' : 'facing up') : 'side face';
  showSheet('Flat face selected', [
    h('p', { class: 'info' }, `About ${fmt(b.w)} × ${fmt(b.h)} mm, area ${fmt(f.area)} mm² (${flat}). Drag the blue arrow, or type an exact distance:`),
    h('div', { class: 'row' }, pp, btn('Apply', () => { if (dist) applyPushPull(fid, snapVal(dist)); }, 'primary')),
    h('div', { class: 'grid2' },
      btn('＋ Add / cut here…', () => showToolMenu(true)),
      btn('Lay this face on the bed', () => layFlat(fid)),
      btn('Cut along this face', () => startPlaneCut({ normal: f.normal, offset: f.d })),
      btn('Mirror copy across face', () => doMirror(f.normal, f.d, true, 'Mirror copy across face'))),
  ], { onClose: () => { clearSelection(); closeSheet(); } });
}

function edgePreview(kind, size) {
  clearPreview();
  const e = ensureEdges().edges[S.sel.id];
  try {
    const t = edgeTool(e, kind, size);
    addPreview(t.solid, t.op);
    freeSolid(t.solid);
  } catch (err) { toast(err.message, 'error'); }
}
function showEdgeSheet() {
  const e = ensureEdges().edges[S.sel.id];
  if (!e.straight) {
    showSheet('Curved edge selected', [
      h('p', { class: 'info' }, `Length about ${fmt(e.length)} mm. Rounding or chamfering curved edges is not supported yet. Tip: for the top of a screw hole, use Add/Cut → Hole with a countersink (cone-shaped recess).`),
    ], { onClose: () => { clearSelection(); closeSheet(); } });
    return;
  }
  let kind = 'chamfer', size = Math.min(1, e.length / 4);
  const run = () => edgePreview(kind, size);
  showSheet('Edge selected', [
    h('p', { class: 'info' }, `${fmt(e.length)} mm long, ${e.convex ? 'outside corner (material will be removed)' : 'inside corner (material will be added)'}.`),
    choice('Edge style', [['chamfer', 'Chamfer (angled cut)'], ['fillet', 'Fillet (rounded)']], kind, (v) => { kind = v; run(); }),
    h('div', { class: 'row' }, numField(kind === 'fillet' ? 'Size' : 'Size', size, (v) => { size = v; run(); }, { min: 0.1, help: 'chamfer width or fillet radius' }),
      btn('Apply', () => applyEdge(e, kind, size), 'primary')),
  ], { onClose: () => { clearPreview(); clearSelection(); closeSheet(); } });
  run();
}
function applyEdge(e, kind, size) {
  busy('Shaping edge…', () => {
    const t = edgeTool(e, kind, size);
    try {
      const m = applySolid(S.model, t.solid, t.op);
      clearPreview();
      commit(`${kind === 'fillet' ? 'Fillet' : 'Chamfer'} ${fmt(size)} mm`, m);
      closeSheet();
      toast('Done. ' + checkMsg());
    } finally { freeSolid(t.solid); }
  });
}
function cornerOutward(c) {
  const fd = ensureFaces();
  const n = [0, 0, 0];
  for (const fid of c.faces) for (let k = 0; k < 3; k++) n[k] += fd.faces[fid].normal[k];
  const l = Math.hypot(...n) || 1;
  return n.map((x) => x / l);
}
function showCornerSheet() {
  const c = ensureEdges().corners[S.sel.id];
  const ed = ensureEdges();
  const touching = ed.edges.filter((e) => e.straight && (e.va === c.v || e.vb === c.v));
  const convex = touching.length >= 3 && touching.every((e) => e.convex);
  let size = 1;
  const run = () => {
    clearPreview();
    if (!convex) return;
    try { const t = cornerTool(c, size, cornerOutward(c)); addPreview(t.solid, 'cut'); freeSolid(t.solid); } catch (err) { toast(err.message, 'error'); }
  };
  if (!convex) {
    showSheet('Corner selected', [h('p', { class: 'info' }, 'Only outside corners where three straight edges meet can be chamfered. Rounding corners (fillet) is not supported yet — tip: select the edges and fillet them one by one.')], { onClose: () => { clearSelection(); closeSheet(); } });
    return;
  }
  showSheet('Corner selected', [
    h('p', { class: 'info' }, 'Chamfer (cut off) this corner. Size = distance along each edge. Rounding corners is not supported yet.'),
    h('div', { class: 'row' }, numField('Chamfer size', size, (v) => { size = v; run(); }, { min: 0.1 }),
      btn('Apply', () => busy('Cutting corner…', () => {
        const t = cornerTool(c, size, cornerOutward(c));
        try { const m = applySolid(S.model, t.solid, 'cut'); clearPreview(); commit(`Corner chamfer ${fmt(size)} mm`, m); closeSheet(); toast('Done. ' + checkMsg()); } finally { freeSolid(t.solid); }
      }), 'primary')),
  ], { onClose: () => { clearPreview(); clearSelection(); closeSheet(); } });
  run();
}
function checkMsg() { return S.check && S.check.ok ? 'Model is watertight ✓' : 'Warning: model has gaps.'; }

// ---------- previews ----------
function clearPreview() {
  for (const o of previewGroup.children) o.geometry && o.geometry.dispose();
  previewGroup.clear();
  clearLabels((l) => l.el.classList.contains('prevLabel'));
  requestRender();
}
function meshFromModel(m) {
  const P = new Float32Array(m.tri.length * 3);
  for (let i = 0; i < m.tri.length; i++) { const v = m.tri[i] * 3; P[i * 3] = m.pos[v]; P[i * 3 + 1] = m.pos[v + 1]; P[i * 3 + 2] = m.pos[v + 2]; }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(P, 3));
  g.computeVertexNormals();
  return g;
}
function addPreview(solid, op) {
  const g = meshFromModel(toolMesh(solid));
  const color = op === 'cut' ? 0xff5a5f : 0x3ddc97;
  const m = new THREE.Mesh(g, new THREE.MeshStandardMaterial({ color, transparent: true, opacity: 0.5, depthTest: false, depthWrite: false, emissive: color, emissiveIntensity: 0.25 }));
  m.renderOrder = 8;
  previewGroup.add(m);
  const l = new THREE.LineSegments(new THREE.EdgesGeometry(g, 30), new THREE.LineBasicMaterial({ color, depthTest: false }));
  l.renderOrder = 9;
  previewGroup.add(l);
  requestRender();
}

// ---------- tools (add / cut features) ----------
const TOOLS = {
  hole: { name: 'Hole', icon: '◎', desc: 'Round hole for a screw or pin', params: { preset: 'M3', diameter: SCREWS.M3.clear, through: true, depth: 5, head: 'none', headD: SCREWS.M3.cbD, headDepth: SCREWS.M3.cbDepth } },
  slot: { name: 'Slot', icon: '⊂⊃', desc: 'Long rounded hole', params: { length: 10, width: 3.4, through: false, depth: 3, angle: 0 } },
  pocket: { name: 'Square pocket', icon: '▢', desc: 'Rectangular recess', params: { width: 10, height: 10, radius: 0, through: false, depth: 3, angle: 0 } },
  text: { name: 'Text', icon: 'T', desc: 'Raised or engraved letters', params: { text: 'HELLO', size: 8, depth: 1, mode: 'emboss', angle: 0 } },
  bracket: { name: 'L-bracket', icon: '⌐', desc: 'Right-angle bracket', params: { legA: 20, legB: 20, width: 15, thick: 3, holeD: 3.4, angle: 0 } },
  tab: { name: 'Mounting tab', icon: '◖', desc: 'Flat ear with a screw hole', params: { length: 12, width: 10, thick: 3, holeD: 3.4 } },
  rib: { name: 'Rib / gusset', icon: '◺', desc: 'Triangle brace', params: { length: 10, height: 10, thick: 2, angle: 0 } },
  standoff: { name: 'Standoff / boss', icon: '⊙', desc: 'Post with a screw hole', params: { outerD: 7, height: 8, holeD: 2.5, holeDepth: 6 } },
};
const SHAPES = {
  box: { name: 'Box', icon: '▣', size: { x: 20, y: 20, z: 20 } },
  cylinder: { name: 'Cylinder', icon: '⬭', size: { x: 20, y: 20, z: 20 } },
  sphere: { name: 'Sphere', icon: '●', size: { x: 20, y: 20, z: 20 } },
  cone: { name: 'Cone', icon: '▲', size: { x: 20, y: 20, z: 20, top: 0 } },
};

function showToolMenu(fromFace) {
  const keepFace = fromFace && S.sel && S.sel.kind === 'face' ? { ...S.sel } : null;
  cancelModes(true);
  const tile = (icon, name, desc, onClick) => h('button', { class: 'tile', type: 'button', onclick: onClick }, h('span', { class: 'ticon' }, icon), h('b', null, name), h('small', null, desc));
  const hasModel = S.model && S.model.tri.length;
  showSheet(hasModel ? 'Add / cut' : 'Start with a shape', [
    hasModel ? h('p', { class: 'sub' }, 'Features (placed on a flat face)') : null,
    hasModel ? h('div', { class: 'tiles' }, Object.entries(TOOLS).map(([k, t]) => tile(t.icon, t.name, t.desc, () => startFeature(k, keepFace)))) : null,
    h('p', { class: 'sub' }, hasModel ? 'Basic shapes (add or subtract, then move / rotate / resize)' : 'Pick a basic shape. You can resize it after.'),
    h('div', { class: 'tiles' }, Object.entries(SHAPES).map(([k, t]) => tile(t.icon, t.name, hasModel ? 'Add or cut' : 'Start here', () => startShape(k, keepFace)))),
  ]);
}

function placementFromFace(fid, point) {
  const { f, fr, b } = faceInfo(fid);
  let U = (b.minU + b.maxU) / 2 - b.minU, V = (b.minV + b.maxV) / 2 - b.minV;
  if (point) {
    U = snapVal(point.dot(new THREE.Vector3(...fr.u)) - b.minU);
    V = snapVal(point.dot(new THREE.Vector3(...fr.v)) - b.minV);
  }
  return { fid, f, fr, b, U, V };
}
function startFeature(type, sel) {
  cancelModes(true);
  const def = TOOLS[type];
  S.mode = 'feature';
  S.feature = { type, params: JSON.parse(JSON.stringify(def.params)), place: null, pattern: { type: 'none', count: 4, spacing: 10, dir: 'u', angle: 360 } };
  if (sel && sel.kind === 'face') {
    S.feature.place = placementFromFace(sel.id, sel.point);
    if (type === 'tab') S.feature.place.V = 0;
    if (type === 'text') fitTextToFace();
  }
  clearSelection();
  renderFeatureSheet();
  updateFeaturePreview();
  if (!S.feature.place) hint('Tap a flat face on the model to place the ' + def.name.toLowerCase());
}
function featureTap(x, y) {
  const hit = pickModel(x, y);
  if (!hit) return;
  const fid = ensureFaces().faceOf[hit.faceIndex];
  const old = S.feature.place;
  S.feature.place = placementFromFace(fid, hit.point);
  if (S.feature.type === 'tab' && (!old || old.fid !== fid)) S.feature.place.V = 0;
  if (S.feature.type === 'text' && (!old || old.fid !== fid)) fitTextToFace();
  highlightFace(fid);
  hint('');
  renderFeatureSheet();
  updateFeaturePreview();
}
// pick a letter height so the text fits on the face (user can still change it)
function fitTextToFace() {
  const F = S.feature, b = F.place.b;
  const n = Math.max(1, (F.params.text || '').length);
  F.params.size = Math.max(2, Math.min(20, Math.floor(Math.min(b.w * 0.85 / (0.75 * n), b.h * 0.6))));
}
function featureFrame() {
  const p = S.feature.place;
  const { fr, b, f } = p;
  const u = new THREE.Vector3(...fr.u), v = new THREE.Vector3(...fr.v), n = new THREE.Vector3(...fr.n);
  const origin = n.clone().multiplyScalar(f.d).addScaledVector(u, b.minU + p.U).addScaledVector(v, b.minV + p.V);
  return { M: frameMatrix(fr.u, fr.v, fr.n, origin.toArray()), origin };
}
function textPolygons(text, size) {
  const font = textPolygons.font || (textPolygons.font = new Font(fontJson));
  const shapes = font.generateShapes(text || '', size);
  const polys = [];
  for (const s of shapes) {
    const ex = s.extractPoints(8);
    polys.push(ex.shape.map((p) => [p.x, p.y]));
    for (const hole of ex.holes) polys.push(hole.map((p) => [p.x, p.y]));
  }
  // centre the text on the placement point
  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
  for (const p of polys) for (const [x, y] of p) { minX = Math.min(minX, x); maxX = Math.max(maxX, x); minY = Math.min(minY, y); maxY = Math.max(maxY, y); }
  const cx = (minX + maxX) / 2, cy = (minY + maxY) / 2;
  return polys.filter((p) => p.length >= 3).map((p) => p.map(([x, y]) => [x - cx, y - cy]));
}
function featureParams() {
  const F = S.feature;
  const p = { ...F.params };
  if (F.type === 'text') p.polygons = textPolygons(p.text, p.size);
  return p;
}
function featurePattern() {
  const F = S.feature, pl = F.place;
  const pat = { ...F.pattern };
  if (pat.type === 'circular') { pat.cx = pl.b.w / 2 - pl.U; pat.cy = pl.b.h / 2 - pl.V; }
  return pat;
}
let featTimer = 0;
function updateFeaturePreview() {
  clearTimeout(featTimer);
  featTimer = setTimeout(() => {
    clearPreview();
    const F = S.feature;
    if (!F || !F.place) return;
    try {
      const { M, origin } = featureFrame();
      const t = featureWorld(F.type, featureParams(), M, featurePattern(), sceneSize() * 2 + 10);
      addPreview(t.solid, t.op);
      freeSolid(t.solid);
      addLabel(`← ${fmt(F.place.U)}  ↓ ${fmt(F.place.V)} mm`, origin, 'prevLabel');
    } catch (e) { toast(e.message, 'error'); }
  }, 60);
}
function renderFeatureSheet() {
  const F = S.feature;
  const def = TOOLS[F.type];
  const P = F.params;
  const upd = () => updateFeaturePreview();
  const set = (k) => (v) => { P[k] = v; upd(); };
  const rows = [];
  switch (F.type) {
    case 'hole': {
      rows.push(choice('Screw size preset', [['custom', 'Custom'], ['M3', 'M3'], ['M4', 'M4'], ['M5', 'M5']], P.preset, (v) => {
        P.preset = v;
        if (SCREWS[v]) { P.diameter = SCREWS[v].clear; P.headD = P.head === 'countersink' ? SCREWS[v].cskD : SCREWS[v].cbD; P.headDepth = SCREWS[v].cbDepth; }
        renderFeatureSheet(); upd();
      }));
      rows.push(h('p', { class: 'note' }, 'M3 / M4 / M5 = metric screws 3, 4, 5 mm thick. Hole sizes are typical clearance values (a little bigger than the screw) — check them against your screws.'));
      rows.push(numField('Diameter', P.diameter, (v) => { P.diameter = v; P.preset = 'custom'; upd(); }, { min: 0.2, digits: 2 }));
      rows.push(toggle('Through-hole (goes all the way through)', P.through, (v) => { P.through = v; renderFeatureSheet(); upd(); }));
      if (!P.through) rows.push(numField('Depth', P.depth, set('depth'), { min: 0.1 }));
      rows.push(choice('Screw head recess', [['none', 'None'], ['countersink', 'Countersink'], ['counterbore', 'Counterbore']], P.head, (v) => {
        P.head = v;
        if (SCREWS[P.preset]) P.headD = v === 'countersink' ? SCREWS[P.preset].cskD : SCREWS[P.preset].cbD;
        renderFeatureSheet(); upd();
      }));
      rows.push(h('p', { class: 'note' }, 'Countersink = cone-shaped recess so a flat-head screw sits flush. Counterbore = flat-bottomed step so a round-head screw sits below the surface.'));
      if (P.head !== 'none') rows.push(numField('Head diameter', P.headD, set('headD'), { min: 0.5, digits: 2 }));
      if (P.head === 'counterbore') rows.push(numField('Head depth', P.headDepth, set('headDepth'), { min: 0.1 }));
      break;
    }
    case 'slot':
      rows.push(numField('Length (overall)', P.length, set('length'), { min: 0.5 }), numField('Width', P.width, set('width'), { min: 0.2 }));
      rows.push(toggle('Through (all the way)', P.through, (v) => { P.through = v; renderFeatureSheet(); upd(); }));
      if (!P.through) rows.push(numField('Depth', P.depth, set('depth'), { min: 0.1 }));
      rows.push(numField('Angle', P.angle, set('angle'), { unit: '°', help: 'degrees, turns it on the face' }));
      break;
    case 'pocket':
      rows.push(numField('Width', P.width, set('width'), { min: 0.5 }), numField('Height', P.height, set('height'), { min: 0.5 }), numField('Corner radius', P.radius, set('radius'), { min: 0, help: '0 = sharp corners' }));
      rows.push(toggle('Through (cut-out window)', P.through, (v) => { P.through = v; renderFeatureSheet(); upd(); }));
      if (!P.through) rows.push(numField('Depth', P.depth, set('depth'), { min: 0.1 }));
      rows.push(numField('Angle', P.angle, set('angle'), { unit: '°', help: 'degrees' }));
      break;
    case 'text': {
      const ti = h('input', { type: 'text', value: P.text, 'aria-label': 'Text' });
      ti.addEventListener('input', () => { P.text = ti.value; upd(); });
      rows.push(h('label', { class: 'field col' }, h('span', { class: 'flabel' }, 'Text (A–Z, 0–9, basic symbols)'), ti));
      rows.push(choice('Style', [['emboss', 'Emboss (raised)'], ['deboss', 'Deboss (engraved)']], P.mode, (v) => { P.mode = v; upd(); }));
      rows.push(numField('Letter height', P.size, set('size'), { min: 1 }), numField(P.mode === 'emboss' ? 'Raise by' : 'Depth', P.depth, set('depth'), { min: 0.1 }), numField('Angle', P.angle, set('angle'), { unit: '°', help: 'degrees' }));
      break;
    }
    case 'bracket':
      rows.push(h('p', { class: 'note' }, 'An L shape: one leg lies on the face, the other stands up.'));
      rows.push(numField('Leg on face', P.legA, set('legA'), { min: 1 }), numField('Upright leg', P.legB, set('legB'), { min: 1 }), numField('Width', P.width, set('width'), { min: 1 }), numField('Thickness', P.thick, set('thick'), { min: 0.4 }), numField('Hole diameter', P.holeD, set('holeD'), { min: 0, help: '0 = no holes' }), numField('Angle', P.angle, set('angle'), { unit: '°', help: 'degrees' }));
      break;
    case 'tab':
      rows.push(h('p', { class: 'note' }, 'Best on a side face. It starts flush with the bottom of the face so it can lie on the print bed.'));
      rows.push(numField('Sticks out by', P.length, set('length'), { min: 1 }), numField('Width', P.width, set('width'), { min: 1 }), numField('Thickness', P.thick, set('thick'), { min: 0.4 }), numField('Hole diameter', P.holeD, set('holeD'), { min: 0, help: '0 = no hole' }));
      break;
    case 'rib':
      rows.push(h('p', { class: 'note' }, 'A triangle brace standing on the face. Move it against a wall to stiffen the corner.'));
      rows.push(numField('Length', P.length, set('length'), { min: 0.5 }), numField('Height', P.height, set('height'), { min: 0.5 }), numField('Thickness', P.thick, set('thick'), { min: 0.4 }), numField('Angle', P.angle, set('angle'), { unit: '°', help: 'degrees' }));
      break;
    case 'standoff':
      rows.push(numField('Outer diameter', P.outerD, set('outerD'), { min: 1 }), numField('Height', P.height, set('height'), { min: 0.5 }), numField('Hole diameter', P.holeD, set('holeD'), { min: 0, help: '0 = solid; ~2.5 mm suits an M3 self-tapping screw (verify)' }), numField('Hole depth', P.holeDepth, set('holeDepth'), { min: 0.5 }));
      break;
    default: break;
  }
  const place = F.place;
  const placeRows = place ? [
    h('p', { class: 'sub' }, 'Position on the face (tap the face again to move it)'),
    h('div', { class: 'grid2' },
      numField('From left edge', place.U, (v) => { place.U = v; upd(); }, {}),
      numField('From bottom edge', place.V, (v) => { place.V = v; upd(); }, {})),
    btn('Centre on face', () => { place.U = place.b.w / 2; place.V = place.b.h / 2; renderFeatureSheet(); upd(); }),
  ] : [h('p', { class: 'info strong' }, '👆 Tap a flat face on the model to place it.')];
  const pat = F.pattern;
  const patRows = [
    h('p', { class: 'sub' }, 'Pattern (repeat copies)'),
    choice(null, [['none', 'Single'], ['linear', 'Row'], ['circular', 'Circle']], pat.type, (v) => { pat.type = v; renderFeatureSheet(); upd(); }),
  ];
  if (pat.type === 'linear') patRows.push(numField('Count', pat.count, (v) => { pat.count = v; upd(); }, { min: 2, max: 50, int: true, unit: '×', digits: 0 }), numField('Spacing', pat.spacing, (v) => { pat.spacing = v; upd(); }, {}), choice('Direction', [['u', 'Across →'], ['v', 'Up ↑']], pat.dir, (v) => { pat.dir = v; upd(); }));
  if (pat.type === 'circular') patRows.push(h('p', { class: 'note' }, 'Copies turn around the centre of the face.'), numField('Count', pat.count, (v) => { pat.count = v; upd(); }, { min: 2, max: 72, int: true, unit: '×', digits: 0 }), numField('Total angle', pat.angle, (v) => { pat.angle = v; upd(); }, { min: 1, max: 360, unit: '°' }));
  const turn = 'angle' in P ? h('div', { class: 'grid2' },
    btn('⟲ Turn 90°', () => { P.angle = ((P.angle || 0) + 90) % 360; renderFeatureSheet(); upd(); }),
    btn('⟳ Turn −90°', () => { P.angle = ((P.angle || 0) + 270) % 360; renderFeatureSheet(); upd(); })) : null;
  showSheet(def.name, [
    h('p', { class: 'info' }, def.desc + '. Red preview = material removed, green = material added. Drag with one finger to turn the view and check it from all sides.'),
    turn,
    ...rows, ...placeRows, ...patRows,
    h('div', { class: 'row end' }, btn('Cancel', () => cancelModes()), btn('Apply', applyFeature, 'primary')),
  ], { onClose: () => cancelModes() });
}
function applyFeature() {
  const F = S.feature;
  if (!F.place) { toast('Tap a face to place it first.'); return; }
  busy('Applying ' + TOOLS[F.type].name.toLowerCase() + '…', () => {
    const { M } = featureFrame();
    const t = featureWorld(F.type, featureParams(), M, featurePattern(), sceneSize() * 2 + 10);
    try {
      const m = applySolid(S.model, t.solid, t.op);
      const label = TOOLS[F.type].name + (F.pattern.type !== 'none' ? ` ×${F.pattern.count}` : '');
      cancelModes();
      commit(label, m);
      toast(label + ' done. ' + checkMsg());
    } finally { freeSolid(t.solid); }
  });
}

// ---------- basic shapes with gizmo ----------
function startShape(type, sel) {
  cancelModes(true);
  const def = SHAPES[type];
  S.mode = 'shape';
  const size = { ...def.size };
  const obj = new THREE.Mesh(new THREE.BufferGeometry(), new THREE.MeshStandardMaterial({ color: 0x3ddc97, transparent: true, opacity: 0.55, depthWrite: false }));
  obj.renderOrder = 7;
  S.shape = { type, size, obj, gizmo: 'translate' };
  rebuildShapeGeom();
  // place: on the tapped face, or in the middle of the bed
  if (sel && sel.kind === 'face' && sel.point && S.model) {
    const f = ensureFaces().faces[sel.id];
    const n = new THREE.Vector3(...f.normal);
    obj.position.copy(sel.point).addScaledVector(n, size.z / 2 - 0.01);
  } else if (S.model && S.model.tri.length) {
    const b = bbox(S.model);
    obj.position.set(b.center[0], b.center[1], b.max[2] + size.z / 2 - 0.01);
  } else obj.position.set(0, 0, size.z / 2);
  scene.add(obj);
  if (!S.model || !S.model.tri.length) { obj.updateMatrixWorld(); fitView(new THREE.Vector3(0.6, -0.8, 0.6), new THREE.Box3().setFromObject(obj).expandByScalar(size.x * 0.6)); }
  tc.attach(obj);
  tc.setMode('translate');
  applySnapToGizmo();
  clearSelection();
  renderShapeSheet();
  requestRender();
}
function rebuildShapeGeom() {
  const sh = S.shape;
  try {
    const solid = shapeWorld(sh.type, sh.size, new THREE.Matrix4().elements);
    const g = meshFromModel(toolMesh(solid));
    freeSolid(solid);
    sh.obj.geometry.dispose();
    sh.obj.geometry = g;
  } catch (e) { toast(e.message, 'error'); }
  requestRender();
}
function shapeTap(x, y) {
  const hit = pickModel(x, y);
  if (!hit || !S.shape) return;
  const f = ensureFaces().faces[ensureFaces().faceOf[hit.faceIndex]];
  const sh = S.shape;
  sh.obj.position.copy(hit.point).addScaledVector(new THREE.Vector3(...f.normal), sh.size.z * sh.obj.scale.z / 2 - 0.01);
  onShapeMoved();
  requestRender();
}
let shapeFields = null;
function onShapeMoved() {
  if (!S.shape || !shapeFields) return;
  const o = S.shape.obj, s = S.shape.size;
  shapeFields.x.setValue(s.x * o.scale.x); shapeFields.y.setValue(s.y * o.scale.y); shapeFields.z.setValue(s.z * o.scale.z);
  shapeFields.px.setValue(o.position.x); shapeFields.py.setValue(o.position.y); shapeFields.pz.setValue(o.position.z);
  shapeFields.rx.setValue(THREE.MathUtils.radToDeg(o.rotation.x)); shapeFields.ry.setValue(THREE.MathUtils.radToDeg(o.rotation.y)); shapeFields.rz.setValue(THREE.MathUtils.radToDeg(o.rotation.z));
  clearLabels((l) => l.el.classList.contains('shapeLabel'));
  addLabel(`${fmt(s.x * o.scale.x)} × ${fmt(s.y * o.scale.y)} × ${fmt(s.z * o.scale.z)} mm`, o.position, 'shapeLabel');
}
function renderShapeSheet() {
  const sh = S.shape, o = sh.obj, def = SHAPES[sh.type];
  const hasModel = S.model && S.model.tri.length;
  const setSize = (axis) => (v) => { o.scale[axis] = v / sh.size[axis]; if (sh.type === 'sphere') { o.scale.set(o.scale[axis], o.scale[axis], o.scale[axis]); } onShapeMoved(); requestRender(); };
  const setPos = (axis) => (v) => { o.position[axis] = v; onShapeMoved(); requestRender(); };
  const setRot = (axis) => (v) => { o.rotation[axis] = THREE.MathUtils.degToRad(v); onShapeMoved(); requestRender(); };
  shapeFields = {
    x: numField(sh.type === 'box' ? 'Width (X)' : 'Diameter X', sh.size.x * o.scale.x, setSize('x'), { min: 0.1 }),
    y: numField(sh.type === 'box' ? 'Depth (Y)' : 'Diameter Y', sh.size.y * o.scale.y, setSize('y'), { min: 0.1 }),
    z: numField('Height (Z)', sh.size.z * o.scale.z, setSize('z'), { min: 0.1 }),
    px: numField('X', o.position.x, setPos('x')), py: numField('Y', o.position.y, setPos('y')), pz: numField('Z', o.position.z, setPos('z')),
    rx: numField('Turn X', 0, setRot('x'), { unit: '°' }), ry: numField('Turn Y', 0, setRot('y'), { unit: '°' }), rz: numField('Turn Z', 0, setRot('z'), { unit: '°' }),
  };
  const gizmo = choice('Drag handles to', [['translate', 'Move'], ['rotate', 'Rotate'], ['scale', 'Resize']], sh.gizmo, (v) => { sh.gizmo = v; tc.setMode(v); requestRender(); });
  const sizeRows = sh.type === 'sphere' ? [shapeFields.x] : [shapeFields.x, shapeFields.y, shapeFields.z];
  const extra = [];
  if (sh.type === 'cone') extra.push(numField('Top diameter', sh.size.top, (v) => { sh.size.top = v; rebuildShapeGeom(); }, { min: 0, help: '0 = pointed' }));
  showSheet(def.name, [
    h('p', { class: 'info' }, hasModel ? 'Drag the coloured handles, or type sizes. Tap the model to move the shape onto a face. Then choose Add or Cut.' : 'Set the size, then tap Create. You can keep editing after.'),
    gizmo,
    h('p', { class: 'sub' }, 'Size'), h('div', { class: 'grid2' }, ...sizeRows, ...extra),
    h('p', { class: 'sub' }, 'Centre position'), h('div', { class: 'grid3' }, shapeFields.px, shapeFields.py, shapeFields.pz),
    btn('Sit on bed', () => { const b = new THREE.Box3().setFromObject(o); o.position.z -= b.min.z; onShapeMoved(); requestRender(); }),
    h('p', { class: 'sub' }, 'Rotation (degrees)'), h('div', { class: 'grid3' }, shapeFields.rx, shapeFields.ry, shapeFields.rz),
    h('div', { class: 'row end' }, btn('Cancel', () => cancelModes()),
      hasModel ? btn('Cut from model', () => applyShape('cut'), 'danger') : null,
      btn(hasModel ? 'Add to model' : 'Create', () => applyShape('add'), 'primary')),
  ], { onClose: () => cancelModes() });
  onShapeMoved();
}
function applyShape(op) {
  const sh = S.shape;
  busy(op === 'add' ? 'Adding…' : 'Cutting…', () => {
    sh.obj.updateMatrixWorld();
    const solid = shapeWorld(sh.type, sh.size, sh.obj.matrixWorld.elements);
    try {
      const m = applySolid(S.model, solid, op);
      const label = `${op === 'add' ? 'Add' : 'Cut'} ${SHAPES[sh.type].name.toLowerCase()}`;
      const first = !S.model || !S.model.tri.length;
      cancelModes();
      if (first) S.name = SHAPES[sh.type].name.toLowerCase();
      commit(label, m);
      if (first) fitView();
      toast(label + ' done. ' + checkMsg());
    } finally { freeSolid(solid); }
  });
}
function applySnapToGizmo() {
  tc.setTranslationSnap(S.snap || null);
  tc.setRotationSnap(S.snap ? THREE.MathUtils.degToRad(15) : null);
  tc.setScaleSnap(null);
}

// ---------- modes ----------
function cancelModes(keepSheet) {
  if (S.shape) { tc.detach(); scene.remove(S.shape.obj); S.shape.obj.geometry.dispose(); S.shape = null; shapeFields = null; }
  clearLabels((l) => l.el.classList.contains('shapeLabel'));
  S.feature = null; S.plane = null;
  if (S.mode === 'measure') clearMeasure();
  S.mode = 'select';
  clearPreview();
  clearSelection();
  hint('');
  setToolbarActive(null);
  if (!keepSheet) closeSheet();
}

// ---------- measure ----------
function clearMeasure() {
  measureGroup.clear();
  clearLabels((l) => l.el.classList.contains('measLabel'));
  S.measure = null;
}
function startMeasure() {
  cancelModes(true);
  S.mode = 'measure';
  S.measure = { pts: [] };
  setToolbarActive('tbMeasure');
  hint('Tap two points on the model to measure the distance');
  showSheet('Measure', [h('p', { class: 'info' }, 'Tap a first point, then a second point. Points snap to nearby corners. Tap again to start a new measurement.'), h('div', { id: 'measOut', class: 'measout' }, '—')], { onClose: () => cancelModes() });
}
function measureTap(x, y) {
  const hit = pickModel(x, y);
  if (!hit) return;
  let p = hit.point.clone();
  // snap to a triangle corner within 14 px
  const arr = modelMesh.geometry.attributes.position.array;
  const t = hit.faceIndex * 9;
  for (let k = 0; k < 3; k++) {
    const c = new THREE.Vector3(arr[t + k * 3], arr[t + k * 3 + 1], arr[t + k * 3 + 2]);
    const s = toScreen(c);
    if (Math.hypot(s.x - x, s.y - y) < 14) { p = c; break; }
  }
  const M = S.measure;
  if (M.pts.length >= 2) { clearMeasure(); S.measure = { pts: [] }; }
  S.measure.pts.push(p);
  measureGroup.add(dot(p, 0xffb020));
  if (S.measure.pts.length === 2) {
    const [a, b] = S.measure.pts;
    const g = new THREE.BufferGeometry().setFromPoints([a, b]);
    const line = new THREE.Line(g, new THREE.LineBasicMaterial({ color: 0xffb020, depthTest: false }));
    line.renderOrder = 9;
    measureGroup.add(line);
    const d = a.distanceTo(b);
    addLabel(fmt(d, 2) + ' mm', a.clone().add(b).multiplyScalar(0.5), 'measLabel');
    const out = $('measOut');
    if (out) out.innerHTML = `<b>${fmt(d, 2)} mm</b><br>X ${fmt(Math.abs(b.x - a.x), 2)} · Y ${fmt(Math.abs(b.y - a.y), 2)} · Z ${fmt(Math.abs(b.z - a.z), 2)} mm`;
  } else {
    const out = $('measOut');
    if (out) out.textContent = 'Now tap the second point';
  }
  requestRender();
}

// ---------- arrange (move / rotate / scale / mirror / cut / drop) ----------
function modelCenterBottom() { const b = bbox(S.model); return [b.center[0], b.center[1], b.min[2]]; }
function dropToBed(m) { const b = bbox(m); return transformModel(m, new THREE.Matrix4().makeTranslation(0, 0, -b.min[2]).elements); }
function needModel() { if (!S.model || !S.model.tri.length) { toast('Open an STL or create a shape first.'); return false; } return true; }
function doTransform(label, mat, drop = true) {
  if (!needModel()) return;
  let m = transformModel(S.model, mat.elements);
  if (drop) m = dropToBed(m);
  commit(label, m);
}
function rotateBy(axis, deg) {
  const c = bbox(S.model).center;
  const r = new THREE.Matrix4().makeRotationAxis(new THREE.Vector3(axis === 'x' ? 1 : 0, axis === 'y' ? 1 : 0, axis === 'z' ? 1 : 0), THREE.MathUtils.degToRad(deg));
  const m = new THREE.Matrix4().makeTranslation(c[0], c[1], c[2]).multiply(r).multiply(new THREE.Matrix4().makeTranslation(-c[0], -c[1], -c[2]));
  doTransform(`Rotate ${axis.toUpperCase()} ${fmt(deg, 0)}°`, m);
}
function layFlat(fid) {
  const f = ensureFaces().faces[fid];
  const q = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(...f.normal), new THREE.Vector3(0, 0, -1));
  let m = transformModel(S.model, new THREE.Matrix4().makeRotationFromQuaternion(q).elements);
  const b = bbox(m);
  m = transformModel(m, new THREE.Matrix4().makeTranslation(-b.center[0], -b.center[1], -b.min[2]).elements);
  commit('Lay face on bed', m);
  fitView();
  toast('Face is now flat on the bed.');
}
function doMirror(normal, offset, copy, label) {
  if (!needModel()) return;
  busy('Mirroring…', () => { const m = mirrorModel(S.model, normal, offset, copy); commit(label, copy ? m : dropToBed(m)); closeSheet(); toast(label + ' done. ' + checkMsg()); });
}
function showArrange() {
  if (!needModel()) return;
  cancelModes(true);
  setToolbarActive('tbArrange');
  const mv = { x: 0, y: 0, z: 0 };
  const rot = { x: 0, y: 0, z: 0 };
  let pct = 100;
  const b = bbox(S.model);
  const tgt = { x: b.size[0], y: b.size[1], z: b.size[2] };
  let keepProp = true;
  const sizeFields = {};
  const setT = (axis) => (v) => {
    if (keepProp) {
      const k = v / b.size['xyz'.indexOf(axis)];
      for (const a of 'xyz') { tgt[a] = b.size['xyz'.indexOf(a)] * k; if (a !== axis) sizeFields[a].setValue(tgt[a]); }
    } else tgt[axis] = v;
  };
  for (const a of 'xyz') sizeFields[a] = numField(a.toUpperCase(), tgt[a], setT(a), { min: 0.01 });
  showSheet('Arrange', [
    h('p', { class: 'sub' }, 'Place'),
    h('div', { class: 'grid2' },
      btn('Drop to bed', () => doTransform('Drop to bed', new THREE.Matrix4(), true)),
      btn('Centre on bed', () => { const c = bbox(S.model).center; doTransform('Centre on bed', new THREE.Matrix4().makeTranslation(-c[0], -c[1], 0), true); })),
    h('p', { class: 'sub' }, 'Move by'),
    h('div', { class: 'grid3' }, numField('X', 0, (v) => { mv.x = v; }), numField('Y', 0, (v) => { mv.y = v; }), numField('Z', 0, (v) => { mv.z = v; })),
    btn('Move', () => doTransform(`Move ${fmt(mv.x)}, ${fmt(mv.y)}, ${fmt(mv.z)} mm`, new THREE.Matrix4().makeTranslation(mv.x, mv.y, mv.z), false)),
    h('p', { class: 'sub' }, 'Rotate (model stays on the bed)'),
    h('div', { class: 'grid3' }, btn('X +90°', () => rotateBy('x', 90)), btn('Y +90°', () => rotateBy('y', 90)), btn('Z +90°', () => rotateBy('z', 90))),
    h('div', { class: 'grid3' }, numField('X', 0, (v) => { rot.x = v; }, { unit: '°' }), numField('Y', 0, (v) => { rot.y = v; }, { unit: '°' }), numField('Z', 0, (v) => { rot.z = v; }, { unit: '°' })),
    btn('Rotate by these angles', () => { for (const a of 'xyz') if (rot[a]) rotateBy(a, rot[a]); }),
    h('p', { class: 'sub' }, 'Scale'),
    h('div', { class: 'row' }, numField('Scale', pct, (v) => { pct = v; }, { unit: '%', min: 0.1 }), btn('Apply', () => { const k = pct / 100; const c = modelCenterBottom(); doTransform(`Scale ${fmt(pct, 0)}%`, new THREE.Matrix4().makeTranslation(...c).multiply(new THREE.Matrix4().makeScale(k, k, k)).multiply(new THREE.Matrix4().makeTranslation(-c[0], -c[1], -c[2]))); })),
    h('p', { class: 'note' }, 'Or set an exact overall size:'),
    toggle('Keep proportions', keepProp, (v) => { keepProp = v; }),
    h('div', { class: 'grid3' }, sizeFields.x, sizeFields.y, sizeFields.z),
    btn('Set size', () => { const c = modelCenterBottom(); doTransform('Set size', new THREE.Matrix4().makeTranslation(...c).multiply(new THREE.Matrix4().makeScale(tgt.x / b.size[0] || 1, tgt.y / b.size[1] || 1, tgt.z / b.size[2] || 1)).multiply(new THREE.Matrix4().makeTranslation(-c[0], -c[1], -c[2]))); }),
    h('p', { class: 'sub' }, 'Mirror (flip)'),
    h('div', { class: 'grid3' }, ...['x', 'y', 'z'].map((a) => btn('Flip ' + a.toUpperCase(), () => { const n = [a === 'x' ? 1 : 0, a === 'y' ? 1 : 0, a === 'z' ? 1 : 0]; const c = bbox(S.model).center; doMirror(n, c['xyz'.indexOf(a)], false, 'Flip ' + a.toUpperCase()); }))),
    h('div', { class: 'grid3' }, ...['x', 'y', 'z'].map((a) => btn('Copy +' + a.toUpperCase(), () => { const n = [a === 'x' ? 1 : 0, a === 'y' ? 1 : 0, a === 'z' ? 1 : 0]; const mx = bbox(S.model).max; doMirror(n, mx['xyz'.indexOf(a)], true, 'Mirror copy +' + a.toUpperCase()); }))),
    h('p', { class: 'note' }, 'Copy = adds a mirrored copy joined on the + side. To mirror across any face, select the face first.'),
    h('p', { class: 'sub' }, 'Cut'),
    btn('Cut with a plane…', () => startPlaneCut()),
    h('p', { class: 'sub' }, 'Clean up'),
    h('div', { class: 'grid2' }, btn('Repair gaps', doRepair), btn('Simplify (fewer triangles)', doSimplify)),
  ], { onClose: () => cancelModes() });
}
function doRepair() {
  if (!needModel()) return;
  busy('Repairing…', () => {
    const before = S.check;
    const m = repair(S.model);
    const c = checkWatertight(m);
    commit('Repair', m, { warnCheck: false });
    if (c.ok) toast('Repaired: the model is now watertight ✓');
    else toast(`Partly repaired: gaps went from ${before.open + before.nonManifold + before.flipped} to ${c.open + c.nonManifold + c.flipped}. Some holes in the surface can't be closed automatically here.`, 'error');
  });
}
function doSimplify() {
  if (!needModel()) return;
  busy('Simplifying…', () => {
    const before = S.model.tri.length / 3;
    const tol = Math.max(0.01, sceneSize() * 0.0005);
    const m = simplifyModel(S.model, tol);
    const after = m.tri.length / 3;
    commit('Simplify', m);
    toast(`Triangles: ${before.toLocaleString()} → ${after.toLocaleString()} (shape kept within ${fmt(tol, 2)} mm).`);
  });
}

// plane cut mode
function startPlaneCut(fromFace) {
  if (!needModel()) return;
  cancelModes(true);
  S.mode = 'planecut';
  const b = bbox(S.model);
  const P = S.plane = { axis: 'z', pos: snapVal(b.center[2]), keep: 'below', custom: fromFace || null };
  const draw = () => {
    clearPreview();
    const n = P.custom ? new THREE.Vector3(...P.custom.normal) : new THREE.Vector3(P.axis === 'x' ? 1 : 0, P.axis === 'y' ? 1 : 0, P.axis === 'z' ? 1 : 0);
    const off = P.custom ? P.custom.offset : P.pos;
    const size = sceneSize() * 1.3;
    const g = new THREE.PlaneGeometry(size, size);
    const m = new THREE.Mesh(g, new THREE.MeshBasicMaterial({ color: 0xffb020, transparent: true, opacity: 0.3, side: THREE.DoubleSide, depthWrite: false }));
    m.quaternion.setFromUnitVectors(new THREE.Vector3(0, 0, 1), n);
    const c = new THREE.Vector3(...b.center);
    m.position.copy(c).addScaledVector(n, off - c.dot(n));
    m.renderOrder = 8;
    previewGroup.add(m);
    const edges = new THREE.LineSegments(new THREE.EdgesGeometry(g), new THREE.LineBasicMaterial({ color: 0xffb020 }));
    edges.quaternion.copy(m.quaternion); edges.position.copy(m.position);
    previewGroup.add(edges);
    requestRender();
  };
  const rows = [];
  if (!P.custom) {
    const posField = numField('Position', P.pos, (v) => { P.pos = v; draw(); });
    const range = h('input', { type: 'range', min: 0, max: 1000, value: 500, 'aria-label': 'Plane position' });
    const setRange = () => { const i = 'xyz'.indexOf(P.axis); range.value = String(((P.pos - b.min[i]) / (b.size[i] || 1)) * 1000); };
    range.addEventListener('input', () => { const i = 'xyz'.indexOf(P.axis); P.pos = snapVal(b.min[i] + b.size[i] * (+range.value / 1000)); posField.setValue(P.pos); draw(); });
    rows.push(choice('Cut across axis', [['x', 'X'], ['y', 'Y'], ['z', 'Z (height)']], P.axis, (v) => { P.axis = v; const i = 'xyz'.indexOf(v); P.pos = snapVal(b.center[i]); posField.setValue(P.pos); setRange(); draw(); }), posField, range);
    setRange();
  } else rows.push(h('p', { class: 'info' }, 'Cutting along the plane of the selected face.'));
  rows.push(choice('Keep', [['below', P.custom ? 'Behind face' : 'Lower / − side'], ['above', P.custom ? 'In front' : 'Upper / + side'], ['both', 'Both (split apart)']], P.keep, (v) => { P.keep = v; }));
  showSheet('Cut with a plane', [
    h('p', { class: 'info' }, 'The orange plane shows where the model will be sliced.'),
    ...rows,
    h('div', { class: 'row end' }, btn('Cancel', () => cancelModes()), btn('Cut', () => {
      const n = P.custom ? P.custom.normal : [P.axis === 'x' ? 1 : 0, P.axis === 'y' ? 1 : 0, P.axis === 'z' ? 1 : 0];
      const off = P.custom ? P.custom.offset : P.pos;
      busy('Cutting…', () => {
        let m = planeCut(S.model, n, off, P.keep, 10);
        m = dropToBed(m);
        cancelModes();
        commit('Plane cut', m);
        toast('Cut done. ' + checkMsg() + (P.keep === 'both' ? ' The parts were moved 10 mm apart.' : ''));
      });
    }, 'primary')),
  ], { onClose: () => cancelModes() });
  draw();
}

// ---------- files ----------
let fileMode = 'stl';
function pickFile(mode) {
  fileMode = mode;
  const inp = $('fileInput');
  inp.value = '';
  inp.click();
}
$('fileInput').addEventListener('change', async (e) => {
  const file = e.target.files[0];
  if (!file) return;
  const buf = await file.arrayBuffer();
  const head = new TextDecoder().decode(new Uint8Array(buf, 0, Math.min(20, buf.byteLength))).trim();
  if (head.startsWith('{')) { openProject(buf, file.name); return; }
  if (fileMode === 'project') toast('That is not a Pocket CAD project file, trying it as STL…');
  busy('Reading STL…', () => {
    const soup = parseSTL(buf);
    let m = weld(soup);
    if (!m.tri.length) throw new Error('No triangles found in this file.');
    // centre on the bed and sit on it
    const b = bbox(m);
    m = transformModel(m, new THREE.Matrix4().makeTranslation(-b.center[0], -b.center[1], -b.min[2]).elements);
    cancelModes();
    S.name = file.name.replace(/\.stl$/i, '');
    S.history = []; S.hIndex = -1;
    commit('Open ' + file.name, m, { warnCheck: false });
    fitView(new THREE.Vector3(0.6, -0.8, 0.6));
    const sz = bbox(m).size;
    const msgs = [`Loaded ${(m.tri.length / 3).toLocaleString()} triangles, ${fmt(sz[0])} × ${fmt(sz[1])} × ${fmt(sz[2])} mm. Centred on the bed.`];
    if (sz.some((x) => x > BED)) msgs.push('⚠ It is bigger than the 180 × 180 × 180 mm bed of the A1 mini. Use Arrange → Scale, or cut it into parts.');
    if (!S.check.ok) msgs.push(`⚠ The model is not watertight (${S.check.open} open edges, ${S.check.nonManifold} shared by too many triangles, ${S.check.flipped} flipped). Push/pull will work, but cutting and adding need a watertight model — try Arrange → Repair gaps.`);
    if (m.tri.length / 3 > BIG_MESH) {
      openModal('Very detailed model', h('p', null, `This model has ${(m.tri.length / 3).toLocaleString()} triangles (the tiny flat pieces a 3D surface is made of). Editing may be slow on a phone. Simplify merges flat areas to make it lighter; it may not reduce much on curved, organic shapes.`), [{ label: 'Keep as is' }, { label: 'Simplify', primary: true, onClick: doSimplify }]);
    }
    if (sz.some((x) => x < 1) || sz.every((x) => x < 5)) msgs.push('The model is very small. Some STL files are saved in inches or metres; use Arrange → Scale if it looks wrong (inches → 2540%).');
    if (msgs.length > 1) openModal('Model loaded', h('div', null, msgs.map((t) => h('p', null, t))));
    else toast(msgs[0]);
  });
});

function download(data, filename, type) {
  const blob = data instanceof Blob ? data : new Blob([data], { type });
  const url = URL.createObjectURL(blob);
  const a = h('a', { href: url, download: filename });
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 60000);
}
async function share(data, filename, type) {
  const file = new File([data], filename, { type });
  if (navigator.canShare && navigator.canShare({ files: [file] })) {
    try { await navigator.share({ files: [file], title: filename }); } catch (e) { if (e.name !== 'AbortError') toast('Share failed: ' + e.message, 'error'); }
  } else download(data, filename, type);
}
const b64 = {
  enc(u8) { let s = ''; for (let i = 0; i < u8.length; i += 0x8000) s += String.fromCharCode.apply(null, u8.subarray(i, i + 0x8000)); return btoa(s); },
  dec(str) { const s = atob(str); const u = new Uint8Array(s.length); for (let i = 0; i < s.length; i++) u[i] = s.charCodeAt(i); return u; },
};
function projectJSON() {
  return JSON.stringify({ app: 'PocketCAD', version: 1, name: S.name, saved: new Date().toISOString(), pos: b64.enc(new Uint8Array(S.model.pos.buffer, S.model.pos.byteOffset, S.model.pos.byteLength)), tri: b64.enc(new Uint8Array(S.model.tri.buffer, S.model.tri.byteOffset, S.model.tri.byteLength)) });
}
function openProject(buf, fname) {
  busy('Opening project…', () => {
    const j = JSON.parse(new TextDecoder().decode(buf));
    if (j.app !== 'PocketCAD') throw new Error('Not a Pocket CAD project file.');
    const m = { pos: new Float32Array(b64.dec(j.pos).buffer), tri: new Uint32Array(b64.dec(j.tri).buffer) };
    cancelModes();
    S.name = j.name || fname;
    S.history = []; S.hIndex = -1;
    commit('Open project', m);
    fitView();
    toast('Project opened.');
  });
}
function showExport() {
  if (!needModel()) return;
  cancelModes(true);
  setToolbarActive('tbExport');
  const b = bbox(S.model);
  const too = b.size.some((x) => x > BED);
  const nameIn = h('input', { type: 'text', value: S.name, 'aria-label': 'File name' });
  const fname = (ext) => (nameIn.value.trim() || 'model').replace(/[\\/:*?"<>|]/g, '_') + '.' + ext;
  const stl = () => exportSTL(S.model, S.name);
  const mf = () => export3MF(S.model, S.name);
  const canShare = !!(navigator.canShare && navigator.share);
  showSheet('Export for printing', [
    h('p', { class: S.check.ok ? 'info good' : 'info bad' }, S.check.ok ? '✓ Watertight — ready for the slicer (the app that prepares the print).' : '⚠ Not watertight. Bambu Studio may still repair it, but check the result.'),
    h('p', { class: too ? 'info bad' : 'info' }, `Size ${fmt(b.size[0])} × ${fmt(b.size[1])} × ${fmt(b.size[2])} mm` + (too ? ' — bigger than the 180 mm A1 mini bed!' : ' — fits the A1 mini bed.')),
    h('label', { class: 'field col' }, h('span', { class: 'flabel' }, 'File name'), nameIn),
    h('div', { class: 'grid2' },
      btn('Download STL', () => { S.name = nameIn.value.trim() || S.name; download(stl(), fname('stl'), 'model/stl'); }, 'primary'),
      btn('Download 3MF', () => { S.name = nameIn.value.trim() || S.name; download(mf(), fname('3mf'), 'model/3mf'); })),
    canShare ? h('div', { class: 'grid2' },
      btn('Share STL…', () => share(stl(), fname('stl'), 'model/stl')),
      btn('Share 3MF…', () => share(mf(), fname('3mf'), 'model/3mf'))) : null,
    h('p', { class: 'note' }, 'STL = the classic 3D print file. 3MF (3D Manufacturing Format) = newer format that Bambu Studio prefers; it keeps units in mm. Share lets you send it straight to Bambu Handy, Files, or AirDrop if your phone supports it.'),
    h('p', { class: 'sub' }, 'Project'),
    h('div', { class: 'grid2' },
      btn('Save project file', () => download(projectJSON(), fname('pocketcad.json'), 'application/json')),
      btn('Open project file', () => pickFile('project'))),
  ], { onClose: () => cancelModes() });
}

// ---------- autosave (IndexedDB) ----------
function idb() {
  return new Promise((res, rej) => {
    const r = indexedDB.open('pocketcad', 1);
    r.onupgradeneeded = () => r.result.createObjectStore('kv');
    r.onsuccess = () => res(r.result);
    r.onerror = () => rej(r.error);
  });
}
async function idbSet(k, v) { const db = await idb(); return new Promise((res, rej) => { const tx = db.transaction('kv', 'readwrite'); tx.objectStore('kv').put(v, k); tx.oncomplete = res; tx.onerror = () => rej(tx.error); }); }
async function idbGet(k) { const db = await idb(); return new Promise((res, rej) => { const tx = db.transaction('kv', 'readonly'); const q = tx.objectStore('kv').get(k); q.onsuccess = () => res(q.result); q.onerror = () => rej(q.error); }); }
let saveTimer = 0;
function scheduleAutosave() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(async () => {
    try {
      if (!S.model) await idbSet('autosave', null);
      else await idbSet('autosave', { name: S.name, pos: S.model.pos, tri: S.model.tri, time: Date.now() });
      $('saveDot').classList.add('saved');
      setTimeout(() => $('saveDot').classList.remove('saved'), 1200);
    } catch (e) { console.warn('autosave failed', e); }
  }, 700);
}

// ---------- menus, help ----------
function setToolbarActive(id) { for (const b of document.querySelectorAll('#toolbar button')) b.classList.toggle('active', b.id === id); }
function showMenu() {
  const item = (label, sub, fn) => h('button', { class: 'mitem', type: 'button', onclick: () => { closeDrawer(); fn(); } }, h('b', null, label), sub ? h('small', null, sub) : null);
  const d = $('drawerCard');
  d.innerHTML = '';
  d.append(h('h2', null, 'Pocket CAD'),
    item('Open STL…', 'Load a 3D print file from your phone', () => pickFile('stl')),
    item('New blank scene', 'Start from a basic shape', newScene),
    item('Export / save…', 'STL, 3MF, or a project file', showExport),
    item('Open project file…', 'A .pocketcad.json you saved before', () => pickFile('project')),
    item('History', 'Every step; tap one to go back to it', showHistory),
    item('Check model', 'Watertight test (no gaps)', showCheck),
    item('How to use', 'Short guide and word list', showHelp),
    item('About & licences', null, showAbout));
  $('drawer').classList.remove('hidden');
}
function closeDrawer() { $('drawer').classList.add('hidden'); }
$('drawer').addEventListener('click', (e) => { if (e.target.id === 'drawer') closeDrawer(); });
function newScene() {
  const go = () => { cancelModes(); S.history = []; S.hIndex = -1; S.name = 'model'; commit('New scene', null); fitView(new THREE.Vector3(0.6, -0.8, 0.6)); showToolMenu(false); };
  if (S.model) openModal('Start a new scene?', h('p', null, 'Your current model will be cleared. (Undo history is cleared too — export or save a project first if you want to keep it.)'), [{ label: 'Cancel' }, { label: 'New scene', primary: true, onClick: go }]);
  else go();
}
function showHistory() {
  cancelModes(true);
  const list = h('div', { class: 'hist' }, S.history.map((e, i) => h('button', { class: 'hitem ' + (i === S.hIndex ? 'cur' : i > S.hIndex ? 'future' : ''), type: 'button', onclick: () => { S.hIndex = i; loadState(e.model, { warnCheck: false }); scheduleAutosave(); showHistory(); } }, h('span', null, (i + 1) + '. ' + e.label), h('small', null, new Date(e.time).toLocaleTimeString()))));
  showSheet('History', [h('p', { class: 'note' }, 'Tap a step to jump back to it. Greyed steps are ones you undid (Redo brings them back). Making a new edit removes the greyed steps.' + (S.droppedHistory ? ' The oldest steps were removed to save memory.' : '')), list]);
}
function showCheck() {
  if (!needModel()) return;
  const c = S.check;
  openModal(c.ok ? 'Watertight ✓' : 'Gaps found', h('div', null,
    h('p', null, 'Watertight means the surface is completely closed, like a balloon with no holes. 3D printers and slicers need this to know what is inside and outside.'),
    h('ul', null,
      h('li', null, `Triangles (tiny flat pieces of the surface): ${c.triangles.toLocaleString()}`),
      h('li', null, `Open edges (gaps): ${c.open}`),
      h('li', null, `Edges shared by more than 2 triangles: ${c.nonManifold}`),
      h('li', null, `Flipped triangles (facing the wrong way): ${c.flipped}`),
      h('li', null, `Volume: ${fmt(Math.abs(c.volume) / 1000, 2)} cm³`)),
    c.insideOut ? h('p', null, 'The model is inside-out. Repair fixes this.') : null),
  c.ok ? [{ label: 'Close' }] : [{ label: 'Close' }, { label: 'Try repair', primary: true, onClick: doRepair }]);
}
function showHelp() {
  openModal('How to use Pocket CAD', h('div', { class: 'help' },
    h('h4', null, 'Move the view'),
    h('ul', null, h('li', null, 'One finger drag: orbit (turn around the model)'), h('li', null, 'Two finger pinch: zoom'), h('li', null, 'Two finger drag: pan (slide the view)'), h('li', null, '"Fit" button: show the whole model; "View" cycles 3D / top / front / right')),
    h('h4', null, 'Edit'),
    h('ol', null,
      h('li', null, 'Open an STL (☰ menu or Open button), or start from a basic shape.'),
      h('li', null, 'Tap a flat face to select it (it turns blue). Drag the blue arrow to push or pull it, or type an exact distance.'),
      h('li', null, 'Tap an edge to chamfer (angled cut) or fillet (round) it. Tap a corner to chamfer it.'),
      h('li', null, 'Add/Cut: holes, slots, pockets, text, brackets, tabs, ribs, standoffs, and basic shapes. Tap a face to place, adjust the numbers, then Apply.'),
      h('li', null, 'Arrange: move, rotate, scale, mirror, cut with a plane, drop to the bed.'),
      h('li', null, 'Snap (top left of the view) rounds drags to 0.5, 1 or 5 mm.'),
      h('li', null, 'Undo ↶ / Redo ↷ at the top. History is in the ☰ menu.'),
      h('li', null, 'Export: download an STL or 3MF and open it in Bambu Studio or Bambu Handy.')),
    h('p', null, 'Your work saves automatically in this browser. To keep a copy safe, use Export → Save project file.'),
    h('h4', null, 'Words used'),
    h('dl', null, ...[
      ['STL', 'STereoLithography — the common 3D print file: a list of triangles.'],
      ['3MF', '3D Manufacturing Format — newer print file, preferred by Bambu Studio.'],
      ['CAD', 'Computer-Aided Design — drawing objects on a computer.'],
      ['CSG', 'Constructive Solid Geometry — making shapes by adding and cutting solids.'],
      ['mm', 'Millimetre. 10 mm = 1 cm.'],
      ['Face', 'A flat side of the model.'],
      ['Push / pull', 'Moving a face outward (bigger) or inward (smaller).'],
      ['Chamfer', 'An angled cut that replaces a sharp edge.'],
      ['Fillet', 'A rounded edge.'],
      ['Countersink', 'Cone-shaped recess so a flat-head screw sits flush.'],
      ['Counterbore', 'Flat-bottomed step so a screw head sits below the surface.'],
      ['M3 / M4 / M5', 'Metric screw sizes: 3, 4, 5 mm thread diameter.'],
      ['Emboss / deboss', 'Raised text / engraved text.'],
      ['Gusset / rib', 'A triangle brace that stiffens a corner.'],
      ['Standoff / boss', 'A post that holds a screw, e.g. for a circuit board.'],
      ['Watertight', 'Surface fully closed, no gaps — needed for printing.'],
      ['Snap', 'Rounding moves to a fixed step, e.g. 1 mm.'],
      ['Slicer', 'App that turns the model into printer instructions (Bambu Studio).'],
      ['PWA', 'Progressive Web App — a website you can install to your home screen and use offline.'],
    ].flatMap(([t, d]) => [h('dt', null, t), h('dd', null, d)])),
    h('h4', null, 'Install on your phone'),
    h('p', null, 'iPhone (Safari): Share button → "Add to Home Screen". Android (Chrome): menu ⋮ → "Install app" or "Add to Home screen". After opening it once, it works offline.')));
}
function showAbout() {
  openModal('About & licences', h('div', { class: 'help' },
    h('p', null, 'Pocket CAD — a small touch-first editor for 3D print files. Build volume preset: Bambu Lab A1 mini (180 × 180 × 180 mm).'),
    h('p', null, 'Built with: three.js (MIT licence), Manifold / manifold-3d (Apache 2.0 licence) for watertight cutting and joining, and the Helvetiker Bold typeface (MgOpen Moderna, © 2004 MAGENTA Ltd., free licence) for text.'),
    h('p', null, 'Screw sizes are typical values — always check against your own hardware.')));
}

// ---------- wiring ----------
$('btnMenu').onclick = showMenu;
$('btnUndo').onclick = undo;
$('btnRedo').onclick = redo;
$('badge').onclick = showCheck;
$('fitBtn').onclick = () => fitView();
$('viewBtn').onclick = () => { viewIdx = (viewIdx + 1) % VIEWS.length; $('viewBtn').innerHTML = 'View<br>' + VIEWS[viewIdx][0]; fitView(new THREE.Vector3(...VIEWS[viewIdx][1])); };
$('helpChip').onclick = showHelp;
// show / hide the measurement labels drawn over the 3D view (the push/pull distance always shows)
function setLabelsOn(on) {
  $('labels').classList.toggle('off', !on);
  $('labelsChip').innerHTML = 'Labels<br>' + (on ? 'on' : 'off');
  try { localStorage.setItem('pocketcad.labels', on ? '1' : '0'); } catch (e) { /* storage blocked */ }
}
$('labelsChip').onclick = () => setLabelsOn($('labels').classList.contains('off'));
try { if (localStorage.getItem('pocketcad.labels') === '0') setLabelsOn(false); } catch (e) { /* ignore */ }
const SNAPS = [0, 0.5, 1, 5];
$('snapChip').onclick = () => {
  S.snap = SNAPS[(SNAPS.indexOf(S.snap) + 1) % SNAPS.length];
  $('snapChip').innerHTML = 'Snap<br>' + (S.snap ? S.snap + ' mm' : 'off');
  applySnapToGizmo();
  try { localStorage.setItem('pocketcad.snap', String(S.snap)); } catch (e) { /* storage blocked */ }
};
$('tbOpen').onclick = () => pickFile('stl');
$('tbAdd').onclick = () => { setToolbarActive('tbAdd'); showToolMenu(false); };
$('tbArrange').onclick = showArrange;
$('tbMeasure').onclick = () => (S.mode === 'measure' ? cancelModes() : startMeasure());
$('tbExport').onclick = showExport;
window.addEventListener('keydown', (e) => {
  if (e.target.tagName === 'INPUT') return;
  if ((e.ctrlKey || e.metaKey) && e.key === 'z') { e.preventDefault(); e.shiftKey ? redo() : undo(); }
  if (e.key === 'Escape') cancelModes();
});
// stop iOS double-tap zoom and long-press menus on the 3D view
view.addEventListener('touchstart', (e) => { if (e.touches.length > 1) e.preventDefault(); }, { passive: false });
view.addEventListener('contextmenu', (e) => e.preventDefault());

// expose a small API for automated tests
window.PocketCAD = { Vector3: THREE.Vector3, arrowPos: () => [arrow.position.x, arrow.position.y, arrow.position.z, arrow.scale.x], S, commit, applyPushPull, selectThing, ensureFaces, ensureEdges, startFeature, applyFeature, toScreen, exportSTL, export3MF, checkWatertight, fitView, startShape, applyShape, renderFeatureSheet, updateFeaturePreview, cancelModes };

// ---------- start ----------
async function start() {
  try { const s = parseFloat(localStorage.getItem('pocketcad.snap')); if (SNAPS.includes(s)) { S.snap = s; $('snapChip').innerHTML = 'Snap<br>' + (s ? s + ' mm' : 'off'); } } catch (e) { /* ignore */ }
  resize();
  fitView(new THREE.Vector3(0.6, -0.8, 0.6));
  try {
    const bin = Uint8Array.from(atob(wasmB64), (c) => c.charCodeAt(0));
    await initCSG(bin);
  } catch (e) {
    console.error(e);
    toast('Could not start the geometry engine: ' + e.message, 'error');
  }
  let restored = false;
  try {
    const saved = await idbGet('autosave');
    if (saved && saved.pos && saved.tri && saved.tri.length) {
      S.name = saved.name || 'model';
      commit('Restored last session', { pos: new Float32Array(saved.pos), tri: new Uint32Array(saved.tri) }, { warnCheck: false });
      fitView(new THREE.Vector3(0.6, -0.8, 0.6));
      toast('Restored your last work (' + new Date(saved.time).toLocaleString() + ').');
      restored = true;
    }
  } catch (e) { console.warn('restore failed', e); }
  if (!restored) {
    commit('Start', null);
    let seen = false;
    try { seen = localStorage.getItem('pocketcad.seenHelp') === '1'; localStorage.setItem('pocketcad.seenHelp', '1'); } catch (e) { /* ignore */ }
    if (!seen) showHelp();
  }
  $('splash').classList.add('hidden');
  if ('serviceWorker' in navigator && (location.protocol === 'https:' || location.hostname === 'localhost')) {
    navigator.serviceWorker.register('sw.js').catch((e) => console.warn('service worker', e));
  }
}
start();
void cloneModel;
