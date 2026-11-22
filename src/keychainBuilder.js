import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { dilate, erode, close, fillEnclosedHoles, boxBlurToField, signedDistanceField } from './maskOps.js';
import { traceField, signedArea } from './contourTrace.js';

// Flat, single-plane keychain builder.
//
// Unlike KeychainMaker (separate per-element meshes + bases that merely overlap in 3D, which
// exported as several overlapping shells), EVERYTHING here — every element, the outline border,
// the hole tab and its connector — is combined in ONE world-space binary mask first, then traced
// and turned into a single solid. Overlap/union/cut are all plain per-pixel boolean ops, so the
// exported mesh is always one clean closed solid per connected piece, with no 3D CSG anywhere
// (see KeychainMaker/HANDOFF.md "Why CSG was abandoned").
//
// items: [{ source: {canvas,width,height}, x, y, widthMM, heightMM, rotationDeg, flipX,
//           boldMM, smoothMM, mode: 'add'|'cut',
//           outlineMM, outlineShape, outlineSmoothMM, outlineFilletMM, outlineFlatness }]
// Each "add" element carries its OWN outline (distance + shape + smoothing); the outlines are
// then unioned (optionally closed by joinSmoothMM so neighbouring outlines blend together).
const DEFAULTS = {
  ppm: 10, thicknessMM: 3, joinSmoothMM: 0,
  fillHoles: false, minAreaMM2: 1,
  chamferTopMM: 0, chamferBottomMM: 0, chamferProfile: 'chamfer',
  holeEnabled: true, holeDiameterMM: 5, holeRingMM: 2.5, holeShape: 'circle', holeFilletMM: 1.5, holeAngleDeg: 0,
  holeX: null, holeY: null,
  splitColors: false
};

