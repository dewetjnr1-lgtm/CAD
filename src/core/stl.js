// STL (STereoLithography) reading and writing.
// parseSTL returns a "triangle soup": Float32Array of xyz for 3 corners per triangle.

export function parseSTL(buffer) {
  const bytes = new Uint8Array(buffer);
  if (bytes.length < 15) throw new Error('File is too small to be an STL.');
  // Binary STL: 80-byte header, uint32 count, 50 bytes per triangle.
  if (bytes.length >= 84) {
    const dv = new DataView(buffer);
    const n = dv.getUint32(80, true);
    if (84 + n * 50 === bytes.length && n > 0) return parseBinary(dv, n);
  }
  // Otherwise try ASCII ("solid ... facet normal ... vertex x y z").
  const head = new TextDecoder().decode(bytes.subarray(0, Math.min(bytes.length, 1000))).toLowerCase();
  if (head.includes('facet') || head.trimStart().startsWith('solid')) {
    const out = parseAscii(new TextDecoder().decode(bytes));
    if (out.length > 0) return out;
  }
  // Some binary files have a wrong size; trust the count if it fits.
  if (bytes.length >= 84) {
    const dv = new DataView(buffer);
    const n = dv.getUint32(80, true);
    if (n > 0 && 84 + n * 50 <= bytes.length) return parseBinary(dv, n);
  }
  throw new Error('Could not read this file as STL (binary or ASCII).');
}

function parseBinary(dv, n) {
  const out = new Float32Array(n * 9);
  let o = 84, k = 0;
  for (let i = 0; i < n; i++) {
    o += 12; // skip stored normal; we recompute from the vertices
    for (let j = 0; j < 9; j++) { out[k++] = dv.getFloat32(o, true); o += 4; }
    o += 2;
  }
  return out;
}

function parseAscii(text) {
  const re = /vertex\s+([-+0-9.eE]+)\s+([-+0-9.eE]+)\s+([-+0-9.eE]+)/g;
  const vals = [];
  let m;
  while ((m = re.exec(text))) vals.push(+m[1], +m[2], +m[3]);
  const usable = vals.length - (vals.length % 9);
  return new Float32Array(vals.slice(0, usable));
}

// Binary STL from an indexed mesh {pos: Float32Array, tri: Uint32Array}.
export function exportSTL(model, name = 'model') {
  const { pos, tri } = model;
  const n = tri.length / 3;
  const buf = new ArrayBuffer(84 + n * 50);
  const dv = new DataView(buf);
  const header = ('Made with Pocket CAD: ' + name).slice(0, 79);
  for (let i = 0; i < header.length; i++) dv.setUint8(i, header.charCodeAt(i) & 127);
  dv.setUint32(80, n, true);
  let o = 84;
  for (let t = 0; t < n; t++) {
    const a = tri[t * 3] * 3, b = tri[t * 3 + 1] * 3, c = tri[t * 3 + 2] * 3;
    const ux = pos[b] - pos[a], uy = pos[b + 1] - pos[a + 1], uz = pos[b + 2] - pos[a + 2];
    const vx = pos[c] - pos[a], vy = pos[c + 1] - pos[a + 1], vz = pos[c + 2] - pos[a + 2];
    let nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
    const l = Math.hypot(nx, ny, nz) || 1;
    dv.setFloat32(o, nx / l, true); dv.setFloat32(o + 4, ny / l, true); dv.setFloat32(o + 8, nz / l, true);
    o += 12;
    for (const v of [a, b, c]) {
      dv.setFloat32(o, pos[v], true); dv.setFloat32(o + 4, pos[v + 1], true); dv.setFloat32(o + 8, pos[v + 2], true);
      o += 12;
    }
    dv.setUint16(o, 0, true); o += 2;
  }
  return buf;
}
