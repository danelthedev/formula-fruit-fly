import { buildMask, extractCore, largestComponent, prune, simplifySkeleton, thin, traceLoop } from './skeleton.ts';
import { blendSeam, checkpoints, closeLoop, dist, distToTrack, edges, gateAt, nearestIndex, pointAt, projectFraction, resample, ribbon, ribbonSelfOverlap, sampleArc, sampleLine, sanitizePoints, sanitizeTrack, seamPatch, segOverlapsExisting, selfStrokeOverlaps, smooth, smoothOpen, uid, validateGeometry, vertexWidths, widthAt } from './track.ts';
import type { Pt, Track } from './track.ts';
import { deleteTrack, deleteWeights, listTracks, loadBg, loadChamp, loadDraft, loadPieces, loadPopulation, loadRaceCfg, loadRaceSession, loadTeams, loadView, loadWeights, ready as storeReady, saveBg, saveChamp, saveDraft, savePieces, savePopulation, saveRaceCfg, saveRaceSession, saveTeams, saveTrack, saveView, saveWeights } from './storage.ts';
import type { QualiSaved } from './storage.ts';
import { adaptSigma, epochTimeout, initPop, migrateIslands, restartPop, runEpoch } from './ga.ts';
import { buildNet, decodeWeightsFile, encodeWeightsFile, forwardGenome, mutateGenome, randomGenome, withBrakeBias } from './nn.ts';
import type { EpochResult, GAConfig } from './ga.ts';
import type { GenomeNet } from './nn.ts';
import { locate, makeTrackIndex, mulberry32, observe, spawn, stepCar, DT } from './sim.ts';
import type { CarState, TrackIndex } from './sim.ts';
import { buildRoster, carSizeFor, drawRaceScene, driverName, gridSlots, lineColor, sanitizeSetup, sortQuali, startGridMarks, validateChamp, validateSetup } from './race.ts';
import type { Driver, QualiEntry, RaceConfig, SceneCar, TrailPt } from './race.ts';
import { blankTeam, drawCarPreview, physicsFor, sanitizeTeam, teamErrors } from './teams.ts';
import type { PhysicsParams, Team } from './teams.ts';

// Model: disjoint pieces (stroke chains). Active piece feeds the track pipeline.
// New strokes magnetically snap to endpoints; free ends auto-merge with other
// pieces. No implicit jumps: far starts begin a new piece.
const canvas = document.getElementById('editor') as HTMLCanvasElement;
const ctx = canvas.getContext('2d')!;
const status = document.getElementById('status')!;
const checks = document.getElementById('checks')!;
const say = (m: string) => (status.textContent = m);
function gid(id: string): HTMLElement {
  const e = document.getElementById(id);
  if (!e) throw new Error('missing #' + id);
  return e;
}

// ponytail: fades only on non-end sides of containers that actually overflow.
function paintFades() {
  document.querySelectorAll<HTMLElement>('.board, #team-list, #checks, #panel, #race-teams, #champ-tracks, #champ-teams, #champ-races, #race-setup .setup-card').forEach((el) => {
    const can = el.scrollHeight > el.clientHeight + 1;
    el.style.setProperty('--fade-t', can && el.scrollTop > 4 ? 'transparent' : '#000');
    el.style.setProperty('--fade-b', can && el.scrollTop + el.clientHeight < el.scrollHeight - 4 ? 'transparent' : '#000');
  });
}
let fadeT = 0;
const queueFades = () => { window.clearTimeout(fadeT); fadeT = window.setTimeout(paintFades, 60); };
window.addEventListener('scroll', queueFades, true);
new MutationObserver(queueFades).observe(document.getElementById('app')!, { childList: true, subtree: true });

const SNAP = 40;    // endpoint magnet radius, screen px (divided by zoom at use)
const ERASE_R = 24; // eraser radius, screen px
let view = { s: 1, ox: 0, oy: 0 }; // zoom/pan: screen = world*s + o (restored in boot)

let pieces: Pt[][] = [];
let active = 0;
interface Snap { pieces: Pt[][]; gates: number[]; widths: number[]; general: number; start: number | null }
let history: Snap[] = [];
let hIndex = -1;
let piecesVersion = 0; // bumped on every stroke-data mutation (never on width/gate/start)
let builtFor: { v: number; active: number } | null = null; // geometry the live centerline was built from
function touchPieces() { piecesVersion++; }
let track: Track | null = null;
let tool: 'free' | 'line' | 'arc' | 'erase' | 'gate' = 'free';
let panning = false;
let panLast: [number, number] | null = null;
let setStartMode = false;
let drawing: Pt[] | null = null;
let attachEnd: 'head' | 'tail' | 'new' = 'new';
let lineStart: Pt | null = null;
let arcPts: Pt[] = [];
let hover: Pt | null = null;
let erasing = false;
let eraseCullMsg: string | null = null;

// Background image: world-space offset/scale, drawn under everything.
let bg: { img: HTMLImageElement; data: string; x: number; y: number; s: number } | null = null;
let moveBg = false;
let bgDrag: [number, number] | null = null;
function saveBgState() {
  saveBg(bg ? { data: bg.data, x: bg.x, y: bg.y, s: bg.s } : null);
}
function setBg(img: HTMLImageElement, data: string, x: number, y: number, s: number) {
  bg = { img, data, x, y, s };
  (gid('in-bg-scale') as HTMLInputElement).value = String(Math.round(s * 100));
  gid('bg-scale-val').textContent = `${Math.round(s * 100)}%`;
  saveBgState(); render();
}
let eraseChanged = false;
let lastRejection: string | null = null; // shown in checklist so message + requirements agree

const clonePieces = (ps: Pt[][]): Pt[][] => ps.map((s) => s.map((p) => [...p] as Pt));
const allRaw = (): Pt[] => pieces.flat();

// ---- init (async: storage lives in IndexedDB) ----
async function bootRestore() {
  const saved = await loadPieces();
  const rawDraft = await loadDraft();
  const draft = rawDraft ? sanitizeTrack(rawDraft) : null;
  if (rawDraft && !draft) say('Saved draft was corrupt — starting fresh.');
  if (saved) { pieces = saved.pieces.map(sanitizePoints).filter((p) => p.length > 0); active = saved.active; }
  else if (draft) { pieces = [draft.centerline.map((p) => [...p] as Pt)]; }
  fixActive();
  if (draft) { track = { ...draft }; say(`Draft restored (${draft.centerline.length} pts)`); }
  history = [capture()]; // after track assignment: snapshot includes draft gates
  hIndex = 0;
}
function fixActive() {
  if (!pieces.length) { active = 0; return; }
  if (active < 0 || active >= pieces.length || !pieces[active].length) {
    let bi = 0;
    pieces.forEach((p, i) => { if (p.length > pieces[bi].length) bi = i; });
    active = bi;
  }
}
// Ordered, non-blocking writes: chained so rapid rebuilds can't persist out of order.
let pchain: Promise<void> = Promise.resolve();
function persist() {
  const pp = { pieces: clonePieces(pieces), active, w: canvas.width, h: canvas.height };
  const td = track ? { ...track, gates: track.gates.slice(), gateWidths: track.gateWidths?.slice() } : null;
  pchain = pchain.then(() => Promise.all([savePieces(pp), saveDraft(td)])).then(() => undefined).catch(() => {});
}
// snapshots cover pieces + checkpoints + widths: undo spans everything
function capture(): Snap {
  return {
    pieces: clonePieces(pieces),
    gates: track?.gates.slice() ?? [],
    widths: track?.gateWidths?.slice() ?? [],
    general: track?.width ?? 60,
    start: track?.startS ?? null,
  };
}
function pushHistory() {
  history = history.slice(0, hIndex + 1);
  history.push(capture());
  if (history.length > 50) history.shift();
  hIndex = history.length - 1;
}
// gates/widths riding along a pieces restore (undo/redo/reject): rebuildTrack picks
// these up instead of the live track's, since the live track is about to be replaced.
let incoming: { gates: number[]; widths: number[]; start: number | null } | null = null;
function applySnap(s: Snap) {
  pieces = clonePieces(s.pieces); fixActive(); touchPieces();
  incoming = { gates: s.gates.slice(), widths: s.widths.slice(), start: s.start };
  els.width.value = String(s.general); els.widthVal.textContent = String(s.general);
  selectedGate = null;
}

// ---- geometry pipeline ----
function buildFromPiece(piece: Pt[]): { center: Pt[]; closed: boolean } | null {
  if (piece.length < 2) return null;
  const rs = resample(piece, 8, false);
  const { loop, closed } = closeLoop(rs); // no auto-bridge: only explicit joins close
  if (!closed) return { center: smoothOpen(loop), closed };
  return { center: blendSeam(smooth(loop)), closed }; // seam corner cut + G1 bridge
}

// Rebuild track from active piece. Returns false + reverts when the new
// geometry crosses itself (stays on last-good state). Ribbon overlaps merge.
function rebuildTrack(): boolean {
  lastRejection = null; // fresh verdict each rebuild; set below on reject
  if (!pieces.length) { track = null; builtFor = null; persist(); render(); return true; }
  fixActive();
  const w = Number(els.width.value);
  if (builtFor && builtFor.v === piecesVersion && builtFor.active === active && track) {
    // Strokes unchanged: reuse the stored centerline verbatim. Reprocessing clean
    // data is pure loss (resample renumbering, trim/fill flicker) and is what made
    // gates creep across saves. Only metadata can have changed.
    track.width = w; pinOpenWidth();
    persist(); render(); return true;
  }
  const built = buildFromPiece(pieces[active]);
  if (!built || built.center.length < 2) { track = null; builtFor = { v: piecesVersion, active }; persist(); render(); return true; }
  // gates/start ride along as geography, not indices: resampling shifts indices
  // every pass (gates used to walk ~30px per save/load). Undo restores verbatim.
  const prevCenter = track?.centerline, hadCenter = !!prevCenter && prevCenter.length >= 2;
  const prevClosed = track?.closed ?? false;
  const hasStart = hadCenter && track!.startS != null;
  const startWorld = hasStart ? pointAt(prevCenter!, prevClosed, (track!.startS! % prevCenter!.length) / prevCenter!.length) : null;
  const gateWorld = hadCenter ? (track?.gates ?? []).map((fr) => pointAt(prevCenter!, prevClosed, fr)) : [];
  let gates: number[], widths: number[], startS: number | null;
  if (incoming) {
    ({ gates, widths } = incoming);
    startS = incoming.start;
    incoming = null;
  } else {
    // gates/start survive only if their world spot still lies on the new centerline:
    // resampling shifts a few px, an erased section leaves erase-radius gap.
    const ER = ERASE_R / view.s;
    const gw = track?.gateWidths ?? [];
    gates = []; widths = [];
    let culledG = 0, culledS = false;
    gateWorld.forEach((p, i) => {
      if (distToTrack(built.center, built.closed, p) >= ER) { culledG++; return; }
      gates.push(projectFraction(built.center, built.closed, p));
      widths.push(gw[i] ?? w);
    });
    if (startWorld && distToTrack(built.center, built.closed, startWorld) < ER) {
      startS = Math.round(projectFraction(built.center, built.closed, startWorld) * built.center.length) % built.center.length;
    } else {
      if (startWorld) culledS = true;
      startS = null; // never auto-placed: user sets it explicitly
    }
    if (culledG || culledS) {
      const parts: string[] = [];
      if (culledG) parts.push(`${culledG} checkpoint${culledG === 1 ? '' : 's'}`);
      if (culledS) parts.push('start line');
      const msg = `${parts.join(' + ')} removed — erased section.`;
      if (erasing) eraseCullMsg = msg; // pointerup folds it into 'Erased.'
      else say(msg);
    }
  }
  if (built.closed && validateGeometry(built.center, w) === 'crossed') {
    applySnap(history[hIndex]);
    rebuildTrack(); // rebuild last-good: deterministic, always succeeds
    lastRejection = 'Last stroke rejected: track crosses itself.';
    say(lastRejection);
    return false;
  }
  if (!built.closed) {
    const ends = pieces[active];
    say(`Open piece: ends ${Math.round(dist(ends[0], ends[ends.length - 1]))}px apart — draw into a glowing dot to connect.`);
  }
  const prev = track;
  track = {
    id: prev?.id ?? uid(), name: prev?.name ?? '',
    centerline: built.center, width: w,
    startS: startS == null ? null : Math.min(startS, built.center.length - 1),
    closed: built.closed,
    gates, // world-anchored fractions
    gateWidths: widths,
  };
  if (track.startS != null) track.startS = Math.min(track.startS, built.center.length - 1);
  pinOpenWidth();
  builtFor = { v: piecesVersion, active };
  refreshWidthCaps();
  persist(); render();
  return true;
}
function commit() {
  if (rebuildTrack()) pushHistory();
}

// Racing direction: signed area of the loop (canvas y-down, so positive reads
// clockwise on screen). Reversing the stroke flips travel; start line and
// checkpoints ride along as world geography through the normal rebuild.
function signedArea(pts: Pt[]): number {
  let a = 0;
  for (let i = 0; i < pts.length; i++) {
    const p = pts[i], q = pts[(i + 1) % pts.length];
    a += p[0] * q[1] - q[0] * p[1];
  }
  return a / 2;
}
let lastDirection = '';
function refreshDirection() {
  const pts = track?.centerline;
  const d = !track?.closed || !pts || pts.length < 8 ? '' : signedArea(pts) >= 0 ? 'clockwise' : 'counter-clockwise';
  if (d !== lastDirection) { lastDirection = d; gid('track-direction').textContent = d || '—'; }
  (gid('btn-reverse') as HTMLButtonElement).disabled = !d;
}
gid('btn-reverse').onclick = () => {
  if (!track?.closed || !pieces[active]?.length) return;
  pieces[active] = pieces[active].slice().reverse();
  touchPieces();
  if (rebuildTrack()) { pushHistory(); say(`Direction reversed — now running ${lastDirection}.`); }
  // rejection restores last-good geometry (with its direction) inside rebuildTrack
};

// ---- endpoints: snap + merge ----
interface Ep { p: Pt; piece: number; end: 'head' | 'tail' }
function endpoints(): Ep[] {
  const out: Ep[] = [];
  pieces.forEach((pc, i) => {
    if (pc.length) {
      out.push({ p: pc[0], piece: i, end: 'head' });
      out.push({ p: pc[pc.length - 1], piece: i, end: 'tail' });
    }
  });
  return out;
}
function snapToEndpoint(p: Pt): Ep | null {
  let best: Ep | null = null, bd = SNAP / view.s; // screen-constant magnet
  for (const e of endpoints()) {
    const d = dist(p, e.p);
    if (d < bd) { bd = d; best = e; }
  }
  return best;
}
// Free end of the active piece merged into a nearby other piece's endpoint.
function tryMerge(freeAtHead: boolean): boolean {
  const A = pieces[active];
  if (!A?.length) return false;
  const freeEnd = freeAtHead ? A[0] : A[A.length - 1];
  for (let i = 0; i < pieces.length; i++) {
    if (i === active || !pieces[i].length) continue;
    const B = pieces[i];
    const headMatch = dist(B[0], freeEnd) < SNAP;
    const tailMatch = !headMatch && dist(B[B.length - 1], freeEnd) < SNAP;
    if (!headMatch && !tailMatch) continue;
    if (freeAtHead) A.unshift(...(headMatch ? B.slice(1).reverse() : B.slice(0, -1)));
    else A.push(...(headMatch ? B.slice(1) : B.slice(0, -1).reverse()));
    pieces.splice(i, 1);
    if (i < active) active--;
    return true;
  }
  return false;
}
function addStroke(seg: Pt[], attach: 'head' | 'tail' | 'new', label = 'Stroke') {
  if (seg.length < 2) return;
  if (strokeOverlaps(seg)) { say(`Overlap — ${label.toLowerCase()} rejected. Leave a full track-width gap.`); render(); return; }
  if (attach === 'new') { pieces.push(seg); active = pieces.length - 1; }
  else if (attach === 'tail') pieces[active].push(...seg.slice(1));
  else pieces[active].unshift(...seg.slice(1).reverse());
  tryMerge(attach === 'head');
  // explicit closure only: free end drawn onto the opposite end joins exactly.
  // (no invented bridge segments — the data ring is truly closed)
  const A = pieces[active];
  if (A.length > 30 && dist(A[0], A[A.length - 1]) < SNAP / view.s) {
    if (attach === 'head') A[0] = [...A[A.length - 1]] as Pt;
    else A[A.length - 1] = [...A[0]] as Pt;
  }
  touchPieces(); commit();
  if (track?.closed && (tool === 'free' || tool === 'line' || tool === 'arc')) {
    setTool('gate'); // closed → next job is checkpoints
    say(`Loop closed (${track.centerline.length} pts) — place checkpoints or set the start line.`);
  } else if (track?.closed) say(`Loop closed (${track.centerline.length} pts) — set the start line.`);
}

// ---- eraser: drag to delete points within radius (splits pieces) ----
// Cutting a closed loop rotates the runs so BOTH dots land on the cut:
// [head..cutA] + [cutB..tail] becomes one piece [cutB..tail, head..cutA].
function eraseAt(p: Pt): boolean {
  const r = ERASE_R / view.s;
  const before = allRaw().length;
  const wasClosed = track?.closed ?? false;
  const out: Pt[][] = [];
  pieces.forEach((pc, pi) => {
    const runs: Pt[][] = [];
    let run: Pt[] = [];
    for (const q of pc) {
      if (dist(q, p) > r) run.push(q);
      else { if (run.length >= 2) runs.push(run); run = []; }
    }
    if (run.length >= 2) runs.push(run);
    if (runs.length === 2 && pi === active && wasClosed) out.push([...runs[1], ...runs[0]]);
    else out.push(...runs);
  });
  const after = out.flat().length;
  if (after === before) return false;
  pieces = out; touchPieces();
  active = 0;
  pieces.forEach((pc, i) => { if (pc.length > pieces[active].length) active = i; });
  fixActive(); rebuildTrack();
  return true;
}

