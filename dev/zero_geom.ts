import { readFileSync } from 'node:fs';
import type { Track } from '../src/track.ts';
const track = JSON.parse(readFileSync('/home/danel/Projects/racing_sim/assets/tracks/Portimao GP.json', 'utf8')) as Track;
const pts = track.centerline as [number,number][];
const n = pts.length;
for (let k = 0; k <= 20; k++) {
  const f = 0.96 + k * 0.007;
  const ff = f % 1;
  const i = Math.floor(ff * n) % n;
  const a = pts[i], b = pts[(i+1) % n];
  const h = Math.atan2(b[1]-a[1], b[0]-a[0]) * 180 / Math.PI;
  console.log(`frac=${ff.toFixed(3)} x=${a[0].toFixed(0)} y=${a[1].toFixed(0)} hdg=${h.toFixed(0)}`);
}
