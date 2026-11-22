import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { buildFlatKeychain, itemCorners } from './keychainBuilder.js';
import { buildTextSource, buildImageSource, imageHasTransparency, loadImage, TEXT_FONT_PX } from './sources.js';
import { orderItemToDesign, createOrderDialog } from './orderImport.js';
import { cutHorizontalHoles } from './csgHoles.js';
import { createPresetPanel } from './presets.js';
import { saveModel, save3MF, saveSplitSTL, encodeModel, encode3MF } from './exporter.js';
import { createFontPicker } from './fontPicker.js';
import { createIconLibrary } from './iconLibrary.js';

// ── State ──────────────────────────────────────────────
let elements = [];
let selectedId = null;
let nextId = 1;
let defaultFont = 'Arial';
const settings = {
  lockW: false, lockH: true, lockZ: true, lockElemT: false, targetW: null, targetH: 25, targetZ: 12.65,
  thicknessMM: 3, elementThicknessMM: 2, joinSmoothMM: 0, fillHoles: false, minAreaMM2: 1, quality: 10, exportQuality: 24,
  splitColors: true, colorSkin: true, colorSkinMM: 0.8, bodyColor: '#ff8a3d', borderColor: '#f2f2f2',
  chamferTopMM: 0, chamferBottomMM: 0, chamferProfile: 'chamfer',
  holeShape: 'circle', holeFilletMM: 1.5, holeAngleDeg: 0,
  holeEnabled: false, holeDiameterMM: 5, holeRingMM: 2.5, holeX: null, holeY: null,
  // export option: relief and base as separate pieces, base with a glue recess (two-level only)
  glueSplit: false, glueDepthMM: 1, glueGapMM: 0.15
};
let lastResult = null;
// App-wide preferences set from the menu (not part of undo): see main.js.
let prefs = { minFeatureMM: 0.4 };

const $ = (id) => document.getElementById(id);
const selected = () => elements.find(e => e.id === selectedId) || null;

// ── Three.js scene ─────────────────────────────────────
const viewport = $('viewport');
const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setPixelRatio(window.devicePixelRatio);
viewport.appendChild(renderer.domElement);
const scene = new THREE.Scene();
scene.background = new THREE.Color(0x1a1a1a);
const camera = new THREE.PerspectiveCamera(35, 1, 0.5, 5000);
camera.up.set(0, 0, 1);
camera.position.set(0, -90, 140);
const controls = new OrbitControls(camera, renderer.domElement);
controls.enableDamping = true;
controls.mouseButtons = { LEFT: THREE.MOUSE.ROTATE, MIDDLE: THREE.MOUSE.DOLLY, RIGHT: THREE.MOUSE.PAN };

scene.add(new THREE.HemisphereLight(0xffffff, 0x444444, 1.6));
const sun = new THREE.DirectionalLight(0xffffff, 1.6);
sun.position.set(60, -80, 150);
scene.add(sun);
const grid = new THREE.GridHelper(300, 30, 0x444444, 0x2c2c2c);
grid.rotation.x = Math.PI / 2;
grid.position.z = -0.01;
scene.add(grid);

const makeMaterial = () => new THREE.MeshStandardMaterial({ roughness: 0.55, metalness: 0.05 });
const modelMesh = new THREE.Mesh(new THREE.BufferGeometry(), makeMaterial());   // single-color view
const bodyMesh = new THREE.Mesh(new THREE.BufferGeometry(), makeMaterial());    // split view: body
const borderMesh = new THREE.Mesh(new THREE.BufferGeometry(), makeMaterial());  // split view: border
scene.add(modelMesh, bodyMesh, borderMesh);

function applyColors() {
  modelMesh.material.color.set(settings.bodyColor);
  bodyMesh.material.color.set(settings.bodyColor);
  borderMesh.material.color.set(settings.borderColor);
}
applyColors();

// The color parts of a result, in export order (null when not split / nothing to split).
function colorPartsOf(result) {
  if (result?.parts) return result.parts;
  if (!result?.colorParts) return null;
  return [
    { name: 'body', color: settings.bodyColor, geometry: result.colorParts.body },
    { name: 'border', color: settings.borderColor, geometry: result.colorParts.border }
  ];
}

function disposeResult(result) {
  if (!result) return;
  result.geometry.dispose();
  result.colorParts?.body.dispose();
  result.colorParts?.border.dispose();
  result.parts?.forEach(p => p.geometry.dispose());
}

// Two-level mode: one mesh per part (plate + each raised element) in its own color.
const partsGroup = new THREE.Group();
scene.add(partsGroup);
function showParts(parts) {
  for (const m of [...partsGroup.children]) { m.material.dispose(); partsGroup.remove(m); }
  for (const p of parts || []) {
    const mat = new THREE.MeshStandardMaterial({ color: p.color, roughness: 0.55, metalness: 0.05 });
    const mesh = new THREE.Mesh(p.geometry, mat);
    mesh.userData.key = p.key || p.name;
    partsGroup.add(mesh);
  }
  highlightPart(selectedPartKey);
}

let selectedPartKey = null;
function highlightPart(key) {
  for (const m of partsGroup.children) m.material.emissive.setHex(m.userData.key === key ? 0x553311 : 0x000000);
}
const overlay = new THREE.Group(); // selection rectangle + hole handle, drawn above the top face
scene.add(overlay);

function resize() {
  const w = viewport.clientWidth, h = viewport.clientHeight;
  renderer.setSize(w, h);
  camera.aspect = w / h;
  camera.updateProjectionMatrix();
}
window.addEventListener('resize', resize);
resize();
renderer.setAnimationLoop(() => { controls.update(); renderer.render(scene, camera); });

// ── Sources (content → cropped coverage canvas), cached by content ──
const sourceCache = new Map();
const imageCache = new Map();

function sourceKey(el) {
  const warp = `|${el.bendDeg || 0}|${el.waveAmp || 0}|${el.waveCount}|${el.wavePhase}`;
  if (el.type === 'text') return `t|${el.text}|${el.font}|${el.bold}|${el.italic}|${el.letterSpacing}|${el.lineHeight}|${el.align}` + warp;
  return `i|${el.imageKey}|${el.imgMode}|${el.threshold}|${el.invert}|${el.colorSplit ? (el.colorAuto !== false ? 'auto' : el.colorCount || 3) : 0}` + warp;
}

function getSource(el) {
  const key = sourceKey(el);
  if (!sourceCache.has(key)) {
    if (sourceCache.size > 80) sourceCache.clear();
    const p = el.type === 'text'
      ? buildTextSource(el)
      : getImage(el).then(img => buildImageSource(img, el));
    sourceCache.set(key, p.catch(err => { console.error(err); return null; }));
  }
  return sourceCache.get(key);
}

function getImage(el) {
  if (!imageCache.has(el.imageKey)) imageCache.set(el.imageKey, loadImage(el.imageDataUrl));
  return imageCache.get(el.imageKey);
}

// ── Rebuild ────────────────────────────────────────────
let buildToken = 0;
let queuedKind = null;
let historyPending = false;

// 'draft' = low resolution (used while dragging), 'full' = settings.quality.
function requestRebuild(kind = 'full') {
  if (queuedKind !== 'full') queuedKind = kind;
  if (requestRebuild.raf) return;
  // A ~1-frame timer, not requestAnimationFrame: rAF pauses while the window is minimized or
  // covered, which would stall rebuilds (and exports waiting on them) until it's shown again.
  requestRebuild.raf = setTimeout(() => {
    requestRebuild.raf = 0;
    const k = queuedKind; queuedKind = null;
    rebuild(k === 'draft' ? Math.min(5, settings.quality) : settings.quality);
  }, 16);
}

// Outline on/off. New elements: off; new bases: on. Older files (no flag): an element with an
// outline distance counts as on; a base counts as on unless it used the old "none" shape.
function outlineEnabled(el) {
  if (el.type === 'base' && el.baseSize === 'manual') return true; // its box IS the shape
  if (el.outlineOn != null) return el.outlineOn;
  return el.type === 'base' ? el.outlineShape !== 'none' : (el.outlineMM || 0) > 0;
}

async function computeResult(ppm, { glue = false } = {}) {
  const items = [];
  // Elements wrapped by a borderless base ("ไร้ขอบ" base shape) get no outline of their own.
  const allAddIds = elements.filter(e => e.type !== 'base' && e.type !== 'hole' && e.mode !== 'cut' && e.visible).map(e => e.id);
  // Any element wrapped by a visible base gets no outline of its own: the base is the border.
  const borderlessIds = new Set(elements
    .filter(b => b.type === 'base' && b.visible)
    .flatMap(b => (b.targetAll ? allAddIds : b.targets)));
  for (const el of elements) {
    if (!el.visible || el.type === 'base' || el.type === 'hole') continue;
    const source = await getSource(el);
    if (!source) continue;
    syncAspect(el, source);
    // Relief height above a raised base: the shared value (left panel) or the element's own.
    items.push({
      ...el, source, partName: partName(el),
      reliefMM: el.useSharedThickness !== false ? settings.elementThicknessMM : el.elThicknessMM,
      // on a borderless base: no outline (its own setting is kept for later)
      ...(borderlessIds.has(el.id) || !outlineEnabled(el) ? { outlineMM: 0, outlineShape: 'contour', outlineSmoothMM: 0 } : {})
    });
  }
  const addIds = items.filter(it => it.mode !== 'cut').map(it => it.id);
  const bases = elements.filter(el => el.type === 'base' && el.visible).map(b => ({
    ...b, targetIds: b.targetAll ? addIds : addIds.filter(id => b.targets.includes(id)),
    // borderless base: hugs its elements exactly (a manual base keeps its own box → rect)
    ...(!outlineEnabled(b) ? { outlineMM: 0, outlineShape: 'contour', outlineSmoothMM: 0 }
      : b.outlineShape === 'none' ? { outlineShape: 'rect' } : {})
  }));
  const holes = elements.filter(el => el.type === 'hole' && el.visible);
  const drillHoles = holes.filter(el => el.holeDir !== 'horizontal').map(el => ({ x: el.x, y: el.y, r: el.widthMM / 2 }));
  const result = buildFlatKeychain(items, { ...settings, ppm, bases, drillHoles, minFeatureMM: prefs.minFeatureMM,
    glue: glue ? { depthMM: settings.glueDepthMM, gapMM: settings.glueGapMM } : null });
  const sideHoles = holes.filter(el => el.holeDir === 'horizontal');
  if (result && sideHoles.length) await applySideHoles(result, sideHoles);
  return result;
}

// Horizontal holes: cut each solid of the result in 3D (single body, the two color parts, or
// every per-element part). If a solid can't be cut, it's left as is and the stats say so.
async function applySideHoles(result, holes) {
  const spec = holes.map(el => ({
    x: el.x, y: el.y, r: el.heightMM / 2, angleDeg: el.rotationDeg || 0,
    z: el.zMM != null ? el.zMM : settings.thicknessMM / 2,
    length: el.throughAll === false ? el.widthMM : null
  }));
  const cut = async (g) => {
    const out = await cutHorizontalHoles(g, spec);
    if (!out) { result.sideHoleFailed = true; return g; }
    g.dispose();
    return out;
  };
  result.geometry = await cut(result.geometry);
  if (result.colorParts) {
    result.colorParts.body = await cut(result.colorParts.body);
    result.colorParts.border = await cut(result.colorParts.border);
  }
  if (result.parts) for (const p of result.parts) p.geometry = await cut(p.geometry);
}

// ── Overall size (left panel "ขนาดรวมชิ้นงาน") ──
const SIZE_TOL = 0.05; // mm
let fitting = false;
let fitGaveUp = false; // set when a fit can't reach the target; cleared by the next user change
const boundsSize = (b) => ({ w: b.maxX - b.minX, h: b.maxY - b.minY });

// Uniform scale that brings the size onto the target(s): locked axes (plus `axis` for a one-off
// edit). Both axes → the tighter one, so the piece fits inside both. 1 = nothing to do.
function fitScale(bounds, axis = null) {
  const { w, h } = boundsSize(bounds);
  const ratios = [];
  if ((settings.lockW || axis === 'w') && settings.targetW > 0) ratios.push(settings.targetW / w);
  if ((settings.lockH || axis === 'h') && settings.targetH > 0) ratios.push(settings.targetH / h);
  return ratios.length ? Math.min(...ratios) : 1;
}

// Scales the whole layout about the piece's center: element positions and sizes (and manual
// bases, and a manually placed hole) — but NOT physical clearances (outline distance, boldness,
// hole size), which is why the overall size isn't exactly linear and fitToSize iterates.
function scaleLayout(f, cx, cy) {
  for (const el of elements) {
    if (el.type === 'base' && el.baseSize !== 'manual') continue;
    el.x = round2(cx + (el.x - cx) * f);
    el.y = round2(cy + (el.y - cy) * f);
    if (el.type === 'hole') continue;
    el.widthMM = Math.max(1, round2(el.widthMM * f));
    el.heightMM = Math.max(1, round2(el.heightMM * f));
  }
  if (settings.holeX != null) settings.holeX = round2(cx + (settings.holeX - cx) * f);
  if (settings.holeY != null) settings.holeY = round2(cy + (settings.holeY - cy) * f);
}

// Rescales the layout until the overall width/height match their targets. `axis` forces one
// axis for a one-off edit of an unlocked field; locked axes always take part. With both axes
// in play, the tighter ratio wins (uniform scale fits inside both).
async function fitToSize(axis = null) {
  if (fitting) return;
  fitting = true;
  let reached = false;
  try {
    for (let i = 0; i < 8; i++) {
      const r = await computeResult(settings.quality);
      if (!r) break;
      const { w, h } = boundsSize(r.bounds);
      const cx = (r.bounds.minX + r.bounds.maxX) / 2, cy = (r.bounds.minY + r.bounds.maxY) / 2;
      const f = fitScale(r.bounds, axis);
      disposeResult(r);
      if (Math.abs(f - 1) * Math.max(w, h) < SIZE_TOL / 2) { reached = true; break; }
      scaleLayout(f, cx, cy);
    }
  } finally {
    fitting = false;
  }
  commit();
  // After commit() (which clears it for user changes): if we couldn't converge — e.g. elements
  // at their 1 mm minimum — stop auto-refitting until the user changes something.
  fitGaveUp = !reached;
  renderProps();
}

function onTotalSizeEdit(axis, value) {
  if (!(value > 0)) return;
  if (axis === 'w') settings.targetW = value; else settings.targetH = value;
  fitToSize(axis);
}

// Total height: two-level → base + shared element thickness (edits the element part);
// flat → the piece thickness.
function onTotalZEdit(value) {
  if (settings.lockZ) {
    // locked: just move the target — fitZ scales the relief (or sets the flat thickness)
    settings.targetZ = Math.max(0.4, round2(value));
    commit();
    renderProps();
    return;
  }
  const twoLevel = elements.some(e => e.baseStyle === 'raised' && e.type === 'base' && e.visible);
  if (twoLevel) settings.elementThicknessMM = Math.max(0.2, round2(value - settings.thicknessMM));
  else settings.thicknessMM = Math.max(0.2, round2(value));
  commit();
  renderProps();
}

for (const [id, axis] of [['totalW', 'w'], ['totalH', 'h']]) {
  $(id).addEventListener('change', (e) => onTotalSizeEdit(axis, parseFloat(e.target.value)));
}
$('totalZ').addEventListener('change', (e) => onTotalZEdit(parseFloat(e.target.value)));

async function rebuild(ppm) {
  const token = ++buildToken;
  let result;
  try {
    result = await computeResult(ppm);
  } catch (err) {
    console.error(err);
    return;
  }
  if (token !== buildToken) { disposeResult(result); return; }
  disposeResult(lastResult);
  const empty = () => new THREE.BufferGeometry();
  modelMesh.geometry = result ? result.geometry : empty();
  bodyMesh.geometry = result?.colorParts ? result.colorParts.body : empty();
  borderMesh.geometry = result?.colorParts ? result.colorParts.border : empty();
  const split = !!result?.colorParts;
  const multi = !!result?.parts;
  showParts(result?.parts);
  modelMesh.visible = !split && !multi;
  bodyMesh.visible = borderMesh.visible = split && !multi;
  lastResult = result;
  renderStats();
  renderPartsPanel();
  renderPartPopup();
  renderOverlay();
  renderProps();
  if (historyPending && ppm === settings.quality) { historyPending = false; pushHistory(); }
  if (ppm === settings.quality && result && !fitting && !fitGaveUp && (settings.lockW || settings.lockH)) {
    if (Math.abs(fitScale(result.bounds) - 1) * Math.max(...Object.values(boundsSize(result.bounds))) > SIZE_TOL) fitToSize();
  }
  if (ppm === settings.quality && result && !fitting && settings.lockZ && settings.targetZ > 0
      && Math.abs((result.heightMM ?? settings.thicknessMM) - settings.targetZ) > 0.01) fitZ(result);
}

// Total thickness lock. Two-level: the base keeps its thickness and every relief height
// (shared, per-element, odd/even) is scaled by the same factor, so the tallest point lands on
// the target. Flat: the piece thickness becomes the target. Heights are linear, so one step is
// exact; if it still doesn't match (e.g. the base alone is thicker than the target) we stop.
let zFitTried = false;
// Every relief height (shared, per-element, odd/even, per-color) times k.
function scaleReliefHeights(k) {
  const r3 = (v) => Math.round(v * k * 1000) / 1000;
  settings.elementThicknessMM = r3(settings.elementThicknessMM);
  for (const el of elements) {
    if (el.type === 'base' || el.type === 'hole') continue;
    if (el.elThicknessMM != null) el.elThicknessMM = r3(el.elThicknessMM);
    if (el.altOddMM != null) el.altOddMM = r3(el.altOddMM);
    if (el.altEvenMM != null) el.altEvenMM = r3(el.altEvenMM);
    if (Array.isArray(el.layerHeights)) el.layerHeights = el.layerHeights.map(v => (v > 0 ? r3(v) : v));
  }
}
function fitZ(result) {
  if (zFitTried) return;
  const Z = result.heightMM ?? settings.thicknessMM, T = settings.thicknessMM, target = settings.targetZ;
  const twoLevel = elements.some(e => e.type === 'base' && e.visible && e.baseStyle === 'raised');
  if (twoLevel && settings.lockElemT) {
    // Element thickness locked: keep the relief as is, the base takes up the difference.
    const relief = Z - T, base = target - relief;
    if (!(relief > 0.01) || !(base >= 0.4)) return;
    settings.thicknessMM = Math.round(base * 1000) / 1000;
  } else if (twoLevel && target - T < 0.2) {
    // The base alone already fills the target (e.g. right after switching a full-thickness flat
    // piece to raised): keep the relief, the base gives way — but never thinner than 0.4 mm;
    // past that the relief is scaled into what's left.
    const relief = Z - T;
    if (!(relief > 0.01)) return;
    const base = Math.max(0.4, target - relief);
    settings.thicknessMM = Math.round(base * 1000) / 1000;
    if (target - base < relief - 0.001) {
      const k = Math.max(0.2, target - base) / relief;
      scaleReliefHeights(k);
    }
  } else if (twoLevel) {
    const relief = Z - T, want = target - T;
    if (!(relief > 0.01) || !(want >= 0.2)) return;
    scaleReliefHeights(want / relief);
  } else {
    settings.thicknessMM = Math.round(target * 1000) / 1000;
  }
  commit();
  zFitTried = true; // one automatic step per user change (cleared in commit for user changes)
  renderProps();
}

