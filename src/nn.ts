// ---- Genome NN (Story 3: GA training). Plain-JS MLP 16→64→64→3:
// throttle/brake sigmoid, steer tanh. No TF.js: the GA never backpropagates,
// and one forward pass per sim step must stay in the microsecond range
// (TF.js cost ~0.1ms/step in blocking GPU readbacks alone).
// Genome layout mirrors the old TF dense order (kernel row-major [in][out],
// then bias, layer by layer) so weights saved by earlier versions load unchanged.
import type { Control } from './sim.ts';

export interface GenomeNet { size: number }
export const NET_ARCH = [16, 64, 64, 3];

const [N_IN, N_H1, N_H2, N_OUT] = NET_ARCH;
const W1 = 0;
const B1 = W1 + N_IN * N_H1;
const W2 = B1 + N_H1;
const B2 = W2 + N_H1 * N_H2;
const W3 = B2 + N_H2;
const B3 = W3 + N_H2 * N_OUT;
export const GENOME_SIZE = B3 + N_OUT; // 5443

export function buildNet(): GenomeNet {
  return { size: GENOME_SIZE };
}

export function randomGenome(net: GenomeNet, rand: () => number): Float32Array {
  const g = new Float32Array(net.size);
  for (let i = 0; i < g.length; i++) g[i] = (rand() * 2 - 1) * 0.5;
  return g;
}

// Forward pass with output activations. Hot path: no allocation but two
// small hidden arrays, ~5.4K FMA, single-digit microseconds.
export function forwardGenome(g: ArrayLike<number>, obs: ArrayLike<number>): Control {
  const h1 = new Array<number>(N_H1);
  for (let j = 0; j < N_H1; j++) {
    let s = g[B1 + j];
    for (let i = 0; i < N_IN; i++) s += obs[i] * g[W1 + i * N_H1 + j];
    h1[j] = s > 0 ? s : 0;
  }
  const h2 = new Array<number>(N_H2);
  for (let j = 0; j < N_H2; j++) {
    let s = g[B2 + j];
    for (let i = 0; i < N_H1; i++) s += h1[i] * g[W2 + i * N_H2 + j];
    h2[j] = s > 0 ? s : 0;
  }
  let o0 = g[B3], o1 = g[B3 + 1], o2 = g[B3 + 2];
  for (let i = 0; i < N_H2; i++) {
    const h = h2[i], k = W3 + i * N_OUT;
    o0 += h * g[k];
    o1 += h * g[k + 1];
    o2 += h * g[k + 2];
  }
  return [
    1 / (1 + Math.exp(-o0)),
    1 / (1 + Math.exp(-o1)),
    Math.tanh(o2),
  ];
}

// Add gaussian noise (Box-Muller from the seeded rng): deterministic per seed.
export function mutateGenome(g: Float32Array, sigma: number, rand: () => number): Float32Array {
  const out = new Float32Array(g.length);
  for (let i = 0; i < g.length; i += 2) {
    const u1 = Math.max(rand(), 1e-9), u2 = rand();
    const r = Math.sqrt(-2 * Math.log(u1)), t = 2 * Math.PI * u2;
    out[i] = g[i] + r * Math.cos(t) * sigma;
    if (i + 1 < g.length) out[i + 1] = g[i + 1] + r * Math.sin(t) * sigma;
  }
  return out;
}

// Reintroduce brake expression: copy genome with brake output bias boosted.
// Used for restart immigrants so crossover can combine braking with learned
// steering when the whole population has converged to never braking.
export function withBrakeBias(g: Float32Array, amount: number): Float32Array {
  const out = g.slice();
  out[B3 + 1] += amount;
  return out;
}

// Weights file format (IDB + JSON export/import). Arch tag guards mismatches.
// v2 = real-rate physics generation (engine/brake/grip/latA retune): v1 genomes
// assumed instant response and un-limited yaw, so they drive off the road now.
export interface WeightsFile { v: 2; teamId: string; teamName: string; arch: number[]; weights: number[] }
export function encodeWeightsFile(teamId: string, teamName: string, genome: Float32Array | number[]): WeightsFile {
  return { v: 2, teamId, teamName, arch: NET_ARCH.slice(), weights: [...genome] };
}
export function decodeWeightsFile(o: unknown, genomeSize: number): WeightsFile | null {
  if (!o || typeof o !== 'object') return null;
  const r = o as Record<string, unknown>;
  if (r.v !== 2 || typeof r.teamId !== 'string' || typeof r.teamName !== 'string') return null;
  if (!Array.isArray(r.arch) || r.arch.join(',') !== NET_ARCH.join(',')) return null;
  if (!Array.isArray(r.weights) || r.weights.length !== genomeSize) return null;
  if (!(r.weights as unknown[]).every((w) => typeof w === 'number' && Number.isFinite(w))) return null;
  return { v: 2, teamId: r.teamId, teamName: r.teamName, arch: NET_ARCH.slice(), weights: (r.weights as number[]).slice() };
}