// ---- pointer ----
const els = {
  undo: gid('btn-undo'), redo: gid('btn-redo'), clear: gid('btn-clear'),
  width: gid('in-width') as HTMLInputElement, widthVal: gid('width-val'),
  start: gid('btn-start'), name: gid('in-name') as HTMLInputElement,
  save: gid('btn-save'), sel: gid('sel-tracks') as HTMLSelectElement,
  load: gid('btn-load'), del: gid('btn-del'),
  exp: gid('btn-export'), imp: gid('btn-import'),
  file: gid('file-import') as HTMLInputElement,
};
const pos = (e: PointerEvent): Pt | null => {
  // scale client px -> canvas backing px -> world (inverse view). Null when
  // unmappable (hidden canvas, broken view): callers ignore it, so poison
  // (Infinity/NaN) can never be committed into geometry or persisted.
  const r = canvas.getBoundingClientRect();
  if (!(r.width > 0) || !Number.isFinite(view.s) || view.s <= 0 || !Number.isFinite(view.ox + view.oy)) return null;
  const kx = canvas.width / r.width;
  return [((e.clientX - r.left) * kx - view.ox) / view.s, ((e.clientY - r.top) * kx - view.oy) / view.s];
};
canvas.addEventListener('pointerdown', (e) => {
  if (e.button === 1) { // wheel-click pan (any tool, even start-armed)
    panning = true; panLast = [e.clientX, e.clientY];
    canvas.setPointerCapture(e.pointerId);
    e.preventDefault();
    return;
  }
  if (moveBg && bg && e.button === 0) { // background move: drag pans the image, never draws
    bgDrag = [e.clientX, e.clientY];
    canvas.setPointerCapture(e.pointerId);
    return;
  }
  if (e.button === 2 && tool !== 'gate') return; // right-click is gate-select only
  canvas.setPointerCapture(e.pointerId);
  const p = pos(e);
  if (!p) return; // unmappable event (hidden canvas): ignore, never commit poison
  if (setStartMode) { // start-pick mode: only job is placing the start line
    if (track && track.closed && track.centerline.length > 8) {
      track.startS = nearestIndex(track.centerline, p);
      persist(); render();
      say(`Start line placed — mode off`);
    } else say('Draw a closed loop first');
    setArmed(false);
    return;
  }
  if (tool === 'erase') { erasing = true; eraseChanged = false; if (eraseAt(p)) eraseChanged = true; return; }
  if (tool === 'gate') {
    if (e.button === 2) selectGateAt(p);
    else if (!track?.closed) say('Close the loop first, then place checkpoints.');
    else addGateAt(p);
    return;
  }
  if (tool === 'arc') {
    if (track?.closed) { say('Track is closed — erase a section to edit it.'); return; }
    const s = snapToEndpoint(p);
    if (arcPts.length === 0) {
      if (pieces.length && !s) { say('Start arcs from a glowing dot.'); return; }
      if (s) { active = s.piece; attachEnd = s.end; } else attachEnd = 'new';
    }
    arcPts.push(s ? [...s.p] as Pt : p);
    if (arcPts.length === 3) {
      const seg = sampleArc(arcPts[0], arcPts[1], arcPts[2]);
      arcPts = []; hover = null;
      addStroke(seg, attachEnd, 'Arc');
    } else { say(`Arc: click point ${arcPts.length + 1} of 3 (Esc cancels)`); render(); }
    return;
  }
  if (track?.closed) { say('Track is closed — erase a section to edit it.'); return; }
  if (pieces.length) {
    const s = snapToEndpoint(p);
    if (!s) { say('Start from a glowing dot to extend the circuit.'); return; }
    active = s.piece; attachEnd = s.end;
  } else attachEnd = 'new';
  const s = snapToEndpoint(p);
  const start: Pt = s ? [...s.p] as Pt : p;
  if (tool === 'line') { lineStart = start; drawing = [start]; return; }
  drawing = [start];
});
canvas.addEventListener('pointermove', (e) => {
  if (panning && panLast) { // wheel-drag pan
    const kx = canvas.width / canvas.getBoundingClientRect().width;
    view.ox += (e.clientX - panLast[0]) * kx;
    view.oy += (e.clientY - panLast[1]) * kx;
    panLast = [e.clientX, e.clientY];
    saveView(view); render();
    return;
  }
  if (bgDrag && bg) { // background move drag: client px -> world
    const kx = canvas.width / canvas.getBoundingClientRect().width;
    bg.x += ((e.clientX - bgDrag[0]) * kx) / view.s;
    bg.y += ((e.clientY - bgDrag[1]) * kx) / view.s;
    bgDrag = [e.clientX, e.clientY];
    render();
    return;
  }
  hover = pos(e);
  if (!hover) return;
  if (tool === 'arc' && arcPts.length > 0) { render(); return; }
  if (tool === 'gate') { render(); return; } // ghost gate follows cursor
  if (tool === 'erase') { render(); if (erasing && eraseAt(hover)) eraseChanged = true; return; }
  if (!drawing) return;
  const p = hover;
  if (tool === 'line' && lineStart) {
    const s = snapToEndpoint(p); // magnetic line ends: precise joins
    drawing = sampleLine(lineStart, s ? [...s.p] as Pt : p); // full sampling: preview == commit
    renderLive();
    return;
  }
  if (dist(p, drawing[drawing.length - 1]) > 3) { drawing.push(p); renderLive(); }
});
canvas.addEventListener('pointerup', (e) => {
  if (panning) { panning = false; panLast = null; return; }
  if (bgDrag) { bgDrag = null; saveBgState(); return; }
  if (erasing) { erasing = false; if (eraseChanged) { pushHistory(); say(eraseCullMsg ? `Erased. ${eraseCullMsg}` : 'Erased.'); eraseCullMsg = null; } return; }
  if (tool === 'line' && lineStart) {
    const seg = drawing ?? [];
    lineStart = null; drawing = null;
    addStroke(seg, attachEnd, 'Line');
    return;
  }
  if (!drawing) return;
  const min = attachEnd === 'new' ? 8 : 2; // continuations can be tiny
  if (drawing.length >= min) addStroke(drawing, attachEnd);
  drawing = null;
});
window.addEventListener('keydown', (e) => {
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z' && !(e.target as HTMLElement)?.closest?.('input,select,textarea')) {
    e.preventDefault();
    if (e.shiftKey) { if (hIndex < history.length - 1) { hIndex++; applySnap(history[hIndex]); rebuildTrack(); say('Redo'); } }
    else if (hIndex > 0) { hIndex--; applySnap(history[hIndex]); rebuildTrack(); say('Undo'); }
    return;
  }
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'y') { e.preventDefault(); document.getElementById('btn-redo')?.click(); return; }
  if (e.key === 'Escape' && setStartMode) { setArmed(false); say('Start placement cancelled'); return; }
  if ((e.key === 'Delete' || e.key === 'Backspace') && !(e.target as HTMLElement)?.closest?.('input,select,textarea')) {
    if (selectedGate !== null) { e.preventDefault(); removeSelectedGate(); return; }
  }
  if (!(e.ctrlKey || e.metaKey) && !(e.target as HTMLElement)?.closest?.('input,select,textarea')) {
    const k = e.key.toLowerCase();
    if (k === 'f') setTool('free');
    else if (k === 'l') setTool('line');
    else if (k === 'a') setTool('arc');
    else if (k === 'e') setTool('erase');
    else if (k === 'c') setTool('gate');
    else if (k === 's') setArmed(!setStartMode);
    else return;
    return;
  }
  if (e.key === 'Escape' && arcPts.length) { arcPts = []; hover = null; render(); say('Arc cancelled'); }
});
canvas.addEventListener('contextmenu', (e) => {
  e.preventDefault();
  if (arcPts.length) { arcPts = []; hover = null; render(); say('Arc cancelled'); }
});
// scroll zoom to cursor (0.25x–4x), persisted
canvas.addEventListener('wheel', (e) => {
  e.preventDefault();
  const r = canvas.getBoundingClientRect(), kx = canvas.width / r.width;
  const mx = (e.clientX - r.left) * kx, my = (e.clientY - r.top) * kx;
  const ns = Math.min(4, Math.max(0.25, view.s * Math.exp(-e.deltaY * 0.0015)));
  view.ox = mx - ((mx - view.ox) * ns) / view.s;
  view.oy = my - ((my - view.oy) * ns) / view.s;
  view.s = ns;
  saveView(view); render();
}, { passive: false });
// middle-click would autoscroll: suppress it
canvas.addEventListener('mousedown', (e) => { if (e.button === 1) e.preventDefault(); });

// Frame all content (pieces + built track): the way back when zoom/pan loses
// the track. Also applied after imports and loads so they always land visible.
function fitViewToContent() {
  const pts: Pt[] = pieces.flat();
  if (track) pts.push(...track.centerline);
  if (!pts.length) { view = { s: 1, ox: 0, oy: 0 }; }
  else {
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (const [x, y] of pts) { x0 = Math.min(x0, x); y0 = Math.min(y0, y); x1 = Math.max(x1, x); y1 = Math.max(y1, y); }
    const m = 60, W = canvas.width, H = canvas.height;
    const s = Math.min((W - 2 * m) / Math.max(1, x1 - x0), (H - 2 * m) / Math.max(1, y1 - y0));
    view = { s, ox: W / 2 - ((x0 + x1) / 2) * s, oy: H / 2 - ((y0 + y1) / 2) * s };
  }
  saveView(view); render();
}
gid('btn-fit').onclick = () => fitViewToContent();
canvas.addEventListener('dblclick', () => fitViewToContent());

// ---- render ----
// Smooth-stroke paths: midpoint quadratics render curves without facets,
// so turns look clean without denser data. Fill + strokes share it (no mismatch).
function pathOf(pts: Pt[], close: boolean) {
  ctx.beginPath();
  ctx.lineJoin = 'round'; ctx.lineCap = 'round';
  if (pts.length < 3) {
    pts.forEach((p, i) => (i ? ctx.lineTo(p[0], p[1]) : ctx.moveTo(p[0], p[1])));
    if (close) ctx.closePath();
    return;
  }
  if (close) {
    const m0 = [(pts[pts.length - 1][0] + pts[0][0]) / 2, (pts[pts.length - 1][1] + pts[0][1]) / 2];
    ctx.moveTo(m0[0], m0[1]);
    for (let i = 0; i < pts.length; i++) {
      const p = pts[i], m = pts[(i + 1) % pts.length];
      ctx.quadraticCurveTo(p[0], p[1], (p[0] + m[0]) / 2, (p[1] + m[1]) / 2);
    }
    ctx.closePath();
  } else {
    ctx.moveTo(pts[0][0], pts[0][1]);
    for (let i = 1; i < pts.length - 1; i++)
      ctx.quadraticCurveTo(pts[i][0], pts[i][1], (pts[i][0] + pts[i + 1][0]) / 2, (pts[i][1] + pts[i + 1][1]) / 2);
    const l = pts[pts.length - 1];
    ctx.lineTo(l[0], l[1]);
  }
}
// live: does a stroke overlap committed track? Delegates to the density-proof
// check in track.ts (exclusion in world px around the stroke's own ends).
// Red = invalid: placement is blocked.
function strokeOverlaps(seg: Pt[]): boolean {
  const w = Number(els.width.value);
  if (selfStrokeOverlaps(seg, w)) return true; // fold inside this stroke (incl. first)
  if (!pieces.length) return false;
  return segOverlapsExisting(allRaw(), seg, w);
}
function liveOverlap(): boolean {
  return drawing ? strokeOverlaps(drawing) : false;
}

// ---- width caps: sliders stop where the ribbon would self-overlap ----
// Same threshold as the draw guard (center distance < summed half-widths),
// but against the finished centerline with the live width profile.
const sepWin = (closed: boolean) => (closed ? 16 : 10);
function overlapsAt(general: number, gateWidths: number[]): boolean {
  if (!track || track.centerline.length < 8) return false;
  const t: Track = { ...track, width: general, gates: track.gates, gateWidths };
  return ribbonSelfOverlap(t.centerline, vertexWidths(t), t.closed, sepWin(t.closed));
}
// untouched gates (within 0.5 of general) follow the general slider; customized stay
function followerWidths(general: number, newW: number, widths: number[]): number[] {
  const out = widths.slice();
  track?.gates.forEach((_, i) => { if (Math.abs((out[i] ?? general) - general) < 0.5) out[i] = newW; });
  return out;
}
// max v in [lo,hi] that doesn't overlap; null when even lo overlaps (legacy blob)
function maxClean(lo: number, hi: number, bad: (v: number) => boolean): number | null {
  if (bad(lo)) return null;
  if (!bad(hi)) return hi;
  let ok = lo, ng = hi;
  while (ng - ok > 1) { const m = (ok + ng) >> 1; if (bad(m)) ng = m; else ok = m; }
  return ok;
}
// Clamp slider maxes AND values so widths can't grow into (or sit in) overlap.
// Null (overlap even at 20px): legacy blob — leave the value, freeze the max.
function refreshWidthCaps() {
  if (!track) return;
  const base = track.gateWidths ?? track.gates.map(() => track!.width);
  const g = maxClean(20, 120, (v) => overlapsAt(v, followerWidths(track!.width, v, base)));
  if (g !== null && g < track.width) {
    // geometry changed under the slider (e.g. loop just closed): shrink to the cap
    const oldW = track.width;
    track.width = g;
    els.width.value = String(g); els.widthVal.textContent = String(g);
    track.gateWidths = followerWidths(oldW, g, track.gateWidths ?? track.gates.map(() => oldW));
    say(`Road narrowed to ${g}px — wider would overlap the track.`);
  }
  if (track.gateWidths) {
    track.gateWidths.forEach((gw, i) => {
      if (i >= track!.gates.length) return;
      const cap = maxClean(20, 160, (v) => { const c = track!.gateWidths!.slice(); c[i] = v; return overlapsAt(track!.width, c); });
      if (cap !== null && cap < gw) {
        track!.gateWidths![i] = cap;
        say(`Checkpoint ${i + 1} narrowed to ${cap}px — wider would overlap the track.`);
      }
    });
  }
  const gMax = maxClean(20, 120, (v) => overlapsAt(v, followerWidths(track!.width, v, track!.gateWidths ?? []))) ?? track.width;
  els.width.max = String(Math.max(gMax, track.width));
  if (selectedGate !== null && track.gateWidths && selectedGate < track.gates.length) {
    const gw = track.gateWidths;
    const cap = maxClean(20, 160, (v) => { const c = gw.slice(); c[selectedGate!] = v; return overlapsAt(track!.width, c); }) ?? gw[selectedGate];
    (gid('in-gate-width') as HTMLInputElement).max = String(Math.max(cap, gw[selectedGate]));
  }
}

// Open drafts always ride at 20px: the width slider is locked until close,
// so there is never a stale too-big value to force-reduce afterwards.
function pinOpenWidth() {
  if (track && !track.closed && track.width !== 20) {
    track.width = 20;
    els.width.value = '20'; els.widthVal.textContent = '20';
  }
}
function renderLive() {
  render();
  if (!drawing) return;
  const bad = liveOverlap();
  ctx.strokeStyle = bad ? '#f44' : '#ff0'; ctx.lineWidth = bad ? 3 : 2; ctx.setLineDash([6, 4]);
  pathOf(drawing, false); ctx.stroke(); ctx.setLineDash([]);
  if (bad) say('Overlap — leave a full track-width gap.');
}
function render() {
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  ctx.setTransform(view.s, 0, 0, view.s, view.ox, view.oy);
  if (bg && bg.img.naturalWidth > 0) ctx.drawImage(bg.img, bg.x, bg.y, bg.img.naturalWidth * bg.s, bg.img.naturalHeight * bg.s);
  // pieces: inactive dim, active brighter
  pieces.forEach((pc, i) => {
    ctx.strokeStyle = i === active ? '#777' : '#4a4a4a'; ctx.lineWidth = 1;
    pathOf(pc, false); ctx.stroke();
  });
  // endpoint handles: active head green / tail red, others small gray
  endpoints().forEach((e) => {
    const isActive = e.piece === active;
    ctx.fillStyle = !isActive ? '#888' : e.end === 'head' ? '#0f0' : '#f44';
    ctx.beginPath(); ctx.arc(e.p[0], e.p[1], isActive ? 6 : 3, 0, Math.PI * 2); ctx.fill();
  });
  if (track && track.centerline.length >= 2) {
    const n = track.centerline.length, closed = track.closed;
    if (closed && n >= 8) {
      // edges first (wide), fill on top: inner overlap spikes hide under the fill
      const { left, right } = edges(track);
      ctx.strokeStyle = '#999'; ctx.lineWidth = 4;
      pathOf(left, closed); ctx.stroke();
      pathOf(right, closed); ctx.stroke();
      ctx.fillStyle = '#3d3d3d';
      pathOf(ribbon(track), true); ctx.fill();
      pathOf(seamPatch(track), true); ctx.fill(); // overlap strip: no seam notch possible
    }
    // actual line of every piece always visible — spot gaps while drawing
    pieces.forEach((pc, i) => {
      const b = buildFromPiece(pc);
      if (!b || b.center.length < 2) return;
      ctx.strokeStyle = i === active ? '#ffb300' : '#6b5f33';
      ctx.lineWidth = 2;
      pathOf(b.center, b.closed && b.center.length >= 8);
      ctx.stroke();
    });
    if (closed && n >= 8) {
      const cps = checkpoints(track);
      ctx.lineWidth = 2;
      cps.forEach((c, i) => {
        ctx.strokeStyle = i === selectedGate ? '#0f0' : '#fa0';
        ctx.lineWidth = i === selectedGate ? 4 : 2;
        ctx.beginPath(); ctx.moveTo(c.a[0], c.a[1]); ctx.lineTo(c.b[0], c.b[1]); ctx.stroke();
      });
      // start line: own gate at startS, independent of checkpoints (only when placed)
      if (track.startS != null) {
        const s0 = gateAt(track, track.startS % n / n);
        ctx.strokeStyle = '#fff'; ctx.lineWidth = 5;
        ctx.beginPath(); ctx.moveTo(s0.a[0], s0.a[1]); ctx.lineTo(s0.b[0], s0.b[1]); ctx.stroke();
      }
    }
  }
  // arc tool: clicked points + live preview
  if (arcPts.length > 0) {
    ctx.fillStyle = '#ff0';
    for (const p of arcPts) { ctx.beginPath(); ctx.arc(p[0], p[1], 4, 0, Math.PI * 2); ctx.fill(); }
    if (arcPts.length === 2 && hover) {
      const ps = snapToEndpoint(hover); // same snap as commit: preview == verdict
      const prev = sampleArc(arcPts[0], arcPts[1], ps ? [...ps.p] as Pt : hover);
      const bad = strokeOverlaps(prev);
      ctx.strokeStyle = bad ? '#f44' : '#ff0'; ctx.lineWidth = 2; ctx.setLineDash([6, 4]);
      pathOf(prev, false); ctx.stroke(); ctx.setLineDash([]);
    }
  }
  // ghost gate: where a click would place it
  if (tool === 'gate' && hover && track?.closed && track.centerline.length >= 8) {
    const g = gateAt(track, nearestIndex(track.centerline, hover) / track.centerline.length);
    ctx.strokeStyle = '#666'; ctx.lineWidth = 2; ctx.setLineDash([4, 4]);
    ctx.beginPath(); ctx.moveTo(g.a[0], g.a[1]); ctx.lineTo(g.b[0], g.b[1]); ctx.stroke(); ctx.setLineDash([]);
  }
  // eraser cursor
  if (tool === 'erase' && hover) {
    ctx.strokeStyle = '#f44'; ctx.lineWidth = 1;
    ctx.beginPath(); ctx.arc(hover[0], hover[1], ERASE_R / view.s, 0, Math.PI * 2); ctx.stroke();
  }
  syncGateEditor();
  const locked = track?.closed ?? false; // drawing tools sleep while the loop is closed
  const gateOff = !locked; // checkpoint tool needs a complete circuit
  els.width.disabled = !locked; // road width unlocks once the loop is closed (open drafts ride at 20px)
  (els.start as HTMLButtonElement).disabled = !locked; // start line needs a built circuit
  for (const [id, off] of [['btn-tool-free', locked], ['btn-tool-line', locked], ['btn-tool-arc', locked], ['btn-tool-gate', gateOff]] as const) {
    const b = document.getElementById(id);
    if (b && (b as HTMLButtonElement).disabled !== off) (b as HTMLButtonElement).disabled = off;
  }
  refreshDirection();
  validate();
}

