import { readFileSync } from 'node:fs';
import { makeTrackIndex, spawn, locate, observe, stepCar, DT } from '../src/sim.ts';
import { pointAt } from '../src/track.ts';
import { buildNet, forwardGenome, mutateGenome } from '../src/nn.ts';
import { physicsFor, blankTeam } from '../src/teams.ts';
import { mulberry32 } from '../src/sim.ts';
import type { Track } from '../src/track.ts';
import type { Control } from '../src/sim.ts';

const phys = physicsFor({ ...blankTeam('t') });
const wrap = (a: number) => Math.atan2(Math.sin(a), Math.cos(a));
const net = buildNet();

// pursuit demonstrator (laps Spa)
function pursuit(idx: ReturnType<typeof makeTrackIndex>, loc: { frac: number }, car: { x: number; y: number; heading: number; vx: number; vy: number }): Control {
  const ahead = aheadCurve(idx, loc.frac, 120);
  void ahead;
  const tp = pointAt(idx.track.centerline, true, loc.frac + 0.01);
  const err = wrap(Math.atan2(tp[1] - car.y, tp[0] - car.x) - car.heading);
  const steer = Math.max(-1, Math.min(1, err * 1.5));
  const v = Math.hypot(car.vx, car.vy);
  return [v < 200 ? 1 : 0, v > 215 ? 0.9 : 0, steer];
}
function aheadCurve(idx: ReturnType<typeof makeTrackIndex>, frac: number, distPx: number): number {
  const pts = idx.track.centerline, m = pts.length;
  const stepLen = idx.total / m;
  const steps = Math.max(1, Math.round(distPx / stepLen));
  const i0 = ((Math.floor(frac * m) % m) + m) % m;
  let mx = 0, px = pts[i0][0] - pts[(i0 - 1 + m) % m][0], py = pts[i0][1] - pts[(i0 - 1 + m) % m][1];
  for (let k = 1; k <= steps; k++) {
    const a = pts[(i0 + k - 1) % m], b = pts[(i0 + k) % m];
    const h1 = Math.atan2(py, px), h2 = Math.atan2(b[1] - a[1], b[0] - a[0]);
    let d = Math.abs(h2 - h1);
    if (d > Math.PI) d = 2 * Math.PI - d;
    mx = Math.max(mx, d);
    px = b[0] - a[0]; py = b[1] - a[1];
  }
  return mx;
}

// collect (obs, action) pairs from pursuit rollouts with noise-injected states
const track = JSON.parse(readFileSync('/home/danel/Projects/racing_sim/assets/tracks/Spa GP.json', 'utf8')) as Track;
const idx = makeTrackIndex(track);
const pairs: { obs: number[]; act: Control }[] = [];
{
  const { car } = spawn(idx);
  let hint = -1, prevFrac: number | null = null, prog = 0;
  const rand = mulberry32(99);
  for (let step = 0; step < 60 * 120 && prog < 1; step++) {
    const loc = locate(idx, car.x, car.y, hint);
    hint = loc.bi;
    if (prevFrac == null) prevFrac = loc.frac;
    let d = loc.frac - prevFrac;
    if (d > 0.5) d -= 1; else if (d < -0.5) d += 1;
    prog += d; prevFrac = loc.frac;
    if (loc.dist > loc.hw) break;
    const obs = observe(idx, car, loc);
    pairs.push({ obs, act: pursuit(idx, loc, car) });
    // record noisy neighbors too for robustness
    for (let j = 0; j < 2; j++) {
      const noisy = obs.map((v) => v + (rand() - 0.5) * 0.1);
      pairs.push({ obs: noisy, act: pursuit(idx, loc, car) });
    }
    stepCar(car, pursuit(idx, loc, car), phys);
  }
}
console.log(`collected ${pairs.length} demo pairs`);

// hill-climb MSE from random genome
function mse(g: Float32Array): number {
  let s = 0;
  for (const p of pairs) {
    const o = forwardGenome(g, p.obs);
    for (let k = 0; k < 3; k++) { const e = o[k] - p.act[k]; s += e * e; }
  }
  return s / (pairs.length * 3);
}
const rand = mulberry32(7);
const g0 = new Float32Array(net.size);
for (let i = 0; i < g0.length; i++) g0[i] = (rand() * 2 - 1) * 0.5;
let best = g0, bestMse = mse(g0);
console.log(`init mse=${bestMse.toFixed(4)}`);
for (let iter = 0; iter < 300; iter++) {
  const cand = mutateGenome(best, 0.05, rand);
  const m = mse(cand);
  if (m < bestMse) { best = cand; bestMse = m; }
  if (iter % 50 === 49) console.log(`iter ${iter}: mse=${bestMse.toFixed(4)}`);
}

// evaluate distilled net: full lap from standing start?
function rollout(g: Float32Array): string {
  const { car } = spawn(idx);
  let hint = -1, prevFrac: number | null = null, prog = 0, time = 0;
  for (let step = 0; step < 60 * 150; step++) {
    const loc = locate(idx, car.x, car.y, hint);
    hint = loc.bi;
    if (prevFrac == null) prevFrac = loc.frac;
    let d = loc.frac - prevFrac;
    if (d > 0.5) d -= 1; else if (d < -0.5) d += 1;
    prog += d; prevFrac = loc.frac;
    if (loc.dist > loc.hw) return `crash@${prog.toFixed(3)} t=${time.toFixed(0)}`;
    if (prog >= 1) return `LAP t=${time.toFixed(0)}`;
    stepCar(car, forwardGenome(g, observe(idx, car, loc)), phys);
    time += DT;
  }
  return 'timeout';
}
console.log('distilled:', rollout(best));
