import { buildMask, extractCore, largestComponent, prune, simplifySkeleton, thin, traceLoop } from './skeleton.ts';
import { blendSeam, checkpoints, closeLoop, dist, distToTrack, edges, gateAt, nearestIndex, pointAt, projectFraction, resample, ribbon, ribbonSelfOverlap, sampleArc, sampleLine, seamPatch, segOverlapsExisting, selfStrokeOverlaps, smooth, smoothOpen, uid, validateGeometry, vertexWidths, widthAt } from './track.ts';
import type { Pt, Track } from './track.ts';
import { deleteTrack, listTracks, loadBg, loadDraft, loadPieces, loadPopulation, loadRaceCfg, loadRaceSession, loadTeams, loadView, loadWeights, ready as storeReady, saveBg, saveDraft, savePieces, savePopulation, saveRaceCfg, saveRaceSession, saveTeams, saveTrack, saveView, saveWeights } from './storage.ts';
import { initPop, runEpoch } from './ga.ts';
import { actObs, buildNet, decodeWeightsFile, encodeWeightsFile, getGenome, mutateGenome, randomGenome, setGenome } from './nn.ts';
import type { EpochResult, GAConfig } from './ga.ts';
import type { GenomeNet } from './nn.ts';
import { locate, makeTrackIndex, mulberry32, observe, spawn, stepCar, DT } from './sim.ts';
import type { CarState, TrackIndex } from './sim.ts';
import { buildRoster, drawRaceScene, sanitizeSetup, sortQuali, validateSetup } from './race.ts';
import type { Driver, QualiEntry, RaceConfig, SceneCar } from './race.ts';
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
  const draft = await loadDraft();
  if (saved) { pieces = saved.pieces; active = saved.active; }
  else if (draft) { pieces = [draft.centerline.map((p) => [...p] as Pt)]; }
  if (draft?.closed === undefined && draft) (draft as Track).closed = true;
  fixActive();
  if (draft) { track = { ...draft, startS: !draft.startS ? null : draft.startS, gates: draft.gates ?? [], gateWidths: draft.gateWidths ?? (draft.gates ?? []).map(() => draft.width) }; say(`Draft restored (${draft.centerline.length} pts)`); }
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
const pos = (e: PointerEvent): Pt => {
  // scale client px -> canvas backing px -> world (inverse view)
  const r = canvas.getBoundingClientRect();
  const kx = canvas.width / r.width;
  return [((e.clientX - r.left) * kx - view.ox) / view.s, ((e.clientY - r.top) * kx - view.oy) / view.s];
};
canvas.addEventListener('pointerdown', (e) => {
  if (previewRunning) { previewAbort = true; say('Preview stopped — track is yours again.'); return; } // click takes the track back
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
  if (previewIdx) { renderPreviewScene(); return; }
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
      ctx.strokeStyle = i === active ? '#0af' : '#1f7aa8';
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
  validate();
}

function validate() {
  const items: [boolean, string][] = [];
  const n = track?.centerline.length ?? 0;
  items.push([(track?.closed ?? false) && n >= 32, 'Closed loop']);
  if (lastRejection) items.push([false, lastRejection]);
  items.push([track?.startS != null && n >= 8, 'Start line placed']);
  const ng = track?.gates.length ?? 0;
  items.push([ng >= 3, `${ng}/3 checkpoints`]);
  checks.innerHTML = items.map(([ok, t]) => `<li class="${ok ? 'ok' : 'bad'}">${ok ? '✓' : '✗'} ${t}</li>`).join('');
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
  else if (!previewActive) resetRaceSession();
  if (previewRunning && v !== 'tracks') previewAbort = true; // user bailed mid-preview
  (Object.entries({ 'nav-tracks': 'tracks', 'nav-teams': 'teams', 'nav-races': 'races' }) as [string, MainView][])
    .forEach(([id, vv]) => gid(id).classList.toggle('active', vv === v));
  say('');
}
gid('nav-tracks').onclick = () => showView('tracks');
gid('nav-teams').onclick = () => showView('teams');
gid('nav-races').onclick = () => showView('races');

// ---- single-race setup (Story 3-4, subtask 4) ----
let raceCfg: RaceConfig | null = null; // locked selections (persisted)
type RacePane = 'landing' | 'setup' | 'practice' | 'quali' | 'race' | 'champ';
let racePane: RacePane = 'landing';
function setRacePane(p: RacePane) {
  racePane = p;
  (Object.entries({ 'race-landing': 'landing', 'race-setup': 'setup', 'race-practice': 'practice', 'race-quali': 'quali', 'race-race': 'race', 'race-champ': 'champ' }) as [string, RacePane][])
    .forEach(([id, vv]) => (gid(id) as HTMLElement).hidden = vv !== p);
  if (p === 'quali') { fitSessionCanvas(gid('quali-canvas') as HTMLCanvasElement); if (qualiIdx && !quali?.running) drawQualiScene([]); }
  if (p === 'race') { fitSessionCanvas(gid('race-canvas') as HTMLCanvasElement); if (raceIdx && !raceRunning) drawRaceSceneOnCanvas(); }
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
    const lab = document.createElement('label');
    lab.className = 'race-teamrow';
    const cb = document.createElement('input');
    cb.type = 'checkbox'; cb.value = t.id; cb.checked = checked.has(t.id);
    const sw = document.createElement('span');
    sw.className = 'swatch'; sw.style.background = t.primary;
    const nm = document.createElement('span');
    nm.textContent = t.name;
    lab.append(cb, sw, nm);
    box.appendChild(lab);
  }
  (gid('in-race-drivers') as HTMLInputElement).value = String(raceCfg?.drivers ?? 2);
  (gid('in-race-laps') as HTMLInputElement).value = String(raceCfg?.laps ?? 3);
  gid('race-setup-hint').textContent = '';
}
// ---- practice session (Story 3, subtask 5) ----
interface TeamTrain {
  teamId: string;
  status: 'idle' | 'training' | 'stopped';
  pop: Float32Array[];
  epoch: number;
  best: Float32Array | null;
  bestFit: number;
  lastAvg: number;
  histBest: number[];
  histAvg: number[];
  seed: number;
  card?: { status: HTMLElement; stat: HTMLElement; canvas: HTMLCanvasElement; toggle: HTMLButtonElement; exp: HTMLButtonElement };
}
let practiceTeams: TeamTrain[] = [];
let practiceNet: GenomeNet | null = null;
let practiceIdx: TrackIndex | null = null;
let weightsImportTarget: string | null = null;

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
    episodes: 3, timeout: 30, laps: 1,
  };
}

