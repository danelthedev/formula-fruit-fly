import type { Pt } from './track.ts';

// Raster track image → ordered centerline loop. Pure functions over pixel masks
// (no DOM); main.ts handles file loading, canvas raster and coordinate mapping.
// Pipeline: buildMask → largestComponent → thin (Zhang-Suen) → prune → traceLoop.

function lum(r: number, g: number, b: number): number {
  return 0.299 * r + 0.587 * g + 0.114 * b;
}

// Binary track mask from RGBA pixels. Transparent background → alpha test;
// opaque image (jpg) → pixels far from the border median luminance.
export function buildMask(data: Uint8ClampedArray, w: number, h: number): Uint8Array {
  const n = w * h;
  let transparent = 0;
  for (let i = 3; i < data.length; i += 16) if (data[i] < 128) transparent++;
  const mask = new Uint8Array(n);
  if (transparent > n / 64) {
    for (let i = 0; i < n; i++) mask[i] = data[i * 4 + 3] >= 128 ? 1 : 0;
    return mask;
  }
  const border: number[] = [];
  for (let x = 0; x < w; x++) {
    border.push(lum(data[x * 4], data[x * 4 + 1], data[x * 4 + 2]));
    border.push(lum(data[(w * (h - 1) + x) * 4], data[(w * (h - 1) + x) * 4 + 1], data[(w * (h - 1) + x) * 4 + 2]));
  }
  for (let y = 0; y < h; y++) {
    border.push(lum(data[(y * w) * 4], data[(y * w) * 4 + 1], data[(y * w) * 4 + 2]));
    border.push(lum(data[(y * w + w - 1) * 4], data[(y * w + w - 1) * 4 + 1], data[(y * w + w - 1) * 4 + 2]));
  }
  border.sort((a, b) => a - b);
  const bg = border[Math.floor(border.length / 2)];
  for (let i = 0; i < n; i++) {
    const l = lum(data[i * 4], data[i * 4 + 1], data[i * 4 + 2]);
    mask[i] = Math.abs(l - bg) > 48 ? 1 : 0;
  }
  return mask;
}

// Keep only the largest connected component (drops jpeg speckle / stray marks).
// 4-connected by default; pass eight=true for thin skeletons (diagonal
// staircases are 8- but not 4-connected).
export function largestComponent(mask: Uint8Array, w: number, h: number, eight = false): Uint8Array {
  const seen = new Uint8Array(w * h);
  let best: number[] = [];
  const stack: number[] = [];
  for (let s = 0; s < w * h; s++) {
    if (!mask[s] || seen[s]) continue;
    const comp: number[] = [];
    stack.push(s);
    seen[s] = 1;
    while (stack.length) {
      const i = stack.pop()!;
      comp.push(i);
      const x = i % w, y = (i / w) | 0;
      const nbrs: number[] = [];
      if (x > 0) nbrs.push(i - 1);
      if (x < w - 1) nbrs.push(i + 1);
      if (y > 0) nbrs.push(i - w);
      if (y < h - 1) nbrs.push(i + w);
      if (eight) {
        if (x > 0 && y > 0) nbrs.push(i - w - 1);
        if (x < w - 1 && y > 0) nbrs.push(i - w + 1);
        if (x > 0 && y < h - 1) nbrs.push(i + w - 1);
        if (x < w - 1 && y < h - 1) nbrs.push(i + w + 1);
      }
      for (const ni of nbrs) if (mask[ni] && !seen[ni]) { seen[ni] = 1; stack.push(ni); }
    }
    if (comp.length > best.length) best = comp;
  }
  const out = new Uint8Array(w * h);
  for (const i of best) out[i] = 1;
  return out;
}

const N8 = [[1, 0], [1, 1], [0, 1], [-1, 1], [-1, 0], [-1, -1], [0, -1], [1, -1]];