let lastValidateHtml = '';
function validate() {
  const items: [boolean, string][] = [];
  const n = track?.centerline.length ?? 0;
  items.push([(track?.closed ?? false) && n >= 32, 'Closed loop']);
  if (lastRejection) items.push([false, lastRejection]);
  items.push([track?.startS != null && n >= 8, 'Start line placed']);
  const ng = track?.gates.length ?? 0;
  items.push([ng >= 3, `${ng}/3 checkpoints`]);
  const html = items.map(([ok, t]) => `<li class="${ok ? 'ok' : 'bad'}">${ok ? '✓' : '✗'} ${t}</li>`).join('');
  if (html !== lastValidateHtml) { checks.innerHTML = html; lastValidateHtml = html; } // same content, no DOM churn per mousemove
}

// ---- controls ----
els.undo.onclick = () => {
  if (hIndex <= 0) return;
  hIndex--;
  applySnap(history[hIndex]);
  rebuildTrack(); say('Undo');
};
els.redo.onclick = () => {
  if (hIndex >= history.length - 1) return;
  hIndex++;
  applySnap(history[hIndex]);
  rebuildTrack(); say('Redo');
};
els.clear.onclick = () => { pieces = []; active = 0; arcPts = []; hover = null; selectedGate = null; els.width.value = '20'; els.widthVal.textContent = '20'; touchPieces(); commit(); say('Cleared'); };
els.width.oninput = () => {
  if (track) {
    const oldW = track.width, wantW = Number(els.width.value);
    const base = track.gateWidths ?? track.gates.map(() => oldW);
    if (overlapsAt(wantW, followerWidths(oldW, wantW, base))) {
      const cap = maxClean(20, wantW, (v) => overlapsAt(v, followerWidths(oldW, v, base))) ?? Math.min(oldW, wantW);
      els.width.value = String(cap);
      say(`Width capped at ${cap}px — wider would overlap the track.`);
    }
    // untouched gates (still at the old general width) follow the slider; customized stay
    const oldW2 = track.width, newW = Number(els.width.value);
    track.gateWidths ??= track.gates.map(() => oldW2);
    track.gates.forEach((_, i) => { if (Math.abs((track!.gateWidths?.[i] ?? oldW2) - oldW2) < 0.5) track!.gateWidths![i] = newW; });
  }
  els.widthVal.textContent = els.width.value;
  rebuildTrack();
};
els.width.onchange = () => pushHistory(); // one undo step per drag, not per tick
// Start-pick mode: armed → must pick a point (or Esc/click button to cancel).
// Everything else in the panel locks while armed.
function setArmed(on: boolean) {
  if (on && (!track || !track.closed)) { say('Draw a closed loop first'); return; }
  setStartMode = on;
  els.start.classList.toggle('active', on);
  document.querySelectorAll('#panel button, #panel input, #panel select').forEach((el) => {
    if (el.id !== 'btn-start') (el as HTMLButtonElement).disabled = on;
  });
  canvas.style.cursor = on ? 'copy' : 'crosshair';
  if (on) say('Click the track to place the start line (Esc cancels)');
  render();
}
els.start.onclick = () => setArmed(!setStartMode);
// Manual checkpoints: click road to add (general width), click gate to select,
// click selected gate to deselect. Selected gate edits width / removes below.
let selectedGate: number | null = null;
// left-click: place a gate. right-click: select. Delete key: remove selected.
function gateDist(p: Pt, g: { a: Pt; b: Pt }): number {
  const vx = g.b[0] - g.a[0], vy = g.b[1] - g.a[1], L2 = vx * vx + vy * vy || 1;
  const tt = Math.max(0, Math.min(1, ((p[0] - g.a[0]) * vx + (p[1] - g.a[1]) * vy) / L2));
  return Math.hypot(p[0] - (g.a[0] + vx * tt), p[1] - (g.a[1] + vy * tt));
}
function nearestGate(p: Pt): number {
  if (!track) return -1;
  let bi = -1, bd = 20 / view.s;
  checkpoints(track).forEach((g, i) => { const d = gateDist(p, g); if (d < bd) { bd = d; bi = i; } });
  return bi;
}
function addGateAt(p: Pt) {
  if (!track) return;
  track.gateWidths ??= track.gates.map(() => track!.width);
  if (nearestGate(p) >= 0) { say('Checkpoint already here — right-click it to select'); return; }
  const fr = nearestIndex(track.centerline, p) / track.centerline.length;
  track.gates.push(fr);
  track.gateWidths.push(track.width);
  const order = track.gates.map((g, i) => i).sort((a, b) => track!.gates[a] - track!.gates[b]);
  track.gates = order.map((i) => track!.gates[i]);
  track.gateWidths = order.map((i) => track!.gateWidths![i]);
  selectedGate = track.gates.indexOf(fr);
  say(`Checkpoint ${track.gates.length} placed at width ${track.width}`);
  pushHistory(); refreshWidthCaps(); syncGateEditor(); persist(); render();
}
function selectGateAt(p: Pt) {
  if (!track) return;
  const bi = nearestGate(p);
  selectedGate = bi >= 0 && selectedGate !== bi ? bi : null;
  say(selectedGate === null ? 'Checkpoint deselected' : `Checkpoint ${selectedGate + 1} selected — set its width below`);
  refreshWidthCaps(); syncGateEditor(); render();
}
function removeSelectedGate() {
  if (!track || selectedGate === null || selectedGate >= track.gates.length) return;
  track.gates.splice(selectedGate, 1);
  track.gateWidths?.splice(selectedGate, 1);
  selectedGate = null;
  say(`Checkpoint removed (${track.gates.length} left)`);
  pushHistory(); refreshWidthCaps(); persist(); render();
}
// gate editor panel (Road section): width of selected gate + remove
function syncGateEditor() {
  const ed = gid('gate-editor');
  const ok = tool === 'gate' && track?.closed && selectedGate !== null && (track?.gates.length ?? 0) > selectedGate;
  ed.hidden = !ok;
  if (!ok || !track || selectedGate === null) return;
  (gid('in-gate-width') as HTMLInputElement).value = String(track.gateWidths?.[selectedGate] ?? track.width);
  gid('gate-width-val').textContent = String(track.gateWidths?.[selectedGate] ?? track.width);
  gid('gate-title').textContent = `Checkpoint ${selectedGate + 1} of ${track.gates.length}`;
}
const setTool = (t: typeof tool) => {
  if (setStartMode) return; // locked while start-pick is armed
  if (track?.closed && (t === 'free' || t === 'line' || t === 'arc')) return; // locked while closed
  tool = t; arcPts = []; hover = null; lineStart = null; drawing = null; erasing = false;
  if (moveBg) { moveBg = false; gid('btn-bg-move').classList.remove('active'); } // picking a tool ends background move
  for (const [id, tt] of [['btn-tool-free', 'free'], ['btn-tool-line', 'line'], ['btn-tool-arc', 'arc'], ['btn-tool-erase', 'erase'], ['btn-tool-gate', 'gate']] as const)
    document.getElementById(id)?.classList.toggle('active', tt === t);
  canvas.style.cursor = t === 'erase' ? 'cell' : 'crosshair';
  say(t === 'free' ? 'Free: drag from a glowing dot to extend, or start fresh'
    : t === 'line' ? 'Line: drag; both ends snap to dots'
    : t === 'arc' ? 'Arc: click 3 points (start, via, end)'
    : t === 'gate' ? 'Checkpoints: left-click road to add, right-click gate to select (Del removes)'
    : 'Erase: drag over track to delete sections');
  syncGateEditor(); render();
};
gid('btn-tool-free').onclick = () => setTool('free');
gid('btn-tool-line').onclick = () => setTool('line');
gid('btn-tool-arc').onclick = () => setTool('arc');
gid('btn-tool-erase').onclick = () => setTool('erase');
gid('btn-tool-gate').onclick = () => setTool('gate');

// ---- top-level views: builder vs placeholders ----
type MainView = 'tracks' | 'teams' | 'races';
function showView(v: MainView) {
  (gid('view-tracks') as HTMLElement).hidden = v !== 'tracks';
  (gid('view-teams') as HTMLElement).hidden = v !== 'teams';
  (gid('view-races') as HTMLElement).hidden = v !== 'races';
  if (v === 'teams') renderTeams();
  if (v === 'races') void renderRaces();
  else resetRaceSession();
  (Object.entries({ 'nav-tracks': 'tracks', 'nav-teams': 'teams', 'nav-races': 'races' }) as [string, MainView][])
    .forEach(([id, vv]) => gid(id).classList.toggle('active', vv === v));
  say('');
}
gid('nav-tracks').onclick = () => showView('tracks');
gid('nav-teams').onclick = () => showView('teams');
gid('nav-races').onclick = () => showView('races');

// ---- single-race setup (Story 3-4, subtask 4) ----
let raceCfg: RaceConfig | null = null; // locked selections (persisted)
type RacePane = 'landing' | 'setup' | 'practice' | 'quali' | 'race' | 'champ' | 'champsetup';
let racePane: RacePane = 'landing';
function setRacePane(p: RacePane) {
  racePane = p;
  (Object.entries({ 'race-landing': 'landing', 'race-setup': 'setup', 'race-champsetup': 'champsetup', 'race-practice': 'practice', 'race-quali': 'quali', 'race-race': 'race', 'race-champ': 'champ' }) as [string, RacePane][])
    .forEach(([id, vv]) => (gid(id) as HTMLElement).hidden = vv !== p);
  if (p === 'quali') { fitSessionCanvas(gid('quali-canvas') as HTMLCanvasElement); if (qualiIdx && !quali?.running) drawQualiScene([]); }
  if (p === 'race') { fitSessionCanvas(gid('race-canvas') as HTMLCanvasElement); if (raceIdx && !raceRunning) drawRaceSceneOnCanvas(); }
  if (p === 'practice') { fitSessionCanvas(gid('practice-canvas') as HTMLCanvasElement); if (practiceIdx && !previewRunning && session) drawPracticeScene(); }
}
// ponytail: track ribbon preview reuses the session renderer, no new drawing code.
function paintTrackPreview(canvasId: string, t: Track | undefined, gridN = 0) {
  const cv = gid(canvasId) as HTMLCanvasElement;
  const ctx = cv.getContext('2d')!;
  if (!t) { ctx.setTransform(1, 0, 0, 1, 0, 0); ctx.clearRect(0, 0, cv.width, cv.height); return; }
  const idx = makeTrackIndex(t);
  drawRaceScene(ctx, cv.width, cv.height, idx.track.centerline, idx.left, idx.right, ribbon(idx.track), undefined, startGridMarks(idx, gridN));
}
async function renderRaces() {
  setRacePane(racePane);
  const tracks = await listTracks();
  const sel = gid('sel-race-track') as HTMLSelectElement;
  sel.innerHTML = '';
  for (const t of tracks) {
    const o = document.createElement('option');
    o.value = t.id;
    o.textContent = `${t.name} (${t.centerline.length}pts)`;
    sel.appendChild(o);
  }
  if (!tracks.length) {
    const o = document.createElement('option');
    o.value = '';
    o.textContent = '(no tracks — build one first)';
    sel.appendChild(o);
  }
  sel.value = raceCfg && tracks.some((t) => t.id === raceCfg!.trackId) ? raceCfg.trackId : (tracks[0]?.id ?? '');
  const box = gid('race-teams');
  box.innerHTML = '';
  const checked = new Set(raceCfg?.teamIds.length ? raceCfg.teamIds : teams.map((t) => t.id));
  if (!teams.length) box.textContent = '(no teams — configure some first)';
  for (const t of teams) {
    const row = document.createElement('div');
    row.className = 'race-teamrow';
    const cb = document.createElement('input');
    cb.type = 'checkbox'; cb.value = t.id; cb.checked = checked.has(t.id);
    const sw = document.createElement('span');
    sw.className = 'swatch'; sw.style.background = t.primary;
    const nm = document.createElement('span');
    nm.textContent = t.name;
    const lab = document.createElement('label');
    lab.append(cb, sw, nm);
    const exp = document.createElement('button');
    exp.className = 'mini';
    exp.textContent = '↓';
    exp.title = 'Download this team\u2019s saved weights';
    exp.onclick = () => { void exportTeamWeights(t.id); };
    const imp = document.createElement('button');
    imp.className = 'mini';
    imp.textContent = '↑';
    imp.title = 'Load a weights file as this team\u2019s saved best';
    imp.onclick = () => { weightsImportTarget = t.id; gid('file-weights').click(); };
    const clr = document.createElement('button');
    clr.className = 'mini';
    clr.textContent = '✕';
    clr.title = 'Forget this team\u2019s saved weights (retrain from scratch)';
    clr.onclick = () => { void clearTeamWeights(t.id); };
    row.append(lab, exp, imp, clr);
    box.appendChild(row);
  }
  (gid('in-race-drivers') as HTMLInputElement).value = String(raceCfg?.drivers ?? 2);
  (gid('in-race-laps') as HTMLInputElement).value = String(raceCfg?.laps ?? 3);
  gid('race-setup-hint').textContent = '';
  const selPaint = () => {
    const drivers = Math.min(4, Math.max(1, Math.round(Number((gid('in-race-drivers') as HTMLInputElement).value) || 2)));
    const nTeams = gid('race-teams').querySelectorAll<HTMLInputElement>('input:checked').length;
    paintTrackPreview('setup-track-preview', tracks.find((t) => t.id === (gid('sel-race-track') as HTMLSelectElement).value), drivers * nTeams);
  };
  (gid('sel-race-track') as HTMLSelectElement).onchange = () => { selPaint(); void updateSkipButton(); };
  gid('race-teams').onchange = () => { selPaint(); void updateSkipButton(); };
  (gid('in-race-drivers') as HTMLInputElement).onchange = () => { selPaint(); };
  selPaint();
  void updateSkipButton();
  const tCard = gid('sel-race-track').closest('section') as HTMLElement | null;
  const eCard = gid('race-teams').closest('section') as HTMLElement | null;
  if (tCard && eCard) eCard.style.maxHeight = `${tCard.offsetHeight}px`; // teams card never taller than track card
}

// Skip-to-qualifying: enabled when every checked team has saved weights.
// Weights are per-team, not per-track — skipping onto a new track races on
// transferred skill, which may drive worse than track-trained weights.
async function updateSkipButton() {
  const btn = gid('btn-race-skip') as HTMLButtonElement;
  const teamIds = [...gid('race-teams').querySelectorAll<HTMLInputElement>('input:checked')].map((cb) => cb.value);
  const trackId = (gid('sel-race-track') as HTMLSelectElement).value;
  btn.disabled = true;
  if (!trackId || !teamIds.length) return;
  for (const id of teamIds) {
    const w = await loadWeights(id);
    if (!w) return; // one weightless team: train first
  }
  btn.disabled = false;
}

// Weights backup on the setup rows: export downloads saved weights, import
// stores a file as the team's saved best (picked up by the next session).
// Forget a team's saved weights + population: the next session starts from scratch.
async function clearTeamWeights(teamId: string) {
  const team = teams.find((t) => t.id === teamId);
  const name = team?.name ?? 'team';
  if (!await loadWeights(teamId)) { say(`${name} has no saved weights to clear.`); return; }
  if (!window.confirm(`Forget ${name}'s saved weights and retrain from scratch?`)) return;
  await deleteWeights(teamId);
  say(`${name}'s saved weights cleared — next session starts from scratch.`);
  void updateSkipButton();
}

async function exportTeamWeights(teamId: string) {
  const team = teams.find((t) => t.id === teamId);
  const w = await loadWeights(teamId);
  if (!w || !team) { say('No saved weights to export yet — train first.'); return; }
  const blob = new Blob([JSON.stringify(w, null, 2)], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob); a.download = `weights-${team.name}.json`; a.click();
  URL.revokeObjectURL(a.href);
}

(gid('file-weights') as HTMLInputElement).onchange = async (e) => {
  const f = (e.target as HTMLInputElement).files?.[0];
  (e.target as HTMLInputElement).value = '';
  const target = weightsImportTarget;
  weightsImportTarget = null;
  if (!f || !target) return;
  if (!practiceNet) practiceNet = buildNet();
  try {
    const wf = decodeWeightsFile(JSON.parse(await f.text()), practiceNet.size);
    if (!wf) { say('Import failed: bad weights file.'); return; }
    await saveWeights(target, wf);
    await savePopulation(target, []); // stale pop would shadow the import: session rebuilds from best
    say(`Weights imported for ${teams.find((t) => t.id === target)?.name ?? 'team'} — next session starts from them.`);
  } catch { say('Import failed: invalid weights JSON'); }
};
// ---- practice session (Story 3, subtask 5) ----
interface Island {
  pop: Float32Array[];
  best: Float32Array | null;
  bestFit: number;
  sigma: number | null;
  stasis: number;
  seed: number;
  epoch: number;
  lastAvg: number;
}
interface TeamTrain {
  teamId: string;
  status: 'idle' | 'training' | 'stopped';
  pop: Float32Array[]; // mirrored best-island pop (single place readers look)
  epoch: number; // max island epoch
  best: Float32Array | null; // best island best (fairly crowned)
  bestFit: number;
  lastAvg: number;
  sigma: number | null;
  stasis: number;
  islands: Island[];
  hof: { genome: Float32Array; fitness: number; epoch: number } | null; // hall of fame: best confirmed champion ever
  migAt: number; // max island epoch at last migration
  finalize: boolean; // consolidate mode: frozen sigma, no crossover/immigrants, worst-episode selection
  previewedAt: number; // last epoch shown as a practice ghost (per-team previews)
}
let practiceTeams: TeamTrain[] = [];
let practiceNet: GenomeNet | null = null;
let practiceIdx: TrackIndex | null = null;
let weightsImportTarget: string | null = null;