// Keeps width/height consistent with the content's aspect ratio when "lock" is on. Text keeps
// its height (typing more letters makes it wider); images keep their width.
// When the source's pixel size changes (typing, font change, bend/wave, threshold…), keep the
// content's PHYSICAL scale (mm per source pixel) — so glyphs stay the same size and a bend just
// makes the element's box bigger. First build: text keeps its height, images keep their width
// (images reset `aspect` to null when replaced, which lands here too).
function syncAspect(el, source) {
  const aspect = source.height / source.width;
  if (el.srcW === source.width && el.srcH === source.height && el.aspect) return;
  if (el.fontSizeMM || (el.fitMM && el.fitFull && source.fullW)) {
    // From an order (ORDER_FORMAT.md): text at the website's font size (em, mm); an icon with the
    // WHOLE image (incl. transparent margins) fitted into the iconMM square, as the website draws
    // it. mm per source pixel = k.
    const k = el.fontSizeMM ? el.fontSizeMM / TEXT_FONT_PX : el.fitMM / Math.max(source.fullW, source.fullH);
    el.widthMM = round2(source.width * k);
    el.heightMM = round2(source.height * k);
    // The order gives the center of the website's layout box (text box / icon square); our
    // element is centered on its ink → shift by the difference (source y is down, world y up).
    if (el.anchorLayout && source.layoutCenter) {
      el.x = round2(el.x + (source.width / 2 - source.layoutCenter.x) * k);
      el.y = round2(el.y + (source.layoutCenter.y - source.height / 2) * k);
    }
    delete el.fontSizeMM; delete el.fitMM; delete el.fitFull; delete el.anchorLayout;
  } else if (el.fitMM) {
    // Icon: longest side of its visible content = fitMM.
    el.widthMM = round2(aspect >= 1 ? el.fitMM / aspect : el.fitMM);
    el.heightMM = round2(aspect >= 1 ? el.fitMM : el.fitMM * aspect);
    delete el.fitMM;
  } else if (el.srcW && el.srcH && el.aspect) {
    el.widthMM = round2(el.widthMM * source.width / el.srcW);
    el.heightMM = round2(el.heightMM * source.height / el.srcH);
  } else if (el.lockAspect) {
    if (el.type === 'text') el.widthMM = round2(el.heightMM / aspect);
    else el.heightMM = round2(el.widthMM * aspect);
  }
  el.aspect = aspect;
  el.srcW = source.width;
  el.srcH = source.height;
}

// A committed change (field blur/enter, drag release, add/remove…) — rebuilds at full quality and
// records an undo step once that build settles.
function commit() {
  if (!fitting) fitGaveUp = false;
  zFitTried = false;
  markDirty();
  historyPending = true;
  requestRebuild('full');
  renderLayerList();
  rememberWork();
}

// web: keep the work in progress in this browser, so opening the app again continues it.
function rememberWork() {
  if (!restoreDone) return; // don't overwrite the saved work with the startup design
  window.webApp?.autosaveSoon({ text: serializeProject(), projectPath, dirty: projectDirty });
}
var restoreDone = false;

// ── Undo / redo (snapshot-based) ───────────────────────
const history = [];
let historyIndex = -1;

function snapshot() {
  return { elements: elements.map(e => ({ ...e })), selectedId, settings: { ...settings } };
}
function snapshotSignature(s) {
  return JSON.stringify(s, (k, v) => (k === 'imageDataUrl' ? undefined : v));
}
function pushHistory() {
  const snap = snapshot();
  const sig = snapshotSignature(snap);
  if (historyIndex >= 0 && history[historyIndex].sig === sig) return;
  history.splice(historyIndex + 1);
  history.push({ snap, sig });
  if (history.length > 80) history.shift();
  historyIndex = history.length - 1;
  renderUndoButtons();
}
function restore(index) {
  if (index < 0 || index >= history.length) return;
  historyIndex = index;
  const { snap } = history[index];
  elements = snap.elements.map(e => ({ ...e }));
  selectedId = snap.selectedId;
  Object.assign(settings, snap.settings);
  applyColors();
  renderLayerList();
  renderProps();
  renderUndoButtons();
  requestRebuild('full');
}
const undo = () => restore(historyIndex - 1);
const redo = () => restore(historyIndex + 1);
function renderUndoButtons() {
  $('undoBtn').disabled = historyIndex <= 0;
  $('redoBtn').disabled = historyIndex >= history.length - 1;
}

// ── Elements ───────────────────────────────────────────
// Distinct default colors for new elements (two-level mode colors each element separately).
const ELEMENT_COLORS = ['#ff8a3d', '#3db3ff', '#7ed957', '#ff5d8f', '#ffd23f', '#b07cff', '#35d0c0'];
function nextElementColor() {
  return ELEMENT_COLORS[elements.filter(e => e.type !== 'base').length % ELEMENT_COLORS.length];
}

