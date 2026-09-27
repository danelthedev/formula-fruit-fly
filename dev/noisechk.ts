import { readFileSync } from 'node:fs';
import type { Track } from '../src/track.ts';
for (const tn of ['Bahrain GP.json', 'Portimao GP.json', 'Monaco GP.json', 'Spa GP.json']) {
  const track = JSON.parse(readFileSync(`/home/danel/Projects/racing_sim/assets/tracks/${tn}`, 'utf8')) as Track;
  const pts = track.centerline as [number,number][];
  const n = pts.length;
  // heading-change noise: std of per-step dhdg in straight zones (R>300)
  let ss = 0, sn = 0;
  const vals: number[] = [];
  for (let i = 0; i < n; i++) {
    const a = pts[i], b = pts[(i+1)%n], c = pts[(i+2)%n];
    const h1 = Math.atan2(b[1]-a[1], b[0]-a[0]), h2 = Math.atan2(c[1]-b[1], c[0]-b[0]);
    let dh = (h2-h1)*180/Math.PI;
    while (dh > 180) dh -= 360; while (dh < -180) dh += 360;
    vals.push(Math.abs(dh));
    ss += dh*dh; sn++;
  }
  vals.sort((x,y) => x-y);
  const mean = vals.reduce((x,y)=>x+y,0)/vals.length;
  console.log(`${tn}: mean|dhdg|=${mean.toFixed(2)}° p90=${vals[Math.floor(vals.length*0.9)].toFixed(1)}° p99=${vals[Math.floor(vals.length*0.99)].toFixed(1)}°`);
}
