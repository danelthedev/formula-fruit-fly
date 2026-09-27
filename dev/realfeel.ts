import { readFileSync } from 'node:fs';
import { makeTrackIndex, locate, runEpisode } from '../src/sim.ts';
import { pointAt } from '../src/track.ts';
import { physicsFor, blankTeam } from '../src/teams.ts';

// Brake-aware pursuit: target speed from lookahead curvature (v=sqrt(latA*R)),
// full throttle below, brake above. Validates geometric passability.
const trackName = process.argv[2];
const turnSpec = Number(process.argv[3] || 5);
const phys = physicsFor({ ...blankTeam('t'), turningAbility: turnSpec });
const track = JSON.parse(readFileSync(`/home/danel/Projects/racing_sim/assets/tracks/${trackName}`, 'utf8'));
const idx = makeTrackIndex(track);
const wrap = (a: number) => Math.atan2(Math.sin(a), Math.cos(a));
const radiusAt = (frac: number): number => {
  const n = idx.n, c = idx.track.centerline;
  const i = ((Math.floor(frac * n) % n) + n) % n;
  const a = c[(i - 4 + n) % n], b = c[i], d = c[(i + 4) % n];
  const a1 = Math.atan2(b[1] - a[1], b[0] - a[0]), a2 = Math.atan2(d[1] - b[1], d[0] - b[0]);
  let da = Math.abs(a2 - a1); if (da > Math.PI) da = 2 * Math.PI - da;
  const ds = (Math.hypot(b[0] - a[0], b[1] - a[1]) + Math.hypot(d[0] - b[0], d[1] - b[1])) / 2;
  return da < 1e-6 ? 1e6 : Math.min(1e6, ds / da);
};
const r = await runEpisode(idx, phys, (_obs, car) => {
  const loc = locate(idx, car.x, car.y, -1);
  const v = Math.hypot(car.vx, car.vy);
  const tp = pointAt(idx.track.centerline, true, loc.frac + 0.012 + v * 0.00008);
  const err = wrap(Math.atan2(tp[1] - car.y, tp[0] - car.x) - car.heading);
  let vt = Infinity;
  // driver margin: ride at 60% of the grip limit, not 100%
  for (let k = 1; k <= 12; k++) vt = Math.min(vt, Math.sqrt(phys.latA * radiusAt(loc.frac + k * 0.008) * 0.6));
  vt = Math.min(vt, phys.vMax);
  const brk = v > vt * 1.02 ? 1 : 0; // hard on the brakes whenever over corner speed
  const thr = brk > 0 ? 0 : v < vt * 0.9 ? 1 : 0.2;
  return [thr, brk, Math.max(-1, Math.min(1, err * 3))];
}, { laps: 1, maxTime: 150 });
console.log(`${trackName} spec${turnSpec}: ${r.done} t=${r.time.toFixed(1)}s prog=${r.progress.toFixed(2)}`);
