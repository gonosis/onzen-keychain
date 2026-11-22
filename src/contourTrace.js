// Interpolated marching-squares contour tracing over a 0..1 field, ported from KeychainMaker.
// Returns plain polygons in pixel space: [{ outer: [[x,y],...], holes: [[[x,y],...], ...] }].
// Winding convention (pixel space, Y down): outer contours have positive signed area, holes
// negative — relied on for classifying outers vs. holes below.

// `outside` is the field value assumed beyond the canvas edge (0 for coverage fields; a large
// negative number for signed-distance fields traced at iso >= 0).
export function traceField(field, w, h, { iso = 0.5, simplifyTolerance = 0.3, smoothIterations = 1, outside = 0 } = {}) {
  const segments = marchingSquares(field, w, h, iso, outside);
  const loops = chainSegments(segments);
  const polygons = loops
    .map(loop => chaikinSmooth(loop, smoothIterations))
    .map(loop => simplify(loop, simplifyTolerance))
    .map(dedupe)
    .filter(p => p.length >= 3);

  const withArea = polygons.map(points => ({ points, area: signedArea(points) }));
  const outers = withArea.filter(p => p.area > 0).map(p => ({ outer: p.points, area: p.area, holes: [] }));
  const holes = withArea.filter(p => p.area < 0);

  // Each hole belongs to its smallest containing outer contour.
  for (const hole of holes) {
    const testPoint = hole.points[0];
    let best = null;
    for (const o of outers) {
      if (o.area < (best ? best.area : Infinity) && pointInPolygon(testPoint, o.outer)) best = o;
    }
    if (best) best.holes.push(hole.points);
  }
  return outers.map(o => ({ outer: o.outer, holes: o.holes }));
}

function marchingSquares(field, w, h, iso, outside) {
  const at = (x, y) => (x < 0 || y < 0 || x >= w || y >= h) ? outside : field[y * w + x];
  const lerpEdge = (ax, ay, av, bx, by, bv) => {
    let t = (iso - av) / (bv - av);
    if (!isFinite(t)) t = 0.5;
    t = Math.min(1, Math.max(0, t));
    return [ax + (bx - ax) * t, ay + (by - ay) * t];
  };
  const segments = [];
  for (let y = -1; y < h; y++) {
    for (let x = -1; x < w; x++) {
      const tl = at(x, y), tr = at(x + 1, y), br = at(x + 1, y + 1), bl = at(x, y + 1);
      const idx = (tl >= iso ? 8 : 0) | (tr >= iso ? 4 : 0) | (br >= iso ? 2 : 0) | (bl >= iso ? 1 : 0);
      if (idx === 0 || idx === 15) continue;
      const top = () => lerpEdge(x, y, tl, x + 1, y, tr);
      const right = () => lerpEdge(x + 1, y, tr, x + 1, y + 1, br);
      const bottom = () => lerpEdge(x, y + 1, bl, x + 1, y + 1, br);
      const left = () => lerpEdge(x, y, tl, x, y + 1, bl);
      const pairs = CASES[idx];
      if (pairs) for (const [a, b] of pairs) segments.push([(a === 'T' ? top : a === 'R' ? right : a === 'B' ? bottom : left)(),
                                                           (b === 'T' ? top : b === 'R' ? right : b === 'B' ? bottom : left)()]);
    }
  }
  return segments;
}

// Edge pairs oriented so field-above-iso stays on one consistent side of travel direction.
const CASES = {
  1: [['L', 'B']], 2: [['B', 'R']], 3: [['L', 'R']],
  4: [['R', 'T']], 5: [['L', 'T'], ['R', 'B']], 6: [['B', 'T']],
  7: [['L', 'T']], 8: [['T', 'L']], 9: [['T', 'B']],
  10: [['T', 'R'], ['B', 'L']], 11: [['T', 'R']],
  12: [['R', 'L']], 13: [['R', 'B']], 14: [['B', 'L']]
};

