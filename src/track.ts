export type Pt = [number, number];
export interface Checkpoint { s: number; a: Pt; b: Pt; }
export interface Track {
  id: string; name: string;
  centerline: Pt[]; // resampled, closed (first==last omitted; treated cyclically)
  width: number;
  startS: number;   // arc index into centerline
  closed: boolean;  // loop auto-closed (end snapped to start)
  gates: number[];  // manual checkpoints, arc fractions [0,1) sorted along travel
  gateWidths?: number[]; // parallel to gates; missing entries fall back to width
}

export const dist = (a: Pt, b: Pt) => Math.hypot(a[0] - b[0], a[1] - b[1]);

// Even-spacing resample (cyclic if closed)
export function resample(pts: Pt[], step = 8, closed = true): Pt[] {
  // drop consecutive duplicates: zero-length segments blow up interpolation (t → 1e6),
  // and snapping/merging routinely creates them
  const clean = pts.filter((p, i) => i === 0 || dist(p, pts[i - 1]) > 1e-6);
  if (clean.length < 2) return [...clean];
  const path = closed ? [...clean, clean[0]] : clean;
  const lens = [0];
  for (let i = 1; i < path.length; i++) lens.push(lens[i - 1] + dist(path[i - 1], path[i]));
  const total = lens[lens.length - 1];
  const n = Math.max(8, Math.floor(total / step));
  const out: Pt[] = [];
  let j = 0;
  for (let k = 0; k < n; k++) {
    const target = (k / n) * total;
    while (j < lens.length - 2 && lens[j + 1] < target) j++;
    const t = Math.max(0, Math.min(1, (target - lens[j]) / Math.max(1e-6, lens[j + 1] - lens[j])));
    out.push([
      path[j][0] + (path[j + 1][0] - path[j][0]) * t,
      path[j][1] + (path[j + 1][1] - path[j][1]) * t,
    ]);
  }
  return out;
}

// Chaikin smoothing (cyclic), keeps shape, kills jitter.
// Runs only on new/changed strokes (rebuilds are dirty-gated in main.ts),
// so no skip threshold is needed here — and none could be reliable anyway.
export function smooth(pts: Pt[], iters = 2): Pt[] {
  if (!pts.length) return [];
  let cur = pts;
  for (let it = 0; it < iters; it++) {
    const out: Pt[] = [];
    for (let i = 0; i < cur.length; i++) {
      const p = cur[i], q = cur[(i + 1) % cur.length];
      out.push([p[0] * 0.75 + q[0] * 0.25, p[1] * 0.75 + q[1] * 0.25]);
      out.push([p[0] * 0.25 + q[0] * 0.75, p[1] * 0.25 + q[1] * 0.75]);
    }
    cur = out;
  }
  return resample(cur, 8, true);
}

// Snap tail to head: cut back to the closest approach (not everything within snap —
// that eats legit overlapping track and leaves a shortcut chord), then fill any
// residual chord with even points so the seam has uniform spacing.
export function closeLoop(pts: Pt[], snap = 60): { loop: Pt[]; closed: boolean } {
  if (pts.length < 2) return { loop: pts, closed: false };
  if (dist(pts[0], pts[pts.length - 1]) >= snap) return { loop: pts, closed: false };
  let end = pts.length - 1, best = end, bd = 0;
  for (let k = 0; k < Math.min(pts.length - 8, 40); k++) {
    const d = dist(pts[pts.length - 1 - k], pts[0]);
    if (d < bd || k === 0) { bd = d; best = pts.length - 1 - k; }
    else if (d > bd + 12) break; // past closest approach
  }
  end = Math.max(8, best);
  const loop = pts.slice(0, end + 1);
  const gap = dist(loop[loop.length - 1], loop[0]);
  if (gap > 8) {
    const a = loop[loop.length - 1], b = loop[0], k = Math.round(gap / 8);
    for (let i = 1; i < k; i++) loop.push([a[0] + ((b[0] - a[0]) * i) / k, a[1] + ((b[1] - a[1]) * i) / k]);
  }
  return { loop, closed: loop.length >= 8 };
}

