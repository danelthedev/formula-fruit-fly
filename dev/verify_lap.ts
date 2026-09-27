import { readFileSync } from 'node:fs';
import { makeTrackIndex, spawn, locate, observe, stepCar, DT } from '../src/sim.ts';
import { forwardGenome } from '../src/nn.ts';
import { physicsFor, blankTeam } from '../src/teams.ts';
import type { Track } from '../src/track.ts';
import type { Control } from '../src/sim.ts';
const turnSpec = Number(process.argv[4] || 5);
const phys = physicsFor({ ...blankTeam('t'), turningAbility: turnSpec });
const trackName = process.argv[2];
const laps = Number(process.argv[3] ?? 3);
const track = JSON.parse(readFileSync(`/home/danel/Projects/racing_sim/assets/tracks/${trackName}`, 'utf8')) as Track;
const idx = makeTrackIndex(track);
const saved = JSON.parse(readFileSync('/tmp/headless_pop.json', 'utf8'));
const g = new Float32Array(saved.pop[0]);
for (let lap = 0; lap < laps; lap++) {
  const { car } = spawn(idx);
  let hint = -1, prevFrac: number | null = null, prog = 0, time = 0;
  let res = '';
  for (let step = 0; step < 60 * 150; step++) {
    const loc = locate(idx, car.x, car.y, hint);
    hint = loc.bi;
    if (prevFrac == null) prevFrac = loc.frac;
    let d = loc.frac - prevFrac;
    if (d > 0.5) d -= 1; else if (d < -0.5) d += 1;
    prog += d; prevFrac = loc.frac;
    if (loc.dist > loc.hw) { res = `crash@${prog.toFixed(3)}`; break; }
    if (prog >= 1) { res = `LAP t=${time.toFixed(1)}`; break; }
    const ctl: Control = forwardGenome(g, observe(idx, car, loc));
    stepCar(car, ctl, phys);
    time += DT;
  }
  console.log(`lap attempt ${lap + 1}: ${res || 'timeout'}`);
}
