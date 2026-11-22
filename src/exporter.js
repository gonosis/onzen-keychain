import * as THREE from 'three';
import { STLExporter } from 'three/examples/jsm/exporters/STLExporter.js';
import { OBJExporter } from 'three/examples/jsm/exporters/OBJExporter.js';
import { zipSync, strToU8 } from 'three/examples/jsm/libs/fflate.module.js';

// Encodes the keychain geometry. Only positions are exported — normals/UVs from the preview
// geometry aren't needed by slicers.
export function encodeModel(geometry, format) {
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', geometry.getAttribute('position'));
  if (geometry.index) g.setIndex(geometry.index);
  const mesh = new THREE.Mesh(g);
  if (format === 'stl') {
    const view = new STLExporter().parse(mesh, { binary: true });
    return new Uint8Array(view.buffer, view.byteOffset, view.byteLength);
  }
  return new TextEncoder().encode(new OBJExporter().parse(mesh));
}

export function sanitizeName(name) {
  return (name || '').replace(/[\\/:*?"<>|\n\r]+/g, '_').trim() || 'keychain';
}

export function saveModel(geometry, format, baseName = 'keychain') {
  const safe = sanitizeName(baseName);
  return window.api.saveExport({
    defaultName: `${safe}.${format}`,
    filters: [{ name: format.toUpperCase(), extensions: [format] }],
    data: encodeModel(geometry, format)
  });
}

// parts: [{ name, color: '#rrggbb', geometry }]
// One 3MF object made of components (one per color part). PrusaSlicer / Bambu Studio / Orca
// load that as a single object with multiple parts, so each part can get its own filament
// while they stay locked together in position.
export function encode3MF(parts) {
  const esc = (s) => String(s).replace(/[<>&"]/g, c => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;' }[c]));
  const num = (v) => (Math.round(v * 1e5) / 1e5).toString();

  // One filament slot per distinct color, in part order (base first) → extruder 1, 2, 3…
  const colors = [];
  for (const p of parts) { const c = p.color.toUpperCase(); if (!colors.includes(c)) colors.push(c); }
  const slotOf = (p) => colors.indexOf(p.color.toUpperCase()) + 1;

  let objects = '';
  parts.forEach((part, i) => {
    const { vertices, triangles } = indexedMesh(part.geometry);
    let vx = '', tx = '';
    for (let v = 0; v < vertices.length; v += 3) vx += `<vertex x="${num(vertices[v])}" y="${num(vertices[v + 1])}" z="${num(vertices[v + 2])}"/>`;
    for (let t = 0; t < triangles.length; t += 3) tx += `<triangle v1="${triangles[t]}" v2="${triangles[t + 1]}" v3="${triangles[t + 2]}"/>`;
    objects += `<object id="${i + 2}" name="${esc(part.name)}" type="model" pid="1" pindex="${i}"><mesh><vertices>${vx}</vertices><triangles>${tx}</triangles></mesh></object>`;
  });
  const parentId = parts.length + 2;
  const components = parts.map((_, i) => `<component objectid="${i + 2}"/>`).join('');
  const bases = parts.map(p => `<base name="${esc(p.name)}" displaycolor="${p.color.toUpperCase()}FF"/>`).join('');
  // Core 3MF (any slicer) + the BambuStudio namespace/version marker that makes OrcaSlicer and
  // Bambu Studio read Metadata/model_settings.config (per-part names + filament assignment).
  const model = `<?xml version="1.0" encoding="UTF-8"?>
<model unit="millimeter" xml:lang="en-US" xmlns="http://schemas.microsoft.com/3dmanufacturing/core/2015/02" xmlns:BambuStudio="http://schemas.bambulab.com/package/2021">
<metadata name="Application">Onzen Flat Keychain</metadata>
<metadata name="BambuStudio:3mfVersion">1</metadata>
<resources><basematerials id="1">${bases}</basematerials>${objects}<object id="${parentId}" name="keychain" type="model"><components>${components}</components></object></resources>
<build><item objectid="${parentId}"/></build>
</model>`;

  const identity = '1 0 0 0 0 1 0 0 0 0 1 0 0 0 0 1';
  const modelSettings = `<?xml version="1.0" encoding="UTF-8"?>
<config>
  <object id="${parentId}">
    <metadata key="name" value="keychain"/>
    <metadata key="extruder" value="${slotOf(parts[0])}"/>
${parts.map((p, i) => `    <part id="${i + 2}" subtype="normal_part">
      <metadata key="name" value="${esc(p.name)}"/>
      <metadata key="matrix" value="${identity}"/>
      <metadata key="extruder" value="${slotOf(p)}"/>
    </part>`).join('\n')}
  </object>
</config>`;

  return zipSync({
    '[Content_Types].xml': strToU8('<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="model" ContentType="application/vnd.ms-package.3dmanufacturing-3dmodel+xml"/><Default Extension="config" ContentType="text/xml"/></Types>'),
    '_rels/.rels': strToU8('<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Target="/3D/3dmodel.model" Id="rel0" Type="http://schemas.microsoft.com/3dmanufacturing/2013/01/3dmodel"/></Relationships>'),
    '3D/3dmodel.model': strToU8(model),
    'Metadata/model_settings.config': strToU8(modelSettings)
    // No Metadata/project_settings.config: OrcaSlicer crashes on a partial one (it expects the
    // full printer/filament profile), so the slot COLORS come from the user's own filament list.
  });
}

// Welds the non-indexed triangle soup by exact position (3MF requires shared vertices).
function indexedMesh(geometry) {
  const pos = geometry.getAttribute('position');
  const index = geometry.index;
  const count = index ? index.count : pos.count;
  const map = new Map();
  const vertices = [];
  const triangles = [];
  for (let i = 0; i < count; i++) {
    const vi = index ? index.getX(i) : i;
    const x = pos.getX(vi), y = pos.getY(vi), z = pos.getZ(vi);
    const key = `${x},${y},${z}`;
    let id = map.get(key);
    if (id === undefined) { id = vertices.length / 3; map.set(key, id); vertices.push(x, y, z); }
    triangles.push(id);
  }
  // Drop triangles that collapsed to a line/point after welding.
  const clean = [];
  for (let t = 0; t < triangles.length; t += 3) {
    const a = triangles[t], b = triangles[t + 1], c = triangles[t + 2];
    if (a !== b && b !== c && a !== c) clean.push(a, b, c);
  }
  return { vertices, triangles: clean };
}

export function save3MF(parts, baseName = 'keychain') {
  return window.api.saveExport({
    defaultName: `${sanitizeName(baseName)}.3mf`,
    filters: [{ name: '3MF', extensions: ['3mf'] }],
    data: encode3MF(parts)
  });
}

// Separate STL per color part: one save dialog for the base name, files get _<part> suffixes.
export function saveSplitSTL(parts, baseName = 'keychain') {
  return window.api.saveExportMulti({
    defaultName: `${sanitizeName(baseName)}.stl`,
    filters: [{ name: 'STL', extensions: ['stl'] }],
    files: parts.map(p => ({ suffix: `_${p.name}`, data: encodeModel(p.geometry, 'stl') }))
  });
}
