import { readFileSync } from 'node:fs';
import { makeTrackIndex, spawn, locate, observe, stepCar, DT } from '../src/sim.ts';
import { forwardGenome } from '../src/nn.ts';
import { physicsFor, blankTeam } from '../src/teams.ts';
import type { Track } from '../src/track.ts';
import type { Control } from '../src/sim.ts';
const phys = physicsFor({ ...blankTeam('t') });
const trackName = process.argv[2];
const track = JSON.parse(readFileSync(`/home/danel/Projects/racing_sim/assets/tracks/${trackName}`, 'utf8')) as Track;
const idx = makeTrackIndex(track);
const saved = JSON.parse(readFileSync('/tmp/headless_pop.json', 'utf8'));
let best = { gi: -1, prog: -1 };
for (let gi = 0; gi < saved.pop.length; gi++) {
  const g = new Float32Array(saved.pop[gi]);
  const { car } = spawn(idx);
  let hint = -1, prevFrac: number | null = null, prog = 0, time = 0;
  let res = '';
  for (let step = 0; step < 60*90; step++) {
    const loc = locate(idx, car.x, car.y, hint);
    hint = loc.bi;
    if (prevFrac == null) prevFrac = loc.frac;
    let d = loc.frac - prevFrac;
    if (d > 0.5) d -= 1; else if (d < -0.5) d += 1;
    prog += d; prevFrac = loc.frac;
    if (loc.dist > loc.hw) { res = 'crash'; break; }
    if (prog >= 1) { res = 'LAP'; break; }
    const ctl: Control = forwardGenome(g, observe(idx, car, loc));
    stepCar(car, ctl, phys);
    time += DT;
  }
  if (prog > best.prog) best = { gi, prog };
  console.log(`genome ${gi}: ${res} prog=${prog.toFixed(3)} t=${time.toFixed(0)}`);
}
console.log(`BEST: genome ${best.gi} prog=${best.prog.toFixed(3)}`);