function chainSegments(segments) {
  const key = p => `${p[0].toFixed(3)},${p[1].toFixed(3)}`;
  const startMap = new Map();
  for (const seg of segments) {
    const k = key(seg[0]);
    if (!startMap.has(k)) startMap.set(k, []);
    startMap.get(k).push(seg);
  }
  const used = new Set();
  const loops = [];
  for (const seg of segments) {
    if (used.has(seg)) continue;
    const loop = [seg[0]];
    let current = seg;
    while (current && !used.has(current)) {
      used.add(current);
      loop.push(current[1]);
      const candidates = startMap.get(key(current[1]));
      current = candidates ? candidates.find(c => !used.has(c)) : null;
    }
    loop.pop(); // last point == first point (closed loop)
    if (loop.length >= 3) loops.push(loop);
  }
  return loops;
}

// Chaikin corner-cutting on a closed polyline.
function chaikinSmooth(points, iterations) {
  let pts = points;
  for (let it = 0; it < iterations; it++) {
    const next = [];
    const n = pts.length;
    for (let i = 0; i < n; i++) {
      const [x0, y0] = pts[i];
      const [x1, y1] = pts[(i + 1) % n];
      next.push([x0 * 0.75 + x1 * 0.25, y0 * 0.75 + y1 * 0.25]);
      next.push([x0 * 0.25 + x1 * 0.75, y0 * 0.25 + y1 * 0.75]);
    }
    pts = next;
  }
  return pts;
}

function dedupe(points) {
  const out = [];
  for (const p of points) {
    const last = out[out.length - 1];
    if (!last || Math.abs(last[0] - p[0]) > 1e-6 || Math.abs(last[1] - p[1]) > 1e-6) out.push(p);
  }
  while (out.length > 1) {
    const a = out[0], b = out[out.length - 1];
    if (Math.abs(a[0] - b[0]) > 1e-6 || Math.abs(a[1] - b[1]) > 1e-6) break;
    out.pop();
  }
  return out;
}

export function signedArea(points) {
  let sum = 0;
  for (let i = 0; i < points.length; i++) {
    const [x1, y1] = points[i];
    const [x2, y2] = points[(i + 1) % points.length];
    sum += x1 * y2 - x2 * y1;
  }
  return sum / 2;
}

function pointInPolygon(point, polygon) {
  const [x, y] = point;
  let inside = false;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    const [xi, yi] = polygon[i];
    const [xj, yj] = polygon[j];
    if (((yi > y) !== (yj > y)) && (x < (xj - xi) * (y - yi) / (yj - yi) + xi)) inside = !inside;
  }
  return inside;
}

// Ramer-Douglas-Peucker simplification of a closed loop. The loop is split at its first point
// and the point farthest from it, so neither anchor is an arbitrary chord endpoint.
function simplify(points, tolerance) {
  if (points.length <= 4 || tolerance <= 0) return points;
  let far = 0, farD = -1;
  for (let i = 1; i < points.length; i++) {
    const dx = points[i][0] - points[0][0], dy = points[i][1] - points[0][1];
    const d = dx * dx + dy * dy;
    if (d > farD) { farD = d; far = i; }
  }
  const sqTol = tolerance * tolerance;
  const closed = [...points, points[0]];
  const keep = new Uint8Array(closed.length);
  keep[0] = 1; keep[far] = 1; keep[closed.length - 1] = 1;
  simplifySection(closed, 0, far, sqTol, keep);
  simplifySection(closed, far, closed.length - 1, sqTol, keep);
  const out = [];
  for (let i = 0; i < closed.length - 1; i++) if (keep[i]) out.push(closed[i]);
  return out;
}

function simplifySection(points, first, last, sqTol, keep) {
  if (last - first < 2) return;
  let maxDist = 0, index = -1;
  for (let i = first + 1; i < last; i++) {
    const d = sqSegDist(points[i], points[first], points[last]);
    if (d > maxDist) { maxDist = d; index = i; }
  }
  if (maxDist > sqTol && index !== -1) {
    keep[index] = 1;
    simplifySection(points, first, index, sqTol, keep);
    simplifySection(points, index, last, sqTol, keep);
  }
}

function sqSegDist(p, a, b) {
  let [x, y] = p, [x1, y1] = a;
  const [x2, y2] = b;
  let dx = x2 - x1, dy = y2 - y1;
  if (dx !== 0 || dy !== 0) {
    const t = ((x - x1) * dx + (y - y1) * dy) / (dx * dx + dy * dy);
    if (t > 1) { x1 = x2; y1 = y2; }
    else if (t > 0) { x1 += dx * t; y1 += dy * t; }
  }
  dx = x - x1; dy = y - y1;
  return dx * dx + dy * dy;
}