export function buildFlatKeychain(items, opts) {
  const o = { ...DEFAULTS, ...opts };
  const addItems = items.filter(i => i.mode !== 'cut');
  const cutItems = items.filter(i => i.mode === 'cut');
  if (!addItems.length) return null;

  // ── World raster bounds ──
  let world = null;
  for (const it of addItems) {
    let b = expand(itemBounds(it), Math.max(0, it.boldMM || 0) + (it.smoothMM || 0) + Math.max(0, it.outlineMM || 0));
    // Ellipse/capsule/rect outlines enclose the element's bbox, so they reach beyond it (≤ √2).
    if (it.outlineShape && it.outlineShape !== 'contour') b = scaleBounds(b, 1.45);
    world = unionBounds(world, expand(b, Math.max(0, it.outlineSmoothMM || 0)));
  }
  // Bases (opts.bases): each wraps the union of its target elements.
  // A base is either 'auto' (wraps its targets) or 'manual' (own position/size/rotation).
  const bases = (o.bases || []).map(b => ({ ...b, targets: addItems.filter(it => b.targetIds.includes(it.id)) }))
    .filter(b => b.baseSize === 'manual' || b.targets.length);
  for (const b of bases) {
    if (b.baseSize === 'manual') { world = unionBounds(world, expand(itemBounds(b), 1)); continue; }
    let tb = null;
    for (const it of b.targets) tb = unionBounds(tb, expand(itemBounds(it), Math.max(0, it.boldMM || 0) + (it.smoothMM || 0)));
    tb = expand(tb, Math.max(0, b.outlineMM || 0));
    if (b.outlineShape !== 'contour') tb = scaleBounds(tb, 1.45);
    world = unionBounds(world, expand(tb, Math.max(0, b.outlineSmoothMM || 0)));
  }
  world = expand(world, Math.max(0, o.joinSmoothMM) + 2);

  const holeR = o.holeDiameterMM / 2;
  const tabR = holeR + Math.max(0.4, o.holeRingMM);
  const tabReach = o.holeShape === 'rect' ? tabR * Math.SQRT2 : tabR;
  if (o.holeEnabled) {
    if (o.holeX != null) world = unionBounds(world, { minX: o.holeX - tabReach - 1, maxX: o.holeX + tabReach + 1, minY: world.minY, maxY: world.maxY });
    else world.minX -= 2 * tabReach + 2; // room for the auto-placed tab on the left
    if (o.holeY != null) world = unionBounds(world, { minX: world.minX, maxX: world.maxX, minY: o.holeY - tabReach - 1, maxY: o.holeY + tabReach + 1 });
  }

  // Cap raster size so a huge keychain can't lock the UI; quality degrades gracefully instead.
  const spanX = world.maxX - world.minX, spanY = world.maxY - world.minY;
  const ppm = Math.min(o.ppm, 8000 / spanX, 8000 / spanY, Math.sqrt(24e6 / (spanX * spanY)));
  // Snap the raster origin to a fixed world grid, so an element rasterizes to exactly the same
  // pixels no matter where OTHER elements are (keeps the auto hole perfectly still).
  world.minX = Math.floor(world.minX * ppm) / ppm;
  world.maxY = Math.ceil(world.maxY * ppm) / ppm;
  const w = Math.max(8, Math.ceil(spanX * ppm));
  const h = Math.max(8, Math.ceil(spanY * ppm));
  const toPx = (x, y) => [(x - world.minX) * ppm, (world.maxY - y) * ppm];
  const toMM = ([px, py]) => new THREE.Vector2(world.minX + (px + 0.5) / ppm, world.maxY - (py + 0.5) / ppm);

  const raster = createRasterizer(w, h, world, ppm);

  // 1+2. Per "add" element: its body (with boldness) → union into bodyMask; its own outline
  //      (round offset, optional enclosing shape, smoothing) → union into mask.
  const bodyMask = new Uint8Array(w * h);
  let mask = new Uint8Array(w * h);
  let anchorMask = null; // outline of the first element (or first base) — the auto hole attaches to it
  const bodyById = new Map();
  // Color-split images: their body divided into one region per detected color (see sources.js).
  const colorRegions = []; // [{ itemId, name, color, mask }]
  for (const it of addItems) {
    const m = raster(it);
    bodyById.set(it.id, m);
    if (it.colorSplit && it.source.colorLayers && it.source.colorLayers.length > 1) {
      colorRegions.push(...splitByColor(it, m, raster, w, h));
    }
    orInto(bodyMask, m);
    let om = it.outlineMM > 0 ? dilate(m, w, h, it.outlineMM * ppm) : Uint8Array.from(m);
    if (it.outlineShape === 'ends' && it.source.firstRange) {
      // Outline follows only the first and last character; the middle is bridged by straight
      // tangent lines (convex hull of the two offset end blobs). Middle characters that poke
      // outside the hull still count as material (unioned with the body itself).
      const d = (mm) => (it.outlineMM > 0 ? dilate(mm, w, h, it.outlineMM * ppm) : mm);
      const [cx, cy] = [(it.x - world.minX) * ppm, (world.maxY - it.y) * ppm];
      const hull = rasterEqualEndsHull(d(raster(it, it.source.firstRange)), d(raster(it, it.source.lastRange)), w, h, cx, cy, it.rotationDeg || 0);
      if (hull) { om = hull; orInto(om, m); }
    } else if (it.outlineShape && it.outlineShape !== 'contour' && it.outlineShape !== 'ends') {
      const shapeMask = rasterEnclosingShape(om, w, h, it, ppm);
      if (shapeMask) orInto(om, shapeMask);
    }
    if (it.outlineSmoothMM > 0) om = close(om, w, h, it.outlineSmoothMM * ppm);
    if (!anchorMask) anchorMask = om;
    orInto(mask, om);
  }
  // Raised ("relief") bases: the base is a plate at the normal thickness and every element it
  // carries stands up by that element's own relief height (it.reliefMM), or — for text with
  // alternating heights — by altOddMM / altEvenMM per character. raisedMask = union of all
  // raised elements (used to grow the plate under relief that overhangs the base).
  // Each raised element is kept as its OWN relief record (mask, per-pixel heights, color): in the
  // two-level mode every element becomes a separate solid standing on the plate.
  let raisedMask = null, plateColor = null;
  const raisedItems = [];
  const addRaisedItem = (it, through, skinMM) => {
    if (raisedItems.some(r => r.id === it.id)) return;
    raisedMask = raisedMask || new Uint8Array(w * h);
    const heightAt = itemHeightFn(it, world, ppm);
    // A color-split image becomes one relief record per color region (each its own part/color).
    const regions = colorRegions.filter(r => r.itemId === it.id);
    const pieces = regions.length
      ? regions.map(r => ({ m: r.mask, name: r.name, color: r.color, colorIndex: r.colorIndex }))
      : [{ m: bodyById.get(it.id), name: it.partName || `element ${it.id}`, color: it.color || '#ff8a3d', colorIndex: null }];
    for (const pc of pieces) {
      const own = new Uint8Array(w * h), heights = new Float32Array(w * h);
      for (let i = 0; i < pc.m.length; i++) {
        if (!pc.m[i]) continue;
        // a color region may have its own height (Parts panel → it.layerHeights[c])
        const ovr = pc.colorIndex != null && it.layerHeights ? it.layerHeights[pc.colorIndex] : null;
        const hMM = ovr > 0 ? ovr : heightAt(i % w, (i / w) | 0);
        if (!(hMM > 0)) continue;
        own[i] = 1; heights[i] = hMM; raisedMask[i] = 1;
      }
      raisedItems.push({ id: it.id, name: pc.name, color: pc.color, mask: own, heights, through, skinMM, colorIndex: pc.colorIndex });
    }
  };
  const addRaised = (b, items) => {
    if (b.baseStyle !== 'raised') return;
    if (!plateColor) plateColor = b.color || '#f2f2f2';
    for (const it of items) addRaisedItem(it, !!b.colorThrough, b.skinMM ?? 0.6);
  };
  for (const b of bases) {
    if (b.baseSize === 'manual') {
      const bm = rasterFreeShape(b, w, h, world, ppm);
      if (b.baseStyle === 'raised') {
        // Manual base: raise every element whose body touches its footprint (the whole element).
        const onBase = addItems.filter(it => {
          const m = bodyById.get(it.id);
          for (let i = 0; i < m.length; i++) if (m[i] && bm[i]) return true;
          return false;
        });
        addRaised(b, onBase);
      }
      if (b === bases[0]) anchorMask = bm;
      orInto(mask, bm);
      continue;
    }
    const u = new Uint8Array(w * h);
    for (const it of b.targets) orInto(u, bodyById.get(it.id));
    addRaised(b, b.targets);
    const dist = Math.max(0, b.outlineMM || 0) * ppm;
    let bm = dist > 0 ? dilate(u, w, h, dist) : u;
    if (b.outlineShape === 'ends' && b.targets.length >= 2) {
      // Leftmost and rightmost target elements, bridged straight, equal heights (world frame).
      const sorted = b.targets.slice().sort((p, q) => p.x - q.x);
      const d = (mm) => (dist > 0 ? dilate(mm, w, h, dist) : mm);
      const hull = rasterEqualEndsHull(d(bodyById.get(sorted[0].id)), d(bodyById.get(sorted[sorted.length - 1].id)), w, h, 0, 0, 0);
      if (hull) { orInto(hull, u); bm = hull; }
    } else if (b.outlineShape && b.outlineShape !== 'contour' && b.outlineShape !== 'ends') {
      const shapeMask = rasterEnclosingShape(bm, w, h, b, ppm);
      if (shapeMask) orInto(bm, shapeMask);
    }
    if (b.outlineSmoothMM > 0) bm = close(bm, w, h, b.outlineSmoothMM * ppm);
    if (b === bases[0]) anchorMask = bm;
    orInto(mask, bm);
  }
  if (o.joinSmoothMM > 0) mask = close(mask, w, h, o.joinSmoothMM * ppm);
  if (o.fillHoles) mask = fillEnclosedHoles(mask, w, h);

  // 3. Hole tab + connector strut, unioned BEFORE the hole is cut (union-first-then-cut, so the
  //    cut can never sever the only bridge — lesson carried over from KeychainMaker).
  let holeCenter = null;
  if (o.holeEnabled) {
    // Auto position = left-middle of the FIRST element's outline, so adding/moving other
    // elements never drags the hole along with them.
    const mb = maskBounds(anchorMask, w, h);
    if (mb) {
      const left = toMM([mb.minX, 0]).x - 0.5 / ppm;
      const midY = (toMM([0, mb.minY]).y + toMM([0, mb.maxY]).y) / 2;
      holeCenter = { x: o.holeX ?? left - holeR - Math.min(1, o.holeRingMM * 0.4), y: o.holeY ?? midY };
      const [hcx, hcy] = toPx(holeCenter.x, holeCenter.y);
      const tabPx = tabR * ppm;
      const nearest = nearestSetPixel(mask, w, h, hcx, hcy);
      if (o.holeShape === 'rect') stampRoundedSquare(mask, w, h, hcx, hcy, tabPx, o.holeFilletMM * ppm, o.holeAngleDeg);
      else stampCapsule(mask, w, h, hcx, hcy, hcx, hcy, tabPx);
      if (nearest && nearest.dist > tabPx - 0.3 * ppm) {
        const dx = nearest.x - hcx, dy = nearest.y - hcy;
        const len = Math.hypot(dx, dy) || 1;
        const over = 1.0 * ppm; // overshoot into real material so the joint is solid, not tangent
        const strutHalf = Math.min(tabPx, Math.max(1.5, o.holeRingMM) * ppm);
        stampCapsule(mask, w, h, hcx, hcy, nearest.x + (dx / len) * over, nearest.y + (dy / len) * over, strutHalf);
      }
    }
  }

  // 4. Cut-through elements and the hole itself (from both the whole piece and the body).
  const cutMask = new Uint8Array(w * h);
  for (const it of cutItems) {
    const m = raster(it);
    subtractFrom(mask, m);
    subtractFrom(bodyMask, m);
    if (raisedMask) subtractFrom(raisedMask, m);
    for (const r of raisedItems) subtractFrom(r.mask, m);
    orInto(cutMask, m);
  }
  if (holeCenter) {
    const [hcx, hcy] = toPx(holeCenter.x, holeCenter.y);
    clearDisk(mask, w, h, hcx, hcy, holeR * ppm);
    clearDisk(bodyMask, w, h, hcx, hcy, holeR * ppm);
    if (raisedMask) clearDisk(raisedMask, w, h, hcx, hcy, holeR * ppm);
    for (const r of raisedItems) clearDisk(r.mask, w, h, hcx, hcy, holeR * ppm);
    const disk = new Uint8Array(w * h);
    stampCapsule(disk, w, h, hcx, hcy, hcx, hcy, holeR * ppm);
    orInto(cutMask, disk);
  }
  // Vertical drilled holes (cylinder straight down through everything) — same as the key-ring
  // hole, so the chamfer also rounds their edges. Horizontal holes are cut later in 3D (app.js).
  for (const dh of o.drillHoles || []) {
    const [dcx, dcy] = toPx(dh.x, dh.y);
    const r = dh.r * ppm;
    clearDisk(mask, w, h, dcx, dcy, r);
    clearDisk(bodyMask, w, h, dcx, dcy, r);
    if (raisedMask) clearDisk(raisedMask, w, h, dcx, dcy, r);
    for (const ri of raisedItems) clearDisk(ri.mask, w, h, dcx, dcy, r);
    const disk = new Uint8Array(w * h);
    stampCapsule(disk, w, h, dcx, dcy, dcx, dcy, r);
    orInto(cutMask, disk);
  }

  // 4b. Minimum feature width (printer nozzle): morphological opening by half the width removes
  //     every part thinner than minFeatureMM (hairlines, thin serifs, slivers) while leaving
  //     thicker parts unchanged apart from a tiny rounding of convex corners. Opening is
  //     monotone, so the body stays inside the whole piece.
  let removedMM2 = 0;
  const openR = (o.minFeatureMM || 0) / 2 * ppm;
  if (openR >= 0.5) {
    let before = 0, after = 0;
    for (let i = 0; i < mask.length; i++) before += mask[i];
    mask = dilate(erode(mask, w, h, openR), w, h, openR);
    const openedBody = dilate(erode(bodyMask, w, h, openR), w, h, openR);
    for (let i = 0; i < mask.length; i++) { after += mask[i]; bodyMask[i] = openedBody[i] & mask[i]; }
    if (raisedMask) raisedMask = dilate(erode(raisedMask, w, h, openR), w, h, openR);
    for (const r of raisedItems) r.mask = dilate(erode(r.mask, w, h, openR), w, h, openR);
    removedMM2 = (before - after) / (ppm * ppm);
  }

  // 5. Mask → solid(s).
  const T = o.thicknessMM;
  let cb = Math.max(0, o.chamferBottomMM || 0), ct = Math.max(0, o.chamferTopMM || 0);
  const maxTotal = Math.max(0, T - 0.2);
  if (cb + ct > maxTotal) { const f = maxTotal / (cb + ct); cb *= f; ct *= f; }

  let raised = null;
  if (raisedMask) {
    // The relief must sit strictly inside the plate's top face (see buildChamfered). Where a
    // raised element reaches past the base's edge, grow the plate under it by a thin lip instead
    // of clipping the relief away — then re-apply the cut-throughs and the key-ring hole.
    const lipPx = ct * ppm + Math.max(1.5, 0.1 * ppm) + 1;
    const lip = dilate(raisedMask, w, h, lipPx);
    for (let i = 0; i < mask.length; i++) mask[i] = (mask[i] | lip[i]) & (cutMask[i] ^ 1);
    for (let i = 0; i < raisedMask.length; i++) raisedMask[i] &= mask[i];
    for (const r of raisedItems) for (let i = 0; i < r.mask.length; i++) r.mask[i] &= mask[i];
    raised = { items: raisedItems, plateColor: plateColor || '#f2f2f2' };
  }

  // Final color regions = what's left of each after cuts/holes/min-feature (bodyMask).
  for (const r of colorRegions) for (let i = 0; i < r.mask.length; i++) r.mask[i] &= bodyMask[i];
  const ctx = {
    mask, bodyMask, w, h, ppm, toMM, T, minAreaMM2: o.minAreaMM2, splitColors: o.splitColors,
    colorRegions, bodyColor: o.bodyColor || '#ff8a3d', borderColor: o.borderColor || '#f2f2f2',
    // Flat two-color: colors only as skins on the top and bottom faces (the core is border
    // color, so a sideways hole shows border color) — needs room for two skins + a core.
    skinMM: o.splitColors && o.colorSkin !== false && !raised && T >= 2 * (o.colorSkinMM ?? 0.8) + 0.2 ? (o.colorSkinMM ?? 0.8) : 0,
    glue: raised && o.glue ? o.glue : null
  };
  // Chamfers and raised relief both need the layered (multi-height) builder.
  const solid = (cb > 0.01 || ct > 0.01 || raised || ctx.skinMM > 0)
    ? buildChamfered(ctx, cb, ct, o.chamferProfile, raised)
    : buildStraight(ctx);
  if (!solid) return null;

  solid.geometry.computeBoundingBox();
  const bb = solid.geometry.boundingBox;
  return {
    geometry: solid.geometry,
    colorParts: solid.colorParts,
    parts: solid.parts || null,
    pieces: solid.pieces,
    holeCenter,
    removedMM2,
    heightMM: bb.max.z - bb.min.z,
    tabRadius: holeCenter ? tabR : 0,
    bounds: { minX: bb.min.x, maxX: bb.max.x, minY: bb.min.y, maxY: bb.max.y },
    ppm
  };
}

