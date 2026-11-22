// Turns an element's content (text or image) into a "source": a tightly-cropped canvas whose
// ALPHA channel is the material coverage (0..255). The keychain builder then draws that canvas
// into world space with the element's size/rotation/position — so content is rasterized once
// per content change, not on every move.

// High enough that even at 32 px/mm export a typical keychain text isn't upscaled.
export const TEXT_FONT_PX = 400;
const MAX_IMAGE_PX = 3000;

export async function buildTextSource(el) {
  const text = el.text || '';
  const lines = text.split('\n');
  if (!text.trim()) return null;

  const style = `${el.italic ? 'italic ' : ''}${el.bold ? 'bold ' : ''}${TEXT_FONT_PX}px "${el.font}"`;
  try { await document.fonts.load(style, text); } catch { /* system font — drawn anyway */ }

  const spacingPx = ((el.letterSpacing || 0) / 100) * TEXT_FONT_PX;
  const setup = (ctx) => {
    ctx.font = style;
    if ('letterSpacing' in ctx) ctx.letterSpacing = `${spacingPx}px`;
    ctx.textBaseline = 'alphabetic';
  };

  const measure = document.createElement('canvas').getContext('2d');
  setup(measure);
  const widths = lines.map(line => measure.measureText(line).width);
  const maxW = Math.max(1, ...widths);
  const lineH = TEXT_FONT_PX * (el.lineHeight || 1);
  // Generous padding: script/decorative fonts routinely draw far outside their advance box.
  const pad = TEXT_FONT_PX;
  const canvas = document.createElement('canvas');
  canvas.width = Math.min(16000, Math.ceil(maxW + pad * 2));
  canvas.height = Math.min(16000, Math.ceil(lineH * (lines.length - 1) + TEXT_FONT_PX * 1.6 + pad * 2));
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  setup(ctx);
  ctx.fillStyle = '#fff';
  // Column range of the first character (leftmost line start) and last character (rightmost
  // line end) — used by the "ends" outline shape. Measured by advance width, then opened up to
  // the crop edge on the outer side so glyph overhang (italic/script) is still included.
  let firstEnd = Infinity, lastStart = -Infinity, minStart = Infinity, maxEnd = -Infinity;
  // Per-character boxes (advance width × line band), numbered 1.. over non-space characters in
  // reading order — used for the alternating odd/even relief height.
  const charBoxes = [];
  let charNo = 0;
  lines.forEach((line, i) => {
    const w = widths[i];
    const x = el.align === 'left' ? pad : el.align === 'right' ? pad + maxW - w : pad + (maxW - w) / 2;
    const baseline = pad + TEXT_FONT_PX + i * lineH;
    ctx.fillText(line, x, baseline);
    const chars = Array.from(line);
    if (!chars.length) return;
    let prefix = '';
    for (const ch of chars) {
      const x0 = x + (prefix ? measure.measureText(prefix).width : 0);
      prefix += ch;
      const x1 = x + measure.measureText(prefix).width;
      if (/\s/.test(ch)) continue;
      charBoxes.push({ no: ++charNo, x0, x1, y0: baseline - TEXT_FONT_PX * 1.1, y1: baseline + TEXT_FONT_PX * 0.4 });
    }
    if (x < minStart) { minStart = x; firstEnd = x + measure.measureText(chars[0]).width; }
    if (x + w > maxEnd) { maxEnd = x + w; lastStart = x + w - measure.measureText(chars[chars.length - 1]).width; }
  });
  const src = cropToContent(canvas);
  if (src) {
    const alpha = measure.measureText('M').actualBoundingBoxAscent;
    measure.textBaseline = 'middle';
    const middle = measure.measureText('M').actualBoundingBoxAscent;
    measure.textBaseline = 'alphabetic';
    const midAboveBaseline = alpha - middle; // how far 'middle' sits above the alphabetic baseline
    const meanBaseline = pad + TEXT_FONT_PX + ((lines.length - 1) * lineH) / 2;
    src.layoutCenter = { x: pad + maxW / 2 - src.offsetX, y: meanBaseline - midAboveBaseline - src.offsetY };
  }
  if (src && Array.from(text.replace(/\s/g, '')).length >= 2) {
    src.firstRange = [0, Math.max(1, firstEnd - src.offsetX)];
    src.lastRange = [Math.min(src.width - 1, lastStart - src.offsetX), src.width];
  }
  if (src) src.charBoxes = charBoxes.map(b => ({ ...b, x0: b.x0 - src.offsetX, x1: b.x1 - src.offsetX, y0: b.y0 - src.offsetY, y1: b.y1 - src.offsetY }));
  return warpSource(src, el);
}

