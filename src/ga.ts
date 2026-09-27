import { mulberry32, runEpisode, sampleSpawnFrac } from './sim.ts';
import type { Control, EpisodeResult, TrackIndex } from './sim.ts';
import { forwardGenome, mutateGenome, randomGenome } from './nn.ts';
import type { GenomeNet } from './nn.ts';
import type { PhysicsParams } from './teams.ts';

// ---- Genetic algorithm, one population per team (Story 3) ----
// Sequential evaluation, shared model, elitism + tournament + gaussian mutate.
// Async with periodic yields so the UI stays alive mid-epoch.
export interface GAConfig {
  popSize: number; elite: number; sigma: number;
  episodes: number; timeout: number; laps: number;
  crossoverRate: number; // 0.7 explore: uniform crossover; 0 finalize: pure mutation
  robust: boolean; // false: select on mean over episodes; true: worst episode (robust lappers)
  spawnFocus?: number | null; // curriculum: non-start episodes spawn at this frac (±0.02 jitter) instead of sampled corners
}
export const DEFAULT_GA: GAConfig = {
  popSize: 32, elite: 4, sigma: 0.05, episodes: 2, timeout: 20, laps: 1,
  crossoverRate: 0.7, robust: false,
};

export function fitnessOf(r: EpisodeResult): number {
  // Rate-first selection: progress alone crowns crawlers (further, slower, always
  // wins). Rate (ground covered per second) is what racing actually maximizes;
  // progress breaks ties, laps dominate everything.
  let f = r.progress * 1000;
  if (r.done !== 'lap') f -= 100; // crash or timeout: didn't finish
  // deceleration bonus: slowed down right before trouble (genuine corner approach).
  // Uses the ~1s-ago speed baseline, so only late braking earns it — braking
  // mid-straight shows no last-second drop, and crawlers never go fast to begin with.
  if (r.done === 'crash') f += r.decel;
  if (r.done === 'lap') f += 300 + Math.max(0, 30 - r.time) * 10; // finishing matters, finishing fast matters more
  f += (Math.max(0, r.progress) / Math.max(r.time, 1e-3)) * 2000;
  // smoothness penalty: chattering full-lock steering weaves down straights and
  // exits sweepers. Mean |Δsteer| ~1.8 chattering vs ~0.1 smooth.
  f -= (r.jitter ?? 0) * 60;
  return f;
}

// Adaptive mutation: cool down when improving (fine-tune), heat up when stuck
// (escape ruts). Pure: decided per completed epoch from the stasis count.
export function adaptSigma(sigma: number, base: number, improved: boolean, stasis: number): number {
  if (improved) return Math.max(base * 0.5, sigma * 0.7);
  return Math.min(0.15, base * (1 + stasis * 0.5)); // 0.3 scrambled whole genomes; 0.15 still explores hard
}

// Stagnation restart: fresh local search around the champion. Heating sigma
// forever just scrambles (28/32 children random, elites frozen) — re-rolling
// near-best diversity breaks the pinned-at-cap trap.
export function restartPop(best: Float32Array, popSize: number, sigma: number, rand: () => number): Float32Array[] {
  return [best.slice(), ...Array.from({ length: Math.max(0, popSize - 1) }, () => mutateGenome(best, sigma, rand))];
}

// Island-model migration (ring): each island receives a copy of the previous
// island's champion, replacing a random non-elite member. Lets strong lineages
// spread without collapsing diversity. Pure + deterministic. No-op when an
// island has no best yet or no room past elites.
export function migrateIslands(pops: Float32Array[][], bests: (Float32Array | null)[], elite: number, rand: () => number): void {
  const n = pops.length;
  if (n < 2) return;
  const incoming = bests.map((b) => b?.slice() ?? null);
  for (let i = 0; i < n; i++) {
    const donor = incoming[(i - 1 + n) % n];
    const pop = pops[i];
    const first = Math.max(0, elite);
    if (!donor || pop.length <= first) continue;
    pop[first + ((rand() * (pop.length - first)) | 0)] = donor;
  }
}

// Timeout scaled to track length at learning pace (~35px/s with real accel
// rates: the 0-vMax ramp takes ~3s now): cautious genomes need ~2x the time
// of fast ones; cutting them off removes all gradient toward finishing.
export function epochTimeout(totalPx: number, laps: number): number {
  if (!Number.isFinite(totalPx) || totalPx <= 0) return 40;
  return Math.min(150, Math.max(40, (totalPx / 35) * Math.max(1, laps)));
}

