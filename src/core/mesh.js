// Indexed triangle mesh helpers. A model is { pos: Float32Array (xyz per vertex), tri: Uint32Array (3 per triangle) }.

export function cloneModel(m) {
  return { pos: m.pos.slice(), tri: m.tri.slice() };
}

// Merge corners that are at the same spot (within tol mm) so triangles share vertices.
export function weld(soup, tol = 1e-4) {
  const map = new Map();
  const pos = [];
  const idx = new Uint32Array(soup.length / 3);
  const inv = 1 / tol;
  for (let i = 0, v = 0; i < soup.length; i += 3, v++) {
    const x = soup[i], y = soup[i + 1], z = soup[i + 2];
    const key = Math.round(x * inv) + ',' + Math.round(y * inv) + ',' + Math.round(z * inv);
    let id = map.get(key);
    if (id === undefined) { id = pos.length / 3; map.set(key, id); pos.push(x, y, z); }
    idx[v] = id;
  }
  const tri = [];
  for (let t = 0; t < idx.length; t += 3) {
    const a = idx[t], b = idx[t + 1], c = idx[t + 2];
    if (a !== b && b !== c && a !== c) tri.push(a, b, c);
  }
  return compact({ pos: new Float32Array(pos), tri: new Uint32Array(tri) });
}

// Remove unused vertices.
export function compact(m) {
  const nv = m.pos.length / 3;
  const remap = new Int32Array(nv).fill(-1);
  let k = 0;
  for (let i = 0; i < m.tri.length; i++) if (remap[m.tri[i]] < 0) remap[m.tri[i]] = k++;
  if (k === nv) return m;
  const pos = new Float32Array(k * 3);
  for (let i = 0; i < nv; i++) if (remap[i] >= 0) pos.set(m.pos.subarray(i * 3, i * 3 + 3), remap[i] * 3);
  const tri = new Uint32Array(m.tri.length);
  for (let i = 0; i < tri.length; i++) tri[i] = remap[m.tri[i]];
  return { pos, tri };
}

export function toSoup(m) {
  const out = new Float32Array(m.tri.length * 3);
  for (let i = 0; i < m.tri.length; i++) {
    const v = m.tri[i] * 3;
    out[i * 3] = m.pos[v]; out[i * 3 + 1] = m.pos[v + 1]; out[i * 3 + 2] = m.pos[v + 2];
  }
  return out;
}

export function bbox(m) {
  const min = [Infinity, Infinity, Infinity], max = [-Infinity, -Infinity, -Infinity];
  const used = new Uint8Array(m.pos.length / 3);
  for (let i = 0; i < m.tri.length; i++) used[m.tri[i]] = 1;
  for (let i = 0; i < used.length; i++) {
    if (!used[i]) continue;
    for (let j = 0; j < 3; j++) {
      const v = m.pos[i * 3 + j];
      if (v < min[j]) min[j] = v;
      if (v > max[j]) max[j] = v;
    }
  }
  if (min[0] === Infinity) return { min: [0, 0, 0], max: [0, 0, 0], size: [0, 0, 0], center: [0, 0, 0] };
  return { min, max, size: max.map((v, i) => v - min[i]), center: max.map((v, i) => (v + min[i]) / 2) };
}

export function volume(m) {
  const { pos, tri } = m;
  let v = 0;
  for (let t = 0; t < tri.length; t += 3) {
    const a = tri[t] * 3, b = tri[t + 1] * 3, c = tri[t + 2] * 3;
    v += pos[a] * (pos[b + 1] * pos[c + 2] - pos[b + 2] * pos[c + 1])
       - pos[a + 1] * (pos[b] * pos[c + 2] - pos[b + 2] * pos[c])
       + pos[a + 2] * (pos[b] * pos[c + 1] - pos[b + 1] * pos[c]);
  }
  return v / 6;
}

