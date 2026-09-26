import assert from 'node:assert/strict';
import { test } from 'node:test';
import { blankTeam, physicsFor } from '../src/teams.ts';
import type { Track } from '../src/track.ts';
import { buildNet, decodeWeightsFile, encodeWeightsFile, forwardGenome, GENOME_SIZE, mutateGenome, NET_ARCH } from '../src/nn.ts';
import { fitnessOf, initPop, runEpoch } from '../src/ga.ts';
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
  }, 5);
  assert.equal(r.pop.length, 4);
  assert.ok(Number.isFinite(r.bestFitness) && Number.isFinite(r.avgFitness));
  assert.ok(r.bestFitness >= r.avgFitness);
  // fitness prefers laps over crashes
  assert.ok(
    fitnessOf({ progress: 1, time: 10, steps: 600, done: 'lap' }) >
    fitnessOf({ progress: 0.2, time: 10, steps: 600, done: 'crash' }),
  );
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
