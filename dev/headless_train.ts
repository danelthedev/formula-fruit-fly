import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { makeTrackIndex, mulberry32 } from '../src/sim.ts';
import { buildNet, randomGenome, mutateGenome } from '../src/nn.ts';
import { runEpoch, adaptSigma, restartPop, epochTimeout, DEFAULT_GA } from '../src/ga.ts';
import { withBrakeBias } from '../src/nn.ts';
import type { GAConfig } from '../src/ga.ts';
import { physicsFor, blankTeam } from '../src/teams.ts';
import type { Track } from '../src/track.ts';

// Mirrors trainOneEpoch in main.ts (minus UI/workers/storage).
const trackName = process.argv[2] ?? 'Portimao GP.json';
const epochs = Number(process.argv[3] ?? 40);
const resume = process.argv[4] ?? '';
const seedFrom = process.argv[5] ?? '';
const track = JSON.parse(readFileSync(`/home/danel/Projects/racing_sim/assets/tracks/${trackName}`, 'utf8')) as Track;
const idx = makeTrackIndex(track);
const turnSpec = Number(process.argv[9] || 5);
const phys = physicsFor({ ...blankTeam('t'), turningAbility: turnSpec });
const net = buildNet();
const focusArg = process.argv[8];
const cfg: GAConfig = { ...DEFAULT_GA, popSize: Number(process.argv[6] || 24), episodes: Number(process.argv[7] || 2), timeout: 40, sigma: Number(process.argv[10] || 0.05), ...(focusArg ? { spawnFocus: Number(focusArg) } : {}) };
let pop = Array.from({ length: cfg.popSize }, () => randomGenome(net, Math.random));
let seed = 7;
let best: Float32Array | null = null;
let bestFit = -Infinity;
let sigma: number | null = null;
let stasis = 0;
let epoch0 = 0;
if (seedFrom && existsSync(seedFrom)) {
  const donor = JSON.parse(readFileSync(seedFrom, 'utf8'));
  const dg = new Float32Array(donor.best);
  const rr = mulberry32(999);
  pop = [dg.slice(), ...Array.from({ length: cfg.popSize - 1 }, () => mutateGenome(dg, cfg.sigma, rr))];
  seed = 1000;
  console.log(`seeded from donor best (transfer)`);
} else if (resume && existsSync(resume)) {
  const saved = JSON.parse(readFileSync(resume, 'utf8'));
  pop = saved.pop.map((a: number[]) => new Float32Array(a));
  seed = saved.seed ?? 7; best = saved.best ? new Float32Array(saved.best) : null;
  bestFit = saved.bestFit ?? -Infinity; sigma = saved.sigma ?? null; stasis = saved.stasis ?? 0; epoch0 = saved.epoch ?? 0;
  console.log(`resumed epoch ${epoch0}, bestFit=${Number.isFinite(bestFit) ? bestFit.toFixed(0) : '-inf'}`);
}
console.log(`training ${trackName} len=${Math.round(idx.total)} pop=${cfg.popSize} ep=${cfg.episodes}`);
const rand = mulberry32(1234);
for (let e = 0; e < epochs; e++) {
  if (sigma == null) sigma = cfg.sigma;
  if (best && stasis >= 10) {
    const near = restartPop(best, Math.max(2, Math.ceil(cfg.popSize / 2)), cfg.sigma, Math.random);
    const nFresh = Math.max(0, cfg.popSize - near.length);
    const fresh = Array.from({ length: nFresh }, (_, i) =>
      i % 2 === 0
        ? randomGenome(net, Math.random)
        : mutateGenome(withBrakeBias(best!, 1.0 + Math.random() * 1.5), cfg.sigma, Math.random));
    pop = [...near, ...fresh];
    stasis = 0; sigma = cfg.sigma;
    console.log(`  ** stagnation restart`);
  }
  const ecfg = { ...cfg, sigma, timeout: epochTimeout(idx.total, cfg.laps) };
  while (pop.length < ecfg.popSize && best) pop.push(mutateGenome(best, sigma, rand));
  if (pop.length > ecfg.popSize) pop.length = ecfg.popSize;
  const r = await runEpoch(idx, phys, pop, ecfg, seed);
  pop = r.pop;
  seed = (seed + 1) >>> 0;
  if (!best || r.bestFitness > bestFit) {
    best = r.best; bestFit = r.bestFitness; stasis = 0;
    sigma = adaptSigma(sigma ?? cfg.sigma, cfg.sigma, true, 0);
  } else {
    stasis++;
    sigma = adaptSigma(sigma ?? cfg.sigma, cfg.sigma, false, stasis);
  }
  console.log(`epoch ${epoch0 + e}: best=${r.bestFitness.toFixed(0)} avg=${r.avgFitness.toFixed(0)} sig=${sigma.toFixed(3)} stas=${stasis}`);
}
writeFileSync('/tmp/headless_pop.json', JSON.stringify({
  pop: pop.map((g) => [...g]), seed,
  best: best ? [...best] : null, bestFit, sigma, stasis, epoch: epoch0 + epochs,
}));
console.log('done');
