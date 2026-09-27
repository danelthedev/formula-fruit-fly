import assert from 'node:assert/strict';
import { test } from 'node:test';
import { blankTeam, physicsFor } from '../src/teams.ts';
import type { Track } from '../src/track.ts';
import { buildNet, decodeWeightsFile, encodeWeightsFile, forwardGenome, GENOME_SIZE, mutateGenome, NET_ARCH, withBrakeBias } from '../src/nn.ts';
import { adaptSigma, aggregateEpisodes, crossover, epochTimeout, fitnessOf, initPop, migrateIslands, restartPop, runEpoch } from '../src/ga.ts';
import { makeTrackIndex } from '../src/sim.ts';
import { mulberry32 } from '../src/sim.ts';

const oval = (): Track => {
  const center: [number, number][] = Array.from({ length: 120 }, (_, i) => {
    const a = (i / 120) * Math.PI * 2;
    return [Math.cos(a) * 200, Math.sin(a) * 120];
  });
  return { id: 'o', name: 'oval', centerline: center, width: 60, startS: 0, closed: true, gates: [] };
};
const phys = physicsFor({ ...blankTeam('t'), topSpeed: 5, acceleration: 5, brakeEfficiency: 5, turningAbility: 5 });

test('plain-JS MLP: arch, ranges, zero-genome invariant (stories.md DoD)', async () => {
  const net = buildNet();
  assert.equal(net.size, 5443);
  assert.equal(GENOME_SIZE, 5443);
  assert.deepEqual(NET_ARCH, [16, 64, 64, 3]);
  // all-zero weights: pre-activations 0 → [sigmoid 0, sigmoid 0, tanh 0]
  assert.deepEqual([...forwardGenome(new Float32Array(net.size), new Array(16).fill(0))], [0.5, 0.5, 0]);
  const g = mutateGenome(new Float32Array(net.size), 0.5, mulberry32(7));
  for (let i = 0; i < 20; i++) {
    const obs = Array.from({ length: 16 }, (_, k) => ((i * 16 + k) % 21) / 10 - 1);
    const [thr, brk, str] = forwardGenome(g, obs);
    assert.ok(thr >= 0 && thr <= 1 && brk >= 0 && brk <= 1, 'throttle/brake in [0,1]');
    assert.ok(str >= -1 && str <= 1, 'steer in [-1,1]');
  }
  // deterministic per input, mutate deterministic per seed
  const obs = Array.from({ length: 16 }, (_, k) => k / 16 - 0.5);
  assert.deepEqual([...forwardGenome(g, obs)], [...forwardGenome(g, obs)]);
  const m1 = mutateGenome(g, 0.1, mulberry32(3));
  const m2 = mutateGenome(g, 0.1, mulberry32(3));
  assert.deepEqual([...m1], [...m2]);
});

test('mini GA epoch runs headless (no TF.js)', async () => {
  const net = buildNet();
  const idx = makeTrackIndex(oval());
  const pop = initPop(net, 4, 11);
  const r = await runEpoch(idx, phys, pop, {
    popSize: 4, elite: 1, sigma: 0.1, episodes: 1, timeout: 4, laps: 1,
    crossoverRate: 0.7, robust: false,
  }, 5);
  assert.equal(r.pop.length, 4);
  assert.ok(Number.isFinite(r.bestFitness) && Number.isFinite(r.avgFitness));
  assert.ok(r.bestFitness >= r.avgFitness);
  // fitness prefers laps over crashes, and fast coverage over crawling to the same spot
  assert.ok(
    fitnessOf({ progress: 1, time: 10, steps: 600, done: 'lap', endSpeed: 100, decel: 0 }) >
    fitnessOf({ progress: 0.2, time: 10, steps: 600, done: 'crash', endSpeed: 200, decel: 0 }),
  );
  // ladder: late-braker (right skill, mistimed) > kamikaze (speed, no brakes) > crawler
  assert.ok(
    fitnessOf({ progress: 0.21, time: 6, steps: 360, done: 'crash', endSpeed: 60, decel: 140 }) >
    fitnessOf({ progress: 0.195, time: 3.6, steps: 216, done: 'crash', endSpeed: 200, decel: 0 }),
  );
  assert.ok(
    fitnessOf({ progress: 0.195, time: 3.6, steps: 216, done: 'crash', endSpeed: 200, decel: 0 }) >
    fitnessOf({ progress: 0.26, time: 36, steps: 2160, done: 'crash', endSpeed: 25, decel: 5 }),
  );
});

test('aggregateEpisodes: mean rewards peaks, worst-episode rewards consistency', () => {
  assert.equal(aggregateEpisodes([100, 200, 300], false), 200);
  assert.equal(aggregateEpisodes([100, 200, 300], true), 100);
  assert.equal(aggregateEpisodes([250, 250, 250], true), 250); // steady lapper unaffected
  assert.equal(aggregateEpisodes([], true), -Infinity);
});

test('finalize config (robust, no crossover, deep eval) runs headless', async () => {
  const net = buildNet();
  const idx = makeTrackIndex(oval());
  const pop = initPop(net, 4, 11);
  const r = await runEpoch(idx, phys, pop, {
    popSize: 4, elite: 1, sigma: 0.01, episodes: 4, timeout: 4, laps: 1,
    crossoverRate: 0, robust: true,
  }, 5);
  assert.equal(r.pop.length, 4);
  assert.ok(Number.isFinite(r.bestFitness) && Number.isFinite(r.avgFitness));
  assert.ok(r.bestFitness >= r.avgFitness);
  assert.equal(r.partial, false);
});

