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
function run(brkZone: [number, number] | null): string {
  const { car } = spawn(idx);
  let hint = -1, prevFrac: number | null = null, prog = 0, time = 0;
  for (let step = 0; step < 60*60; step++) {
    const loc = locate(idx, car.x, car.y, hint);
    hint = loc.bi;
    if (prevFrac == null) prevFrac = loc.frac;
    let d = loc.frac - prevFrac;
    if (d > 0.5) d -= 1; else if (d < -0.5) d += 1;
    prog += d; prevFrac = loc.frac;
    if (loc.dist > loc.hw) return `crash@${prog.toFixed(3)} t=${time.toFixed(1)}`;
    if (prog >= 1) return `LAP t=${time.toFixed(1)}`;
    const base: Control = forwardGenome(g, observe(idx, car, loc));
    const ctl: Control = (brkZone && prog >= brkZone[0] && prog <= brkZone[1]) ? [0, 0.9, base[2]] : base;
    stepCar(car, ctl, phys);
    time += DT;
  }
  return 'timeout';
}
console.log('plain:', run(null));
for (const z of [[0.60, 0.70], [0.62, 0.69], [0.64, 0.70], [0.60, 0.68]] as [number, number][]) {
  console.log(`brake [${z}]:`, run(z));
}