// ── Straight walls (no chamfer): trace once, ExtrudeGeometry ──
function buildStraight({ mask, bodyMask, w, h, ppm, toMM, T, minAreaMM2, splitColors, colorRegions = [], bodyColor, borderColor }) {
  const field = boxBlurToField(mask, w, h, 1, 1);
  const polysToShapes = (polys) => {
    const shapes = [];
    for (const poly of polys) {
      if (Math.abs(signedArea(poly.outer)) / (ppm * ppm) < minAreaMM2) continue;
      const shape = new THREE.Shape(poly.outer.map(toMM));
      for (const hole of poly.holes) {
        if (Math.abs(signedArea(hole)) / (ppm * ppm) < minAreaMM2) continue;
        shape.holes.push(new THREE.Path(hole.map(toMM)));
      }
      shapes.push(shape);
    }
    return shapes;
  };
  const shapes = polysToShapes(traceField(field, w, h, { simplifyTolerance: 0.25, smoothIterations: 1 }));
  if (!shapes.length) return null;
  const geometry = extrudeShapes(shapes, T);

  // Two-color split: "body" (the elements) and "border" (outline + hole tab). The border field
  // is min(whole, 1 - body), so its inner edge is the SAME 0.5 iso-line as the body's edge —
  // marching squares puts the shared boundary vertices at identical positions for both parts
  // (no gap, no overlap between colors). RDP is disabled here because it's global per loop and
  // would make the two sides of the shared edge diverge; Chaikin is local, so they stay matched.
  let colorParts = null;
  if (splitColors) {
    const bodyField = boxBlurToField(bodyMask, w, h, 1, 1);
    const borderField = new Float32Array(w * h);
    for (let i = 0; i < w * h; i++) borderField[i] = Math.min(field[i], 1 - bodyField[i]);
    const traceOpts = { simplifyTolerance: 0, smoothIterations: 1 };
    const bodyShapes = polysToShapes(traceField(bodyField, w, h, traceOpts));
    const borderShapes = polysToShapes(traceField(borderField, w, h, traceOpts));
    if (bodyShapes.length && borderShapes.length) {
      colorParts = { body: extrudeShapes(bodyShapes, T), border: extrudeShapes(borderShapes, T) };
    }
    // Color-split images: the body is further divided by color → one part per color region
    // (+ "body" for everything not covered by a color region), next to the border part — which
    // may not exist at all (no outline, no hole tab: "borderless").
    if (colorRegions.length) {
      const parts = [];
      if (borderShapes.length) parts.push({ key: 'border', kind: 'border', name: 'border', color: borderColor, geometry: extrudeShapes(borderShapes, T) });
      if (colorParts) { colorParts.body.dispose(); colorParts.border.dispose(); }
      for (const rg of [...colorRegions, restRegion(bodyMask, colorRegions, bodyColor)].filter(Boolean)) {
        const shp = polysToShapes(traceField(boxBlurToField(rg.mask, w, h, 1, 1), w, h, traceOpts));
        if (shp.length) parts.push({ ...partMeta(rg.itemId, rg.colorIndex), name: rg.name, color: rg.color, geometry: extrudeShapes(shp, T) });
      }
      return { geometry, colorParts: null, parts, pieces: shapes.length };
    }
  }
  return { geometry, colorParts, pieces: shapes.length };
}

// Divides one color-split image's body mask m into its color regions: each pixel goes to the
// layer drawn strongest there; pixels no layer reaches (e.g. added by boldness) take the
// nearest labeled neighbor's color.
function splitByColor(it, m, raster, w, h) {
  const layers = it.source.colorLayers;
  const alphas = layers.map(L => raster({ ...it, boldMM: 0, source: L }, null, true));
  const label = new Int8Array(w * h).fill(-1);
  const queue = new Int32Array(w * h);
  let qh = 0, qt = 0;
  for (let i = 0; i < w * h; i++) {
    if (!m[i]) continue;
    let best = -1, bestA = 0;
    for (let c = 0; c < alphas.length; c++) if (alphas[c][i] > bestA) { bestA = alphas[c][i]; best = c; }
    if (best >= 0) { label[i] = best; queue[qt++] = i; }
  }
  while (qh < qt) {
    const i = queue[qh++], x = i % w;
    for (const j of [x > 0 ? i - 1 : -1, x < w - 1 ? i + 1 : -1, i - w, i + w]) {
      if (j < 0 || j >= w * h || !m[j] || label[j] >= 0) continue;
      label[j] = label[i];
      queue[qt++] = j;
    }
  }
  return layers.map((L, c) => {
    const mask = new Uint8Array(w * h);
    for (let i = 0; i < w * h; i++) if (label[i] === c) mask[i] = 1;
    return { itemId: it.id, colorIndex: c, name: `${it.partName || 'image'}_สี${c + 1}`, color: (it.layerColors && it.layerColors[c]) || L.color, mask };
  });
}

// Stable identity of an output part, so UI edits map back to the right element / color.
function partMeta(elementId, colorIndex) {
  if (elementId == null) return { key: 'body', kind: 'body', elementId: null, colorIndex: null };
  return colorIndex != null
    ? { key: `${elementId}:c${colorIndex}`, kind: 'region', elementId, colorIndex }
    : { key: `${elementId}`, kind: 'element', elementId, colorIndex: null };
}

// Body pixels not covered by any color region (other elements) → a plain "body" region.
function restRegion(bodyMask, regions, color) {
  const mask = Uint8Array.from(bodyMask);
  for (const r of regions) for (let i = 0; i < mask.length; i++) if (r.mask[i]) mask[i] = 0;
  let any = false;
  for (let i = 0; i < mask.length && !any; i++) any = mask[i] === 1;
  return any ? { itemId: null, colorIndex: null, name: 'body', color, mask } : null;
}

function extrudeShapes(shapes, thicknessMM) {
  const geoms = shapes.map(s => new THREE.ExtrudeGeometry(s, { depth: thicknessMM, bevelEnabled: false, steps: 1, curveSegments: 1 }));
  if (geoms.length === 1) return geoms[0];
  const merged = mergeGeometries(geoms);
  geoms.forEach(g => g.dispose());
  return merged;
}

