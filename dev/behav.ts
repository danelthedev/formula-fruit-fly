import { readFileSync } from 'node:fs';
import { makeTrackIndex, spawn, locate, observe, stepCar, DT } from '../src/sim.ts';
import { forwardGenome } from '../src/nn.ts';
import { physicsFor, blankTeam } from '../src/teams.ts';
import type { Track } from '../src/track.ts';
import type { Control } from '../src/sim.ts';
const phys = physicsFor({ ...blankTeam('t') });
function stats(tn: string, g: Float32Array) {
  const track = JSON.parse(readFileSync(`/home/danel/Projects/racing_sim/assets/tracks/${tn}`, 'utf8')) as Track;
  const idx = makeTrackIndex(track);
  const { car } = spawn(idx);
  let hint = -1, prevFrac: number | null = null, prog = 0, time = 0;
  let n = 0, sStr = 0, sStr2 = 0, sBrk = 0, brkHi = 0, sThr = 0, sLat = 0, end = '';
  for (let step = 0; step < 60 * 120; step++) {
    const loc = locate(idx, car.x, car.y, hint);
    hint = loc.bi;
    if (prevFrac == null) prevFrac = loc.frac;
    let d = loc.frac - prevFrac;
    if (d > 0.5) d -= 1; else if (d < -0.5) d += 1;
    prog += d; prevFrac = loc.frac;
    if (loc.dist > loc.hw) { end = `crash@${prog.toFixed(2)}`; break; }
    if (prog >= 1) { end = `LAP t=${time.toFixed(0)}`; break; }
    const ctl: Control = forwardGenome(g, observe(idx, car, loc));
    sStr += ctl[2]; sStr2 += ctl[2] * ctl[2]; sBrk += ctl[1]; sThr += ctl[0]; sLat += Math.abs(loc.dist); n++;
    if (ctl[1] > 0.5) brkHi++;
    stepCar(car, ctl, phys);
    time += DT;
  }
  const mean = sStr / Math.max(1, n), sd = Math.sqrt(Math.max(0, sStr2 / Math.max(1, n) - mean * mean));
  console.log(`${tn}: ${end} t=${time.toFixed(0)} strMean=${mean.toFixed(2)} strSD=${sd.toFixed(2)} brkMean=${(sBrk / Math.max(1, n)).toFixed(2)} brkHi%=${(100 * brkHi / Math.max(1, n)).toFixed(1)} thrMean=${(sThr / Math.max(1, n)).toFixed(2)} latMean=${(sLat / Math.max(1, n)).toFixed(1)}`);
}
const spa = JSON.parse(readFileSync('/tmp/spa_champ.json', 'utf8'));
const por = JSON.parse(readFileSync('/tmp/headless_pop.json', 'utf8'));
stats('Spa GP.json', new Float32Array(spa.best ?? spa.pop[0]));
stats('Portimao GP.json', new Float32Array(por.pop[0]));
