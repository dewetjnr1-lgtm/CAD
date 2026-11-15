import fs from 'fs';
import { initCSG, fromManifold } from '../src/core/csg.js';
import { exportSTL } from '../src/core/stl.js';
import Module from 'manifold-3d';
const w = await Module({ wasmBinary: fs.readFileSync('node_modules/manifold-3d/manifold.wasm') }); w.setup();
const s = w.Manifold.sphere(40, 800);
const m = fromManifold(s);
fs.writeFileSync('test/out/big-sphere.stl', Buffer.from(exportSTL(m)));
console.log('big sphere triangles', m.tri.length / 3);