// ── Chamfered solid ──
//
// The chamfer is built as a stack of layers, each a vertical wall of the iso-line
// "signed distance = inset" of ONE shared distance field, joined by horizontal rings
// (region(layer i) minus region(layer i+1)). Because every iso-line comes from the same distance
// field they are strictly nested and never cross, and each loop's exact vertices are reused by
// its wall AND the ring/cap on either side — so the result is a closed 2-manifold with no CSG,
// and it chamfers every edge uniformly: outer silhouette, letter counters, cut-throughs and the
// key-ring hole alike. Steps are ≤ ~0.15mm tall — finer than a print layer, so the slicer output
// matches a smooth chamfer.
function buildChamfered({ mask, bodyMask, w, h, ppm, toMM, T, minAreaMM2, splitColors, colorRegions = [], bodyColor, borderColor, skinMM = 0, glue = null }, cb, ct, profile, raised = null) {
  const sd = signedDistanceField(mask, w, h);
  const cache = new Map();
  const loopsAt = (insetPx) => {
    const key = insetPx.toFixed(4);
    if (!cache.has(key)) cache.set(key, traceLoops(sd, w, h, insetPx, toMM, minAreaMM2));
    return cache.get(key);
  };
  const layers = chamferLayers(T, cb, ct, profile, ppm).map(L => ({ ...L, field: 'plate', loops: loopsAt(L.insetPx) }));
  const baseRegions = regionsFromLoops(loopsAt(0));
  if (!baseRegions.length) return null;

  // Two-level piece: the plate is one closed solid, and every raised element is its OWN closed
  // solid standing on the plate's top face at its own height(s), in its own color — elements
  // don't have to fuse (overlaps between elements are left to the slicer, like separate parts).
  // An element with "color through" instead runs from the bottom up, and the plate gets its
  // footprint (kept inside the plate's top face) as a cavity so the two meet exactly.
  if (raised && raised.items.length) {
    // keepOut also clears the bottom chamfer: a "color through" skin sits in the plate's bottom face.
    const keepOut = Math.max(cb, ct) * ppm + Math.max(1.5, 0.1 * ppm);
    const parts = [];
    // "Color through" = the element's color shows on the BOTTOM face too, but only as a thin skin
    // (skinMM) — the core of the base stays base-colored, so a drilled hole shows base color.
    // Glue split (export option): the relief prints SEPARATELY from the base — the base gets a
    // recess (depth glue.depthMM) shaped like the relief's footprint, and every relief part gets
    // a tab below the base top that drops into it, inset by glue.gapMM so it fits.
    if (glue) return buildGlueSplit(raised, layers, sd, keepOut, glue, { w, h, ppm, toMM, T, minAreaMM2, pieces: baseRegions.length });
    const throughItems = raised.items.filter(r => r.through);
    const skinZ = throughItems.length
      ? Math.max(0.2, Math.min(Math.max(...throughItems.map(r => r.skinMM || 0.6)), T - ct - 0.2))
      : 0;
    for (const r of raised.items) {
      const tiers = reliefTiers(r, r.through ? sd : null, keepOut, w, h, toMM, minAreaMM2);
      if (!tiers.length) continue;
      const tierLayers = tiers.map((t, k) => ({
        loops: t.loops, z0: T + (k ? tiers[k - 1].heightMM : 0), z1: T + t.heightMM, insetPx: 0, field: `tier${k}`
      }));
      const pos = [];
      addStack(pos, tierLayers);
      if (r.through) addStack(pos, [{ loops: tiers[0].loops, z0: 0, z1: skinZ, insetPx: 0 }]);
      parts.push({ ...partMeta(r.id, r.colorIndex), name: r.name, color: r.color, geometry: geometryFrom(pos) });
    }
    if (parts.length) {
      let plate;
      if (throughItems.length) {
        // Pocket in the plate's bottom face = union of all "through" footprints (kept inside
        // the plate past the chamfers, like the skins themselves).
        const u = new Uint8Array(w * h);
        for (const r of throughItems) for (let i = 0; i < u.length; i++) if (r.mask[i] && r.heights[i] > 0) u[i] = 1;
        const sdU = signedDistanceField(u, w, h);
        const f = new Float32Array(w * h);
        for (let i = 0; i < f.length; i++) f[i] = Math.min(sdU[i], sd[i] - keepOut);
        plate = buildPlateWithPocket(layers, traceLoops(f, w, h, 0, toMM, minAreaMM2), skinZ);
      } else {
        plate = buildLayeredSolid(layers, []);
      }
      parts.unshift({ key: 'base', kind: 'base', name: 'base', color: raised.plateColor, geometry: plate });
      // The single-body geometry (plain STL/OBJ export) is the FUSED version instead: one clean
      // 2-manifold where every pixel still ends at its own element's height (tallest wins where
      // elements overlap) — stacking the separate parts would leave coincident walls/faces.
      const union = { mask: new Uint8Array(w * h), heights: new Float32Array(w * h) };
      for (const r of raised.items) {
        for (let i = 0; i < r.mask.length; i++) {
          if (!r.mask[i]) continue;
          union.mask[i] = 1;
          if (r.heights[i] > union.heights[i]) union.heights[i] = r.heights[i];
        }
      }
      const tiers = reliefTiers(union, sd, keepOut, w, h, toMM, minAreaMM2);
      const tierLayers = tiers.map((t, k) => ({
        loops: t.loops, z0: T + (k ? tiers[k - 1].heightMM : 0), z1: T + t.heightMM, insetPx: 0, field: `tier${k}`
      }));
      const geometry = buildLayeredSolid([...layers, ...tierLayers], []);
      return { geometry, colorParts: null, parts, pieces: baseRegions.length };
    }
  }
  const geometry = buildLayeredSolid(layers, []);

  // Two-color split with chamfer: the body is kept a little inside the deepest chamfer inset
  // (so it's a plain straight-walled column), and the border is the chamfered solid with the
  // body's loops as full-height inner walls. Both use the very same body loops → exact match.
  let colorParts = null;
  if (splitColors) {
    const sdBody = signedDistanceField(bodyMask, w, h);
    // Without chamfers the color only has to stay strictly inside the plate outline (separate,
    // non-touching loops) → a sub-pixel gap, so the face color reaches the real edge.
    const keepOut = cb > 0.01 || ct > 0.01 ? Math.max(cb, ct) * ppm + Math.max(1.5, 0.1 * ppm) : 0.75;
    const f = new Float32Array(w * h);
    for (let i = 0; i < w * h; i++) f[i] = Math.min(sdBody[i], sd[i] - keepOut);
    // (relief without color split: the relief simply rides on the plate — handled above)
    const bodyLoops = traceLoops(f, w, h, 0, toMM, minAreaMM2);
    if (bodyLoops.some(l => loopArea(l) > 0)) {
      // skinMM > 0: color parts are thin skins on both faces, and the border fills the core
      // (its pockets top and bottom take the skins). Otherwise: full-height color columns.
      const border = skinMM > 0
        ? buildPlateWithPockets(layers, bodyLoops, skinMM, T - skinMM)
        : buildLayeredSolid(layers, bodyLoops.map(reversed));
      const colorSolid = (loops) => {
        if (!skinMM) return buildLayeredSolid([{ loops, z0: 0, z1: T, insetPx: 0 }], []);
        const pos = [];
        addStack(pos, [{ loops, z0: 0, z1: skinMM, insetPx: 0 }]);
        addStack(pos, [{ loops, z0: T - skinMM, z1: T, insetPx: 0 }]);
        return geometryFrom(pos);
      };
      if (colorRegions.length) {
        // Color-split images: one straight column per color region (kept inside the chamfer
        // like the body), filling the border's cavity.
        const parts = [{ key: 'border', kind: 'border', name: 'border', color: borderColor, geometry: border }];
        for (const rg of [...colorRegions, restRegion(bodyMask, colorRegions, bodyColor)].filter(Boolean)) {
          const sdR = signedDistanceField(rg.mask, w, h);
          const fr = new Float32Array(w * h);
          for (let i = 0; i < w * h; i++) fr[i] = Math.min(sdR[i], sd[i] - keepOut);
          const loops = traceLoops(fr, w, h, 0, toMM, minAreaMM2);
          if (loops.some(l => loopArea(l) > 0)) parts.push({ ...partMeta(rg.itemId, rg.colorIndex), name: rg.name, color: rg.color, geometry: colorSolid(loops) });
        }
        return { geometry, colorParts: null, parts, pieces: baseRegions.length };
      }
      colorParts = { body: colorSolid(bodyLoops), border };
    }
  }
  return { geometry, colorParts, pieces: baseRegions.length };
}

// Layers bottom→top: [{ insetPx, z0, z1 }], consecutive layers always differ in inset.
function chamferLayers(T, cb, ct, profile, ppm) {
  const steps = (c) => Math.max(1, Math.min(40, Math.round((c * ppm) / 1.5)));
  const raw = [];
  // Bottom: inset goes from ~cb (at z=0) to 0 (at z=cb).
  if (cb > 0) {
    const n = steps(cb);
    for (let j = 0; j < n; j++) {
      if (profile === 'round') {
        const a0 = (Math.PI / 2) * j / n, a1 = (Math.PI / 2) * (j + 1) / n, am = (a0 + a1) / 2;
        raw.push({ inset: cb * (1 - Math.sin(am)), z0: cb * (1 - Math.cos(a0)), z1: cb * (1 - Math.cos(a1)) });
      } else {
        raw.push({ inset: cb * (1 - (j + 0.5) / n), z0: (cb * j) / n, z1: (cb * (j + 1)) / n });
      }
    }
  }
  if (T - ct > cb + 1e-6) raw.push({ inset: 0, z0: cb, z1: T - ct });
  // Top: mirror image — inset goes from 0 (at z=T-ct) to ~ct (at z=T).
  if (ct > 0) {
    const n = steps(ct);
    const zj = T - ct;
    for (let j = 0; j < n; j++) {
      if (profile === 'round') {
        const a0 = (Math.PI / 2) * j / n, a1 = (Math.PI / 2) * (j + 1) / n, am = (a0 + a1) / 2;
        raw.push({ inset: ct * (1 - Math.cos(am)), z0: zj + ct * Math.sin(a0), z1: zj + ct * Math.sin(a1) });
      } else {
        raw.push({ inset: (ct * (j + 0.5)) / n, z0: zj + (ct * j) / n, z1: zj + (ct * (j + 1)) / n });
      }
    }
  }
  // Merge layers whose inset differs by < 1px (their iso-lines would be too close to nest safely).
  const out = [];
  for (const L of raw) {
    const prev = out[out.length - 1];
    if (prev && Math.abs(prev.inset - L.inset) * ppm < 1) prev.z1 = L.z1;
    else out.push({ ...L });
  }
  return out.map(L => ({ insetPx: L.inset * ppm, z0: L.z0, z1: L.z1 }));
}

