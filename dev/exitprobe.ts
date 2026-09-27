import { readFileSync } from 'node:fs';
import { makeTrackIndex, locate, stepCar, DT } from '../src/sim.ts';
import { physicsFor, blankTeam } from '../src/teams.ts';
import type { Track } from '../src/track.ts';
import type { Control } from '../src/sim.ts';
const phys = physicsFor({ ...blankTeam('t') });
const track = JSON.parse(readFileSync('/home/danel/Projects/racing_sim/assets/tracks/Portimao GP.json', 'utf8')) as Track;
const idx = makeTrackIndex(track);
const pts = track.centerline as [number,number][];
const n = pts.length;
// place car at frac 0.866 on centerline, tangent heading, speed 68
const i = Math.floor(0.866 * n) % n;
const a = pts[i], b = pts[(i+1) % n];
const h = Math.atan2(b[1]-a[1], b[0]-a[0]);
for (const [unwindT, thr] of [[0.2, 0.3], [0.4, 0.3], [0.6, 0.3], [0.4, 0.1], [0.4, 0.5], [0.0, 0.3]]) {
  const car = { x: a[0], y: a[1], heading: h, vx: Math.cos(h) * 68, vy: Math.sin(h) * 68 };
  let hint = -1, prevFrac: number | null = null, prog = 0, time = 0, res = '';
  for (let step = 0; step < 1200; step++) {
    const loc = locate(idx, car.x, car.y, hint);
    hint = loc.bi;
    if (prevFrac == null) prevFrac = loc.frac;
    let d = loc.frac - prevFrac;
    if (d > 0.5) d -= 1; else if (d < -0.5) d += 1;
    prog += d; prevFrac = loc.frac;
    if (loc.dist > loc.hw) { res = `crash@${prog.toFixed(3)}`; break; }
    if (prog >= 0.08) { res = `CLEAR t=${time.toFixed(1)}`; break; }
    const ctl: Control = time < unwindT ? [0.1, 0.5, -1.0] : [thr, 0, -0.1];
    stepCar(car, ctl, phys);
    time += DT;
  }
  console.log(`unwindT=${unwindT} thr=${thr}: ${res || 'timeout'}`);
}