function partName(el) {
  const label = el.type === 'text' ? (el.text || '').split('\n')[0].trim() : (el.imageName || 'image').replace(/\.[a-z0-9]+$/i, '');
  return `${el.id}_${label || el.type}`.replace(/[\\/:*?"<>|]+/g, '_').slice(0, 40);
}

// New text/image/icon elements start without an outline (the self-test predates that default).
let newElementOutlineOn = false;

function baseElement() {
  return {
    id: nextId++, x: 0, y: 0, widthMM: 40, heightMM: 15, lockAspect: true, aspect: null,
    rotationDeg: 0, flipX: false, boldMM: 0, smoothMM: 0, mode: 'add', visible: true,
    outlineOn: newElementOutlineOn, outlineMM: 1.5, outlineShape: 'contour', outlineSmoothMM: 0, outlineFilletMM: 5, outlineFlatness: 4,
    bendDeg: 0, waveAmp: 0, waveCount: 2, wavePhase: 0,
    useSharedThickness: true, elThicknessMM: 2, altHeights: false, altOddMM: 4, altEvenMM: 2
  };
}

// A base wraps several elements with one shared outline (all of them by default, including ones
// added later). It has no transform of its own — it's derived from its targets.
// Drilled hole: vertical (straight down, Ø = width) or horizontal (sideways through the piece:
// Ø = height, length = width, direction = rotation, centered zMM above the bottom).
function addHoleElement() {
  const el = {
    ...baseElement(), type: 'hole', mode: 'cut', holeDir: 'horizontal', widthMM: 30, heightMM: 6.5, lockAspect: false,
    outlineMM: 0, zMM: null, throughAll: true
  };
  elements.push(el);
  selectedId = el.id;
  commit();
  renderProps();
  return el;
}

function addBaseElement() {
  const el = {
    ...baseElement(), type: 'base', baseSize: 'auto', baseStyle: 'flat', outlineOn: true, colorThrough: false, skinMM: 0.6, targetAll: true, lockAspect: false, color: '#f2f2f2',
    targets: elements.filter(e => e.type !== 'base' && e.mode !== 'cut').map(e => e.id),
    outlineShape: 'capsule', outlineMM: 3
  };
  // The base now provides the border → the wrapped elements stop building their own outlines.
  for (const e of elements) if (el.targets.includes(e.id)) e.outlineOn = false;
  elements.unshift(el); // drawn first → listed at the bottom, under the elements it wraps
  selectedId = el.id;
  commit();
  renderProps();
  return el;
}

function addTextElement(text = 'Onzen') {
  const el = {
    ...baseElement(), type: 'text', text, font: defaultFont, bold: true, italic: false, color: nextElementColor(),
    letterSpacing: 0, lineHeight: 1, align: 'center'
  };
  elements.push(el);
  selectedId = el.id;
  commit();
  renderProps();
  return el;
}

async function addImageElement(picked) {
  if (!picked) picked = await window.api.pickImage();
  if (!picked) return null;
  const img = await loadImage(picked.dataUrl);
  const el = {
    ...baseElement(), type: 'image', color: nextElementColor(), imageKey: `img${Date.now()}_${Math.random().toString(36).slice(2)}`,
    imageDataUrl: picked.dataUrl, imageName: picked.name,
    imgMode: imageHasTransparency(img) ? 'alpha' : 'dark', threshold: 50, invert: false, colorSplit: false, colorAuto: true, colorCount: 3
  };
  el.heightMM = round2(el.widthMM * img.height / img.width);
  imageCache.set(el.imageKey, Promise.resolve(img));
  elements.push(el);
  selectedId = el.id;
  commit();
  renderProps();
  return el;
}

async function replaceImage(el) {
  const picked = await window.api.pickImage();
  if (!picked) return;
  const img = await loadImage(picked.dataUrl);
  el.imageKey = `img${Date.now()}_${Math.random().toString(36).slice(2)}`;
  el.imageDataUrl = picked.dataUrl;
  el.imageName = picked.name;
  el.imgMode = imageHasTransparency(img) ? 'alpha' : 'dark';
  el.aspect = null;
  imageCache.set(el.imageKey, Promise.resolve(img));
  commit();
  renderProps();
}

function removeElement(id) {
  elements = elements.filter(e => e.id !== id);
  if (selectedId === id) selectedId = null;
  commit();
  renderProps();
}

function moveElement(id, dir) {
  const i = elements.findIndex(e => e.id === id);
  const j = i + dir;
  if (i < 0 || j < 0 || j >= elements.length) return;
  [elements[i], elements[j]] = [elements[j], elements[i]];
  commit();
}

function select(id) {
  selectedId = id;
  renderLayerList();
  renderProps();
  renderOverlay();
}

// ── Layer list ─────────────────────────────────────────
function elementLabel(el) {
  if (el.type === 'hole') return `🕳 รู${el.holeDir === 'horizontal' ? 'แนวนอน' : 'แนวตั้ง'} Ø${(el.holeDir === 'horizontal' ? el.heightMM : el.widthMM)}`;
  if (el.type === 'base') return `🟦 ฐาน (${el.baseSize === 'manual' ? 'กำหนดเอง' : el.targetAll ? 'ทุกชิ้น' : `${el.targets.length} ชิ้น`})`;
  if (el.type === 'text') return `🔤 ${(el.text || '').replace(/\n/g, ' ') || '(ว่าง)'}`;
  return `🖼 ${el.imageName || 'รูปภาพ'}`;
}

function renderLayerList() {
  const list = $('elementList');
  list.innerHTML = '';
  if (!elements.length) {
    list.innerHTML = '<div class="empty">ยังไม่มีชิ้นส่วน<br>กด “+ ข้อความ” หรือ “+ รูปภาพ”</div>';
    return;
  }
  // Top of the list = last drawn (matches viewport picking order).
  for (const el of [...elements].reverse()) {
    const row = document.createElement('div');
    row.className = `layer${el.id === selectedId ? ' selected' : ''}${el.visible ? '' : ' hidden'}`;
    row.innerHTML = `
      <span class="name"></span>
      <span class="badge ${el.mode === 'cut' ? 'cut' : ''}">${el.type === 'base' ? 'ฐาน' : el.mode === 'cut' ? 'เจาะ' : 'เติม'}</span>
      <button data-act="vis" title="ซ่อน/แสดง">${el.visible ? '👁' : '—'}</button>
      <button data-act="up" title="ขึ้น">▲</button>
      <button data-act="down" title="ลง">▼</button>
      <button data-act="del" title="ลบ">✕</button>`;
    row.querySelector('.name').textContent = elementLabel(el);
    row.addEventListener('click', (e) => {
      const act = e.target.dataset?.act;
      if (act === 'vis') { el.visible = !el.visible; commit(); }
      else if (act === 'up') moveElement(el.id, 1);
      else if (act === 'down') moveElement(el.id, -1);
      else if (act === 'del') removeElement(el.id);
      else select(el.id);
    });
    list.appendChild(row);
  }
}

// ── Property panel binding ─────────────────────────────
function readInput(input) {
  if (input.type === 'checkbox') return input.checked;
  if (input.type === 'number' || input.type === 'range' || 'num' in input.dataset) {
    if (input.value === '' && 'nullable' in input.dataset) return null;
    const v = parseFloat(input.value);
    return Number.isFinite(v) ? v : undefined;
  }
  return input.value;
}

function writeInput(input, value) {
  if (input === document.activeElement && input.type !== 'range' && input.type !== 'checkbox') return;
  if (input.type === 'checkbox') input.checked = !!value;
  else input.value = value ?? '';
}

function setElementField(el, key, value) {
  if (el.type === 'hole' && (key === 'holeDia' || key === 'holeLen' || key === 'holeDir')) return setHoleField(el, key, value);
  if (key === 'baseSize' && value === 'manual' && el.baseSize !== 'manual') initManualBase(el);
  if (key === 'widthMM' || key === 'heightMM') value = Math.max(0.5, value);
  el[key] = value;
  if (!el.lockAspect || !el.aspect) return;
  if (key === 'widthMM') el.heightMM = round2(value * el.aspect);
  if (key === 'heightMM') el.widthMM = round2(value / el.aspect);
  if (key === 'lockAspect' && value) el.heightMM = round2(el.widthMM * el.aspect);
}

function onFieldEvent(e, committed) {
  const input = e.target;
  if (!input.dataset) return;
  const elKey = input.dataset.el, setKey = input.dataset.set;
  if (!elKey && !setKey) return;
  const value = readInput(input);
  if (value === undefined) return;
  if (elKey) {
    const el = selected();
    if (!el) return;
    setElementField(el, elKey, value);
    // switching a base to raised relief → its border follows the piece's shape
    if (elKey === 'baseStyle' && value === 'raised' && el.type === 'base') { el.outlineShape = 'contour'; el.outlineOn = true; }
    if (elKey === 'text' || elKey === 'mode') renderLayerList();
  } else {
    settings[setKey] = value;
    if ((setKey === 'lockW' || setKey === 'lockH') && value && lastResult) {
      const { w, h } = boundsSize(lastResult.bounds);
      if (setKey === 'lockW') settings.targetW = round2(w); else settings.targetH = round2(h);
    }
    if (setKey === 'lockZ' && value && lastResult) settings.targetZ = round2(lastResult.heightMM ?? settings.thicknessMM);
    if (setKey === 'bodyColor' || setKey === 'borderColor') applyColors();
  }
  renderProps();
  if (committed) commit();
  else {
    requestRebuild('draft');
    clearTimeout(onFieldEvent.settle);
    onFieldEvent.settle = setTimeout(() => requestRebuild('full'), 350);
  }
}

document.addEventListener('input', (e) => onFieldEvent(e, false));
document.addEventListener('change', (e) => onFieldEvent(e, true));

function renderProps() {
  const el = selected();
  $('elementCard').classList.toggle('hide', !el);
  $('noSelection').classList.toggle('hide', !!el || !elements.length);
  if (el) {
    $('elementTitle').textContent = el.type === 'text' ? 'ข้อความ' : el.type === 'image' ? 'รูปภาพ' : el.type === 'hole' ? 'รูเจาะทรงกระบอก' : 'ฐาน';
    $('holeElGroup').classList.toggle('hide', el.type !== 'hole');
    if (el.type === 'hole') {
      // vertical holes stay round when resized with the corner handles
      if (el.holeDir !== 'horizontal' && el.heightMM !== el.widthMM) el.heightMM = el.widthMM;
      el.holeDia = el.holeDir === 'horizontal' ? el.heightMM : el.widthMM;
      el.holeLen = el.widthMM;
    }
    $('outlineTitle').textContent = el.type === 'base' ? 'รูปทรงฐาน' : 'ขอบรอบนอกของชิ้นนี้';
    // wrapped by a visible base → the base is its border; its own outline can't be used
    const wrapped = el.type !== 'base' && el.type !== 'hole' && elements.some(b => b.type === 'base' && b.visible && (b.targetAll || b.targets.includes(el.id)));
    $('outlineBlock').classList.toggle('force-hide', wrapped);
    if (el.outlineOn == null) el.outlineOn = outlineEnabled(el);
    if (el.outlineShape === 'none') el.outlineShape = 'contour'; // old "borderless" shape → the checkbox now
    if (el.type === 'base' && el.baseSize === 'manual') el.outlineOn = true;
    $('outlineToggleRow').classList.toggle('force-hide', el.type === 'base' && el.baseSize === 'manual');
    $('baseGroup').classList.toggle('hide', el.type !== 'base');
    $('baseColorThroughRow').classList.toggle('hide', el.type !== 'base' || el.baseStyle !== 'raised');
    $('transformGroup').classList.toggle('hide', el.type === 'base' || el.type === 'hole');
    if (el.type === 'base') renderBaseTargets(el);
    // Bases show their shape settings right after "base style"; elements keep them at the end.
    const slot = $(el.type === 'base' ? 'outlineSlotBase' : 'outlineSlotEl');
    if ($('outlineBlock').previousElementSibling !== slot) slot.after($('outlineBlock'));
    $('textGroup').classList.toggle('hide', el.type !== 'text');
    $('imageGroup').classList.toggle('hide', el.type !== 'image');
    if (el.type === 'image') { $('imageName').textContent = el.imageName || ''; renderColorSwatches(el); }
    for (const input of document.querySelectorAll('[data-el]')) writeInput(input, el[input.dataset.el]);
  }
  for (const input of document.querySelectorAll('[data-set]')) {
    const key = input.dataset.set;
    writeInput(input, settings[key]);
    if ((key === 'holeX' || key === 'holeY') && settings[key] == null && lastResult?.holeCenter) {
      input.placeholder = `อัตโนมัติ ${lastResult.holeCenter[key === 'holeX' ? 'x' : 'y'].toFixed(1)}`;
    }
  }
  // "Two-level" piece as soon as a raised (relief) base exists.
  const twoLevel = elements.some(e => e.type === 'base' && e.visible && e.baseStyle === 'raised');
  renderTotalSize(twoLevel);
  $('pieceTitle').textContent = twoLevel ? 'ชิ้นงาน (สองระดับ)' : 'ชิ้นงาน (ระนาบเดียว)';
  $('elThickRow').classList.toggle('hide', !twoLevel);
  $('elThickHint').classList.toggle('hide', !twoLevel);
  $('flatColors').classList.toggle('hide', twoLevel);
  $('twoLevelColorHint').classList.toggle('hide', !twoLevel);
  for (const node of document.querySelectorAll('.two-level-only')) node.classList.toggle('hide', !twoLevel);
  for (const node of document.querySelectorAll('[data-show]')) node.classList.toggle('hide', !showCondition(node.dataset.show, settings));
  if (el) for (const node of document.querySelectorAll('[data-show-el]')) node.classList.toggle('hide', !showCondition(node.dataset.showEl, el));
  $('splitExport').classList.toggle('hide', !settings.splitColors && !twoLevel);
  fontPicker.sync();
}

// data-show / data-show-el="key" → shown when obj[key] is truthy; "key=a|b" → when it equals
// a or b. data-show reads settings, data-show-el reads the selected element.
function showCondition(cond, obj) {
  if (cond === 'chamferAny') return obj.chamferTopMM > 0 || obj.chamferBottomMM > 0;
  if (cond.includes('!=')) { const [k, v] = cond.split('!='); return String(obj[k]) !== v; }
  const [key, values] = cond.split('=');
  return values ? values.split('|').includes(String(obj[key])) : !!obj[key];
}

const fontPicker = createFontPicker({
  input: $('fontInput'),
  getCurrent: () => selected()?.font || '',
  getSampleText: () => {
    const line = (selected()?.text || '').split('\n')[0].trim();
    return line ? line.slice(0, 32) : 'AaBb กขค 123';
  },
  onPick: (name) => {
    const el = selected();
    if (!el || el.type !== 'text' || el.font === name) return;
    el.font = name;
    commit();
  },
  loadFavorites: () => window.api.getFavoriteFonts(),
  saveFavorites: (list) => window.api.saveFavoriteFonts(list)
});

// Checkbox per element the base can wrap (disabled while "wrap all" is on).
// Switching a base to manual starts from the box its targets currently occupy (+ margin).
function initManualBase(base) {
  const targets = elements.filter(e => e.type !== 'base' && e.mode !== 'cut' && e.visible && (base.targetAll || base.targets.includes(e.id)));
  let b = null;
  for (const t of targets) {
    for (const c of itemCorners(t)) {
      b = b ? { minX: Math.min(b.minX, c.x), maxX: Math.max(b.maxX, c.x), minY: Math.min(b.minY, c.y), maxY: Math.max(b.maxY, c.y) }
            : { minX: c.x, maxX: c.x, minY: c.y, maxY: c.y };
    }
  }
  b = b || { minX: -20, maxX: 20, minY: -10, maxY: 10 };
  const pad = Math.max(0, base.outlineMM || 0);
  Object.assign(base, {
    x: round1((b.minX + b.maxX) / 2), y: round1((b.minY + b.maxY) / 2), rotationDeg: 0,
    widthMM: round1(b.maxX - b.minX + pad * 2), heightMM: round1(b.maxY - b.minY + pad * 2)
  });
  if (base.outlineShape === 'contour' || base.outlineShape === 'ends') base.outlineShape = 'rect';
}

// Elements with their own position/size in the viewport: everything except auto-sized bases.
function isTransformable(el) {
  return el.type !== 'base' || el.baseSize === 'manual';
}

function renderBaseTargets(base) {
  const box = $('baseTargets');
  box.innerHTML = '';
  for (const el of [...elements].reverse()) {
    if (el.type === 'base' || el.mode === 'cut') continue;
    const label = document.createElement('label');
    label.className = 'check';
    const cb = document.createElement('input');
    cb.type = 'checkbox';
    cb.checked = base.targetAll || base.targets.includes(el.id);
    cb.disabled = base.targetAll;
    cb.addEventListener('change', (e) => {
      e.stopPropagation();
      base.targets = cb.checked ? [...base.targets, el.id] : base.targets.filter(id => id !== el.id);
      commit();
    });
    label.append(cb, document.createTextNode(' ' + elementLabel(el)));
    box.appendChild(label);
  }
}

function renderTotalSize(twoLevel) {
  const set = (id, v, digits = 1) => { if (document.activeElement !== $(id)) $(id).value = v == null ? '' : +v.toFixed(digits); };
  if (lastResult) {
    const { w, h } = boundsSize(lastResult.bounds);
    set('totalW', w);
    set('totalH', h);
    set('totalZ', lastResult.heightMM ?? settings.thicknessMM, 2);
  }
  const relief = lastResult && lastResult.heightMM - settings.thicknessMM;
  $('zBreakdown').textContent = twoLevel && relief > 0.01
    ? `= ฐาน ${settings.thicknessMM} + นูน ${relief.toFixed(1)}`
    : '';
}

function setHoleField(el, key, value) {
  if (key === 'holeDir') {
    const dia = el.holeDir === 'horizontal' ? el.heightMM : el.widthMM;
    el.holeDir = value;
    if (value === 'horizontal') Object.assign(el, { heightMM: dia, widthMM: 30, lockAspect: false });
    else Object.assign(el, { widthMM: dia, heightMM: dia, lockAspect: true });
  } else if (key === 'holeDia') {
    const d = Math.max(0.3, value);
    if (el.holeDir === 'horizontal') el.heightMM = d;
    else { el.widthMM = d; el.heightMM = d; }
  } else if (key === 'holeLen') {
    el.widthMM = Math.max(1, value);
  }
}

// Detected colors of a color-split image, one picker each (overrides kept in el.layerColors).
function renderColorSwatches(el) {
  const box = $('colorSwatches');
  if (!el.colorSplit) { box.innerHTML = ''; return; }
  getSource(el).then(src => {
    if (selected() !== el) return;
    const layers = src?.colorLayers || [];
    const sig = `${el.id}|${layers.map(L => L.color).join(',')}|${(el.layerColors || []).join(',')}`;
    if (box.dataset.sig === sig) return;
    box.dataset.sig = sig;
    $('colorAutoInfo').textContent = el.colorAuto !== false && layers.length ? `(พบ ${layers.length} สี)` : '';
    box.innerHTML = layers.length ? '' : '<span class="hint" style="margin:0">ตรวจไม่พบสี (หรือภาพถูกดัดโค้ง/คลื่น)</span>';
    layers.forEach((L, i) => {
      const input = document.createElement('input');
      input.type = 'color';
      input.value = (el.layerColors && el.layerColors[i]) || L.color;
      input.title = `สี ${i + 1} · ${Math.round(L.share * 100)}% ของภาพ (ค่าที่ตรวจพบ ${L.color})`;
      input.addEventListener('change', (e) => {
        e.stopPropagation();
        el.layerColors = [...(el.layerColors || [])];
        el.layerColors[i] = input.value;
        commit();
      });
      input.addEventListener('input', (e) => e.stopPropagation());
      box.appendChild(input);
    });
  });
}

// ── Parts panel (right tab) ──
// One row per output part (exactly what 3MF export writes): color, height, filament slot.
// Edits go to the existing per-element fields, so undo / project files / presets just work:
//   base → settings.thicknessMM & base color · element → own thickness & color ·
//   color region → el.layerHeights[c] & el.layerColors[c] · flat body/border → left-panel colors.
let rightTab = 'elements';
function setRightTab(tab) {
  rightTab = tab;
  $('tabElements').classList.toggle('on', tab === 'elements');
  $('tabParts').classList.toggle('on', tab === 'parts');
  $('elementList').classList.toggle('hide', tab !== 'elements');
  $('elementProps').classList.toggle('hide', tab !== 'elements');
  $('partsView').classList.toggle('hide', tab !== 'parts');
  if (tab === 'parts') renderPartsPanel(true);
}
$('tabElements').onclick = () => setRightTab('elements');
$('tabParts').onclick = () => setRightTab('parts');

function partInfo(p) {
  const twoLevel = elements.some(e => e.type === 'base' && e.visible && e.baseStyle === 'raised');
  const kind = p.kind || p.name; // flat body/border parts have no kind
  const el = p.elementId != null ? elements.find(e => e.id === p.elementId) : null;
  const shared = settings.elementThicknessMM;
  if (kind === 'base') {
    return { label: 'ฐาน', height: settings.thicknessMM, editable: true, override: false,
      setHeight: (v) => { settings.thicknessMM = v; },
      setColor: (c) => { for (const b of elements.filter(e => e.type === 'base' && e.baseStyle === 'raised')) b.color = c; } };
  }
  if (kind === 'border' || kind === 'body') {
    return { label: kind === 'border' ? 'ขอบ + ห่วง' : 'เนื้องาน', height: settings.thicknessMM, editable: false, override: false,
      setColor: (c) => { if (kind === 'border') settings.borderColor = c; else settings.bodyColor = c; applyColors(); } };
  }
  if (!el) return { label: p.name, height: null, editable: false };
  const elHeight = el.useSharedThickness !== false ? shared : el.elThicknessMM;
  if (kind === 'region') {
    const c = p.colorIndex;
    const own = el.layerHeights && el.layerHeights[c] > 0 ? el.layerHeights[c] : null;
    return { label: `${elementLabel(el).replace(/^\S+\s/, '')} · สี ${c + 1}`, height: twoLevel ? (own ?? (el.altHeights ? null : elHeight)) : null,
      editable: twoLevel, override: own != null,
      setHeight: (v) => { el.layerHeights = [...(el.layerHeights || [])]; el.layerHeights[c] = v; },
      reset: () => { el.layerHeights = [...(el.layerHeights || [])]; el.layerHeights[c] = null; },
      setColor: (col) => { el.layerColors = [...(el.layerColors || [])]; el.layerColors[c] = col; } };
  }
  return { label: elementLabel(el).replace(/^\S+\s/, ''),
    height: el.altHeights ? null : elHeight, alt: el.altHeights ? `คี่ ${el.altOddMM} / คู่ ${el.altEvenMM}` : null,
    editable: twoLevel && !el.altHeights, override: el.useSharedThickness === false,
    setHeight: (v) => { el.useSharedThickness = false; el.elThicknessMM = v; },
    reset: () => { el.useSharedThickness = true; },
    setColor: (c) => { el.color = c; } };
}

function renderPartsPanel(force = false) {
  if (rightTab !== 'parts') return;
  const view = $('partsView');
  if (!force && view.contains(document.activeElement)) return; // don't rebuild under the cursor
  const parts = colorPartsOf(lastResult) || [];
  view.innerHTML = '';
  if (!parts.length) {
    view.innerHTML = '<div class="empty">งานนี้เป็นชิ้นเดียว สีเดียว<br>ใช้ฐานแบบ “รองใต้ – ตัวหนังสือนูน” หรือเปิด “แยกสีเนื้องานกับขอบ” ทางซ้าย<br>เพื่อแยกเป็นหลาย part</div>';
    return;
  }
  const colors = [];
  for (const p of parts) { const c = p.color.toUpperCase(); if (!colors.includes(c)) colors.push(c); }
  view.insertAdjacentHTML('beforeend', '<div class="part-head"><span style="width:40px">สี</span><span style="flex:1">part</span><span style="width:84px">สูง (mm)</span><span>filament</span></div>');
  for (const p of parts) {
    const info = partInfo(p);
    const key = p.key || p.name;
    const row = document.createElement('div');
    row.className = `part-row${key === selectedPartKey ? ' on' : ''}`;
    const color = document.createElement('input');
    color.type = 'color';
    color.value = p.color;
    color.title = 'สีของ part นี้';
    const name = document.createElement('span');
    name.className = 'pname';
    name.textContent = info.label;
    name.title = p.name;
    const h = document.createElement('input');
    h.type = 'number'; h.step = '0.1'; h.min = '0.2';
    if (info.alt) { h.disabled = true; h.placeholder = 'คี่/คู่'; h.title = `สลับความสูง ${info.alt} — ปรับในการ์ดข้อความ`; }
    else if (info.height != null) h.value = +(+info.height).toFixed(2);
    h.disabled = h.disabled || !info.editable;
    if (info.override) h.classList.add('override');
    if (!info.editable && !info.alt) h.title = 'ความสูงของ part นี้ปรับไม่ได้ในโหมดนี้ (ใช้ความหนาฐานทางซ้าย)';
    const reset = document.createElement('button');
    reset.className = 'reset';
    reset.textContent = '↺';
    reset.title = 'กลับไปใช้ค่าปกติ';
    reset.style.visibility = info.override && info.reset ? 'visible' : 'hidden';
    const slot = document.createElement('span');
    slot.className = 'slot';
    slot.textContent = `#${colors.indexOf(p.color.toUpperCase()) + 1}`;
    slot.title = 'ลำดับ filament ใน 3MF';
    row.append(color, name, h, reset, slot);
    for (const input of [color, h]) {
      input.addEventListener('input', (e) => e.stopPropagation());
      input.addEventListener('click', (e) => e.stopPropagation());
    }
    color.addEventListener('change', (e) => { e.stopPropagation(); info.setColor?.(color.value); commit(); });
    h.addEventListener('change', (e) => {
      e.stopPropagation();
      const v = parseFloat(h.value);
      if (v > 0 && info.setHeight) { info.setHeight(Math.max(0.2, v)); commit(); }
    });
    reset.addEventListener('click', (e) => { e.stopPropagation(); info.reset?.(); commit(); });
    row.addEventListener('click', () => {
      selectedPartKey = selectedPartKey === key ? null : key;
      highlightPart(selectedPartKey);
      renderPartsPanel(true);
    });
    view.appendChild(row);
  }
  view.insertAdjacentHTML('beforeend', '<div class="hint" style="margin-top:8px">คลิกแถวเพื่อไฮไลต์ part ในจอ · ช่องสูงขอบส้ม = ค่าที่ตั้งเอง (↺ = กลับไปใช้ค่าปกติ) · ฐาน = ความหนาฐาน · element = ความสูงนูนจากฐาน · ลำดับ filament ตรงกับไฟล์ 3MF</div>');
}

function renderStats() {
  const stats = $('stats');
  if (!lastResult) {
    stats.textContent = elements.length ? 'ไม่มีเนื้อชิ้นงาน (ต้องมีอย่างน้อย 1 ชิ้นแบบ “เติมเนื้อ”)' : '';
    stats.classList.remove('warn');
    return;
  }
  const b = lastResult.bounds;
  const tris = (lastResult.parts
    ? lastResult.parts.reduce((n, p) => n + p.geometry.getAttribute('position').count, 0)
    : lastResult.colorParts
      ? lastResult.colorParts.body.getAttribute('position').count + lastResult.colorParts.border.getAttribute('position').count
      : lastResult.geometry.getAttribute('position').count) / 3;
  let text = `ขนาด ${(b.maxX - b.minX).toFixed(1)} × ${(b.maxY - b.minY).toFixed(1)} × ${(lastResult.heightMM ?? settings.thicknessMM).toFixed(1)} mm · ${tris.toLocaleString()} สามเหลี่ยม`;
  if (lastResult.removedMM2 > 0.05) text += ` · ตัดส่วนที่บางกว่า ${prefs.minFeatureMM} mm ออก ${lastResult.removedMM2.toFixed(1)} mm²`;
  if (lastResult.sideHoleFailed) text += ' · ⚠ เจาะรูแนวนอนไม่สำเร็จบางส่วน';
  if (lastResult.pieces > 1) text += ` · ⚠ มี ${lastResult.pieces} ชิ้นแยกกัน — เพิ่ม “ขอบรอบนอก” หรือ “ความหนาเส้น” ให้ติดกัน`;
  else text += ' · ✓ ชิ้นเดียว';
  if (settings.splitColors && !lastResult.colorParts && !lastResult.parts) text += ' · (ไม่มีส่วนขอบให้แยกสี — เพิ่ม “ขอบรอบนอก”)';
  stats.textContent = text;
  stats.classList.toggle('warn', lastResult.pieces > 1);
}

// ── Overlay (selection rectangle + scale/rotate handles + hole handle) ──
const HANDLE_PX = 10;          // pick radius of a handle, in screen px
const ROTATE_OFFSET_PX = 34;   // rotate handle sits this far above the top edge, in screen px

// World-space length of one screen pixel near the model (perspective camera).
function worldPerPixel() {
  const dist = camera.position.distanceTo(controls.target);
  return (2 * dist * Math.tan((camera.fov * Math.PI) / 360)) / renderer.domElement.clientHeight;
}

// Selected element's handles in world space: 4 corners (sx, sy = which corner) + rotate knob.
function elementHandles(el) {
  const a = ((el.rotationDeg || 0) * Math.PI) / 180, cos = Math.cos(a), sin = Math.sin(a);
  const toWorld = (lx, ly) => ({ x: el.x + lx * cos - ly * sin, y: el.y + lx * sin + ly * cos });
  const hw = el.widthMM / 2, hh = el.heightMM / 2;
  const corners = [[-1, -1], [1, -1], [1, 1], [-1, 1]].map(([sx, sy]) => ({ kind: 'scale', sx, sy, ...toWorld(sx * hw, sy * hh) }));
  const topMid = toWorld(0, hh);
  const knob = { kind: 'rotate', ...toWorld(0, hh + ROTATE_OFFSET_PX * worldPerPixel()) };
  return { corners, topMid, knob };
}

function toScreen(x, y) {
  const v = new THREE.Vector3(x, y, settings.thicknessMM).project(camera);
  const rect = renderer.domElement.getBoundingClientRect();
  return { x: rect.left + ((v.x + 1) / 2) * rect.width, y: rect.top + ((1 - v.y) / 2) * rect.height };
}

// Handle of the selected element under the mouse (screen-space test), or null.
function handleAt(clientX, clientY) {
  const el = selected();
  if (!el || !el.visible || !isTransformable(el)) return null;
  const { corners, knob } = elementHandles(el);
  for (const hnd of [knob, ...corners]) {
    const s = toScreen(hnd.x, hnd.y);
    if (Math.hypot(s.x - clientX, s.y - clientY) <= HANDLE_PX) return hnd;
  }
  return null;
}

function renderOverlay() {
  for (const child of [...overlay.children]) { child.geometry.dispose(); child.material.dispose(); overlay.remove(child); }
  const z = settings.thicknessMM + 0.05;
  const onTop = (obj) => { obj.renderOrder = 10; overlay.add(obj); };
  const el = selected();
  if (el && el.visible && isTransformable(el)) {
    const blue = new THREE.LineBasicMaterial({ color: 0x3db3ff, depthTest: false });
    const pts = itemCorners(el).map(c => new THREE.Vector3(c.x, c.y, z));
    onTop(new THREE.LineLoop(new THREE.BufferGeometry().setFromPoints(pts), blue));
    const { corners, topMid, knob } = elementHandles(el);
    onTop(new THREE.Line(new THREE.BufferGeometry().setFromPoints([
      new THREE.Vector3(topMid.x, topMid.y, z), new THREE.Vector3(knob.x, knob.y, z)]), blue));
    onTop(new THREE.Points(new THREE.BufferGeometry().setFromPoints(corners.map(c => new THREE.Vector3(c.x, c.y, z))),
      new THREE.PointsMaterial({ color: 0xffffff, size: 9, sizeAttenuation: false, depthTest: false })));
    onTop(new THREE.Points(new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(knob.x, knob.y, z)]),
      new THREE.PointsMaterial({ color: 0x3db3ff, size: 12, sizeAttenuation: false, depthTest: false })));
  }
  if (settings.holeEnabled && lastResult?.holeCenter) {
    const { x, y } = lastResult.holeCenter;
    const r = lastResult.tabRadius;
    const pts = [];
    for (let i = 0; i < 64; i++) {
      const a = (i / 64) * Math.PI * 2;
      pts.push(new THREE.Vector3(x + Math.cos(a) * r, y + Math.sin(a) * r, z));
    }
    onTop(new THREE.LineLoop(new THREE.BufferGeometry().setFromPoints(pts),
      new THREE.LineBasicMaterial({ color: 0xffb070, depthTest: false, transparent: true, opacity: 0.8 })));
  }
  positionZBar(); // web:
}