function islandCount(): number {
  const el = document.getElementById('in-ga-islands') as HTMLInputElement | null;
  const v = el ? Number(el.value) : NaN;
  return Number.isFinite(v) ? Math.min(4, Math.max(1, Math.round(v))) : 3;
}
function practiceCfg(): GAConfig {
  const num = (id: string, dflt: number) => {
    const v = Number((gid(id) as HTMLInputElement).value);
    return Number.isFinite(v) ? v : dflt;
  };
  const popSize = Math.min(256, Math.max(4, Math.round(num('in-ga-pop', 64))));
  return {
    popSize,
    elite: Math.min(4, Math.max(1, popSize - 1)),
    sigma: Math.min(0.5, Math.max(0.005, num('in-ga-sigma', 0.05))),
    episodes: 2, timeout: 20, laps: 1, crossoverRate: 0.7, robust: false,
  };
}

function stopPracticeAll() {
  for (const st of practiceTeams) if (st.status === 'training') st.status = 'stopped';
  stopPreviewLoop();
  updatePracticeCards();
}

// Leaving the Races tab wipes the last event: training, quali and race runtime
// state plus the saved session. Selections (raceCfg), teams, tracks and trained
// weights persist — only the event itself is forgotten.
function resetRaceSession() {
  enteringPractice = false;
  enteringQuali = false;
  stopPracticeAll();
  terminateAllWorkers(); // in-flight epochs die; their late results are dropped (team left)
  if (quali) quali.aborted = true;
  quali = null;
  qualiIdx = null;
  raceAbort = true;
  raceRunning = false;
  raceCars = [];
  raceIdx = null;
  qualiSel = null;
  raceSel = null;
  qualiTrails.clear();
  stopPreviewLoop();
  practiceTeams = [];
  practiceIdx = null;
  void saveRaceSession(null);
  setRacePane('landing');
}

function fmtFit(f: number) { return Number.isFinite(f) ? f.toFixed(0) : '—'; }


let practiceGen = 0; // bumped every entry: late epochs from a previous event are dropped
let enteringPractice = false; // async re-entry guard: double Begin clicks share one build
async function enterPractice(): Promise<boolean> {
  if (!raceCfg) return false;
  const tracks = await listTracks();
  const t = tracks.find((x) => x.id === raceCfg!.trackId);
  if (!t) { say('Saved track is gone — pick another.'); setRacePane('setup'); return false; }
  const myGen = ++practiceGen;
  if (enteringPractice) return false;
  enteringPractice = true;
  stopPracticeAll();
  terminateAllWorkers(); // fresh pool: no old epoch can occupy a slot or write late
  const net = practiceNet ?? (practiceNet = buildNet());
  practiceIdx = makeTrackIndex(t);
  const cfg = practiceCfg();
  practiceTeams = [];
  for (const id of raceCfg.teamIds) {
    const team = teams.find((x) => x.id === id);
    if (!team) continue;
    const savedW = await loadWeights(id);
    const savedP = await loadPopulation(id);
    let best: Float32Array | null = null;
    let pop: Float32Array[];
    if (savedW && savedW.weights.length === net.size) {
      const b = new Float32Array(savedW.weights);
      best = b;
      pop = savedP?.length && savedP.every((g) => g.length === net.size)
        ? savedP.map((g) => new Float32Array(g))
        : [b.slice(), ...Array.from({ length: cfg.popSize - 1 }, () => mutateGenome(b, cfg.sigma, Math.random))];
    } else {
      pop = initPop(net, cfg.popSize, (Math.random() * 2 ** 31) | 0);
    }
    const K = islandCount();
    const islands: Island[] = [];
    for (let i = 0; i < K; i++) {
      if (i === 0) {
        islands.push({ pop: pop.map((g) => g.slice()), best: best ? best.slice() : null, bestFit: -Infinity, sigma: null, stasis: 0, seed: (Math.random() * 2 ** 31) | 0, epoch: 0, lastAvg: NaN });
      } else if (best) {
        const b = best.slice();
        islands.push({ pop: [b.slice(), ...Array.from({ length: Math.max(0, cfg.popSize - 1) }, () => mutateGenome(b, cfg.sigma, Math.random))], best: b.slice(), bestFit: -Infinity, sigma: null, stasis: 0, seed: (Math.random() * 2 ** 31) | 0, epoch: 0, lastAvg: NaN });
      } else {
        islands.push({ pop: initPop(net, cfg.popSize, (Math.random() * 2 ** 31) | 0), best: null, bestFit: -Infinity, sigma: null, stasis: 0, seed: (Math.random() * 2 ** 31) | 0, epoch: 0, lastAvg: NaN });
      }
    }
    practiceTeams.push({ teamId: id, status: best ? 'stopped' : 'idle', pop, epoch: 0, best: best ? best.slice() : null, bestFit: -Infinity, lastAvg: NaN, sigma: null, stasis: 0, islands, hof: null, migAt: 0, finalize: false, previewedAt: -1 });
  }
  (gid('in-ga-preview') as HTMLInputElement).value = String(raceCfg.previewEvery ?? 0);
  beginSession();
  updateQualiGate();
  return true;
}



function updatePracticeCards() {
  // Session view: phase switches, completion, epoch counter, live leaderboard.
  const ses = session;
  if (ses && !ses.done) {
    for (const st of practiceTeams) {
      if (st.status === 'training' && st.epoch >= ses.total) {
        st.status = 'stopped'; // budgeted epochs done: rest while slower teams finish
        for (let i = 0; i < st.islands.length; i++) { try { teamWorkers.get(`${st.teamId}:${i}`)?.postMessage({ type: 'stop' }); } catch { /* worker gone */ } }
        continue;
      }
      if (st.status === 'training' && !st.finalize && st.epoch >= ses.exploreN) {
        st.finalize = true;
        for (const isl of st.islands) { isl.stasis = 0; isl.sigma = 0.01; }
        const team = teams.find((t) => t.id === st.teamId);
        say(`${team?.name ?? 'Team'} reached epoch ${ses.exploreN} — finalizing: σ frozen, worst-episode selection.`);
      }
    }
    if (practiceTeams.length && practiceTeams.every((s) => s.epoch >= ses.total)) finishSession();
    // Independent per-team preview: each team reaching a preview epoch puts its
    // current best on track (staggered — others join as they get there).
    const X = raceCfg?.previewEvery ?? 0;
    if (X > 0 && practiceIdx && practiceNet && racePane === 'practice') {
      for (const st of practiceTeams) {
        if (!st.best || st.epoch <= 0 || st.epoch % X !== 0 || st.previewedAt === st.epoch) continue;
        st.previewedAt = st.epoch;
        const team = teams.find((t) => t.id === st.teamId);
        if (!team) continue;
        previewCars = previewCars.filter((g) => g.teamId !== st.teamId); // unfinished run replaced
        const { car } = spawn(practiceIdx);
        previewCars.push({ teamId: st.teamId, car, genome: st.best.slice(), color: team.primary, secondary: team.secondary, hint: -1, prevFrac: null, prog: 0, done: false, frames: 0, phys: physicsFor(team) });
      }
      if (previewCars.length) ensurePreviewLoop();
    }
  }
  const ep = practiceTeams.length ? Math.max(...practiceTeams.map((s) => s.epoch)) : 0;
  const total = session?.total ?? 0;
  gid('practice-title').textContent = session ? `Practice — Epoch ${Math.min(ep, total)}/${total}` : 'Practice';
  renderPracticeBoard();
  updateQualiGate();
}

// ---- programmed practice session: explore N epochs, auto-finalize, done → quali ----
interface Session { exploreN: number; total: number; done: boolean }
let session: Session | null = null; // null outside a programmed session (e.g. before Begin)

function sessionCfg(): { exploreN: number; finalizeN: number } {
  const num = (id: string, dflt: number) => {
    const v = Number((gid(id) as HTMLInputElement).value);
    return Number.isFinite(v) ? v : dflt;
  };
  return {
    exploreN: Math.min(500, Math.max(1, Math.round(num('in-ga-explore', 80)))),
    finalizeN: Math.min(200, Math.max(0, Math.round(num('in-ga-finalize', 30)))),
  };
}

// Hands-off session: every team trains from epoch 0 to total; explore flips to
// finalize per team at exploreN; Start Quali unlocks when all teams finish.
function beginSession() {
  enteringPractice = false;
  const { exploreN, finalizeN } = sessionCfg();
  session = { exploreN, total: exploreN + finalizeN, done: false };
  for (const st of practiceTeams) { st.status = 'training'; st.finalize = false; st.previewedAt = -1; }
  say(`Practice: ${exploreN} explore + ${finalizeN} finalize epochs. Previews every ${raceCfg?.previewEvery ?? 0}.`);
  updatePracticeCards();
  drawPracticeScene();
  void scheduler();
}

function finishSession() {
  if (!session || session.done) return;
  session.done = true;
  stopPracticeAll();
  stopAllWorkers();
  say('Practice complete — qualifying is ready.');
  updatePracticeCards();
}

function renderPracticeBoard() {
  const ul = gid('practice-board');
  ul.innerHTML = '';
  const ranked = practiceTeams.slice().sort((a, b) => (b.bestFit ?? -Infinity) - (a.bestFit ?? -Infinity));
  ranked.forEach((st, i) => {
    const team = teams.find((t) => t.id === st.teamId);
    if (!team) return;
    boardRow(ul, {
      pos: `P${i + 1}`, mi: i, color: team.primary, team: team.name,
      name: st.status === 'training' ? (st.finalize ? `ep ${st.epoch} · finalizing` : `ep ${st.epoch} · exploring`) : 'weights kept',
      meta: `best ${fmtFit(st.bestFit)} · avg ${fmtFit(st.lastAvg)}`,
    });
  });
}

// Track background underlay (from the track record, if it has one): decoded once
// per image, then drawn under the ribbon in world units — same placement as
// the editor. Shared by practice, quali and race (same event track).
let bgCache: { data: string; img: HTMLImageElement } | null = null;
function trackBg(t: Track | null | undefined, onReady?: () => void): { img: HTMLImageElement; x: number; y: number; s: number } | null {
  const b = t?.bg;
  if (!b?.data) return null;
  if (!bgCache || bgCache.data !== b.data) {
    bgCache = null; // stale while the new image decodes
    loadImageEl(b.data).then((img) => { bgCache = { data: b.data, img }; onReady?.(); }).catch(() => { /* bad image: track without underlay */ });
    return null;
  }
  if (![b.x, b.y, b.s].every(isFinite) || b.s <= 0) return null;
  return { img: bgCache.img, x: b.x, y: b.y, s: b.s };
}
// grid boxes on every session scene: event grid size (0 = start line only)
function eventGridN(): number {
  return raceCfg ? raceCfg.drivers * raceCfg.teamIds.length : 0;
}
function drawPracticeScene() {
  if (!practiceIdx) return;
  const cv = gid('practice-canvas') as HTMLCanvasElement;
  fitSessionCanvas(cv);
  const ctx = cv.getContext('2d')!;
  const idx = practiceIdx;
  drawRaceScene(ctx, cv.width, cv.height, idx.track.centerline, idx.left, idx.right, ribbon(idx.track), trackBg(idx.track, () => { if (racePane === 'practice' && !previewRunning) drawPracticeScene(); }), startGridMarks(idx, eventGridN()));
}

// Session preview frame: same track, same size, same leaderboard — only the cars move.
function drawPracticePreview() {
  const idx = practiceIdx!;
  const cv = gid('practice-canvas') as HTMLCanvasElement;
  const ctx = cv.getContext('2d')!;
  drawRaceScene(ctx, cv.width, cv.height, idx.track.centerline, idx.left, idx.right, ribbon(idx.track), trackBg(idx.track, () => { if (previewRunning) drawPracticePreview(); }), startGridMarks(idx, eventGridN()));
  drawSessionCars(ctx, previewCars.map((g) => ({ x: g.car.x, y: g.car.y, heading: g.car.heading, primary: g.color, secondary: g.secondary, dim: g.done })), carSizeFor(idx.track.width));
}



// Central scheduler: teams train in parallel (one worker each), one epoch per
// training team per round, so auto-previews and pause/resume stay coordinated.
let schedActive = false;
const inFlight = new Set<string>(); // teamIds with a dispatched epoch (replaces the old single epochActive flag)
let previewRunning = false; // ghost loop alive (practice canvas shows driving ghosts)
const sleep = (ms: number) => new Promise<void>((res) => setTimeout(res, ms));

// One module worker per team, created lazily. Null when workers are unavailable
// (blocked CSP/file://): that team falls back to inline epochs on the UI thread.
const teamWorkers = new Map<string, Worker | null>();
let jobSeq = 0;
function getWorker(teamId: string): Worker | null {
  if (!teamWorkers.has(teamId)) {
    try {
      const w = new Worker(new URL('./train-worker.ts', import.meta.url), { type: 'module' });
      w.onerror = () => { teamWorkers.set(teamId, null); };
      teamWorkers.set(teamId, w);
    } catch { teamWorkers.set(teamId, null); }
  }
  return teamWorkers.get(teamId) ?? null;
}
function stopAllWorkers() {
  for (const w of teamWorkers.values()) { try { w?.postMessage({ type: 'stop' }); } catch { /* gone */ } }
}
function terminateAllWorkers() {
  for (const w of teamWorkers.values()) { try { w?.terminate(); } catch { /* gone */ } }
  teamWorkers.clear();
  inFlight.clear();
}
function runWorkerEpoch(w: Worker, job: { idx: TrackIndex; phys: PhysicsParams; pop: Float32Array[]; cfg: GAConfig; seed: number }): Promise<EpochResult> {
  return new Promise((resolve, reject) => {
    const jobId = ++jobSeq;
    const to = window.setTimeout(() => reject(new Error('epoch timed out')), 1000 * 60 * 30);
    const handler = (e: MessageEvent) => {
      const m = e.data as { type: string; jobId: number; ok: boolean; result?: EpochResult; error?: string };
      if (!m || m.type !== 'done' || m.jobId !== jobId) return;
      w.removeEventListener('message', handler);
      window.clearTimeout(to);
      if (m.ok && m.result) resolve(m.result);
      else reject(new Error(m.error ?? 'epoch failed'));
    };
    w.addEventListener('message', handler);
    w.postMessage({ type: 'epoch', jobId, ...job });
  });
}

async function scheduler() {
  if (schedActive) return;
  schedActive = true;
  try {
    for (;;) {
      const active = practiceTeams.filter((s) => s.status === 'training');
      if (!active.length) return;
      let dispatched = false;
      const key = (t: TeamTrain, i: number) => `${t.teamId}:${i}`;
      for (const st of active) {
        if (st.status !== 'training') continue;
        // migrate champions between islands when settled (no island in flight)
        const maxEp = st.islands.length ? Math.max(...st.islands.map((s) => s.epoch)) : 0;
        if (maxEp - st.migAt >= 5 && maxEp > 0 && st.islands.every((_, i) => !inFlight.has(key(st, i)))) {
          migrateIslands(st.islands.map((s) => s.pop), st.islands.map((s) => s.best), practiceCfg().elite, Math.random);
          st.migAt = maxEp;
        }
        for (let i = 0; i < st.islands.length; i++) {
          if (st.status !== 'training' || inFlight.has(key(st, i))) continue;
          inFlight.add(key(st, i));
          dispatched = true;
          void trainIslandEpoch(st, st.islands[i], i, practiceGen).finally(() => { inFlight.delete(key(st, i)); updatePracticeCards(); });
        }
      }
      await sleep(dispatched ? 100 : 250);
      if (!practiceTeams.some((s) => s.status === 'training')) return;
    }
  } finally { schedActive = false; }
}

function refreshTeamBest(st: TeamTrain) {
  if (!st.islands.length) return;
  let bi = 0;
  for (let i = 1; i < st.islands.length; i++) {
    if ((st.islands[i].bestFit ?? -Infinity) > (st.islands[bi].bestFit ?? -Infinity)) bi = i;
  }
  const b = st.islands[bi];
  st.best = b.best ? b.best.slice() : null;
  st.bestFit = b.bestFit;
  st.lastAvg = b.lastAvg;
  st.epoch = Math.max(...st.islands.map((s) => s.epoch));
  st.sigma = b.sigma; st.stasis = b.stasis;
  st.pop = b.pop;
}