// Watertight check. Every edge must be used by exactly two triangles, once in each direction.
export function checkWatertight(m) {
  const { tri } = m;
  const nv = m.pos.length / 3;
  const edges = new Map(); // key -> [forwardCount, reverseCount]
  let degenerate = 0;
  for (let t = 0; t < tri.length; t += 3) {
    const a = tri[t], b = tri[t + 1], c = tri[t + 2];
    if (a === b || b === c || a === c) { degenerate++; continue; }
    for (let e = 0; e < 3; e++) {
      const u = tri[t + e], v = tri[t + ((e + 1) % 3)];
      const key = u < v ? u * nv + v : v * nv + u;
      let rec = edges.get(key);
      if (!rec) { rec = [0, 0]; edges.set(key, rec); }
      rec[u < v ? 0 : 1]++;
    }
  }
  let open = 0, nonManifold = 0, flipped = 0;
  for (const [f, r] of edges.values()) {
    const s = f + r;
    if (s === 1) open++;
    else if (s > 2) nonManifold++;
    else if (f !== 1) flipped++;
  }
  const vol = volume(m);
  const ok = open === 0 && nonManifold === 0 && flipped === 0 && tri.length > 0;
  return { ok, open, nonManifold, flipped, degenerate, triangles: tri.length / 3, volume: vol, insideOut: ok && vol < 0 };
}

export function triNormals(m) {
  const { pos, tri } = m;
  const n = new Float32Array(tri.length);
  const area = new Float32Array(tri.length / 3);
  for (let t = 0, i = 0; t < tri.length; t += 3, i++) {
    const a = tri[t] * 3, b = tri[t + 1] * 3, c = tri[t + 2] * 3;
    const ux = pos[b] - pos[a], uy = pos[b + 1] - pos[a + 1], uz = pos[b + 2] - pos[a + 2];
    const vx = pos[c] - pos[a], vy = pos[c + 1] - pos[a + 1], vz = pos[c + 2] - pos[a + 2];
    const nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
    const l = Math.hypot(nx, ny, nz);
    area[i] = l / 2;
    if (l > 0) { n[t] = nx / l; n[t + 1] = ny / l; n[t + 2] = nz / l; }
  }
  return { n, area };
}

// For each undirected edge, which triangles use it. Returns Map key -> [tri, tri, ...].
function edgeTriMap(m) {
  const nv = m.pos.length / 3;
  const map = new Map();
  for (let t = 0; t < m.tri.length / 3; t++) {
    for (let e = 0; e < 3; e++) {
      const u = m.tri[t * 3 + e], v = m.tri[t * 3 + ((e + 1) % 3)];
      const key = u < v ? u * nv + v : v * nv + u;
      const list = map.get(key);
      if (list) list.push(t); else map.set(key, [t]);
    }
  }
  return map;
}