export function buildImageSource(img, el) {
  const scale = Math.min(1, MAX_IMAGE_PX / Math.max(img.width, img.height));
  const w = Math.max(1, Math.round(img.width * scale));
  const h = Math.max(1, Math.round(img.height * scale));
  const canvas = document.createElement('canvas');
  canvas.width = w; canvas.height = h;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(img, 0, 0, w, h);
  const imageData = ctx.getImageData(0, 0, w, h);
  const d = imageData.data;
  const orig = el.colorSplit ? new Uint8ClampedArray(d) : null; // RGB kept for color detection
  const t = (el.threshold ?? 50) / 100;
  for (let i = 0; i < w * h; i++) {
    const r = d[i * 4], g = d[i * 4 + 1], b = d[i * 4 + 2], a = d[i * 4 + 3] / 255;
    const lum = (r * 0.299 + g * 0.587 + b * 0.114) / 255;
    let c;
    if (el.imgMode === 'dark') c = (1 - lum) * a;
    else if (el.imgMode === 'light') c = lum * a;
    else c = a;
    if (el.invert) c = 1 - c;
    // Soft threshold: keeps a thin anti-aliased ramp around the cut level so the world-space
    // resample + contour trace stays smooth instead of stair-stepped.
    const v = Math.min(1, Math.max(0, (c - t) / 0.08 + 0.5));
    d[i * 4] = d[i * 4 + 1] = d[i * 4 + 2] = 255;
    d[i * 4 + 3] = Math.round(v * 255);
  }
  ctx.putImageData(imageData, 0, 0);
  const src = cropToContent(canvas);
  if (src) {
    src.fullW = w; src.fullH = h;
    src.layoutCenter = { x: w / 2 - src.offsetX, y: h / 2 - src.offsetY };
  }
  const warped = Math.abs(el.bendDeg || 0) >= 0.5 || (el.waveAmp || 0) > 0;
  // colorAuto (default) → detect how many colors the image has; otherwise use colorCount.
  const k = el.colorAuto !== false ? 0 : Math.max(2, Math.min(8, el.colorCount || 3));
  if (src && orig && !warped) src.colorLayers = colorLayers(src, orig, w, k);
  return warpSource(src, el);
}

// k-means in RGB with a deterministic farthest-first init. → { cents, sse }
// Dominant colors by histogram: pixels binned at 4 bits/channel, bins taken most-frequent first;
// a bin becomes a seed if it covers ≥ 1% of the image and is ≥ 40 (RGB) away from every seed so
// far. Flat-color art (logos, cartoons) gives one bin per real color, while anti-aliased edge
// pixels (tiny, in-between) never qualify. maxSeeds caps the count; with `fill`, the next most
// frequent bins top it up to exactly maxSeeds even if they're close/small (manual count).
function dominantColors(samples, d2, maxSeeds, fill = false) {
  const bins = new Map();
  for (const p of samples) {
    const key = (p[0] >> 4) * 256 + (p[1] >> 4) * 16 + (p[2] >> 4);
    let e = bins.get(key);
    if (!e) { e = [0, 0, 0, 0]; bins.set(key, e); }
    e[0] += p[0]; e[1] += p[1]; e[2] += p[2]; e[3]++;
  }
  const sorted = [...bins.values()].map(e => [e[0] / e[3], e[1] / e[3], e[2] / e[3], e[3] / samples.length]).sort((a, b) => b[3] - a[3]);
  const seeds = [];
  for (const e of sorted) {
    if (seeds.length >= maxSeeds || e[3] < 0.01) break;
    if (seeds.every(c => d2(e, c) >= 40 * 40)) seeds.push(e.slice(0, 3));
  }
  if (fill) for (const e of sorted) { if (seeds.length >= maxSeeds) break; if (!seeds.some(c => d2(e, c) === 0)) seeds.push(e.slice(0, 3)); }
  return seeds;
}