// Zhang-Suen thinning, in place. Reduces the track blob to a 1px skeleton.
export function thin(mask: Uint8Array, w: number, h: number): void {
  const del = new Uint8Array(w * h);
  const neighbours = (x: number, y: number): number[] => {
    const out: number[] = [];
    for (const [dx, dy] of N8) {
      const nx = x + dx, ny = y + dy;
      out.push(nx < 0 || ny < 0 || nx >= w || ny >= h ? 0 : mask[ny * w + nx]);
    }
    return out;
  };
  for (let iter = 0; iter < w * h; iter++) {
    let removed = 0;
    for (let step = 0; step < 2; step++) {
      del.fill(0);
      for (let y = 1; y < h - 1; y++) {
        for (let x = 1; x < w - 1; x++) {
          const i = y * w + x;
          if (!mask[i]) continue;
          const nb = neighbours(x, y);
          const nz = nb.reduce((a, b) => a + b, 0);
          if (nz < 2 || nz > 6) continue;
          let trans = 0;
          for (let k = 0; k < 8; k++) if (nb[k] === 0 && nb[(k + 1) % 8] === 1) trans++;
          if (trans !== 1) continue;
          // N,E,S,W cross in this ring's rotated order lives at indices 6,0,2,4.
          if (step === 0) {
            if (nb[6] * nb[0] * nb[2] !== 0 || nb[0] * nb[2] * nb[4] !== 0) continue;
          } else if (nb[6] * nb[0] * nb[4] !== 0 || nb[6] * nb[2] * nb[4] !== 0) continue;
          del[i] = 1;
          removed++;
        }
      }
      for (let i = 0; i < w * h; i++) if (del[i]) mask[i] = 0;
    }
    if (!removed) break;
  }
}

// Strip short spur branches (endpoints eaten back N rounds). Closed loops have
// no endpoints so they pass through untouched; open ends lose N px (fine).
export function prune(mask: Uint8Array, w: number, h: number, rounds = 10): void {
  const deg = (i: number): number => {
    const x = i % w, y = (i / w) | 0;
    let c = 0;
    for (const [dx, dy] of N8) {
      const nx = x + dx, ny = y + dy;
      if (nx >= 0 && ny >= 0 && nx < w && ny < h && mask[ny * w + nx]) c++;
    }
    return c;
  };
  for (let r = 0; r < rounds; r++) {
    const ends: number[] = [];
    for (let i = 0; i < w * h; i++) if (mask[i] && deg(i) <= 1) ends.push(i);
    if (!ends.length) break;
    for (const i of ends) mask[i] = 0;
  }
}

// Strip all tree branches down to the 2-core (queue-based leaf stripping).
// Branch decorations (start gantries, pit stubs, thinning barbs) attach to the
// ring by a stalk and vanish completely; the closed ring has no endpoints so
// it survives untouched. Returns remaining pixel count (0 = open curve/track
// with a gap: caller should fall back to plain walk instead).
export function extractCore(mask: Uint8Array, w: number, h: number): number {
  const deg = (i: number): number => {
    const x = i % w, y = (i / w) | 0;
    let c = 0;
    for (const [dx, dy] of N8) {
      const nx = x + dx, ny = y + dy;
      if (nx >= 0 && ny >= 0 && nx < w && ny < h && mask[ny * w + nx]) c++;
    }
    return c;
  };
  const queue: number[] = [];
  let remaining = 0;
  for (let i = 0; i < w * h; i++) {
    if (!mask[i]) continue;
    remaining++;
    if (deg(i) <= 1) queue.push(i);
  }
  while (queue.length) {
    const i = queue.pop()!;
    if (!mask[i]) continue;
    const x = i % w, y = (i / w) | 0;
    mask[i] = 0;
    remaining--;
    for (const [dx, dy] of N8) {
      const nx = x + dx, ny = y + dy;
      if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
      const ni = ny * w + nx;
      if (mask[ni] && deg(ni) <= 1) queue.push(ni);
    }
  }
  return remaining;
}