function stopPracticeAll() {
  for (const st of practiceTeams) if (st.status === 'training') st.status = 'stopped';
  updatePracticeCards();
}

// Leaving the Races tab wipes the last event: training, quali and race runtime
// state plus the saved session. Selections (raceCfg), teams, tracks and trained
// weights persist — only the event itself is forgotten.
function resetRaceSession() {
  stopPracticeAll();
  if (quali) quali.aborted = true;
  quali = null;
  qualiIdx = null;
  raceAbort = true;
  raceRunning = false;
  raceCars = [];
  raceIdx = null;
  previewCars = [];
  previewIdx = null;
  previewHold = false;
  practiceTeams = [];
  practiceIdx = null;
  void saveRaceSession(null);
  setRacePane('landing');
}

function fmtFit(f: number) { return Number.isFinite(f) ? f.toFixed(0) : '—'; }

function spark(cv: HTMLCanvasElement, best: number[], avg: number[]) {
  const c = cv.getContext('2d')!;
  const W = cv.width, H = cv.height;
  c.clearRect(0, 0, W, H);
  const all = [...best, ...avg].filter(Number.isFinite);
  if (!all.length) return;
  let lo = Math.min(...all), hi = Math.max(...all);
  if (hi - lo < 1e-6) { lo -= 1; hi += 1; }
  const line = (arr: number[], col: string) => {
    c.strokeStyle = col; c.lineWidth = 1.5; c.beginPath();
    arr.forEach((v, i) => {
      const x = arr.length < 2 ? 2 : (i / (arr.length - 1)) * (W - 4) + 2;
      const y = H - 4 - ((v - lo) / (hi - lo)) * (H - 8);
      if (i) c.lineTo(x, y); else c.moveTo(x, y);
    });
    c.stroke();
  };
  line(avg, '#666'); line(best, '#0f0');
}

async function enterPractice(): Promise<boolean> {
  if (!raceCfg) return false;
  const tracks = await listTracks();
  const t = tracks.find((x) => x.id === raceCfg!.trackId);
  if (!t) { say('Saved track is gone — pick another.'); setRacePane('setup'); return false; }
  stopPracticeAll();
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
    practiceTeams.push({ teamId: id, status: best ? 'stopped' : 'idle', pop, epoch: 0, best, bestFit: -Infinity, lastAvg: NaN, histBest: [], histAvg: [], seed: (Math.random() * 2 ** 31) | 0 });
  }
  (gid('in-ga-preview') as HTMLInputElement).value = String(raceCfg.previewEvery ?? 0);
  buildPracticeCards();
  updateQualiGate();
  // one-time GPU warmup (shader compile) so the first Start click doesn't hitch
  setGenome(net, randomGenome(net, Math.random));
  for (let i = 0; i < 5; i++) actObs(net, new Array(16).fill(0));
  return true;
}

function buildPracticeCards() {
  const box = gid('practice-teams');
  box.innerHTML = '';
  for (const st of practiceTeams) {
    const team = teams.find((t) => t.id === st.teamId)!;
    const card = document.createElement('div');
    card.className = 'practice-card';
    const head = document.createElement('div');
    head.className = 'prow';
    const sw = document.createElement('span');
    sw.className = 'swatch'; sw.style.background = team.primary;
    const nm = document.createElement('strong');
    nm.textContent = team.name;
    const status = document.createElement('span');
    status.className = 'stat';
    head.append(sw, nm, status);
    const stat = document.createElement('div');
    stat.className = 'stat';
    const cv = document.createElement('canvas');
    cv.width = 220; cv.height = 60;
    const row = document.createElement('div');
    row.className = 'row';
    const toggle = document.createElement('button');
    toggle.textContent = 'Start';
    toggle.onclick = () => toggleTeam(st.teamId);
    const imp = document.createElement('button');
    imp.textContent = 'Import weights';
    imp.onclick = () => { weightsImportTarget = st.teamId; gid('file-weights').click(); };
    const exp = document.createElement('button');
    exp.textContent = 'Export weights';
    exp.onclick = () => exportTeamWeights(st.teamId);
    row.append(toggle, imp, exp);
    card.append(head, stat, cv, row);
    box.appendChild(card);
    st.card = { status, stat, canvas: cv, toggle, exp };
  }
  updatePracticeCards();
}