// Loops (mm, THREE.Vector2[]) of the iso-line field == iso, normalized: outers CCW, holes CW.
function traceLoops(field, w, h, iso, toMM, minAreaMM2) {
  const polys = traceField(field, w, h, { iso, outside: -1e9, simplifyTolerance: 0.2, smoothIterations: 1 });
  const loops = [];
  for (const poly of polys) {
    const outer = poly.outer.map(toMM);
    const a = loopArea(outer);
    if (Math.abs(a) < minAreaMM2) continue;
    loops.push(a > 0 ? outer : outer.reverse());
    for (const holePx of poly.holes) {
      const hole = holePx.map(toMM);
      const ha = loopArea(hole);
      if (Math.abs(ha) < minAreaMM2) continue;
      loops.push(ha < 0 ? hole : hole.reverse());
    }
  }
  return loops;
}

// layers: [{ loops, z0, z1, insetPx }] contiguous bottom→top. innerLoops: extra full-height
// loops (already oriented as holes/outers of this solid) — used for the border part's cavity.
function buildLayeredSolid(layers, innerLoops) {
  const pos = [];
  addStack(pos, layers, { bottomExtra: innerLoops, topExtra: innerLoops });
  addWalls(pos, innerLoops, layers[0].z0, layers[layers.length - 1].z1);
  return geometryFrom(pos);
}

// Plate with a shallow pocket in its bottom face (0..pocketZ) — where the "color through" skins
// sit. The layer stack is split at pocketZ; the pocket's walls run 0..pocketZ and its ceiling
// faces down at pocketZ. The pocket loops lie strictly inside every plate layer (keepOut), so
// the plate's own rings never touch them.
function buildPlateWithPocket(layers, pocketLoops, pocketZ) {
  if (!pocketLoops.some(l => loopArea(l) > 0)) return buildLayeredSolid(layers, []);
  const L = [];
  for (const layer of layers) {
    if (layer.z0 < pocketZ - 1e-6 && layer.z1 > pocketZ + 1e-6) {
      L.push({ ...layer, z1: pocketZ });
      L.push({ ...layer, z0: pocketZ });
    } else {
      L.push(layer);
    }
  }
  const pos = [];
  const holes = pocketLoops.map(reversed);
  addCap(pos, regionsFromLoops([...L[0].loops, ...holes]), L[0].z0, false);
  addCap(pos, regionsFromLoops(L[L.length - 1].loops), L[L.length - 1].z1, true);
  for (const layer of L) addWalls(pos, layer.loops, layer.z0, layer.z1);
  addWalls(pos, holes, L[0].z0, pocketZ);
  addCap(pos, regionsFromLoops(pocketLoops), pocketZ, false); // pocket ceiling
  for (let i = 0; i < L.length - 1; i++) {
    const A = L[i], B = L[i + 1];
    if (A.loops === B.loops) continue; // the split point: same outline, nothing to join
    if (B.insetPx > A.insetPx) addCap(pos, regionsFromLoops([...A.loops, ...B.loops.map(reversed)]), A.z1, true);
    else addCap(pos, regionsFromLoops([...B.loops, ...A.loops.map(reversed)]), A.z1, false);
  }
  return geometryFrom(pos);
}

// Glue split: base with a top recess + relief parts with tabs (see buildChamfered).
// Recess = union of the relief footprints (each kept inside the plate's top face like the relief
// itself); tab = the part's own footprint shrunk by gapPx, from the recess floor up to the base
// top, where the normal relief tiers continue. Positions are the assembled ones (app.js lays
// the parts out on the bed).
function buildGlueSplit(raised, layers, sd, keepOut, glue, { w, h, ppm, toMM, T, minAreaMM2, pieces }) {
  const D = Math.max(0.2, Math.min(glue.depthMM || 1, T - 0.6)); // keep ≥ 0.6 mm of floor
  const gapPx = Math.max(1, (glue.gapMM ?? 0.15) * ppm);
  const floorZ = T - D;
  const fieldOf = (m) => {
    const s = signedDistanceField(m, w, h);
    const f = new Float32Array(w * h);
    for (let i = 0; i < f.length; i++) f[i] = Math.min(s[i], sd[i] - keepOut);
    return f;
  };
  const union = new Uint8Array(w * h);
  const parts = [];
  for (const r of raised.items) {
    const tiers = reliefTiers(r, sd, keepOut, w, h, toMM, minAreaMM2);
    if (!tiers.length) continue;
    const m = new Uint8Array(w * h);
    for (let i = 0; i < m.length; i++) if (r.mask[i] && r.heights[i] > 0) { m[i] = 1; union[i] = 1; }
    const f = fieldOf(m);
    for (let i = 0; i < f.length; i++) f[i] -= gapPx;
    const tab = traceLoops(f, w, h, 0, toMM, minAreaMM2);
    const tierLayers = tiers.map((t, k) => ({
      loops: t.loops, z0: T + (k ? tiers[k - 1].heightMM : 0), z1: T + t.heightMM, insetPx: 0, field: `tier${k}`
    }));
    const pos = [];
    // tab below (insetPx 1 > tier's 0 → the ring at z=T faces down: tier wider than the tab)
    addStack(pos, tab.some(l => loopArea(l) > 0) ? [{ loops: tab, z0: floorZ, z1: T, insetPx: 1 }, ...tierLayers] : tierLayers);
    parts.push({ ...partMeta(r.id, r.colorIndex), name: r.name, color: r.color, geometry: geometryFrom(pos), glueRelief: true });
  }
  const recess = traceLoops(fieldOf(union), w, h, 0, toMM, minAreaMM2);
  const plate = buildPlateWithTopPocket(layers, recess, floorZ);
  parts.unshift({ key: 'base', kind: 'base', name: 'base', color: raised.plateColor, geometry: plate });
  return { geometry: plate, colorParts: null, parts, pieces, glue: { depthMM: D, gapMM: gapPx / ppm } };
}

// Plate with a recess in its TOP face (pocketZ..top), pocket loops strictly inside the top face.
function buildPlateWithTopPocket(layers, pocketLoops, pocketZ) {
  if (!pocketLoops.some(l => loopArea(l) > 0)) return buildLayeredSolid(layers, []);
  const L = [];
  for (const layer of layers) {
    if (layer.z0 < pocketZ - 1e-6 && layer.z1 > pocketZ + 1e-6) { L.push({ ...layer, z1: pocketZ }); L.push({ ...layer, z0: pocketZ }); }
    else L.push(layer);
  }
  const pos = [];
  const holes = pocketLoops.map(reversed);
  const zTop = L[L.length - 1].z1;
  addCap(pos, regionsFromLoops(L[0].loops), L[0].z0, false);
  addCap(pos, regionsFromLoops([...L[L.length - 1].loops, ...holes]), zTop, true);
  for (const layer of L) addWalls(pos, layer.loops, layer.z0, layer.z1);
  addWalls(pos, holes, pocketZ, zTop);
  addCap(pos, regionsFromLoops(pocketLoops), pocketZ, true); // recess floor
  for (let i = 0; i < L.length - 1; i++) {
    const A = L[i], B = L[i + 1];
    if (A.loops === B.loops) continue;
    if (B.insetPx > A.insetPx) addCap(pos, regionsFromLoops([...A.loops, ...B.loops.map(reversed)]), A.z1, true);
    else addCap(pos, regionsFromLoops([...B.loops, ...A.loops.map(reversed)]), A.z1, false);
  }
  return geometryFrom(pos);
}

