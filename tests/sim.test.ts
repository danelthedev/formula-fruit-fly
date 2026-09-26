import assert from 'node:assert/strict';
import { test } from 'node:test';
import { blankTeam, physicsFor } from '../src/teams.ts';
import { pointAt } from '../src/track.ts';
import type { Track } from '../src/track.ts';
import { locate, makeTrackIndex, observe, runEpisode } from '../src/sim.ts';
import type { CarState, Control } from '../src/sim.ts';

const oval = (): Track => {
  const center: [number, number][] = Array.from({ length: 120 }, (_, i) => {
    const a = (i / 120) * Math.PI * 2;
    return [Math.cos(a) * 200, Math.sin(a) * 120];
  });
  return { id: 'o', name: 'oval', centerline: center, width: 60, startS: 0, closed: true, gates: [] };
};
const phys = physicsFor({ ...blankTeam('t'), topSpeed: 5, acceleration: 5, brakeEfficiency: 5, turningAbility: 5 });
const wrap = (a: number) => Math.atan2(Math.sin(a), Math.cos(a));
// pure pursuit: steer toward a lookahead point, lift throttle in sharp bends
const pursuit = (idx: ReturnType<typeof makeTrackIndex>): ((obs: number[], car: CarState) => Control) => (obs, car) => {
  const loc = locate(idx, car.x, car.y, -1);
  const tp = pointAt(idx.track.centerline, true, loc.frac + 0.04);
  const err = wrap(Math.atan2(tp[1] - car.y, tp[0] - car.x) - car.heading);
  const steer = Math.max(-1, Math.min(1, err * 2.5));
  return [Math.abs(err) < 0.35 ? 1 : 0.45, 0, steer];
};

test('scripted run completes a lap; replay is deterministic', async () => {
  const idx = makeTrackIndex(oval());
  const t0 = Date.now();
  const r1 = await runEpisode(idx, phys, pursuit(idx), { laps: 1, maxTime: 60 });
  const wall = (Date.now() - t0) / 1000;
  console.log(`      lap: ${r1.steps} steps, ${(r1.steps / Math.max(wall, 1e-3)).toFixed(0)} steps/s wall`);
  assert.equal(r1.done, 'lap');
  const r2 = await runEpisode(idx, phys, pursuit(idx), { laps: 1, maxTime: 60 });
  assert.deepEqual([r2.progress, r2.time, r2.steps, r2.done], [r1.progress, r1.time, r1.steps, r1.done]);
});

test('straight into the wall crashes; crawl times out', async () => {
  const idx = makeTrackIndex(oval());
  const crash = await runEpisode(idx, phys, () => [1, 0, 0], { laps: 1, maxTime: 60 });
  assert.equal(crash.done, 'crash');
  assert.ok(crash.progress < 1);
  const slow = await runEpisode(idx, phys, () => [0.05, 0, 0], { laps: 1, maxTime: 0.5 });
  assert.equal(slow.done, 'timeout');
});

test('parked genome stalls out fast instead of burning the timeout', async () => {
  const idx = makeTrackIndex(oval());
  const r = await runEpisode(idx, phys, () => [0, 0, 0], { laps: 1, maxTime: 60 });
  assert.equal(r.done, 'crash');
  assert.ok(r.time < 20, `stalled at ${r.time}s instead of 60s timeout`);
  assert.ok(r.steps < 60 * 20);
});

test('gate order precomputed sorted; matches gate count', () => {
  const t = oval();
  t.gates = [0.75, 0.1, 0.5];
  const idx = makeTrackIndex(t);
  assert.equal(idx.gateOrder.length, idx.gates.length);
  const frs = idx.gateOrder.map((o) => o.fr);
  assert.deepEqual([...frs].sort((a, b) => a - b), frs);
});

test('observe returns 16 normalized dims', () => {
  const idx = makeTrackIndex(oval());
  const car: CarState = { x: 200, y: 0, heading: Math.PI / 2, vx: 0, vy: 0 };
  const obs = observe(idx, car, locate(idx, car.x, car.y, -1));
  assert.equal(obs.length, 16);
  assert.ok(obs.every((v) => Number.isFinite(v)), 'all finite');
  assert.ok(obs.slice(3, 12).every((v) => v >= 0 && v <= 1), 'rays in [0,1]');
});
