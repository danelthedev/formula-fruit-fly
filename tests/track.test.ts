import assert from 'node:assert/strict';
import { test } from 'node:test';
import { buildMask, extractCore, largestComponent, thin, prune, simplifySkeleton, traceLoop } from '../src/skeleton.ts';
import { blendSeam, checkpoints, circleCenter, closeLoop, dist, edges, gateAt, hasSelfIntersection, minSelfSeparation, nearestIndex, pointAt, projectFraction, resample, sampleArc, sampleLine, segOverlapsExisting, smooth, smoothOpen, validateGeometry, widthAt } from '../src/track.ts';

test('resample evens spacing on fixture square', () => {
  const sq = [[0, 0], [100, 0], [100, 100], [0, 100]];
  const r = resample(sq, 10, true);
  assert.ok(r.length >= 30 && r.length <= 50, `n=${r.length}`);
});

test('intersection: figure-eight rejected, oval accepted', () => {
  const oval = Array.from({ length: 32 }, (_, i) => {
    const a = (i / 32) * Math.PI * 2;
    return [Math.cos(a) * 100, Math.sin(a) * 60] as [number, number];
  });
  const eight = Array.from({ length: 32 }, (_, i) => {
    const a = (i / 32) * Math.PI * 2;
    return [Math.sin(a) * 100, Math.sin(a) * Math.cos(a) * 60] as [number, number];
  });
  assert.equal(hasSelfIntersection(oval), false);
  assert.equal(hasSelfIntersection(eight), true);
});

test('closeLoop cuts overshoot past start, keeps overlapped track', () => {
  const loop = [...Array.from({ length: 40 }, (_, i) => {
    const a = (i / 40) * Math.PI * 2;
    return [Math.cos(a) * 100, Math.sin(a) * 100] as [number, number];
  }), [95, 5] as [number, number], [80, 10] as [number, number], [60, 20] as [number, number]];
  const { loop: out, closed } = closeLoop(loop);
  assert.equal(closed, true);
  assert.equal(out.length, 41); // overshoot pair trimmed, overlapping [95,5] kept
  assert.equal(closeLoop([[0, 0], [200, 0]]).closed, false);
});

test('blendSeam cuts the closure corner with even spacing, no kink', () => {
  // square closed AT a corner: 90° joint at index 0
  const sq: [number, number][] = [[0, 0], [200, 0], [200, 200], [0, 200], [0, 0]];
  const rs = resample(sq, 8, false);
  const { loop, closed } = closeLoop(rs);
  assert.equal(closed, true);
  const bl = blendSeam(smooth(loop));
  const n = bl.length;
  const jump = (a: [number, number], b: [number, number]) => Math.hypot(a[0] - b[0], a[1] - b[1]);
  const turn = (i: number): number => {
    const p = bl[i], q = bl[(i + 1) % n], r = bl[(i + 2) % n];
    const v1 = [q[0] - p[0], q[1] - p[1]], v2 = [r[0] - q[0], r[1] - q[1]];
    return Math.abs(Math.atan2(v1[0] * v2[1] - v1[1] * v2[0], v1[0] * v2[0] + v1[1] * v2[1])) * 180 / Math.PI;
  };
  let mj = 0;
  for (let i = 0; i < n; i++) mj = Math.max(mj, jump(bl[i], bl[(i + 1) % n]));
  assert.ok(mj < 12, `seam spacing jump ${mj.toFixed(1)}px`);
  let mt = 0;
  for (let k = -15; k <= 15; k++) mt = Math.max(mt, turn(((k % n) + n) % n));
  assert.ok(mt < 50, `residual kink ${mt.toFixed(0)}° at seam`); // drawn corners elsewhere keep their shape
});

test('line samples straight, arc stays on circle through 3 pts', () => {
  const line = sampleLine([0, 0], [100, 0]);
  assert.ok(line.length > 5 && line.every((p) => Math.abs(p[1]) < 1e-9));
  assert.deepEqual(line[0], [0, 0]);
  const arc = sampleArc([100, 0], [0, 100], [-100, 0]);
  const c = circleCenter([100, 0], [0, 100], [-100, 0])!;
  const r = Math.hypot(100 - c[0], 0 - c[1]);
  assert.ok(arc.every((p) => Math.abs(Math.hypot(p[0] - c[0], p[1] - c[1]) - r) < 1e-6));
  assert.ok(Math.hypot(arc[0][0] - 100, arc[0][1]) < 1e-6);
  assert.ok(arc.some((p) => Math.hypot(p[0], p[1] - 100) < 9)); // passes via point
  assert.equal(circleCenter([0, 0], [1, 1], [2, 2]), null); // collinear
});

