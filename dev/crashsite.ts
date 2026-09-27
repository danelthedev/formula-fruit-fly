import { readFileSync } from 'node:fs';
import { makeTrackIndex, spawn, locate, stepCar, DT } from '../src/sim.ts';
import { pointAt, widthAt } from '../src/track.ts';
import { physicsFor, blankTeam } from '../src/teams.ts';
import type { Track } from '../src/track.ts';
import type { Control } from '../src/sim.ts';

const phys = physicsFor({ ...blankTeam('t') });
const wrap = (a: number) => Math.atan2(Math.sin(a), Math.cos(a));

function radiusAt(pts: [number, number][], frac: number, R = 8): number {
  const m = pts.length;
  const i = ((Math.floor(frac * m) % m) + m) % m;
  const a = pts[(i - R + m) % m], b = pts[i], c = pts[(i + R) % m];
  const ab = Math.hypot(b[0] - a[0], b[1] - a[1]);
  const bc = Math.hypot(c[0] - b[0], c[1] - b[1]);
  const ca = Math.hypot(a[0] - c[0], a[1] - c[1]);
  const area = Math.abs((b[0] - a[0]) * (c[1] - a[1]) - (c[0] - a[0]) * (b[1] - a[1])) / 2;
  return area < 1e-9 ? Infinity : (ab * bc * ca) / (4 * area);
}

for (const [tn, cf] of [['Portimao GP.json', 0.68], ['Monaco GP.json', 0.61]] as const) {
  const track = JSON.parse(readFileSync(`/home/danel/Projects/racing_sim/assets/tracks/${tn}`, 'utf8')) as Track;
  const idx = makeTrackIndex(track);
  console.log(`===== ${tn} around frac ${cf} =====`);
  console.log(' frac | radius | width | distFromCenterAtSpawnLine');
  for (let k = -6; k <= 6; k++) {
    const f = cf + k * 0.005;
    const r = radiusAt(track.centerline, f);
    const w = widthAt(track, f);
    console.log(`  ${f.toFixed(3)} | ${r === Infinity ? 'inf' : r.toFixed(0).padStart(4)} | ${w.toFixed(1)}`);
  }
  // crawl pursuit with tiny lookahead, dump steer/lat near crash
  const { car } = spawn(idx);
  let hint = -1, prevFrac: number | null = null, prog = 0, time = 0;
  const la = 0.008;
  for (let step = 0; step < 60 * 150; step++) {
    const loc = locate(idx, car.x, car.y, hint);
    hint = loc.bi;
    if (prevFrac == null) prevFrac = loc.frac;
    let d = loc.frac - prevFrac;
    if (d > 0.5) d -= 1; else if (d < -0.5) d += 1;
    prog += d; prevFrac = loc.frac;
    if (loc.dist > loc.hw) {
      console.log(`crash@${prog.toFixed(3)} lat=${loc.dist.toFixed(1)} hw=${loc.hw.toFixed(1)}`);
      break;
    }
    if (prog >= 1) { console.log('LAP'); break; }
    const tp = pointAt(idx.track.centerline, true, loc.frac + la);
    const err = wrap(Math.atan2(tp[1] - car.y, tp[0] - car.x) - car.heading);
    const steer = Math.max(-1, Math.min(1, err * 1.5));
    const v = Math.hypot(car.vx, car.vy);
    const ctl: Control = [v < 25 ? 1 : 0, v > 40 ? 0.9 : 0, steer];
    if (prog > cf - 0.03) {
      console.log(`  prog=${prog.toFixed(3)} lat=${loc.dist.toFixed(1)} v=${v.toFixed(0)} steer=${steer.toFixed(2)} err=${err.toFixed(2)}`);
    }
    stepCar(car, ctl, phys);
    time += DT;
  }
}
