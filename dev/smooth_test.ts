import { readFileSync } from 'node:fs';
import { makeTrackIndex, spawn, locate, observe, stepCar, DT } from '../src/sim.ts';
import { forwardGenome } from '../src/nn.ts';
import { physicsFor, blankTeam } from '../src/teams.ts';
import type { Track } from '../src/track.ts';
import type { Control } from '../src/sim.ts';

const phys = physicsFor({ ...blankTeam('t') });

function rollout(track: Track, g: Float32Array, smooth: number, maxT = 120): string {
  const idx = makeTrackIndex(track);
  const { car } = spawn(idx);
  let hint = -1, prevFrac: number | null = null, prog = 0, time = 0;
  let sSteer = 0, sThr = 0, sBrk = 0, first = true;
  for (let step = 0; step < 60 * maxT; step++) {
    const loc = locate(idx, car.x, car.y, hint);
    hint = loc.bi;
    if (prevFrac == null) prevFrac = loc.frac;
    let d = loc.frac - prevFrac;
    if (d > 0.5) d -= 1; else if (d < -0.5) d += 1;
    prog += d; prevFrac = loc.frac;
    if (loc.dist > loc.hw) return `crash@${prog.toFixed(3)} t=${time.toFixed(1)}`;
    if (prog >= 1) return `LAP t=${time.toFixed(1)}`;
    const obs = observe(idx, car, loc);
    const raw: Control = forwardGenome(g, obs);
    if (first) { sSteer = raw[2]; sThr = raw[0]; sBrk = raw[1]; first = false; }
    sSteer += smooth * (raw[2] - sSteer);
    sThr += smooth * (raw[0] - sThr);
    sBrk += smooth * (raw[1] - sBrk);
    const ctl: Control = smooth >= 1 ? raw : [sThr, sBrk, sSteer];
    stepCar(car, ctl, phys);
    time += DT;
  }
  return 'timeout';
}

for (const tn of ['Spa GP.json', 'Bahrain GP.json', 'Portimao GP.json', 'Monaco GP.json']) {
  const track = JSON.parse(readFileSync(`/home/danel/Projects/racing_sim/assets/tracks/${tn}`, 'utf8')) as Track;
  for (const [name, wf] of [['scuteria', 'weights-scuteria.json'], ['bingbong', 'weights-bingbong.json']] as const) {
    const g = new Float32Array((JSON.parse(readFileSync(`/home/danel/Projects/racing_sim/${wf}`, 'utf8')).weights as number[]));
    const parts: string[] = [];
    for (const sm of [1, 0.3, 0.15]) parts.push(`sm=${sm}:${rollout(track, g, sm)}`);
    console.log(`${tn} ${name}: ${parts.join(' | ')}`);
  }
}