test('overlap guard: out-and-back flagged, clean oval passes', () => {
  const pts: [number, number][] = [];
  for (let x = 0; x <= 200; x += 8) pts.push([x, 0]);
  for (let x = 200; x >= 0; x -= 8) pts.push([x, 20]); // 20px parallel, width 60
  assert.ok(minSelfSeparation(pts, 10, false) < 60);
  const oval = Array.from({ length: 120 }, (_, i) => {
    const a = (i / 120) * Math.PI * 2;
    return [Math.cos(a) * 200, Math.sin(a) * 120] as [number, number];
  });
  assert.ok(minSelfSeparation(oval, 16, true) > 60);
});

test('no auto-close: near-miss stays open, exact join closes; smoothOpen keeps endpoints', () => {
  const near: [number, number][] = [[0, 0], [100, 0], [100, 100], [10, 100]]; // 10px gap
  assert.equal(closeLoop(near).closed, false); // user must join explicitly
  const far: [number, number][] = [[0, 0], [100, 0], [100, 100], [400, 400]];
  assert.equal(closeLoop(far).closed, false);
  const kink: [number, number][] = [[0, 0], [50, 0], [50, 50], [100, 50]];
  const sm = smoothOpen(kink);
  const d0 = Math.hypot(sm[0][0], sm[0][1]);
  const d1 = Math.hypot(sm[sm.length - 1][0] - 100, sm[sm.length - 1][1] - 50);
  assert.ok(d0 < 8 && d1 < 12); // endpoints pinned (resample stops ≤1 step short)
  assert.ok(sm.length > kink.length); // subdivided
});

test('hairpins merge (ok), crossings rejected', () => {
  // stadium with tight top: legs 30px apart, width 60 -> old code rejected, now hairpin
  const u: [number, number][] = [];
  for (let y = 0; y <= 200; y += 10) u.push([0, y]);
  for (let a = 1; a <= 9; a++) {
    const t = Math.PI + (a / 10) * Math.PI;
    u.push([15 + 15 * Math.cos(t), 200 + 15 * Math.sin(t)]);
  }
  for (let y = 200; y >= 0; y -= 10) u.push([30, y]);
  u.push([30, -100], [0, -100], [0, 0]); // bottom connector, far away
  assert.equal(validateGeometry(u, 60), 'ok');
  const eight = Array.from({ length: 32 }, (_, i) => {
    const a = (i / 32) * Math.PI * 2;
    return [Math.sin(a) * 100, Math.sin(a) * Math.cos(a) * 60] as [number, number];
  });
  assert.equal(validateGeometry(eight, 60), 'crossed');
});

test('checkpoints hug road edges across widths', () => {
  const center = Array.from({ length: 120 }, (_, i) => {
    const a = (i / 120) * Math.PI * 2;
    return [Math.cos(a) * 200, Math.sin(a) * 120] as [number, number];
  });
  for (const w of [40, 100]) {
    const t = { id: 'x', name: 'x', centerline: center, width: w, startS: 0, closed: true,
      gates: Array.from({ length: 12 }, (_, k) => k / 12) };
    const all = [...edges(t).left, ...edges(t).right];
    for (const g of checkpoints(t))
      for (const p of [g.a, g.b]) {
        const d = Math.min(...all.map((q) => Math.hypot(p[0] - q[0], p[1] - q[1])));
        assert.ok(d < 0.01, `gate end ${d.toFixed(2)}px off edge at w=${w}`); // exact by construction
      }
  }
});

