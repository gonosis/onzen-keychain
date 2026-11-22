// Binary-mask morphology on Uint8Array masks (1 = material, 0 = empty), size w*h.
//
// Dilation/erosion use an exact Euclidean distance transform (Felzenszwalb & Huttenlocher),
// which is O(w*h) regardless of radius AND gives a true round structuring element. The old
// KeychainMaker used a separable square window for speed, which was the root cause of every
// "my circle/outline looks like a rounded square" bug there — this replaces it outright.

const INF = 1e20;

function dt1d(f, n, d, v, z) {
  let k = 0;
  v[0] = 0; z[0] = -INF; z[1] = INF;
  for (let q = 1; q < n; q++) {
    let s = ((f[q] + q * q) - (f[v[k]] + v[k] * v[k])) / (2 * q - 2 * v[k]);
    while (s <= z[k]) {
      k--;
      s = ((f[q] + q * q) - (f[v[k]] + v[k] * v[k])) / (2 * q - 2 * v[k]);
    }
    k++;
    v[k] = q; z[k] = s; z[k + 1] = INF;
  }
  k = 0;
  for (let q = 0; q < n; q++) {
    while (z[k + 1] < q) k++;
    const dq = q - v[k];
    d[q] = dq * dq + f[v[k]];
  }
}

// Squared distance (in px²) from every pixel to the nearest pixel whose value === target.
export function squaredDistanceTo(mask, w, h, target) {
  const n = Math.max(w, h);
  const f = new Float64Array(n), d = new Float64Array(n), v = new Int32Array(n), z = new Float64Array(n + 1);
  const grid = new Float64Array(w * h);
  for (let i = 0; i < w * h; i++) grid[i] = mask[i] === target ? 0 : INF;
  for (let x = 0; x < w; x++) {
    for (let y = 0; y < h; y++) f[y] = grid[y * w + x];
    dt1d(f, h, d, v, z);
    for (let y = 0; y < h; y++) grid[y * w + x] = d[y];
  }
  for (let y = 0; y < h; y++) {
    const row = y * w;
    for (let x = 0; x < w; x++) f[x] = grid[row + x];
    dt1d(f, w, d, v, z);
    for (let x = 0; x < w; x++) grid[row + x] = d[x];
  }
  return grid;
}

export function dilate(mask, w, h, radiusPx) {
  if (!(radiusPx > 0)) return mask;
  const d = squaredDistanceTo(mask, w, h, 1);
  const r2 = radiusPx * radiusPx;
  const out = new Uint8Array(w * h);
  for (let i = 0; i < w * h; i++) out[i] = d[i] <= r2 ? 1 : 0;
  return out;
}

export function erode(mask, w, h, radiusPx) {
  if (!(radiusPx > 0)) return mask;
  const d = squaredDistanceTo(mask, w, h, 0);
  const r2 = radiusPx * radiusPx;
  const out = new Uint8Array(w * h);
  for (let i = 0; i < w * h; i++) out[i] = d[i] > r2 ? 1 : 0;
  return out;
}

// Signed distance (px) to the mask boundary: positive inside, negative outside, lightly blurred
// so its iso-lines trace smoothly. Its gradient magnitude is <= 1, so iso-lines at levels d and
// d+δ are always >= δ px apart — they never cross, which the chamfer layering relies on.
export function signedDistanceField(mask, w, h) {
  const toBg = squaredDistanceTo(mask, w, h, 0);
  const toFg = squaredDistanceTo(mask, w, h, 1);
  const f = new Float32Array(w * h);
  for (let i = 0; i < w * h; i++) f[i] = mask[i] ? Math.sqrt(toBg[i]) - 0.5 : 0.5 - Math.sqrt(toFg[i]);
  return boxBlurToField(f, w, h, 1, 1);
}

// Morphological closing: fills notches/gaps narrower than 2*radius and rounds inner corners,
// without growing the outer extent.
export function close(mask, w, h, radiusPx) {
  if (!(radiusPx > 0)) return mask;
  return erode(dilate(mask, w, h, radiusPx), w, h, radiusPx);
}

// Fills every empty region not connected to the canvas border (letter counters, enclosed gaps).
export function fillEnclosedHoles(mask, w, h) {
  const outside = new Uint8Array(w * h);
  const stack = new Int32Array(w * h);
  let sp = 0;
  const push = (i) => { if (!mask[i] && !outside[i]) { outside[i] = 1; stack[sp++] = i; } };
  for (let x = 0; x < w; x++) { push(x); push((h - 1) * w + x); }
  for (let y = 0; y < h; y++) { push(y * w); push(y * w + w - 1); }
  while (sp > 0) {
    const i = stack[--sp];
    const x = i % w, y = (i - x) / w;
    if (x > 0) push(i - 1);
    if (x < w - 1) push(i + 1);
    if (y > 0) push(i - w);
    if (y < h - 1) push(i + w);
  }
  const out = new Uint8Array(w * h);
  for (let i = 0; i < w * h; i++) out[i] = outside[i] ? 0 : 1;
  return out;
}

// Separable box blur, `passes` times — turns a binary mask into a smooth 0..1 field so the
// interpolated marching squares in contourTrace.js traces a smooth curve, not pixel steps.
export function boxBlurToField(mask, w, h, passes = 1, radius = 1) {
  let src = Float32Array.from(mask);
  for (let p = 0; p < passes; p++) {
    const tmp = new Float32Array(w * h);
    for (let y = 0; y < h; y++) {
      const row = y * w;
      for (let x = 0; x < w; x++) {
        let sum = 0, count = 0;
        for (let dx = -radius; dx <= radius; dx++) {
          const nx = x + dx;
          if (nx < 0 || nx >= w) continue;
          sum += src[row + nx]; count++;
        }
        tmp[row + x] = sum / count;
      }
    }
    const out = new Float32Array(w * h);
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        let sum = 0, count = 0;
        for (let dy = -radius; dy <= radius; dy++) {
          const ny = y + dy;
          if (ny < 0 || ny >= h) continue;
          sum += tmp[ny * w + x]; count++;
        }
        out[y * w + x] = sum / count;
      }
    }
    src = out;
  }
  return src;
}
