// Node test of the geometry core: STL in -> edits -> watertight check -> STL/3MF out.
import fs from 'fs';
import { parseSTL, exportSTL } from '../src/core/stl.js';
import { weld, checkWatertight, computeFaces, computeEdges, moveVerts, bbox, volume, planeFrame, transformModel, repair, toSoup } from '../src/core/mesh.js';
import { initCSG, featureWorld, applySolid, frameMatrix, edgeTool, cornerTool, planeCut, mirrorModel, shapeWorld, freeSolid, SCREWS } from '../src/core/csg.js';
import { export3MF } from '../src/core/threemf.js';
let fails = 0;
const ok = (c, msg) => { console.log((c ? 'PASS ' : 'FAIL ') + msg); if (!c) fails++; };
const near = (a, b, t = 1e-2) => Math.abs(a - b) <= t;
await initCSG(fs.readFileSync('node_modules/manifold-3d/manifold.wasm'));

// 1. ASCII cube STL (20 mm), 12 triangles
const V = [[0,0,0],[20,0,0],[20,20,0],[0,20,0],[0,0,20],[20,0,20],[20,20,20],[0,20,20]];
const F = [[0,2,1],[0,3,2],[4,5,6],[4,6,7],[0,1,5],[0,5,4],[1,2,6],[1,6,5],[2,3,7],[2,7,6],[3,0,4],[3,4,7]];
let ascii = 'solid cube\n';
for (const f of F) { ascii += ' facet normal 0 0 0\n  outer loop\n'; for (const i of f) ascii += '   vertex ' + V[i].join(' ') + '\n'; ascii += '  endloop\n endfacet\n'; }
ascii += 'endsolid cube\n';
const soup = parseSTL(new TextEncoder().encode(ascii).buffer);
ok(soup.length === 12 * 9, 'ASCII STL parsed 12 triangles');
let m = weld(soup);
ok(m.pos.length === 24, 'welded to 8 vertices');
let wt = checkWatertight(m);
ok(wt.ok && near(wt.volume, 8000), 'cube watertight, volume 8000 (' + wt.volume + ')');
// binary round trip
const bin = exportSTL(m, 'cube');
const m2 = weld(parseSTL(bin));
ok(m2.tri.length === m.tri.length && checkWatertight(m2).ok, 'binary STL export -> re-import round trip');

// 2. faces
let fd = computeFaces(m);
ok(fd.faces.length === 6, 'cube has 6 flat faces (' + fd.faces.length + ')');
let ed = computeEdges(m, fd);
ok(ed.edges.filter(e => e.straight).length === 12 && ed.corners.length === 8, '12 straight edges, 8 corners (' + ed.edges.length + ',' + ed.corners.length + ')');
ok(ed.edges.every(e => e.convex), 'all cube edges are convex');

// 3. push/pull top face up by 5
const top = fd.faces.find(f => f.normal[2] > 0.99);
m = moveVerts(m, top.verts, top.normal, 5);
wt = checkWatertight(m);
ok(wt.ok && near(wt.volume, 10000) && near(bbox(m).size[2], 25), 'push/pull top +5 mm: watertight, height 25');

// 4. M3 counterbored through-hole in the top face centre
fd = computeFaces(m);
const top2 = fd.faces.find(f => f.normal[2] > 0.99);
const fr = planeFrame(top2.normal);
const M = frameMatrix(fr.u, fr.v, fr.n, top2.centroid);
const s = SCREWS.M3;
let tool = featureWorld('hole', { diameter: s.clear, through: true, depth: 0, head: 'counterbore', headD: s.cbD, headDepth: s.cbDepth }, M, null, 100);
m = applySolid(m, tool.solid, tool.op); freeSolid(tool.solid);
wt = checkWatertight(m);
const expected = 10000 - Math.PI * (s.clear/2)**2 * (25 - s.cbDepth) - Math.PI * (s.cbD/2)**2 * s.cbDepth;
ok(wt.ok, 'after M3 counterbore hole: watertight (open=' + wt.open + ', nonManifold=' + wt.nonManifold + ')');
ok(Math.abs(wt.volume - expected) / expected < 0.01, 'hole volume close to expected (' + wt.volume.toFixed(1) + ' vs ' + expected.toFixed(1) + ')');

// 5. linear pattern of 4 slots on a side face
fd = computeFaces(m);
const side = fd.faces.find(f => f.normal[0] > 0.99);
const fs2 = planeFrame(side.normal);
tool = featureWorld('slot', { length: 6, width: 2, depth: 2, through: false, angle: 90 }, frameMatrix(fs2.u, fs2.v, fs2.n, side.centroid), { type: 'linear', count: 4, spacing: 4, dir: 'u' }, 100);
const before = volume(m);
m = applySolid(m, tool.solid, tool.op); freeSolid(tool.solid);
wt = checkWatertight(m);
ok(wt.ok && wt.volume < before, 'linear pattern of 4 slots: watertight, volume reduced');