test('inner edge clamps on hairpins tighter than half-width (no cusp zigzag)', () => {
  // 180° arc r=30 with width 120: raw parallel offset would cusp-fold here
  const arc: [number, number][] = [];
  for (let a = 0; a <= 20; a++) {
    const t = Math.PI - (a / 20) * Math.PI;
    arc.push([100 + 30 * Math.cos(t), 100 + 30 * Math.sin(t)]);
  }
  for (let y = 90; y >= -200; y -= 10) arc.push([130, y]); // out leg down
  for (let a = 1; a <= 9; a++) { // bottom U-turn
    const t = -(a / 10) * Math.PI;
    arc.push([100 + 30 * Math.cos(t), -200 + 30 * Math.sin(t)]);
  }
  for (let y = -190; y <= 100; y += 10) arc.push([70, y]); // in leg up, ends at arc start: closed loop
  const t = { id: 'x', name: 'x', centerline: resample(arc, 8, true), width: 120, startS: 0, closed: true, gates: [0.1, 0.4, 0.7] }; // resampled: matches app even-spacing
  for (const poly of [edges(t).left, edges(t).right]) {
    for (let i = 1; i < poly.length - 1; i++) {
      const v1 = [poly[i][0] - poly[i - 1][0], poly[i][1] - poly[i - 1][1]];
      const v2 = [poly[i + 1][0] - poly[i][0], poly[i + 1][1] - poly[i][1]];
      const turn = Math.abs(Math.atan2(v1[0] * v2[1] - v1[1] * v2[0], v1[0] * v2[0] + v1[1] * v2[1])) * 180 / Math.PI;
      if (turn < 100) continue;
      // spike height: ignore sub-pixel wiggles, flag real triangles
      const ax = poly[i - 1], bx = poly[i + 1], p = poly[i];
      const dx = bx[0] - ax[0], dy = bx[1] - ax[1], L2 = dx * dx + dy * dy || 1;
      const tt = Math.max(0, Math.min(1, ((p[0] - ax[0]) * dx + (p[1] - ax[1]) * dy) / L2));
      const h = Math.hypot(p[0] - (ax[0] + dx * tt), p[1] - (ax[1] + dy * tt));
      assert.ok(h < 6, `edge folds back: ${turn.toFixed(0)}° height ${h.toFixed(1)}px at ${i}`);
    }
  }
  for (const g of checkpoints(t))
    assert.ok(Math.hypot(g.a[0] - g.b[0], g.a[1] - g.b[1]) <= 120, 'gate wider than road');
});

test('gates never leap to a neighboring road section', () => {
  // S-curve pinched 25px from a straight: gates must stay local (≈ road width)
  const pts: [number, number][] = [];
  for (let y = 0; y <= 400; y += 8) pts.push([0, y]); // straight
  for (let y = 0; y <= 400; y += 8) pts.push([55 + 30 * Math.sin(y / 45), 400 - y]); // S back
  pts.push([0, -120], [-80, -120], [-80, 480], [0, 480]); // far connector
  const t = { id: 'x', name: 'x', centerline: pts, width: 60, startS: 0, closed: true,
    gates: Array.from({ length: 48 }, (_, k) => k / 48) };
  for (const g of checkpoints(t)) {
    const len = Math.hypot(g.a[0] - g.b[0], g.a[1] - g.b[1]);
    assert.ok(len < 100, `gate spans ${len.toFixed(0)}px — leapt sections`);
  }
});

test('manual gates: toggle semantics (sorted fractions, start gate independent)', () => {
  const oval = Array.from({ length: 120 }, (_, i) => {
    const a = (i / 120) * Math.PI * 2;
    return [Math.cos(a) * 200, Math.sin(a) * 120] as [number, number];
  });
  const t = { id: 'x', name: 'x', centerline: oval, width: 60, startS: 0, closed: true, gates: [0.1, 0.5, 0.9] };
  const cps = checkpoints(t);
  assert.equal(cps.length, 3);
  assert.ok(Math.abs(cps[0].s - 12) < 1e-9 && Math.abs(cps[2].s - 108) < 1e-9); // fractions map to arc
  const s0 = gateAt(t, 0.3); // start line anywhere, independent of gates
  assert.ok(Math.abs(s0.s - 0.3 * 120) < 1e-9);
});

test('widthAt interpolates gate widths, falls back to general', () => {
  const base = { id: 'x', name: 'x', centerline: [[0, 0], [10, 0]], width: 60, startS: 0, closed: true, gates: [0, 0.5] as number[], gateWidths: [40, 80] as number[] };
  assert.equal(widthAt(base, 0), 40);
  assert.equal(widthAt(base, 0.5), 80);
  assert.ok(Math.abs(widthAt(base, 0.25) - 60) < 1e-9); // cosine midpoint
  assert.ok(Math.abs(widthAt(base, 0.75) - 60) < 1e-9); // wraps other way
  assert.equal(widthAt({ ...base, gates: [] }, 0.3), 60); // no gates: general
  assert.equal(widthAt({ ...base, gates: [0.2], gateWidths: [44] }, 0.9), 44); // single: constant
});

