// CSG (Constructive Solid Geometry: combining and cutting solids) using the Manifold library (manifold-3d).
// Manifold guarantees watertight output for watertight input.
import Module from 'manifold-3d';

let W = null; // the wasm module
export async function initCSG(wasmBinary) {
  if (W) return W;
  W = await Module({ wasmBinary, locateFile: () => 'manifold.wasm' }); // locateFile avoids a URL lookup; the binary is passed in directly
  W.setup();
  return W;
}
export const csgReady = () => !!W;

// Track temporary WASM objects so we can free them (WASM memory is not garbage collected).
function tracker() {
  const list = [];
  const T = (o) => { list.push(o); return o; };
  T.free = (...keep) => { for (const o of list) if (!keep.includes(o)) { try { o.delete(); } catch (e) { /* already freed */ } } list.length = 0; };
  return T;
}

export function toManifold(model) {
  const { Manifold, Mesh } = W;
  const mesh = new Mesh({ numProp: 3, vertProperties: new Float32Array(model.pos), triVerts: new Uint32Array(model.tri) });
  mesh.merge();
  let man;
  try {
    man = new Manifold(mesh);
  } catch (e) {
    throw new Error('This model has gaps or overlapping surfaces, so it cannot be cut or combined safely. Try Repair first. (' + (e.message || e) + ')');
  }
  const st = man.status();
  if (st !== 'NoError') { man.delete(); throw new Error('Model is not watertight (' + st + '). Try Repair first.'); }
  return man;
}

export function fromManifold(man) {
  const mesh = man.getMesh();
  const np = mesh.numProp;
  const vp = mesh.vertProperties;
  let pos;
  if (np === 3) pos = new Float32Array(vp);
  else {
    const n = vp.length / np;
    pos = new Float32Array(n * 3);
    for (let i = 0; i < n; i++) { pos[i * 3] = vp[i * np]; pos[i * 3 + 1] = vp[i * np + 1]; pos[i * 3 + 2] = vp[i * np + 2]; }
  }
  return { pos, tri: new Uint32Array(mesh.triVerts) };
}

// Column-major 4x4 from a local frame (u, v, n axes and origin p).
export function frameMatrix(u, v, n, p) {
  return [u[0], u[1], u[2], 0, v[0], v[1], v[2], 0, n[0], n[1], n[2], 0, p[0], p[1], p[2], 1];
}

const segsFor = (r) => Math.max(24, Math.min(96, Math.round(r * 2 * Math.PI / 0.6)));

// Cylinder along local Z from z0 to z1 with radius r0 at z0 and r1 at z1.
function cylZ(T, r0, r1, z0, z1) {
  const { Manifold } = W;
  const h = z1 - z0;
  const c = T(Manifold.cylinder(h, r0, r1, segsFor(Math.max(r0, r1)), false));
  return T(c.translate([0, 0, z0]));
}

function stadium(T, length, width) {
  const { CrossSection } = W;
  const r = width / 2, a = Math.max(0, (length - width) / 2);
  const c1 = T(CrossSection.circle(r, segsFor(r)).translate([-a, 0]));
  const c2 = T(CrossSection.circle(r, segsFor(r)).translate([a, 0]));
  return T(CrossSection.hull([c1, c2]));
}

function roundedRect(T, w, h, rad) {
  const { CrossSection } = W;
  rad = Math.max(0, Math.min(rad, w / 2 - 0.01, h / 2 - 0.01));
  if (rad <= 0.01) return T(CrossSection.square([w, h], true));
  const cs = [];
  for (const sx of [-1, 1]) for (const sy of [-1, 1]) cs.push(T(T(CrossSection.circle(rad, segsFor(rad))).translate([sx * (w / 2 - rad), sy * (h / 2 - rad)])));
  return T(CrossSection.hull(cs));
}

function extrudeZ(T, cs, z0, z1) {
  const { Manifold } = W;
  return T(T(Manifold.extrude(cs, z1 - z0)).translate([0, 0, z0]));
}

