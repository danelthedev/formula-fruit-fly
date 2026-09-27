import { readFileSync } from 'node:fs';
import { makeTrackIndex, spawnAt, locate, stepCar, DT } from '../src/sim.ts';
import { pointAt } from '../src/track.ts';
import { physicsFor, blankTeam } from '../src/teams.ts';
import type { Track } from '../src/track.ts';
import type { Control } from '../src/sim.ts';
const phys = physicsFor({ ...blankTeam('t') });
const wrap = (a: number) => Math.atan2(Math.sin(a), Math.cos(a));
const track = JSON.parse(readFileSync('/home/danel/Projects/racing_sim/assets/tracks/Portimao GP.json', 'utf8')) as Track;
const idx = makeTrackIndex(track);
const { car } = spawnAt(idx, 0.60, 30);
let hint = -1, prevFrac: number | null = null, prog = 0, time = 0;
const la = 0.004;
for (let step = 0; step < 4000; step++) {
  const loc = locate(idx, car.x, car.y, hint);
  hint = loc.bi;
  if (prevFrac == null) prevFrac = loc.frac;
  let d = loc.frac - prevFrac;
  if (d > 0.5) d -= 1; else if (d < -0.5) d += 1;
  prog += d; prevFrac = loc.frac;
  if (loc.dist > loc.hw) { console.log(`CRASH prog=${prog.toFixed(4)} bi=${loc.bi} dist=${loc.dist.toFixed(1)}`); break; }
  const tp = pointAt(idx.track.centerline, true, loc.frac + la);
  const err = wrap(Math.atan2(tp[1] - car.y, tp[0] - car.x) - car.heading);
  const steer = Math.max(-1, Math.min(1, err * 1.5));
  const v = Math.hypot(car.vx, car.vy);
  if (prog > 0.66) console.log(`prog=${prog.toFixed(4)} bi=${loc.bi} lat=${loc.dist.toFixed(1)} v=${v.toFixed(0)} str=${steer.toFixed(2)} err=${err.toFixed(2)} hdg=${(car.heading*180/Math.PI).toFixed(0)}`);
  const ctl: Control = [v < 15 ? 1 : 0, v > 20 ? 0.9 : 0, steer];
  stepCar(car, ctl, phys);
  time += DT;
}
