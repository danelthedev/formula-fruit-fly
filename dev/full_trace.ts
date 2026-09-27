import { readFileSync } from 'node:fs';
import { makeTrackIndex, spawn, locate, observe, stepCar, DT } from '../src/sim.ts';
import { forwardGenome } from '../src/nn.ts';
import { physicsFor, blankTeam } from '../src/teams.ts';
import type { Track } from '../src/track.ts';
import type { Control } from '../src/sim.ts';
const phys = physicsFor({ ...blankTeam('t') });
const track = JSON.parse(readFileSync('/home/danel/Projects/racing_sim/assets/tracks/Portimao GP.json', 'utf8')) as Track;
const idx = makeTrackIndex(track);
const saved = JSON.parse(readFileSync('/tmp/headless_pop.json', 'utf8'));
const g = new Float32Array(saved.pop[0]);
const { car } = spawn(idx);
let hint = -1, prevFrac: number | null = null, prog = 0, time = 0, lastP = -1;
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
  const v = Math.hypot(car.vx, car.vy);
  if (prog - lastP > 0.05) { console.log(`prog=${prog.toFixed(3)} lat=${loc.dist.toFixed(1)} v=${v.toFixed(0)} thr=${ctl[0].toFixed(2)} brk=${ctl[1].toFixed(2)} str=${ctl[2].toFixed(2)}`); lastP = prog; }
  stepCar(car, ctl, phys);
  time += DT;
}
