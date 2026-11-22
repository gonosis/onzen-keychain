// Horizontal drilled holes: a real 3D boolean (piece − cylinder) with manifold-3d, whose
// booleans are guaranteed to return a closed 2-manifold. Everything else in this app stays 2D
// (mask → contours → layered extrusion); only a sideways cylinder truly needs 3D, and the
// solids it's applied to are already verified manifold, which is what manifold-3d requires.
import * as THREE from 'three';

let wasmPromise = null;
function getWasm() {
  if (!wasmPromise) {
    wasmPromise = import('../node_modules/manifold-3d/manifold.js')
      .then(m => m.default())
      .then(w => { w.setup(); return w; });
  }
  return wasmPromise;
}

// holes: [{ x, y, z, r, angleDeg, length|null }] — axis lies in the XY plane at angleDeg
// (0 = along X), centered at (x, y) and height z; length null = through the whole piece.
// Returns a new non-indexed BufferGeometry, or null if the input isn't a valid manifold.
export async function cutHorizontalHoles(geometry, holes) {
  const { Manifold, Mesh } = await getWasm();

  // Weld the triangle soup by exact position → indexed mesh (the builders share vertices
  // exactly along every edge, so this recovers the topology).
  const pos = geometry.getAttribute('position');
  const map = new Map();
  const verts = [];
  const tris = new Uint32Array(pos.count);
  for (let i = 0; i < pos.count; i++) {
    const x = pos.getX(i), y = pos.getY(i), z = pos.getZ(i);
    const key = `${x},${y},${z}`;
    let id = map.get(key);
    if (id === undefined) { id = verts.length / 3; map.set(key, id); verts.push(x, y, z); }
    tris[i] = id;
  }
  const piece = new Manifold(new Mesh({ numProp: 3, vertProperties: new Float32Array(verts), triVerts: tris }));
  if (piece.status() !== 'NoError') { piece.delete(); return null; }

  const bb = piece.boundingBox();
  const through = Math.hypot(bb.max[0] - bb.min[0], bb.max[1] - bb.min[1]) * 2 + 20;
  let result = piece;
  for (const hole of holes) {
    const len = hole.length > 0 ? hole.length : through;
    const segments = Math.max(24, Math.min(96, Math.round(hole.r * 24)));
    const cyl = Manifold.cylinder(len, hole.r, hole.r, segments, true)
      .rotate([0, 90, 0])
      .rotate([0, 0, hole.angleDeg || 0])
      .translate([hole.x, hole.y, hole.z]);
    const next = result.subtract(cyl);
    cyl.delete();
    if (result !== piece) result.delete();
    result = next;
  }

  const mesh = result.getMesh();
  const tv = mesh.triVerts, vp = mesh.vertProperties, np = mesh.numProp;
  const out = new Float32Array(tv.length * 3);
  for (let i = 0; i < tv.length; i++) {
    const v = tv[i] * np;
    out[i * 3] = vp[v]; out[i * 3 + 1] = vp[v + 1]; out[i * 3 + 2] = vp[v + 2];
  }
  if (result !== piece) result.delete();
  piece.delete();
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(out, 3));
  g.computeVertexNormals();
  return g;
}