function updatePracticeCards() {
  for (const st of practiceTeams) {
    if (!st.card) continue;
    st.card.status.textContent = st.status === 'training' ? `training · epoch ${st.epoch}` : st.status === 'idle' ? 'idle' : 'stopped · weights kept';
    st.card.stat.textContent = `best ${fmtFit(st.bestFit)} · avg ${fmtFit(st.lastAvg)}`;
    st.card.toggle.textContent = st.status === 'training' ? 'Stop' : 'Start';
    st.card.exp.disabled = !st.best;
    spark(st.card.canvas, st.histBest, st.histAvg);
  }
}

function toggleTeam(id: string) {
  const st = practiceTeams.find((s) => s.teamId === id);
  if (!st || !practiceIdx || !practiceNet) return;
  if (st.status === 'training') st.status = 'stopped';
  else { st.status = 'training'; updatePracticeCards(); void scheduler(); }
  updatePracticeCards();
}

// Central scheduler: one epoch per training team per round, so auto-previews
// and pause/resume coordinate across teams (per-team loops can't do that).
let schedActive = false;
let epochActive = false;
let previewHold = false;
let previewRunning = false;
let previewAbort = false;
let previewActive = false;
const previewedEpochs = new Map<string, number>();
const sleep = (ms: number) => new Promise<void>((res) => setTimeout(res, ms));

async function scheduler() {
  if (schedActive) return;
  schedActive = true;
  try {
    for (;;) {
      if (previewHold) { await runPreviewCycle(); await sleep(200); continue; }
      const active = practiceTeams.filter((s) => s.status === 'training');
      if (!active.length) return;
      for (const st of active) {
        if (previewHold) break;
        if (st.status !== 'training') continue;
        await trainOneEpoch(st);
      }
    }
  } finally { schedActive = false; }
}

async function trainOneEpoch(st: TeamTrain) {
  const team = teams.find((t) => t.id === st.teamId);
  if (!team || !practiceIdx || !practiceNet) return;
  const phys = physicsFor(team);
  const cfg = practiceCfg();
  while (st.pop.length < cfg.popSize && st.best) st.pop.push(mutateGenome(st.best, cfg.sigma, Math.random));
  if (st.pop.length > cfg.popSize) st.pop.length = cfg.popSize;
  epochActive = true;
  let r: EpochResult;
  try {
    r = await runEpoch(practiceIdx, phys, practiceNet, st.pop, cfg, (st.seed = (st.seed + 1) >>> 0), () => st.status !== 'training' || previewHold);
  } finally { epochActive = false; }
  st.pop = r.pop;
  if (r.partial) { updatePracticeCards(); return; }
  st.epoch++;
  st.histBest.push(r.bestFitness);
  st.histAvg.push(r.avgFitness);
  st.lastAvg = r.avgFitness;
  if (!st.best || r.bestFitness > st.bestFit) { st.best = r.best; st.bestFit = r.bestFitness; }
  await saveWeights(st.teamId, encodeWeightsFile(st.teamId, team.name, st.best));
  await savePopulation(st.teamId, st.pop.map((g) => [...g]));
  const X = raceCfg?.previewEvery ?? 0;
  if (X > 0 && st.epoch > 0 && st.epoch % X === 0 && (previewedEpochs.get(st.teamId) ?? -1) !== st.epoch) {
    previewedEpochs.set(st.teamId, st.epoch);
    previewHold = true;
  }
  updatePracticeCards();
  updateQualiGate();
}

// Manual preview: park training, show all current bests together, resume.
async function requestManualPreview() {
  if (previewRunning) return;
  if (!practiceTeams.some((s) => s.best)) { say('Nothing to preview yet.'); return; }
  previewHold = true;
  updatePracticeCards();
  const t0 = Date.now();
  while (epochActive && Date.now() - t0 < 30000) await sleep(150);
  if (schedActive) {
    // scheduler picks up the hold and runs the cycle; wait for it to clear
    while (previewHold && !previewRunning && Date.now() - t0 < 180000) await sleep(200);
    if (previewHold && !previewRunning) previewHold = false; // scheduler went away: release
  } else {
    await runPreviewCycle();
  }
}

interface GhostCar { car: CarState; genome: Float32Array; color: string; secondary: string; hint: number; prevFrac: number | null; prog: number; done: boolean; frames: number; phys: PhysicsParams }
let previewCars: GhostCar[] = [];
let previewIdx: TrackIndex | null = null;

async function runPreviewCycle() {
  if (previewRunning) return; // single entry: scheduler or manual, never both
  const ready = practiceTeams.filter((s) => s.best);
  if (!ready.length || !practiceNet || !practiceIdx) { previewHold = false; return; }
  previewRunning = true;
  previewActive = true;
  previewAbort = false;
  try {
    previewIdx = practiceIdx;
    previewCars = ready.map((s) => {
      const team = teams.find((t) => t.id === s.teamId)!;
      const { car } = spawn(previewIdx!);
      return { car, genome: s.best!.slice(), color: team.primary, secondary: team.secondary, hint: -1, prevFrac: null, prog: 0, done: false, frames: 0, phys: physicsFor(team) };
    });
    showView('tracks');
    (document.querySelector('#panel') as HTMLElement).style.visibility = 'hidden'; // full-width track, no layout shift
    say(`Previewing bests — ${previewCars.length} car${previewCars.length === 1 ? '' : 's'} on track.`);
    await animateGhostLap();
  } finally {
    previewRunning = false;
    previewActive = false;
    previewHold = false;
    previewCars = [];
    previewIdx = null;
    (document.querySelector('#panel') as HTMLElement).style.visibility = '';
    if (!previewAbort) { showView('races'); setRacePane('practice'); }
    render();
  }
}

