import Module from 'manifold-3d';
import fs from 'fs';
const w = await Module({wasmBinary: fs.readFileSync('node_modules/manifold-3d/manifold.wasm')});
w.setup();
const {Manifold, Mesh, CrossSection} = w;
const box = Manifold.cube([20,20,10], true);
const cyl = Manifold.cylinder(30, 2, 2, 32, true);
const r = box.subtract(cyl);
console.log('status', r.status(), 'genus', r.genus(), 'vol', r.volume(), 'tris', r.numTri());
const m = r.getMesh();
console.log('numProp', m.numProp, m.vertProperties.length, m.triVerts.length);
// soup round trip
const tv = m.triVerts; const vp=m.vertProperties; const soup=new Float32Array(tv.length*3);
for(let i=0;i<tv.length;i++){ soup.set(vp.subarray(tv[i]*3,tv[i]*3+3), i*3); }
const idx=new Uint32Array(tv.length).map((_,i)=>i);
const mesh2 = new Mesh({numProp:3, vertProperties: soup, triVerts: idx});
console.log('merge', mesh2.merge());
const m2 = new Manifold(mesh2); console.log('soup status', m2.status(), m2.volume());
const bb = r.boundingBox(); console.log(bb);
const t = r.trimByPlane([0,0,1], 0); console.log('trim vol', t.volume());
console.log(typeof CrossSection.circle, typeof Manifold.extrude, typeof r.mirror, typeof Manifold.hull, typeof r.rotate, typeof r.scale, typeof r.minkowskiSum);
