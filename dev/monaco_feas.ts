import { readFileSync } from 'node:fs';
import { makeTrackIndex } from '../src/sim.ts';
import { widthAt } from '../src/track.ts';
import { physicsFor, blankTeam } from '../src/teams.ts';
import type { Track } from '../src/track.ts';
const track = JSON.parse(readFileSync('/home/danel/Projects/racing_sim/assets/tracks/Monaco GP.json', 'utf8')) as Track;
const idx = makeTrackIndex(track);
const pts = track.centerline as [number,number][];
const n = pts.length;
// min turn radius per spec with WB=6: R = 6/tan(0.15+0.035*spec)
console.log('spec: minTurnR (WB=6)');
for (const s of [1,2,3,4,5,6,7,8,9,10]) {
  const sm = 0.15 + 0.035 * s;
  console.log(`  turning ${s}: steerMax=${sm.toFixed(3)} minR=${(6 / Math.tan(sm)).toFixed(1)}px`);
}
// corner radii (R=±8 triplets) + width profile; flag sub-spec5-minR spots
console.log('\nMonaco: corners tighter than 40px:');
for (let i = 0; i < n; i += 2) {
  const R = 8;
  const a = pts[(i - R + n) % n], b = pts[i], c = pts[(i + R) % n];
  const ab = Math.hypot(b[0]-a[0], b[1]-a[1]), bc = Math.hypot(c[0]-b[0], c[1]-b[1]), ca = Math.hypot(a[0]-c[0], a[1]-c[1]);
  const area = Math.abs((b[0]-a[0])*(c[1]-a[1]) - (c[0]-a[0])*(b[1]-a[1])) / 2;
  const r = area < 1e-9 ? Infinity : (ab*bc*ca)/(4*area);
  if (r < 60) console.log(`  frac=${(i/n).toFixed(3)} r=${r.toFixed(0)} width=${widthAt(track, i/n).toFixed(1)}`);
}
console.log(`\ntrack width=${track.width} closed=${track.closed} gates=${track.gates.length} startS=${track.startS} len=${Math.round(idx.total)}`);
