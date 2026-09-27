import { readFileSync } from 'node:fs';
import { makeTrackIndex, spawn, locate, observe, stepCar, DT } from '../src/sim.ts';
import { forwardGenome } from '../src/nn.ts';
import { physicsFor, blankTeam } from '../src/teams.ts';
import type { Track } from '../src/track.ts';
import type { Control } from '../src/sim.ts';

const phys = physicsFor({ ...blankTeam('t') });
const track = JSON.parse(readFileSync('/home/danel/Projects/racing_sim/assets/tracks/Spa GP.json', 'utf8')) as Track;
const idx = makeTrackIndex(track);
const g = new Float32Array((JSON.parse(readFileSync('/home/danel/Projects/racing_sim/weights-scuteria.json', 'utf8')).weights as number[]));

const { car } = spawn(idx);
let hint = -1, prevFrac: number | null = null, prog = 0, time = 0;
let prevStr = 0;
for (let step = 0; step < 1200; step++) {
  const loc = locate(idx, car.x, car.y, hint);
  hint = loc.bi;
  if (prevFrac == null) prevFrac = loc.frac;
  let d = loc.frac - prevFrac;
  if (d > 0.5) d -= 1; else if (d < -0.5) d += 1;
  prog += d; prevFrac = loc.frac;
  if (loc.dist > loc.hw) { console.log(`CRASH prog=${prog.toFixed(3)} t=${time.toFixed(1)}`); break; }
  const obs = observe(idx, car, loc);
  const ctl: Control = forwardGenome(g, obs);
  const v = Math.hypot(car.vx, car.vy);
  if (prog > 0.60) {
    console.log(`prog=${prog.toFixed(3)} lat=${loc.dist.toFixed(1)} v=${v.toFixed(0)} thr=${ctl[0].toFixed(2)} brk=${ctl[1].toFixed(2)} str=${ctl[2].toFixed(2)} dstr=${(ctl[2] - prevStr).toFixed(2)} fwd=${obs[7].toFixed(2)}`);
  }
  prevStr = ctl[2];
  stepCar(car, ctl, phys);
  time += DT;
}