function kmeans(samples, k, d2, seeds = null) {
  const cents = seeds ? seeds.map(c => c.slice()) : [samples[0].slice()];
  while (cents.length < k) {
    let best = null, bestD = -1;
    for (const sp of samples) { const d = Math.min(...cents.map(c => d2(sp, c))); if (d > bestD) { bestD = d; best = sp; } }
    if (bestD <= 0) break; // fewer distinct colors than k
    cents.push(best.slice());
  }
  const nearest = (p) => { let bi = 0, bd = Infinity; cents.forEach((c, i) => { const d = d2(p, c); if (d < bd) { bd = d; bi = i; } }); return [bi, bd]; };
  let sse = 0;
  for (let it = 0; it < 15; it++) {
    const sum = cents.map(() => [0, 0, 0, 0]);
    sse = 0;
    for (const sp of samples) { const [i, d] = nearest(sp); const c = sum[i]; c[0] += sp[0]; c[1] += sp[1]; c[2] += sp[2]; c[3]++; sse += d; }
    sum.forEach((c, i) => { if (c[3]) cents[i] = [c[0] / c[3], c[1] / c[3], c[2] / c[3]]; });
  }
  return { cents, sse };
}

// ── Color split ──
// Groups the image's visible pixels into k colors (k-means in RGB) and returns one layer per
// color, aligned with the cropped source: [{ color: '#rrggbb', share, canvas }] where each
// canvas's alpha = the source coverage restricted to that color. Sorted by area, largest first.
function colorLayers(src, orig, fullW, k) {
  const { width: cw, height: ch, offsetX: ox, offsetY: oy } = src;
  const cov = src.canvas.getContext('2d', { willReadFrequently: true }).getImageData(0, 0, cw, ch).data;
  const rgbAt = (x, y) => { const i = ((y + oy) * fullW + (x + ox)) * 4; return [orig[i], orig[i + 1], orig[i + 2]]; };

  // samples: visible pixels (coverage ≥ 50%), strided to ≤ ~40k
  const visible = [];
  for (let y = 0; y < ch; y++) for (let x = 0; x < cw; x++) if (cov[(y * cw + x) * 4 + 3] >= 128) visible.push(y * cw + x);
  if (visible.length < Math.max(k, 2)) return null;
  const stride = Math.max(1, Math.floor(visible.length / (k > 0 ? 40000 : 15000)));
  const samples = [];
  for (let i = 0; i < visible.length; i += stride) { const p = visible[i]; samples.push(rgbAt(p % cw, (p / cw) | 0)); }

  const d2 = (a, b) => (a[0] - b[0]) ** 2 + (a[1] - b[1]) ** 2 + (a[2] - b[2]) ** 2;
  // Seeds from the dominant colors (auto: as many as qualify, up to 8; manual: exactly k), then
  // k-means refines them so every pixel lands in its nearest color.
  const seeds = k > 0 ? dominantColors(samples, d2, k, true) : dominantColors(samples, d2, 8);
  const cents = kmeans(samples, seeds.length, d2, seeds).cents;
  const nearest = (p) => { let bi = 0, bd = Infinity; cents.forEach((c, i) => { const d = d2(p, c); if (d < bd) { bd = d; bi = i; } }); return bi; };

  // label every pixel with any coverage; build one alpha layer per color
  const n = cents.length;
  const layers = cents.map(() => {
    const canvas = document.createElement('canvas');
    canvas.width = cw; canvas.height = ch;
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    return { canvas, ctx, img: ctx.createImageData(cw, ch), count: 0 };
  });
  for (let y = 0; y < ch; y++) {
    for (let x = 0; x < cw; x++) {
      const i = y * cw + x, a = cov[i * 4 + 3];
      if (!a) continue;
      const L = layers[nearest(rgbAt(x, y))];
      L.img.data[i * 4] = L.img.data[i * 4 + 1] = L.img.data[i * 4 + 2] = 255;
      L.img.data[i * 4 + 3] = a;
      if (a >= 128) L.count++;
    }
  }
  const hex = (c) => '#' + c.map(v => Math.round(v).toString(16).padStart(2, '0')).join('');
  const total = layers.reduce((s, L) => s + L.count, 0) || 1;
  return layers
    .map((L, i) => { L.ctx.putImageData(L.img, 0, 0); return { color: hex(cents[i]), share: L.count / total, canvas: L.canvas, width: cw, height: ch }; })
    .filter(L => L.share > 0.002)
    .sort((a, b) => b.share - a.share);
}