async function trainIslandEpoch(st: TeamTrain, isl: Island, islIdx: number, myGen: number) {
  const team = teams.find((t) => t.id === st.teamId);
  if (!team || !practiceIdx || !practiceNet) return;
  const net = practiceNet; // narrowed copy for closures below
  const phys = physicsFor(team);
  const cfg = practiceCfg();
  if (st.finalize) { isl.sigma = 0.01; isl.stasis = 0; } // consolidate: frozen sigma, no restarts below
  else if (isl.sigma == null) isl.sigma = cfg.sigma; // first epoch: take the UI rate, then adapt
  const hof = st.hof;
  if (!st.finalize && hof && isl.stasis >= 10) {
    // champion + near mutants + fresh random immigrants: the immigrants bring
    // desaturated priors (throttle!) that crossover can combine with learned skills
    const near = restartPop(hof.genome, Math.max(2, Math.ceil(cfg.popSize / 2)), cfg.sigma, Math.random);
    const nFresh = Math.max(0, cfg.popSize - near.length);
    const fresh = Array.from({ length: nFresh }, (_, i) =>
      i % 2 === 0
        ? randomGenome(net, Math.random)
        : mutateGenome(withBrakeBias(hof.genome, 1.0 + Math.random() * 1.5), cfg.sigma, Math.random));
    isl.pop = [...near, ...fresh];
    isl.stasis = 0; isl.sigma = cfg.sigma;
    say(`${team.name} island ${islIdx + 1}: no progress for 10 epochs — restarting around its hall of fame.`);
  }
  const ecfg = st.finalize
    ? { ...cfg, sigma: 0.01, episodes: Math.max(4, cfg.episodes), crossoverRate: 0, robust: true, timeout: epochTimeout(practiceIdx.total, cfg.laps) }
    : { ...cfg, sigma: isl.sigma, timeout: epochTimeout(practiceIdx.total, cfg.laps) };
  while (isl.pop.length < ecfg.popSize && isl.best) isl.pop.push(mutateGenome(isl.best, isl.sigma, Math.random));
  if (isl.pop.length > ecfg.popSize) isl.pop.length = ecfg.popSize;
  updatePracticeCards();
  const key = `${st.teamId}:${islIdx}`;
  const w = getWorker(key);
  const stop = () => st.status !== 'training';
  let r: EpochResult;
  try {
    const seed = (isl.seed = (isl.seed + 1) >>> 0);
    r = w
      ? await runWorkerEpoch(w, { idx: practiceIdx, phys, pop: isl.pop, cfg: ecfg, seed })
      : await runEpoch(practiceIdx, phys, isl.pop, ecfg, seed, stop);
  } catch {
    // worker died mid-epoch: drop it, retry once inline (unless the team is gone/stopped)
    if (w) { try { w.terminate(); } catch { /* gone */ } teamWorkers.delete(key); }
    if (myGen !== practiceGen || !practiceTeams.some((s) => s.teamId === st.teamId) || st.status !== 'training') { updatePracticeCards(); return; }
    const seed2 = (isl.seed = (isl.seed + 1) >>> 0);
    r = await runEpoch(practiceIdx, phys, isl.pop, ecfg, seed2, stop);
  }
  if (myGen !== practiceGen || !practiceTeams.some((s) => s.teamId === st.teamId)) return; // stale event or team left mid-epoch: drop the result
  isl.pop = r.pop;
  if (r.partial) { updatePracticeCards(); return; }
  isl.epoch++;
  isl.lastAvg = r.avgFitness;
  st.lastAvg = r.avgFitness;
  if (!isl.best || r.bestFitness > isl.bestFit) {
    // second opinion: re-score the candidate on fresh spawns and crown the mean —
    // but only when the mean beats the reigning champion, so a lucky single eval
    // can't dethrone a confirmed best.
    let confirmFit = r.bestFitness;
    try {
      const cseed = (isl.seed = (isl.seed + 1) >>> 0);
      const w2 = getWorker(key);
      const rc = w2
        ? await runWorkerEpoch(w2, { idx: practiceIdx, phys, pop: [r.best.slice()], cfg: ecfg, seed: cseed })
        : await runEpoch(practiceIdx, phys, [r.best.slice()], ecfg, cseed, stop);
      if (myGen !== practiceGen || !practiceTeams.some((s) => s.teamId === st.teamId)) return;
      if (!rc.partial) confirmFit = (r.bestFitness + rc.bestFitness) / 2;
    } catch { /* confirm failed: fall back to single eval */ }
    if (!isl.best || confirmFit > isl.bestFit) {
      isl.best = r.best; isl.bestFit = confirmFit; isl.stasis = 0;
      if (!st.finalize) isl.sigma = adaptSigma(isl.sigma ?? cfg.sigma, cfg.sigma, true, 0);
      if (!st.hof || confirmFit > st.hof.fitness) st.hof = { genome: r.best.slice(), fitness: confirmFit, epoch: isl.epoch };
    } else {
      isl.stasis++;
      if (!st.finalize) isl.sigma = adaptSigma(isl.sigma ?? cfg.sigma, cfg.sigma, false, isl.stasis);
    }
  } else {
    isl.stasis++;
    if (!st.finalize) isl.sigma = adaptSigma(isl.sigma ?? cfg.sigma, cfg.sigma, false, isl.stasis);
  }
  refreshTeamBest(st);
  const sb = st.best; // crowned above when any island completed; guard for tsc
  if (sb) {
    await saveWeights(st.teamId, encodeWeightsFile(st.teamId, team.name, sb));
    await savePopulation(st.teamId, st.pop.map((g) => [...g]));
  }
  updatePracticeCards();
  updateQualiGate();
}

// Practice ghosts: one driving car per team, refreshed each preview epoch.
// Training never pauses — teams join the track as they hit their multiples,
// staggered. A team hitting its next multiple replaces its unfinished run.
interface GhostCar { teamId: string; car: CarState; genome: Float32Array; color: string; secondary: string; hint: number; prevFrac: number | null; prog: number; done: boolean; frames: number; phys: PhysicsParams }
let previewCars: GhostCar[] = [];

function stopPreviewLoop() {
  previewRunning = false;
  previewCars = [];
}

function ensurePreviewLoop() {
  if (previewRunning || !practiceIdx) return;
  previewRunning = true;
  requestAnimationFrame(previewStep);
}

function previewStep() {
  if (!previewRunning || racePane !== 'practice' || !practiceIdx || !practiceNet) { stopPreviewLoop(); return; }
  const idx = practiceIdx;
  for (const g of previewCars) {
    if (g.done) continue;
    const loc = locate(idx, g.car.x, g.car.y, g.hint);
    g.hint = loc.bi;
    if (g.prevFrac == null) g.prevFrac = loc.frac;
    let d = loc.frac - g.prevFrac;
    if (d > 0.5) d -= 1;
    else if (d < -0.5) d += 1;
    g.prog += d;
    g.prevFrac = loc.frac;
    if (loc.dist > loc.hw || g.prog >= 1 || ++g.frames > 60 * 75) { g.done = true; continue; }
    stepCar(g.car, forwardGenome(g.genome, observe(idx, g.car, loc)), g.phys);
  }
  previewCars = previewCars.filter((g) => !g.done);
  if (!previewCars.length) { previewRunning = false; drawPracticeScene(); return; }
  drawPracticePreview();
  requestAnimationFrame(previewStep);
}

// Liveried session cars: prerendered per team colors, rotated nose-along-heading.
// (drawCarPreview draws nose-up, so rotate by heading + 90°.)
const liveryCache = new Map<string, HTMLCanvasElement>();
// Session canvases fill the flex stage like the editor; backing store follows CSS size.
function fitSessionCanvas(cv: HTMLCanvasElement) {
  const r = cv.getBoundingClientRect();
  const w = Math.max(320, Math.round(r.width)), h = Math.max(240, Math.round(r.height));
  if (cv.width !== w || cv.height !== h) { cv.width = w; cv.height = h; return true; }
  return false;
}
function refitSessions() {
  if (!gid('race-quali').hidden && qualiIdx) {
    if (fitSessionCanvas(gid('quali-canvas') as HTMLCanvasElement) && !quali?.running) drawQualiScene([]);
  }
  if (!gid('race-race').hidden && raceIdx) {
    if (fitSessionCanvas(gid('race-canvas') as HTMLCanvasElement) && !raceRunning) drawRaceSceneOnCanvas();
  }
  if (!gid('race-practice').hidden && practiceIdx && session && !previewRunning) {
    if (fitSessionCanvas(gid('practice-canvas') as HTMLCanvasElement)) drawPracticeScene();
  }
}

function liveryFor(primary: string, secondary: string): HTMLCanvasElement {
  const k = primary + '|' + secondary;
  let cv = liveryCache.get(k);
  if (!cv) {
    cv = document.createElement('canvas');
    cv.width = 44; cv.height = 33;
    drawCarPreview(cv.getContext('2d')!, cv.width, cv.height, primary, secondary);
    liveryCache.set(k, cv);
  }
  return cv;
}
function drawSessionCars(ctx: CanvasRenderingContext2D, cars: { x: number; y: number; heading: number; primary: string; secondary: string; dim?: boolean }[], size = 24) {
  for (const c of cars) {
    const img = liveryFor(c.primary, c.secondary);
    const W = (size * img.width) / img.height;
    ctx.save();
    ctx.globalAlpha = c.dim ? 0.45 : 1;
    ctx.translate(c.x, c.y);
    ctx.rotate(c.heading + Math.PI / 2);
    ctx.drawImage(img, -W / 2, -size / 2, W, size);
    ctx.restore();
  }
  ctx.globalAlpha = 1;
}



function updateQualiGate() {
  const btn = gid('btn-start-quali') as HTMLButtonElement;
  const trained = raceCfg != null && raceCfg.teamIds.length > 0 && raceCfg.teamIds.every((id) => practiceTeams.some((s) => s.teamId === id && s.best));
  const ready = trained && (!session || session.done);
  btn.disabled = !ready;
  gid('practice-hint').textContent = ready || (session && !session.done) ? '' : 'Every team needs weights (train or import) to unlock qualifying.';
}
// ---- qualifying session (Story 4, subtask 7) ----
interface QualiRun { roster: Driver[]; entries: QualiEntry[]; idx: number; seed: number; aborted: boolean; running: boolean }
let quali: QualiRun | null = null;
let qualiIdx: TrackIndex | null = null;
let qualiGen = 0; // bumped every entry: stale loops/epochs from a previous run bail out
let enteringQuali = false; // async re-entry guard: double clicks share one build

async function enterQuali(fixedNames?: string[]) {
  if (!raceCfg || quali?.running || enteringQuali) return;
  enteringQuali = true;
  const myGen = ++qualiGen;
  stopPracticeAll();
  const tracks = await listTracks();
  const t = tracks.find((x) => x.id === raceCfg!.trackId);
  if (!t) { enteringQuali = false; say('Saved track is gone — pick another.'); setRacePane('setup'); return; }
  if (!practiceNet) practiceNet = buildNet();
  qualiIdx = makeTrackIndex(t);
  const pops = new Map<string, number[][]>();
  const bests = new Map<string, number[]>();
  const names = new Map<string, string>();
  for (const id of raceCfg.teamIds) {
    const team = teams.find((x) => x.id === id);
    if (!team) continue;
    pops.set(id, (await loadPopulation(id)) ?? []);
    const w = await loadWeights(id);
    if (w) bests.set(id, w.weights);
    names.set(id, team.name);
  }
  // entering quali always starts fresh: a half-run saved session never resumes
  // (abandoned runs looked "already in progress" on return).
  const seed = (Math.random() * 2 ** 31) | 0;
  const roster = buildRoster(raceCfg.teamIds, names, raceCfg.drivers, pops, bests, mulberry32(seed));
  if (fixedNames?.length === roster.length) roster.forEach((d, i) => (d.name = fixedNames[i])); // champ: stable driver names across races
  quali = { roster, entries: [], idx: 0, seed, aborted: false, running: false };
  qualiSel = null;
  qualiTrails.clear();
  quali.idx = quali.entries.length; // completed count (finish order, not roster order)
  (gid('btn-start-race') as HTMLButtonElement).disabled = true;
  setRacePane('quali');
  drawQualiScene([]); // immediate first paint so the canvas never sits blank
  renderQualiBoard();
  void renderLastResults();
  enteringQuali = false;
  void qualiLoop(myGen);
}

function qualiTimeout(): number {
  if (!qualiIdx || !raceCfg) return 60;
  let vMax = 1;
  for (const id of raceCfg.teamIds) {
    const team = teams.find((t) => t.id === id);
    if (team) vMax = Math.max(vMax, physicsFor(team).vMax);
  }
  return (4 * qualiIdx.total) / (0.5 * vMax); // generous: early AI crawls
}

// Simultaneous qualifying: the whole grid launches together from staggered slots
// and each driver's flying lap (line-to-line) is timed. Finished drivers keep
// their entries; reloads re-run only the unfinished.
interface QualiRunner {
  d: Driver; car: CarState; genome: Float32Array; phys: PhysicsParams;
  color: string; secondary: string;
  hint: number; prevFrac: number | null; prog: number; best: number; time: number; frames: number; stallT: number; stallProg: number;
  tZero: number | null; done: boolean; trail: TrailPt[];
}
let qualiLive: QualiRunner[] = [];
let qualiTrails = new Map<string, { color: string; trail: TrailPt[] }>(); // finished laps, kept for post-quali selection
// ponytail: quali stall rule — under 1% progress in 3s of drive time = DNF.
// (Race uses a speed-based rule below: fair from a standing start.)
function stalled(c: { prog: number; time: number; stallT: number; stallProg: number }): boolean {
  if (c.time - c.stallT < 3) return false;
  if (c.prog - c.stallProg < 0.01) return true;
  c.stallT = c.time; c.stallProg = c.prog;
  return false;
}

// Race stall rule: parked cars DNF. Speed-based over 5s windows (standstill
// launches read 0; anything rolling survives), plus a 30s progress backstop
// so wall-grinders going nowhere still get classified.
function raceStalled(r: { time: number; prog: number; spdT: number; spdAcc: number; prgT: number; prgMark: number }): boolean {
  if (r.time - r.spdT >= 5) {
    if (r.spdAcc / Math.max(1e-6, r.time - r.spdT) < 10) return true;
    r.spdT = r.time; r.spdAcc = 0;
  }
  if (r.time - r.prgT >= 30) {
    if (r.prog - r.prgMark < 0.005) return true;
    r.prgT = r.time; r.prgMark = r.prog;
  }
  return false;
}

async function qualiLoop(myGen: number) {
  if (myGen !== qualiGen || !quali || !qualiIdx || !practiceNet || quali.running) return;
  quali.running = true;
  const timeout = qualiTimeout();
  try {
    const doneKeys = new Set(quali.entries.map((e) => e.teamId + '|' + e.name));
    const lineup = quali.roster.filter((d) => !doneKeys.has(d.teamId + '|' + d.name));
    qualiLive = lineup.map((d) => {
      const team = teams.find((t) => t.id === d.teamId)!;
      return { d, car: { x: 0, y: 0, heading: 0, vx: 0, vy: 0 }, genome: new Float32Array(d.genome), phys: physicsFor(team), color: team.primary, secondary: team.secondary, hint: -1, prevFrac: null, prog: 0, best: 0, time: 0, frames: 0, stallT: 0, stallProg: 0, tZero: null, done: false, trail: [] };
    });
    if (qualiLive.length) {
      const slot = gridSlots(qualiIdx, 1)[0]; // quali: everyone launches from the same spot
      // prog rebased: 0 at the start line — the flying lap is timed line-to-line
      const qm = qualiIdx.n;
      const qStartFr = qualiIdx.track.startS == null ? 0 : (qualiIdx.track.startS % qm) / qm;
      const qProg0 = -((((qStartFr - projectFraction(qualiIdx.track.centerline, qualiIdx.track.closed, [slot.x, slot.y])) % 1) + 1) % 1);
      qualiLive.forEach((r) => { r.car = { x: slot.x, y: slot.y, heading: slot.heading, vx: 0, vy: 0 }; r.prog = qProg0; r.best = qProg0; r.stallT = 0; r.stallProg = qProg0; });
      say(`Qualifying — ${qualiLive.length} driver${qualiLive.length === 1 ? '' : 's'} on track together.`);
      await animateQualiAll(timeout, myGen);
    }
  } finally {
    if (myGen !== qualiGen) return; // superseded: the new run owns qualiLive now
    qualiLive = [];
    if (quali) {
      quali.idx = quali.entries.length;
      if (!quali.aborted && quali.idx >= quali.roster.length) (gid('btn-start-race') as HTMLButtonElement).disabled = false;
      quali.running = false;
    }
    renderQualiBoard();
  }
}

function animateQualiAll(timeout: number, myGen: number): Promise<void> {
  return new Promise((resolve) => {
    const idx = qualiIdx!;
    const finish = (r: QualiRunner, time: number | null) => {
      r.done = true;
      qualiTrails.set(driverKey(r.d.teamId, r.d.name), { color: r.color, trail: r.trail });
      if (myGen !== qualiGen || !quali) return;
      quali.entries.push({ teamId: r.d.teamId, teamName: r.d.teamName, name: r.d.name, time, progress: r.best });
      quali.idx = quali.entries.length;
      saveRaceSession({ stage: 'quali', cfg: raceCfg!, seed: quali.seed, quali: quali.entries, nextIdx: quali.idx }).catch(() => {});
    };
    const step = () => {
      if (myGen !== qualiGen || !quali || quali.aborted || !practiceNet) return resolve();
      try {
        let allDone = true;
        for (const r of qualiLive) {
          if (r.done) continue;
          allDone = false;
          const loc = locate(idx, r.car.x, r.car.y, r.hint);
          r.hint = loc.bi;
          if (r.prevFrac == null) r.prevFrac = loc.frac;
          let df = loc.frac - r.prevFrac;
          if (df > 0.5) df -= 1; else if (df < -0.5) df += 1;
          r.prog += df; if (r.prog > r.best) r.best = r.prog; r.prevFrac = loc.frac;
          const qctl = forwardGenome(r.genome, observe(idx, r.car, loc));
          r.trail.push({ x: r.car.x, y: r.car.y, th: qctl[0], br: qctl[1] });
          if (r.tZero == null && r.prog >= 0) r.tZero = r.time;
          if (loc.dist > loc.hw) finish(r, null);
          else if (r.prog >= 1) finish(r, r.time - (r.tZero ?? 0));
          else if (stalled(r)) finish(r, null);
          else if (r.time >= timeout || ++r.frames > 60 * 120) finish(r, null);
          else { stepCar(r.car, qctl, r.phys); r.time += DT; }
        }
        drawQualiScene(qualiLive.map((r) => ({ x: r.car.x, y: r.car.y, heading: r.car.heading, color: r.color, secondary: r.secondary, dim: r.done })));
        renderQualiBoard();
        if (allDone) { setTimeout(resolve, 800); return; }
        requestAnimationFrame(step);
      } catch { resolve(); }
    };
    requestAnimationFrame(step);
  });
}

function drawQualiScene(cars: (SceneCar & { secondary: string })[]) {
  const cv = gid('quali-canvas') as HTMLCanvasElement;
  const idx = qualiIdx!;
  const ctx = cv.getContext('2d')!;
  drawRaceScene(ctx, cv.width, cv.height, idx.track.centerline, idx.left, idx.right, ribbon(idx.track), trackBg(idx.track, () => { if (qualiIdx && !quali?.running) drawQualiScene([]); }), startGridMarks(idx, quali?.roster.length ?? eventGridN()));
  drawSessionCars(ctx, cars.map((c) => ({ x: c.x, y: c.y, heading: c.heading, primary: c.color, secondary: c.secondary, dim: c.dim })), carSizeFor(idx.track.width));
  if (qualiSel) {
    const size = carSizeFor(idx.track.width);
    const live = qualiLive.find((r) => driverKey(r.d.teamId, r.d.name) === qualiSel);
    if (live) drawHighlight(ctx, live.car.x, live.car.y, size, live.trail, []);
    else {
      const past = qualiTrails.get(qualiSel);
      if (past && past.trail.length > 1) {
        const p = past.trail[past.trail.length - 1];
        drawHighlight(ctx, p.x, p.y, size, past.trail, []);
      }
    }
  }
}

function fmtTime(t: number) {
  return t >= 60 ? `${Math.floor(t / 60)}:${(t % 60).toFixed(2).padStart(5, '0')}` : `${t.toFixed(2)}s`;
}

function medal(i: number) { return i === 0 ? ' p1' : i === 1 ? ' p2' : i === 2 ? ' p3' : ''; }
function boardRow(ul: HTMLElement, o: { pos: string; mi: number; color: string; team: string; name: string; meta: string; metaBad?: boolean; live?: boolean; dim?: boolean; liveId?: string; selected?: boolean; key?: string }) {
  const li = document.createElement('li');
  if (o.live) li.className = 'live';
  else if (o.dim) li.className = 'dim';
  if (o.selected) li.classList.add('sel');
  // selection reads ul.onmousedown (set per render): press/release land on
  // different rebuilt nodes mid-race, so click never fires at all.
  if (o.key) { li.classList.add('clickable'); li.dataset.key = o.key; }
  const pos = document.createElement('span'); pos.className = 'bpos' + medal(o.mi); pos.textContent = o.pos;
  const bar = document.createElement('span'); bar.className = 'bbar'; bar.style.background = o.color;
  const main = document.createElement('span'); main.className = 'bmain';
  const tm = document.createElement('span'); tm.className = 'bteam'; tm.textContent = o.team;
  const nm = document.createElement('span'); nm.className = 'bdriver'; nm.textContent = o.name;
  main.append(tm, nm);
  const meta = document.createElement('span'); meta.className = 'btime' + (o.metaBad ? ' dnf' : '');
  if (o.liveId) meta.id = o.liveId;
  meta.textContent = o.meta;
  li.append(pos, bar, main, meta);
  ul.appendChild(li);
}