test('weights file round-trip identical; invalid decodes null', async () => {
  const net = buildNet();
  const g = mutateGenome(new Float32Array(net.size), 0.5, mulberry32(7));
  const obs = Array.from({ length: 16 }, (_, k) => (k % 21) / 10 - 1);
  const before = forwardGenome(g, obs);
  const file = encodeWeightsFile('t1', 'Alpha', g);
  const json = JSON.stringify(file);
  const back = decodeWeightsFile(JSON.parse(json), net.size);
  assert.ok(back);
  assert.equal(back.teamId, 't1');
  assert.deepEqual([...forwardGenome(new Float32Array(back.weights), obs)], [...before]);
  assert.equal(decodeWeightsFile({ v: 1, teamId: 'x', teamName: 'y', arch: [16, 8, 8, 3], weights: [] }, net.size), null);
  assert.equal(decodeWeightsFile({ v: 1, teamId: 'x', teamName: 'y', arch: [16, 64, 64, 3], weights: [1, 2] }, net.size), null);
  assert.equal(decodeWeightsFile(null, net.size), null);
});

test('adaptive sigma cools on improvement, heats on stasis, caps', () => {
  const close = (a: number, b: number) => assert.ok(Math.abs(a - b) < 1e-12, `${a} ≈ ${b}`);
  close(adaptSigma(0.05, 0.05, true, 0), 0.035); // 0.05 * 0.7
  close(adaptSigma(0.035, 0.05, true, 0), 0.025); // floor at base/2
  close(adaptSigma(0.05, 0.05, false, 1), 0.075); // base * 1.5
  close(adaptSigma(0.05, 0.05, false, 2), 0.1); // base * 2
  close(adaptSigma(0.05, 0.05, false, 5), 0.15); // base * 3.5 capped
  close(adaptSigma(0.2, 0.05, false, 99), 0.15); // hard cap (0.3 scrambled genomes)
});

test('restartPop keeps a champion copy plus mutated diversity; epochTimeout scales with track', () => {
  const net = buildNet();
  const best = mutateGenome(new Float32Array(net.size), 0.5, mulberry32(7));
  const pop = restartPop(best, 8, 0.05, mulberry32(1));
  assert.equal(pop.length, 8);
  assert.deepEqual([...pop[0]], [...best]);
  assert.ok(pop[0] !== best, 'copy, not alias');
  assert.ok(pop.some((g) => g.some((v, i) => v !== best[i])), 'mutants differ');
  assert.equal(epochTimeout(1000, 1), 40); // small track: floor
  assert.equal(epochTimeout(2800, 1), 80); // big track scales (learning pace)
  assert.equal(epochTimeout(2800, 2), 150); // multi-lap scales (capped)
  assert.equal(epochTimeout(20000, 1), 150); // ceiling
  assert.equal(epochTimeout(0, 1), 40); // degenerate guard
});

test('crossover picks every gene from a parent; deterministic per seed', () => {
  const a = new Float32Array([1, 2, 3, 4]);
  const b = new Float32Array([10, 20, 30, 40]);
  const c1 = crossover(a, b, mulberry32(9));
  const c2 = crossover(a, b, mulberry32(9));
  assert.deepEqual([...c1], [...c2]);
  assert.ok(c1.every((v, i) => v === a[i] || v === b[i]), 'each gene from a parent');
  assert.ok(c1.some((v, i) => v === a[i]) && c1.some((v, i) => v === b[i]), 'mixes both parents');
});

test('withBrakeBias raises brake output, leaves rest identical', () => {
  const net = buildNet();
  const g = new Float32Array(net.size);
  for (let i = 0; i < g.length; i++) g[i] = (i % 7 - 3) * 0.1;
  const obs = new Array(16).fill(0.2);
  const before = forwardGenome(g, obs);
  const after = forwardGenome(withBrakeBias(g, 2.0), obs);
  assert.ok(after[1] > before[1], 'brake output increased');
  assert.ok(Math.abs(after[0] - before[0]) < 1e-9 && Math.abs(after[2] - before[2]) < 1e-9, 'throttle/steer unchanged');
});

test('migrateIslands rings champions, spares elites, skips nulls', () => {
  const mk = (v: number) => new Float32Array([v, v]);
  const pops = [[mk(1), mk(1), mk(1), mk(1)], [mk(2), mk(2), mk(2), mk(2)], [mk(3), mk(3), mk(3), mk(3)]];
  const bests = [mk(10), mk(20), mk(30)];
  migrateIslands(pops, bests, 1, mulberry32(4));
  for (const p of pops) assert.equal(p.length, 4); // lengths unchanged
  // elite (first genome) untouched
  assert.equal(pops[0][0][0], 1);
  assert.equal(pops[1][0][0], 2);
  // island i received island i-1's champion past elites
  for (let i = 0; i < 3; i++) {
    const want = [10, 20, 30][(i + 2) % 3];
    assert.ok(pops[i].slice(1).some((g) => g[0] === want), `island ${i} got champion ${want}`);
  }
  // null bests skipped, single island no-op
  const q = [[mk(5)]];
  migrateIslands(q, [null], 0, mulberry32(1));
  assert.equal(q[0].length, 1);
  const r = [[mk(7), mk(7)], [mk(8), mk(8)]];
  migrateIslands(r, [null, mk(9)], 1, mulberry32(2));
  assert.deepEqual(r[1].map((g) => g[0]), [8, 8]); // null donor: untouched
  assert.ok(r[0].slice(1).some((g) => g[0] === 9)); // island 0 got island 1's champion past elite
});
