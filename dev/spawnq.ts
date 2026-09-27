import { readFileSync } from 'node:fs';
import { makeTrackIndex, spawnAt, locate, stepCar, DT, sampleSpawnFrac, mulberry32 } from '../src/sim.ts';
import { pointAt } from '../src/track.ts';
import { physicsFor, blankTeam } from '../src/teams.ts';
import type { Track } from '../src/track.ts';
import type { Control } from '../src/sim.ts';
const phys = physicsFor({ ...blankTeam('t') });
const wrap = (a: number) => Math.atan2(Math.sin(a), Math.cos(a));
const track = JSON.parse(readFileSync('/home/danel/Projects/racing_sim/assets/tracks/Portimao GP.json', 'utf8')) as Track;
const idx = makeTrackIndex(track);
const leadFrac = (phys.vMax * 0.75 * 1.5) / idx.total;
const rand = mulberry32(11);
let surv = 0, insta = 0;
for (let i = 0; i < 40; i++) {
  const fr = sampleSpawnFrac(idx, rand);
  const sp = (((fr - leadFrac) % 1) + 1) % 1;
  const { car } = spawnAt(idx, sp, phys.vMax * 0.75);
  let hint = -1, prevFrac: number | null = null, prog = 0, time = 0, res = '';
  for (let step = 0; step < 60 * 12; step++) {
    const loc = locate(idx, car.x, car.y, hint);
    hint = loc.bi;
    if (prevFrac == null) prevFrac = loc.frac;
    let d = loc.frac - prevFrac;
    if (d > 0.5) d -= 1; else if (d < -0.5) d += 1;
    prog += d; prevFrac = loc.frac;
    if (loc.dist > loc.hw) { res = 'crash'; break; }
    if (prog >= 0.06) { res = 'survived'; break; }
    const tp = pointAt(idx.track.centerline, true, loc.frac + 0.008);
    const err = wrap(Math.atan2(tp[1] - car.y, tp[0] - car.x) - car.heading);
    const steer = Math.max(-1, Math.min(1, err * 1.5));
    const v = Math.hypot(car.vx, car.vy);
    const ctl: Control = [v < 25 ? 1 : 0, v > 40 ? 0.9 : 0, steer];
    stepCar(car, ctl, phys);
    time += DT;
  }
  if (res === 'survived') surv++;
  if (res === 'crash' && time < 1.0) insta++;
}
console.log(`lead-back approach spawns: survived=${surv}/40 instaDeath=${insta}/40`);
