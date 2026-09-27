import { readFileSync } from 'node:fs';
import type { Track } from '../src/track.ts';
const track = JSON.parse(readFileSync('/home/danel/Projects/racing_sim/assets/tracks/Portimao GP.json', 'utf8')) as Track;
const pts = track.centerline as [number,number][];
const n = pts.length;
// print points from frac 0.62 to 0.74 with heading direction
for (let k = 0; k <= 24; k++) {
  const f = 0.62 + k * 0.005;
  const i = Math.floor(f * n) % n;
  const a = pts[i], b = pts[(i+3) % n];
  const h = Math.atan2(b[1]-a[1], b[0]-a[0]) * 180 / Math.PI;
  console.log(`frac=${f.toFixed(3)} x=${a[0].toFixed(0)} y=${a[1].toFixed(0)} hdg=${h.toFixed(0)}`);
}