let qualiSel: string | null = null; // single highlighted driver (teamId|name)
let raceSel: string | null = null;
const driverKey = (teamId: string, name: string) => `${teamId}|${name}`;

// selected driver: white ring + racing lines in track space after cars.
// Current lap action-painted (green = throttle, red = brake, gray = coast);
// older laps gray, fading with age.
function strokeColoredLine(ctx: CanvasRenderingContext2D, pts: TrailPt[], width: number, single?: string) {
  let cur = '';
  ctx.lineWidth = width;
  for (let i = 0; i < pts.length; i++) {
    const c = single ?? lineColor(pts[i].th, pts[i].br);
    if (c !== cur) {
      if (i > 0) ctx.stroke();
      ctx.beginPath();
      ctx.strokeStyle = c;
      if (i > 0) ctx.moveTo(pts[i - 1].x, pts[i - 1].y);
      cur = c;
    }
    ctx.lineTo(pts[i].x, pts[i].y);
  }
  if (pts.length) ctx.stroke();
}
function drawHighlight(ctx: CanvasRenderingContext2D, x: number, y: number, size: number, cur: TrailPt[], past: TrailPt[][]) {
  ctx.lineJoin = 'round'; ctx.lineCap = 'round';
  past.forEach((lap, i) => {
    if (lap.length < 2) return;
    ctx.save();
    ctx.globalAlpha = 0.5 * Math.pow(0.55, past.length - 1 - i);
    strokeColoredLine(ctx, lap, 3, '#8a8a8a');
    ctx.restore();
  });
  if (cur.length > 1) {
    strokeColoredLine(ctx, cur, 5, 'rgba(255,255,255,0.9)');
    strokeColoredLine(ctx, cur, 2.5);
  }
  ctx.strokeStyle = '#fff'; ctx.lineWidth = 3;
  ctx.beginPath(); ctx.arc(x, y, size * 0.85, 0, Math.PI * 2); ctx.stroke();
}
function toggleQualiSel(key: string) {
  qualiSel = qualiSel === key ? null : key;
  renderQualiBoard();
  if (!quali?.running) drawQualiScene([]);
}
function toggleRaceSel(key: string) {
  raceSel = raceSel === key ? null : key;
  renderRaceBoard();
  if (!raceRunning) drawRaceSceneOnCanvas();
}
function renderQualiBoard() {
  const ul = gid('quali-board');
  ul.onmousedown = (e) => {
    // hit-test press coords: press/release land on different rebuilt nodes,
    // so click never fires mid-race.
    const el = document.elementFromPoint(e.clientX, e.clientY);
    const k = (el?.closest('li') as HTMLElement | null)?.dataset.key;
    if (k) toggleQualiSel(k);
  };
  ul.innerHTML = '';
  const ranked = sortQuali(quali?.entries ?? []);
  const p1 = ranked.find((e) => e.time != null)?.time;
  // timed laps first, then everyone else purely by % reached — live position
  // for drivers, furthest point for DNFs. 27% dead beats 20% driving.
  let pos = 0;
  const row = (o: Parameters<typeof boardRow>[1], medal: boolean) => boardRow(ul, { ...o, pos: `P${++pos}`, mi: medal ? pos - 1 : -1 });
  ranked.filter((e) => e.time != null).forEach((e) => {
    const team = teams.find((t) => t.id === e.teamId);
    row({
      pos: '', mi: 0, color: team?.primary ?? '#888', team: e.teamName, name: e.name,
      meta: p1 != null && e.time !== p1 ? `+${(e.time! - p1).toFixed(2)}` : fmtTime(e.time!),
      selected: qualiSel === driverKey(e.teamId, e.name), key: driverKey(e.teamId, e.name),
    }, true);
  });
  const rest: { sort: number; live?: (typeof qualiLive)[number]; entry?: QualiEntry }[] = [
    ...qualiLive.filter((r) => !r.done).map((r) => ({ sort: r.prog, live: r })),
    ...ranked.filter((e) => e.time == null).map((e) => ({ sort: e.progress ?? -Infinity, entry: e })),
  ].sort((a, b) => b.sort - a.sort);
  rest.forEach(({ live: r, entry: e }) => {
    if (r) {
      row({
        pos: '', mi: -1, color: r.color, team: r.d.teamName, name: r.d.name,
        meta: `${fmtTime(r.time - (r.tZero ?? 0))} · ${(Math.max(0, r.prog) * 100).toFixed(0)}%`, live: true,
        selected: qualiSel === driverKey(r.d.teamId, r.d.name), key: driverKey(r.d.teamId, r.d.name),
      }, false);
    } else if (e) {
      const team = teams.find((t) => t.id === e.teamId);
      row({
        pos: '', mi: 0, color: team?.primary ?? '#888', team: e.teamName, name: e.name,
        meta: `DNF · ${(Math.max(0, e.progress ?? 0) * 100).toFixed(0)}%`, metaBad: true,
        selected: qualiSel === driverKey(e.teamId, e.name), key: driverKey(e.teamId, e.name),
      }, false);
    }
  });
  const qdone = quali?.entries.length ?? 0, qtotal = quali?.roster.length ?? 0;
  gid('btn-start-race').textContent = qtotal && qdone >= qtotal ? 'Start race' : `Start race (${qdone}/${qtotal})`;
}


async function renderLastResults() {
  const el = gid('race-last-results');
  el.textContent = '';
  if (!raceCfg) return;
  const s = await loadRaceSession();
  const same = s && s.stage === 'race' && s.cfg.trackId === raceCfg.trackId
    && s.cfg.teamIds.join() === raceCfg.teamIds.join() && s.cfg.drivers === raceCfg.drivers && s.cfg.laps === raceCfg.laps;
  if (!same || !s!.results?.length) return;
  const ordered = sortQuali(s!.results.map((r) => ({ teamId: r.teamId, teamName: r.teamName ?? teams.find((t) => t.id === r.teamId)?.name ?? r.teamId, name: r.name, time: r.time, progress: r.progress })));
  const w = ordered[0];
  el.textContent = w.time != null ? `Last race: ${w.name} wins in ${fmtTime(w.time)} (${ordered.length} drivers).` : '';
}

gid('btn-start-quali').onclick = () => { void enterQuali(champRace && champ ? champ.lineup.map((l) => l.name) : undefined); };
// ---- race session (Story 4, subtask 8) ----
interface RaceCar {
  teamId: string; teamName: string; name: string; car: CarState; genome: Float32Array; phys: PhysicsParams;
  color: string; hint: number; prevFrac: number | null; prog: number; bestProg: number; spdT: number; spdAcc: number; prgT: number; prgMark: number; trail: TrailPt[]; laps: TrailPt[][];
  time: number;
  done: boolean; dnf: boolean; finishTime: number | null;
  gateMap: Map<string, number>; // start/finish-line crossing times (key = lap:-1) for gap timing
  gapLockFor: string | null; gapLock: string | null; // frozen gap vs a finished car ahead
}
let raceCars: RaceCar[] = [];
let raceIdx: TrackIndex | null = null;
let raceRunning = false;
let raceAbort = false;
let raceGen = 0; // bumped every entry: stale lights/step loops from a previous run bail out
let raceLaps = 3;


async function enterRace() {
  if (!raceCfg || !quali || quali.idx < quali.roster.length || raceRunning) return;
  const myGen = ++raceGen;
  const tracks = await listTracks();
  const t = tracks.find((x) => x.id === raceCfg!.trackId);
  if (!t) { say('Saved track is gone — pick another.'); return; }
  if (!practiceNet) practiceNet = buildNet();
  raceIdx = makeTrackIndex(t);
  raceLaps = raceCfg.laps;
  const order = sortQuali(quali.entries);
  const slots = gridSlots(raceIdx, order.length);
  const m = raceIdx.n; // grid-slot arc scale for the prog rebase below
  try {
  raceSel = null;
  raceCars = order.map((e, i) => {
    const team = teams.find((x) => x.id === e.teamId)!;
    const qd = quali!.roster.find((d) => d.name === e.name && d.teamId === e.teamId)!;
    // prog rebased: 0 at the start line, not the grid — cars finish at the
    // finish line after raceLaps full laps, and stagger offsets stay fair.
    const startFr = t.startS == null ? 0 : (t.startS % m) / m;
    const slotFr = projectFraction(t.centerline, t.closed, [slots[i].x, slots[i].y]);
    const prog0 = -((((startFr - slotFr) % 1) + 1) % 1);
    return {
      teamId: e.teamId, teamName: e.teamName, name: e.name, phys: physicsFor(team),
      car: { x: slots[i].x, y: slots[i].y, heading: slots[i].heading, vx: 0, vy: 0 },
      genome: new Float32Array(qd.genome), color: team.primary,
      hint: -1, prevFrac: null, prog: prog0, bestProg: prog0, time: 0, spdT: 0, spdAcc: 0, prgT: 0, prgMark: prog0, gateMap: new Map(), trail: [], laps: [], gapLockFor: null, gapLock: null,
      done: false, dnf: false, finishTime: null,
    };
  });
  } catch { say('Could not build the starting grid.'); return; }
  raceAbort = false;
  setRacePane('race');
  drawRaceSceneOnCanvas();
  renderRaceBoard();
  void runStartLights(myGen);
}

// F1 start: 5 lamps at 0.6s intervals, random 0.4–1.8s hold, then lights out.
// Cars sit on the grid until the lamps go — raceStep only runs after.
async function runStartLights(myGen: number) {
  const el = gid('race-lights');
  el.hidden = false;
  const lamps = [...el.querySelectorAll('.light')];
  lamps.forEach((l) => l.classList.remove('on'));
  for (const lamp of lamps) {
    await sleep(600);
    if (myGen !== raceGen) return; // superseded: new run owns the lamps now
    if (raceAbort || !raceIdx) { el.hidden = true; return; }
    lamp.classList.add('on');
  }
  await sleep(400 + Math.random() * 1400);
  if (myGen !== raceGen) return;
  if (raceAbort || !raceIdx) { el.hidden = true; return; }
  lamps.forEach((l) => l.classList.remove('on'));
  say('LIGHTS OUT!');
  raceRunning = true;
  requestAnimationFrame(() => raceStep(myGen));
  window.setTimeout(() => { if (myGen === raceGen) el.hidden = true; }, 1200);
}

function raceStep(myGen: number) {
  if (myGen !== raceGen || !raceRunning || raceAbort || !raceIdx || !practiceNet) return;
  let allDone = true;
  for (const r of raceCars) {
    if (r.done) continue;
    allDone = false;
    try {
    const loc = locate(raceIdx, r.car.x, r.car.y, r.hint);
    r.hint = loc.bi;
    if (r.prevFrac == null) r.prevFrac = loc.frac;
    let df = loc.frac - r.prevFrac;
    if (df > 0.5) df -= 1;
    else if (df < -0.5) df += 1;
    r.prog += df; if (r.prog > r.bestProg) r.bestProg = r.prog;
    const rctl = forwardGenome(r.genome, observe(raceIdx, r.car, loc));
    const pt: TrailPt = { x: r.car.x, y: r.car.y, th: rctl[0], br: rctl[1] };
    r.trail.push(pt);
    // start/finish-line crossings feed lap times for gap timing (line-relative
    // prog: integer crossings ARE line crossings since the grid rebase)
    const lapNow = Math.floor(r.prog);
    if (Math.floor(r.prog - df) < lapNow) {
      const k = `${lapNow}:-1`;
      if (!r.gateMap.has(k)) {
        r.gateMap.set(k, r.time);
        // new lap: current line joins history (except the grid stub on lap 0),
        // fresh one starts at the line
        if (lapNow >= 1) {
          r.laps.push(r.trail);
          if (r.laps.length > 9) r.laps.shift();
        }
        r.trail = [pt];
      }
    }
    r.prevFrac = loc.frac;
    if (loc.dist > loc.hw) { r.done = true; r.dnf = true; continue; }
    if (r.prog >= raceLaps) { r.done = true; r.finishTime = r.time; continue; }
    if (raceStalled(r)) { r.done = true; r.dnf = true; continue; }
    if (r.time > 60 * 180) { r.done = true; r.dnf = true; continue; }
    stepCar(r.car, rctl, r.phys);
    r.time += DT;
    r.spdAcc += Math.hypot(r.car.vx, r.car.vy) * DT;
    } catch { r.done = true; r.dnf = true; }
  }
  try { drawRaceSceneOnCanvas(); renderRaceBoard(); } catch { /* a bad frame must never kill the race */ }
  if (allDone) { void finishRace(); return; }
  requestAnimationFrame(() => raceStep(myGen));
}

function drawRaceSceneOnCanvas() {
  const cv = gid('race-canvas') as HTMLCanvasElement;
  const idx = raceIdx!;
  const ctx = cv.getContext('2d')!;
  drawRaceScene(ctx, cv.width, cv.height, idx.track.centerline, idx.left, idx.right, ribbon(idx.track), trackBg(idx.track, () => { if (raceIdx && !raceRunning) drawRaceSceneOnCanvas(); }), startGridMarks(idx, raceCars.length));
  drawSessionCars(ctx, raceCars.map((r) => {
    const team = teams.find((t) => t.id === r.teamId);
    return { x: r.car.x, y: r.car.y, heading: r.car.heading, primary: r.color, secondary: team?.secondary ?? '#ffffff', dim: r.done };
  }), carSizeFor(idx.track.width));
  const sel = raceSel ? raceCars.find((r) => driverKey(r.teamId, r.name) === raceSel) : undefined;
  if (sel) drawHighlight(ctx, sel.car.x, sel.car.y, carSizeFor(idx.track.width), sel.trail, sel.laps);
}

function raceOrder(): RaceCar[] {
  return raceCars.slice().sort((a, b) => {
    // finishers by crossing time (frozen prog overshoot is NOT race order —
    // sorting by prog put the winner mid-pack); the rest purely by % reached,
    // live position or DNF furthest — same rule as the quali board.
    if (a.finishTime != null && b.finishTime != null) return a.finishTime - b.finishTime;
    if (a.finishTime != null) return -1;
    if (b.finishTime != null) return 1;
    return (b.dnf ? b.bestProg : b.prog) - (a.dnf ? a.bestProg : a.prog);
  });
}

// Gap to the car ahead: full laps down shown as +N LAP, otherwise the prog
// gap scaled by pace (last completed lap, else current-lap partial). Overtakes
// can't invert it — gate timestamps could, which is why the board went dashed.
function lastLapTime(r: RaceCar): number | null {
  for (let L = Math.floor(r.prog); L >= 1; L--) {
    const t1 = r.gateMap.get(`${L}:-1`), t0 = r.gateMap.get(`${L - 1}:-1`);
    if (t1 != null && t0 != null && t1 > t0) return t1 - t0;
  }
  return null;
}
function partialPace(r: RaceCar): number | null {
  const t0 = r.gateMap.get('0:-1');
  if (t0 == null || r.prog <= 0.005) return null;
  const p = (r.time - t0) / r.prog;
  return p > 0 ? p : null;
}
function gapToAhead(me: RaceCar, ahead: RaceCar): string | null {
  const dProg = ahead.prog - me.prog;
  if (Math.floor(dProg) >= 1) return `+${Math.floor(dProg)} LAP`;
  if (!(dProg > 0)) return null;
  const pace = lastLapTime(ahead) ?? lastLapTime(me) ?? partialPace(ahead) ?? partialPace(me);
  if (pace == null) return null;
  return `+${(dProg * pace).toFixed(2)}`;
}

function renderRaceBoard() {
  const ul = gid('race-board');
  ul.onmousedown = (e) => {
    const el = document.elementFromPoint(e.clientX, e.clientY);
    const k = (el?.closest('li') as HTMLElement | null)?.dataset.key;
    if (k) toggleRaceSel(k);
  };
  ul.innerHTML = '';
  const ordered = raceOrder();
  const winner = ordered.filter((r) => r.finishTime != null).sort((a, b) => a.finishTime! - b.finishTime!)[0];
  ordered.forEach((r, i) => {
    const team = teams.find((t) => t.id === r.teamId);
    let meta: string; let bad = false;
    if (r.finishTime != null) {
      meta = winner && winner !== r && winner.finishTime != null ? `+${(r.finishTime - winner.finishTime).toFixed(2)}` : 'Winner';
    } else if (r.dnf) { meta = 'DNF'; bad = true; }
    else if (i === 0) { meta = 'Leader'; }
    else {
      // gaps freeze once the car ahead finishes — recomputing against frozen
      // prog only ever shrinks the number on screen.
      const ahead = ordered[i - 1], akey = driverKey(ahead.teamId, ahead.name);
      if (ahead.finishTime != null) {
        if (r.gapLockFor !== akey) { r.gapLockFor = akey; r.gapLock = gapToAhead(r, ahead); }
        meta = r.gapLock ?? '—';
      } else { r.gapLockFor = null; r.gapLock = null; meta = gapToAhead(r, ahead) ?? '—'; }
    }
    boardRow(ul, {
      pos: `P${i + 1}`, mi: i, color: team?.primary ?? '#888', team: r.teamName, name: r.name,
      meta, metaBad: bad, dim: r.done,
      selected: raceSel === driverKey(r.teamId, r.name), key: driverKey(r.teamId, r.name),
    });
  });
  const lead = raceOrder().find((r) => !r.done) ?? raceOrder()[0];
  const cur = lead ? Math.min(raceLaps, Math.floor(Math.max(0, lead.prog)) + 1) : raceLaps;
  gid('race-lap').textContent = `Lap ${cur}/${raceLaps}`;
}

async function finishRace() {
  raceRunning = false;
  const order = raceOrder();
  const results = order.map((r) => ({ teamId: r.teamId, teamName: teams.find((t) => t.id === r.teamId)?.name ?? r.teamId, name: r.name, time: r.finishTime, progress: r.bestProg }));
  if (quali && raceCfg) await saveRaceSession({ stage: 'race', cfg: raceCfg, seed: quali.seed, quali: quali.entries, nextIdx: quali.idx, results });
  renderRaceBoard();
  const w = order[0];
  if (champRace && champ && raceCfg) {
    const i = champ.trackIds.indexOf(raceCfg.trackId);
    if (i >= 0) {
      champ.results[i] = results;
      champ.current = Math.max(champ.current, i + 1);
      champViewRace = i;
      await saveChamp(champ);
    }
    (gid('btn-race-to-champ') as HTMLButtonElement).hidden = false;
  }
  say(w && !w.dnf ? `${w.name} wins in ${fmtTime(w.finishTime!)}.` : 'Race over — no finishers.');
}