// web: height of the selected element, straight from the viewport — a small bar beside it.
// Drag the number up / down (or tap ▲ ▼) to change the height. It edits the same values as the
// side panel (element relief over a raised base, otherwise the piece / base thickness), so the
// panel and the bar always show the same number.
function heightTarget() {
  const el = selected();
  if (!el || !el.visible || el.type === 'hole') return null;
  const twoLevel = elements.some(e => e.type === 'base' && e.visible && e.baseStyle === 'raised');
  if (settings.lockZ) {
    // total height is locked (left panel) → the bar moves that target, like editing "หนารวม Z"
    return { el, label: 'รวม 🔒', title: 'ความสูงรวม (ล็อกอยู่)',
      get: () => settings.targetZ, set: (v) => { settings.targetZ = Math.max(0.4, v); } };
  }
  if (twoLevel && el.type !== 'base') {
    if (el.altHeights) return { el, label: 'นูน', disabled: 'สลับความสูงคี่/คู่ — ปรับในการ์ดข้อความ', get: () => el.altOddMM };
    return { el, label: 'นูน', title: 'ความสูงที่นูนจากฐาน (ชิ้นนี้)',
      get: () => (el.useSharedThickness !== false ? settings.elementThicknessMM : el.elThicknessMM),
      set: (v) => { el.useSharedThickness = false; el.elThicknessMM = v; } };
  }
  return { el, label: twoLevel ? 'ฐาน' : 'หนา', title: twoLevel ? 'ความหนาฐาน' : 'ความหนาชิ้นงาน',
    get: () => settings.thicknessMM, set: (v) => { settings.thicknessMM = v; } };
}

var zBar = document.createElement('div'); // var: renderOverlay may run before this line
zBar.className = 'zbar hide';
zBar.innerHTML = '<button class="zb-up" title="+0.1 mm">▲</button><div class="zb-grip"><span class="zb-lbl"></span><b class="zb-val"></b><span>mm</span></div><button class="zb-dn" title="−0.1 mm">▼</button>';
document.body.appendChild(zBar);
const zStyle = document.createElement('style');
zStyle.textContent = `
  .zbar { position: fixed; z-index: 50; display: flex; flex-direction: column; align-items: stretch; width: 58px;
    background: rgba(30,30,30,.92); border: 1px solid #ff9a3c; border-radius: 8px; overflow: hidden;
    box-shadow: 0 4px 14px rgba(0,0,0,.45); -webkit-user-select: none; user-select: none; touch-action: none; }
  .zbar.hide { display: none; }
  .zbar button { background: none; border: none; color: #ff9a3c; padding: 4px 0; font-size: 12px; border-radius: 0; cursor: pointer; }
  .zbar button:active { background: #ff9a3c; color: #111; }
  .zbar .zb-grip { display: flex; flex-direction: column; align-items: center; padding: 3px 0; cursor: ns-resize;
    border-top: 1px solid #444; border-bottom: 1px solid #444; font-size: 10px; color: #bbb; line-height: 1.25; }
  .zbar .zb-val { font-size: 14px; color: #fff; }
  .zbar.dragging .zb-grip { background: #ff9a3c33; }
  .zbar.off { border-color: #555; opacity: .7; }
  .zbar.off button, .zbar.off .zb-grip { cursor: not-allowed; color: #777; }`;
document.head.appendChild(zStyle);

let zDrag = null;
function zBarState() {
  const t = heightTarget();
  if (!t) return null;
  return { ...t, off: t.disabled || null };
}

function positionZBar() {
  if (!zBar) return;
  const t = zBarState();
  if (!t) { zBar.classList.add('hide'); return; }
  // right edge of the element on screen (auto-sized bases: the whole piece)
  let pts;
  if (isTransformable(t.el)) pts = itemCorners(t.el);
  else if (lastResult) { const b = lastResult.bounds; pts = [{ x: b.minX, y: b.minY }, { x: b.maxX, y: b.minY }, { x: b.maxX, y: b.maxY }, { x: b.minX, y: b.maxY }]; }
  else { zBar.classList.add('hide'); return; }
  const s = pts.map(p => toScreen(p.x, p.y));
  const rect = renderer.domElement.getBoundingClientRect();
  const right = Math.max(...s.map(p => p.x)), midY = s.reduce((a, p) => a + p.y, 0) / s.length;
  const w = 58, h = 84;
  zBar.style.left = `${Math.round(Math.min(rect.right - w - 6, Math.max(rect.left + 6, right + 16)))}px`;
  zBar.style.top = `${Math.round(Math.min(rect.bottom - h - 6, Math.max(rect.top + 6, midY - h / 2)))}px`;
  zBar.querySelector('.zb-lbl').textContent = t.label;
  const v = t.get();
  zBar.querySelector('.zb-val').textContent = v == null ? '–' : String(+(+v).toFixed(2));
  zBar.title = t.off || `${t.title} · ลากขึ้น/ลง หรือกด ▲ ▼ · ค่าเดียวกับแผงด้านข้าง`;
  zBar.classList.toggle('off', !!t.off);
  zBar.classList.remove('hide');
}

function setZValue(t, v, final) {
  t.set(Math.max(0.2, Math.min(60, Math.round(v * 100) / 100)));
  renderProps();
  renderPartsPanel(true);
  positionZBar();
  if (final) commit();
  else requestRebuild('draft');
}

for (const [cls, step] of [['.zb-up', 0.1], ['.zb-dn', -0.1]]) {
  zBar.querySelector(cls).addEventListener('click', (e) => {
    e.stopPropagation();
    const t = zBarState();
    if (!t || t.off || !t.set) return;
    setZValue(t, (t.get() || 0) + step, true);
  });
}
const zGrip = zBar.querySelector('.zb-grip');
zGrip.addEventListener('pointerdown', (e) => {
  e.stopPropagation();
  const t = zBarState();
  if (!t || t.off || !t.set) return;
  zDrag = { t, y: e.clientY, v0: t.get() || 0, moved: false };
  try { zGrip.setPointerCapture(e.pointerId); } catch { /* pointer already gone */ }
  zBar.classList.add('dragging');
});
zGrip.addEventListener('pointermove', (e) => {
  if (!zDrag) return;
  e.stopPropagation();
  const dy = zDrag.y - e.clientY;
  if (!zDrag.moved && Math.abs(dy) < 2) return;
  zDrag.moved = true;
  // 0.02 mm per pixel (Shift: 0.005 for fine steps); snapped to 0.1 mm unless Shift
  const raw = zDrag.v0 + dy * (e.shiftKey ? 0.005 : 0.02);
  setZValue(zDrag.t, e.shiftKey ? raw : Math.round(raw * 10) / 10, false);
});
const endZDrag = (e) => {
  if (!zDrag) return;
  const d = zDrag;
  zDrag = null;
  zBar.classList.remove('dragging');
  if (d.moved) setZValue(d.t, d.t.get(), true);
};
zGrip.addEventListener('pointerup', endZDrag);
zGrip.addEventListener('pointercancel', endZDrag);
window.addEventListener('resize', () => positionZBar());
// The rotate knob's offset is screen-constant, so re-place it when the camera zooms.
controls.addEventListener('change', () => { if (selected()) renderOverlay(); });

// ── Viewport picking & dragging ────────────────────────
const raycaster = new THREE.Raycaster();
const dragPlane = new THREE.Plane(new THREE.Vector3(0, 0, 1), 0);

function worldPointAt(clientX, clientY) {
  const rect = renderer.domElement.getBoundingClientRect();
  const ndc = new THREE.Vector2(((clientX - rect.left) / rect.width) * 2 - 1, -((clientY - rect.top) / rect.height) * 2 + 1);
  raycaster.setFromCamera(ndc, camera);
  dragPlane.constant = -settings.thicknessMM;
  const p = new THREE.Vector3();
  return raycaster.ray.intersectPlane(dragPlane, p) ? p : null;
}

// World point → element-local coords (element's own unrotated frame, origin at `center`).
function toLocal(p, center, rotationDeg) {
  const a = (-(rotationDeg || 0) * Math.PI) / 180;
  const dx = p.x - center.x, dy = p.y - center.y;
  return { x: dx * Math.cos(a) - dy * Math.sin(a), y: dx * Math.sin(a) + dy * Math.cos(a) };
}

function pointInElement(el, p) {
  const l = toLocal(p, el, el.rotationDeg);
  return Math.abs(l.x) <= el.widthMM / 2 && Math.abs(l.y) <= el.heightMM / 2;
}

function elementAt(p) {
  // Prefer the currently selected element, then topmost (last drawn).
  const candidates = [...elements].reverse().filter(el => el.visible && isTransformable(el) && pointInElement(el, p));
  return candidates.find(el => el.id === selectedId) || candidates[0] || null;
}

function holeAt(p) {
  if (!settings.holeEnabled || !lastResult?.holeCenter) return false;
  const hc = lastResult.holeCenter;
  return Math.hypot(p.x - hc.x, p.y - hc.y) <= lastResult.tabRadius;
}

let drag = null;

renderer.domElement.addEventListener('pointerdown', (e) => {
  if (e.button !== 0) return;
  const p = worldPointAt(e.clientX, e.clientY);
  if (!p) return;
  let target = null;
  const handle = handleAt(e.clientX, e.clientY);
  if (handle) {
    const el = selected();
    target = {
      kind: handle.kind, id: el.id, sx: handle.sx, sy: handle.sy,
      start: { x: el.x, y: el.y, widthMM: el.widthMM, heightMM: el.heightMM, rotationDeg: el.rotationDeg || 0 }
    };
  } else if (holeAt(p)) {
    const hc = lastResult.holeCenter;
    target = { kind: 'hole', startX: hc.x, startY: hc.y };
  } else {
    const hit = elementAt(p);
    if (hit) target = { kind: 'element', id: hit.id, startX: hit.x, startY: hit.y };
  }
  if (!target) {
    drag = { kind: 'none', downX: e.clientX, downY: e.clientY };
    return; // OrbitControls handles rotate
  }
  controls.enabled = false;
  drag = { ...target, origin: p, moved: false, downX: e.clientX, downY: e.clientY };
  if (target.kind === 'element' && target.id !== selectedId) select(target.id);
});

// Scale from a corner: the OPPOSITE corner stays put. With "lock aspect" the scale is uniform
// (projected onto the corner diagonal), otherwise width and height follow the mouse freely.
// With Alt held the anchor is the element's CENTER instead (both sides grow symmetrically).
function applyScale(el, d, p, fromCenter = false) {
  const s = d.start;
  const l = toLocal(p, s, s.rotationDeg);
  const f = fromCenter ? 0.5 : 1;                                     // anchor → corner = f × box
  const ax = fromCenter ? 0 : -d.sx * s.widthMM / 2, ay = fromCenter ? 0 : -d.sy * s.heightMM / 2;
  let w, h;
  if (el.lockAspect) {
    const cx = d.sx * s.widthMM * f, cy = d.sy * s.heightMM * f;      // anchor → dragged corner
    const k = Math.max(0.02, ((l.x - ax) * cx + (l.y - ay) * cy) / (cx * cx + cy * cy));
    w = s.widthMM * k; h = s.heightMM * k;
  } else {
    w = Math.max(1, ((l.x - ax) * d.sx) / f);
    h = Math.max(1, ((l.y - ay) * d.sy) / f);
  }
  w = Math.max(1, round2(w)); h = Math.max(1, round2(h));
  const lcx = fromCenter ? 0 : ax + d.sx * w / 2, lcy = fromCenter ? 0 : ay + d.sy * h / 2; // new center, local
  const a = (s.rotationDeg * Math.PI) / 180;
  el.widthMM = w; el.heightMM = h;
  el.x = round2(s.x + lcx * Math.cos(a) - lcy * Math.sin(a));
  el.y = round2(s.y + lcx * Math.sin(a) + lcy * Math.cos(a));
}

// Rotate around the element center; Shift snaps to 15°.
function applyRotate(el, d, p, snap) {
  const s = d.start;
  const a0 = Math.atan2(d.origin.y - s.y, d.origin.x - s.x);
  const a1 = Math.atan2(p.y - s.y, p.x - s.x);
  let deg = s.rotationDeg + ((a1 - a0) * 180) / Math.PI;
  deg = snap ? Math.round(deg / 15) * 15 : Math.round(deg);
  deg = ((deg + 540) % 360) - 180; // keep within -180..180 like the slider
  el.rotationDeg = deg;
}

// Bound to window (not the canvas) so a drag released outside the viewport still commits —
// lesson from KeychainMaker's hole-drag undo bug.
window.addEventListener('pointermove', (e) => {
  if (!drag) { updateHoverCursor(e); return; }
  if (drag.kind === 'none') return;
  const p = worldPointAt(e.clientX, e.clientY);
  if (!p) return;
  if (!drag.moved && Math.hypot(e.clientX - drag.downX, e.clientY - drag.downY) < 3) return;
  drag.moved = true;
  const el = drag.id != null ? elements.find(x => x.id === drag.id) : null;
  if (drag.kind === 'hole') {
    settings.holeX = round1(drag.startX + (p.x - drag.origin.x));
    settings.holeY = round1(drag.startY + (p.y - drag.origin.y));
  } else if (el && drag.kind === 'element') {
    el.x = round1(drag.startX + (p.x - drag.origin.x));
    el.y = round1(drag.startY + (p.y - drag.origin.y));
  } else if (el && drag.kind === 'scale') {
    applyScale(el, drag, p, e.altKey);
  } else if (el && drag.kind === 'rotate') {
    applyRotate(el, drag, p, e.shiftKey);
  }
  renderOverlay();
  renderProps();
  requestRebuild('draft');
});

window.addEventListener('pointerup', (e) => {
  if (!drag) return;
  const d = drag;
  drag = null;
  controls.enabled = true;
  const isClick = !d.moved && Math.hypot(e.clientX - d.downX, e.clientY - d.downY) < 4 && e.target === renderer.domElement;
  // Plain click on a part (multi-part results) → its quick-edit popup.
  const partKey = isClick && (d.kind === 'none' || d.kind === 'element') ? pickPart(e.clientX, e.clientY) : null;
  if (partKey) openPartPopup(partKey, e.clientX, e.clientY);
  // web: a click on a part also selects the element it belongs to (the base too — an auto-sized
  // base has no box to grab, so this is the only way to pick it in the viewport); the right
  // panel and the height bar follow.
  // A plain click goes by the part actually under the cursor, not the element's box (the text's
  // box covers most of the base, e.g. the gaps between letters).
  if (isClick && (d.kind === 'none' || d.kind === 'element')) {
    const owner = partKey ? elementOfPart(partKey) : d.kind === 'none' && modelHit(e.clientX, e.clientY) ? autoBase() : null;
    if (owner) { if (owner.id !== selectedId) select(owner.id); if (d.kind === 'none') return; }
  }
  if (d.kind === 'none') {
    // Plain click on empty space deselects.
    if (isClick && !partKey) { select(null); closePartPopup(); }
    return;
  }
  if (d.moved) commit();
});

// ── Part quick-edit popup (click a part in the viewport) ──
// Edits exactly the same values as the Parts tab (via partInfo), so the two never disagree:
// whichever was changed last is the value in effect.
const partPopup = document.createElement('div');
partPopup.className = 'part-popup hide';
document.body.appendChild(partPopup);
let popupKey = null;

function pickPart(clientX, clientY) {
  if (!partsGroup.children.length) return null;
  const rect = renderer.domElement.getBoundingClientRect();
  const ndc = new THREE.Vector2(((clientX - rect.left) / rect.width) * 2 - 1, -((clientY - rect.top) / rect.height) * 2 + 1);
  raycaster.setFromCamera(ndc, camera);
  const hit = raycaster.intersectObjects(partsGroup.children, false)[0];
  return hit ? hit.object.userData.key : null;
}

