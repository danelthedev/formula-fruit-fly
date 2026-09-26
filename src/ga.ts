import { mulberry32, runEpisode } from './sim.ts';
import type { Control, EpisodeResult, TrackIndex } from './sim.ts';
import { actObs, mutateGenome, randomGenome, setGenome } from './nn.ts';
import type { GenomeNet } from './nn.ts';
import type { PhysicsParams } from './teams.ts';

// ---- Genetic algorithm, one population per team (Story 3) ----
// Sequential evaluation, shared model, elitism + tournament + gaussian mutate.
// Async with periodic yields so the UI stays alive mid-epoch.
export interface GAConfig {
  popSize: number; elite: number; sigma: number;
  episodes: number; timeout: number; laps: number;
}
export const DEFAULT_GA: GAConfig = {
  popSize: 64, elite: 4, sigma: 0.05, episodes: 3, timeout: 30, laps: 1,
};

export function fitnessOf(r: EpisodeResult): number {
  let f = r.progress * 1000;
  if (r.done === 'crash') f -= 50;
  if (r.done === 'lap') f += 200;
  f += (Math.max(0, r.progress) / Math.max(r.time, 1e-3)) * 20; // speed bonus
  return f;
}

export function initPop(net: GenomeNet, n: number, seed: number): Float32Array[] {
  const rand = mulberry32(seed);
  return Array.from({ length: n }, () => randomGenome(net, rand));
}

export interface EpochResult {
  pop: Float32Array[]; best: Float32Array; bestFitness: number; avgFitness: number;
  partial: boolean; // stopped early: pop/best carried over, epoch not counted
}

const tick = () => new Promise<void>((res) => setTimeout(res, 0));

export async function runEpoch(
  idx: TrackIndex,
  phys: PhysicsParams,
  net: GenomeNet,
  pop: Float32Array[],
  cfg: GAConfig,
  seed: number,
  shouldStop?: () => boolean,
): Promise<EpochResult> {
  const stopped = () => shouldStop?.() ?? false;
  const scored: { g: Float32Array; f: number }[] = [];
  for (let i = 0; i < pop.length; i++) {
    if (stopped()) break;
    setGenome(net, pop[i]);
    let f = 0;
    for (let e = 0; e < cfg.episodes; e++) {
      const policy = (obs: number[]): Control => actObs(net, obs);
      f += fitnessOf(await runEpisode(idx, phys, policy, { laps: cfg.laps, maxTime: cfg.timeout }));
    }
    scored.push({ g: pop[i], f: f / cfg.episodes });
    if (i % 8 === 7) await tick();
  }
  if (!scored.length) return { pop, best: pop[0].slice(), bestFitness: -Infinity, avgFitness: -Infinity, partial: true };
  scored.sort((a, b) => b.f - a.f);
  const rand = mulberry32(seed);
  const next: Float32Array[] = scored.slice(0, cfg.elite).map((s) => s.g.slice());
  while (next.length < pop.length) {
    // tournament of 3
    let w = scored[(rand() * scored.length) | 0];
    for (let k = 0; k < 2; k++) {
      const c = scored[(rand() * scored.length) | 0];
      if (c.f > w.f) w = c;
    }
    next.push(mutateGenome(w.g, cfg.sigma, rand));
    if (next.length % 8 === 0) await tick();
  }
  const avg = scored.reduce((a, s) => a + s.f, 0) / scored.length;
  if (stopped()) return { pop: next, best: scored[0].g.slice(), bestFitness: scored[0].f, avgFitness: avg, partial: true };
  return { pop: next, best: scored[0].g.slice(), bestFitness: scored[0].f, avgFitness: avg, partial: false };
}
