import * as tf from '@tensorflow/tfjs';
import type { Control } from './sim.ts';

// ---- NN genome utils (Story 3: GA training). MLP 16→64→64→3 per initial_plan:
// throttle/brake sigmoid, steer tanh. One shared model; genomes swapped in.
export interface GenomeNet { model: tf.Sequential; size: number }

export function buildNet(): GenomeNet {
  const model = tf.sequential();
  model.add(tf.layers.dense({ units: 64, activation: 'relu', inputShape: [16] }));
  model.add(tf.layers.dense({ units: 64, activation: 'relu' }));
  model.add(tf.layers.dense({ units: 3 }));
  let size = 0;
  for (const w of model.getWeights()) size += w.size;
  return { model, size };
}

export function randomGenome(net: GenomeNet, rand: () => number): Float32Array {
  const g = new Float32Array(net.size);
  for (let i = 0; i < g.length; i++) g[i] = (rand() * 2 - 1) * 0.5;
  return g;
}

export function setGenome(net: GenomeNet, g: Float32Array): void {
  const ws = net.model.getWeights();
  const tensors: tf.Tensor[] = [];
  let o = 0;
  for (const w of ws) {
    tensors.push(tf.tensor(g.slice(o, o + w.size), w.shape as number[]));
    o += w.size;
  }
  net.model.setWeights(tensors);
  for (const t of tensors) t.dispose();
}

export function getGenome(net: GenomeNet): Float32Array {
  const out = new Float32Array(net.size);
  let o = 0;
  for (const w of net.model.getWeights()) {
    out.set(w.dataSync() as Float32Array, o);
    o += w.size;
  }
  return out;
}

// Forward pass with output activations; tidy-wrapped (no leak per call).
export function actObs(net: GenomeNet, obs: number[]): Control {
  return tf.tidy(() => {
    const y = net.model.predict(tf.tensor2d([obs])) as tf.Tensor;
    const v = y.dataSync();
    return [
      1 / (1 + Math.exp(-v[0])),
      1 / (1 + Math.exp(-v[1])),
      Math.tanh(v[2]),
    ] as Control;
  });
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

// Weights file format (IDB + JSON export/import). Arch tag guards mismatches.
export interface WeightsFile { v: 1; teamId: string; teamName: string; arch: number[]; weights: number[] }
export const NET_ARCH = [16, 64, 64, 3];
export function encodeWeightsFile(teamId: string, teamName: string, genome: Float32Array | number[]): WeightsFile {
  return { v: 1, teamId, teamName, arch: NET_ARCH.slice(), weights: [...genome] };
}
export function decodeWeightsFile(o: unknown, genomeSize: number): WeightsFile | null {
  if (!o || typeof o !== 'object') return null;
  const r = o as Record<string, unknown>;
  if (r.v !== 1 || typeof r.teamId !== 'string' || typeof r.teamName !== 'string') return null;
  if (!Array.isArray(r.arch) || r.arch.join(',') !== NET_ARCH.join(',')) return null;
  if (!Array.isArray(r.weights) || r.weights.length !== genomeSize) return null;
  if (!(r.weights as unknown[]).every((w) => typeof w === 'number' && Number.isFinite(w))) return null;
  return { v: 1, teamId: r.teamId, teamName: r.teamName, arch: NET_ARCH.slice(), weights: (r.weights as number[]).slice() };
}

export function disposeNet(net: GenomeNet): void {
  net.model.dispose();
}