// Group connected triangles that share the same plane into "faces".
// Returns { faceOf: Int32Array per triangle, faces: [{ id, tris, normal, d, area, centroid, verts }] }
export function computeFaces(m, angleDeg = 0.6, distTol = 0.005) {
  const { n, area } = triNormals(m);
  const nt = m.tri.length / 3;
  const nv = m.pos.length / 3;
  const cosTol = Math.cos(angleDeg * Math.PI / 180);
  const em = edgeTriMap(m);
  const faceOf = new Int32Array(nt).fill(-1);
  const faces = [];
  const d = new Float32Array(nt);
  for (let t = 0; t < nt; t++) {
    const a = m.tri[t * 3] * 3;
    d[t] = n[t * 3] * m.pos[a] + n[t * 3 + 1] * m.pos[a + 1] + n[t * 3 + 2] * m.pos[a + 2];
  }
  const stack = [];
  // seed from the biggest triangles first: their normals are the most accurate
  const order = Array.from({ length: nt }, (_, i) => i).sort((a, b) => area[b] - area[a]);
  for (const s of order) {
    if (faceOf[s] >= 0) continue;
    const id = faces.length;
    const tris = [];
    faceOf[s] = id; stack.push(s);
    while (stack.length) {
      const t = stack.pop();
      tris.push(t);
      for (let e = 0; e < 3; e++) {
        const u = m.tri[t * 3 + e], v = m.tri[t * 3 + ((e + 1) % 3)];
        const list = em.get(u < v ? u * nv + v : v * nv + u);
        if (!list || list.length !== 2) continue;
        const o = list[0] === t ? list[1] : list[0];
        if (faceOf[o] >= 0) continue;
        const dot = n[s * 3] * n[o * 3] + n[s * 3 + 1] * n[o * 3 + 1] + n[s * 3 + 2] * n[o * 3 + 2];
        // thin sliver triangles have noisy normals, so for tiny ones rely on the plane-distance test only
        if (dot < (area[o] < 0.01 ? 0.5 : cosTol)) continue;
        // all three corners must lie on the seed triangle's plane so the face stays flat
        let flat = true;
        for (let k = 0; k < 3; k++) {
          const q = m.tri[o * 3 + k] * 3;
          const pd = n[s * 3] * m.pos[q] + n[s * 3 + 1] * m.pos[q + 1] + n[s * 3 + 2] * m.pos[q + 2];
          if (Math.abs(pd - d[s]) > distTol) { flat = false; break; }
        }
        if (!flat) continue;
        faceOf[o] = id; stack.push(o);
      }
    }
    let A = 0; const N = [0, 0, 0], C = [0, 0, 0];
    const vset = new Set();
    for (const t of tris) {
      const w = area[t];
      A += w;
      for (let j = 0; j < 3; j++) N[j] += n[t * 3 + j] * w;
      for (let k = 0; k < 3; k++) {
        const vi = m.tri[t * 3 + k];
        vset.add(vi);
        for (let j = 0; j < 3; j++) C[j] += m.pos[vi * 3 + j] * w / 3;
      }
    }
    const l = Math.hypot(...N) || 1;
    const normal = N.map((x) => x / l);
    const centroid = A > 0 ? C.map((x) => x / A) : [m.pos[m.tri[s * 3] * 3], m.pos[m.tri[s * 3] * 3 + 1], m.pos[m.tri[s * 3] * 3 + 2]];
    faces.push({ id, tris, normal, d: normal[0] * centroid[0] + normal[1] * centroid[1] + normal[2] * centroid[2], area: A, centroid, verts: [...vset] });
  }
  return { faceOf, faces, edgeMap: em };
}

const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const dot3 = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const len3 = (a) => Math.hypot(a[0], a[1], a[2]);
const norm3 = (a) => { const l = len3(a) || 1; return [a[0] / l, a[1] / l, a[2] / l]; };