test('closeLoop keeps overlapped track, fills residual chord evenly', () => {
  // out 500px then back over itself, ending 10px past start: overlap must survive
  const pts: [number, number][] = [[0, 0], [100, 0], [200, 0], [300, 0], [400, 0], [500, 0], [400, 0], [300, 0], [200, 0], [100, 0], [10, 0]];
  const { loop, closed } = closeLoop(pts);
  assert.equal(closed, true);
  assert.equal(loop.length, 11); // old trim ate the doubled-back stretch
  // near-miss gap gets bridged with even spacing (no chord jump)
  const gapped: [number, number][] = [[0, 0], [100, 0], [200, 0], [200, 100], [100, 100], [30, 40]];
  const r2 = closeLoop(gapped);
  assert.equal(r2.closed, true);
  assert.equal(r2.loop.length, 11); // 6 raw + 5 chord fillers
  const step = Math.hypot(r2.loop[6][0] - r2.loop[5][0], r2.loop[6][1] - r2.loop[5][1]);
  assert.ok(step < 12, `chord fill step ${step.toFixed(1)}px at seam`);
});

test('pipeline is deterministic + world-anchor roundtrips exact (save/load cannot drift)', () => {
  // design contract: same strokes in → bit-identical centerline out, so undo,
  // save/load and metadata-only rebuilds never move anything. Dirty-gating in
  // main.ts ensures the pipeline only runs on changed strokes; load adopts
  // the saved centerline verbatim.
  const raw: [number, number][] = [];
  for (let x = 0; x <= 400; x += 8) raw.push([x, 0]);
  for (let y = 0; y <= 200; y += 8) raw.push([400, y]);
  for (let x = 400; x >= 0; x -= 8) raw.push([x, 200]);
  for (let y = 200; y >= 0; y -= 8) raw.push([0, y]);
  const pipe = (pts: [number, number][]) => {
    const rs = resample(pts, 8, false);
    const { loop } = closeLoop(rs);
    return blendSeam(smooth(loop));
  };
  assert.deepEqual(pipe(raw), pipe(raw)); // deterministic: same in, same out
  const center = pipe(raw);
  for (const fr of [0.05, 0.3, 0.55, 0.8]) {
    const w = pointAt(center, true, fr);
    const back = pointAt(center, true, projectFraction(center, true, w));
    assert.ok(Math.hypot(back[0] - w[0], back[1] - w[1]) < 1e-9, `anchor roundtrip moved ${fr}`);
  }
  const file = JSON.parse(JSON.stringify({ centerline: center, gates: [0.05, 0.3], gateWidths: [60, 60] }));
  assert.deepEqual(file.centerline, center); // save/load preserves values bit-exactly
  assert.deepEqual(file.gates, [0.05, 0.3]);
});


test('segOverlapsExisting: dense raw bridges pass both ways, true crossings caught', () => {
  // regresses the red-green join bug: point-count exclusion zones assumed 8px
  // spacing, but live hand strokes are ~3px — the attach dot alone tripped red.
  // exclusion is now world-space around the stroke's own ends: direction-free.
  const committed: [number, number][] = [];
  for (let x = 0; x <= 300; x += 3) committed.push([x, 0]);
  for (let y = 3; y <= 300; y += 3) committed.push([300, y]);
  const w = 20;
  const head = committed[0], tail = committed[committed.length - 1];
  assert.ok(dist(head, tail) > 400, 'fixture needs a real gap');
  assert.equal(segOverlapsExisting(committed, sampleLine(tail, head), w), false);
  assert.equal(segOverlapsExisting(committed, sampleLine(head, tail), w), false);
  // a genuine mid-track crossing is still flagged
  assert.equal(segOverlapsExisting(committed, sampleLine([150, 80], [150, -80]), w), true);
  // degenerate inputs never flag
  assert.equal(segOverlapsExisting(committed, [[0, 0], [1, 1]], w), false);
  assert.equal(segOverlapsExisting([], sampleLine([0, 0], [0, 100]), w), false);
});