// Cut the closure corner and bridge it with a tangent-matched Hermite spline.
// G1-continuous by construction: no kink, no fill wedge at the seam.
// Runs only on new/changed strokes (dirty-gated), so it always blends once.
export function blendSeam(loop: Pt[], cut = 4): Pt[] {
  const n = loop.length;
  if (n < 16) return loop;
  const c = Math.max(2, Math.min(cut, Math.floor(n / 8)));
  const A = loop[(n - c) % n], B = loop[c % n];
  const pA = loop[(n - c - 3 + n) % n], nB = loop[(c + 3) % n]; // wide stencil: stable tangents
  const tAx = A[0] - pA[0], tAy = A[1] - pA[1], tBx = nB[0] - B[0], tBy = nB[1] - B[1];
  const lA = Math.hypot(tAx, tAy) || 1, lB = Math.hypot(tBx, tBy) || 1;
  const d = dist(A, B) || 1;
  // tangent reach ≈ arm scale (not segment scale): too short kinks at the meet points,
  // chord-scaled loops the bridge. d/2 would loop on hairpins; cap at 24.
  const L = Math.min(24, d * 0.5);
  const m0x = (tAx / lA) * L, m0y = (tAy / lA) * L;
  const m1x = (tBx / lB) * L, m1y = (tBy / lB) * L;
  const m = Math.max(4, Math.ceil(d / 6));
  const out: Pt[] = [];
  for (let k = 0; k <= m; k++) {
    const t = k / m, t2 = t * t, t3 = t2 * t;
    out.push([
      (2 * t3 - 3 * t2 + 1) * A[0] + (t3 - 2 * t2 + t) * m0x + (-2 * t3 + 3 * t2) * B[0] + (t3 - t2) * m1x,
      (2 * t3 - 3 * t2 + 1) * A[1] + (t3 - 2 * t2 + t) * m0y + (-2 * t3 + 3 * t2) * B[1] + (t3 - t2) * m1y,
    ]);
  }
  for (let k = c + 1; k <= n - c - 1; k++) out.push(loop[k % n]);
  return resample(out, 8, true);
}
// Straight segment sampled to points (line tool).
export function sampleLine(a: Pt, b: Pt, step = 8): Pt[] {
  const n = Math.max(1, Math.ceil(dist(a, b) / step));
  const out: Pt[] = [];
  for (let i = 0; i <= n; i++) out.push([a[0] + ((b[0] - a[0]) * i) / n, a[1] + ((b[1] - a[1]) * i) / n]);
  return out;
}

// Circle through 3 points; null when collinear.
export function circleCenter(p0: Pt, p1: Pt, p2: Pt): Pt | null {
  const d = 2 * (p0[0] * (p1[1] - p2[1]) + p1[0] * (p2[1] - p0[1]) + p2[0] * (p0[1] - p1[1]));
  if (Math.abs(d) < 1e-6) return null;
  const s0 = p0[0] ** 2 + p0[1] ** 2, s1 = p1[0] ** 2 + p1[1] ** 2, s2 = p2[0] ** 2 + p2[1] ** 2;
  return [
    ((s0 * (p1[1] - p2[1]) + s1 * (p2[1] - p0[1]) + s2 * (p0[1] - p1[1])) / d),
    ((s0 * (p2[0] - p1[0]) + s1 * (p0[0] - p2[0]) + s2 * (p1[0] - p0[0])) / d),
  ];
}

// Arc from p0 to p2 passing through p1 (arc tool). Falls back to polyline if collinear.
export function sampleArc(p0: Pt, p1: Pt, p2: Pt, step = 8): Pt[] {
  const c = circleCenter(p0, p1, p2);
  if (!c) return [p0, p1, p2];
  const TAU = Math.PI * 2;
  const norm = (a: number) => ((a % TAU) + TAU) % TAU;
  const ang = (p: Pt) => Math.atan2(p[1] - c[1], p[0] - c[0]);
  const a0 = ang(p0), a1 = ang(p1), a2 = ang(p2);
  const sweepTotal = norm(a2 - a0);
  const dir = norm(a1 - a0) <= sweepTotal ? 1 : -1; // which way passes through p1
  const sweep = dir === 1 ? sweepTotal : sweepTotal - TAU;
  const r = dist(c, p0);
  const n = Math.max(8, Math.ceil((Math.abs(sweep) * r) / step));
  const out: Pt[] = [];
  for (let i = 0; i <= n; i++) {
    const a = a0 + (sweep * i) / n;
    out.push([c[0] + Math.cos(a) * r, c[1] + Math.sin(a) * r]);
  }
  return out;
}

