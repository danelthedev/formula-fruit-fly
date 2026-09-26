import assert from 'node:assert/strict';
import { test } from 'node:test';
import { buildRoster, sanitizeSetup, sortQuali, validateSetup } from '../src/race.ts';
import { mulberry32 } from '../src/sim.ts';

const tracks = [{ id: 't1' }, { id: 't2' }];
const teams = [{ id: 'a' }, { id: 'b' }];

test('validateSetup blocks bad configs, passes good ones', () => {
  assert.deepEqual(validateSetup({ trackId: '', teamIds: ['a'], drivers: 2, laps: 3 }, tracks, teams).length > 0, true);
  assert.deepEqual(validateSetup({ trackId: 'nope', teamIds: ['a'], drivers: 2, laps: 3 }, tracks, teams), ['Pick one of your tracks (build one first).']);
  assert.deepEqual(validateSetup({ trackId: 't1', teamIds: [], drivers: 2, laps: 3 }, tracks, teams), ['Pick at least one team.']);
  assert.deepEqual(validateSetup({ trackId: 't1', teamIds: ['zzz'], drivers: 2, laps: 3 }, tracks, teams), ['Pick at least one team.']);
  assert.deepEqual(validateSetup({ trackId: 't1', teamIds: ['a'], drivers: 0, laps: 3 }, tracks, teams), ['Drivers per team must be 1–4.']);
  assert.deepEqual(validateSetup({ trackId: 't1', teamIds: ['a'], drivers: 2, laps: 11 }, tracks, teams), ['Laps must be 1–10.']);
  assert.deepEqual(validateSetup({ trackId: 't1', teamIds: ['a', 'b'], drivers: 4, laps: 10 }, tracks, teams), []);
});

test('sanitizeSetup coerces persisted configs, drops unknowns', () => {
  const c = sanitizeSetup({ trackId: 't1', teamIds: ['a', 'zzz'], drivers: 99, laps: 0, previewEvery: -1 }, tracks, teams);
  assert.ok(c);
  assert.deepEqual([c!.teamIds, c!.drivers, c!.laps, c!.previewEvery], [['a'], 4, 1, 0]);
  assert.equal(sanitizeSetup({ trackId: 'gone', teamIds: ['a'], drivers: 2, laps: 3 }, tracks, teams), null);
  assert.equal(sanitizeSetup(null, tracks, teams), null);
});

test('sortQuali orders finishers by time, DNFs by progress', () => {
  const rows = sortQuali([
    { teamId: 'a', name: 'A 1', time: null, progress: 0.3 },
    { teamId: 'b', name: 'B 1', time: 62.5, progress: 1 },
    { teamId: 'a', name: 'A 2', time: 58.1, progress: 1 },
    { teamId: 'b', name: 'B 2', time: null, progress: 0.7 },
  ]);
  assert.deepEqual(rows.map((r) => r.name), ['A 2', 'B 1', 'B 2', 'A 1']);
});

test('buildRoster samples deterministically, falls back to best', () => {
  const pops = new Map([['a', [[1], [2], [3]]]]);
  const bests = new Map([['a', [9]], ['b', [7]]]);
  const names = new Map([['a', 'A'], ['b', 'B']]);
  const r1 = buildRoster(['a', 'b'], names, 2, pops, bests, mulberry32(4));
  const r2 = buildRoster(['a', 'b'], names, 2, pops, bests, mulberry32(4));
  assert.deepEqual(r1, r2);
  assert.ok(r1.every((d) => /^\S+ \S+$/.test(d.name)), 'two-word driver names');
  assert.equal(new Set(r1.map((d) => d.name)).size, 4, 'unique names');
  assert.deepEqual([r1[0].teamName, r1[2].teamName], ['A', 'B']);
  assert.ok(r1[0].genome.length === 1 && r1[1].genome.length === 1);
  assert.deepEqual(r1[2].genome, [7]); // no population: best clone
});