// web: which element a part belongs to ('base' part → the visible raised base).
function elementOfPart(key) {
  const p = (colorPartsOf(lastResult) || []).find(pp => (pp.key || pp.name) === key);
  if (!p) return null;
  if (p.elementId != null) return elements.find(el => el.id === p.elementId) || null;
  if ((p.kind || p.name) === 'base') return elements.find(el => el.type === 'base' && el.visible && el.baseStyle === 'raised') || autoBase();
  return autoBase();
}
function autoBase() {
  return elements.find(el => el.type === 'base' && el.visible) || null;
}
// web: did the click land on the model (single body or the two color parts)?
function modelHit(clientX, clientY) {
  const rect = renderer.domElement.getBoundingClientRect();
  const ndc = new THREE.Vector2(((clientX - rect.left) / rect.width) * 2 - 1, -((clientY - rect.top) / rect.height) * 2 + 1);
  raycaster.setFromCamera(ndc, camera);
  const meshes = [modelMesh, bodyMesh, borderMesh].filter(m => m.visible);
  return raycaster.intersectObjects(meshes, false).length > 0;
}

function openPartPopup(key, x, y) {
  popupKey = key;
  selectedPartKey = key;
  highlightPart(key);
  partPopup.style.left = `${Math.min(x + 12, window.innerWidth - 260)}px`;
  partPopup.style.top = `${Math.min(y + 12, window.innerHeight - 170)}px`;
  partPopup.classList.remove('hide');
  renderPartPopup(true);
  renderPartsPanel(true);
}

function closePartPopup() {
  popupKey = null;
  partPopup.classList.add('hide');
}

function renderPartPopup(force = false) {
  if (!popupKey) return;
  if (!force && partPopup.contains(document.activeElement)) return;
  const parts = colorPartsOf(lastResult) || [];
  const p = parts.find(pp => (pp.key || pp.name) === popupKey);
  if (!p) { closePartPopup(); return; }
  const info = partInfo(p);
  const colors = [];
  for (const pp of parts) { const c = pp.color.toUpperCase(); if (!colors.includes(c)) colors.push(c); }
  partPopup.innerHTML = `
    <div class="ph"><span></span><button title="ปิด (Esc)">✕</button></div>
    <div class="row"><label>สี</label><input type="color"><span class="hint" style="margin:0">filament #${colors.indexOf(p.color.toUpperCase()) + 1}</span></div>
    <div class="row"><label>สูง (mm)</label><input type="number" step="0.1" min="0.2"><button class="reset" title="กลับไปใช้ค่าปกติ" style="background:none;border:none;color:var(--accent)">↺</button></div>
    <div class="hint" style="margin:4px 0 0"></div>`;
  partPopup.querySelector('.ph span').textContent = info.label;
  const color = partPopup.querySelector('input[type=color]');
  const h = partPopup.querySelector('input[type=number]');
  const reset = partPopup.querySelector('.reset');
  const note = partPopup.querySelector('.hint:last-child');
  color.value = p.color;
  if (info.alt) { h.disabled = true; note.textContent = `สลับความสูง ${info.alt} — ปรับในการ์ดข้อความ`; }
  else if (info.height != null) h.value = +(+info.height).toFixed(2);
  if (!info.editable) { h.disabled = true; if (!info.alt) note.textContent = 'ความสูงปรับได้ในโหมดสองระดับ (ฐาน = ความหนาฐาน)'; }
  if (info.override) h.classList.add('override');
  reset.style.visibility = info.override && info.reset ? 'visible' : 'hidden';
  for (const input of [color, h]) input.addEventListener('input', (e) => e.stopPropagation());
  color.addEventListener('change', (e) => { e.stopPropagation(); info.setColor?.(color.value); commit(); });
  h.addEventListener('change', (e) => {
    e.stopPropagation();
    const v = parseFloat(h.value);
    if (v > 0 && info.setHeight) { info.setHeight(Math.max(0.2, v)); commit(); }
  });
  reset.addEventListener('click', () => { info.reset?.(); commit(); });
  partPopup.querySelector('.ph button').addEventListener('click', closePartPopup);
}

window.addEventListener('keydown', (e) => { if (e.key === 'Escape' && popupKey) closePartPopup(); });
window.addEventListener('pointerdown', (e) => {
  if (popupKey && !partPopup.contains(e.target) && e.target !== renderer.domElement) closePartPopup();
});

// Cursor hints: resize arrows on corners (matching the corner's on-screen direction), a rotate
// cursor on the knob, move over elements / the hole.
function updateHoverCursor(e) {
  const canvas = renderer.domElement;
  if (e.target !== canvas) return;
  const handle = handleAt(e.clientX, e.clientY);
  if (handle?.kind === 'rotate') { canvas.style.cursor = 'grab'; return; }
  if (handle?.kind === 'scale') {
    const el = selected();
    const c = toScreen(el.x, el.y), h = toScreen(handle.x, handle.y);
    canvas.style.cursor = (h.x - c.x) * (h.y - c.y) > 0 ? 'nwse-resize' : 'nesw-resize';
    return;
  }
  const p = worldPointAt(e.clientX, e.clientY);
  canvas.style.cursor = p && (holeAt(p) || elementAt(p)) ? 'move' : '';
}

// ── Keyboard ───────────────────────────────────────────
// A lone Alt press/release would focus the window menu bar on Windows (and swallow the next
// click) — Alt is used as a scale modifier here, so suppress that.
window.addEventListener('keyup', (e) => { if (e.key === 'Alt') e.preventDefault(); });

window.addEventListener('keydown', (e) => {
  if (e.key === 'Alt') { e.preventDefault(); return; }
  const inField = ['INPUT', 'TEXTAREA', 'SELECT'].includes(document.activeElement?.tagName);
  if (e.ctrlKey && e.key.toLowerCase() === 'z' && !e.shiftKey) { if (!inField) { e.preventDefault(); undo(); } return; }
  if (e.ctrlKey && (e.key.toLowerCase() === 'y' || (e.shiftKey && e.key.toLowerCase() === 'z'))) { if (!inField) { e.preventDefault(); redo(); } return; }
  if (inField) return;
  const el = selected();
  if (!el) return;
  if (e.key === 'Delete') { removeElement(el.id); return; }
  const step = e.shiftKey ? 5 : 0.5;
  const moves = { ArrowLeft: [-step, 0], ArrowRight: [step, 0], ArrowUp: [0, step], ArrowDown: [0, -step] };
  if (moves[e.key] && isTransformable(el)) {
    e.preventDefault();
    el.x = round1(el.x + moves[e.key][0]);
    el.y = round1(el.y + moves[e.key][1]);
    renderOverlay();
    commit();
  }
});

// ── Camera helpers ─────────────────────────────────────
function fitView(mode = 'keep') {
  const b = lastResult?.bounds || { minX: -30, maxX: 30, minY: -20, maxY: 20 };
  const cx = (b.minX + b.maxX) / 2, cy = (b.minY + b.maxY) / 2;
  const size = Math.max(b.maxX - b.minX, (b.maxY - b.minY) * camera.aspect, 20);
  const dist = (size / 2) / Math.tan((camera.fov * Math.PI) / 360) / camera.aspect * 1.35;
  let dir = camera.position.clone().sub(controls.target).normalize();
  if (mode === 'top') dir = new THREE.Vector3(0, -0.0001, 1).normalize();
  if (mode === '3d') dir = new THREE.Vector3(0, -0.55, 1).normalize();
  controls.target.set(cx, cy, 0);
  camera.position.set(cx, cy, 0).addScaledVector(dir, dist);
}

// ── Export ─────────────────────────────────────────────
// format: 'stl' | 'obj' (single body) | '3mf' | 'split-stl' (color parts)
async function doExport(format) {
  const status = $('exportStatus');
  status.textContent = 'กำลังสร้างไฟล์...';
  const twoLevel = elements.some(e => e.type === 'base' && e.visible && e.baseStyle === 'raised');
  const multiFile = format === '3mf' || format === 'split-stl';
  const glue = multiFile && settings.glueSplit && twoLevel;
  if (multiFile && settings.glueSplit && !twoLevel) { status.textContent = 'แยกตัวนูน/ฐาน ใช้ได้เฉพาะเมื่อมีฐานแบบ “รองใต้ – ตัวหนังสือนูน”'; return; }
  const result = await computeResult(settings.exportQuality, { glue });
  if (!result) { status.textContent = 'ยังไม่มีชิ้นงานให้ export'; return; }
  if (glue) layoutGlueParts(result);
  const name = exportNameOverride || elements.find(e => e.type === 'text' && e.visible)?.text?.split('\n')[0] || 'keychain';
  let res;
  if (format === '3mf' || format === 'split-stl') {
    const parts = colorPartsOf(result);
    if (!parts) {
      status.textContent = 'ไม่มีส่วนขอบให้แยกสี — เพิ่ม “ขอบรอบนอก” หรือเปิดรูห่วง';
      disposeResult(result);
      return;
    }
    res = format === '3mf' ? await save3MF(parts, name) : await saveSplitSTL(parts, name);
  } else {
    res = await saveModel(result.geometry, format, name);
  }
  disposeResult(result);
  status.textContent = res.ok ? `บันทึกแล้ว: ${res.filePath}` : '';
}

// Glue split: lay the relief parts on the bed beside the base (bottom at z=0, shifted in +y past
// the base by 5 mm), keeping their relative positions so they still match the recess.
function layoutGlueParts(result) {
  const relief = (result.parts || []).filter(p => p.glueRelief);
  if (!relief.length) return;
  let minZ = Infinity, minY = Infinity;
  for (const p of relief) { p.geometry.computeBoundingBox(); minZ = Math.min(minZ, p.geometry.boundingBox.min.z); minY = Math.min(minY, p.geometry.boundingBox.min.y); }
  const dy = result.bounds.maxY + 5 - minY;
  for (const p of relief) p.geometry.translate(0, dy, -minZ);
}

// ── Wiring ─────────────────────────────────────────────
$('addText').onclick = () => addTextElement();
$('addImage').onclick = () => addImageElement();
$('addBase').onclick = () => addBaseElement();
$('addHole').onclick = () => addHoleElement();

// ── ▲▼ steppers next to every number field (static panels) ──
// Click = one step; hold = keeps stepping. Each step fires "input" (live preview); releasing
// fires one "change" (one undo step).
function addSteppers(root = document) {
  for (const input of root.querySelectorAll('input[type=number]')) {
    if (input.dataset.stepper || input.closest('#partsView, .part-popup')) continue;
    input.dataset.stepper = '1';
    input.classList.add('has-stepper');
    const box = document.createElement('span');
    box.className = 'stepper';
    box.innerHTML = '<button type="button" tabindex="-1" title="เพิ่ม">▲</button><button type="button" tabindex="-1" title="ลด">▼</button>';
    input.after(box);
    box.querySelectorAll('button').forEach((btn, i) => {
      let timer = null, repeat = null;
      const step = () => {
        if (input.disabled) return;
        if (input.value === '') input.value = input.placeholder && !isNaN(parseFloat(input.placeholder)) ? parseFloat(input.placeholder) : 0;
        i === 0 ? input.stepUp() : input.stepDown();
        input.dispatchEvent(new Event('input', { bubbles: true }));
      };
      const stop = () => {
        if (timer === null && repeat === null) return;
        clearTimeout(timer); clearInterval(repeat); timer = repeat = null;
        input.dispatchEvent(new Event('change', { bubbles: true }));
      };
      btn.addEventListener('pointerdown', (e) => {
        e.preventDefault();
        step();
        timer = setTimeout(() => { repeat = setInterval(step, 70); }, 400);
      });
      btn.addEventListener('pointerup', stop);
      btn.addEventListener('pointerleave', stop);
    });
  }
}
addSteppers();

// ── "⟲ 0,0" next to every X / Y position row ──
for (const yInput of document.querySelectorAll('input[type=number][data-el="y"]')) {
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'pos-reset';
  btn.textContent = '⟲ 0,0';
  btn.title = 'ย้ายกลับไปที่ตำแหน่ง X = 0, Y = 0';
  btn.addEventListener('click', () => {
    const el = selected();
    if (!el) return;
    el.x = 0; el.y = 0;
    commit();
    renderProps();
    renderOverlay();
  });
  (yInput.nextElementSibling?.classList.contains('stepper') ? yInput.nextElementSibling : yInput).after(btn);
}

// Key ring (the global loop): off by default, added from the "＋ รู / ห่วง" menu.
function addRing() {
  if (settings.holeEnabled) return;
  settings.holeEnabled = true;
  settings.holeX = null; settings.holeY = null; // auto position
  commit();
  renderProps();
}
$('addRing').onclick = () => addRing();

// "＋" dropdown menus: open on click, close on pick / outside click / Esc.
for (const menu of document.querySelectorAll('.add-menu')) {
  const list = menu.querySelector('.add-menu-list');
  menu.querySelector('.add-menu-btn').addEventListener('click', (e) => {
    e.stopPropagation();
    const open = list.classList.contains('hide');
    for (const l of document.querySelectorAll('.add-menu-list')) l.classList.add('hide');
    if (open) {
      $('addRing').disabled = settings.holeEnabled;
      $('addRing').textContent = settings.holeEnabled ? '⭕ ห่วงร้อยพวงกุญแจ (มีแล้ว)' : '⭕ ห่วงร้อยพวงกุญแจ';
      list.classList.remove('hide');
    }
  });
  list.addEventListener('click', () => list.classList.add('hide'));
}
window.addEventListener('pointerdown', (e) => {
  if (!e.target.closest('.add-menu')) for (const l of document.querySelectorAll('.add-menu-list')) l.classList.add('hide');
});
window.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') for (const l of document.querySelectorAll('.add-menu-list')) l.classList.add('hide');
});
const iconLibrary = createIconLibrary({ onPick: (picked) => addImageElement(picked) });

// ── Order sheets from the website ──
let installedFonts = [];
let exportNameOverride = null; // "<order>_<no>_<text>" while working on an order item
// alert() blocks the renderer — the self-test collects messages instead.
let notifyLog = null;
const notify = (msg) => (notifyLog ? notifyLog.push(msg) : alert(msg));

// Replaces the current design with one order item (undo-able with Ctrl+Z).
async function openOrderItem(item, orderName, { quiet = false } = {}) {
  const builtinIcons = (await window.api.listIcons()).filter(i => i.builtin);
  const design = await orderItemToDesign(item, { installedFonts, builtinIcons, orderName });
  elements = [];
  selectedId = null;
  Object.assign(settings, design.settings);
  applyColors();
  for (const p of design.parts) {
    if (p.type === 'text') {
      elements.push({
        ...baseElement(), type: 'text', text: p.text, font: p.font, bold: p.bold, italic: false,
        letterSpacing: 0, lineHeight: 1.2, align: 'center', color: p.color,
        x: p.x, y: p.y, outlineOn: false, outlineMM: 0, fontSizeMM: p.fontSizeMM, anchorLayout: p.anchorLayout
      });
    } else if (p.type === 'image') {
      const img = await loadImage(p.dataUrl);
      const el = {
        ...baseElement(), type: 'image', color: p.color, imageKey: `img${Date.now()}_${Math.random().toString(36).slice(2)}`,
        imageDataUrl: p.dataUrl, imageName: p.name, imgMode: p.imgMode, threshold: 50, invert: false,
        x: p.x, y: p.y, outlineOn: false, outlineMM: 0, widthMM: p.fitMM, heightMM: p.fitMM,
        fitMM: p.fitMM, fitFull: p.fitFull, anchorLayout: p.anchorLayout
      };
      imageCache.set(el.imageKey, Promise.resolve(img));
      elements.push(el);
    } else if (p.type === 'base') {
      elements.unshift({
        ...baseElement(), type: 'base', baseSize: 'auto', baseStyle: p.baseStyle, colorThrough: false,
        targetAll: true, targets: [], lockAspect: false, color: p.color, outlineOn: p.outlineOn !== false,
        outlineShape: p.outlineShape, outlineMM: p.outlineMM, outlineSmoothMM: p.outlineSmoothMM,
        outlineFilletMM: p.outlineFilletMM, outlineFlatness: p.outlineFlatness
      });
    }
  }
  exportNameOverride = design.exportName;
  document.title = `Onzen Flat Keychain — ${design.label} (${orderName})`;
  commit();
  renderLayerList();
  renderProps();
  await waitForBuild();
  // ORDER_FORMAT.md §2: the order's origin isn't guaranteed to be the piece's center — center the
  // whole piece (elements + key-ring hole) on (0,0) here.
  if (lastResult) {
    const b = lastResult.bounds;
    const cx = (b.minX + b.maxX) / 2, cy = (b.minY + b.maxY) / 2;
    if (Math.abs(cx) > 0.01 || Math.abs(cy) > 0.01) {
      for (const el of elements) { el.x = round2(el.x - cx); el.y = round2(el.y - cy); }
      if (settings.holeX != null) settings.holeX = round2(settings.holeX - cx);
      if (settings.holeY != null) settings.holeY = round2(settings.holeY - cy);
      commit();
      await waitForBuild();
    }
    // Sanity check against the website's own size estimate.
    const ex = design.expectedSize;
    if (ex && lastResult) {
      const got = { w: lastResult.bounds.maxX - lastResult.bounds.minX, h: lastResult.bounds.maxY - lastResult.bounds.minY, t: lastResult.heightMM };
      const off = ['w', 'h', 't'].filter(k => ex[k] && Math.abs(got[k] - ex[k]) > 1.5);
      if (off.length) design.warnings.push(`ขนาดต่างจากหน้าเว็บ: โปรแกรม ${got.w.toFixed(1)} × ${got.h.toFixed(1)} × ${got.t.toFixed(1)} mm · เว็บ ${ex.w ?? '-'} × ${ex.h ?? '-'} × ${ex.t ?? '-'} mm`);
      design.builtSize = got;
    }
  }
  if (!quiet) fitView('3d');
  if (!quiet && design.warnings.length) notify(`ใบงาน ${design.label}\n\n• ${design.warnings.join('\n• ')}`);
  return design;
}