// Uniform crossover: per-weight pick from either parent (seeded). Pure.
export function crossover(a: Float32Array, b: Float32Array, rand: () => number): Float32Array {
  const out = new Float32Array(a.length);
  for (let i = 0; i < out.length; i++) out[i] = rand() < 0.5 ? a[i] : b[i];
  return out;
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
// Episode aggregation: mean rewards peak one-offs (lucky spawns); worst-episode
// rewards genomes that lap from every spawn — the finalize objective. Pure.
export function aggregateEpisodes(fits: number[], robust: boolean): number {
  if (!fits.length) return -Infinity;
  return robust ? Math.min(...fits) : fits.reduce((a, f) => a + f, 0) / fits.length;
}
export async function runEpoch(
  idx: TrackIndex,
  phys: PhysicsParams,
  pop: Float32Array[],
  cfg: GAConfig,
  seed: number,
  shouldStop?: () => boolean,
): Promise<EpochResult> {
  const stopped = () => shouldStop?.() ?? false;
  const scored: { g: Float32Array; f: number }[] = [];
  // Shared spawn plan per epoch: episode 0 launches from the start line, the
  // rest start at the same corner-biased spots for every genome — comparable
  // scores, corners practiced (where learning happens), no spawn dependence.
  // Corner spawns lead back ~1.5s of travel at spawn speed: the car approaches
  // the corner instead of materializing inside it (unrecoverable = pure noise).
  const rand = mulberry32(seed);
  const leadFrac = (phys.vMax * 0.75 * 1.5) / idx.total;
  const spawnFracs = Array.from({ length: cfg.episodes }, (_, e) => {
    if (e === 0) return null;
    const fr = cfg.spawnFocus != null
      ? cfg.spawnFocus + (rand() - 0.5) * 0.04
      : sampleSpawnFrac(idx, rand);
    return (((fr - leadFrac) % 1) + 1) % 1;
  }) as (number | null)[];
  for (let i = 0; i < pop.length; i++) {
    if (stopped()) break;
    const g = pop[i];
    const fits: number[] = [];
    for (let e = 0; e < cfg.episodes; e++) {
      const policy = (obs: number[]): Control => forwardGenome(g, obs);
      fits.push(fitnessOf(await runEpisode(idx, phys, policy, { laps: cfg.laps, maxTime: cfg.timeout, spawnFrac: spawnFracs[e], spawnSpeed: spawnFracs[e] == null ? 0 : phys.vMax * 0.35 })));
    }
    scored.push({ g: pop[i], f: aggregateEpisodes(fits, cfg.robust) });
    if (i % 8 === 7) await tick();
  }
  if (!scored.length) return { pop, best: pop[0].slice(), bestFitness: -Infinity, avgFitness: -Infinity, partial: true };
  scored.sort((a, b) => b.f - a.f); // rand (seeded above) continues into tournaments: fully deterministic
  const next: Float32Array[] = scored.slice(0, cfg.elite).map((s) => s.g.slice());
  const pick = () => {
    // tournament of 3
    let w = scored[(rand() * scored.length) | 0];
    for (let k = 0; k < 2; k++) {
      const c = scored[(rand() * scored.length) | 0];
      if (c.f > w.f) w = c;
    }
    return w.g;
  };
  while (next.length < pop.length) {
    // 70% uniform crossover (combine sub-skills) + 30% asexual (fine-tune without
    // shattering co-adapted weights): all-crossover churns too hard to converge
    // precise maneuvers like hairpin entries.
    const child = rand() < cfg.crossoverRate ? crossover(pick(), pick(), rand) : pick().slice();
    next.push(mutateGenome(child, cfg.sigma, rand));
    if (next.length % 8 === 0) await tick();
  }
  const avg = scored.reduce((a, s) => a + s.f, 0) / scored.length;
  if (stopped()) return { pop: next, best: scored[0].g.slice(), bestFitness: scored[0].f, avgFitness: avg, partial: true };
  return { pop: next, best: scored[0].g.slice(), bestFitness: scored[0].f, avgFitness: avg, partial: false };
}
