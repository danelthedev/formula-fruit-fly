import { readFileSync } from 'node:fs';
import { makeTrackIndex, locate, observe, stepCar, DT } from '../src/sim.ts';
import { forwardGenome } from '../src/nn.ts';
import { physicsFor, blankTeam } from '../src/teams.ts';
import type { Track } from '../src/track.ts';
import type { Control } from '../src/sim.ts';
const phys = physicsFor({ ...blankTeam('t') });
const track = JSON.parse(readFileSync('/home/danel/Projects/racing_sim/assets/tracks/Monaco GP.json', 'utf8')) as Track;
const idx = makeTrackIndex(track);
const saved = JSON.parse(readFileSync('/tmp/headless_pop.json', 'utf8'));
const g = new Float32Array(saved.pop[0]);
const pts = track.centerline as [number,number][];
const n = pts.length;
const i = Math.floor(0.0815 * n) % n;
const a = pts[i], b = pts[(i+1) % n];
const h = Math.atan2(b[1]-a[1], b[0]-a[0]);
for (const [dlat, dv] of [[0,0],[2,0],[-2,0],[0,10],[0,-10],[1,5]] as const) {
  const nx = -(b[1]-a[1]), ny = (b[0]-a[0]);
  const L = Math.hypot(nx, ny) || 1;
  const car = { x: a[0] + nx/L*dlat, y: a[1] + ny/L*dlat, heading: h, vx: Math.cos(h)*(0+dv), vy: Math.sin(h)*(0+dv) };
  let hint = -1, prevFrac: number | null = null, prog = 0, time = 0;
  let res = '';
  for (let step = 0; step < 60*90; step++) {
    const loc = locate(idx, car.x, car.y, hint);
    hint = loc.bi;
    if (prevFrac == null) prevFrac = loc.frac;
    let d = loc.frac - prevFrac;
    if (d > 0.5) d -= 1; else if (d < -0.5) d += 1;
    prog += d; prevFrac = loc.frac;
    if (loc.dist > loc.hw) { res = `crash@${prog.toFixed(3)}`; break; }
    if (prog >= 1) { res = `LAP t=${time.toFixed(1)}`; break; }
    const ctl: Control = forwardGenome(g, observe(idx, car, loc));
    stepCar(car, ctl, phys);
    time += DT;
  }
  console.log(`dlat=${dlat} dv=${dv}: ${res || 'timeout'}`);
}