// "Export ทั้งใบงาน": every item opened in turn and saved as <exportName>.3mf in one folder.
async function exportWholeOrder(items, orderName) {
  const dir = await window.api.pickFolder('เลือกโฟลเดอร์สำหรับไฟล์ 3MF ของใบงานนี้');
  if (!dir) return null;
  const lines = [];
  for (const it of items) {
    try {
      const design = await openOrderItem(it, orderName, { quiet: true });
      const result = await computeResult(settings.exportQuality);
      if (!result) { lines.push(`✗ ${design.label}: ไม่มีชิ้นงาน`); continue; }
      const parts = colorPartsOf(result) || [{ name: 'keychain', color: settings.bodyColor, geometry: result.geometry }];
      const file = `${design.exportName.replace(/[\\/:*?"<>|\n\r]+/g, '_')}.3mf`;
      await window.api.writeFileIn(dir, file, encode3MF(parts));
      disposeResult(result);
      lines.push(`✓ ${file}${design.warnings.length ? `  — ${design.warnings.join(' / ')}` : ''}`);
    } catch (err) {
      lines.push(`✗ #${it['ลำดับ'] ?? '?'}: ${err.message || err}`);
    }
  }
  if (window.api.finishFolder) await window.api.finishFolder(dir); // web: download the .zip
  notify(`Export ทั้งใบงาน → ${dir}\n\n${lines.join('\n')}`);
  return { dir, lines };
}

const orderDialog = createOrderDialog({ onOpenItem: openOrderItem, onExportAll: exportWholeOrder });

// ── Project files (.kcproj) ──
// Plain JSON: all settings + all elements (images embedded as data URLs), so one file reopens
// the exact design on any machine. Runtime-only state (caches, results) is never stored.
const PROJECT_FORMAT = 'onzen-flat-keychain-project';
let projectPath = null;
let projectDirty = false;

function markDirty() {
  if (projectDirty) return;
  projectDirty = true;
  window.api.setDirty(true);
  updateTitle();
}

function updateTitle() {
  const name = projectPath ? projectPath.split(/[\\/]/).pop() : 'งานใหม่';
  document.title = `${projectDirty ? '● ' : ''}${name} — Onzen Flat Keychain`;
}

function serializeProject() {
  return JSON.stringify({
    format: PROJECT_FORMAT, version: 1, savedAt: new Date().toISOString(),
    settings: { ...settings },
    elements: elements.map(e => ({ ...e }))
  });
}

async function saveProject(saveAs = false) {
  const defaultName = `${(exportNameOverride || elements.find(e => e.type === 'text')?.text?.split('\n')[0] || 'keychain').replace(/[\\/:*?"<>|]+/g, '_')}.kcproj`;
  const path = await window.api.saveProject({ filePath: saveAs ? null : projectPath, defaultName, text: serializeProject() });
  if (!path) return false;
  projectPath = path;
  projectDirty = false;
  window.api.setDirty(false);
  updateTitle();
  rememberWork(); // web:
  return true;
}

function loadProjectData(data) {
  if (!data || data.format !== PROJECT_FORMAT || !Array.isArray(data.elements)) throw new Error('ไม่ใช่ไฟล์งานของโปรแกรมนี้');
  elements = data.elements.map(e => ({ ...e }));
  // Settings saved by an older version may lack newer keys — keep current defaults for those.
  Object.assign(settings, data.settings || {});
  nextId = Math.max(0, ...elements.map(e => e.id || 0)) + 1;
  selectedId = null;
  exportNameOverride = null;
  applyColors();
  commit();
  renderLayerList();
  renderProps();
}

async function openProject(recentPath = null) {
  if (projectDirty && elements.length && !confirm('งานที่เปิดอยู่ยังไม่ได้บันทึก — เปิดงานอื่นแทนเลยหรือไม่?')) return;
  const res = recentPath ? await window.api.readProject(recentPath) : await window.api.openProject();
  if (!res) return;
  if (res.error) { alert(`เปิดไฟล์ไม่ได้: ${res.error}`); return; }
  try { loadProjectData(res.data); }
  catch (e) { alert(`เปิดไฟล์ไม่ได้: ${e.message}`); return; }
  projectPath = res.filePath;
  await waitForBuild();
  fitView('3d');
  projectDirty = false;
  window.api.setDirty(false);
  updateTitle();
  rememberWork(); // web:
}

window.api.onMenu('project-save', () => saveProject(false));
window.api.onMenu('project-save-as', () => saveProject(true));
window.api.onMenu('project-open', () => openProject());
window.api.onOpenRecent((filePath) => openProject(filePath));

// ── Presets (left-panel settings) ──
const presetPanel = createPresetPanel({
  select: $('presetSelect'), applyBtn: $('presetApply'), saveBtn: $('presetSave'),
  overwriteBtn: $('presetOverwrite'), renameBtn: $('presetRename'), deleteBtn: $('presetDelete')
}, {
  getSettings: () => settings,
  // Besides the left panel: the base style (flat / two-level) and the text thickness settings.
  getExtra: () => {
    const base = elements.find(e => e.type === 'base');
    const text = elements.find(e => e.type === 'text');
    return {
      baseStyle: base ? base.baseStyle : 'flat',
      text: text ? {
        useSharedThickness: text.useSharedThickness !== false, elThicknessMM: text.elThicknessMM,
        altHeights: !!text.altHeights, altOddMM: text.altOddMM, altEvenMM: text.altEvenMM
      } : null
    };
  },
  applyPreset: (s, extra) => {
    Object.assign(settings, s);
    if (extra) {
      const bases = elements.filter(e => e.type === 'base');
      for (const b of bases) b.baseStyle = extra.baseStyle;
      if (!bases.length && extra.baseStyle === 'raised' && elements.some(e => e.type !== 'hole')) {
        const b = addBaseElement(); // wraps every element (targetAll)
        b.baseStyle = 'raised';
      }
      if (extra.text) for (const t of elements.filter(e => e.type === 'text')) Object.assign(t, extra.text);
    }
    applyColors();
    commit();
    renderLayerList();
    renderProps();
  }
});
window.api.onOrderLoaded((payload) => orderDialog.load(payload));
window.api.onOrderShow(() => orderDialog.open());
$('addIcon').onclick = () => iconLibrary.open();
$('replaceImage').onclick = () => { const el = selected(); if (el?.type === 'image') replaceImage(el); };
$('undoBtn').onclick = undo;
$('redoBtn').onclick = redo;
$('exportStl').onclick = () => doExport('stl');
$('exportObj').onclick = () => doExport('obj');
$('export3mf').onclick = () => doExport('3mf');
$('exportSplitStl').onclick = () => doExport('split-stl');
$('viewTop').onclick = () => fitView('top');
$('view3d').onclick = () => fitView('3d');
$('viewFit').onclick = () => fitView();
$('holeAuto').onclick = () => { settings.holeX = null; settings.holeY = null; commit(); };

function round1(v) { return Math.round(v * 10) / 10; }
function round2(v) { return Math.round(v * 100) / 100; }

// ── Startup ────────────────────────────────────────────
async function init() {
  const fonts = await window.api.listSystemFonts();
  installedFonts = fonts;
  fontPicker.setFonts(fonts);
  defaultFont = ['Arial', 'Tahoma', 'Segoe UI'].find(f => fonts.includes(f)) || fonts[0] || 'Arial';
  // web: fonts added from a file (or read from the computer) show up without reloading
  window.api.onFontsChanged?.((list) => { installedFonts = list; fontPicker.setFonts(list); });

  prefs = { ...prefs, ...(await window.api.getPrefs()) };
  window.api.onPrefsChanged((p) => { prefs = { ...prefs, ...p }; requestRebuild('full'); });

  const selftest = await window.api.selftestInfo();
  if (selftest) { await runSelfTest(); return; }

  // web: continue the work left open last time in this browser
  let restored = null;
  try {
    const saved = await window.webApp?.autosaveGet();
    if (saved?.text) { loadProjectData(JSON.parse(saved.text)); restored = saved; }
  } catch (e) { console.warn('restore failed', e); }
  if (!restored) addTextElement();
  await waitForBuild();
  fitView('3d');
  // the starting design isn't "unsaved work" yet
  projectPath = restored?.projectPath || null;
  projectDirty = !!restored?.dirty;
  window.api.setDirty(projectDirty);
  updateTitle();
  restoreDone = true;
  rememberWork();
}

function waitForBuild() {
  return new Promise(resolve => {
    const check = () => (requestRebuild.raf || historyPending ? setTimeout(check, 30) : resolve());
    setTimeout(check, 30);
  });
}

