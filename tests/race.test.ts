import assert from 'node:assert/strict';
import { test } from 'node:test';
import { buildRoster, gridSlots, lineColor, sanitizeSetup, sortQuali, startGridMarks, validateSetup } from '../src/race.ts';
import { locate, makeTrackIndex, mulberry32 } from '../src/sim.ts';
import { resample } from '../src/track.ts';
import type { Pt } from '../src/track.ts';
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

test('sortQuali ranks finishers by time, DNFs by furthest reached', () => {
  const rows = sortQuali([
    { teamId: 'a', teamName: 'A', name: 'short', time: null, progress: 0.3 },
    { teamId: 'b', teamName: 'B', name: 'far', time: null, progress: 0.8 },
    { teamId: 'c', teamName: 'C', name: 'fast', time: 60, progress: 1 },
    { teamId: 'd', teamName: 'D', name: 'slow', time: 62, progress: 1 },
  ]);
  assert.deepEqual(rows.map((r) => r.name), ['fast', 'slow', 'far', 'short']);
});

test('lineColor blends continuously: endpoints exact, mids between', () => {
  assert.equal(lineColor(0, 0), '#9a9a9a');
  assert.equal(lineColor(1, 0), '#2bff7d');
  assert.equal(lineColor(0, 1), '#ff3b30');
  const hex = (s: string) => [1, 3, 5].map((i) => parseInt(s.slice(i, i + 2), 16));
  const [r, g, b] = hex(lineColor(0.5, 0));
  assert.ok(r < 154 && g > 154 && b < 154, `half throttle greens the gray: ${lineColor(0.5, 0)}`); // r=85 g=217 b=136
  const [r2, g2, b2] = hex(lineColor(0, 0.5));
  assert.ok(r2 > 154 && g2 < 154 && b2 < 154, `half brake reddens the gray: ${lineColor(0, 0.5)}`); // r=217 g=95 b=88
  const [, g3] = hex(lineColor(0.3, 0));
  assert.ok(g3 >= 200, `feathered throttle reads green, not murk: ${lineColor(0.3, 0)}`);
});

test('grid staggers odd slots and clears boxes, even in corners', () => {
  const oval: Pt[] = Array.from({ length: 64 }, (_, i) => {
    const a = (i / 64) * Math.PI * 2;
    return [Math.cos(a) * 200, Math.sin(a) * 120] as Pt;
  });
  const mkOval = (w: number) => ({ id: 'x', name: 'x', centerline: oval, width: w, startS: 10, closed: true, gates: [] as number[] });
  // stagger: each slot sits further behind the start than the last (odd half a row back)
  const idx = makeTrackIndex(mkOval(60));
  const slots = gridSlots(idx, 6);
  const behind = slots.map((s) => (((10 / idx.n - locate(idx, s.x, s.y, -1).frac) % 1) + 1) % 1);
  for (let i = 1; i < behind.length; i++) assert.ok(behind[i] > behind[i - 1], `slot ${i} not behind slot ${i - 1}`);
  // hairpin with the start at the apex: same-side boxes clear, everything on road
  const raw: Pt[] = [[-200, -45], [200, -45]];
  for (let a = -Math.PI / 2; a <= Math.PI / 2 + 1e-6; a += 0.08) raw.push([200 + Math.cos(a) * 45, Math.sin(a) * 45]);
  raw.push([-200, 45]);
  for (let a = Math.PI / 2; a <= Math.PI * 1.5 + 1e-6; a += 0.08) raw.push([-200 + Math.cos(a) * 45, Math.sin(a) * 45]);
  const hair = resample(raw, 8, true);
  let apex = 0; hair.forEach((p, i) => { if (p[0] > hair[apex][0]) apex = i; });
  const hIdx = makeTrackIndex({ id: 'x', name: 'x', centerline: hair, width: 56, startS: apex, closed: true, gates: [] as number[] });
  const mk = startGridMarks(hIdx, 8);
  assert.equal(mk.slots.length, 8);
  mk.slots.forEach((s) => {
    const l = locate(hIdx, s.x, s.y, -1);
    assert.ok(l.dist <= l.hw - 4, `slot off road: dist ${l.dist.toFixed(1)} > hw ${l.hw.toFixed(1)}`);
  });
  for (let i = 0; i < mk.slots.length - 2; i++) {
    const a = mk.slots[i], b = mk.slots[i + 2];
    const d = Math.hypot(a.x - b.x, a.y - b.y);
    assert.ok(d >= mk.box.l, `same-side slots ${i},${i + 2} overlap: ${d.toFixed(1)} < box ${mk.box.l}`);
  }
});
