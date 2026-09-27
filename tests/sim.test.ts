import assert from 'node:assert/strict';
import { test } from 'node:test';
import { blankTeam, physicsFor } from '../src/teams.ts';
import { pointAt } from '../src/track.ts';
import type { Track } from '../src/track.ts';
import { locate, makeTrackIndex, mulberry32, observe, runEpisode, sampleSpawnFrac, spawn, spawnAt } from '../src/sim.ts';
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

test('spawnAt wraps fractions; spawnFrac episodes record endSpeed', async () => {
  const idx = makeTrackIndex(oval());
  const a = spawnAt(idx, 0.25);
  const b = spawnAt(idx, 1.25);
  assert.deepEqual([a.car.x, a.car.y], [b.car.x, b.car.y]); // wraps like 0.25
  assert.deepEqual([spawn(idx).car.x, spawn(idx).car.y], [spawnAt(idx, 0).car.x, spawnAt(idx, 0).car.y]);
  const r = await runEpisode(idx, phys, () => [1, 0, 0], { laps: 1, maxTime: 5, spawnFrac: 0.5 });
  assert.ok(Number.isFinite(r.endSpeed) && r.endSpeed >= 0, 'endSpeed recorded');
  assert.ok(r.done === 'crash' || r.done === 'timeout' || r.done === 'lap');
});

test('curvature CDF built; corner-biased spawns stay in range and deterministic', () => {
  const idx = makeTrackIndex(oval());
  assert.ok(idx.curveTotal > 0, 'oval has curvature');
  assert.equal(idx.curveCum.length, 120);
  const sorted = [...idx.curveCum];
  sorted.sort((a, b) => a - b);
  assert.deepEqual(idx.curveCum, sorted, 'CDF monotonic');
  const r1 = Array.from({ length: 20 }, () => sampleSpawnFrac(idx, mulberry32(4)));
  const r2 = Array.from({ length: 20 }, () => sampleSpawnFrac(idx, mulberry32(4)));
  assert.deepEqual(r1, r2, 'deterministic per seed');
  assert.ok(r1.every((f) => f >= 0 && f < 1), 'fractions in [0,1)');
});

test('spawnAt sets rolling velocity along the tangent; coasting covers ground', async () => {
  const idx = makeTrackIndex(oval());
  const s = spawnAt(idx, 0.1, 60);
  assert.equal(Math.round(Math.hypot(s.car.vx, s.car.vy)), 60);
  // parked policy coasts from speed before stalling: progress without throttle
  // (60px/s: drag brings it to rest on the straight; faster would carry it off)
  const r = await runEpisode(idx, phys, () => [0, 0, 0], { laps: 1, maxTime: 3, spawnFrac: 0.1, spawnSpeed: 60 });
  assert.ok(r.progress > 0.005, `coasted prog=${r.progress}`);
  assert.equal(r.done, 'timeout');
});

test('hairpin track (R=30, tighter than Bahrain) is kinematically lappable', async () => {
  // Regression: WHEELBASE=32 needed 95px+ to turn, making real hairpins
  // impassable for any policy. Pursuit must complete a lap.
  const pts: [number, number][] = [];
  for (let x = 0; x <= 300; x += 10) pts.push([x, 0]);
  for (let a = -90; a <= 90; a += 6) {
    const t = (a * Math.PI) / 180;
    pts.push([300 + 30 * Math.cos(t), 30 + 30 * Math.sin(t)]);
  }
  for (let x = 300; x >= 0; x -= 10) pts.push([x, 60]);
  for (let a = 90; a <= 270; a += 6) {
    const t = (a * Math.PI) / 180;
    pts.push([30 * Math.cos(t), 30 + 30 * Math.sin(t)]);
  }
  const t: Track = { id: 'h', name: 'hairpin', centerline: pts, width: 40, startS: 0, closed: true, gates: [] };
  const idx = makeTrackIndex(t);
  const wrap = (a: number) => Math.atan2(Math.sin(a), Math.cos(a));
  const r = await runEpisode(idx, phys, (_obs, car) => {
    const loc = locate(idx, car.x, car.y, -1);
    const tp = pointAt(idx.track.centerline, true, loc.frac + 0.015);
    const err = wrap(Math.atan2(tp[1] - car.y, tp[0] - car.x) - car.heading);
    const steer = Math.max(-1, Math.min(1, err * 3));
    const v = Math.hypot(car.vx, car.vy);
    // real rates: brake for the R=30 hairpins (corner speed ≈ 60px/s), back on power after
    return [v < 55 ? 1 : 0, v > 70 ? 0.8 : 0, steer];
  }, { laps: 1, maxTime: 60 });
  assert.equal(r.done, 'lap');
});