// True if the image has meaningful transparency — used to pick the default image mode
// (transparent PNG → use alpha; opaque JPG/PNG → use dark pixels on light background).
export function imageHasTransparency(img) {
  const scale = Math.min(1, 256 / Math.max(img.width, img.height));
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.round(img.width * scale));
  canvas.height = Math.max(1, Math.round(img.height * scale));
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
  const d = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
  let transparent = 0;
  for (let i = 3; i < d.length; i += 4) if (d[i] < 200) transparent++;
  return transparent > (d.length / 4) * 0.01;
}

// ── Warps (bend / wave) ──
// Applied to the cropped source's alpha, so the element keeps its size/rotation/outline logic
// and just gets a new (warped) silhouette. Order: wave first, then bend.
//  bendDeg  : total arc angle; > 0 arches up (rainbow), < 0 sags down (smile). Glyphs stay
//             perpendicular to the arc, the text's middle line keeps its length.
//  waveAmp  : wave height as % of the source height; waveCount cycles across the width;
//             wavePhase shifts the wave (degrees). Columns shift vertically only.
export function warpSource(src, el) {
  if (!src) return src;
  const bend = Math.max(-359, Math.min(359, el.bendDeg || 0));
  const amp = Math.max(0, el.waveAmp || 0) / 100;
  if (Math.abs(bend) < 0.5 && amp <= 0) return src;

  const ctx = src.canvas.getContext('2d', { willReadFrequently: true });
  const d = ctx.getImageData(0, 0, src.width, src.height).data;
  let img = { w: src.width, h: src.height, a: new Float32Array(src.width * src.height) };
  for (let i = 0; i < img.a.length; i++) img.a[i] = d[i * 4 + 3];

  if (amp > 0) img = waveAlpha(img, amp, el.waveCount || 1, ((el.wavePhase || 0) * Math.PI) / 180);
  if (Math.abs(bend) >= 0.5) {
    if (bend < 0) img = flipY(img);
    img = bendAlpha(img, (Math.abs(bend) * Math.PI) / 180);
    if (bend < 0) img = flipY(img);
  }

  const out = document.createElement('canvas');
  out.width = img.w; out.height = img.h;
  const octx = out.getContext('2d', { willReadFrequently: true });
  const od = octx.createImageData(img.w, img.h);
  for (let i = 0; i < img.a.length; i++) {
    od.data[i * 4] = od.data[i * 4 + 1] = od.data[i * 4 + 2] = 255;
    od.data[i * 4 + 3] = img.a[i];
  }
  octx.putImageData(od, 0, 0);
  const warped = cropToContent(out);
  // First/last-character columns stay valid under a pure wave (x is unchanged); a bend moves
  // them along an arc, so the "ends" outline falls back to the plain contour then.
  if (warped && src.firstRange && Math.abs(bend) < 0.5) {
    warped.firstRange = src.firstRange.map(v => v - warped.offsetX);
    warped.lastRange = src.lastRange.map(v => v - warped.offsetX);
  }
  // Character boxes survive a pure wave in x (columns only shift vertically → full-height bands);
  // a bend moves glyphs along an arc, so per-character heights aren't available then.
  if (warped && src.charBoxes && Math.abs(bend) < 0.5) {
    warped.charBoxes = src.charBoxes.map(b => ({ ...b, x0: b.x0 - warped.offsetX, x1: b.x1 - warped.offsetX, y0: -Infinity, y1: Infinity }));
  }
  return warped;
}

