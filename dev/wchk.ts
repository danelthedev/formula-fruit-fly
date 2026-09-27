import { readFileSync } from 'node:fs';
import { makeTrackIndex } from '../src/sim.ts';
import { widthAt } from '../src/track.ts';
import type { Track } from '../src/track.ts';
const track = JSON.parse(readFileSync('/home/danel/Projects/racing_sim/assets/tracks/Portimao GP.json', 'utf8')) as Track;
console.log('base width:', track.width, 'nGates:', track.gates.length);
for (const f of [0.83, 0.84, 0.85, 0.855, 0.86, 0.87, 0.88]) {
  console.log(`widthAt(${f}) = ${widthAt(track, f).toFixed(1)}`);
}
const idx = makeTrackIndex(track);
console.log('idx.track gateWidths around apex:', idx.track.gateWidths.slice(20, 26));