// Dev self-test (only when launched with KC_SELFTEST=<dir>): builds sample keychains and writes
// their STLs + stats so manifoldness can be verified offline.
async function runSelfTest() {
  // The self-test predates the default size locks — start unlocked so its expectations hold.
  Object.assign(settings, { lockW: false, lockH: false, lockZ: false, holeEnabled: true }); // (ring now starts off)
  newElementOutlineOn = true; // (outline now starts off for new elements)
  const report = {};
  const save = async (name) => {
    const result = await computeResult(settings.exportQuality);
    report[name] = result ? { pieces: result.pieces, tris: result.geometry.getAttribute('position').count / 3, bounds: result.bounds } : null;
    if (result) await window.api.selftestWrite(`${name}.stl`, encodeModel(result.geometry, 'stl'));
    const parts = colorPartsOf(result);
    if (parts) {
      for (const p of parts) await window.api.selftestWrite(`${name}_${p.name}.stl`, encodeModel(p.geometry, 'stl'));
      await window.api.selftestWrite(`${name}.3mf`, encode3MF(parts));
    }
  };
  try {
    const text = addTextElement('Onzen');
    await waitForBuild();
    await save('text');

    // Synthetic image (black star + circle on transparent) overlapping the text.
    const c = document.createElement('canvas');
    c.width = 400; c.height = 400;
    const g = c.getContext('2d');
    g.fillStyle = '#000';
    g.beginPath();
    for (let i = 0; i < 10; i++) {
      const r = i % 2 ? 80 : 190, a = (i / 10) * Math.PI * 2 - Math.PI / 2;
      g.lineTo(200 + Math.cos(a) * r, 200 + Math.sin(a) * r);
    }
    g.closePath(); g.fill();
    g.globalCompositeOperation = 'destination-out';
    g.beginPath(); g.arc(200, 210, 40, 0, Math.PI * 2); g.fill();
    const img = await addImageElement({ name: 'star.png', dataUrl: c.toDataURL('image/png') });
    img.x = 30; img.widthMM = 30; img.heightMM = 30;
    commit();
    await waitForBuild();
    await save('combo');

    // Moving a later element must not move the auto-placed hole (it's anchored to the first).
    const holeBefore = { ...lastResult.holeCenter };
    img.x = 45; img.y = -12;
    commit();
    await waitForBuild();
    const holeAfter = { ...lastResult.holeCenter };
    report.holeAnchored = { before: holeBefore, after: holeAfter, ok: Math.hypot(holeBefore.x - holeAfter.x, holeBefore.y - holeAfter.y) < 1e-6 };
    img.x = 30; img.y = 0;

    const cut = addTextElement('A');
    cut.mode = 'cut'; cut.x = 30; cut.heightMM = 8;
    text.rotationDeg = 10;
    text.outlineMM = 0; img.outlineMM = 0;
    commit();
    await waitForBuild();
    await save('cut_nooutline');

    // Chamfer (top+bottom, both profiles) across every outline shape + the square hole tab.
    text.rotationDeg = 0;
    Object.assign(settings, { chamferTopMM: 0.8, chamferBottomMM: 0.4, chamferProfile: 'round' });
    text.outlineMM = 2.5; img.outlineMM = 2.5;
    // [name, text outline, image outline, global settings]
    const variants = [
      ['chamfer_contour', { outlineShape: 'contour', outlineSmoothMM: 3 }, { outlineShape: 'contour' }, { joinSmoothMM: 3 }],
      ['chamfer_rect', { outlineShape: 'rect', outlineFilletMM: 6 }, { outlineShape: 'contour' }, { joinSmoothMM: 0, holeShape: 'rect', holeFilletMM: 1.5, holeAngleDeg: 20 }],
      ['chamfer_capsule', { outlineShape: 'capsule', outlineFlatness: 5 }, { outlineShape: 'ellipse' }, { chamferProfile: 'chamfer' }],
      ['chamfer_ellipse', { outlineShape: 'ellipse' }, { outlineShape: 'rect', outlineFilletMM: 3 }, { holeShape: 'circle' }],
      ['chamfer_ends', { outlineShape: 'ends' }, { outlineShape: 'contour' }, {}]
    ];
    for (const [name, textPatch, imgPatch, settingsPatch] of variants) {
      Object.assign(text, textPatch);
      Object.assign(img, imgPatch);
      Object.assign(settings, settingsPatch);
      commit();
      await waitForBuild();
      await save(name);
    }

    // Bases: one shared base wrapping everything (capsule, then ends), then a base on the
    // text only while the star keeps its own outline.
    Object.assign(settings, { chamferTopMM: 0.6, chamferBottomMM: 0.3 });
    text.outlineMM = 0; img.outlineMM = 0;
    const base = addBaseElement();
    await waitForBuild();
    await save('base_capsule');
    base.outlineShape = 'ends';
    commit();
    await waitForBuild();
    await save('base_ends');
    Object.assign(base, { targetAll: false, targets: [text.id], outlineShape: 'rect', outlineFilletMM: 4 });
    img.outlineMM = 2;
    commit();
    await waitForBuild();
    await save('base_textonly');
    removeElement(base.id);
    text.outlineMM = 2.5; img.outlineMM = 2.5;

    // Final on-screen state for the screenshot: different outline per element.
    Object.assign(text, { outlineShape: 'ends', text: 'Onzenly' });
    await save('ends_equal');
    Object.assign(img, { outlineShape: 'contour', outlineMM: 2 });
    Object.assign(settings, { joinSmoothMM: 2, holeShape: 'rect', holeFilletMM: 1.5, holeAngleDeg: 0 });
    commit();
    await waitForBuild();
    // Simulated mouse: drag the image's top-right corner handle outward, then its rotate knob,
    // and check both the element and the side-panel fields follow.
    select(img.id);
    fitView('top');
    await new Promise(r => setTimeout(r, 300));
    const canvas = renderer.domElement;
    const mouse = async (type, target, x, y, extra = {}) => {
      target.dispatchEvent(new PointerEvent(type, { clientX: x, clientY: y, button: 0, bubbles: true, ...extra }));
      await new Promise(r => setTimeout(r, 30));
    };
    const dragHandle = async (hnd, dx, dy, extra) => {
      const s0 = toScreen(hnd.x, hnd.y);
      await mouse('pointerdown', canvas, s0.x, s0.y);
      for (let i = 1; i <= 5; i++) await mouse('pointermove', window, s0.x + dx * i / 5, s0.y + dy * i / 5, extra);
      await mouse('pointerup', window, s0.x + dx, s0.y + dy);
      await waitForBuild();
    };
    const before = { w: img.widthMM, h: img.heightMM, x: img.x, y: img.y, r: img.rotationDeg };
    await dragHandle(elementHandles(img).corners.find(c => c.sx === 1 && c.sy === 1), 60, -60);
    const afterScale = { w: img.widthMM, h: img.heightMM, x: img.x, y: img.y, panelW: document.querySelector('input[type=number][data-el=widthMM]').value };
    await dragHandle(elementHandles(img).knob, 120, 60, { shiftKey: true });
    const afterRotate = { r: img.rotationDeg, panelR: document.querySelector('input[type=number][data-el=rotationDeg]').value };
    report.viewportHandles = {
      before, afterScale, afterRotate,
      scaled: afterScale.w > before.w && Math.abs(afterScale.w / afterScale.h - before.w / before.h) < 0.02 && String(afterScale.w) === afterScale.panelW,
      rotated: afterRotate.r !== before.r && afterRotate.r % 15 === 0 && String(afterRotate.r) === afterRotate.panelR
    };
    // Manual base: switch via the same path as the UI select, then enlarge it with its corner
    // handle — it must follow the mouse independently of the elements it used to wrap.
    const freeBase = addBaseElement();
    setElementField(freeBase, 'outlineShape', 'rect');
    setElementField(freeBase, 'outlineFilletMM', 6);
    setElementField(freeBase, 'baseSize', 'manual');
    commit();
    await waitForBuild();
    renderProps();
    fitView('top');
    await new Promise(r => setTimeout(r, 300));
    const fb0 = { w: freeBase.widthMM, h: freeBase.heightMM };
    await dragHandle(elementHandles(freeBase).corners.find(c => c.sx === 1 && c.sy === -1), 40, 40);
    report.manualBase = { before: fb0, after: { w: freeBase.widthMM, h: freeBase.heightMM }, ok: freeBase.widthMM > fb0.w && freeBase.heightMM > fb0.h };
    await save('base_manual');
    removeElement(freeBase.id);

    // Raised relief: auto base under the text (with chamfer + 2 colors), without chamfer, and a
    // manual base carrying everything on it.
    const relief = addBaseElement();
    Object.assign(relief, { baseStyle: 'raised', raiseMM: 1.5, targetAll: false, targets: [text.id], outlineShape: 'capsule', outlineMM: 3 });
    commit(); await waitForBuild();
    await save('relief_chamfer');
    report.relief = { heightMM: lastResult.heightMM, split: !!lastResult.colorParts };
    const cham = { t: settings.chamferTopMM, b: settings.chamferBottomMM };
    Object.assign(settings, { chamferTopMM: 0, chamferBottomMM: 0 });
    commit(); await waitForBuild();
    await save('relief_flat');
    setElementField(relief, 'baseSize', 'manual');
    Object.assign(settings, { chamferTopMM: cham.t, chamferBottomMM: cham.b });
    commit(); await waitForBuild();
    await save('relief_manual');
    removeElement(relief.id);
    await waitForBuild();

    // Alt + corner drag scales about the center: the center must not move.
    select(img.id);
    renderOverlay();
    const c0 = { x: img.x, y: img.y, w: img.widthMM };
    await dragHandle(elementHandles(img).corners.find(c => c.sx === 1 && c.sy === 1), 30, -30, { altKey: true });
    report.altScale = { before: c0, after: { x: img.x, y: img.y, w: img.widthMM }, ok: Math.abs(img.x - c0.x) < 0.02 && Math.abs(img.y - c0.y) < 0.02 && img.widthMM > c0.w };

    // Bend / wave on the text: glyph scale must stay (height grows, not shrinks).
    const t0 = { w: text.widthMM, h: text.heightMM };
    text.bendDeg = 70; commit(); await waitForBuild(); await save('bend');
    report.bend = { before: t0, after: { w: text.widthMM, h: text.heightMM }, ok: text.heightMM > t0.h };
    text.bendDeg = -70; commit(); await waitForBuild(); await save('bend_down');
    text.bendDeg = 0; text.waveAmp = 35; text.waveCount = 1.5; commit(); await waitForBuild(); await save('wave');

    // Built-in icon.
    const icons = await window.api.listIcons();
    const heart = icons.find(i => i.builtin && i.name === 'heart');
    const heartEl = await addImageElement({ name: 'หัวใจ', dataUrl: heart.dataUrl });
    Object.assign(heartEl, { x: -20, y: 22, widthMM: 16, heightMM: 16 });
    commit(); await waitForBuild(); await save('icon_heart');
    report.icons = { builtin: icons.filter(i => i.builtin).length, user: icons.filter(i => !i.builtin).length };

    // Min feature width: a 0.15 mm hairline must be removed at 0.4 mm.
    const hc = document.createElement('canvas');
    hc.width = 400; hc.height = 200;
    const hg = hc.getContext('2d');
    hg.fillRect(20, 40, 120, 120);   // solid block
    hg.fillRect(140, 99, 240, 2);     // 2px of 400px over 30mm ≈ 0.15 mm hairline
    const hair = await addImageElement({ name: 'hairline.png', dataUrl: hc.toDataURL('image/png') });
    Object.assign(hair, { x: 0, y: -30, widthMM: 30, heightMM: 15, outlineMM: 0 });
    commit(); await waitForBuild();
    report.minFeature = { minFeatureMM: prefs.minFeatureMM, removedMM2: lastResult.removedMM2, ok: lastResult.removedMM2 > 1 };
    await save('minfeature');
    removeElement(hair.id);
    await waitForBuild();

    select(text.id);
    fitView('3d');
    await new Promise(r => setTimeout(r, 300));
    renderOverlay();
    // Final screenshot: text + heart raised on a capsule base.
    const showBase = addBaseElement();
    Object.assign(showBase, { baseStyle: 'raised', raiseMM: 1.5, outlineShape: 'capsule', outlineMM: 3 });
    text.waveAmp = 0; text.outlineMM = 0; img.visible = false;
    commit(); await waitForBuild();
    // Manual base only half as wide as the content: the text must stay fully raised past its edge.
    setElementField(showBase, 'baseSize', 'manual');
    showBase.widthMM = round1(showBase.widthMM * 0.5);
    showBase.x = round1(showBase.x - showBase.widthMM / 2);
    commit(); await waitForBuild();
    report.reliefPastEdge = { heightMM: lastResult.heightMM, pieces: lastResult.pieces };
    await save('relief_past_edge');
    // Alternating letter heights (odd 4 / even 2) + the heart on its own 1 mm height.
    text.altHeights = true;
    heartEl.useSharedThickness = false; heartEl.elThicknessMM = 1;
    commit(); await waitForBuild();
    report.reliefAlt = { heightMM: lastResult.heightMM, expected: settings.thicknessMM + text.altOddMM };
    await save('relief_alt');
    showBase.colorThrough = true;
    commit(); await waitForBuild();
    await save('relief_through');
    showBase.colorThrough = false;
    commit(); await waitForBuild();
    // Overlapping elements with different own heights: each keeps its own height.
    Object.assign(heartEl, { x: -14, y: 6, widthMM: 18, heightMM: 18 });
    commit(); await waitForBuild();
    report.reliefOverlap = { heightMM: lastResult.heightMM };
    await save('relief_overlap');
    select(text.id);
    fitView('3d');
    await new Promise(r => setTimeout(r, 500));
  } catch (err) {
    report.error = String(err && err.stack || err);
  }
  // Order sheet from the website: same field names/values as KeychainShop's spec().
  try {
    notifyLog = [];
    const dot = document.createElement('canvas'); dot.width = 300; dot.height = 200;
    const dg = dot.getContext('2d'); dg.fillRect(20, 20, 260, 160); dg.clearRect(120, 70, 60, 60);
    const order = { 'วันที่': '2026-09-30T19:32:53.166Z', 'รายการ': [
      { 'ลำดับ': 1, 'จำนวน': 2, 'ราคา': 109, 'แบบ': 'แบน (ระนาบเดียว)', 'ข้อความ': 'CHERENE', 'ฟอนต์': 'Kanit', 'ตัวหนา': true,
        'ความสูงตัวอักษร_mm': 10, 'ไอคอน': 'หัวใจ', 'ขนาดไอคอน_mm': 14, 'เลื่อนไอคอนจากตำแหน่งเริ่มต้น_mm': { x: 0, y: 0 }, 'ถมช่องใน': true,
        'ตำแหน่งไอคอน': 'ซ้ายของข้อความ', 'ขอบรอบนอก': 'ตามรูปร่าง', 'ระยะขอบ_mm': 1.5, 'ความsmooth': 1.5,
        'ความหนา_mm': { 'ชิ้นงาน': 3 }, 'รูห่วง': { 'ขนาดรู_mm': 5, 'ขอบรอบรู_mm': 2.5, 'ตำแหน่ง': 'อัตโนมัติชิดซ้าย' },
        'สี': { 'เนื้องาน (ข้อความ/ไอคอน)': 'ขาว', 'ขอบ + ห่วง': 'น้ำเงิน' }, 'ขนาดโดยประมาณ_mm': { x: 80, y: 20 } },
      { 'ลำดับ': 2, 'จำนวน': 1, 'ราคา': 168, 'แบบ': 'สองระดับ (ตัวนูน) - ฐานแบบ "รองใต้ – ตัวหนังสือนูน"', 'ข้อความ': 'Mali', 'ฟอนต์': 'Arial', 'ตัวหนา': true,
        'ความสูงตัวอักษร_mm': 12, 'ไอคอน': 'รูปลูกค้า (ส่วนที่ไม่โปร่งใส)', 'ขนาดไอคอน_mm': 16, 'เลื่อนไอคอนจากตำแหน่งเริ่มต้น_mm': { x: 2, y: 3 }, 'ถมช่องใน': true,
        'ตำแหน่งไอคอน': 'ขวาของข้อความ', 'ขอบรอบนอก': 'แคปซูล', 'ระยะขอบ_mm': 2.5,
        'ความหนา_mm': { 'ฐาน': 3, 'element': 2 }, 'รูห่วง': { 'ขนาดรู_mm': 5, 'ขอบรอบรู_mm': 2.5, 'ตำแหน่ง': 'อัตโนมัติชิดซ้าย' },
        'สี': { 'ฐาน': 'น้ำเงิน', 'ตัวหนังสือนูน': 'ขาว', 'ไอคอนนูน': 'แดง' }, 'รูปลูกค้า': dot.toDataURL('image/png') }
    ] };
    const d1 = await openOrderItem(order['รายการ'][0], 'order-1790796773167.json');
    report.order1 = { label: d1.label, exportName: exportNameOverride, heightMM: lastResult?.heightMM, bounds: lastResult?.bounds,
      parts: colorPartsOf(lastResult)?.map(p => `${p.name} ${p.color}`), elements: elements.map(e => ({ type: e.type, x: e.x, y: e.y, w: e.widthMM, h: e.heightMM })) };
    await save('order1');
    const d2 = await openOrderItem(order['รายการ'][1], 'order-1790796773167.json');
    report.order2 = { label: d2.label, heightMM: lastResult?.heightMM, parts: colorPartsOf(lastResult)?.map(p => `${p.name} ${p.color}`),
      elements: elements.map(e => ({ type: e.type, x: e.x, y: e.y, w: e.widthMM, h: e.heightMM })) };
    await save('order2');
    // ── spec v2 (ORDER_FORMAT.md): direct positions, note, defaults, export-all ──
    const v2 = { 'เวอร์ชันสเปก': 2, 'วันที่': '2026-10-05T10:00:00.000Z', 'รายการ': [
      { 'ลำดับ': 1, 'จำนวน': 3, 'ราคา': 109, 'แบบ': 'แบน (ระนาบเดียว)', 'ข้อความ': 'Momo', 'ฟอนต์': 'Arial', 'ตัวหนา': true,
        'ความสูงตัวอักษร_mm': 10, 'ไอคอน': 'ดาว', 'ขนาดไอคอน_mm': 12,
        'ตำแหน่งข้อความ_mm': { x: 4, y: 1 }, 'ตำแหน่งไอคอน_mm': { x: -16, y: 1 },
        'รูห่วง': { 'ขนาดรู_mm': 5, 'ขอบรอบรู_mm': 2.5, 'ตำแหน่ง': 'ลากวางเอง', 'ตำแหน่ง_mm': { x: -30, y: 1 } },
        'ขอบรอบนอก': 'ตามรูปร่าง', 'ระยะขอบ_mm': 1.5, 'ความsmooth': 2, 'ถมช่องใน': true,
        'สี': { 'เนื้องาน (ข้อความ/ไอคอน)': 'ขาว', 'ขอบ + ห่วง': 'ชมพู' },
        'ขนาดโดยประมาณ_mm': { w: 54, h: 17, t: 2 }, 'หมายเหตุลูกค้า': 'ขอตัวอักษรหนาหน่อยค่ะ' },
      { 'ลำดับ': 2, 'จำนวน': 1, 'ราคา': 129, 'แบบ': 'สองระดับ (ตัวนูน) - ฐานแบบ "รองใต้ – ตัวหนังสือนูน"', 'ข้อความ': 'Ten', 'ฟอนต์': 'Arial', 'ตัวหนา': true,
        'ความสูงตัวอักษร_mm': 9, 'ไอคอน': 'ไม่มี', 'ตำแหน่งข้อความ_mm': { x: 0, y: 0 }, 'ตำแหน่งไอคอน_mm': null,
        'รูห่วง': { 'ขนาดรู_mm': 5, 'ขอบรอบรู_mm': 2.5, 'ตำแหน่ง': 'อัตโนมัติชิดซ้าย', 'ตำแหน่ง_mm': { x: -16, y: 0 } },
        'ขอบรอบนอก': 'แคปซูล', 'ระยะขอบ_mm': 2, 'ถมช่องใน': true, 'ความหนา_mm': {},
        'สี': { 'ฐาน': 'ดำ', 'ตัวหนังสือนูน': 'เหลือง' } }
    ] };
    // item 1: relative layout must match the order (hole − text, icon − text), whatever the recentering
    const d3 = await openOrderItem(v2['รายการ'][0], 'order-v2-test.json', { quiet: true });
    const textEl = elements.find(e => e.type === 'text'), iconEl = elements.find(e => e.type === 'image');
    const tsrc = await getSource(textEl), isrc = await getSource(iconEl);
    const layoutPos = (el, src) => {                       // the website's layout-box center of an element
      const k = el.widthMM / src.width;
      return { x: el.x - (src.width / 2 - src.layoutCenter.x) * k, y: el.y - (src.layoutCenter.y - src.height / 2) * k };
    };
    const tp = layoutPos(textEl, tsrc), ip = layoutPos(iconEl, isrc);
    report.orderV2 = {
      label: d3.label, version: d3.specVersion, warnings: d3.warnings, builtSize: d3.builtSize,
      holeMinusText: [+(settings.holeX - tp.x).toFixed(2), +(settings.holeY - tp.y).toFixed(2)],   // expect (-34, 0)
      iconMinusText: [+(ip.x - tp.x).toFixed(2), +(ip.y - tp.y).toFixed(2)],                       // expect (-20, 0)
      iconSquare: [+(iconEl.widthMM).toFixed(2), +(iconEl.heightMM).toFixed(2)], thickness: settings.thicknessMM
    };
    await save('order_v2_flat');
    // item 2: missing thickness → website defaults (2 + 1)
    await openOrderItem(v2['รายการ'][1], 'order-v2-test.json', { quiet: true });
    report.orderV2b = { thickness: settings.thicknessMM, element: settings.elementThicknessMM, heightMM: lastResult.heightMM };
    // dialog shows the note; export-all writes one 3MF per item
    orderDialog.load({ name: 'order-v2-test.json', data: v2 });
    report.orderV2Note = document.querySelector('.order-note')?.textContent || null;
    document.querySelector('.icon-overlay:not(.hide) .icon-close')?.click();
    const exp = await exportWholeOrder(v2['รายการ'], 'order-v2-test.json');
    report.orderV2Export = exp?.lines;
    // restore the state the later tests were written against (after v1 order #2)
    await openOrderItem(order['รายการ'][1], 'order-1790796773167.json', { quiet: true });
    report.orderWarnings = notifyLog;
    await new Promise(r => setTimeout(r, 400));
  } catch (err) {
    report.orderError = String(err && err.stack || err);
  }
  // Overall size panel: one-off width edit, width lock under a design change, both locks, Z.
  try {
    const settle = async () => {
      // wait until no fit, no queued build and no pending history — twice in a row
      let calm = 0;
      for (let t = 0; t < 600 && calm < 2; t++) {
        await new Promise(r => setTimeout(r, 50));
        calm = !fitting && !requestRebuild.raf && !historyPending ? calm + 1 : 0;
      }
    };
    const size = () => { const { w, h } = boundsSize(lastResult.bounds); return { w: round2(w), h: round2(h), z: lastResult.heightMM }; };
    await settle();
    const s0 = size();
    onTotalSizeEdit('w', 70);
    await settle();
    const s1 = size();
    settings.lockW = true; settings.targetW = s1.w;
    const textEl = elements.find(e => e.type === 'text');
    textEl.boldMM = 0.6;
    commit();
    await settle();
    const s2 = size();
    settings.lockH = true; settings.targetH = round2(s2.h - 3);
    const base = elements.find(e => e.type === 'base');
    base.outlineMM = 4;
    commit();
    const t0 = Date.now();
    await settle();
    const s3 = size();
    onTotalZEdit(6);
    await settle();
    const s4 = size();
    report.totalSize = {
      start: s0, editW70: s1, lockedW_afterBold: s2, bothLocked: { ...s3, targetW: settings.targetW, targetH: settings.targetH, ms: Date.now() - t0 }, z6: s4,
      ok: Math.abs(s1.w - 70) <= 0.1 && Math.abs(s2.w - s1.w) <= 0.1 && s3.w <= settings.targetW + 0.1 && s3.h <= settings.targetH + 0.1 && Math.abs(s4.z - 6) < 0.01
    };
    await save('total_size');
  } catch (err) {
    report.totalSizeError = String(err && err.stack || err);
  }
  // Drilled cylinder holes: vertical + horizontal (through and fixed length, rotated), on the
  // two-level piece (separate parts) and then on a flat chamfered piece.
  try {
    for (const k of ['lockW', 'lockH']) settings[k] = false;
    const b = lastResult.bounds;
    const cx = (b.minX + b.maxX) / 2, cy = (b.minY + b.maxY) / 2;
    const v = addHoleElement();
    report.holeDefaults = { dir: v.holeDir, dia: v.heightMM };
    setHoleField(v, 'holeDir', 'vertical');
    Object.assign(v, { x: round1(cx + 12), y: round1(cy), widthMM: 3, heightMM: 3 });
    const hThrough = addHoleElement();
    setHoleField(hThrough, 'holeDir', 'horizontal');
    Object.assign(hThrough, { x: round1(cx), y: round1(cy - 2), heightMM: 2, zMM: 1.5, rotationDeg: 0, throughAll: true });
    const hShort = addHoleElement();
    setHoleField(hShort, 'holeDir', 'horizontal');
    Object.assign(hShort, { x: round1(cx - 10), y: round1(cy + 3), heightMM: 1.6, widthMM: 14, zMM: 4, rotationDeg: 30, throughAll: false });
    commit();
    await waitForBuild();
    report.holesTwoLevel = { sideHoleFailed: !!lastResult.sideHoleFailed, parts: colorPartsOf(lastResult)?.map(p => p.name) };
    await save('holes_twolevel');
    // flat + chamfer
    for (const el of elements) if (el.type === 'base') el.baseStyle = 'flat';
    Object.assign(settings, { chamferTopMM: 0.5, chamferBottomMM: 0.3 });
    commit();
    await waitForBuild();
    report.holesFlat = { sideHoleFailed: !!lastResult.sideHoleFailed };
    await save('holes_flat');
    select(hShort.id);
    renderOverlay();
    fitView('3d');
    await new Promise(r => setTimeout(r, 400));
  } catch (err) {
    report.holesError = String(err && err.stack || err);
  }
  // Z lock, default size locks, and project save → load round trip.
  try {
    const settle = async () => {
      let calm = 0;
      for (let t = 0; t < 600 && calm < 3; t++) {
        await new Promise(r => setTimeout(r, 50));
        calm = !fitting && !requestRebuild.raf && !historyPending ? calm + 1 : 0;
      }
    };
    const dims = () => ({ ...boundsSize(lastResult.bounds), z: lastResult.heightMM });
    // two-level Z lock
    for (const el of elements) if (el.type === 'base') el.baseStyle = 'raised';
    Object.assign(settings, { chamferTopMM: 0, chamferBottomMM: 0, lockZ: true, targetZ: 9 });
    commit(); await settle();
    const z1 = dims().z;
    settings.thicknessMM = 4;
    commit(); await settle();
    const z2 = dims().z;
    report.zLock = { afterLock: z1, afterBase4: z2, ok: Math.abs(z1 - 9) < 0.02 && Math.abs(z2 - 9) < 0.02 };
    // element thickness locked too: a new Z target must move the BASE, not the relief
    settings.lockElemT = true;
    const reliefBefore = dims().z - settings.thicknessMM;
    onTotalZEdit(10);
    await settle();
    report.elemLock = { base: settings.thicknessMM, z: dims().z, relief: dims().z - settings.thicknessMM, reliefBefore,
      ok: Math.abs(dims().z - 10) < 0.02 && Math.abs(dims().z - settings.thicknessMM - reliefBefore) < 0.02 };
    settings.lockElemT = false;

    // project round trip
    const before = { ...dims(), n: elements.length, json: serializeProject() };
    const saved = JSON.parse(before.json);
    elements = []; commit(); await settle();
    loadProjectData(saved);
    await settle();
    const after = { ...dims(), n: elements.length };
    report.project = {
      bytes: before.json.length, before: { w: before.w, h: before.h, z: before.z, n: before.n }, after,
      ok: after.n === before.n && Math.abs(after.w - before.w) < 0.01 && Math.abs(after.h - before.h) < 0.01 && Math.abs(after.z - before.z) < 0.01
    };
    await window.api.selftestWrite('roundtrip.kcproj', before.json);
    report.projectPath = (await window.api.selftestInfo()).dir + '/roundtrip.kcproj';

    // defaults for a new design: Y locked at 25, Z locked at 12.65
    elements = [];
    Object.assign(settings, { lockW: false, lockH: true, targetH: 25, lockZ: true, targetZ: 12.65, thicknessMM: 3 });
    addTextElement();
    await settle();
    report.defaults = { ...dims(), ok: Math.abs(dims().h - 25) < 0.06 && Math.abs(dims().z - 12.65) < 0.01 };
    await save('defaults');
    fitView('3d');
    await new Promise(r => setTimeout(r, 400));
  } catch (err) {
    report.projectError = String(err && err.stack || err);
  }
  // Presets through the real UI (modal name input), then the recent-file open path.
  try {
    const fill = async (text) => {
      await new Promise(r => setTimeout(r, 100));
      const input = document.querySelector('.prompt-input');
      input.value = text;
      input.closest('.icon-dialog').querySelector('.prompt-ok').click();
      await new Promise(r => setTimeout(r, 200));
    };
    settings.thicknessMM = 4.2;
    $('presetSave').click(); await fill('ทดสอบ A');
    settings.thicknessMM = 2.5;
    $('presetSave').click(); await fill('ทดสอบ B');
    $('presetSelect').value = 'ทดสอบ A'; $('presetSelect').dispatchEvent(new Event('change'));
    $('presetApply').click();
    const appliedThickness = settings.thicknessMM;
    $('presetRename').click(); await fill('ทดสอบ A2');
    $('presetSelect').value = 'ทดสอบ B'; $('presetSelect').dispatchEvent(new Event('change'));
    const origConfirm = window.confirm; window.confirm = () => true;
    $('presetDelete').click();
    await new Promise(r => setTimeout(r, 200));
    window.confirm = origConfirm;
    const stored = await window.api.getPresets();
    report.presets = { appliedThickness, names: stored.map(p => p.name), ok: appliedThickness === 4.2 && stored.length === 1 && stored[0].name === 'ทดสอบ A2' && stored[0].settings.thicknessMM === 4.2 };
    // base style + text thickness in a preset
    {
      const textEl = elements.find(e => e.type === 'text') || addTextElement('Onzen');
      let base = elements.find(e => e.type === 'base') || addBaseElement();
      base.baseStyle = 'raised';
      Object.assign(textEl, { useSharedThickness: false, elThicknessMM: 3.3, altHeights: true, altOddMM: 5, altEvenMM: 2.5 });
      commit(); await waitForBuild();
      $('presetSave').click(); await fill('สองระดับ สลับสูง');
      // change everything away from the preset
      base.baseStyle = 'flat';
      Object.assign(textEl, { useSharedThickness: true, altHeights: false, altOddMM: 4, altEvenMM: 2 });
      commit(); await waitForBuild();
      $('presetSelect').value = 'สองระดับ สลับสูง'; $('presetSelect').dispatchEvent(new Event('change'));
      $('presetApply').click(); await waitForBuild();
      const r1 = { baseStyle: base.baseStyle, shared: textEl.useSharedThickness, own: textEl.elThicknessMM, alt: textEl.altHeights, odd: textEl.altOddMM, even: textEl.altEvenMM };
      // no base at all → applying a two-level preset creates one
      removeElement(base.id); await waitForBuild();
      $('presetApply').click(); await waitForBuild();
      base = elements.find(e => e.type === 'base');
      report.presetExtra = { applied: r1, createdBase: base ? base.baseStyle : null,
        ok: r1.baseStyle === 'raised' && r1.shared === false && r1.own === 3.3 && r1.alt === true && r1.odd === 5 && r1.even === 2.5 && base?.baseStyle === 'raised' };
      await save('preset_extra');
    }
    // recent: open the project file written earlier by its path
    const rp = report.projectPath;
    if (rp) {
      projectDirty = false;
      await openProject(rp);
      report.recentOpen = { title: document.title, elements: elements.length };
    }
  } catch (err) {
    report.presetError = String(err && err.stack || err);
  }
  // Color split from a 3-color PNG, with a vertical drilled hole through it; two-level + flat.
  try {
    for (const k of ['lockW', 'lockH', 'lockZ']) settings[k] = false;
    elements = [];
    const pc = document.createElement('canvas'); pc.width = 300; pc.height = 300;
    const pg = pc.getContext('2d');
    pg.fillStyle = '#d62828'; pg.beginPath(); pg.arc(110, 150, 90, 0, Math.PI * 2); pg.fill();      // red circle
    pg.fillStyle = '#1d4ed8'; pg.fillRect(150, 60, 130, 180);                                       // blue block
    pg.fillStyle = '#fcbf49'; pg.beginPath(); pg.arc(215, 150, 35, 0, Math.PI * 2); pg.fill();     // yellow dot
    const imgEl = await addImageElement({ name: 'three-colors.png', dataUrl: pc.toDataURL('image/png') });
    Object.assign(imgEl, { x: 0, y: 0, widthMM: 40, heightMM: 40, colorSplit: true, colorAuto: true, outlineMM: 0, color: '#ffffff' });
    const drill = addHoleElement();
    setHoleField(drill, 'holeDir', 'vertical');
    Object.assign(drill, { x: 3, y: 0, widthMM: 5, heightMM: 5 });
    const base = addBaseElement();
    Object.assign(base, { baseStyle: 'raised', outlineShape: 'rect', outlineMM: 3, outlineFilletMM: 4 });
    Object.assign(settings, { thicknessMM: 3, elementThicknessMM: 2, chamferTopMM: 0, chamferBottomMM: 0 });
    commit(); await waitForBuild();
    const src = await getSource(imgEl);
    report.colorSplitDetected = (src.colorLayers || []).map(L => `${L.color} ${Math.round(L.share * 100)}%`);
    report.colorSplitTwoLevel = colorPartsOf(lastResult)?.map(p => `${p.name} ${p.color}`);
    await save('colorsplit_twolevel');
    // Parts panel: give two colors their own heights through the real inputs
    setRightTab('parts');
    const rows = [...document.querySelectorAll('#partsView .part-row')];
    const setRowHeight = (idx, v) => { const inp = rows[idx].querySelector('input[type=number]'); inp.value = v; inp.dispatchEvent(new Event('change')); };
    setRowHeight(2, 4);   // row 0 = base, 1..3 = colors
    await waitForBuild();
    const rows2 = [...document.querySelectorAll('#partsView .part-row')];
    rows2[3].querySelector('input[type=number]').value = 1;
    rows2[3].querySelector('input[type=number]').dispatchEvent(new Event('change'));
    await waitForBuild();
    const zTop = (g) => { g.computeBoundingBox(); return +g.boundingBox.max.z.toFixed(3); };
    report.partsPanel = {
      rows: [...document.querySelectorAll('#partsView .part-row')].map(r => `${r.querySelector('.pname').textContent} | ${r.querySelector('input[type=number]').value} | ${r.querySelector('.slot').textContent}`),
      tops: colorPartsOf(lastResult).map(pp => `${pp.name}: ${zTop(pp.geometry)}`),
      layerHeights: imgEl.layerHeights
    };
    await save('parts_heights');
    rows2[1].click(); // highlight colour 1 for the screenshot

    // auto color count on a 5-stripe image
    {
      const sc = document.createElement('canvas'); sc.width = 250; sc.height = 100;
      const sg = sc.getContext('2d');
      ['#e63946', '#2a9d8f', '#f4a261', '#264653', '#ffffff'].forEach((c, i) => { sg.fillStyle = c; sg.fillRect(i * 50, 0, 50, 100); });
      const stripes = await getSource({ type: 'image', imageKey: 'stripes-test', imageDataUrl: sc.toDataURL('image/png'), imgMode: 'alpha', threshold: 50, colorSplit: true, colorAuto: true });
      report.autoColors = { threeColorImage: (src.colorLayers || []).length, fiveStripes: (stripes.colorLayers || []).length };
    }

    // C: click the yellow part in the viewport → popup → change its height there
    {
      const yellow = colorPartsOf(lastResult).find(pp => pp.colorIndex === 2);
      yellow.geometry.computeBoundingBox();
      const bb = yellow.geometry.boundingBox;
      fitView('top');
      await new Promise(r => setTimeout(r, 300));
      const v = new THREE.Vector3((bb.min.x + bb.max.x) / 2, (bb.min.y + bb.max.y) / 2, bb.max.z).project(camera);
      const rect = renderer.domElement.getBoundingClientRect();
      const sx = rect.left + ((v.x + 1) / 2) * rect.width, sy = rect.top + ((1 - v.y) / 2) * rect.height;
      renderer.domElement.dispatchEvent(new PointerEvent('pointerdown', { clientX: sx, clientY: sy, button: 0, bubbles: true }));
      renderer.domElement.dispatchEvent(new PointerEvent('pointerup', { clientX: sx, clientY: sy, button: 0, bubbles: true })); // real mouse-up lands on the canvas
      await new Promise(r => setTimeout(r, 100));
      const opened = { visible: !partPopup.classList.contains('hide'), key: popupKey, label: partPopup.querySelector('.ph span')?.textContent };
      const ph = partPopup.querySelector('input[type=number]');
      ph.value = 2.5; ph.dispatchEvent(new Event('change'));
      await waitForBuild();
      const panelRow = [...document.querySelectorAll('#partsView .part-row')].find(r => r.querySelector('.pname').textContent.includes('สี 3'));
      report.popup = { opened, layerHeights: imgEl.layerHeights, panelShows: panelRow?.querySelector('input[type=number]').value };
      closePartPopup();
    }
    base.baseStyle = 'flat';
    settings.splitColors = true;
    commit(); await waitForBuild();
    report.colorSplitFlat = colorPartsOf(lastResult)?.map(p => `${p.name} ${p.color}`);
    await save('colorsplit_flat');
    Object.assign(settings, { chamferTopMM: 0.5, chamferBottomMM: 0.3 });
    commit(); await waitForBuild();
    report.colorSplitFlatChamfer = colorPartsOf(lastResult)?.map(p => `${p.name} ${p.color}`);
    await save('colorsplit_flat_chamfer');
    // borderless: flat + no outline + no hole → still one part per color, no border part
    base.outlineOn = false;   // borderless base
    Object.assign(settings, { holeEnabled: false, chamferTopMM: 0, chamferBottomMM: 0 });
    commit(); await waitForBuild();
    report.borderlessFlat = colorPartsOf(lastResult)?.map(p => `${p.name} ${p.color}`) || null;
    await save('borderless_flat');
    base.baseStyle = 'raised';
    commit(); await waitForBuild();
    report.borderlessTwoLevel = colorPartsOf(lastResult)?.map(p => `${p.name} ${p.color}`) || null;
    await save('borderless_twolevel');
    base.baseStyle = 'flat';
    base.outlineOn = true;
    Object.assign(settings, { holeEnabled: true, chamferTopMM: 0.5, chamferBottomMM: 0.3 });
    commit(); await waitForBuild();
    base.baseStyle = 'raised';
    Object.assign(settings, { chamferTopMM: 0, chamferBottomMM: 0 });
    commit(); await waitForBuild();
    setRightTab('parts');
    fitView('3d');
    await new Promise(r => setTimeout(r, 600));
  } catch (err) {
    report.colorSplitError = String(err && err.stack || err);
  }
  // New default: no key ring; added from the "＋ รู / ห่วง" menu.
  try {
    elements = [];
    Object.assign(settings, { holeEnabled: false, holeX: null, holeY: null, chamferTopMM: 0, chamferBottomMM: 0 });
    addTextElement('Ring');
    await waitForBuild();
    const before = { holeEnabled: settings.holeEnabled, hasHole: !!lastResult?.holeCenter };
    const menus = document.querySelectorAll('.add-menu-btn');
    menus[1].click();
    const listShown = !document.querySelectorAll('.add-menu-list')[1].classList.contains('hide');
    $('addRing').click();
    await waitForBuild();
    report.ringMenu = { before, listShown, after: { holeEnabled: settings.holeEnabled, hasHole: !!lastResult?.holeCenter }, defaultHoleDia: report.holeDefaults?.dia };
    menus[0].click(); // leave the element menu open for the screenshot
    fitView('3d');
    await new Promise(r => setTimeout(r, 400));
  } catch (err) {
    report.ringError = String(err && err.stack || err);
  }
  // Flat, 12 mm, 3-color PNG, sideways hole through the middle: colors only as skins.
  try {
    elements = [];
    Object.assign(settings, { lockW: false, lockH: false, lockZ: false, holeEnabled: false,
      thicknessMM: 12, splitColors: true, colorSkin: true, colorSkinMM: 0.6, chamferTopMM: 0, chamferBottomMM: 0 });
    const pc = document.createElement('canvas'); pc.width = 300; pc.height = 300;
    const pg = pc.getContext('2d');
    pg.fillStyle = '#d62828'; pg.beginPath(); pg.arc(110, 150, 90, 0, Math.PI * 2); pg.fill();
    pg.fillStyle = '#1d4ed8'; pg.fillRect(150, 60, 130, 180);
    pg.fillStyle = '#fcbf49'; pg.beginPath(); pg.arc(215, 150, 35, 0, Math.PI * 2); pg.fill();
    const im = await addImageElement({ name: 'skin.png', dataUrl: pc.toDataURL('image/png') });
    Object.assign(im, { x: 0, y: 0, widthMM: 40, heightMM: 40, colorSplit: true, colorAuto: true, outlineMM: 2 });
    const hh = addHoleElement();
    Object.assign(hh, { x: 0, y: 0, heightMM: 4, zMM: 6, rotationDeg: 0, throughAll: true });
    commit(); await waitForBuild();
    const zRange = (g) => { g.computeBoundingBox(); const b = g.boundingBox; return [+b.min.z.toFixed(2), +b.max.z.toFixed(2)]; };
    const zLevels = (g) => { const p = g.getAttribute('position'); const s = new Set(); for (let i = 0; i < p.count; i++) s.add(+p.getZ(i).toFixed(2)); return [...s].sort((a, b) => a - b); };
    report.flatSkin = colorPartsOf(lastResult).map(p => ({ name: p.name, z: p.kind === 'region' ? zLevels(p.geometry) : zRange(p.geometry) }));
    report.flatSkinHoleFailed = !!lastResult.sideHoleFailed;
    await save('flat_skin12');
    fitView('3d');
    await new Promise(r => setTimeout(r, 400));
  } catch (err) {
    report.flatSkinError = String(err && err.stack || err);
  }
  // Bear.png (3 flat colors) auto-detection, ▲ stepper, ⟲ 0,0
  try {
    elements = [];
    const bear = await addImageElement({ name: 'Bear.png', dataUrl: 'file:///U:/_bloomiy/001/Bear.png' });
    Object.assign(bear, { colorSplit: true, colorAuto: true, x: 7, y: -3 });
    commit(); await waitForBuild();
    const bsrc = await getSource(bear);
    select(bear.id); setRightTab('elements');
    const wInput = document.querySelector('#transformGroup input[type=number][data-el="widthMM"]');
    const w0 = bear.widthMM;
    const up = wInput.nextElementSibling.querySelector('button');
    up.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true })); up.dispatchEvent(new PointerEvent('pointerup', { bubbles: true }));
    await waitForBuild();
    const w1 = bear.widthMM;
    document.querySelector('#transformGroup .pos-reset').click();
    await waitForBuild();
    report.bear = { colors: (bsrc.colorLayers || []).map(L => `${L.color} ${Math.round(L.share * 100)}%`), stepper: [w0, w1], pos: [bear.x, bear.y] };
    await save('bear');
    fitView('top');
    await new Promise(r => setTimeout(r, 500));
  } catch (err) { report.bearError = String(err && err.stack || err); }
  newElementOutlineOn = false;
  {
    const keep = elements; const t = addTextElement('Def');
    const b = addBaseElement();
    report.outlineDefaults = { element: t.outlineOn, base: b.outlineOn, ok: t.outlineOn === false && b.outlineOn === true };
    elements = keep.filter(e => e !== t && e !== b); commit(); await waitForBuild(); select(elements.find(e => e.type === 'image')?.id ?? null);
  }
  // Glue split export: base with recess + relief parts with tabs, laid out beside the base.
  try {
    elements = []; commit();
    Object.assign(settings, { lockW: false, lockH: false, lockZ: false, holeEnabled: false, thicknessMM: 3, elementThicknessMM: 2, chamferTopMM: 0, chamferBottomMM: 0 });
    const gt = addTextElement('Onzen'); gt.heightMM = 12; gt.widthMM = 40;
    const gb = addBaseElement(); gb.baseStyle = 'raised'; gb.outlineShape = 'contour';
    commit(); await waitForBuild();
    report.glue = [];
    for (const [tag, ch] of [['glue', 0], ['glue_chamfer', 0.8]]) {
      Object.assign(settings, { chamferTopMM: ch, chamferBottomMM: ch, glueDepthMM: 1.2, glueGapMM: 0.15 });
      commit(); await waitForBuild();
      const r = await computeResult(settings.exportQuality, { glue: true });
      layoutGlueParts(r);
      const info = { tag, glue: r.glue, parts: [] };
      for (const p of r.parts) {
        p.geometry.computeBoundingBox();
        const bb = p.geometry.boundingBox;
        info.parts.push({ name: p.name, z: [+bb.min.z.toFixed(3), +bb.max.z.toFixed(3)], y: [+bb.min.y.toFixed(2), +bb.max.y.toFixed(2)] });
        await window.api.selftestWrite(`${tag}_${p.name}.stl`, encodeModel(p.geometry, 'stl'));
      }
      await window.api.selftestWrite(`${tag}.3mf`, encode3MF(r.parts));
      report.glue.push(info);
      disposeResult(r);
    }
  } catch (err) { report.glueError = String(err && err.stack || err); }
  await window.api.selftestWrite('report.json', JSON.stringify(report, null, 2));
  await new Promise(r => setTimeout(r, 400));
  await window.api.selftestDone();
}

renderLayerList();
renderProps();
renderUndoButtons();
init();