// Plate with shallow pockets in BOTH faces: 0..bottomZ and topZ..T, both with the outline
// pocketLoops (strictly inside every plate layer). Walls of the pockets run inside those
// ranges; the bottom pocket's ceiling faces down at bottomZ, the top pocket's floor faces up at
// topZ. The plate's own layer rings are untouched (the stack is only split at those heights).
function buildPlateWithPockets(layers, pocketLoops, bottomZ, topZ) {
  if (!pocketLoops.some(l => loopArea(l) > 0)) return buildLayeredSolid(layers, []);
  let L = layers;
  for (const z of [bottomZ, topZ]) {
    const next = [];
    for (const layer of L) {
      if (layer.z0 < z - 1e-6 && layer.z1 > z + 1e-6) { next.push({ ...layer, z1: z }); next.push({ ...layer, z0: z }); }
      else next.push(layer);
    }
    L = next;
  }
  const pos = [];
  const holes = pocketLoops.map(reversed);
  const zBot = L[0].z0, zTop = L[L.length - 1].z1;
  addCap(pos, regionsFromLoops([...L[0].loops, ...holes]), zBot, false);
  addCap(pos, regionsFromLoops([...L[L.length - 1].loops, ...holes]), zTop, true);
  for (const layer of L) addWalls(pos, layer.loops, layer.z0, layer.z1);
  addWalls(pos, holes, zBot, bottomZ);
  addWalls(pos, holes, topZ, zTop);
  addCap(pos, regionsFromLoops(pocketLoops), bottomZ, false); // bottom pocket ceiling
  addCap(pos, regionsFromLoops(pocketLoops), topZ, true);     // top pocket floor
  for (let i = 0; i < L.length - 1; i++) {
    const A = L[i], B = L[i + 1];
    if (A.loops === B.loops) continue; // split points: same outline, nothing to join
    if (B.insetPx > A.insetPx) addCap(pos, regionsFromLoops([...A.loops, ...B.loops.map(reversed)]), A.z1, true);
    else addCap(pos, regionsFromLoops([...B.loops, ...A.loops.map(reversed)]), A.z1, false);
  }
  return geometryFrom(pos);
}

function geometryFrom(pos) {
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.computeVertexNormals();
  return g;
}

// One stack of layers: caps (optional, with extra loops merged into them), walls, and the rings
// between consecutive layers.
function addStack(pos, layers, { bottom = true, top = true, bottomExtra = [], topExtra = [] } = {}) {
  const zBot = layers[0].z0, zTop = layers[layers.length - 1].z1;
  if (bottom) addCap(pos, regionsFromLoops([...layers[0].loops, ...bottomExtra]), zBot, false);
  if (top) addCap(pos, regionsFromLoops([...layers[layers.length - 1].loops, ...topExtra]), zTop, true);
  for (const L of layers) addWalls(pos, L.loops, L.z0, L.z1);
  for (let i = 0; i < layers.length - 1; i++) {
    const A = layers[i], B = layers[i + 1];
    const shrinking = A.field && B.field && A.field !== B.field ? true : B.insetPx > A.insetPx;
    if (shrinking) {
      // Shrinking upward: ring = A \ B, facing up.
      addCap(pos, regionsFromLoops([...A.loops, ...B.loops.map(reversed)]), A.z1, true);
    } else {
      // Growing upward (bottom chamfer): ring = B \ A, facing down.
      addCap(pos, regionsFromLoops([...B.loops, ...A.loops.map(reversed)]), A.z1, false);
    }
  }
}

// Relief tiers, lowest first: [{ heightMM, loops, through }]. Tier k's field is
// min(distance to "height ≥ h_k", tier k−1's field − gap), so each tier sits strictly inside the
// one below (and tier 1 strictly inside the plate's top face): nested, non-touching loops →
// clean rings between tiers. Where a taller element's edge coincides with the tier below, that
// leaves a tiny ledge of `gap` (1.5px — far below a nozzle width).
function reliefTiers(r, sdPlate, keepOutPx, w, h, toMM, minAreaMM2) {
  const levels = new Set();
  for (let i = 0; i < r.mask.length; i++) if (r.mask[i] && r.heights[i] > 0) levels.add(Math.round(r.heights[i] * 100) / 100);
  const tiers = [];
  let prev = null;
  for (const level of [...levels].sort((p, q) => p - q)) {
    const m = new Uint8Array(w * h);
    for (let i = 0; i < m.length; i++) m[i] = r.mask[i] && r.heights[i] >= level - 0.005 ? 1 : 0;
    const sdT = signedDistanceField(m, w, h);
    const f = new Float32Array(w * h);
    for (let i = 0; i < f.length; i++) {
      f[i] = prev ? Math.min(sdT[i], prev[i] - 1.5) : sdPlate ? Math.min(sdT[i], sdPlate[i] - keepOutPx) : sdT[i];
    }
    const loops = traceLoops(f, w, h, 0, toMM, minAreaMM2);
    if (!loops.some(l => loopArea(l) > 0)) break; // higher tiers are nested inside → empty too
    tiers.push({ heightMM: level, loops });
    prev = f;
  }
  return tiers;
}

// Positive-area loops are outers, negative are holes; each hole goes to its smallest containing
// outer. Valid because all loops here come from nested, non-crossing iso-lines.
function regionsFromLoops(loops) {
  const outers = [], holes = [];
  for (const pts of loops) {
    const a = loopArea(pts);
    (a > 0 ? outers : holes).push({ pts, area: Math.abs(a), bbox: loopBBox(pts) });
  }
  outers.sort((p, q) => p.area - q.area);
  const regions = outers.map(o => ({ outer: o.pts, holes: [], o }));
  for (const hole of holes) {
    const p = hole.pts[0];
    const r = regions.find(({ o }) => p.x >= o.bbox.minX && p.x <= o.bbox.maxX && p.y >= o.bbox.minY && p.y <= o.bbox.maxY && pointInLoop(p, o.pts));
    if (r) r.holes.push(hole.pts);
  }
  return regions;
}

function addCap(pos, regions, z, up) {
  for (const { outer, holes } of regions) {
    const verts = [outer, ...holes].flat();
    const tris = robustTriangulate(outer, holes);
    // Earcut winds all its triangles consistently, so flip the WHOLE set at once (decided by the
    // total signed area). Flipping per triangle would scramble zero-area slivers on long straight
    // edges, whose sign is just float noise, and leave them as non-manifold duplicates.
    let signed = 0;
    for (const [i, j, k] of tris) {
      const a = verts[i], b = verts[j], c = verts[k];
      signed += (b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x);
    }
    const flip = (signed > 0) !== up;
    for (const [i, j, k] of tris) {
      const a = verts[i], b = flip ? verts[k] : verts[j], c = flip ? verts[j] : verts[k];
      pos.push(a.x, a.y, z, b.x, b.y, z, c.x, c.y, z);
    }
  }
}

// Earcut occasionally mis-triangulates long, nearly straight edges next to holes (overlapping or
// missing triangles → a non-manifold cap). A correct triangulation's |area| sum equals the
// region's area, so check that and, if it's off, retry on rotated copies of the coordinates —
// earcut's hole bridging and ear order depend on orientation. Indices still refer to the same
// original vertices, so the cap stays welded to its walls.
function robustTriangulate(outer, holes) {
  const target = Math.abs(loopArea(outer)) - holes.reduce((s, hh) => s + Math.abs(loopArea(hh)), 0);
  const all = [outer, ...holes].flat();
  let best = null, bestErr = Infinity;
  for (const deg of [0, 37, 90, 143, 211, 283, 19, 71]) {
    const a = (deg * Math.PI) / 180, c = Math.cos(a), s = Math.sin(a);
    const rot = (loop) => loop.map(p => new THREE.Vector2(p.x * c - p.y * s, p.x * s + p.y * c));
    const tris = THREE.ShapeUtils.triangulateShape(rot(outer), holes.map(rot));
    let sum = 0;
    for (const [i, j, k] of tris) {
      const A = all[i], B = all[j], C = all[k];
      sum += Math.abs((B.x - A.x) * (C.y - A.y) - (B.y - A.y) * (C.x - A.x)) / 2;
    }
    const err = Math.abs(sum - target);
    if (err < bestErr) { best = tris; bestErr = err; }
    if (err <= 1e-6 * Math.max(1, target)) break;
  }
  return best;
}

// Vertical walls; with outers CCW and holes CW, the outward normal is always to the right of
// the travel direction, which this winding produces.
function addWalls(pos, loops, z0, z1) {
  for (const loop of loops) {
    const n = loop.length;
    for (let i = 0; i < n; i++) {
      const a = loop[i], b = loop[(i + 1) % n];
      pos.push(a.x, a.y, z0, b.x, b.y, z0, b.x, b.y, z1);
      pos.push(a.x, a.y, z0, b.x, b.y, z1, a.x, a.y, z1);
    }
  }
}

const reversed = (loop) => loop.slice().reverse();

function loopArea(pts) {
  let s = 0;
  for (let i = 0, n = pts.length; i < n; i++) {
    const a = pts[i], b = pts[(i + 1) % n];
    s += a.x * b.y - b.x * a.y;
  }
  return s / 2;
}

function loopBBox(pts) {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const p of pts) {
    if (p.x < minX) minX = p.x;
    if (p.x > maxX) maxX = p.x;
    if (p.y < minY) minY = p.y;
    if (p.y > maxY) maxY = p.y;
  }
  return { minX, minY, maxX, maxY };
}

function pointInLoop(p, pts) {
  let inside = false;
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
    const a = pts[i], b = pts[j];
    if (((a.y > p.y) !== (b.y > p.y)) && (p.x < (b.x - a.x) * (p.y - a.y) / (b.y - a.y) + a.x)) inside = !inside;
  }
  return inside;
}

