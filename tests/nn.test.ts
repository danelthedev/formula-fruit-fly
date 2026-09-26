import assert from 'node:assert/strict';
import { test } from 'node:test';
import * as tf from '@tensorflow/tfjs';
import { blankTeam, physicsFor } from '../src/teams.ts';
import type { Track } from '../src/track.ts';
import { actObs, buildNet, decodeWeightsFile, disposeNet, encodeWeightsFile, getGenome, mutateGenome, setGenome } from '../src/nn.ts';
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

test('net arch shapes + mutated output ranges (stories.md DoD)', async () => {
  await tf.ready();
  tf.setBackend('cpu');
  const net = buildNet();
  assert.ok(net.size > 4000 && net.size < 8000, `genome size ${net.size}`);
  const shapes = net.model.getWeights().map((w) => w.shape.join('x'));
  assert.deepEqual(shapes, ['16x64', '64', '64x64', '64', '64x3', '3']);
  const g = mutateGenome(new Float32Array(net.size), 0.5, mulberry32(7));
  setGenome(net, g);
  assert.deepEqual([...getGenome(net)], [...g]);
  for (let i = 0; i < 20; i++) {
    const obs = Array.from({ length: 16 }, (_, k) => ((i * 16 + k) % 21) / 10 - 1);
    const [thr, brk, str] = actObs(net, obs);
    assert.ok(thr >= 0 && thr <= 1 && brk >= 0 && brk <= 1, 'throttle/brake in [0,1]');
    assert.ok(str >= -1 && str <= 1, 'steer in [-1,1]');
  }
  // mutate is deterministic per seed
  const m1 = mutateGenome(g, 0.1, mulberry32(3));
  const m2 = mutateGenome(g, 0.1, mulberry32(3));
  assert.deepEqual([...m1], [...m2]);
  disposeNet(net);
});

test('mini GA epoch runs headless without leaking tensors', async () => {
  await tf.ready();
  tf.setBackend('cpu');
  const net = buildNet();
  const idx = makeTrackIndex(oval());
  const before = tf.memory().numTensors;
  const pop = initPop(net, 4, 11);
  const r = await runEpoch(idx, phys, net, pop, {
    popSize: 4, elite: 1, sigma: 0.1, episodes: 1, timeout: 4, laps: 1,
  }, 5);
  assert.equal(r.pop.length, 4);
  assert.ok(Number.isFinite(r.bestFitness) && Number.isFinite(r.avgFitness));
  assert.ok(r.bestFitness >= r.avgFitness);
  assert.equal(tf.memory().numTensors, before);
  // fitness prefers laps over crashes
  assert.ok(
    fitnessOf({ progress: 1, time: 10, steps: 600, done: 'lap' }) >
    fitnessOf({ progress: 0.2, time: 10, steps: 600, done: 'crash' }),
  );
  disposeNet(net);
});

test('weights file round-trip identical; invalid decodes null', async () => {
  await tf.ready();
  tf.setBackend('cpu');
  const net = buildNet();
  const g = mutateGenome(new Float32Array(net.size), 0.5, mulberry32(7));
  setGenome(net, g);
  const obs = Array.from({ length: 16 }, (_, k) => (k % 21) / 10 - 1);
  const before = actObs(net, obs);
  const file = encodeWeightsFile('t1', 'Alpha', g);
  const json = JSON.stringify(file);
  const back = decodeWeightsFile(JSON.parse(json), net.size);
  assert.ok(back);
  assert.equal(back.teamId, 't1');
  setGenome(net, new Float32Array(back.weights));
  assert.deepEqual([...actObs(net, obs)], [...before]);
  assert.equal(decodeWeightsFile({ v: 1, teamId: 'x', teamName: 'y', arch: [16, 8, 8, 3], weights: [] }, net.size), null);
  assert.equal(decodeWeightsFile({ v: 1, teamId: 'x', teamName: 'y', arch: [16, 64, 64, 3], weights: [1, 2] }, net.size), null);
  assert.equal(decodeWeightsFile(null, net.size), null);
  disposeNet(net);
});