gid('btn-start-race').onclick = () => { void enterRace(); };
gid('btn-practice-back').onclick = () => {
  session = null; stopPracticeAll(); stopAllWorkers();
  if (champRace && champ) { void renderChampMenu(); return; } // locked settings: no setup to return to
  setRacePane('setup'); void renderRaces();
};
(gid('in-ga-preview') as HTMLInputElement).onchange = async () => {
  if (!raceCfg) return;
  const v = Math.max(0, Math.round(Number((gid('in-ga-preview') as HTMLInputElement).value) || 0));
  (gid('in-ga-preview') as HTMLInputElement).value = String(v);
  raceCfg.previewEvery = v;
  await saveRaceCfg(raceCfg);
};
gid('btn-race-begin').onclick = async () => {
  champRace = false; // single race owns the event now (stale champ routing dies here)
  const tracks = await listTracks();
  const teamIds = [...gid('race-teams').querySelectorAll<HTMLInputElement>('input:checked')].map((cb) => cb.value);
  const input = {
    trackId: (gid('sel-race-track') as HTMLSelectElement).value,
    teamIds,
    drivers: Number((gid('in-race-drivers') as HTMLInputElement).value),
    laps: Number((gid('in-race-laps') as HTMLInputElement).value),
  };
  const errs = validateSetup(input, tracks, teams);
  if (errs.length) { gid('race-setup-hint').textContent = errs[0]; say(errs[0]); return; }
  gid('race-setup-hint').textContent = '';
  raceCfg = { ...input, previewEvery: Math.max(0, Math.round(Number((gid('in-ga-preview') as HTMLInputElement).value) || 0)) };
  await saveRaceCfg(raceCfg);
  if (await enterPractice()) setRacePane('practice');
};
gid('btn-race-skip').onclick = async () => {
  champRace = false;
  const tracks = await listTracks();
  const teamIds = [...gid('race-teams').querySelectorAll<HTMLInputElement>('input:checked')].map((cb) => cb.value);
  const input = {
    trackId: (gid('sel-race-track') as HTMLSelectElement).value,
    teamIds,
    drivers: Number((gid('in-race-drivers') as HTMLInputElement).value),
    laps: Number((gid('in-race-laps') as HTMLInputElement).value),
  };
  const errs = validateSetup(input, tracks, teams);
  if (errs.length) { gid('race-setup-hint').textContent = errs[0]; say(errs[0]); return; }
  for (const id of teamIds) {
    if (!await loadWeights(id)) { say('A selected team has no saved weights — train first.'); return; }
  }
  gid('race-setup-hint').textContent = '';
  raceCfg = { ...input, previewEvery: 0 };
  await saveRaceCfg(raceCfg);
  void enterQuali();
};
gid('btn-race-single').onclick = () => { setRacePane('setup'); void renderRaces(); };
gid('btn-race-champ').onclick = () => {
  if (champ) {
    champViewRace = -1; // land on the next-race preview, nothing pre-selected
    void renderChampMenu();
  }
  else { setRacePane('champsetup'); void renderChampSetup(); }
};
gid('btn-race-setup-back').onclick = () => setRacePane('landing');
gid('btn-race-champ-back').onclick = () => setRacePane('landing');
gid('btn-champ-setup-back').onclick = () => setRacePane('landing');

// ---- championship (multi-race season, locked practice settings) ----
interface ChampGA { pop: number; islands: number; sigma: number; explore: number; finalize: number; preview: number }
interface Championship {
  trackIds: string[]; teamIds: string[]; drivers: number; laps: number;
  ga: ChampGA; lineup: { teamId: string; name: string }[];
  results: QualiSaved[][]; current: number;
}
let champ: Championship | null = null;
let champRace = false; // a champ race is running (practice/quali/race panes)
let champViewRace = -1; // selected completed race shown in the menu
const CHAMP_PTS = [25, 18, 15, 12, 10, 8, 6, 4, 2, 1];

// ponytail: persisted champ, unknown ids dropped; needs ≥2 tracks + ≥1 team.
function sanitizeChamp(o: unknown, tracks: Pick<Track, 'id'>[], teams: Pick<Team, 'id'>[]): Championship | null {
  if (!o || typeof o !== 'object') return null;
  const r = o as Record<string, unknown>;
  const trackIds = Array.isArray(r.trackIds) ? (r.trackIds as unknown[]).filter((id): id is string => typeof id === 'string' && tracks.some((t) => t.id === id)) : [];
  const teamIds = Array.isArray(r.teamIds) ? (r.teamIds as unknown[]).filter((id): id is string => typeof id === 'string' && teams.some((t) => t.id === id)) : [];
  const num = (v: unknown, dflt: number, lo: number, hi: number) => { const n = Math.round(Number(v)); return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : dflt; };
  const g = (r.ga ?? {}) as Record<string, unknown>;
  const ga: ChampGA = {
    pop: num(g.pop, 32, 4, 256), islands: num(g.islands, 3, 1, 4),
    sigma: typeof g.sigma === 'number' && isFinite(g.sigma) ? Math.min(0.5, Math.max(0.005, g.sigma)) : 0.05,
    explore: num(g.explore, 90, 1, 500), finalize: num(g.finalize, 40, 0, 200), preview: num(g.preview, 10, 0, 50),
  };
  const lineup = Array.isArray(r.lineup) ? (r.lineup as unknown[]).filter((e): e is { teamId: string; name: string } =>
    !!e && typeof e === 'object' && teamIds.includes((e as { teamId: string }).teamId) && typeof (e as { name: string }).name === 'string') : [];
  const results = Array.isArray(r.results) ? (r.results as unknown[]).map((res) =>
    Array.isArray(res) ? (res as unknown[]).filter((e): e is QualiSaved =>
      !!e && typeof e === 'object' && typeof (e as QualiSaved).teamId === 'string' && typeof (e as QualiSaved).name === 'string') : []) : [];
  if (trackIds.length < 2 || !teamIds.length) return null;
  const want = teamIds.length * num(r.drivers, 2, 1, 4);
  if (lineup.length !== want) return null; // stale lineup (drivers/teams changed): restart, don't guess
  return {
    trackIds, teamIds, drivers: num(r.drivers, 2, 1, 4), laps: num(r.laps, 3, 1, 10), ga, lineup,
    results: trackIds.map((_, i) => results[i] ?? []),
    current: Math.min(trackIds.length, num(r.current, 0, 0, trackIds.length)),
  };
}

function champCheckRow(box: HTMLElement, value: string, label: string, color: string | null, checked: boolean) {
  const row = document.createElement('div');
  row.className = 'race-teamrow';
  const lab = document.createElement('label');
  const cb = document.createElement('input');
  cb.type = 'checkbox'; cb.value = value; cb.checked = checked;
  lab.append(cb);
  if (color) { const sw = document.createElement('span'); sw.className = 'swatch'; sw.style.background = color; lab.append(sw); }
  const nm = document.createElement('span');
  nm.textContent = label;
  lab.append(nm);
  row.append(lab);
  box.appendChild(row);
}

async function renderChampSetup() {
  setRacePane('champsetup');
  const tracks = await listTracks();
  const tb = gid('champ-tracks');
  tb.innerHTML = '';
  if (!tracks.length) tb.textContent = '(no tracks — build some first)';
  const keepTracks = new Set(champ?.trackIds ?? tracks.map((t) => t.id));
  for (const t of tracks) champCheckRow(tb, t.id, `${t.name} (${t.centerline.length}pts)`, null, keepTracks.has(t.id));
  const eb = gid('champ-teams');
  eb.innerHTML = '';
  if (!teams.length) eb.textContent = '(no teams — configure some first)';
  const keepTeams = new Set(champ?.teamIds.length ? champ.teamIds : teams.map((t) => t.id));
  for (const t of teams) champCheckRow(eb, t.id, t.name, t.primary, keepTeams.has(t.id));
  gid('champ-setup-hint').textContent = '';
}

gid('btn-champ-begin').onclick = async () => {
  const tracks = await listTracks();
  const trackIds = [...gid('champ-tracks').querySelectorAll<HTMLInputElement>('input:checked')].map((cb) => cb.value);
  const teamIds = [...gid('champ-teams').querySelectorAll<HTMLInputElement>('input:checked')].map((cb) => cb.value);
  const num = (id: string) => Number((gid(id) as HTMLInputElement).value);
  const input = { trackIds, teamIds, drivers: num('in-champ-drivers'), laps: num('in-champ-laps') };
  const errs = validateChamp(input, tracks, teams);
  if (errs.length) { gid('champ-setup-hint').textContent = errs[0]; say(errs[0]); return; }
  gid('champ-setup-hint').textContent = '';
  const rand = mulberry32((Math.random() * 2 ** 31) | 0);
  const taken = new Set<string>();
  const lineup: { teamId: string; name: string }[] = [];
  for (const id of teamIds) for (let d = 0; d < input.drivers; d++) lineup.push({ teamId: id, name: driverName(rand, taken) });
  champ = {
    ...input, drivers: Math.round(input.drivers), laps: Math.round(input.laps),
    ga: {
      pop: Math.round(num('in-champ-pop')), islands: Math.round(num('in-champ-islands')),
      sigma: num('in-champ-sigma'), explore: Math.round(num('in-champ-explore')),
      finalize: Math.round(num('in-champ-finalize')), preview: Math.round(num('in-champ-preview')),
    },
    lineup, results: trackIds.map(() => []), current: 0,
  };
  champRace = false;
  await saveChamp(champ);
  renderChampMenu();
  setRacePane('champ');
};

// F1-style points for finishers only (DNF scores nothing).
function champPoints(c: Championship) {
  const tp = new Map<string, { name: string; pts: number }>();
  const dp = new Map<string, { team: string; name: string; pts: number }>();
  for (const id of c.teamIds) tp.set(id, { name: teams.find((t) => t.id === id)?.name ?? id, pts: 0 });
  for (const l of c.lineup) dp.set(`${l.teamId}|${l.name}`, { team: tp.get(l.teamId)?.name ?? l.teamId, name: l.name, pts: 0 });
  for (const res of c.results) {
    if (!res.length) continue;
    sortQuali(res.map((e) => ({ teamId: e.teamId, teamName: e.teamName ?? '', name: e.name, time: e.time, progress: e.progress })))
      .forEach((e, pos) => {
        if (e.time == null) return;
        const p = CHAMP_PTS[pos] ?? 0;
        if (!p) return;
        const team = teams.find((t) => t.id === e.teamId);
        const tName = e.teamName || team?.name || e.teamId;
        tp.set(e.teamId, { name: tName, pts: (tp.get(e.teamId)?.pts ?? 0) + p });
        const dk = `${e.teamId}|${e.name}`;
        dp.set(dk, { team: tName, name: e.name, pts: (dp.get(dk)?.pts ?? 0) + p });
      });
  }
  const byPts = (a: { pts: number; name: string }, b: { pts: number; name: string }) => b.pts - a.pts || a.name.localeCompare(b.name);
  return {
    teams: [...tp.entries()].map(([id, v]) => ({ id, ...v })).sort(byPts),
    drivers: [...dp.entries()].map(([id, v]) => ({ id, ...v })).sort(byPts),
  };
}


async function renderChampMenu() {
  if (!champ) { setRacePane('landing'); return; }
  const c = champ;
  const allTracks = await listTracks(); // one read up front: DOM below updates in a single paint, no flash
  const tname = (id: string) => allTracks.find((t) => t.id === id)?.name ?? '(deleted track)';
  setRacePane('champ');
  const { teams: tpts, drivers: dpts } = champPoints(c);
  const tb = gid('champ-teams-board');
  tb.innerHTML = '';
  tpts.forEach((t, i) => {
    const team = teams.find((x) => x.id === t.id);
    boardRow(tb, { pos: `P${i + 1}`, mi: i, color: team?.primary ?? '#888', team: 'TEAM', name: t.name, meta: `${t.pts} pts` });
  });
  const db = gid('champ-drivers-board');
  db.innerHTML = '';
  dpts.forEach((d, i) => {
    const team = teams.find((x) => x.id === d.id.split('|')[0]);
    boardRow(db, { pos: `P${i + 1}`, mi: i, color: team?.primary ?? '#888', team: d.team, name: d.name, meta: `${d.pts} pts` });
  });
  (db as HTMLElement).style.height = `${tb.offsetHeight}px`; // drivers: exactly the teams height, scroll inside
  const rb = gid('champ-races');
  const nextBtn = gid('btn-champ-next') as HTMLButtonElement;
  nextBtn.remove(); // detach before clearing: it lives inside a row now
  rb.innerHTML = '';
  let nextRow: HTMLElement | null = null;
  for (let i = 0; i < c.trackIds.length; i++) {
    const done = c.results[i]?.length > 0;
    const row = document.createElement('div');
    row.className = 'race-teamrow' + (i === champViewRace ? ' sel' : '') + (done ? ' done' : i === c.current ? ' live' : '');
    const nm = document.createElement('span');
    nm.style.flex = '1';
    nm.textContent = tname(c.trackIds[i]);
    const st = document.createElement('span');
    const kind = done ? 'done' : i === c.current ? 'next' : 'todo';
    st.className = `st ${kind}`;
    st.textContent = done ? 'done' : i === c.current ? 'next' : `race ${i + 1}`;
    row.append(nm);
    if (!done && i === c.current) nextRow = row; // start button goes here, right side
    else {
      row.append(st);
      if (done) row.onclick = ((idx) => () => { champViewRace = champViewRace === idx ? -1 : idx; void renderChampMenu(); })(i);
    }
    rb.appendChild(row);
  }
  if (c.current >= c.trackIds.length) {
    nextBtn.disabled = true; nextBtn.textContent = 'Championship complete';
    rb.parentElement!.appendChild(nextBtn);
  } else {
    nextBtn.disabled = false;
    nextBtn.textContent = c.results[c.current]?.length ? 'Re-run' : 'Start';
    (nextRow ?? rb).appendChild(nextBtn);
  }
  const view = champViewRace >= 0 && c.results[champViewRace]?.length ? champViewRace : -1;
  (gid('champ-result-card') as HTMLElement).hidden = view < 0;
  const res = gid('champ-results');
  res.innerHTML = '';
  if (view >= 0) {
    gid('champ-result-title').textContent = `Result — ${tname(c.trackIds[view])}`;
    sortQuali(c.results[view].map((e) => ({ teamId: e.teamId, teamName: e.teamName ?? '', name: e.name, time: e.time, progress: e.progress })))
      .forEach((e, i) => {
        const team = teams.find((t) => t.id === e.teamId);
        boardRow(res, {
          pos: `P${i + 1}`, mi: i, color: team?.primary ?? '#888', team: e.teamName || team?.name || e.teamId, name: e.name,
          meta: e.time != null ? fmtTime(e.time) : 'DNF', metaBad: e.time == null,
        });
      });
  }
  (res as HTMLElement).style.height = `${tb.offsetHeight}px`; // results: exactly the teams height, scroll inside
  const nextT = view < 0 ? allTracks.find((t) => t.id === c.trackIds[c.current]) : undefined;
  (gid('champ-next-card') as HTMLElement).hidden = !nextT;
  if (nextT) {
    gid('champ-next-title').textContent = `Upcoming: ${nextT.name} — Track preview`;
    paintTrackPreview('champ-next-preview', nextT, c.drivers * c.teamIds.length);
  }
}

async function startChampRace() {
  if (!champ || champ.current >= champ.trackIds.length) return;
  const c = champ;
  // locked practice settings: written into the single-race inputs practice reads.
  (gid('in-ga-pop') as HTMLInputElement).value = String(c.ga.pop);
  (gid('in-ga-islands') as HTMLInputElement).value = String(c.ga.islands);
  (gid('in-ga-sigma') as HTMLInputElement).value = String(c.ga.sigma);
  (gid('in-ga-explore') as HTMLInputElement).value = String(c.ga.explore);
  (gid('in-ga-finalize') as HTMLInputElement).value = String(c.ga.finalize);
  (gid('in-ga-preview') as HTMLInputElement).value = String(c.ga.preview);
  raceCfg = { trackId: c.trackIds[c.current], teamIds: [...c.teamIds], drivers: c.drivers, laps: c.laps, previewEvery: c.ga.preview };
  await saveRaceCfg(raceCfg);
  champRace = true;
  (gid('btn-race-to-champ') as HTMLButtonElement).hidden = true;
  if (await enterPractice()) setRacePane('practice');
}

gid('btn-champ-next').onclick = () => { void startChampRace(); };
gid('btn-champ-cancel').onclick = async () => {
  if (!champ) return;
  if (!window.confirm('Cancel the championship? Standings and results are lost.')) return;
  champ = null;
  champRace = false;
  champViewRace = -1;
  await saveChamp(null);
  setRacePane('landing');
};
gid('btn-race-to-champ').onclick = () => { renderChampMenu(); };

