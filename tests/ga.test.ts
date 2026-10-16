import assert from 'node:assert/strict';
import { test } from 'node:test';
import { aggregateEpisodes, cornerSpawnSpeed, fitnessOf, initPop, runEpoch } from '../src/ga.ts';
import { buildNet } from '../src/nn.ts';
import { makeTrackIndex } from '../src/sim.ts';
import { blankTeam, physicsFor } from '../src/teams.ts';
import type { Pt } from '../src/track.ts';
import type { EpisodeResult } from '../src/sim.ts';

test('corner arrivals mix rolling and brake-or-crash speeds', () => {
  const seen = new Set<number>();
  for (let i = 0; i < 200; i++) {
    const s = cornerSpawnSpeed(200, Math.random);
    assert.ok(s >= 70 && s <= 190, `speed ${s} outside 0.35–0.95 vMax`);
    seen.add(Math.round(s));
  }
  assert.ok(seen.size > 10, 'no variety in arrival speeds');
});

test('fitnessOf rewards faster finished laps', () => {
  const lap = (time: number): EpisodeResult =>
    ({ progress: 1, time, steps: 600, done: 'lap', endSpeed: 100, decel: 0, jitter: 0 });
  assert.ok(fitnessOf(lap(20)) > fitnessOf(lap(40)), 'faster lap should win');
  assert.ok(Number.isFinite(fitnessOf(lap(20))));
  assert.equal(aggregateEpisodes([], false), -Infinity);
});

test('runEpoch scores a tiny pop without stalling', async () => {
  const oval: Pt[] = Array.from({ length: 32 }, (_, i) => {
    const a = (i / 32) * Math.PI * 2;
    return [Math.cos(a) * 200, Math.sin(a) * 120] as Pt;
  });
  const idx = makeTrackIndex({ id: 'x', name: 'x', centerline: oval, width: 60, startS: 0, closed: true, gates: [] as number[] });
  const net = buildNet();
  const r = await runEpoch(idx, physicsFor(blankTeam('t')), initPop(net, 4, 7),
    { popSize: 4, elite: 1, sigma: 0.05, episodes: 2, timeout: 8, laps: 1, crossoverRate: 0.7, robust: false }, 7);
  assert.equal(r.partial, false);
  assert.equal(r.pop.length, 4);
  assert.ok(Number.isFinite(r.bestFitness));
});
