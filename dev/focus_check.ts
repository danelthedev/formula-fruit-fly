import { readFileSync } from 'node:fs';
import { makeTrackIndex, spawnAt, locate, observe, stepCar, DT } from '../src/sim.ts';
import { forwardGenome } from '../src/nn.ts';
import { physicsFor, blankTeam } from '../src/teams.ts';
import type { Track } from '../src/track.ts';
import type { Control } from '../src/sim.ts';
const phys = physicsFor({ ...blankTeam('t') });
const track = JSON.parse(readFileSync('/home/danel/Projects/racing_sim/assets/tracks/Portimao GP.json', 'utf8')) as Track;
const idx = makeTrackIndex(track);
const saved = JSON.parse(readFileSync('/tmp/headless_pop.json', 'utf8'));
const g = new Float32Array(saved.pop[0]);
// spawn at hairpin approach (0.72) at speed, see if it takes the hairpin
const { car } = spawnAt(idx, 0.72, phys.vMax * 0.6);
let hint = -1, prevFrac: number | null = null, prog = 0, time = 0;
for (let step = 0; step < 3000; step++) {
  const loc = locate(idx, car.x, car.y, hint);
  hint = loc.bi;
  if (prevFrac == null) prevFrac = loc.frac;
  let d = loc.frac - prevFrac;
  if (d > 0.5) d -= 1; else if (d < -0.5) d += 1;
  prog += d; prevFrac = loc.frac;
  if (loc.dist > loc.hw) { console.log(`CRASH prog=${prog.toFixed(3)} t=${time.toFixed(1)}`); break; }
  if (prog >= 0.25) { console.log(`SURVIVED past hairpin t=${time.toFixed(1)}`); break; }
  const ctl: Control = forwardGenome(g, observe(idx, car, loc));
  stepCar(car, ctl, phys);
  time += DT;
}