// ── Enclosing outline shapes (rect / capsule / ellipse) ──
// `o` is the element: { outlineShape, outlineFilletMM, outlineFlatness }.
// Sized to the smallest uniform scale (ellipse/capsule) or uniform growth (rect) that contains
// every pixel of the already-offset outline mask, so the requested clearance is kept everywhere.
function rasterEnclosingShape(mask, w, h, o, ppm) {
  const mb = maskBounds(mask, w, h);
  if (!mb) return null;
  const cx = (mb.minX + mb.maxX + 1) / 2, cy = (mb.minY + mb.maxY + 1) / 2;
  const a0 = (mb.maxX - mb.minX + 1) / 2, b0 = (mb.maxY - mb.minY + 1) / 2;
  const pts = boundaryPixels(mask, w, h).map(([x, y]) => [x + 0.5 - cx, y + 0.5 - cy]);

  let inside;
  if (o.outlineShape === 'rect') {
    const r = Math.max(0, o.outlineFilletMM * ppm);
    const make = (e) => {
      const hw = a0 + e, hh = b0 + e, rr = Math.min(r, hw, hh);
      return (x, y) => inRoundRect(x, y, hw, hh, rr);
    };
    const e = minimalFit(make, pts, 0, r + 1);
    inside = make(e);
  } else {
    const p = o.outlineShape === 'ellipse' ? 2 : Math.max(2, o.outlineFlatness || 4);
    // |x/a|^p + (y/b)^2 <= 1 : p = 2 is a true ellipse; larger p flattens the middle while the
    // ends stay smoothly rounded (C¹ everywhere — no straight-to-arc kinks).
    const make = (k) => (x, y) => Math.pow(Math.abs(x) / (k * a0), p) + (y / (k * b0)) ** 2 <= 1;
    inside = make(minimalFit(make, pts, 1, 2));
  }
  const out = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) if (inside(x + 0.5 - cx, y + 0.5 - cy)) out[y * w + x] = 1;
  }
  return out;
}

// "Ends" outline: convex hull of two end blobs, computed in a local frame (origin cx,cy px,
// rotated by angleDeg) where the shorter blob is stretched vertically to the combined height
// of both — so the left and right ends come out the same height, following the taller one.
function rasterEqualEndsHull(blobA, blobB, w, h, cx, cy, angleDeg) {
  const a = (angleDeg * Math.PI) / 180, cos = Math.cos(a), sin = Math.sin(a);
  const toLocal = (px, py) => { const dx = px - cx, dy = -(py - cy); return [dx * cos + dy * sin, -dx * sin + dy * cos]; };
  const ptsA = boundaryPixels(blobA, w, h).map(([x, y]) => toLocal(x + 0.5, y + 0.5));
  const ptsB = boundaryPixels(blobB, w, h).map(([x, y]) => toLocal(x + 0.5, y + 0.5));
  if (!ptsA.length || !ptsB.length) return null;
  const range = (pts) => pts.reduce(([lo, hi], [, y]) => [Math.min(lo, y), Math.max(hi, y)], [Infinity, -Infinity]);
  const ra = range(ptsA), rb = range(ptsB);
  const t0 = Math.min(ra[0], rb[0]), t1 = Math.max(ra[1], rb[1]);
  const stretch = (pts, [r0, r1]) => pts.map(([x, y]) => [x, r1 > r0 ? t0 + ((y - r0) * (t1 - t0)) / (r1 - r0) : y]);
  const hull = convexHull([...stretch(ptsA, ra), ...stretch(ptsB, rb)]);
  if (hull.length < 3) return null;
  const fromLocal = ([lx, ly]) => [cx + lx * cos - ly * sin, cy - (lx * sin + ly * cos)];
  const px = hull.map(fromLocal);
  const minX = Math.max(0, Math.floor(Math.min(...px.map(p => p[0])))), maxX = Math.min(w - 1, Math.ceil(Math.max(...px.map(p => p[0]))));
  const minY = Math.max(0, Math.floor(Math.min(...px.map(p => p[1])))), maxY = Math.min(h - 1, Math.ceil(Math.max(...px.map(p => p[1]))));
  const n = hull.length;
  const out = new Uint8Array(w * h);
  for (let y = minY; y <= maxY; y++) {
    for (let x = minX; x <= maxX; x++) {
      const p = toLocal(x + 0.5, y + 0.5);
      let inside = true;
      for (let i = 0; i < n && inside; i++) if (cross2(hull[i], hull[(i + 1) % n], p) < -1e-9) inside = false;
      if (inside) out[y * w + x] = 1;
    }
  }
  return out;
}

const cross2 = (o, a, b) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);

// Monotone-chain convex hull of [x,y] points, CCW (y-up).
function convexHull(points) {
  const pts = points.slice().sort((p, q) => p[0] - q[0] || p[1] - q[1]);
  if (pts.length < 3) return pts;
  const half = (list) => {
    const out = [];
    for (const p of list) {
      while (out.length >= 2 && cross2(out[out.length - 2], out[out.length - 1], p) <= 0) out.pop();
      out.push(p);
    }
    out.pop();
    return out;
  };
  return [...half(pts), ...half(pts.slice().reverse())];
}

// Manual base: the chosen shape at the base's own center/size/rotation (rect with fillet,
// capsule with flatness, or ellipse; 'contour'/'ends' have no meaning here → rounded rect).
function rasterFreeShape(b, w, h, world, ppm) {
  const cx = (b.x - world.minX) * ppm, cy = (world.maxY - b.y) * ppm;
  const hw = (b.widthMM / 2) * ppm, hh = (b.heightMM / 2) * ppm;
  const a = ((b.rotationDeg || 0) * Math.PI) / 180, cos = Math.cos(a), sin = Math.sin(a);
  let inside;
  if (b.outlineShape === 'ellipse' || b.outlineShape === 'capsule') {
    const p = b.outlineShape === 'ellipse' ? 2 : Math.max(2, b.outlineFlatness || 4);
    inside = (x, y) => Math.pow(Math.abs(x) / hw, p) + (y / hh) ** 2 <= 1;
  } else {
    const r = Math.min(Math.max(0, (b.outlineFilletMM || 0) * ppm), hw, hh);
    inside = (x, y) => inRoundRect(x, y, hw, hh, r);
  }
  const reach = Math.hypot(hw, hh);
  const out = new Uint8Array(w * h);
  for (let y = Math.max(0, Math.floor(cy - reach)); y <= Math.min(h - 1, Math.ceil(cy + reach)); y++) {
    for (let x = Math.max(0, Math.floor(cx - reach)); x <= Math.min(w - 1, Math.ceil(cx + reach)); x++) {
      const dx = x + 0.5 - cx, dy = -(y + 0.5 - cy);
      if (inside(dx * cos + dy * sin, -dx * sin + dy * cos)) out[y * w + x] = 1;
    }
  }
  return out;
}

// Smallest parameter t in [lo, ∞) for which make(t) contains all pts (monotone in t).
function minimalFit(make, pts, lo, hi) {
  const fits = (t) => { const f = make(t); return pts.every(([x, y]) => f(x, y)); };
  if (fits(lo)) return lo;
  while (!fits(hi)) hi *= 2;
  for (let i = 0; i < 30; i++) {
    const mid = (lo + hi) / 2;
    if (fits(mid)) hi = mid; else lo = mid;
  }
  return hi;
}

function inRoundRect(x, y, hw, hh, r) {
  const dx = Math.max(Math.abs(x) - (hw - r), 0), dy = Math.max(Math.abs(y) - (hh - r), 0);
  if (Math.abs(x) > hw || Math.abs(y) > hh) return false;
  return dx * dx + dy * dy <= r * r;
}

function boundaryPixels(mask, w, h) {
  const out = [];
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      if (!mask[i]) continue;
      if (x === 0 || y === 0 || x === w - 1 || y === h - 1 || !mask[i - 1] || !mask[i + 1] || !mask[i - w] || !mask[i + w]) out.push([x, y]);
    }
  }
  return out;
}

function maskBounds(mask, w, h) {
  let minX = w, minY = h, maxX = -1, maxY = -1;
  for (let y = 0; y < h; y++) {
    const row = y * w;
    for (let x = 0; x < w; x++) {
      if (!mask[row + x]) continue;
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
    }
  }
  return maxX < 0 ? null : { minX, minY, maxX, maxY };
}

