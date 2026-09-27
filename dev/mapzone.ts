import { readFileSync } from 'node:fs';
import type { Track } from '../src/track.ts';
const track = JSON.parse(readFileSync('/home/danel/Projects/racing_sim/assets/tracks/Portimao GP.json', 'utf8')) as Track;
const pts = track.centerline as [number,number][];
const n = pts.length;
function radiusAt(i: number, R: number): number {
  const a = pts[(i - R + n) % n], b = pts[i], c = pts[(i + R) % n];
  const ab = Math.hypot(b[0]-a[0], b[1]-a[1]), bc = Math.hypot(c[0]-b[0], c[1]-b[1]), ca = Math.hypot(a[0]-c[0], a[1]-c[1]);
  const area = Math.abs((b[0]-a[0])*(c[1]-a[1]) - (c[0]-a[0])*(b[1]-a[1])) / 2;
  return area < 1e-9 ? Infinity : (ab*bc*ca)/(4*area);
}
for (let k = 0; k <= 20; k++) {
  const f = 0.84 + k * 0.004;
  const i = Math.floor(f * n) % n;
  const a = pts[i], b = pts[(i+1) % n];
  const h = Math.atan2(b[1]-a[1], b[0]-a[0]) * 180 / Math.PI;
  console.log(`frac=${f.toFixed(3)} x=${a[0].toFixed(0)} y=${a[1].toFixed(0)} hdg=${h.toFixed(0)} r=${radiusAt(i, 8).toFixed(0)}`);
}