// ---- Feature builders. Each returns { solid (Manifold, local coords), op: 'cut'|'add' }.
// Local coords: X/Y lie in the face, +Z points out of the face, Z=0 is the face surface.
const EPS_OUT = 0.6; // how far cut tools poke out above the surface so the cut is clean
const EPS_IN = 0.3;  // how far added parts sink into the surface so they fuse

export const SCREWS = {
  // Typical values in mm; verify against your own screws.
  M3: { clear: 3.4, cbD: 6.5, cbDepth: 3.2, cskD: 6.7 },
  M4: { clear: 4.5, cbD: 8.0, cbDepth: 4.2, cskD: 9.0 },
  M5: { clear: 5.5, cbD: 9.5, cbDepth: 5.2, cskD: 11.2 },
};

export function buildFeature(T, type, p, big) {
  const { Manifold, CrossSection } = W;
  const through = big; // depth used for "through"
  switch (type) {
    case 'hole': {
      const depth = p.through ? through : p.depth;
      const r = p.diameter / 2;
      const parts = [cylZ(T, r, r, -depth, EPS_OUT)];
      if (p.head === 'countersink') {
        const R = Math.max(r + 0.1, p.headD / 2);
        const h = R - r; // 90 degree countersink
        parts.push(cylZ(T, r, R, -h, 0), cylZ(T, R, R, 0, EPS_OUT));
      } else if (p.head === 'counterbore') {
        const R = Math.max(r + 0.1, p.headD / 2);
        parts.push(cylZ(T, R, R, -p.headDepth, EPS_OUT));
      }
      return { solid: T(Manifold.union(parts)), op: 'cut' };
    }
    case 'slot': {
      const depth = p.through ? through : p.depth;
      const cs = T(stadium(T, Math.max(p.length, p.width), p.width).rotate(p.angle || 0));
      return { solid: extrudeZ(T, cs, -depth, EPS_OUT), op: 'cut' };
    }
    case 'pocket': {
      const depth = p.through ? through : p.depth;
      const cs = T(roundedRect(T, p.width, p.height, p.radius || 0).rotate(p.angle || 0));
      return { solid: extrudeZ(T, cs, -depth, EPS_OUT), op: 'cut' };
    }
    case 'text': {
      if (!p.polygons || !p.polygons.length) throw new Error('Type some text first.');
      const cs = T(T(new CrossSection(p.polygons, 'EvenOdd')).rotate(p.angle || 0));
      if (p.mode === 'deboss') return { solid: extrudeZ(T, cs, -p.depth, EPS_OUT), op: 'cut' };
      return { solid: extrudeZ(T, cs, -EPS_IN, p.depth), op: 'add' };
    }
    case 'bracket': {
      // L shape: base leg lies on the face along +X, upright leg rises along +Z. Width along Y.
      const { legA, legB, width, thick, holeD } = p;
      let base = T(T(Manifold.cube([legA, width, thick + EPS_IN], false)).translate([0, -width / 2, -EPS_IN]));
      let up = T(T(Manifold.cube([thick, width, legB], false)).translate([0, -width / 2, 0]));
      let solid = T(Manifold.union([base, up]));
      if (holeD > 0) {
        const r = holeD / 2;
        const h1 = T(cylZ(T, r, r, -EPS_IN - 1, thick + 1).translate([thick + (legA - thick) / 2, 0, 0]));
        const h2raw = cylZ(T, r, r, -1, thick + 1); // along Z, rotate to along X
        const h2 = T(T(h2raw.rotate([0, 90, 0])).translate([0, 0, thick + (legB - thick) / 2]));
        solid = T(solid.subtract(T(Manifold.union([h1, h2]))));
      }
      return { solid: T(solid.rotate([0, 0, p.angle || 0])), op: 'add' };
    }
    case 'tab': {
      // Flat tab sticking out of a side face. Built in XY (X = outwards), extruded along Z (thickness), then rotated.
      const { length, width, thick, holeD } = p;
      const r = width / 2;
      const end = Math.max(0, length - r);
      const sq = T(T(CrossSection.square([end + EPS_IN, width], false)).translate([-EPS_IN, -r]));
      const circ = T(T(CrossSection.circle(r, segsFor(r))).translate([end, 0]));
      let cs = T(CrossSection.union(sq, circ));
      if (holeD > 0) cs = T(cs.subtract(T(T(CrossSection.circle(holeD / 2, segsFor(holeD / 2))).translate([end, 0]))));
      const solid = T(Manifold.extrude(cs, thick)); // z in [0, thick]
      // map: tab X -> face normal (local Z), tab Y -> local X, tab Z -> local Y
      const m = [0, 0, 1, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 0, 1];
      return { solid: T(solid.transform(m)), op: 'add', tabMapped: true };
    }
    case 'rib': {
      // Triangle in the XZ plane (X along face, Z out of face), thickness along Y.
      const { length, height, thick } = p;
      const tri = T(new CrossSection([[[-EPS_IN, -EPS_IN], [length, -EPS_IN], [-EPS_IN, height]]], 'Positive'));
      const solid = T(Manifold.extrude(tri, thick)); // XY triangle, z in [0, thick]
      // map: tri X -> X, tri Y -> Z (out), extrude Z -> Y (centered)
      const m = [1, 0, 0, 0, 0, 0, 1, 0, 0, -1, 0, 0, 0, thick / 2, 0, 1];
      return { solid: T(T(solid.transform(m)).rotate([0, 0, p.angle || 0])), op: 'add' };
    }
    case 'standoff': {
      const { outerD, height, holeD, holeDepth } = p;
      const R = outerD / 2;
      let solid = cylZ(T, R, R, -EPS_IN, height);
      if (holeD > 0) {
        const r = holeD / 2;
        solid = T(solid.subtract(cylZ(T, r, r, height - Math.min(holeDepth, height + EPS_IN), height + 1)));
      }
      return { solid, op: 'add' };
    }
    default:
      throw new Error('Unknown tool ' + type);
  }
}

