import type { Pt, Track } from './track.ts';
import { checkpoints, edges, widthAt } from './track.ts';
import type { PhysicsParams } from './teams.ts';

// ---- Shared fixed-timestep sim core (Stories 3-4: practice, quali, race) ----
// Arcade bicycle-ish model, dt = 1/60, seeded RNG for deterministic replays.
export const DT = 1 / 60;
const WHEELBASE = 32; // px, car length scale
const RAY_RANGE = 300; // px, sensor normalization
const RAY_COUNT = 9; // over ±90°

export function mulberry32(seed: number) {
  let a = seed >>> 0;
  return () => {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export interface CarState { x: number; y: number; heading: number; vx: number; vy: number }
export type Control = [throttle: number, brake: number, steer: number]; // [0,1] [0,1] [-1,1]

export interface TrackIndex {
  track: Track; n: number; pts: Pt[]; cum: number[]; total: number;
  left: Pt[]; right: Pt[]; gates: Pt[]; gateFr: number[];
  gateOrder: { fr: number; g: Pt }[]; // gates sorted by arc fraction (binary-searched per step)
  grid: Map<number, number[]>; cell: number;
}

// Precompute per track: arc lengths, edges, gate midpoints, edge-segment grid.
export function makeTrackIndex(track: Track): TrackIndex {
  const pts = track.centerline, n = pts.length;
  const cum = [0];
  for (let i = 1; i <= n; i++) {
    const a = pts[i - 1], b = pts[i % n];
    cum.push(cum[i - 1] + Math.hypot(b[0] - a[0], b[1] - a[1]));
  }
  const { left, right } = edges(track);
  const gates = checkpoints(track).map((g) => [(g.a[0] + g.b[0]) / 2, (g.a[1] + g.b[1]) / 2] as Pt);
  const gateFr = (track.gates ?? []).slice();
  const cell = 32;
  const grid = new Map<number, number[]>();
  const key = (cx: number, cy: number) => cx * 65536 + cy; // cell indices: |cy| << 32768
  const addSeg = (a: Pt, b: Pt, id: number) => {
    const x0 = Math.min(a[0], b[0]), x1 = Math.max(a[0], b[0]);
    const y0 = Math.min(a[1], b[1]), y1 = Math.max(a[1], b[1]);
    for (let cx = Math.floor(x0 / cell); cx <= Math.floor(x1 / cell); cx++)
      for (let cy = Math.floor(y0 / cell); cy <= Math.floor(y1 / cell); cy++) {
        const k = key(cx, cy);
        let arr = grid.get(k);
        if (!arr) grid.set(k, (arr = []));
        arr.push(id);
      }
  };
  for (let i = 0; i < n; i++) {
    addSeg(left[i], left[(i + 1) % n], i);
    addSeg(right[i], right[(i + 1) % n], n + i);
  }
  const gateOrder = gates
    .map((g, i) => ({ fr: gateFr[i] ?? i / Math.max(1, gates.length), g }))
    .sort((a, b) => a.fr - b.fr);
  return { track, n, pts, cum, total: cum[n], left, right, gates, gateFr, gateOrder, grid, cell };
}

export interface Located { s: number; frac: number; dist: number; tx: number; ty: number; hw: number; cx: number; cy: number; bi: number }

// Nearest centerline point (segment-projected). Hint = last index: windowed
// search (±16 segs) since cars move <6px/step; full scan when lost/teleported.
export function locate(idx: TrackIndex, x: number, y: number, hint: number): Located {
  const { pts, n, track } = idx;
  let best = Infinity, bi = 0, bt = 0;
  const scan = (i0: number, i1: number) => {
    for (let i = i0; i < i1; i++) {
      const k = ((i % n) + n) % n;
      const a = pts[k], b = pts[(k + 1) % n];
      const vx = b[0] - a[0], vy = b[1] - a[1];
      const L2 = vx * vx + vy * vy || 1;
      const t = Math.max(0, Math.min(1, ((x - a[0]) * vx + (y - a[1]) * vy) / L2));
      const dx = x - (a[0] + vx * t), dy = y - (a[1] + vy * t);
      const d = dx * dx + dy * dy;
      if (d < best) { best = d; bi = k; bt = t; }
    }
  };
  if (hint >= 0) {
    scan(hint - 16, hint + 17);
    if (best < 100 * 100) return finish(idx, bi, bt, best);
  }
  best = Infinity;
  scan(0, n);
  return finish(idx, bi, bt, best);
}

function finish(idx: TrackIndex, bi: number, bt: number, best: number): Located {
  const { pts, n, cum, track } = idx;
  const a = pts[bi], b = pts[(bi + 1) % n];
  const segLen = Math.hypot(b[0] - a[0], b[1] - a[1]) || 1;
  const tx = (b[0] - a[0]) / segLen, ty = (b[1] - a[1]) / segLen;
  const s = cum[bi] + bt * segLen;
  return { s, frac: s / idx.total, dist: Math.sqrt(best), tx, ty, hw: widthAt(track, s / idx.total) / 2, cx: a[0] + (b[0] - a[0]) * bt, cy: a[1] + (b[1] - a[1]) * bt, bi };
}

// Spawn at the start line, heading along the tangent.
export function spawn(idx: TrackIndex): { car: CarState; s0: number } {
  const t = idx.track;
  const i = t.startS == null ? 0 : t.startS % idx.n;
  const p = t.centerline[i];
  const q = t.centerline[(i + 3) % idx.n], r = t.centerline[(i - 3 + idx.n) % idx.n];
  const dx = q[0] - r[0], dy = q[1] - r[1], L = Math.hypot(dx, dy) || 1;
  return { car: { x: p[0], y: p[1], heading: Math.atan2(dy, dx), vx: 0, vy: 0 }, s0: idx.cum[i] };
}

export function stepCar(car: CarState, c: Control, p: PhysicsParams): void {
  const thr = Math.max(0, Math.min(1, c[0])), brk = Math.max(0, Math.min(1, c[1]));
  const str = Math.max(-1, Math.min(1, c[2]));
  const fx = Math.cos(car.heading), fy = Math.sin(car.heading);
  let vf = car.vx * fx + car.vy * fy, vl = -car.vx * fy + car.vy * fx;
  const drag = p.engine / p.vMax; // full throttle equilibrates at vMax
  vf += (thr * p.engine - brk * p.brake * Math.sign(vf) - drag * vf) * DT;
  if (vf < 0) vf = 0; // no reverse v1
  vl *= Math.exp(-p.grip * DT); // lateral slide decays by grip
  car.vx = fx * vf - fy * vl;
  car.vy = fy * vf + fx * vl;
  car.x += car.vx * DT;
  car.y += car.vy * DT;
  car.heading += ((vf / WHEELBASE) * Math.tan(str * p.steerMax)) * DT;
}

function rayHit(idx: TrackIndex, x: number, y: number, dx: number, dy: number): number {
  // march 8px steps (cell 32: no skipped cells), exact-test candidate segments
  const segs = new Set<number>();
  let step = 0;
  for (let d = 0; d < RAY_RANGE; d += 8, step++) {
    const k = Math.floor((x + dx * d) / idx.cell) * 65536 + Math.floor((y + dy * d) / idx.cell);
    const arr = idx.grid.get(k);
    if (arr) for (const id of arr) segs.add(id);
  }
  void step;
  let m = RAY_RANGE;
  for (const id of segs) {
    const poly = id < idx.n ? idx.left : idx.right;
    const i = id < idx.n ? id : id - idx.n;
    const a = poly[i], b = poly[(i + 1) % idx.n];
    const ex = b[0] - a[0], ey = b[1] - a[1];
    const den = dx * ey - dy * ex;
    if (Math.abs(den) < 1e-9) continue;
    const t = ((a[0] - x) * ey - (a[1] - y) * ex) / den;
    const u = ((a[0] - x) * dy - (a[1] - y) * dx) / den;
    if (t >= 0 && u >= 0 && u <= 1 && t < m) m = t;
  }
  return m / RAY_RANGE;
}

// Flat 16-dim observation: speed, lateral offset, heading error, 9 edge rays,
// angle+dist to the next 2 gate midpoints. Normalized per initial_plan.
function nextGate(idx: TrackIndex, frac: number, k: number): Pt {
  const ord = idx.gateOrder;
  if (!ord.length) return [idx.pts[0][0], idx.pts[0][1]];
  // first gate strictly ahead (a gate exactly at frac counts as just passed → full lap)
  let lo = 0, hi = ord.length;
  while (lo < hi) { const m = (lo + hi) >> 1; if (ord[m].fr <= frac) lo = m + 1; else hi = m; }
  return ord[(lo + k - 1) % ord.length].g;
}

const wrapAngle = (a: number) => Math.atan2(Math.sin(a), Math.cos(a));
export function observe(idx: TrackIndex, car: CarState, loc: Located): number[] {
  const out: number[] = [Math.hypot(car.vx, car.vy) / 300];
  const nx = -loc.ty, ny = loc.tx;
  out.push(Math.max(-2, Math.min(2, ((car.x - loc.cx) * nx + (car.y - loc.cy) * ny) / (loc.hw || 1))));
  out.push(wrapAngle(car.heading - Math.atan2(loc.ty, loc.tx)) / Math.PI);
  for (let r = 0; r < RAY_COUNT; r++) {
    const a = car.heading - Math.PI / 2 + (r / (RAY_COUNT - 1)) * Math.PI;
    out.push(rayHit(idx, car.x, car.y, Math.cos(a), Math.sin(a)));
  }
  // k-th gate ahead by arc fraction (manual gates aren't evenly spaced)
  for (let k = 1; k <= 2; k++) {
    const g = nextGate(idx, loc.frac, k);
    const dx = g[0] - car.x, dy = g[1] - car.y;
    out.push(wrapAngle(Math.atan2(dy, dx) - car.heading) / Math.PI);
    out.push(Math.min(1, Math.hypot(dx, dy) / RAY_RANGE));
  }
  return out;
}

export interface EpisodeOpts { laps?: number; maxTime?: number }
export interface EpisodeResult { progress: number; time: number; steps: number; done: 'lap' | 'crash' | 'timeout' }

// One episode: spawn, then observe → act → step until lap(s), crash or timeout.
// Progress counts signed laps from the spawn point (unwrapped arc fraction).
// Async with periodic yields so long episodes never block the UI thread.
const yieldTick = () => new Promise<void>((res) => setTimeout(res, 0));
export async function runEpisode(
  idx: TrackIndex,
  phys: PhysicsParams,
  policy: (obs: number[], car: CarState) => Control,
  opts: EpisodeOpts = {},
): Promise<EpisodeResult> {
  const laps = opts.laps ?? 1, maxTime = opts.maxTime ?? 60;
  const { car } = spawn(idx);
  let hint = -1, prevFrac: number | null = null, prog = 0, time = 0, steps = 0;
  for (;;) {
    const loc = locate(idx, car.x, car.y, hint);
    hint = loc.bi;
    if (prevFrac == null) prevFrac = loc.frac;
    let d = loc.frac - prevFrac;
    if (d > 0.5) d -= 1;
    else if (d < -0.5) d += 1;
    prog += d;
    prevFrac = loc.frac;
    if (loc.dist > loc.hw) return { progress: prog, time, steps, done: 'crash' };
    if (prog >= laps) return { progress: prog, time, steps, done: 'lap' };
    if (time >= maxTime) return { progress: prog, time, steps, done: 'timeout' };
    if (time > 8 && prog < 0.02) return { progress: prog, time, steps, done: 'crash' }; // stalled: parked or crawling, don't burn the full timeout
    stepCar(car, policy(observe(idx, car, loc), car), phys);
    time += DT;
    steps++;
    if (steps % 120 === 0) await yieldTick();
  }
}
