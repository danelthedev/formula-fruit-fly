import { readFileSync } from 'node:fs';
import { makeTrackIndex, spawn, locate, stepCar, DT } from '../src/sim.ts';
import { pointAt, widthAt } from '../src/track.ts';
import { physicsFor, blankTeam } from '../src/teams.ts';
import type { Track } from '../src/track.ts';
import type { Control } from '../src/sim.ts';

const phys = physicsFor({ ...blankTeam('t') });
const wrap = (a: number) => Math.atan2(Math.sin(a), Math.cos(a));

function radiusAt(pts: [number, number][], frac: number, R: number): number {
  const m = pts.length;
  const i = ((Math.floor(frac * m) % m) + m) % m;
  const a = pts[(i - R + m) % m], b = pts[i], c = pts[(i + R) % m];
  const ab = Math.hypot(b[0] - a[0], b[1] - a[1]);
  const bc = Math.hypot(c[0] - b[0], c[1] - b[1]);
  const ca = Math.hypot(a[0] - c[0], a[1] - c[1]);
  const area = Math.abs((b[0] - a[0]) * (c[1] - a[1]) - (c[0] - a[0]) * (b[1] - a[1])) / 2;
  return area < 1e-9 ? Infinity : (ab * bc * ca) / (4 * area);
}

for (const [tn, cf] of [['Portimao GP.json', 0.30], ['Monaco GP.json', 0.09]] as const) {
  const track = JSON.parse(readFileSync(`/home/danel/Projects/racing_sim/assets/tracks/${tn}`, 'utf8')) as Track;
  const idx = makeTrackIndex(track);
  console.log(`===== ${tn} around frac ${cf} =====`);
  console.log(' frac | r±8 | r±2 | width');
  for (let k = -4; k <= 8; k++) {
    const f = cf + k * 0.004;
    const r8 = radiusAt(track.centerline, f, 8);
    const r2 = radiusAt(track.centerline, f, 2);
    const w = widthAt(track, f);
    console.log(`  ${f.toFixed(3)} | ${r8 === Infinity ? 'inf' : r8.toFixed(0).padStart(4)} | ${r2 === Infinity ? 'inf' : r2.toFixed(0).padStart(4)} | ${w.toFixed(1)}`);
  }
}