// Basic shapes centred on the origin (sizes in mm).
export function buildShape(T, type, s) {
  const { Manifold } = W;
  switch (type) {
    case 'box': return T(Manifold.cube([s.x, s.y, s.z], true));
    case 'cylinder': return T(Manifold.cylinder(s.z, s.x / 2, s.x / 2, segsFor(s.x / 2), true));
    case 'cone': return T(Manifold.cylinder(s.z, s.x / 2, Math.max(0, s.top / 2), segsFor(s.x / 2), true));
    case 'sphere': return T(Manifold.sphere(s.x / 2, segsFor(s.x / 2)));
    default: throw new Error('Unknown shape ' + type);
  }
}

// Copies for linear / circular patterns, in local coords.
function patterned(T, solid, pat) {
  if (!pat || pat.type === 'none' || !(pat.count > 1)) return solid;
  const { Manifold } = W;
  const copies = [solid];
  for (let i = 1; i < pat.count; i++) {
    if (pat.type === 'linear') {
      const d = pat.spacing * i;
      copies.push(T(solid.translate(pat.dir === 'v' ? [0, d, 0] : [d, 0, 0])));
    } else {
      // rotate about the local Z axis through the pattern centre (cx, cy)
      const ang = (pat.angle || 360) * i / (pat.angle && pat.angle < 360 ? pat.count - 1 : pat.count);
      const moved = T(T(T(solid.translate([-pat.cx, -pat.cy, 0])).rotate([0, 0, ang])).translate([pat.cx, pat.cy, 0]));
      copies.push(moved);
    }
  }
  return T(Manifold.union(copies));
}