// Find sharp edges between faces, group them into straight edges or curved chains, and find corners.
export function computeEdges(m, faceData, sharpDeg = 20) {
  const { faceOf, faces, edgeMap } = faceData;
  const nv = m.pos.length / 3;
  const P = (i) => [m.pos[i * 3], m.pos[i * 3 + 1], m.pos[i * 3 + 2]];
  const cosSharp = Math.cos(sharpDeg * Math.PI / 180);
  const segs = []; // {u, v, f1, f2}
  for (const [key, list] of edgeMap) {
    if (list.length !== 2) continue;
    const f1 = faceOf[list[0]], f2 = faceOf[list[1]];
    if (f1 === f2) continue;
    if (dot3(faces[f1].normal, faces[f2].normal) > cosSharp) continue;
    const u = Math.floor(key / nv), v = key - u * nv;
    segs.push({ u, v, f1: Math.min(f1, f2), f2: Math.max(f1, f2) });
  }
  // vertex -> segment ids
  const vsegs = new Map();
  segs.forEach((s, i) => {
    for (const x of [s.u, s.v]) { const l = vsegs.get(x); if (l) l.push(i); else vsegs.set(x, [i]); }
  });
  // Build chains through vertices where exactly 2 sharp segments meet and the turn is gentle (< 40 deg).
  const used = new Uint8Array(segs.length);
  const dirOf = (s, from) => norm3(sub(P(from === s.u ? s.v : s.u), P(from)));
  const passable = (vtx, si) => {
    const l = vsegs.get(vtx);
    if (!l || l.length !== 2) return -1;
    const o = l[0] === si ? l[1] : l[0];
    const a = dirOf(segs[si], vtx), b = dirOf(segs[o], vtx);
    // straight continuation means a and b point opposite ways
    return dot3(a, b) < -Math.cos(40 * Math.PI / 180) ? o : -1;
  };
  const chains = [];
  for (let i = 0; i < segs.length; i++) {
    if (used[i]) continue;
    used[i] = 1;
    const chainSegs = [i];
    let verts = [segs[i].u, segs[i].v];
    // extend forward
    for (const forward of [true, false]) {
      let si = i;
      let vtx = forward ? segs[i].v : segs[i].u;
      for (;;) {
        const o = passable(vtx, si);
        if (o < 0 || used[o]) break;
        used[o] = 1;
        chainSegs.push(o);
        const nx = segs[o].u === vtx ? segs[o].v : segs[o].u;
        if (forward) verts.push(nx); else verts.unshift(nx);
        si = o; vtx = nx;
        if (vtx === verts[forward ? 0 : verts.length - 1]) break; // closed loop
      }
    }
    chains.push({ segs: chainSegs, verts });
  }
  const edges = [];
  for (const ch of chains) {
    const pts = ch.verts.map(P);
    const a = pts[0], b = pts[pts.length - 1];
    const ab = sub(b, a);
    const L = len3(ab);
    let straight = L > 1e-6;
    if (straight) {
      const dir = norm3(ab);
      for (const p of pts) {
        const ap = sub(p, a);
        const t = dot3(ap, dir);
        const perp = len3([ap[0] - dir[0] * t, ap[1] - dir[1] * t, ap[2] - dir[2] * t]);
        if (perp > Math.max(0.01, L * 1e-4)) { straight = false; break; }
      }
    }
    const pairs = new Set(ch.segs.map((s) => segs[s].f1 + '_' + segs[s].f2));
    if (straight && pairs.size === 1) {
      const s0 = segs[ch.segs[0]];
      edges.push({ id: edges.length, straight: true, a, b, length: L, pts, f1: s0.f1, f2: s0.f2, va: ch.verts[0], vb: ch.verts[ch.verts.length - 1] });
    } else if (straight) {
      // collinear but bordered by different faces: split into pieces per face pair (in order)
      let start = 0;
      for (let k = 1; k <= ch.segs.length; k++) {
        const prev = segs[ch.segs[k - 1]];
        const cur = k < ch.segs.length ? segs[ch.segs[k]] : null;
        if (!cur || cur.f1 !== prev.f1 || cur.f2 !== prev.f2) {
          // chain segs are not necessarily ordered along verts; fall back to whole chain endpoints of this sub-list
          const vs = new Set();
          for (let q = start; q < k; q++) { vs.add(segs[ch.segs[q]].u); vs.add(segs[ch.segs[q]].v); }
          const vp = [...vs].map((x) => ({ x, t: dot3(sub(P(x), a), norm3(ab)) })).sort((p, q) => p.t - q.t);
          const pa = P(vp[0].x), pb = P(vp[vp.length - 1].x);
          edges.push({ id: edges.length, straight: true, a: pa, b: pb, length: len3(sub(pb, pa)), pts: [pa, pb], f1: prev.f1, f2: prev.f2, va: vp[0].x, vb: vp[vp.length - 1].x });
          start = k;
        }
      }
    } else {
      edges.push({ id: edges.length, straight: false, a, b, length: pts.slice(1).reduce((s, p, k) => s + len3(sub(p, pts[k])), 0), pts, f1: -1, f2: -1, va: ch.verts[0], vb: ch.verts[ch.verts.length - 1] });
    }
  }
  // Corners: vertices where 3 or more sharp segments meet.
  const corners = [];
  for (const [vtx, l] of vsegs) {
    if (l.length < 3) continue;
    const fs = new Set();
    for (const si of l) { fs.add(segs[si].f1); fs.add(segs[si].f2); }
    corners.push({ id: corners.length, v: vtx, p: P(vtx), dirs: l.map((si) => dirOf(segs[si], vtx)), faces: [...fs] });
  }
  // Convexity for straight edges
  for (const e of edges) {
    if (!e.straight) continue;
    const info = edgeFrame(m, faceData, e);
    Object.assign(e, info);
  }
  return { edges, corners };
}

