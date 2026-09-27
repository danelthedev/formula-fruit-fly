import { readFileSync } from 'node:fs';
import { makeTrackIndex, spawn, locate, observe, stepCar, DT } from '../src/sim.ts';
import { forwardGenome } from '../src/nn.ts';
import { physicsFor, blankTeam } from '../src/teams.ts';
import type { Track } from '../src/track.ts';
import type { Control } from '../src/sim.ts';

const phys = physicsFor({ ...blankTeam('t') });
const loadGenome = (p: string) => new Float32Array((JSON.parse(readFileSync(p, 'utf8')).weights as number[]));

function rollout(idx: ReturnType<typeof makeTrackIndex>, g: Float32Array, maxT = 120): { done: string; prog: number; time: number; maxV: number; crashFrac: number | null; trace: string[] } {
  const { car } = spawn(idx);
  let hint = -1, prevFrac: number | null = null, prog = 0, time = 0, maxV = 0;
  const trace: string[] = [];
  let steps = 0;
  for (;;) {
    const loc = locate(idx, car.x, car.y, hint);
    hint = loc.bi;
    if (prevFrac == null) prevFrac = loc.frac;
    let d = loc.frac - prevFrac;
    if (d > 0.5) d -= 1; else if (d < -0.5) d += 1;
    prog += d; prevFrac = loc.frac;
    if (loc.dist > loc.hw) return { done: 'crash', prog, time, maxV, crashFrac: loc.frac, trace };
    if (prog >= 1) return { done: 'LAP', prog, time, maxV, crashFrac: null, trace };
    if (time >= maxT) return { done: 'timeout', prog, time, maxV, crashFrac: null, trace };
    if (time > 8 && prog < 0.02) return { done: 'stall', prog, time, maxV, crashFrac: null, trace };
    const obs = observe(idx, car, loc);
    const ctl: Control = forwardGenome(g, obs);
    if (steps % 120 === 0) {
      trace.push(`t=${time.toFixed(0)} v=${Math.round(Math.hypot(car.vx, car.vy))} thr=${ctl[0].toFixed(2)} brk=${ctl[1].toFixed(2)} str=${ctl[2].toFixed(2)} prog=${prog.toFixed(2)}`);
    }
    stepCar(car, ctl, phys);
    maxV = Math.max(maxV, Math.hypot(car.vx, car.vy));
    time += DT;
    steps++;
  }
}

// min corner radii per track (circumradius of ±8 triplets)
function tightCorners(track: Track, n = 6): { frac: number; r: number }[] {
  const pts = track.centerline, m = pts.length, R = 8;
  const out: { frac: number; r: number }[] = [];
  for (let i = 0; i < m; i++) {
    const a = pts[(i - R + m) % m], b = pts[i], c = pts[(i + R) % m];
    const ab = Math.hypot(b[0] - a[0], b[1] - a[1]);
    const bc = Math.hypot(c[0] - b[0], c[1] - b[1]);
    const ca = Math.hypot(a[0] - c[0], a[1] - c[1]);
    const area = Math.abs((b[0] - a[0]) * (c[1] - a[1]) - (c[0] - a[0]) * (b[1] - a[1])) / 2;
    out.push({ frac: i / m, r: area < 1e-9 ? Infinity : (ab * bc * ca) / (4 * area) });
  }
  return out.filter((x) => x.r < 200).sort((x, y) => x.r - y.r).slice(0, n);
}

const genomes: [string, Float32Array][] = [
  ['scuteria', loadGenome('/home/danel/Projects/racing_sim/weights-scuteria.json')],
  ['bingbong', loadGenome('/home/danel/Projects/racing_sim/weights-bingbong.json')],
];
for (const tn of ['Spa GP.json', 'Bahrain GP.json', 'Portimao GP.json', 'Monaco GP.json']) {
  const track = JSON.parse(readFileSync(`/home/danel/Projects/racing_sim/assets/tracks/${tn}`, 'utf8')) as Track;
  const idx = makeTrackIndex(track);
  console.log(`\n===== ${tn} (len=${Math.round(idx.total)} width=${track.width} startS=${track.startS}) =====`);
  console.log('  tightest:', tightCorners(track).map((c) => `${c.frac.toFixed(2)}:${c.r.toFixed(0)}`).join(' '));
  for (const [name, g] of genomes) {
    const r = rollout(idx, g);
    console.log(`  ${name}: done=${r.done} prog=${r.prog.toFixed(3)} t=${r.time.toFixed(1)} maxV=${Math.round(r.maxV)}${r.crashFrac != null ? ` crashFrac=${r.crashFrac.toFixed(3)}` : ''}`);
    for (const s of r.trace.slice(0, 8)) console.log('    ' + s);
  }
}