function segInt(p1: Pt, p2: Pt, p3: Pt, p4: Pt): boolean {
  const d = (a: Pt, b: Pt, c: Pt) => (c[0] - a[0]) * (b[1] - a[1]) - (c[1] - a[1]) * (b[0] - a[0]);
  const d1 = d(p3, p4, p1), d2 = d(p3, p4, p2), d3 = d(p1, p2, p3), d4 = d(p1, p2, p4);
  return ((d1 > 0 && d2 < 0) || (d1 < 0 && d2 > 0)) && ((d3 > 0 && d4 < 0) || (d3 < 0 && d4 > 0));
}

// Self-intersection check on cyclic polyline; skips adjacent segments
export function hasSelfIntersection(pts: Pt[]): boolean {
  const n = pts.length;
  if (n < 8) return false;
  for (let i = 0; i < n; i++) {
    for (let j = i + 2; j < n; j++) {
      if (i === 0 && j === n - 1) continue; // closure neighbors
      if (segInt(pts[i], pts[(i + 1) % n], pts[j], pts[(j + 1) % n])) return true;
    }
  }
  return false;
}

// Min distance between non-adjacent points (index window skips neighbors).
// Catches ribbon overlap where centerlines don't cross but track widths collide
// (parallel sections, tight hairpins). Cyclic-aware when closed.
export function minSelfSeparation(pts: Pt[], window: number, closed: boolean): number {
  const n = pts.length;
  if (n < window * 2 + 4) return Infinity;
  let m = Infinity;
  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      let d = j - i;
      if (closed) d = Math.min(d, n - d);
      if (d <= window) continue;
      const dd = dist(pts[i], pts[j]);
      if (dd < m) m = dd;
    }
  }
  return m;
}

// Geometry policy: centerline crossings rejected; ribbon overlaps MERGE
// (tight angles become hairpins — the union renders as wider apex asphalt).
export function validateGeometry(center: Pt[], _w: number): 'ok' | 'crossed' {
  if (center.length < 8) return 'ok';
  return hasSelfIntersection(center) ? 'crossed' : 'ok';
}

// Does a new stroke overlap committed track? Ignores committed points within
// r = w*1.5 of the stroke's own ends (attach dot + landing zone), so legit
// joins pass regardless of point density. Point-count skips are NOT density-proof:
// raw hand strokes are ~3px spaced, so skipping N points only excludes ~3N px.
// Returns true when any middle part of the stroke comes within w of the track.
export function segOverlapsExisting(committed: Pt[], seg: Pt[], w: number): boolean {
  if (seg.length < 4 || !committed.length) return false;
  const r = w * 1.5;
  const a = seg[0], b = seg[seg.length - 1];
  for (const q of committed) {
    if (dist(q, a) < r || dist(q, b) < r) continue;
    for (const p of seg) {
      if (dist(q, p) < w) return true;
    }
  }
  return false;
}

// Manual checkpoints: gates live exactly on the road edges (left[f]-right[f],
// 1:1 with centerline), so they track width changes and never leap sections.
// One gate segment at arc fraction fr (for the start line too).
export function gateAt(t: Track, fr: number): Checkpoint {
  const n = t.centerline.length;
  const f = ((fr % 1) + 1) % 1 * n;
  const { left, right } = edges(t);
  const at = (poly: Pt[]): Pt => {
    const i = Math.floor(f) % n, r = f - Math.floor(f);
    const j = t.closed ? (i + 1) % n : Math.min(i + 1, n - 1);
    return [poly[i][0] + (poly[j][0] - poly[i][0]) * r, poly[i][1] + (poly[j][1] - poly[i][1]) * r];
  };
  return { s: f, a: at(left), b: at(right) };
}

export function checkpoints(t: Track): Checkpoint[] {
  if (t.centerline.length < 8) return [];
  return (t.gates ?? []).map((fr) => gateAt(t, fr));
}