// 6. fillet a top edge and chamfer another
fd = computeFaces(m); ed = computeEdges(m, fd);
const topEdges = ed.edges.filter(e => e.straight && near(e.a[2], 25) && near(e.b[2], 25) && e.length > 19);
ok(topEdges.length >= 4, 'found top outer edges (' + topEdges.length + ')');
let vb = volume(m);
let et = edgeTool(topEdges[0], 'fillet', 3);
m = applySolid(m, et.solid, et.op); freeSolid(et.solid);
wt = checkWatertight(m);
const filletLoss = (1 - Math.PI / 4) * 9 * 20;
ok(wt.ok && Math.abs((vb - wt.volume) - filletLoss) < 2, 'fillet r=3 on 20 mm edge: watertight, removed ' + (vb - wt.volume).toFixed(1) + ' mm3 (expect ~' + filletLoss.toFixed(1) + ')');
fd = computeFaces(m); ed = computeEdges(m, fd);
const e2 = ed.edges.find(e => e.straight && near(e.a[2], 0) && near(e.b[2], 0) && e.length > 19);
vb = volume(m);
et = edgeTool(e2, 'chamfer', 2);
m = applySolid(m, et.solid, et.op); freeSolid(et.solid);
wt = checkWatertight(m);
ok(wt.ok && Math.abs((vb - wt.volume) - 40) < 1, 'chamfer 2 mm on bottom edge: watertight, removed ' + (vb - wt.volume).toFixed(2) + ' (expect 40)');

// 7. corner chamfer on a fresh cube
let c = weld(soup); fd = computeFaces(c); ed = computeEdges(c, fd);
const corner = ed.corners.find(k => near(k.p[0],20) && near(k.p[1],20) && near(k.p[2],20));
const ct = cornerTool(corner, 4, [0.577,0.577,0.577]);
c = applySolid(c, ct.solid, ct.op); freeSolid(ct.solid);
wt = checkWatertight(c);
ok(wt.ok && near(8000 - wt.volume, 64/6, 0.05), 'corner chamfer 4 mm: watertight, removed ' + (8000 - wt.volume).toFixed(2) + ' (expect 10.67)');

// 8. concave edge fillet (adds material) on an L shape
let L = applySolid(weld(soup), shapeWorld('box', {x:10,y:30,z:10}, [1,0,0,0,0,1,0,0,0,0,1,0,15,10,15,1]), 'cut');
fd = computeFaces(L); ed = computeEdges(L, fd);
const conc = ed.edges.filter(e => e.straight && !e.convex);
ok(conc.length === 1, 'L shape has 1 concave edge (' + conc.length + ')');
vb = volume(L);
et = edgeTool(conc[0], 'fillet', 2);
L = applySolid(L, et.solid, et.op); freeSolid(et.solid);
wt = checkWatertight(L);
ok(wt.ok && Math.abs((wt.volume - vb) - (1 - Math.PI/4)*4*20) < 1, 'concave fillet r=2 adds ' + (wt.volume - vb).toFixed(2) + ' (expect ' + ((1 - Math.PI/4)*80).toFixed(2) + ')');

// 9. plane cut, mirror copy, text-free tools
const pc = planeCut(weld(soup), [0,0,1], 5, 'above');
ok(checkWatertight(pc).ok && near(bbox(pc).size[2], 15), 'plane cut at z=5 keeps top 15 mm');
const split = planeCut(weld(soup), [0,0,1], 10, 'both', 10);
ok(checkWatertight(split).ok && near(volume(split), 8000), 'split in two: both parts kept, watertight');
const mc = mirrorModel(weld(soup), [1,0,0], 20, true);
ok(checkWatertight(mc).ok && near(bbox(mc).size[0], 40), 'mirror copy across x=20 doubles width to 40');
for (const [type, p] of [['bracket',{legA:20,legB:15,width:10,thick:3,holeD:3.4,angle:0}],['tab',{length:12,width:10,thick:3,holeD:3.4}],['rib',{length:10,height:10,thick:2,angle:0}],['standoff',{outerD:7,height:8,holeD:2.5,holeDepth:6}],['pocket',{width:8,height:6,radius:1,depth:3,through:false,angle:0}]]) {
  const cube = weld(soup); const fdd = computeFaces(cube); const tf = fdd.faces.find(f => f.normal[2] > 0.99); const frr = planeFrame(tf.normal);
  const t = featureWorld(type, p, frameMatrix(frr.u, frr.v, frr.n, tf.centroid), null, 100);
  const r = applySolid(cube, t.solid, t.op); freeSolid(t.solid);
  const w = checkWatertight(r);
  ok(w.ok && (t.op === 'add' ? w.volume > 8000 : w.volume < 8000), type + ' tool: watertight, volume ' + w.volume.toFixed(1));
}
// 10. transform with mirror matrix keeps orientation
const mir = transformModel(weld(soup), [-1,0,0,0, 0,1,0,0, 0,0,1,0, 0,0,0,1]);
ok(checkWatertight(mir).ok && near(volume(mir), 8000), 'mirror transform keeps outward winding');
// 11. repair: flipped triangle + duplicate
const broken = weld(soup); const bt = broken.tri.slice(); [bt[1], bt[2]] = [bt[2], bt[1]];
const b2 = { pos: broken.pos, tri: bt };
ok(!checkWatertight(b2).ok, 'flipped triangle detected as a problem');
ok(checkWatertight(repair(b2)).ok, 'repair fixes the flipped triangle');
// 12. open mesh (missing triangle) is flagged
const open = { pos: broken.pos, tri: broken.tri.slice(3) };
const wo = checkWatertight(open);
ok(!wo.ok && wo.open === 3, 'missing triangle flagged: 3 open edges');
// 13. export
fs.mkdirSync('test/out', { recursive: true });
fs.writeFileSync('test/out/result.stl', Buffer.from(exportSTL(m, 'result')));
fs.writeFileSync('test/out/result.3mf', export3MF(m, 'result'));
const re = weld(parseSTL(fs.readFileSync('test/out/result.stl').buffer.slice(0)));
ok(checkWatertight(re).ok, 'exported STL re-imports watertight (' + re.tri.length/3 + ' triangles)');
console.log(fails ? fails + ' FAILED' : 'ALL PASSED');
process.exit(fails ? 1 : 0);