// Directions into each face from a straight edge, and whether the edge is convex (outside corner).
export function edgeFrame(m, faceData, e) {
  const { faces, faceOf } = faceData;
  const d = norm3(sub(e.b, e.a));
  const P = (i) => [m.pos[i * 3], m.pos[i * 3 + 1], m.pos[i * 3 + 2]];
  const into = (fid) => {
    const n = faces[fid].normal;
    let t = norm3([n[1] * d[2] - n[2] * d[1], n[2] * d[0] - n[0] * d[2], n[0] * d[1] - n[1] * d[0]]); // n x d, lies in face
    // pick the sign that points into the face: use a face vertex far from the edge line
    let best = 0;
    for (const vi of faces[fid].verts) {
      const ap = sub(P(vi), e.a);
      const along = dot3(ap, d);
      const perp = [ap[0] - d[0] * along, ap[1] - d[1] * along, ap[2] - d[2] * along];
      const s = dot3(perp, t);
      if (Math.abs(s) > Math.abs(best)) best = s;
    }
    if (best < 0) t = t.map((x) => -x);
    return t;
  };
  const t1 = into(e.f1), t2 = into(e.f2);
  const n1 = faces[e.f1].normal, n2 = faces[e.f2].normal;
  const convex = dot3(t1, n2) < 0;
  const angle = Math.acos(Math.max(-1, Math.min(1, dot3(t1, t2)))) * 180 / Math.PI;
  void faceOf;
  return { dir: d, t1, t2, n1, n2, convex, wedgeAngle: angle };
}

// In-plane frame for a face normal: u (across), v (up-ish), n (out of the face).
export function planeFrame(n) {
  let u, v;
  if (Math.abs(n[2]) < 0.9) {
    // side face: v = world up projected onto the face
    v = norm3([-n[0] * n[2], -n[1] * n[2], 1 - n[2] * n[2]]);
    u = norm3([v[1] * n[2] - v[2] * n[1], v[2] * n[0] - v[0] * n[2], v[0] * n[1] - v[1] * n[0]]); // v x n
  } else {
    u = norm3([1 - n[0] * n[0], -n[0] * n[1], -n[0] * n[2]]);
    v = norm3([n[1] * u[2] - n[2] * u[1], n[2] * u[0] - n[0] * u[2], n[0] * u[1] - n[1] * u[0]]); // n x u
  }
  return { u, v, n };
}

// 2D bounding box of a face in its plane frame.
export function faceBounds2D(m, face, frame) {
  let minU = Infinity, maxU = -Infinity, minV = Infinity, maxV = -Infinity;
  for (const vi of face.verts) {
    const p = [m.pos[vi * 3], m.pos[vi * 3 + 1], m.pos[vi * 3 + 2]];
    const a = dot3(p, frame.u), b = dot3(p, frame.v);
    if (a < minU) minU = a; if (a > maxU) maxU = a;
    if (b < minV) minV = b; if (b > maxV) maxV = b;
  }
  return { minU, maxU, minV, maxV, w: maxU - minU, h: maxV - minV };
}

