import { readFileSync } from 'node:fs';
import type { Track } from '../src/track.ts';
for (const tn of ['Spa GP.json', 'Bahrain GP.json', 'Portimao GP.json', 'Monaco GP.json']) {
  const track = JSON.parse(readFileSync(`/home/danel/Projects/racing_sim/assets/tracks/${tn}`, 'utf8')) as Track;
  const pts = track.centerline as [number,number][];
  const n = pts.length;
  const bad: string[] = [];
  for (let i = 0; i < n; i += 2) {
    const R = 2;
    const a = pts[(i - R + n) % n], b = pts[i], c = pts[(i + R) % n];
    const ab = Math.hypot(b[0]-a[0], b[1]-a[1]), bc = Math.hypot(c[0]-b[0], c[1]-b[1]), ca = Math.hypot(a[0]-c[0], a[1]-c[1]);
    const area = Math.abs((b[0]-a[0])*(c[1]-a[1]) - (c[0]-a[0])*(b[1]-a[1])) / 2;
    const r = area < 1e-9 ? Infinity : (ab*bc*ca)/(4*area);
    if (r < 25) bad.push(`${(i/n).toFixed(3)}:${r.toFixed(0)}`);
  }
  console.log(`${tn}: sub-25px apexes: ${bad.length ? bad.join(' ') : 'none'}`);
}
