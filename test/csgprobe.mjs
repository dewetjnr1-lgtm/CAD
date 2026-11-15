import * as THREE from 'three';
import { Brush, Evaluator, SUBTRACTION, ADDITION } from 'three-bvh-csg';
function prep(g){ g=g.index?g.toNonIndexed():g; for(const k of Object.keys(g.attributes)) if(k!=='position'&&k!=='normal') g.deleteAttribute(k); g.clearGroups(); return g; }
function check(g){ const p=g.attributes.position.array; const map=new Map(); const id=[]; const q=v=>Math.round(v*1e4);
 for(let i=0;i<p.length;i+=3){const k=q(p[i])+','+q(p[i+1])+','+q(p[i+2]); if(!map.has(k)) map.set(k,map.size); id.push(map.get(k));}
 const E=new Map(); let degen=0; for(let t=0;t<id.length;t+=3){ const a=id[t],b=id[t+1],c=id[t+2]; if(a===b||b===c||a===c){degen++;continue;} for(const [u,v] of [[a,b],[b,c],[c,a]]){ const k=u<v?u+'_'+v:v+'_'+u; const e=E.get(k)||[0,0]; e[u<v?0:1]++; E.set(k,e);} }
 let open=0,non=0; for(const [k,[f,r]] of E){ if(f!==r) { if(f+r===1) open++; else non++; } } return {tris:id.length/3,verts:map.size,open,non,degen}; }
for (const cdt of [false,true]) {
const ev=new Evaluator(); ev.attributes=['position','normal']; ev.useGroups=false; ev.useCDTClipping=cdt;
const a=new Brush(prep(new THREE.BoxGeometry(20,20,10))); a.updateMatrixWorld();
const b=new Brush(prep(new THREE.CylinderGeometry(2,2,30,32))); b.rotation.x=Math.PI/2; b.updateMatrixWorld();
const r=ev.evaluate(a,b,SUBTRACTION); console.log('cdt',cdt,'sub', check(r.geometry));
const c=new Brush(prep(new THREE.BoxGeometry(5,5,5))); c.position.set(10,0,5); c.updateMatrixWorld();
const r2=ev.evaluate(r,c,ADDITION); console.log('cdt',cdt,'add', check(r2.geometry));
}