// Simple repair: weld with a looser tolerance, drop duplicate triangles, fix inconsistent winding, flip if inside-out.
export function repair(m, tol = 0.01) {
  let r = weld(toSoup(m), tol);
  // drop duplicate triangles (same 3 vertices)
  const seen = new Set();
  const tri = [];
  for (let t = 0; t < r.tri.length; t += 3) {
    const k = [r.tri[t], r.tri[t + 1], r.tri[t + 2]].sort((a, b) => a - b).join(',');
    if (seen.has(k)) continue;
    seen.add(k);
    tri.push(r.tri[t], r.tri[t + 1], r.tri[t + 2]);
  }
  r = { pos: r.pos, tri: new Uint32Array(tri) };
  // make winding consistent with neighbours (flood fill)
  const nt = r.tri.length / 3, nv = r.pos.length / 3;
  const em = edgeTriMap(r);
  const done = new Uint8Array(nt);
  for (let s = 0; s < nt; s++) {
    if (done[s]) continue;
    done[s] = 1;
    const comp = [s];
    const stack = [s];
    while (stack.length) {
      const t = stack.pop();
      for (let e = 0; e < 3; e++) {
        const u = r.tri[t * 3 + e], v = r.tri[t * 3 + ((e + 1) % 3)];
        const list = em.get(u < v ? u * nv + v : v * nv + u);
        if (!list || list.length !== 2) continue;
        const o = list[0] === t ? list[1] : list[0];
        if (done[o]) continue;
        // neighbour should use edge as v->u
        let same = false;
        for (let k = 0; k < 3; k++) if (r.tri[o * 3 + k] === u && r.tri[o * 3 + ((k + 1) % 3)] === v) same = true;
        if (same) { const x = r.tri[o * 3 + 1]; r.tri[o * 3 + 1] = r.tri[o * 3 + 2]; r.tri[o * 3 + 2] = x; }
        done[o] = 1; stack.push(o); comp.push(o);
      }
    }
    // flip whole component if its volume is negative
    let vol = 0;
    for (const t of comp) {
      const a = r.tri[t * 3] * 3, b = r.tri[t * 3 + 1] * 3, c = r.tri[t * 3 + 2] * 3, p = r.pos;
      vol += p[a] * (p[b + 1] * p[c + 2] - p[b + 2] * p[c + 1]) - p[a + 1] * (p[b] * p[c + 2] - p[b + 2] * p[c]) + p[a + 2] * (p[b] * p[c + 1] - p[b + 1] * p[c]);
    }
    if (vol < 0) for (const t of comp) { const x = r.tri[t * 3 + 1]; r.tri[t * 3 + 1] = r.tri[t * 3 + 2]; r.tri[t * 3 + 2] = x; }
  }
  return compact(r);
}

// Apply a 4x4 column-major matrix to all vertices. Flips winding if the matrix mirrors.
export function transformModel(m, e) {
  const pos = new Float32Array(m.pos.length);
  for (let i = 0; i < pos.length; i += 3) {
    const x = m.pos[i], y = m.pos[i + 1], z = m.pos[i + 2];
    pos[i] = e[0] * x + e[4] * y + e[8] * z + e[12];
    pos[i + 1] = e[1] * x + e[5] * y + e[9] * z + e[13];
    pos[i + 2] = e[2] * x + e[6] * y + e[10] * z + e[14];
  }
  const det = e[0] * (e[5] * e[10] - e[9] * e[6]) - e[4] * (e[1] * e[10] - e[9] * e[2]) + e[8] * (e[1] * e[6] - e[5] * e[2]);
  const tri = m.tri.slice();
  if (det < 0) for (let t = 0; t < tri.length; t += 3) { const x = tri[t + 1]; tri[t + 1] = tri[t + 2]; tri[t + 2] = x; }
  return { pos, tri };
}

// Move a set of vertices along a direction (push/pull).
export function moveVerts(m, verts, dir, dist) {
  const pos = m.pos.slice();
  for (const v of verts) {
    pos[v * 3] += dir[0] * dist; pos[v * 3 + 1] += dir[1] * dist; pos[v * 3 + 2] += dir[2] * dist;
  }
  return { pos, tri: m.tri.slice() };
}

export const vec = { sub, dot3, len3, norm3 };