function animateGhostLap(): Promise<void> {
  return new Promise((resolve) => {
    const step = () => {
      if (previewAbort || !previewIdx || !practiceNet) return resolve();
      let allDone = true;
      for (const g of previewCars) {
        if (g.done) continue;
        allDone = false;
        setGenome(practiceNet, g.genome);
        const loc = locate(previewIdx, g.car.x, g.car.y, g.hint);
        g.hint = loc.bi;
        if (g.prevFrac == null) g.prevFrac = loc.frac;
        let d = loc.frac - g.prevFrac;
        if (d > 0.5) d -= 1;
        else if (d < -0.5) d += 1;
        g.prog += d;
        g.prevFrac = loc.frac;
        if (loc.dist > loc.hw || g.prog >= 1 || ++g.frames > 60 * 75) { g.done = true; continue; }
        stepCar(g.car, actObs(practiceNet, observe(previewIdx, g.car, loc)), g.phys);
      }
      render();
      if (allDone) { setTimeout(resolve, 800); return; }
      requestAnimationFrame(step);
    };
    requestAnimationFrame(step);
  });
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
function drawSessionCars(ctx: CanvasRenderingContext2D, cars: { x: number; y: number; heading: number; primary: string; secondary: string; dim?: boolean }[], size = 34) {
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

function renderPreviewScene() {
  const idx = previewIdx!;
  const c = idx.track.centerline;
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const [x, y] of c) { x0 = Math.min(x0, x); y0 = Math.min(y0, y); x1 = Math.max(x1, x); y1 = Math.max(y1, y); }
  const m = 40;
  const s = Math.min((canvas.width - 2 * m) / Math.max(1, x1 - x0), (canvas.height - 2 * m) / Math.max(1, y1 - y0));
  ctx.setTransform(s, 0, 0, s, m - x0 * s, m - y0 * s);
  const { left, right } = edges(idx.track);
  ctx.strokeStyle = '#999'; ctx.lineWidth = 4;
  pathOf(left, true); ctx.stroke();
  pathOf(right, true); ctx.stroke();
  ctx.fillStyle = '#3d3d3d';
  pathOf(ribbon(idx.track), true); ctx.fill();
  drawSessionCars(ctx, previewCars.map((g) => ({ x: g.car.x, y: g.car.y, heading: g.car.heading, primary: g.color, secondary: g.secondary, dim: g.done })));
}

function exportTeamWeights(teamId: string) {
  const st = practiceTeams.find((s) => s.teamId === teamId);
  const team = teams.find((t) => t.id === teamId);
  if (!st?.best || !team) { say('Nothing to export'); return; }
  const blob = new Blob([JSON.stringify(encodeWeightsFile(teamId, team.name, st.best), null, 2)], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob); a.download = `weights-${team.name}.json`; a.click();
  URL.revokeObjectURL(a.href);
}

(gid('file-weights') as HTMLInputElement).onchange = async (e) => {
  const f = (e.target as HTMLInputElement).files?.[0];
  (e.target as HTMLInputElement).value = '';
  if (!f || !weightsImportTarget || !practiceNet) return;
  const st = practiceTeams.find((s) => s.teamId === weightsImportTarget);
  weightsImportTarget = null;
  if (!st) return;
  try {
    const wf = decodeWeightsFile(JSON.parse(await f.text()), practiceNet.size);
    if (!wf) { say('Import failed: bad weights file.'); return; }
    const cfg = practiceCfg();
    st.best = new Float32Array(wf.weights); st.bestFit = -Infinity;
    st.pop = [st.best.slice(), ...Array.from({ length: Math.max(0, cfg.popSize - 1) }, () => mutateGenome(st.best!, cfg.sigma, Math.random))];
    st.epoch = 0; st.histBest = []; st.histAvg = []; st.lastAvg = NaN; st.status = 'stopped';
    await saveWeights(st.teamId, wf);
    await savePopulation(st.teamId, st.pop.map((g) => [...g]));
    updatePracticeCards(); updateQualiGate();
    say(`Weights imported for ${teams.find((t) => t.id === st.teamId)?.name ?? 'team'}.`);
  } catch { say('Import failed: invalid weights JSON'); }
};

function updateQualiGate() {
  const btn = gid('btn-start-quali') as HTMLButtonElement;
  const ready = raceCfg != null && raceCfg.teamIds.length > 0 && raceCfg.teamIds.every((id) => practiceTeams.some((s) => s.teamId === id && s.best));
  btn.disabled = !ready;
  gid('practice-hint').textContent = ready ? '' : 'Every team needs weights (train or import) to unlock qualifying.';
}
// ---- qualifying session (Story 4, subtask 7) ----
interface QualiRun { roster: Driver[]; entries: QualiEntry[]; idx: number; seed: number; aborted: boolean; running: boolean }
let quali: QualiRun | null = null;
let qualiIdx: TrackIndex | null = null;

async function enterQuali() {
  if (!raceCfg) return;
  stopPracticeAll();
  const tracks = await listTracks();
  const t = tracks.find((x) => x.id === raceCfg!.trackId);
  if (!t) { say('Saved track is gone — pick another.'); setRacePane('setup'); return; }
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
  const saved = await loadRaceSession();
  const sameCfg = saved && saved.stage === 'quali' && saved.cfg.trackId === raceCfg.trackId
    && saved.cfg.teamIds.join() === raceCfg.teamIds.join() && saved.cfg.drivers === raceCfg.drivers && saved.cfg.laps === raceCfg.laps;
  const seed = sameCfg ? saved.seed : (Math.random() * 2 ** 31) | 0;
  const roster = buildRoster(raceCfg.teamIds, names, raceCfg.drivers, pops, bests, mulberry32(seed));
  quali = { roster, entries: sameCfg ? saved.quali.map((e) => ({ ...e, teamName: names.get(e.teamId) ?? e.teamId })) : [], idx: sameCfg ? saved.nextIdx : 0, seed, aborted: false, running: false };
  (gid('btn-start-race') as HTMLButtonElement).disabled = true;
  setRacePane('quali');
  drawQualiScene([]); // immediate first paint so the canvas never sits blank
  renderQualiBoard(-1);
  void renderLastResults();
  if (sameCfg && quali.idx > 0) say(`Qualifying resumed at driver ${quali.idx + 1}.`);
  void qualiLoop();
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

async function qualiLoop() {
  if (!quali || !qualiIdx || !practiceNet || quali.running) return;
  quali.running = true;
  const timeout = qualiTimeout();
  while (quali && !quali.aborted && quali.idx < quali.roster.length) {
    const d = quali.roster[quali.idx];
    renderQualiBoard(quali.idx);
    const res = await animateQualiLap(d, timeout);
    if (!quali || quali.aborted) break;
    quali.entries.push({ teamId: d.teamId, teamName: d.teamName, name: d.name, time: res.done === 'lap' ? res.time : null, progress: res.progress });
    quali.idx++;
    await saveRaceSession({ stage: 'quali', cfg: raceCfg!, seed: quali.seed, quali: quali.entries, nextIdx: quali.idx });
    renderQualiBoard(-1);
  }
  if (quali && !quali.aborted && quali.idx >= quali.roster.length) {
    (gid('btn-start-race') as HTMLButtonElement).disabled = false;
    say('Qualifying complete — start the race.');
  }
  if (quali) quali.running = false;
}

function animateQualiLap(d: Driver, timeout: number): Promise<{ time: number; progress: number; done: string }> {
  return new Promise((resolve) => {
    const idx = qualiIdx!, net = practiceNet!;
    const team = teams.find((t) => t.id === d.teamId)!;
    const phys = physicsFor(team);
    setGenome(net, new Float32Array(d.genome));
    const { car } = spawn(idx);
    let hint = -1, prevFrac: number | null = null, prog = 0, time = 0, frames = 0;
    const color = team.primary;
    const step = () => {
      if (!quali || quali.aborted) return resolve({ time, progress: prog, done: 'abort' });
      try {
      const loc = locate(idx, car.x, car.y, hint);
      hint = loc.bi;
      if (prevFrac == null) prevFrac = loc.frac;
      let df = loc.frac - prevFrac;
      if (df > 0.5) df -= 1;
      else if (df < -0.5) df += 1;
      prog += df;
      prevFrac = loc.frac;
      if (loc.dist > loc.hw) return resolve({ time, progress: prog, done: 'crash' });
      if (prog >= 1) return resolve({ time, progress: prog, done: 'lap' });
      if (time >= timeout || ++frames > 60 * 120) return resolve({ time, progress: prog, done: 'timeout' });
      stepCar(car, actObs(net, observe(idx, car, loc)), phys);
      time += DT;
      drawQualiScene([{ x: car.x, y: car.y, heading: car.heading, color, secondary: team.secondary }]);
      renderQualiBoardLive(time, prog);
      requestAnimationFrame(step);
      } catch { resolve({ time, progress: prog, done: 'timeout' }); }
    };
    requestAnimationFrame(step);
  });
}

function drawQualiScene(cars: (SceneCar & { secondary: string })[]) {
  const cv = gid('quali-canvas') as HTMLCanvasElement;
  const idx = qualiIdx!;
  const ctx = cv.getContext('2d')!;
  drawRaceScene(ctx, cv.width, cv.height, idx.track.centerline, idx.left, idx.right, ribbon(idx.track));
  drawSessionCars(ctx, cars.map((c) => ({ x: c.x, y: c.y, heading: c.heading, primary: c.color, secondary: c.secondary, dim: c.dim })));
}

function fmtTime(t: number) {
  return t >= 60 ? `${Math.floor(t / 60)}:${(t % 60).toFixed(2).padStart(5, '0')}` : `${t.toFixed(2)}s`;
}

function medal(i: number) { return i === 0 ? ' p1' : i === 1 ? ' p2' : i === 2 ? ' p3' : ''; }
function boardRow(ul: HTMLElement, o: { pos: string; mi: number; color: string; team: string; name: string; meta: string; metaBad?: boolean; live?: boolean; dim?: boolean; liveId?: string }) {
  const li = document.createElement('li');
  if (o.live) li.className = 'live';
  else if (o.dim) li.className = 'dim';
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

function renderQualiBoard(liveIdx: number) {
  const ul = gid('quali-board');
  ul.innerHTML = '';
  const ranked = sortQuali(quali?.entries ?? []);
  const p1 = ranked.find((e) => e.time != null)?.time;
  ranked.forEach((e, i) => {
    const team = teams.find((t) => t.id === e.teamId);
    const done = e.time != null;
    boardRow(ul, {
      pos: `P${i + 1}`, mi: i, color: team?.primary ?? '#888', team: e.teamName, name: e.name,
      meta: done ? (p1 != null && e.time !== p1 ? `+${(e.time! - p1).toFixed(2)}` : fmtTime(e.time!)) : `DNF · ${(Math.max(0, e.progress) * 100).toFixed(0)}%`,
      metaBad: !done,
    });
  });
  if (quali && liveIdx >= 0 && liveIdx < quali.roster.length) {
    const d = quali.roster[liveIdx];
    const team = teams.find((t) => t.id === d.teamId);
    boardRow(ul, { pos: '…', mi: -1, color: team?.primary ?? '#888', team: d.teamName, name: d.name, meta: '0.00s', live: true, liveId: 'quali-live-time' });
  }
  const qdone = quali?.entries.length ?? 0, qtotal = quali?.roster.length ?? 0;
  gid('btn-start-race').textContent = qtotal && qdone >= qtotal ? 'Start race' : `Start race (${qdone}/${qtotal})`;
}

function renderQualiBoardLive(time: number, prog: number) {
  const el = gid('quali-live-time');
  if (el) el.textContent = `${fmtTime(time)} · ${(Math.max(0, prog) * 100).toFixed(0)}%`;
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

gid('btn-start-quali').onclick = () => { void enterQuali(); };
gid('btn-quali-back').onclick = () => { if (quali) quali.aborted = true; setRacePane('practice'); };
// ---- race session (Story 4, subtask 8) ----
interface RaceCar {
  teamId: string; teamName: string; name: string; car: CarState; genome: Float32Array; phys: PhysicsParams;
  color: string; hint: number; prevFrac: number | null; prog: number;
  time: number;
  done: boolean; dnf: boolean; finishTime: number | null;
}
let raceCars: RaceCar[] = [];
let raceIdx: TrackIndex | null = null;
let raceRunning = false;
let raceAbort = false;
let raceLaps = 3;

// F1-stagger grid behind the start line: 2 cols, alternate sides, row gap.
export function gridSlots(idx: TrackIndex, n: number): { x: number; y: number; heading: number }[] {
  const t = idx.track, m = idx.n;
  const si = t.startS == null ? 0 : t.startS % m;
  const spacing = idx.total / m;
  const step = Math.max(1, Math.round(30 / spacing)); // ~30px rows back along the arc
  const out: { x: number; y: number; heading: number }[] = [];
  for (let i = 0; i < n; i++) {
    const row = Math.floor(i / 2), side = i % 2 === 0 ? -1 : 1;
    const gi = (si - (row + 1) * step) % m;
    const gj = (gi + m) % m;
    const a = t.centerline[gj], b = t.centerline[(gj + 3) % m], c = t.centerline[(gj - 3 + m) % m];
    const L = Math.hypot(b[0] - c[0], b[1] - c[1]) || 1;
    const tx = (b[0] - c[0]) / L, ty = (b[1] - c[1]) / L;
    const hw = widthAt(t, gj / m) / 2;
    const lat = Math.max(0, Math.min(hw * 0.5 + 5, hw - 12));
    const p = pointAt(t.centerline, t.closed, gj / m);
    let x = p[0] + -ty * side * lat, y = p[1] + tx * side * lat;
    if (distToTrack(t.centerline, t.closed, [x, y]) >= hw - 4) { x = p[0]; y = p[1]; } // bend: fall back to center
    out.push({ x, y, heading: Math.atan2(ty, tx) });
  }
  return out;
}

async function enterRace() {
  if (!raceCfg || !quali || quali.idx < quali.roster.length) return;
  const tracks = await listTracks();
  const t = tracks.find((x) => x.id === raceCfg!.trackId);
  if (!t) { say('Saved track is gone — pick another.'); return; }
  if (!practiceNet) practiceNet = buildNet();
  raceIdx = makeTrackIndex(t);
  raceLaps = raceCfg.laps;
  const order = sortQuali(quali.entries);
  const slots = gridSlots(raceIdx, order.length);
  try {
  raceCars = order.map((e, i) => {
    const team = teams.find((x) => x.id === e.teamId)!;
    const qd = quali!.roster.find((d) => d.name === e.name && d.teamId === e.teamId)!;
    return {
      teamId: e.teamId, teamName: e.teamName, name: e.name, phys: physicsFor(team),
      car: { x: slots[i].x, y: slots[i].y, heading: slots[i].heading, vx: 0, vy: 0 },
      genome: new Float32Array(qd.genome), color: team.primary,
      hint: -1, prevFrac: null, prog: 0, time: 0,
      done: false, dnf: false, finishTime: null,
    };
  });
  } catch { say('Could not build the starting grid.'); return; }
  raceRunning = true;
  raceAbort = false;
  setRacePane('race');
  renderRaceBoard();
  requestAnimationFrame(raceStep);
}

function raceStep() {
  if (!raceRunning || raceAbort || !raceIdx || !practiceNet) return;
  let allDone = true;
  for (const r of raceCars) {
    if (r.done) continue;
    allDone = false;
    try {
    setGenome(practiceNet, r.genome);
    const loc = locate(raceIdx, r.car.x, r.car.y, r.hint);
    r.hint = loc.bi;
    if (r.prevFrac == null) r.prevFrac = loc.frac;
    let df = loc.frac - r.prevFrac;
    if (df > 0.5) df -= 1;
    else if (df < -0.5) df += 1;
    r.prog += df;
    r.prevFrac = loc.frac;
    if (loc.dist > loc.hw) { r.done = true; r.dnf = true; continue; }
    if (r.prog >= raceLaps) { r.done = true; r.finishTime = r.time; continue; }
    if (r.time > 60 * 180) { r.done = true; r.dnf = true; continue; }
    stepCar(r.car, actObs(practiceNet, observe(raceIdx, r.car, loc)), r.phys);
    r.time += DT;
    } catch { r.done = true; r.dnf = true; }
  }
  try { drawRaceSceneOnCanvas(); renderRaceBoard(); } catch { /* a bad frame must never kill the race */ }
  if (allDone) { void finishRace(); return; }
  requestAnimationFrame(raceStep);
}

function drawRaceSceneOnCanvas() {
  const cv = gid('race-canvas') as HTMLCanvasElement;
  const idx = raceIdx!;
  const ctx = cv.getContext('2d')!;
  drawRaceScene(ctx, cv.width, cv.height, idx.track.centerline, idx.left, idx.right, ribbon(idx.track));
  drawSessionCars(ctx, raceCars.map((r) => {
    const team = teams.find((t) => t.id === r.teamId);
    return { x: r.car.x, y: r.car.y, heading: r.car.heading, primary: r.color, secondary: team?.secondary ?? '#ffffff', dim: r.done };
  }));
}

function raceOrder(): RaceCar[] {
  return raceCars.slice().sort((a, b) => b.prog - a.prog);
}

function renderRaceBoard() {
  const ul = gid('race-board');
  ul.innerHTML = '';
  raceOrder().forEach((r, i) => {
    const team = teams.find((t) => t.id === r.teamId);
    const lap = Math.min(raceLaps, Math.floor(Math.max(0, r.prog)) + 1);
    const finished = r.finishTime != null;
    const bad = r.dnf && !finished;
    boardRow(ul, {
      pos: `P${i + 1}`, mi: i, color: team?.primary ?? '#888', team: r.teamName, name: r.name,
      meta: finished ? fmtTime(r.finishTime!) : bad ? `DNF · L${lap}` : `L${lap} · ${(Math.max(0, r.prog) * 100 / raceLaps).toFixed(0)}%`,
      metaBad: bad, dim: r.done,
    });
  });
  const lead = raceOrder().find((r) => !r.done) ?? raceOrder()[0];
  const cur = lead ? Math.min(raceLaps, Math.floor(Math.max(0, lead.prog)) + 1) : raceLaps;
  gid('race-lap').textContent = `Lap ${cur}/${raceLaps}`;
}

async function finishRace() {
  raceRunning = false;
  const order = raceOrder();
  const results = order.map((r) => ({ teamId: r.teamId, teamName: teams.find((t) => t.id === r.teamId)?.name ?? r.teamId, name: r.name, time: r.finishTime, progress: r.prog }));
  if (quali && raceCfg) await saveRaceSession({ stage: 'race', cfg: raceCfg, seed: quali.seed, quali: quali.entries, nextIdx: quali.idx, results });
  renderRaceBoard();
  const w = order[0];
  say(w && !w.dnf ? `${w.name} wins in ${fmtTime(w.finishTime!)}.` : 'Race over — no finishers.');
}

gid('btn-start-race').onclick = () => { void enterRace(); };
gid('btn-race-back').onclick = () => { raceAbort = true; raceRunning = false; setRacePane('quali'); };
gid('btn-preview-now').onclick = () => void requestManualPreview();
gid('btn-practice-back').onclick = () => { stopPracticeAll(); setRacePane('setup'); void renderRaces(); };
(gid('in-ga-preview') as HTMLInputElement).onchange = async () => {
  if (!raceCfg) return;
  const v = Math.max(0, Math.round(Number((gid('in-ga-preview') as HTMLInputElement).value) || 0));
  (gid('in-ga-preview') as HTMLInputElement).value = String(v);
  raceCfg.previewEvery = v;
  await saveRaceCfg(raceCfg);
};
gid('btn-race-begin').onclick = async () => {
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
  raceCfg = { ...input, previewEvery: raceCfg?.previewEvery ?? 0 };
  await saveRaceCfg(raceCfg);
  if (await enterPractice()) setRacePane('practice');
};
gid('btn-race-single').onclick = () => { setRacePane('setup'); void renderRaces(); };
gid('btn-race-champ').onclick = () => setRacePane('champ');
gid('btn-race-setup-back').onclick = () => setRacePane('landing');
gid('btn-race-champ-back').onclick = () => setRacePane('landing');

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
  gid('teams-hint').textContent = teams.length ? '' : 'Create at least 1 team to unlock training.';
  if (!ed) return;
  (gid('in-team-name') as HTMLInputElement).value = ed.name;
  (gid('in-team-primary') as HTMLInputElement).value = ed.primary;
  (gid('in-team-secondary') as HTMLInputElement).value = ed.secondary;
  for (const k of SPECS) (gid(`in-spec-${k}`) as HTMLInputElement).value = String(ed[k]);
  gid('team-form-title').textContent = 'Edit team';
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
  const t = (await listTracks()).find((t) => t.id === els.sel.value);
  if (!t || t.centerline.length < 2) return;
  track = { ...t, gates: t.gates ?? [], gateWidths: t.gateWidths ?? (t.gates ?? []).map(() => t.width) };
  track.closed = t.closed ?? dist(track.centerline[0], track.centerline[track.centerline.length - 1]) < 60;
  track.startS = !track.startS ? null : Math.min(track.startS, track.centerline.length - 1); // legacy auto-start (0) counts as unset
  pieces = [t.centerline.map((p) => [...p] as Pt)]; active = 0; selectedGate = null;
  touchPieces();
  builtFor = { v: piecesVersion, active }; // verbatim: saved centerline needs no reprocessing
  els.width.value = String(t.width); els.widthVal.textContent = String(t.width);
  const lb = t.bg;
  if (lb?.data && [lb.x, lb.y, lb.s].every(isFinite) && lb.s > 0) {
    loadImageEl(lb.data).then((img) => setBg(img, lb.data, lb.x, lb.y, lb.s)).catch(() => { /* bad image: track still loads */ });
  } else if (bg) clearBg(); // record has no underlay: don't show the previous track's
  pushHistory(); pinOpenWidth(); refreshWidthCaps(); persist(); render(); say(`Loaded "${t.name}"`);
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
    const t = JSON.parse(await f.text()) as Track;
    if (!t.centerline?.length) throw new Error('bad file');
    track = { ...t, id: uid(), gates: t.gates ?? [], gateWidths: t.gateWidths ?? (t.gates ?? []).map(() => t.width) };
    track.closed = t.closed ?? dist(track.centerline[0], track.centerline[track.centerline.length - 1]) < 60;
    track.startS = !track.startS ? null : Math.min(track.startS, track.centerline.length - 1); // legacy auto-start (0) counts as unset
    pieces = [track.centerline.map((p) => [...p] as Pt)]; active = 0; selectedGate = null;
    touchPieces();
    builtFor = { v: piecesVersion, active }; // verbatim: no reprocessing
    const fb = t.bg;
    if (fb?.data && [fb.x, fb.y, fb.s].every(isFinite) && fb.s > 0) {
      loadImageEl(fb.data).then((img) => setBg(img, fb.data, fb.x, fb.y, fb.s)).catch(() => { /* bad image: track still loads */ });
    }
    pushHistory(); pinOpenWidth(); refreshWidthCaps(); refreshList(); say(`Imported (${track.centerline.length} pts)`);
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
    const loop = await traceImageFile(f, canvas.width, canvas.height);
    if (loop.length < 8) { say('No track found — need one-color circuit on plain background.'); return; }
    // auto-clear: drop the doodle, its gates/start and tool state, and bump the
    // pieces version — without touchPieces the rebuild below reuses the old
    // centerline and the import never appears.
    pieces = [loop]; active = 0; selectedGate = null;
    arcPts = []; hover = null; lineStart = null; drawing = null;
    track = null;
    touchPieces();
    els.width.value = '60'; els.widthVal.textContent = '60'; // fresh closed track: standard default (caps still apply)
    view = { s: 1, ox: 0, oy: 0 }; saveView(view); // traced loop is fit to canvas px: identity view shows it
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
    // fit track bbox into canvas with margin
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
// Canvas fills its flex container: backing store tracks CSS size, stored
// geometry scales proportionally (incl. undo history, so undo stays valid).
// Space the stored pieces live in. Fresh sessions start at the canvas attrs;
let spaceW = 0, spaceH = 0;
async function fitCanvas() {
  const r = canvas.getBoundingClientRect();
  const w = Math.max(50, Math.round(r.width)), h = Math.max(50, Math.round(r.height));
  if (!spaceW) {
    // stored pieces remember their own space; legacy drafts assumed 960x600
    const d = await loadPieces();
    spaceW = d?.w ?? 960; spaceH = d?.h ?? 600;
  }
  if (w !== canvas.width || h !== canvas.height) {
    const sx = w / spaceW, sy = h / spaceH; // 1.0 when reopening at same window: no-op
    spaceW = w; spaceH = h;
    view.ox *= sx; view.oy *= sy; // pan follows the resize
    if (sx !== 1 || sy !== 1) {
      const sc = (ps: Pt[][]) => { for (const pc of ps) for (const p of pc) { p[0] *= sx; p[1] *= sy; } };
      sc(pieces);
      for (const hs of history) sc(hs.pieces);
      if (track) for (const p of track.centerline) { p[0] *= sx; p[1] *= sy; } // keep prev-center in post-scale space for world-anchoring
      touchPieces(); // scaled geometry must rebuild once
      drawing = null; lineStart = null; hover = null;
    }
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
  if (v) view = v;
  await bootRestore();
  await refreshList();
  teams = await loadTeams(); renderTeams();
  raceCfg = sanitizeSetup(await loadRaceCfg(), await listTracks(), teams);
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
