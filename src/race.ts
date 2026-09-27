import type { Team } from './teams.ts';
import type { Pt } from './track.ts';
import type { Track } from './track.ts';

// ---- Single-race setup + session config (Stories 3-4) ----
export interface RaceConfig {
  trackId: string; teamIds: string[]; drivers: number; laps: number;
  previewEvery: number; // 0 = no auto preview
}
export interface SetupInput { trackId: string; teamIds: string[]; drivers: number; laps: number }

export function validateSetup(
  input: SetupInput,
  tracks: Pick<Track, 'id'>[],
  teams: Pick<Team, 'id'>[],
): string[] {
  const errs: string[] = [];
  if (!input.trackId || !tracks.some((t) => t.id === input.trackId))
    errs.push('Pick one of your tracks (build one first).');
  const known = input.teamIds.filter((id) => teams.some((t) => t.id === id));
  if (!known.length) errs.push('Pick at least one team.');
  if (!Number.isInteger(input.drivers) || input.drivers < 1 || input.drivers > 4)
    errs.push('Drivers per team must be 1–4.');
  if (!Number.isInteger(input.laps) || input.laps < 1 || input.laps > 10)
    errs.push('Laps must be 1–10.');
  return errs;
}

// Coerce persisted/UI input into a valid config (unknown ids dropped).
export function sanitizeSetup(o: unknown, tracks: Pick<Track, 'id'>[], teams: Pick<Team, 'id'>[]): RaceConfig | null {
  if (!o || typeof o !== 'object') return null;
  const r = o as Record<string, unknown>;
  const teamIds = Array.isArray(r.teamIds)
    ? (r.teamIds as unknown[]).filter((id): id is string => typeof id === 'string' && teams.some((t) => t.id === id))
    : [];
  const num = (v: unknown, dflt: number) => { const n = Math.round(Number(v)); return Number.isFinite(n) ? n : dflt; };
  const cfg: RaceConfig = {
    trackId: typeof r.trackId === 'string' ? r.trackId : '',
    teamIds,
    drivers: Math.min(4, Math.max(1, num(r.drivers, 2))),
    laps: Math.min(10, Math.max(1, num(r.laps, 3))),
    previewEvery: Math.max(0, num(r.previewEvery, 0)),
  };
  return validateSetup(cfg, tracks, teams).length ? null : cfg;
}

export interface Driver { teamId: string; teamName: string; name: string; genome: number[] }
export interface QualiEntry { teamId: string; teamName: string; name: string; time: number | null; progress: number }

// Seeded roster: N drivers per team sampled without replacement from each
// team's final-epoch population (falls back to best clones when short).
const FIRST = ['Max', 'Lewis', 'Nina', 'Kimi', 'Sofia', 'Ayrton', 'Mika', 'Lena', 'Niki', 'Alain', 'Gilles', 'Mona', 'Jim', 'Elio', 'Ronnie', 'Jo', 'Carlos', 'Lando', 'Oscar', 'Yuki'];
const LAST = ['Power', 'Swift', 'Velocity', 'Thunder', 'Blaze', 'Rocket', 'Storm', 'Drift', 'Turbo', 'Nitro', 'Apex', 'Champion', 'Racer', 'Speed', 'Flash', 'Zoom', 'Dash', 'Blitz', 'Comet', 'Meteor'];
export function driverName(rand: () => number, taken: Set<string>): string {
  for (let k = 0; k < 4; k++) {
    const n = `${FIRST[(rand() * FIRST.length) | 0]} ${LAST[(rand() * LAST.length) | 0]}`;
    if (!taken.has(n)) { taken.add(n); return n; }
  }
  const n = `Racer ${taken.size + 1}`;
  taken.add(n);
  return n;
}
export function buildRoster(
  teamIds: string[],
  teamNames: Map<string, string>,
  drivers: number,
  pops: Map<string, number[][]>,
  bests: Map<string, number[]>,
  rand: () => number,
): Driver[] {
  const out: Driver[] = [];
  const taken = new Set<string>();
  for (const id of teamIds) {
    const teamName = teamNames.get(id) ?? id;
    const pool = (pops.get(id) ?? []).filter((g) => g.length > 0);
    const idxs = pool.map((_, i) => i);
    for (let k = idxs.length - 1; k > 0; k--) {
      const j = Math.floor(rand() * (k + 1));
      [idxs[k], idxs[j]] = [idxs[j], idxs[k]];
    }
    for (let d = 0; d < drivers; d++) {
      const genome = pool.length ? pool[idxs[d % idxs.length]] : (bests.get(id) ?? []);
      out.push({ teamId: id, teamName, name: driverName(rand, taken), genome: genome.slice() });
    }
  }
  return out;
}

// Position sort: finishers by time asc, then DNFs by progress desc.
export function sortQuali(entries: QualiEntry[]): QualiEntry[] {
  return entries.slice().sort((a, b) => {
    if (a.time != null && b.time != null) return a.time - b.time;
    if (a.time != null) return -1;
    if (b.time != null) return 1;
    return b.progress - a.progress;
  });
}

export interface SceneCar { x: number; y: number; heading: number; color: string; dim?: boolean }

// Track scene renderer shared by quali + race: fit bounds + ribbon. Cars are
// drawn by the caller (liveried sprites live in main.ts).
export function drawRaceScene(
  ctx: CanvasRenderingContext2D, W: number, H: number,
  centerline: [number, number][], left: Pt[], right: Pt[],
  ribbonPoly: Pt[],
  bg?: { img: HTMLImageElement; x: number; y: number; s: number } | null,
) {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const [x, y] of centerline) { x0 = Math.min(x0, x); y0 = Math.min(y0, y); x1 = Math.max(x1, x); y1 = Math.max(y1, y); }
  const m = 30;
  const s = Math.min((W - 2 * m) / Math.max(1, x1 - x0), (H - 2 * m) / Math.max(1, y1 - y0));
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.clearRect(0, 0, W, H);
  // Center the leftover space: a wide canvas no longer pins the track top-left.
  const ox = m + ((W - 2 * m) - (x1 - x0) * s) / 2 - x0 * s;
  const oy = m + ((H - 2 * m) - (y1 - y0) * s) / 2 - y0 * s;
  ctx.setTransform(s, 0, 0, s, ox, oy);
  if (bg && bg.img.naturalWidth > 0) ctx.drawImage(bg.img, bg.x, bg.y, bg.img.naturalWidth * bg.s, bg.img.naturalHeight * bg.s);
  const path = (poly: [number, number][], close: boolean) => {
    ctx.beginPath();
    poly.forEach(([x, y], i) => (i ? ctx.lineTo(x, y) : ctx.moveTo(x, y)));
    if (close) ctx.closePath();
  };
  ctx.strokeStyle = '#999'; ctx.lineWidth = 4;
  path(left, true); ctx.stroke();
  path(right, true); ctx.stroke();
  ctx.fillStyle = '#3d3d3d';
  path(ribbonPoly, true); ctx.fill();
  // NOTE: fit transform intentionally left set — callers draw session cars
  // in track space right after; every entry re-resets at the top.
}