function sampleBilinear(img, x, y) {
  if (x < 0 || y < 0 || x > img.w - 1 || y > img.h - 1) return 0;
  const x0 = Math.floor(x), y0 = Math.floor(y);
  const x1 = Math.min(img.w - 1, x0 + 1), y1 = Math.min(img.h - 1, y0 + 1);
  const fx = x - x0, fy = y - y0, a = img.a, w = img.w;
  const top = a[y0 * w + x0] * (1 - fx) + a[y0 * w + x1] * fx;
  const bot = a[y1 * w + x0] * (1 - fx) + a[y1 * w + x1] * fx;
  return top * (1 - fy) + bot * fy;
}

function flipY(img) {
  const a = new Float32Array(img.a.length);
  for (let y = 0; y < img.h; y++) a.set(img.a.subarray((img.h - 1 - y) * img.w, (img.h - y) * img.w), y * img.w);
  return { ...img, a };
}

function waveAlpha(img, amp, cycles, phase) {
  const A = amp * img.h;
  const h2 = Math.ceil(img.h + 2 * A) + 2;
  const a = new Float32Array(img.w * h2);
  for (let x = 0; x < img.w; x++) {
    const off = 1 + A + A * Math.sin((2 * Math.PI * cycles * x) / img.w + phase);
    for (let y = 0; y < h2; y++) a[y * img.w + x] = sampleBilinear(img, x, y - off);
  }
  return { w: img.w, h: h2, a };
}

// Arch: the source's middle line (y = h/2) is laid on a circle of radius R = w/θ, so its length
// is preserved; x maps to angle, distance from the middle line maps to radius.
function bendAlpha(img, theta) {
  const { w, h } = img;
  const R = w / theta;
  // Output bounds from the mapped outline of the source rectangle.
  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
  const steps = 720;
  for (let i = 0; i <= steps; i++) {
    const phi = -theta / 2 + (theta * i) / steps;
    for (const rho of [R - h / 2, R + h / 2]) {
      const X = rho * Math.sin(phi), Y = -rho * Math.cos(phi);
      minX = Math.min(minX, X); maxX = Math.max(maxX, X);
      minY = Math.min(minY, Y); maxY = Math.max(maxY, Y);
    }
  }
  const pad = 2;
  const w2 = Math.ceil(maxX - minX) + pad * 2, h2 = Math.ceil(maxY - minY) + pad * 2;
  const ox = minX - pad, oy = minY - pad;
  const a = new Float32Array(w2 * h2);
  for (let y = 0; y < h2; y++) {
    const ry = y + oy;
    for (let x = 0; x < w2; x++) {
      const rx = x + ox;
      const rho = Math.hypot(rx, ry);
      const phi = Math.atan2(rx, -ry);
      if (Math.abs(phi) > theta / 2 + 0.01) continue;
      a[y * w2 + x] = sampleBilinear(img, w / 2 + phi * R, h / 2 - (rho - R));
    }
  }
  return { w: w2, h: h2, a };
}

export function loadImage(dataUrl) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = reject;
    img.src = dataUrl;
  });
}

function cropToContent(canvas) {
  const { width: w, height: h } = canvas;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  const d = ctx.getImageData(0, 0, w, h).data;
  let minX = w, minY = h, maxX = -1, maxY = -1;
  for (let y = 0; y < h; y++) {
    const row = y * w;
    for (let x = 0; x < w; x++) {
      if (d[(row + x) * 4 + 3] >= 64) {
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
      }
    }
  }
  if (maxX < 0) return null;
  // 2px border so the soft edge isn't clipped.
  minX = Math.max(0, minX - 2); minY = Math.max(0, minY - 2);
  maxX = Math.min(w - 1, maxX + 2); maxY = Math.min(h - 1, maxY + 2);
  const out = document.createElement('canvas');
  out.width = maxX - minX + 1;
  out.height = maxY - minY + 1;
  out.getContext('2d').drawImage(canvas, minX, minY, out.width, out.height, 0, 0, out.width, out.height);
  return { canvas: out, width: out.width, height: out.height, offsetX: minX, offsetY: minY };
}
