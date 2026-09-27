import { readFileSync } from 'node:fs';
import { makeTrackIndex, spawnAt, locate, stepCar, DT } from '../src/sim.ts';
import { pointAt } from '../src/track.ts';
import { physicsFor, blankTeam } from '../src/teams.ts';
import type { Track } from '../src/track.ts';
import type { Control } from '../src/sim.ts';
const spec = Number(process.argv[2] || 5);
const phys = physicsFor({ ...blankTeam('t'), turningAbility: spec });
const wrap = (a: number) => Math.atan2(Math.sin(a), Math.cos(a));
const track = JSON.parse(readFileSync('/home/danel/Projects/racing_sim/assets/tracks/Portimao GP.json', 'utf8')) as Track;
const idx = makeTrackIndex(track);
for (const [la, vmax] of [[0.002, 20], [0.002, 12], [0.004, 15]] as const) {
  const { car } = spawnAt(idx, 0.96, 20);
  let hint = -1, prevFrac: number | null = null, prog = 0, time = 0;
  let res = '';
  for (let step = 0; step < 3000; step++) {
    const loc = locate(idx, car.x, car.y, hint);
    hint = loc.bi;
    if (prevFrac == null) prevFrac = loc.frac;
    let d = loc.frac - prevFrac;
    if (d > 0.5) d -= 1; else if (d < -0.5) d += 1;
    prog += d; prevFrac = loc.frac;
    if (loc.dist > loc.hw) { res = `crash@+${prog.toFixed(3)}`; break; }
    if (prog >= 0.15) { res = `CLEAR t=${time.toFixed(1)}`; break; }
    const tp = pointAt(idx.track.centerline, true, loc.frac + la);
    const err = wrap(Math.atan2(tp[1] - car.y, tp[0] - car.x) - car.heading);
    const steer = Math.max(-1, Math.min(1, err * 2.5));
    const v = Math.hypot(car.vx, car.vy);
    const ctl: Control = [v < vmax ? 0.7 : 0, v > vmax + 5 ? 0.9 : 0, steer];
    stepCar(car, ctl, phys);
    time += DT;
  }
  console.log(`la=${la} vmax=${vmax}: ${res || 'timeout'}`);
}
