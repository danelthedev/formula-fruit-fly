import { readFileSync } from 'node:fs';
import { makeTrackIndex, spawn, locate, observe, stepCar, DT } from '../src/sim.ts';
import { forwardGenome } from '../src/nn.ts';
import { physicsFor, blankTeam } from '../src/teams.ts';
import type { Track } from '../src/track.ts';
import type { Control } from '../src/sim.ts';
const phys = physicsFor({ ...blankTeam('t') });
const track = JSON.parse(readFileSync('/home/danel/Projects/racing_sim/assets/tracks/Portimao GP.json', 'utf8')) as Track;
const saved = JSON.parse(readFileSync('/tmp/headless_pop.json', 'utf8'));
const g = new Float32Array(saved.pop[0]);
// smooth centerline in wrap window [0.95, 0.10] with wide Gaussian (in-memory only)
const pts = track.centerline as [number,number][];
const n = pts.length;
function dfrac(f: number, c: number) {
  let d = Math.abs(f - c);
  return Math.min(d, 1 - d);
}
const sm = pts.map((p, i) => {
  const f = i / n;
  const gss = Math.exp(-(dfrac(f, 0.02) ** 2) / (2 * 0.02 ** 2));
  // neighbor average
  const a = pts[(i - 2 + n) % n], b = pts[(i + 2) % n];
  const mx = (a[0] + b[0]) / 2, my = (a[1] + b[1]) / 2;
  const k = Math.min(1, gss * 3);
  return [p[0] + (mx - p[0]) * k * 0.5, p[1] + (my - p[1]) * k * 0.5] as [number, number];
});
const t2: Track = { ...track, centerline: sm };
const idx = makeTrackIndex(t2);
const { car } = spawn(idx);
let hint = -1, prevFrac: number | null = null, prog = 0, time = 0;
for (let step = 0; step < 9000; step++) {
  const loc = locate(idx, car.x, car.y, hint);
  hint = loc.bi;
  if (prevFrac == null) prevFrac = loc.frac;
  let d = loc.frac - prevFrac;
  if (d > 0.5) d -= 1; else if (d < -0.5) d += 1;
  prog += d; prevFrac = loc.frac;
  if (loc.dist > loc.hw) { console.log(`CRASH prog=${prog.toFixed(3)} t=${time.toFixed(1)}`); break; }
  if (prog >= 1) { console.log(`LAP t=${time.toFixed(1)}`); break; }
  const ctl: Control = forwardGenome(g, observe(idx, car, loc));
  stepCar(car, ctl, phys);
  time += DT;
}
