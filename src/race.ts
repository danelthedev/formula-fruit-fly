import type { Team } from './teams.ts';
import { distToTrack, gateAt, pointAt, widthAt } from './track.ts';
import type { Pt, Track } from './track.ts';
import type { TrackIndex } from './sim.ts';

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
export interface ChampInput { trackIds: string[]; teamIds: string[]; drivers: number; laps: number }

// Championship setup: a set of races (≥2), same field rules as single race.
export function validateChamp(
  input: ChampInput,
  tracks: Pick<Track, 'id'>[],
  teams: Pick<Team, 'id'>[],
): string[] {
  const errs: string[] = [];
  const knownTracks = input.trackIds.filter((id) => tracks.some((t) => t.id === id));
  if (knownTracks.length < 2) errs.push('Pick at least two tracks for a championship.');
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
    // DNFs by furthest track reached (entries store max progress, not net —
    // spinners sliding back must not drop below shorter runs).
    return (b.progress ?? -Infinity) - (a.progress ?? -Infinity);
  });
}

export interface SceneCar { x: number; y: number; heading: number; color: string; dim?: boolean }

// One racing-line sample: position + pedal inputs that frame.
export interface TrailPt { x: number; y: number; th: number; br: number }

// Driving-line paint, continuous in both pedals: gray coasting, blending to
// green with throttle and red with brake (both = muddy mix, as driven).
// Intensities quantize to 1/8 steps so neighboring samples batch into one path.
const LINE_GRAY: [number, number, number] = [154, 154, 154];
const LINE_GREEN: [number, number, number] = [43, 255, 125];
const LINE_RED: [number, number, number] = [255, 59, 48];
export function lineColor(throttle: number, brake: number): string {
  const clamp = (v: number) => Math.min(1, Math.max(0, v));
  // gamma <1: feathered inputs read as their color, not murk (endpoints exact)
  const g = (v: number) => Math.round(Math.pow(clamp(v), 0.65) * 8) / 8;
  const t = g(throttle), b = g(brake);
  const hex = [0, 1, 2].map((i) => {
    const v = Math.max(0, Math.min(255, Math.round(LINE_GRAY[i] + t * (LINE_GREEN[i] - LINE_GRAY[i]) + b * (LINE_RED[i] - LINE_GRAY[i]))));
    return v.toString(16).padStart(2, '0');
  });
  return `#${hex.join('')}`;
}

// Track scene renderer shared by preview + practice + quali + race: fit bounds +
// ribbon, then start line + grid boxes (under the cars callers draw after).
export interface GridMarks { start: { a: Pt; b: Pt } | null; slots: { x: number; y: number; heading: number }[]; box: { l: number; w: number } }
export function drawRaceScene(
  ctx: CanvasRenderingContext2D, W: number, H: number,
  centerline: [number, number][], left: Pt[], right: Pt[],
  ribbonPoly: Pt[],
  bg?: { img: HTMLImageElement; x: number; y: number; s: number } | null,
  marks?: GridMarks | null,
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
  if (marks?.start) {
    ctx.strokeStyle = '#fff'; ctx.lineWidth = 5;
    ctx.beginPath(); ctx.moveTo(marks.start.a[0], marks.start.a[1]); ctx.lineTo(marks.start.b[0], marks.start.b[1]); ctx.stroke();
  }
  if (marks?.slots.length) {
    const { l, w } = marks.box;
    marks.slots.forEach((sl, i) => {
      ctx.save();
      ctx.translate(sl.x, sl.y);
      ctx.rotate(sl.heading);
      if (i === 0) { ctx.fillStyle = 'rgba(255,255,255,0.28)'; ctx.fillRect(-l / 2, -w / 2, l, w); } // pole shaded
      ctx.strokeStyle = 'rgba(255,255,255,0.65)'; ctx.lineWidth = 2;
      ctx.strokeRect(-l / 2, -w / 2, l, w);
      ctx.restore();
    });
  }
  // NOTE: fit transform intentionally left set — callers draw session cars
  // in track space right after; every entry re-resets at the top.
}

// Real F1 proportions: 5.6m long on a ~12m wide track ≈ 0.5× width; 0.75× keeps
// liveries readable at game zoom. A 34px car on 23px Monaco was wider than the road.
export function carSizeFor(trackWidth: number): number {
  return Math.min(28, Math.max(16, Math.round(trackWidth * 0.75)));
}

// F1-stagger grid behind the start line: 2 cols, alternate sides, odd slots
// half a row back (never on the same line). Slots march back along the arc by
// chord distance, so corners widen the gap instead of chord-cutting boxes into
// each other. Lives here (not main.ts) so marks always match car placement.
export function gridSlots(idx: TrackIndex, n: number): { x: number; y: number; heading: number }[] {
  const t = idx.track, m = idx.n;
  const si = t.startS == null ? 0 : t.startS % m;
  const rowPx = Math.max(30, carSizeFor(t.width) + 4); // same-side gap: boxes never overlap
  const staggerPx = rowPx / 2; // odd slots sit half a row back
  const out: { x: number; y: number; heading: number }[] = [];
  const gjPrev: number[] = []; // same-side predecessor arc index (i-2)
  for (let i = 0; i < n; i++) {
    const side = i % 2 === 0 ? -1 : 1;
    const anchor = i < 2 ? si : gjPrev[i - 2];
    const want = rowPx + (i < 2 && i % 2 ? staggerPx : 0);
    const ax = t.centerline[anchor][0], ay = t.centerline[anchor][1];
    let gj = anchor;
    for (let k = 0; k < m; k++) {
      gj = (gj - 1 + m) % m;
      const dx = t.centerline[gj][0] - ax, dy = t.centerline[gj][1] - ay;
      if (dx * dx + dy * dy >= want * want) break;
    }
    gjPrev[i] = gj;
    const a = t.centerline[gj], b = t.centerline[(gj + 3) % m], c = t.centerline[(gj - 3 + m) % m];
    const L = Math.hypot(b[0] - c[0], b[1] - c[1]) || 1;
    const tx = (b[0] - c[0]) / L, ty = (b[1] - c[1]) / L;
    const hw = widthAt(t, gj / m) / 2;
    // edge margin fits the car (not a fixed 12px): fixed margins collapse the
    // stagger to lat 0 on tight tracks, stacking pairs exactly on top of each other
    const lat = Math.max(0, Math.min(hw * 0.5 + 5, hw - (carSizeFor(t.width) / 2.8 / 2 + 3)));
    const p = pointAt(t.centerline, t.closed, gj / m);
    let x = p[0] + -ty * side * lat, y = p[1] + tx * side * lat;
    if (distToTrack(t.centerline, t.closed, [x, y]) >= hw - 4) { x = p[0]; y = p[1]; } // bend: fall back to center
    out.push({ x, y, heading: Math.atan2(ty, tx) });
  }
  return out;
}

// Start line + grid boxes for one track index; n = event grid size.
// Null startS → no marks (user hasn't placed the line yet).
// Box matches the car footprint (length = car size, 2.8:1 F1 proportions).
export function startGridMarks(idx: TrackIndex, n: number): GridMarks {
  const t = idx.track, m = idx.n;
  const l = carSizeFor(t.width);
  const box = { l, w: l / 2.8 };
  if (t.startS == null || m < 8) return { start: null, slots: [], box };
  const g = gateAt(t, (t.startS % m) / m);
  return { start: { a: g.a, b: g.b }, slots: gridSlots(idx, Math.max(0, Math.floor(n))), box };
}