// Build the feature tool solid in world space (for previews and for applying).
export function featureWorld(type, params, frameM, pattern, big) {
  const T = tracker();
  try {
    const f = buildFeature(T, type, params, big);
    const pat = patterned(T, f.solid, pattern);
    const world = pat.transform(frameM);
    T.free();
    return { solid: world, op: f.op };
  } catch (e) { T.free(); throw e; }
}

export function shapeWorld(type, size, matrix) {
  const T = tracker();
  try {
    const s = buildShape(T, type, size);
    const w = s.transform(matrix);
    T.free();
    return w;
  } catch (e) { T.free(); throw e; }
}

// Apply a world-space tool solid to the model. op: 'add' | 'cut' | 'intersect'
export function applySolid(model, solid, op) {
  const T = tracker();
  try {
    let result;
    if (!model || model.tri.length === 0) {
      if (op !== 'add') throw new Error('There is nothing to cut yet.');
      result = solid;
    } else {
      const base = T(toManifold(model));
      if (op === 'add') result = T(base.add(solid));
      else if (op === 'cut') result = T(base.subtract(solid));
      else result = T(base.intersect(solid));
    }
    const st = result.status();
    if (st !== 'NoError') throw new Error('Geometry engine error: ' + st);
    const out = fromManifold(result);
    T.free();
    return out;
  } catch (e) { T.free(); throw e; }
}

export function toolMesh(solid) { return fromManifold(solid); }
export function freeSolid(s) { try { s && s.delete(); } catch (e) { /* ignore */ } }

// Plane cut. keep: 'above' | 'below' | 'both'. normal + offset define the plane (dot(n, x) = offset).
export function planeCut(model, normal, offset, keep, gap = 10) {
  const T = tracker();
  try {
    const base = T(toManifold(model));
    let result;
    if (keep === 'above') result = T(base.trimByPlane(normal, offset));
    else if (keep === 'below') result = T(base.trimByPlane(normal.map((x) => -x), -offset));
    else {
      const [a, b] = base.splitByPlane(normal, offset);
      T(a); T(b);
      const a2 = T(a.translate(normal.map((x) => x * gap)));
      result = T(W.Manifold.compose([a2, b]));
    }
    if (result.isEmpty()) throw new Error('Nothing would be left on that side of the plane.');
    const out = fromManifold(result);
    T.free();
    return out;
  } catch (e) { T.free(); throw e; }
}

// Mirror: copy=false flips the model; copy=true adds a mirrored copy (joined). Plane: dot(n, x) = offset
export function mirrorModel(model, normal, offset, copy) {
  const T = tracker();
  try {
    const base = T(toManifold(model));
    const n = normal;
    // mirror about plane through origin, then shift by 2*offset along n
    const m = T(T(base.mirror(n)).translate(n.map((x) => x * 2 * offset)));
    const result = copy ? T(base.add(m)) : m;
    const out = fromManifold(result);
    T.free();
    return out;
  } catch (e) { T.free(); throw e; }
}

export function simplifyModel(model, tol) {
  const T = tracker();
  try {
    const base = T(toManifold(model));
    const out = fromManifold(T(base.simplify(tol)));
    T.free();
    return out;
  } catch (e) { T.free(); throw e; }
}

