import assert from 'node:assert/strict';
import { test } from 'node:test';
import { blankTeam, drawCarPreview, physicsFor, sanitizeTeam, SPEC_MAP, teamErrors } from '../src/teams.ts';

test('SPEC_MAP is strictly monotonic (DoD: higher spec → better param)', () => {
  for (const [name, f] of Object.entries(SPEC_MAP) as [string, (v: number) => number][]) {
    for (let s = 1; s < 10; s++) assert.ok(f(s + 1) > f(s), `${name}(${s + 1}) must exceed ${name}(${s})`);
  }
  const p = physicsFor({ ...blankTeam('x'), topSpeed: 10, acceleration: 10, brakeEfficiency: 10, turningAbility: 10 });
  assert.ok(Object.values(p).every((v) => Number.isFinite(v) && v > 0));
});

test('sanitizeTeam clamps specs, fixes colors, rejects nameless', () => {
  const t = sanitizeTeam({ name: '  Red  ', topSpeed: 0, acceleration: 99, brakeEfficiency: 4.6, turningAbility: 'abc', primary: 'nope', secondary: '#00ff00' });
  assert.ok(t);
  assert.equal(t!.name, 'Red');
  assert.deepEqual([t!.topSpeed, t!.acceleration, t!.brakeEfficiency, t!.turningAbility], [1, 10, 5, 5]);
  assert.equal(t!.primary, '#e10600');
  assert.equal(t!.secondary, '#00ff00');
  assert.equal(sanitizeTeam({ name: '   ' }), null);
  assert.equal(sanitizeTeam(null), null);
});

test('teamErrors enforces non-empty unique names', () => {
  const others = [{ ...blankTeam('a'), name: 'Ferrari' }];
  assert.deepEqual(teamErrors('', 'b', others), ['Name is required.']);
  assert.deepEqual(teamErrors('ferrari', 'b', others), ['"ferrari" is already taken.']);
  assert.deepEqual(teamErrors('Ferrari', 'a', others), []); // own name ok
  assert.deepEqual(teamErrors('McLaren', 'b', others), []);
});

test('drawCarPreview paints body color without throwing (stub ctx)', () => {
  const calls: string[] = [];
  const ctx = {
    clearRect: () => {}, fillRect: () => {},
    beginPath: () => { calls.push('b'); }, closePath: () => {},
    moveTo: () => {}, lineTo: () => {}, fill: () => { calls.push('f'); },
    ellipse: () => {},
    stroke: () => {},
    set lineWidth(_v: number) {},
    roundRect: (_x: number, _y: number, _w: number, _h: number, _r: number) => {},
    set fillStyle(_v: string) {},
  } as unknown as CanvasRenderingContext2D;
  drawCarPreview(ctx, 220, 110, '#e10600', '#ffffff');
  assert.ok(calls.filter((c) => c === 'f').length >= 8, 'paints all car parts');
});