// Delete topologically redundant skeleton pixels: those whose set neighbors
// already connect around them (single 8-connected component, 2+ neighbors).
// This collapses 2-wide rails of ANY orientation to 1px — greedy tracing needs
// single rails, and axis-only rules miss diagonal doubles. Sequential scan with
// immediate updates (top-to-bottom rows keep south/east rails consistently);
// endpoints (|F|<2) are always preserved. Iterate to convergence.
export function simplifySkeleton(mask: Uint8Array, w: number, h: number): void {
  const adj8 = (a: number, b: number, c: number, d: number) => Math.abs(a - c) <= 1 && Math.abs(b - d) <= 1;
  for (let round = 0; round < 8; round++) {
    let removed = 0;
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const i = y * w + x;
        if (!mask[i]) continue;
        const F: number[] = [];
        for (const [dx, dy] of N8) {
          const nx = x + dx, ny = y + dy;
          if (nx >= 0 && ny >= 0 && nx < w && ny < h && mask[ny * w + nx]) F.push(ny * w + nx);
        }
        if (F.length < 2) continue;
        const seen = new Set<number>([0]);
        const stack = [0];
        while (stack.length) {
          const k = stack.pop()!;
          const kx = F[k] % w, ky = ((F[k] / w) | 0);
          for (let m = 0; m < F.length; m++) {
            if (seen.has(m)) continue;
            if (adj8(kx, ky, F[m] % w, (F[m] / w) | 0)) { seen.add(m); stack.push(m); }
          }
        }
        if (seen.size === F.length) { mask[i] = 0; removed++; }
      }
    }
    if (!removed) break;
  }
}

// Walk the skeleton into an ordered loop (pixel centers). Straight-preference
// keeps it on the ring through leftover junctions; short jumps bridge 2-wide
// rails and speckle gaps that would otherwise dead-end the walk. Returns []
// if trivial.
const TRACE_JUMP = 3;
export function traceLoop(mask: Uint8Array, w: number, h: number): Pt[] {
  const n = w * h;
  let start = -1;
  for (let i = 0; i < n; i++) if (mask[i]) { start = i; break; }
  if (start < 0) return [];
  const at = (i: number): Pt => [i % w + 0.5, ((i / w) | 0) + 0.5];
  const seen = new Uint8Array(n);
  const nearUnseen = (x: number, y: number, r: number): number => {
    let bi = -1, bd = Infinity;
    for (let dy = -r; dy <= r; dy++) for (let dx = -r; dx <= r; dx++) {
      if (!dx && !dy) continue;
      const nx = x + dx, ny = y + dy;
      if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
      const ni = ny * w + nx;
      if (!mask[ni] || seen[ni]) continue;
      const d = dx * dx + dy * dy;
      if (d < bd) { bd = d; bi = ni; }
    }
    return bi;
  };
  const out: Pt[] = [];
  let cur = start, px = -2, py = 0;
  for (let step = 0; step < n + 1; step++) {
    out.push(at(cur));
    seen[cur] = 1;
    const x = cur % w, y = (cur / w) | 0;
    let bi = -1, bd = -2;
    for (const [dx, dy] of N8) {
      const nx = x + dx, ny = y + dy;
      if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
      const ni = ny * w + nx;
      if (!mask[ni] || seen[ni]) continue;
      const d = dx * px + dy * py; // prefer going straight
      if (d > bd) { bd = d; bi = ni; }
    }
    if (bi >= 0) {
      px = Math.sign((bi % w) - x);
      py = Math.sign(((bi / w) | 0) - y);
      cur = bi;
      if (cur === start && out.length > 8) break;
      continue;
    }
    // dead end: close if back at start, else jump to nearby unseen skeleton
    const sx = start % w, sy = (start / w) | 0;
    if (out.length > 8 && Math.hypot(x - sx, y - sy) <= TRACE_JUMP) break;
    const jump = nearUnseen(x, y, TRACE_JUMP);
    if (jump < 0) break;
    px = Math.sign((jump % w) - x);
    py = Math.sign(((jump / w) | 0) - y);
    cur = jump;
  }
  return out.length >= 8 ? out : [];
}
