import { readFileSync } from 'node:fs';
import type { Track } from '../src/track.ts';
const track = JSON.parse(readFileSync('/home/danel/Projects/racing_sim/assets/tracks/Portimao GP.json', 'utf8')) as Track;
const pts = track.centerline as [number,number][];
const n = pts.length;
console.log('n=', n, 'total pts spacing ~', (2881/n).toFixed(1));
for (let k = 0; k <= 20; k++) {
  const f = 0.66 + k * 0.002;
  const i = Math.floor(f * n) % n;
  const a = pts[i], b = pts[(i+1) % n];
  const h = Math.atan2(b[1]-a[1], b[0]-a[0]) * 180 / Math.PI;
  const c = pts[(i+2) % n];
  const h2 = Math.atan2(c[1]-b[1], c[0]-b[0]) * 180 / Math.PI;
  let dh = h2 - h;
  while (dh > 180) dh -= 360; while (dh < -180) dh += 360;
  console.log(`frac=${f.toFixed(3)} x=${a[0].toFixed(0)} y=${a[1].toFixed(0)} hdg=${h.toFixed(1)} dhdg=${dh.toFixed(1)}`);
}