test('skeleton: ring mask thins to a clean loop', () => {
  const W = 60, H = 60;
  const data = new Uint8ClampedArray(W * H * 4);
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const d = Math.hypot(x - 29.5, y - 29.5);
      const on = d > 17 && d < 23 ? 255 : 0; // 6px thick ring
      const i = (y * W + x) * 4;
      data[i] = data[i + 1] = data[i + 2] = on;
      data[i + 3] = 255;
    }
  }
  const mask = largestComponent(buildMask(data, W, H), W, H);
  thin(mask, W, H);
  simplifySkeleton(mask, W, H);
  prune(mask, W, H);
  let count = 0, baddeg = 0;
  const deg = (i: number) => {
    const x = i % W, y = (i / W) | 0;
    let c = 0;
    for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
      if (!dx && !dy) continue;
      const nx = x + dx, ny = y + dy;
      if (nx >= 0 && ny >= 0 && nx < W && ny < H && mask[ny * W + nx]) c++;
    }
    return c;
  };
  for (let i = 0; i < W * H; i++) if (mask[i]) { count++; if (deg(i) > 2) baddeg++; }
  assert.ok(count > 50, `skeleton too small: ${count}`);
  assert.equal(baddeg, 0, 'skeleton has junctions after rail collapse');
  const loop = traceLoop(mask, W, H);
  assert.ok(loop.length > count * 0.9, `trace covered ${loop.length}/${count}`);
  assert.ok(Math.hypot(loop[0][0] - loop[loop.length - 1][0], loop[0][1] - loop[loop.length - 1][1]) < 2, 'loop not closed');
});

test('skeleton: spur stub pruned, alpha + opaque masks detected', () => {
  const W = 60, H = 60;
  const data = new Uint8ClampedArray(W * H * 4);
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const d = Math.hypot(x - 29.5, y - 29.5);
      let on = d > 17 && d < 23 ? 255 : 0;
      if (y === 29 && x >= 47 && x < 57) on = 255; // 10px spur sticking out
      const i = (y * W + x) * 4;
      data[i] = data[i + 1] = data[i + 2] = on;
      data[i + 3] = 255;
    }
  }
  const mask = largestComponent(buildMask(data, W, H), W, H);
  thin(mask, W, H);
  prune(mask, W, H, 12);
  const loop = traceLoop(mask, W, H);
  for (const [x, y] of loop) assert.ok(x < 55, `trace followed spur to ${x},${y}`);
});

test('skeleton: even-width bar simplifies to one rail', () => {
  const W = 60, H = 20;
  const mask = new Uint8Array(W * H);
  for (let y = 5; y < 15; y++) for (let x = 10; x < 50; x++) mask[y * W + x] = 1; // 10px even bar
  thin(mask, W, H);
  simplifySkeleton(mask, W, H);
  let count = 0, bad = 0;
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    if (!mask[y * W + x]) continue;
    count++;
    let c = 0;
    for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
      if (!dx && !dy) continue;
      const nx = x + dx, ny = y + dy;
      if (nx >= 0 && ny >= 0 && nx < W && ny < H && mask[ny * W + nx]) c++;
    }
    if (c > 2) bad++;
  }
  assert.ok(count >= 30 && count <= 50, `single rail ~40px, got ${count}`);
  assert.equal(bad, 0, 'rail still double');
});

test('skeleton: branch decoration stripped to ring, open line returns empty', () => {
  const W = 40, H = 40;
  const ring = (): Uint8Array => {
    const m = new Uint8Array(W * H);
    for (let a = 0; a < 360; a++) {
      const t = (a / 360) * Math.PI * 2;
      m[Math.round(20 + 14 * Math.cos(t)) + Math.round(20 + 14 * Math.sin(t)) * W] = 1;
    }
    return m;
  };
  const withBranch = ring();
  for (let x = 35; x < 40; x++) withBranch[20 * W + x] = 1; // outward stalk, attached only at ring x=34
  assert.ok(extractCore(withBranch, W, H) > 40, 'ring must survive branch stripping');
  assert.equal(withBranch[20 * W + 39], 0, 'stalk tip must be stripped');
  assert.equal(withBranch[20 * W + 34], 1, 'ring attachment must survive');
  const open = new Uint8Array(W * H);
  for (let x = 5; x < 35; x++) open[20 * W + x] = 1; // open 1px line: no cycle
  assert.equal(extractCore(open, W, H), 0, 'open line must strip to nothing');
});
