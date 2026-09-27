// ---- Training worker: one GA epoch per message, off the UI thread ----
// Pure sim/GA only (no DOM): receives a full epoch job, runs it with the
// shared runEpoch, posts the result back. Stop is cooperative: the flag is
// checked between genomes, so aborting returns a partial result like the
// inline path instead of discarding the epoch.
import { runEpoch } from './ga.ts';
import type { GAConfig } from './ga.ts';
import type { EpisodeResult, TrackIndex } from './sim.ts';
import type { PhysicsParams } from './teams.ts';

interface EpochJob {
  type: 'epoch';
  jobId: number;
  idx: TrackIndex;
  phys: PhysicsParams;
  pop: Float32Array[];
  cfg: GAConfig;
  seed: number;
}

interface StopMsg { type: 'stop' }

let stopRequested = false;

self.onmessage = async (e: MessageEvent<EpochJob | StopMsg>) => {
  const msg = e.data;
  if (msg.type === 'stop') { stopRequested = true; return; }
  stopRequested = false;
  try {
    const r = await runEpoch(msg.idx, msg.phys, msg.pop, msg.cfg, msg.seed, () => stopRequested);
    self.postMessage({ type: 'done', jobId: msg.jobId, ok: true, result: r });
  } catch (err) {
    self.postMessage({ type: 'done', jobId: msg.jobId, ok: false, error: String(err) });
  }
};