// Dynamic road width: each checkpoint carries a width; between gates the width
// cosine-interpolates (zero slope at gates, smooth everywhere). No gates → general width.
export function widthAt(t: Track, fr: number): number {
  const gs = t.gates ?? [], ws = t.gateWidths ?? [];
  if (!gs.length) return t.width;
  const f = (((fr % 1) + 1) % 1);
  const n = gs.length;
  if (n === 1) return ws[0] ?? t.width;
  let i = n - 1;
  for (let k = 0; k < n; k++) if (gs[k] <= f) i = k;
  const a = gs[i], w0 = ws[i] ?? t.width;
  const b = gs[(i + 1) % n], w1 = ws[(i + 1) % n] ?? t.width;
  let span = b - a;
  if (span <= 0) span += 1;
  let tt = f - a;
  if (tt < 0) tt += 1;
  const s = 0.5 - 0.5 * Math.cos(Math.PI * Math.min(1, Math.max(0, tt / span)));
  return w0 + (w1 - w0) * s;
}

// Point on a centerline at arc fraction (open-safe). Used to world-anchor gates
// and start across rebuilds: fractions alone drift when resampling changes indices.
export function pointAt(center: Pt[], closed: boolean, fr: number): Pt {
  const n = center.length;
  if (!n) return [0, 0];
  const f = (((fr % 1) + 1) % 1) * n;
  const i = Math.floor(f) % n, r = f - Math.floor(f);
  const j = closed ? (i + 1) % n : Math.min(i + 1, n - 1);
  return [center[i][0] + (center[j][0] - center[i][0]) * r, center[i][1] + (center[j][1] - center[i][1]) * r];
}

// Exact arc fraction of the nearest point on a polyline (segment projection,
// not vertex snapping). Re-snapping the same world spot is exact to ~1e-9, so
// gates/start don't ratchet when resampling renumbers vertices across save/load.
export function projectFraction(center: Pt[], closed: boolean, p: Pt): number {
  const n = center.length;
  if (n < 2) return 0;
  let best = Infinity, bi = 0, bt = 0;
  const segs = closed ? n : n - 1;
  for (let i = 0; i < segs; i++) {
    const a = center[i], b = center[(i + 1) % n];
    const vx = b[0] - a[0], vy = b[1] - a[1];
    const L2 = vx * vx + vy * vy || 1;
    const t = Math.max(0, Math.min(1, ((p[0] - a[0]) * vx + (p[1] - a[1]) * vy) / L2));
    const dx = p[0] - (a[0] + vx * t), dy = p[1] - (a[1] + vy * t);
    const d = dx * dx + dy * dy;
    if (d < best) { best = d; bi = i; bt = t; }
  }
  return (bi + bt) / n;
}

