import { readFileSync } from 'node:fs';
import { makeTrackIndex, spawn, locate, observe, stepCar, DT } from '../src/sim.ts';
import { pointAt } from '../src/track.ts';
import { physicsFor, blankTeam } from '../src/teams.ts';
import type { Track } from '../src/track.ts';
import type { Control } from '../src/sim.ts';

const phys = physicsFor({ ...blankTeam('t') });
const wrap = (a: number) => Math.atan2(Math.sin(a), Math.cos(a));

// lookahead curvature: max heading change over next K px
function aheadCurve(idx: ReturnType<typeof makeTrackIndex>, frac: number, distPx: number): number {
  const pts = idx.track.centerline, m = pts.length;
  const stepLen = idx.total / m;
  const steps = Math.max(1, Math.round(distPx / stepLen));
  const i0 = ((Math.floor(frac * m) % m) + m) % m;
  let mx = 0;
  let px = pts[i0][0] - pts[(i0 - 1 + m) % m][0];
  let py = pts[i0][1] - pts[(i0 - 1 + m) % m][1];
  for (let k = 1; k <= steps; k++) {
    const a = pts[(i0 + k - 1) % m], b = pts[(i0 + k) % m];
    const h1 = Math.atan2(py, px);
    const h2 = Math.atan2(b[1] - a[1], b[0] - a[0]);
    let d = Math.abs(h2 - h1);
    if (d > Math.PI) d = 2 * Math.PI - d;
    mx = Math.max(mx, d);
    px = b[0] - a[0]; py = b[1] - a[1];
  }
  return mx; // radians per ~stepLen px
}

for (const tn of ['Spa GP.json', 'Bahrain GP.json', 'Portimao GP.json', 'Monaco GP.json']) {
  const track = JSON.parse(readFileSync(`/home/danel/Projects/racing_sim/assets/tracks/${tn}`, 'utf8')) as Track;
  const idx = makeTrackIndex(track);
  // smooth pursuit: proportional steer, target speed from upcoming curvature
  const { car } = spawn(idx);
  let hint = -1, prevFrac: number | null = null, prog = 0, time = 0;
  let res = '', maxLat = 0;
  for (let step = 0; step < 60 * 120; step++) {
    const loc = locate(idx, car.x, car.y, hint);
    hint = loc.bi;
    if (prevFrac == null) prevFrac = loc.frac;
    let d = loc.frac - prevFrac;
    if (d > 0.5) d -= 1; else if (d < -0.5) d += 1;
    prog += d; prevFrac = loc.frac;
    maxLat = Math.max(maxLat, Math.abs(loc.dist));
    if (loc.dist > loc.hw) { res = `crash@${prog.toFixed(3)}`; break; }
    if (prog >= 1) { res = 'LAP'; break; }
    const tp = pointAt(idx.track.centerline, true, loc.frac + 0.02);
    const err = wrap(Math.atan2(tp[1] - car.y, tp[0] - car.x) - car.heading);
    const steer = Math.max(-1, Math.min(1, err * 1.5));
    const curve = aheadCurve(idx, loc.frac, 120);
    // target speed: slow proportionally to upcoming curvature
    const vTarget = Math.max(40, 220 - curve * 900);
    const v = Math.hypot(car.vx, car.vy);
    const ctl: Control = [v < vTarget ? 1 : 0, v > vTarget + 15 ? 0.9 : 0, steer];
    const obs = observe(idx, car, loc);
    void obs;
    stepCar(car, ctl, phys);
    time += DT;
  }
  if (!res) res = 'timeout';
  console.log(`${tn}: ${res} t=${time.toFixed(1)} maxLat=${maxLat.toFixed(1)}`);
}
