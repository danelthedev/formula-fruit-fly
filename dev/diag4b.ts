import { readFileSync } from 'node:fs';
import { makeTrackIndex, spawn, locate, observe, stepCar, DT } from '../src/sim.ts';
import { forwardGenome } from '../src/nn.ts';
import { physicsFor, blankTeam } from '../src/teams.ts';
import type { Track } from '../src/track.ts';
import type { Control } from '../src/sim.ts';

const phys = physicsFor({ ...blankTeam('t') });
const loadGenome = (p: string) => new Float32Array((JSON.parse(readFileSync(p, 'utf8')).weights as number[]));

function radiusAt(idx: ReturnType<typeof makeTrackIndex>, frac: number): number {
  const pts = idx.track.centerline, m = pts.length, R = 8;
  const i = ((Math.floor(frac * m) % m) + m) % m;
  const a = pts[(i - R + m) % m], b = pts[i], c = pts[(i + R) % m];
  const ab = Math.hypot(b[0] - a[0], b[1] - a[1]);
  const bc = Math.hypot(c[0] - b[0], c[1] - b[1]);
  const ca = Math.hypot(a[0] - c[0], a[1] - c[1]);
  const area = Math.abs((b[0] - a[0]) * (c[1] - a[1]) - (c[0] - a[0]) * (b[1] - a[1])) / 2;
  return area < 1e-9 ? Infinity : (ab * bc * ca) / (4 * area);
}

for (const s of [1, 5, 10]) {
  console.log(`spec${s} minTurnR=${(6 / Math.tan(0.15 + 0.035 * s)).toFixed(0)}px`);
}

const genomes: [string, Float32Array][] = [
  ['scuteria', loadGenome('/home/danel/Projects/racing_sim/weights-scuteria.json')],
  ['bingbong', loadGenome('/home/danel/Projects/racing_sim/weights-bingbong.json')],
];
for (const tn of ['Spa GP.json', 'Bahrain GP.json', 'Portimao GP.json', 'Monaco GP.json']) {
  const track = JSON.parse(readFileSync(`/home/danel/Projects/racing_sim/assets/tracks/${tn}`, 'utf8')) as Track;
  const idx = makeTrackIndex(track);
  console.log(`\n===== ${tn} (hw=${track.width / 2}) =====`);
  for (const [name, g] of genomes) {
    for (let run = 0; run < 3; run++) {
      const { car } = spawn(idx);
      let hint = -1, prevFrac: number | null = null, prog = 0, time = 0, steps = 0;
      const vhist: number[] = [];
      let res = '';
      for (;;) {
        const loc = locate(idx, car.x, car.y, hint);
        hint = loc.bi;
        if (prevFrac == null) prevFrac = loc.frac;
        let d = loc.frac - prevFrac;
        if (d > 0.5) d -= 1; else if (d < -0.5) d += 1;
        prog += d; prevFrac = loc.frac;
        if (loc.dist > loc.hw) { res = 'crash'; break; }
        if (prog >= 1) { res = 'LAP'; break; }
        if (time >= 90) { res = 'timeout'; break; }
        const obs = observe(idx, car, loc);
        const ctl: Control = forwardGenome(g, obs);
        if (steps % 48 === 0) vhist.push(Math.hypot(car.vx, car.vy));
        stepCar(car, ctl, phys);
        time += DT;
        steps++;
      }
      const endV = Math.hypot(car.vx, car.vy);
      const r = radiusAt(idx, prog);
      console.log(`  ${name}: ${res} prog=${prog.toFixed(3)} t=${time.toFixed(1)} endV=${Math.round(endV)} cornerR=${r === Infinity ? 'inf' : r.toFixed(0)}`);
    }
  }
}