// Edge polylines (clamped indices: correct for open drafts too).
// Inner edge is clamped to the local curve radius: when half-width exceeds the
// radius (tight hairpin at max width) a raw parallel offset CUSPS — folds back
// into zigzag triangles that gates then follow. Clamp keeps it pinched, sane.
export function edges(t: Track): { left: Pt[]; right: Pt[] } {
  const n = t.centerline.length, left: Pt[] = [], right: Pt[] = [];
  const base = t.centerline.map((_, i) => widthAt(t, i / n) / 2); // per-vertex half-width
  const normals: Pt[] = [];
  const allowL: number[] = [], allowR: number[] = [];
  for (let i = 0; i < n; i++) {
    const c = t.centerline[i];
    const p = t.centerline[Math.max(0, i - 1)], q = t.centerline[Math.min(n - 1, i + 1)];
    const dx = q[0] - p[0], dy = q[1] - p[1], len = Math.hypot(dx, dy) || 1;
    normals.push([-dy / len, dx / len]);
    // radius over ±3 stencil (~48px, true arc lengths): immune to 8px sampling jitter.
    // A 16px stencil sees hand jitter as curvature and misfires the clamp.
    const i3 = (k: number) => (t.closed ? ((k % n) + n) % n : Math.max(0, Math.min(n - 1, k)));
    const p3 = t.centerline[i3(i - 3)], q3 = t.centerline[i3(i + 3)];
    const w0x = c[0] - p3[0], w0y = c[1] - p3[1], w1x = q3[0] - c[0], w1y = q3[1] - c[1];
    const m0 = Math.hypot(w0x, w0y) || 1, m1 = Math.hypot(w1x, w1y) || 1;
    const cross = (w0x * w1y - w0y * w1x) / (m0 * m1);
    const dot = Math.max(-1, Math.min(1, (w0x * w1x + w0y * w1y) / (m0 * m1)));
    const phi = Math.acos(dot);
    const r = phi > 1e-4 ? (m0 + m1) / 2 / Math.sin(phi / 2) : Infinity;
    const inner = Math.max(0, Math.min(base[i], r - 2));
    allowL.push(cross > 0 ? inner : base[i]); // cross>0: curvature center on +N (left) side
    allowR.push(cross > 0 ? base[i] : inner);
  }
  // light smooth (±2) kills single-vertex steps; NO min-spread — spreading drags
  // pinches dozens of px along the road (the narrowing bug).
  const idx = (k: number) => (t.closed ? ((k % n) + n) % n : Math.max(0, Math.min(n - 1, k)));
  const smoothProf = (arr: number[]): number[] =>
    arr.map((_, i) => {
      let s = 0;
      for (let m = -2; m <= 2; m++) s += arr[idx(i + m)];
      return s / 5;
    });
  const fL = smoothProf(allowL), fR = smoothProf(allowR);
  for (let i = 0; i < n; i++) {
    const c = t.centerline[i], [nx, ny] = normals[i];
    left.push([c[0] + nx * fL[i], c[1] + ny * fL[i]]);
    right.push([c[0] - nx * fR[i], c[1] - ny * fR[i]]);
  }
  // final pass: smooth the polylines themselves. Center jitter steers the per-vertex
  // normals, and the ±hw lever turns degrees of wobble into px of lumpy road.
  // (cusp clamp above already ran; this only irons high-frequency ripples.)
  const sm = (poly: Pt[]): Pt[] =>
    poly.map((_, i) => {
      let x = 0, y = 0;
      for (let m = -3; m <= 3; m++) {
        const q = poly[t.closed ? ((i + m + n) % n) : Math.max(0, Math.min(n - 1, i + m))];
        x += q[0]; y += q[1];
      }
      return [x / 7, y / 7] as Pt;
    });
  return { left: sm(left), right: sm(right) };
}

// Ribbon polygon (left edge forward + right edge back) for fill
export function ribbon(t: Track): Pt[] {
  const { left, right } = edges(t);
  return [...left, ...right.reverse()];
}

// Seam band-aid: small overlap strip around the closure joint, filled over the
// ribbon. Polygon triangulation can leave a notch at the L/R joint no matter how
// smooth the data is — overlapping fill makes a gap impossible by construction.
export function seamPatch(t: Track, half = 6): Pt[] {
  const n = t.centerline.length;
  if (n < half * 2 + 2) return [];
  const { left, right } = edges(t);
  const at = (poly: Pt[], k: number) => poly[((k % n) + n) % n];
  const band: Pt[] = [];
  for (let k = -half; k <= half; k++) band.push(at(left, k));
  for (let k = half; k >= -half; k--) band.push(at(right, k));
  return band;
}

// Chaikin for open paths: keeps endpoints, rounds interior joints (segment joins).
export function smoothOpen(pts: Pt[], iters = 1): Pt[] {
  let cur = pts;
  for (let it = 0; it < iters; it++) {
    const out: Pt[] = [cur[0]];
    for (let i = 0; i < cur.length - 1; i++) {
      const p = cur[i], q = cur[i + 1];
      out.push([p[0] * 0.75 + q[0] * 0.25, p[1] * 0.75 + q[1] * 0.25]);
      out.push([p[0] * 0.25 + q[0] * 0.75, p[1] * 0.25 + q[1] * 0.75]);
    }
    out.push(cur[cur.length - 1]);
    cur = out;
  }
  return resample(cur, 8, false);
}

export function nearestIndex(pts: Pt[], p: Pt): number {
  let bi = 0, bd = Infinity;
  for (let i = 0; i < pts.length; i++) {
    const d = dist(pts[i], p);
    if (d < bd) { bd = d; bi = i; }
  }
  return bi;
}

export const uid = () => Math.random().toString(36).slice(2, 10);
