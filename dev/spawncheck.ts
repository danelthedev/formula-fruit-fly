import { readFileSync } from 'node:fs';
import { makeTrackIndex, spawnAt, locate, observe, stepCar, DT, sampleSpawnFrac, mulberry32 } from '../src/sim.ts';
import { pointAt } from '../src/track.ts';
import { physicsFor, blankTeam } from '../src/teams.ts';
import type { Track } from '../src/track.ts';
import type { Control } from '../src/sim.ts';

const phys = physicsFor({ ...blankTeam('t') });
const wrap = (a: number) => Math.atan2(Math.sin(a), Math.cos(a));

function pursuit(idx: ReturnType<typeof makeTrackIndex>, locFrac: number, car: { x: number; y: number; heading: number; vx: number; vy: number }): Control {
  const tp = pointAt(idx.track.centerline, true, locFrac + 0.01);
  const err = wrap(Math.atan2(tp[1] - car.y, tp[0] - car.x) - car.heading);
  const steer = Math.max(-1, Math.min(1, err * 1.5));
  const v = Math.hypot(car.vx, car.vy);
  return [v < 200 ? 1 : 0, v > 215 ? 0.9 : 0, steer];
}

for (const tn of ['Spa GP.json', 'Bahrain GP.json', 'Portimao GP.json', 'Monaco GP.json']) {
  const track = JSON.parse(readFileSync(`/home/danel/Projects/racing_sim/assets/tracks/${tn}`, 'utf8')) as Track;
  const idx = makeTrackIndex(track);
  const rand = mulberry32(42);
  let instaDeath = 0, ok = 0;
  const N = 40;
  for (let i = 0; i < N; i++) {
    let fr = sampleSpawnFrac(idx, rand);
    // lead back ~1.5s of travel at spawn speed so the car approaches the corner
    const lead = (phys.vMax * 0.75 * 1.5) / idx.total;
    fr = (((fr - lead) % 1) + 1) % 1;
    const { car } = spawnAt(idx, fr, phys.vMax * 0.75);
    let hint = -1, prevFrac: number | null = null, prog = 0, time = 0;
    let res = '';
    for (let step = 0; step < 60 * 30; step++) {
      const loc = locate(idx, car.x, car.y, hint);
      hint = loc.bi;
      if (prevFrac == null) prevFrac = loc.frac;
      let d = loc.frac - prevFrac;
      if (d > 0.5) d -= 1; else if (d < -0.5) d += 1;
      prog += d; prevFrac = loc.frac;
      if (loc.dist > loc.hw) { res = 'crash'; break; }
      if (prog >= 0.15) { res = 'survived'; break; }
      const obs = observe(idx, car, loc);
      void obs;
      stepCar(car, pursuit(idx, loc.frac, car), phys);
      time += DT;
    }
    if (!res) res = 'timeout';
    if (res === 'crash' && time < 1.0) instaDeath++;
    if (res === 'survived') ok++;
  }
  console.log(`${tn}: pursuit from curvature-spawns: survived=${ok}/${N} instaDeath(<1s)=${instaDeath}/${N}`);
}
