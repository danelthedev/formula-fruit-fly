import { readFileSync } from 'node:fs';
import type { Track } from '../src/track.ts';
const track = JSON.parse(readFileSync('/home/danel/Projects/racing_sim/assets/tracks/Portimao GP.json', 'utf8')) as Track;
const pts = track.centerline as [number,number][];
const n = pts.length;
for (const f of [0.68, 0.81, 0.30]) {
  const i = Math.floor(f * n) % n;
  const p = pts[i];
  let best = Infinity, bj = -1;
  for (let j = 0; j < n; j++) {
    const dj = Math.min(Math.abs(j - i), n - Math.abs(j - i));
    if (dj < 30) continue; // exclude local neighborhood
    const d = Math.hypot(pts[j][0] - p[0], pts[j][1] - p[1]);
    if (d < best) { best = d; bj = j; }
  }
  console.log(`frac=${f}: nearest non-local centerline dist=${best.toFixed(1)}px at frac=${(bj/n).toFixed(3)}`);
}