// ---- teams (Story 2: Team Configurer) ----
let teams: Team[] = [];
let editingId: string | null = null;
const SPECS = ['topSpeed', 'acceleration', 'brakeEfficiency', 'turningAbility'] as const;
function formTeam(): Team {
  const num = (id: string) => Number((gid(id) as HTMLInputElement).value);
  return {
    id: editingId ?? '',
    name: (gid('in-team-name') as HTMLInputElement).value,
    primary: (gid('in-team-primary') as HTMLInputElement).value,
    secondary: (gid('in-team-secondary') as HTMLInputElement).value,
    topSpeed: num('in-spec-topSpeed'),
    acceleration: num('in-spec-acceleration'),
    brakeEfficiency: num('in-spec-brakeEfficiency'),
    turningAbility: num('in-spec-turningAbility'),
  };
}
function paintPreview() {
  const cv = gid('team-preview') as HTMLCanvasElement;
  const t = formTeam();
  for (const k of SPECS) gid(`spec-${k}-val`).textContent = String(t[k]);
  drawCarPreview(cv.getContext('2d')!, cv.width, cv.height, t.primary, t.secondary);
}
function renderTeams() {
  const ul = gid('team-list');
  ul.innerHTML = '';
  teams.forEach((t) => {
    const li = document.createElement('li');
    if (t.id === editingId) li.classList.add('sel');
    const sw = document.createElement('span');
    sw.className = 'swatch'; sw.style.background = t.primary;
    const nm = document.createElement('span');
    nm.className = 'tname'; nm.textContent = t.name;
    const sp = document.createElement('span');
    sp.className = 'tspecs';
    sp.textContent = `${t.topSpeed}/${t.acceleration}/${t.brakeEfficiency}/${t.turningAbility}`;
    li.onclick = () => { editingId = editingId === t.id ? null : t.id; renderTeams(); }; // toggle: deselect returns to a blank new-team form
    li.append(sw, nm, sp);
    ul.appendChild(li);
  });
  const ed = editingId ? teams.find((t) => t.id === editingId) : null;
  (gid('team-editor') as HTMLElement).hidden = !ed;
  (gid('team-preview-card') as HTMLElement).hidden = !ed;
  if (!ed) return;
  (gid('in-team-name') as HTMLInputElement).value = ed.name;
  (gid('in-team-primary') as HTMLInputElement).value = ed.primary;
  (gid('in-team-secondary') as HTMLInputElement).value = ed.secondary;
  for (const k of SPECS) (gid(`in-spec-${k}`) as HTMLInputElement).value = String(ed[k]);
  (gid('btn-team-del') as HTMLButtonElement).disabled = false;
  paintPreview();
}
gid('btn-team-new').onclick = async () => {
  let n = teams.length + 1;
  while (teams.some((t) => t.name.toLowerCase() === `team ${n}`)) n++;
  const t = { ...blankTeam(uid()), name: `Team ${n}` };
  teams.push(t); editingId = t.id;
  await saveTeams(teams);
  renderTeams();
};
gid('btn-team-cancel').onclick = () => { renderTeams(); }; // revert unsaved edits for the selected team
gid('btn-team-save').onclick = async () => {
  const f = formTeam();
  const errs = teamErrors(f.name, editingId ?? '', teams);
  if (errs.length) { say(errs[0]); return; }
  f.name = f.name.trim();
  if (editingId && teams.some((t) => t.id === editingId)) {
    teams = teams.map((t) => (t.id === editingId ? f : t));
  } else {
    f.id = uid(); teams.push(f); editingId = f.id;
  }
  await saveTeams(teams);
  renderTeams();
  say(`Team "${f.name}" saved.`);
};
gid('btn-team-del').onclick = async () => {
  if (!editingId) return;
  teams = teams.filter((t) => t.id !== editingId);
  editingId = null;
  await saveTeams(teams);
  renderTeams();
  say('Team deleted.');
};
for (const k of SPECS) (gid(`in-spec-${k}`) as HTMLInputElement).oninput = () => paintPreview();
gid('in-team-primary').oninput = () => paintPreview();
gid('in-team-secondary').oninput = () => paintPreview();
gid('btn-teams-export').onclick = () => {
  if (!teams.length) { say('Nothing to export'); return; }
  const blob = new Blob([JSON.stringify(teams, null, 2)], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob); a.download = 'teams.json'; a.click();
  URL.revokeObjectURL(a.href);
};
gid('btn-teams-import').onclick = () => gid('file-teams').click();
(gid('file-teams') as HTMLInputElement).onchange = async (e) => {
  const f = (e.target as HTMLInputElement).files?.[0];
  (e.target as HTMLInputElement).value = '';
  if (!f) return;
  try {
    const arr = JSON.parse(await f.text());
    if (!Array.isArray(arr)) throw new Error('bad file');
    const seen = new Set<string>();
    const clean: Team[] = [];
    for (const o of arr) {
      const t = sanitizeTeam(o);
      if (!t) continue;
      let n = t.name, k = 2;
      while (seen.has(n.toLowerCase())) n = `${t.name} ${k++}`;
      seen.add(n.toLowerCase());
      clean.push({ ...t, id: uid(), name: n });
    }
    if (!clean.length) { say('Import failed: no valid teams.'); return; }
    teams = clean; editingId = clean[0].id;
    await saveTeams(teams);
    renderTeams();
    say(`Imported ${clean.length} team${clean.length === 1 ? '' : 's'}.`);
  } catch { say('Import failed: invalid teams JSON'); }
};
(gid('in-gate-width') as HTMLInputElement).oninput = (e) => {
  const input = e.target as HTMLInputElement;
  let v = Number(input.value);
  if (track && selectedGate !== null && track.gateWidths && selectedGate < track.gates.length) {
    const cur = track.gateWidths[selectedGate] ?? track.width;
    const cand = track.gateWidths.slice(); cand[selectedGate] = v;
    if (overlapsAt(track.width, cand)) {
      v = maxClean(20, v, (w) => { const c = track!.gateWidths!.slice(); c[selectedGate!] = w; return overlapsAt(track!.width, c); }) ?? Math.min(cur, v);
      input.value = String(v);
      say(`Checkpoint width capped at ${v}px — wider would overlap the track.`);
    }
    track.gateWidths[selectedGate] = v;
    persist(); refreshWidthCaps(); render();
  }
  gid('gate-width-val').textContent = String(v);
};
(gid('in-gate-width') as HTMLInputElement).onchange = () => pushHistory();
gid('btn-gate-remove').onclick = () => removeSelectedGate();
els.save.onclick = async () => {
  if (!track || track.centerline.length < 8) { say('Draw a valid loop first'); return; }
  track.name = els.name.value.trim() || `Track ${new Date().toLocaleString()}`;
  try {
    await saveTrack(bg ? { ...track, bg: { data: bg.data, x: bg.x, y: bg.y, s: bg.s } } : track);
    await refreshList();
    say(`Saved "${track.name}"`);
  } catch { say('Save failed: browser storage is full — remove the background or delete old tracks.'); }
};
els.load.onclick = async () => {
  const raw = (await listTracks()).find((t) => t.id === els.sel.value);
  const t = raw ? sanitizeTrack(raw) : null;
  if (!t || t.centerline.length < 2) { say('Saved track is corrupt — cannot load.'); return; }
  track = { ...t };
  track.closed = raw!.closed ?? dist(track.centerline[0], track.centerline[track.centerline.length - 1]) < 60;
  pieces = [t.centerline.map((p) => [...p] as Pt)]; active = 0; selectedGate = null;
  touchPieces();
  builtFor = { v: piecesVersion, active }; // verbatim: saved centerline needs no reprocessing
  els.width.value = String(t.width); els.widthVal.textContent = String(t.width);
  const lb = t.bg;
  if (lb?.data && [lb.x, lb.y, lb.s].every(isFinite) && lb.s > 0) {
    loadImageEl(lb.data).then((img) => setBg(img, lb.data, lb.x, lb.y, lb.s)).catch(() => { /* bad image: track still loads */ });
  } else if (bg) clearBg(); // record has no underlay: don't show the previous track's
  pushHistory(); pinOpenWidth(); refreshWidthCaps(); persist(); fitViewToContent(); say(`Loaded "${t.name}"`);
};
els.del.onclick = async () => { if (!els.sel.value) return; await deleteTrack(els.sel.value); await refreshList(); say('Deleted'); };
els.exp.onclick = () => {
  if (!track) { say('Nothing to export'); return; }
  const blob = new Blob([JSON.stringify(bg ? { ...track, bg: { data: bg.data, x: bg.x, y: bg.y, s: bg.s } } : track, null, 2)], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob); a.download = `${track.name || 'track'}.json`; a.click();
  URL.revokeObjectURL(a.href);
};
els.imp.onclick = () => els.file.click();
els.file.onchange = async () => {
  const f = els.file.files?.[0];
  if (!f) return;
  try {
    const raw = JSON.parse(await f.text()) as Track;
    if (!raw?.centerline?.length) throw new Error('bad file');
    const clean = sanitizeTrack(raw);
    if (!clean) throw new Error('bad file');
    const t = { ...clean, id: uid() };
    t.closed = raw.closed ?? dist(t.centerline[0], t.centerline[t.centerline.length - 1]) < 60;
    track = t;
    pieces = [track.centerline.map((p) => [...p] as Pt)]; active = 0; selectedGate = null;
    touchPieces();
    builtFor = { v: piecesVersion, active }; // verbatim: no reprocessing
    const fb = t.bg;
    if (fb?.data && [fb.x, fb.y, fb.s].every(isFinite) && fb.s > 0) {
      loadImageEl(fb.data).then((img) => setBg(img, fb.data, fb.x, fb.y, fb.s)).catch(() => { /* bad image: track still loads */ });
    }
    pushHistory(); pinOpenWidth(); refreshWidthCaps(); refreshList(); fitViewToContent(); say(`Imported (${track.centerline.length} pts)`);
  } catch { say('Import failed: invalid track JSON'); }
  els.file.value = '';
};
// ---- background image: underlay for tracing, world-space pan/scale ----
gid('btn-bg-import').onclick = () => gid('file-bg').click();
function clearBg() {
  bg = null; moveBg = false;
  gid('btn-bg-move').classList.remove('active');
  (gid('in-bg-scale') as HTMLInputElement).value = '100';
  gid('bg-scale-val').textContent = '100%';
  saveBgState();
}
gid('btn-bg-remove').onclick = () => { clearBg(); render(); say('Background removed.'); };
gid('btn-bg-move').onclick = () => {
  if (!bg) { say('Import a background first.'); return; }
  moveBg = !moveBg;
  gid('btn-bg-move').classList.toggle('active', moveBg);
  canvas.style.cursor = moveBg ? 'move' : 'crosshair';
  say(moveBg ? 'Drag to move the background (click Move again to draw).' : 'Move off.');
  render();
};
(gid('in-bg-scale') as HTMLInputElement).oninput = (e) => {
  const v = Number((e.target as HTMLInputElement).value);
  gid('bg-scale-val').textContent = `${v}%`;
  if (bg) { bg.s = v / 100; render(); }
};
(gid('in-bg-scale') as HTMLInputElement).onchange = () => saveBgState();
(gid('file-bg') as HTMLInputElement).onchange = async (e) => {
  const f = (e.target as HTMLInputElement).files?.[0];
  (e.target as HTMLInputElement).value = '';
  if (!f) return;
  try {
    const url = URL.createObjectURL(f);
    let img: HTMLImageElement;
    try { img = await loadImageEl(url); } finally { URL.revokeObjectURL(url); }
    const iw = img.naturalWidth || 512, ih = img.naturalHeight || 512;
    // downscale to 1024px for storage; PNG when transparent, else JPEG
    const k = Math.min(1, 1024 / Math.max(iw, ih));
    const cv = document.createElement('canvas');
    cv.width = Math.max(1, Math.round(iw * k)); cv.height = Math.max(1, Math.round(ih * k));
    const cx2 = cv.getContext('2d')!;
    cx2.drawImage(img, 0, 0, cv.width, cv.height);
    const px = cx2.getImageData(0, 0, cv.width, cv.height).data;
    let alpha = false;
    for (let i = 3; i < px.length; i += 16) if (px[i] < 128) { alpha = true; break; }
    const data = cv.toDataURL(alpha ? 'image/png' : 'image/jpeg', 0.85);
    const art = await loadImageEl(data);
    // fit into the current view, centered (clamped to the scale slider range)
    const s = Math.min(8, Math.max(0.05, Math.min(canvas.width / art.naturalWidth, canvas.height / art.naturalHeight)));
    const wx = (canvas.width / 2 - view.ox) / view.s, wy = (canvas.height / 2 - view.oy) / view.s;
    setBg(art, data, wx - (art.naturalWidth * s) / 2, wy - (art.naturalHeight * s) / 2, s);
    say('Background set — Move drags it, Scale resizes.');
  } catch { say('Background import failed.'); }
};

gid('btn-import-img').onclick = () => gid('file-image').click();
(gid('file-image') as HTMLInputElement).onchange = async (e) => {
  const f = (e.target as HTMLInputElement).files?.[0];
  (e.target as HTMLInputElement).value = '';
  if (!f) return;
  try {
    say('Tracing image…');
    const loop = await traceImageFile(f, 960, 600); // frozen world: imports land in fixed world units, same at any window size
    if (loop.length < 8) { say('No track found — need one-color circuit on plain background.'); return; }
    // auto-clear: drop the doodle, its gates/start and tool state, and bump the
    // pieces version — without touchPieces the rebuild below reuses the old
    // centerline and the import never appears.
    pieces = [loop]; active = 0; selectedGate = null;
    arcPts = []; hover = null; lineStart = null; drawing = null;
    track = null;
    touchPieces();
    els.width.value = '60'; els.widthVal.textContent = '60'; // fresh closed track: standard default (caps still apply)
    fitViewToContent(); // frame the import at any window size (also saves the view)
    commit(); say(`Traced ${loop.length} pts — set width, checkpoints, start.`);
  } catch { say('Image import failed.'); }
};

// Rasterize svg/png/jpg to a mask grid, thin to a skeleton, trace the loop,
// then fit it into the canvas. One code path for all formats.
const IMG_GRID = 512;
function loadImageEl(url: string): Promise<HTMLImageElement> {
  return new Promise((res, rej) => {
    const img = new Image();
    img.onload = () => res(img);
    img.onerror = rej;
    img.src = url;
  });
}
async function traceImageFile(f: File, cw: number, ch: number): Promise<Pt[]> {
  // svg without width/height rasterizes at garbage size: patch from viewBox first.
  let blob: Blob = f;
  if (/\.svg$/i.test(f.name) || f.type === 'image/svg+xml') {
    const text = await f.text();
    if (!/\swidth\s*=/.test(text.match(/<svg[^>]*>/)?.[0] ?? '')) {
      const vb = text.match(/viewBox\s*=\s*"([\d.\s-]+)"/)?.[1].split(/\s+/).map(Number) ?? [];
      const w = vb[2] > 0 ? vb[2] : 512, h = vb[3] > 0 ? vb[3] : 512;
      blob = new Blob([text.replace(/<svg(?![^>]*\swidth)/, `<svg width="${w}" height="${h}"`)], { type: 'image/svg+xml' });
    }
  }
  const url = URL.createObjectURL(blob);
  try {
    const img = await loadImageEl(url);
    const iw = img.naturalWidth || 512, ih = img.naturalHeight || 512;
    const k = Math.min(IMG_GRID / iw, IMG_GRID / ih);
    const gw = Math.max(32, Math.round(iw * k)), gh = Math.max(32, Math.round(ih * k));
    const cv = document.createElement('canvas');
    cv.width = gw; cv.height = gh;
    const cx = cv.getContext('2d', { willReadFrequently: true })!;
    cx.drawImage(img, 0, 0, gw, gh);
    const px = cx.getImageData(0, 0, gw, gh).data;
    const comp = largestComponent(buildMask(px, gw, gh), gw, gh);
    let track = 0;
    for (let i = 0; i < comp.length; i++) track += comp[i];
    if (!track) return [];
    thin(comp, gw, gh);
    simplifySkeleton(comp, gw, gh);
    // strip branch decorations to the closed core; fall back to plain walk
    // when nothing loop-like remains (open track or gappy image).
    const core = Uint8Array.from(comp);
    let raw: Pt[];
    if (extractCore(core, gw, gh) >= 64) {
      const biggest = largestComponent(core, gw, gh, true); // 8-connected: thin diagonals
      raw = traceLoop(biggest, gw, gh);
    } else {
      prune(comp, gw, gh);
      raw = traceLoop(comp, gw, gh);
    }
    if (raw.length < 8) return [];
    // fit track bbox into the fixed world box (cw/ch) with margin
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (const [x, y] of raw) { x0 = Math.min(x0, x); y0 = Math.min(y0, y); x1 = Math.max(x1, x); y1 = Math.max(y1, y); }
    const m = 40, s = Math.min((cw - 2 * m) / Math.max(1, x1 - x0), (ch - 2 * m) / Math.max(1, y1 - y0));
    return raw.map(([x, y]) => [m + (x - x0) * s, m + (y - y0) * s] as Pt);
  } finally {
    URL.revokeObjectURL(url);
  }
}
async function refreshList() {
  const ts = await listTracks();
  els.sel.innerHTML = ts.map((t) => `<option value="${t.id}">${t.name} (${t.centerline.length}pts)</option>`).join('');
}
// Canvas fills its flex container: backing store tracks CSS size, but the world
// is frozen — resizing never rewrites geometry (pieces, track, widths, caps,
// physics all stay window-independent). The VIEW follows the canvas instead,
// so on-screen framing is preserved; only newly revealed space differs.
let prevCW = 0, prevCH = 0; // last canvas backing size: the view follows growth/shrink, never the geometry
async function fitCanvas() {
  const r = canvas.getBoundingClientRect();
  const w = Math.max(50, Math.round(r.width)), h = Math.max(50, Math.round(r.height));
  if (w !== canvas.width || h !== canvas.height || !prevCW) {
    if (prevCW > 0 && prevCH > 0 && (w !== prevCW || h !== prevCH)) {
      // follow the axis that moved most (ties → width): backward ratios are
      // reciprocals, so the same axis is picked both ways and round trips
      // compose to exactly 1. min()/max() here decayed or ballooned the view.
      const wr = w / prevCW, hr = h / prevCH;
      const k = Math.abs(Math.log(wr)) >= Math.abs(Math.log(hr)) ? wr : hr;
      if (Number.isFinite(k) && k > 0) { view.s *= k; view.ox *= k; view.oy *= k; saveView(view); }
    }
    prevCW = w; prevCH = h;
    canvas.width = w; canvas.height = h;
  }
  rebuildTrack();
}
let fitT = 0;
new ResizeObserver(() => { window.clearTimeout(fitT); fitT = window.setTimeout(fitCanvas, 120); }).observe(canvas);
let sessT = 0;
window.addEventListener('resize', () => { window.clearTimeout(sessT); sessT = window.setTimeout(refitSessions, 150); });
// restore slider state from draft before first rebuild (else width snaps to default)
async function boot() {
  await storeReady();
  const v = await loadView();
  if (v && Number.isFinite(v.s) && v.s >= 0.05 && v.s <= 50 && Number.isFinite(v.ox + v.oy)) view = v;
  else if (v) { view = { s: 1, ox: 0, oy: 0 }; saveView(view); } // poisoned view (decayed/NaN): reset instead of restoring a blank screen
  await bootRestore();
  await refreshList();
  teams = await loadTeams(); renderTeams();
  raceCfg = sanitizeSetup(await loadRaceCfg(), await listTracks(), teams);
  champ = sanitizeChamp(await loadChamp(), await listTracks(), teams);
  // restore slider state from draft before first rebuild (else width snaps to default)
  const d = await loadDraft();
  if (d?.closed) {
    els.width.value = String(d.width); els.widthVal.textContent = String(d.width);
  } else {
    els.width.value = '20'; els.widthVal.textContent = '20'; // no built circuit yet
  }
  // restore background underlay (async decode, then paint)
  const b = await loadBg();
  if (b) {
    try {
      const img = await loadImageEl(b.data);
      bg = { img, data: b.data, x: b.x, y: b.y, s: b.s };
      (gid('in-bg-scale') as HTMLInputElement).value = String(Math.round(b.s * 100));
      gid('bg-scale-val').textContent = `${Math.round(b.s * 100)}%`;
    } catch { /* corrupt data: drop it */ saveBg(null); }
  }
  await fitCanvas();
}
void boot();
