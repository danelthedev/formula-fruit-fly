import { readFileSync } from 'node:fs';
import type { Track } from '../src/track.ts';
const track = JSON.parse(readFileSync('/home/danel/Projects/racing_sim/assets/tracks/Portimao GP.json', 'utf8')) as Track;
const pts = track.centerline as [number,number][];
const n = pts.length;
for (let R of [1, 2, 4]) {
  let min = Infinity, minF = 0;
  for (let i = 0; i < n; i++) {
    const f = i / n;
    if (f < 0.83 || f > 0.87) continue;
    const a = pts[(i - R + n) % n], b = pts[i], c = pts[(i + R) % n];
    const ab = Math.hypot(b[0]-a[0], b[1]-a[1]), bc = Math.hypot(c[0]-b[0], c[1]-b[1]), ca = Math.hypot(a[0]-c[0], a[1]-c[1]);
    const area = Math.abs((b[0]-a[0])*(c[1]-a[1]) - (c[0]-a[0])*(b[1]-a[1])) / 2;
    const r = area < 1e-9 ? Infinity : (ab*bc*ca)/(4*area);
    if (r < min) { min = r; minF = f; }
  }
  console.log(`R=±${R}: min radius=${min === Infinity ? 'inf' : min.toFixed(1)}px at frac=${minF.toFixed(4)}`);
}
// zero-length segments anywhere?
let zeros = 0;
for (let i = 0; i < n; i++) {
  const a = pts[i], b = pts[(i+1) % n];
  if (Math.hypot(b[0]-a[0], b[1]-a[1]) < 1e-9) zeros++;
}
console.log(`zero-length segments: ${zeros}/${n}`);
