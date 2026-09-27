import { readFileSync } from 'node:fs';
import { makeTrackIndex, locate } from '../src/sim.ts';
import { widthAt } from '../src/track.ts';
import type { Track } from '../src/track.ts';
const track = JSON.parse(readFileSync('/home/danel/Projects/racing_sim/assets/tracks/Portimao GP.json', 'utf8')) as Track;
const idx = makeTrackIndex(track);
console.log('track.width:', track.width);
console.log('widthAt(0.855):', widthAt(track, 0.855));
console.log('idx.track === track:', idx.track === track);
console.log('idx.track.gateWidths[24]:', idx.track.gateWidths[24]);
// locate a point known near frac 0.855: centerline index
const pts = track.centerline as [number,number][];
const i = Math.floor(0.855 * pts.length) % pts.length;
const loc = locate(idx, pts[i][0], pts[i][1], -1);
console.log('locate at centerline[0.855]: frac=', loc.frac.toFixed(4), 'hw=', loc.hw, 'dist=', loc.dist.toFixed(2));
