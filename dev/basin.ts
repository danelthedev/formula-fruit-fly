import { readFileSync } from 'node:fs';
import { makeTrackIndex, locate, observe, stepCar, DT } from '../src/sim.ts';
import { forwardGenome } from '../src/nn.ts';
import { physicsFor, blankTeam } from '../src/teams.ts';
import type { Track } from '../src/track.ts';
import type { Control } from '../src/sim.ts';
const phys = physicsFor({ ...blankTeam('t') });
const track = JSON.parse(readFileSync('/home/danel/Projects/racing_sim/assets/tracks/Portimao GP.json', 'utf8')) as Track;
const idx = makeTrackIndex(track);
const saved = JSON.parse(readFileSync('/tmp/headless_pop.json', 'utf8'));
const g = new Float32Array(saved.pop[0]);
// hand-place car near hairpin entry with varied lat/speed/heading, run genome, see max prog
const pts = track.centerline as [number,number][];
const n = pts.length;
function stateAt(frac: number, lat: number, v: number) {
  const i = Math.floor(frac * n) % n;
  const a = pts[i], b = pts[(i+1) % n];
  const h = Math.atan2(b[1]-a[1], b[0]-a[0]);
  const nx = -(b[1]-a[1]), ny = (b[0]-a[0]);
  const L = Math.hypot(nx, ny) || 1;
  return { x: a[0] + nx/L*lat, y: a[1] + ny/L*lat, heading: h, vx: Math.cos(h)*v, vy: Math.sin(h)*v };
}
for (const lat of [-8, -4, 0, 4]) {
  for (const v of [40, 70]) {
    const car = stateAt(0.83, lat, v);
    let hint = -1, prevFrac: number | null = null, prog = 0, time = 0, maxP = 0;
    for (let step = 0; step < 2000; step++) {
      const loc = locate(idx, car.x, car.y, hint);
      hint = loc.bi;
      if (prevFrac == null) prevFrac = loc.frac;
      let d = loc.frac - prevFrac;
      if (d > 0.5) d -= 1; else if (d < -0.5) d += 1;
      prog += d; prevFrac = loc.frac;
      maxP = Math.max(maxP, prog);
      if (loc.dist > loc.hw || time > 20) break;
      const ctl: Control = forwardGenome(g, observe(idx, car, loc));
      stepCar(car, ctl, phys);
      time += DT;
    }
    console.log(`lat=${lat} v=${v}: maxProg=${maxP.toFixed(3)}`);
  }
}