// (px, py) world pixel → relief height (mm) of item `it` there.
function itemHeightFn(it, world, ppm) {
  const base = it.reliefMM || 0;
  const boxes = it.altHeights ? it.source.charBoxes : null;
  if (!boxes || !boxes.length) return () => base;
  const a = ((it.rotationDeg || 0) * Math.PI) / 180, cos = Math.cos(a), sin = Math.sin(a);
  const sw = it.source.width, sh = it.source.height;
  return (px, py) => {
    // world pixel → element-local mm → source pixel (inverse of the rasterizer transform)
    const dx = world.minX + (px + 0.5) / ppm - it.x, dy = world.maxY - (py + 0.5) / ppm - it.y;
    const lx = dx * cos + dy * sin, ly = -dx * sin + dy * cos;
    const sx = ((it.flipX ? -lx : lx) / it.widthMM + 0.5) * sw;
    const sy = (0.5 - ly / it.heightMM) * sh;
    // web: the letter whose real ink covers this spot (owner map), else the nearest advance box
    const own = it.source.charOwner;
    if (own) {
      const ix = Math.floor(sx), iy = Math.floor(sy);
      if (ix >= 0 && iy >= 0 && ix < own.w && iy < own.h) {
        const no = own.data[iy * own.w + ix];
        if (no) return no % 2 === 1 ? it.altOddMM : it.altEvenMM;
      }
    }
    let best = boxes[0], bestD = Infinity;
    for (const b of boxes) {
      const ddx = sx < b.x0 ? b.x0 - sx : sx > b.x1 ? sx - b.x1 : 0;
      const ddy = sy < b.y0 ? b.y0 - sy : sy > b.y1 ? sy - b.y1 : 0;
      const d = ddx + ddy * 4; // prefer the same line
      if (d < bestD) { bestD = d; best = b; if (d === 0) break; }
    }
    return best.no % 2 === 1 ? it.altOddMM : it.altEvenMM;
  };
}

// World-space axis-aligned bounds of an element's rotated rectangle.
export function itemBounds(it) {
  const corners = itemCorners(it);
  return {
    minX: Math.min(...corners.map(c => c.x)), maxX: Math.max(...corners.map(c => c.x)),
    minY: Math.min(...corners.map(c => c.y)), maxY: Math.max(...corners.map(c => c.y))
  };
}

export function itemCorners(it) {
  const a = ((it.rotationDeg || 0) * Math.PI) / 180;
  const cos = Math.cos(a), sin = Math.sin(a);
  const hw = it.widthMM / 2, hh = it.heightMM / 2;
  return [[-hw, -hh], [hw, -hh], [hw, hh], [-hw, hh]].map(([lx, ly]) => ({
    x: it.x + lx * cos - ly * sin,
    y: it.y + lx * sin + ly * cos
  }));
}

// Returns (item) => Uint8Array mask of that item drawn into world space at ppm, with its own
// smoothing (blur before threshold → rounded corners, removes hairline detail) and boldness
// (round dilation, or erosion when negative).
function createRasterizer(w, h, world, ppm) {
  const canvas = document.createElement('canvas');
  canvas.width = w; canvas.height = h;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  let blurCanvas = null, blurCtx = null;

  // clip: optional [x0, x1] column range of the source to draw (the rest is left empty).
  // raw = true → the drawn alpha (0..255) as is, for color-layer comparison.
  return (it, clip = null, raw = false) => {
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, w, h);
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';
    ctx.translate((it.x - world.minX) * ppm, (world.maxY - it.y) * ppm);
    ctx.rotate((-(it.rotationDeg || 0) * Math.PI) / 180); // world is Y-up, canvas is Y-down
    ctx.scale(((it.flipX ? -1 : 1) * it.widthMM * ppm) / it.source.width, (it.heightMM * ppm) / it.source.height);
    if (clip) {
      const sx = Math.max(0, clip[0]), sw = Math.max(1, Math.min(it.source.width, clip[1]) - sx);
      ctx.drawImage(it.source.canvas, sx, 0, sw, it.source.height, -it.source.width / 2 + sx, -it.source.height / 2, sw, it.source.height);
    } else {
      ctx.drawImage(it.source.canvas, -it.source.width / 2, -it.source.height / 2);
    }

    let readCtx = ctx;
    const blurPx = (it.smoothMM || 0) * ppm;
    if (blurPx > 0.3) {
      if (!blurCanvas) {
        blurCanvas = document.createElement('canvas');
        blurCanvas.width = w; blurCanvas.height = h;
        blurCtx = blurCanvas.getContext('2d', { willReadFrequently: true });
      }
      blurCtx.clearRect(0, 0, w, h);
      blurCtx.filter = `blur(${blurPx.toFixed(2)}px)`;
      blurCtx.drawImage(canvas, 0, 0);
      blurCtx.filter = 'none';
      readCtx = blurCtx;
    }
    const d = readCtx.getImageData(0, 0, w, h).data;
    if (raw) {
      const a = new Uint8Array(w * h);
      for (let i = 0; i < w * h; i++) a[i] = d[i * 4 + 3];
      return a;
    }
    let m = new Uint8Array(w * h);
    for (let i = 0; i < w * h; i++) m[i] = d[i * 4 + 3] >= 128 ? 1 : 0;
    const bold = it.boldMM || 0;
    if (bold > 0) m = dilate(m, w, h, bold * ppm);
    else if (bold < 0) m = erode(m, w, h, -bold * ppm);
    return m;
  };
}

function orInto(target, src) { for (let i = 0; i < target.length; i++) target[i] |= src[i]; }
function subtractFrom(target, src) { for (let i = 0; i < target.length; i++) if (src[i]) target[i] = 0; }

function nearestSetPixel(mask, w, h, cx, cy) {
  let best = null, bestD = Infinity;
  for (let y = 0; y < h; y++) {
    const dy = y + 0.5 - cy, dy2 = dy * dy;
    if (dy2 >= bestD) continue;
    const row = y * w;
    for (let x = 0; x < w; x++) {
      if (!mask[row + x]) continue;
      const dx = x + 0.5 - cx;
      const d = dx * dx + dy2;
      if (d < bestD) { bestD = d; best = { x: x + 0.5, y: y + 0.5 }; }
    }
  }
  return best ? { ...best, dist: Math.sqrt(bestD) } : null;
}

// Sets every pixel whose center is within `r` of segment (ax,ay)-(bx,by). A zero-length
// segment is a disk — used for the round hole tab and the connector strut.
function stampCapsule(mask, w, h, ax, ay, bx, by, r) {
  const x0 = Math.max(0, Math.floor(Math.min(ax, bx) - r)), x1 = Math.min(w - 1, Math.ceil(Math.max(ax, bx) + r));
  const y0 = Math.max(0, Math.floor(Math.min(ay, by) - r)), y1 = Math.min(h - 1, Math.ceil(Math.max(ay, by) + r));
  const vx = bx - ax, vy = by - ay, len2 = vx * vx + vy * vy, r2 = r * r;
  for (let y = y0; y <= y1; y++) {
    for (let x = x0; x <= x1; x++) {
      const px = x + 0.5 - ax, py = y + 0.5 - ay;
      const t = len2 > 0 ? Math.max(0, Math.min(1, (px * vx + py * vy) / len2)) : 0;
      const dx = px - vx * t, dy = py - vy * t;
      if (dx * dx + dy * dy <= r2) mask[y * w + x] = 1;
    }
  }
}

// Rounded-square hole tab (half-side = r), rotated by angleDeg (world CCW).
function stampRoundedSquare(mask, w, h, cx, cy, r, filletPx, angleDeg) {
  const reach = r * Math.SQRT2;
  const a = (angleDeg * Math.PI) / 180, cos = Math.cos(a), sin = Math.sin(a);
  const rr = Math.max(0, Math.min(filletPx, r));
  const x0 = Math.max(0, Math.floor(cx - reach)), x1 = Math.min(w - 1, Math.ceil(cx + reach));
  const y0 = Math.max(0, Math.floor(cy - reach)), y1 = Math.min(h - 1, Math.ceil(cy + reach));
  for (let y = y0; y <= y1; y++) {
    for (let x = x0; x <= x1; x++) {
      const wx = x + 0.5 - cx, wy = -(y + 0.5 - cy); // pixel → world-oriented offset
      const lx = wx * cos + wy * sin, ly = -wx * sin + wy * cos;
      if (inRoundRect(lx, ly, r, r, rr)) mask[y * w + x] = 1;
    }
  }
}

function clearDisk(mask, w, h, cx, cy, r) {
  const x0 = Math.max(0, Math.floor(cx - r)), x1 = Math.min(w - 1, Math.ceil(cx + r));
  const y0 = Math.max(0, Math.floor(cy - r)), y1 = Math.min(h - 1, Math.ceil(cy + r));
  const r2 = r * r;
  for (let y = y0; y <= y1; y++) {
    for (let x = x0; x <= x1; x++) {
      const dx = x + 0.5 - cx, dy = y + 0.5 - cy;
      if (dx * dx + dy * dy <= r2) mask[y * w + x] = 0;
    }
  }
}

function expand(b, d) {
  return { minX: b.minX - d, minY: b.minY - d, maxX: b.maxX + d, maxY: b.maxY + d };
}

function scaleBounds(b, s) {
  const cx = (b.minX + b.maxX) / 2, cy = (b.minY + b.maxY) / 2;
  const hw = ((b.maxX - b.minX) / 2) * s, hh = ((b.maxY - b.minY) / 2) * s;
  return { minX: cx - hw, maxX: cx + hw, minY: cy - hh, maxY: cy + hh };
}

function unionBounds(a, b) {
  if (!a) return { ...b };
  return { minX: Math.min(a.minX, b.minX), maxX: Math.max(a.maxX, b.maxX), minY: Math.min(a.minY, b.minY), maxY: Math.max(a.maxY, b.maxY) };
}
