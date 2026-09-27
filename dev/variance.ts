import { readFileSync } from 'node:fs';
import { makeTrackIndex, runEpisode, sampleSpawnFrac, mulberry32 } from '../src/sim.ts';
import { buildNet, forwardGenome } from '../src/nn.ts';
import { initPop } from '../src/ga.ts';
import { fitnessOf, DEFAULT_GA } from '../src/ga.ts';
import type { GAConfig } from '../src/ga.ts';
import { physicsFor, blankTeam } from '../src/teams.ts';
import type { Track } from '../src/track.ts';
import type { Control } from '../src/sim.ts';

const track = JSON.parse(readFileSync('/home/danel/Projects/racing_sim/assets/tracks/Portimao GP.json', 'utf8')) as Track;
const idx = makeTrackIndex(track);
const phys = physicsFor({ ...blankTeam('t') });
const net = buildNet();
const cfg: GAConfig = { ...DEFAULT_GA, popSize: 24, episodes: 2, timeout: 40 };
const pop = initPop(net, cfg.popSize, 7);
const g = pop[0];
const policy = (obs: number[]): Control => forwardGenome(g, obs);

// same genome, different epoch seeds (= different spawn fracs)
for (let seed = 0; seed < 10; seed++) {
  const rand = mulberry32(seed);
  const fracs = Array.from({ length: cfg.episodes }, (_, e) => (e === 0 ? null : sampleSpawnFrac(idx, rand)) as number | null);
  let f = 0;
  const parts: string[] = [];
  for (let e = 0; e < cfg.episodes; e++) {
    const r = await runEpisode(idx, phys, policy, { laps: cfg.laps, maxTime: cfg.timeout, spawnFrac: fracs[e], spawnSpeed: fracs[e] == null ? 0 : phys.vMax * 0.75 });
    f += fitnessOf(r);
    parts.push(`${r.done}@${r.progress.toFixed(2)}(sp=${fracs[e]?.toFixed(2) ?? 'start'})`);
  }
  console.log(`seed ${seed}: fit=${(f / cfg.episodes).toFixed(0)} [${parts.join(' ')}]`);
}