// Chamfer / fillet a straight edge. e has a, b, t1, t2, n1, n2, convex.
export function edgeTool(e, kind, size) {
  const { Manifold, CrossSection } = W;
  const T = tracker();
  try {
    const t1 = e.t1, t2 = e.t2;
    // 2D frame in the plane perpendicular to the edge: X = t1, Y = part of t2 perpendicular to t1
    const c = t1[0] * t2[0] + t1[1] * t2[1] + t1[2] * t2[2];
    const alpha = Math.acos(Math.max(-1, Math.min(1, c)));
    if (alpha < 0.05 || alpha > Math.PI - 0.05) throw new Error('These faces are nearly flat to each other; nothing to round.');
    let y = [t2[0] - c * t1[0], t2[1] - c * t1[1], t2[2] - c * t1[2]];
    const yl = Math.hypot(...y); y = y.map((q) => q / yl);
    const d = e.dir;
    const to2 = (v) => [v[0] * t1[0] + v[1] * t1[1] + v[2] * t1[2], v[0] * y[0] + v[1] * y[1] + v[2] * y[2]];
    const T2 = [Math.cos(alpha), Math.sin(alpha)];
    const sgn = e.convex ? 1 : -1; // push tool slightly outside the material for convex edges, inside for concave
    const eps = 0.05;
    const n1 = to2(e.n1).map((q) => q * eps * sgn), n2 = to2(e.n2).map((q) => q * eps * sgn);
    let pts;
    if (kind === 'chamfer') {
      const s = size;
      pts = [[n1[0] + n2[0], n1[1] + n2[1]], [s + n1[0], n1[1]], [s, 0], [s * T2[0], s * T2[1]], [s * T2[0] + n2[0], s * T2[1] + n2[1]]];
    } else {
      const r = size;
      const s = r / Math.tan(alpha / 2);
      const h = r / Math.sin(alpha / 2);
      const C = [Math.cos(alpha / 2) * h, Math.sin(alpha / 2) * h];
      const P1 = [s, 0], P2 = [s * T2[0], s * T2[1]];
      const a1 = Math.atan2(P1[1] - C[1], P1[0] - C[0]);
      let a2 = Math.atan2(P2[1] - C[1], P2[0] - C[0]);
      // arc goes the short way, on the side facing the corner
      let da = a2 - a1;
      while (da > Math.PI) da -= 2 * Math.PI;
      while (da < -Math.PI) da += 2 * Math.PI;
      const N = Math.max(6, Math.ceil(Math.abs(da) / (Math.PI / 24)));
      pts = [[n1[0] + n2[0], n1[1] + n2[1]], [s + n1[0], n1[1]]];
      for (let i = 0; i <= N; i++) { const a = a1 + da * i / N; pts.push([C[0] + r * Math.cos(a), C[1] + r * Math.sin(a)]); }
      pts.push([P2[0] + n2[0], P2[1] + n2[1]]);
    }
    // ensure counter-clockwise
    let area = 0;
    for (let i = 0; i < pts.length; i++) { const p = pts[i], q = pts[(i + 1) % pts.length]; area += p[0] * q[1] - q[0] * p[1]; }
    if (area < 0) pts.reverse();
    const cs = T(new CrossSection([pts], 'Positive'));
    const L = Math.hypot(e.b[0] - e.a[0], e.b[1] - e.a[1], e.b[2] - e.a[2]);
    const ext = 0.02;
    const pr = T(T(Manifold.extrude(cs, L + 2 * ext)).translate([0, 0, -ext]));
    // keep the frame right-handed (t1 x y should point along the extrude direction)
    const cr = [t1[1] * y[2] - t1[2] * y[1], t1[2] * y[0] - t1[0] * y[2], t1[0] * y[1] - t1[1] * y[0]];
    const rightHanded = cr[0] * d[0] + cr[1] * d[1] + cr[2] * d[2] > 0;
    const M = rightHanded ? frameMatrix(t1, y, d, e.a) : frameMatrix(t1, y, d.map((q) => -q), e.b);
    const solid = pr.transform(M);
    T.free();
    return { solid, op: e.convex ? 'cut' : 'add' };
  } catch (err) { T.free(); throw err; }
}

// Chamfer a convex corner by cutting off a small pyramid.
export function cornerTool(corner, size, outward) {
  const { Manifold } = W;
  const p = corner.p;
  const pts = [p.map((x, i) => x + outward[i] * 0.05)];
  for (const d of corner.dirs) pts.push([p[0] + d[0] * size, p[1] + d[1] * size, p[2] + d[2] * size]);
  // push the base points slightly outward too so the cut face is clean
  return { solid: Manifold.hull(pts), op: 'cut' };
}
