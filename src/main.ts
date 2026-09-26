import { buildMask, extractCore, largestComponent, prune, simplifySkeleton, thin, traceLoop } from './skeleton';
import { blendSeam, checkpoints, closeLoop, dist, edges, gateAt, nearestIndex, pointAt, projectFraction, resample, ribbon, ribbonSelfOverlap, sampleArc, sampleLine, seamPatch, segOverlapsExisting, selfStrokeOverlaps, smooth, smoothOpen, uid, validateGeometry, vertexWidths } from './track';
import type { Pt, Track } from './track';
import { deleteTrack, listTracks, loadBg, loadDraft, loadPieces, loadView, ready as storeReady, saveBg, saveDraft, savePieces, saveTrack, saveView } from './storage';

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
interface Snap { pieces: Pt[][]; gates: number[]; widths: number[]; general: number; start: number }
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
  if (draft) { track = { ...draft, gates: draft.gates ?? [], gateWidths: draft.gateWidths ?? (draft.gates ?? []).map(() => draft.width) }; say(`Draft restored (${draft.centerline.length} pts)`); }
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
    start: track?.startS ?? 0,
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
let incoming: { gates: number[]; widths: number[]; start: number } | null = null;
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
function rebuildTrack(keepStart = true): boolean {
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
  const startWorld = hadCenter ? pointAt(prevCenter!, prevClosed, (track!.startS % prevCenter!.length) / prevCenter!.length) : null;
  const gateWorld = hadCenter ? (track?.gates ?? []).map((fr) => pointAt(prevCenter!, prevClosed, fr)) : [];
  let gates: number[], widths: number[], startS: number;
  if (incoming) {
    ({ gates, widths } = incoming);
    startS = incoming.start;
    incoming = null;
  } else {
    gates = gateWorld.map((p) => projectFraction(built.center, built.closed, p));
    widths = (track?.gateWidths ?? []).slice(0, gates.length);
    while (widths.length < gates.length) widths.push(w);
    startS = startWorld ? Math.round(projectFraction(built.center, built.closed, startWorld) * built.center.length) % built.center.length : keepStart ? (track?.startS ?? 0) : 0;
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
    startS: Math.min(startS, built.center.length - 1),
    closed: built.closed,
    gates, // world-anchored fractions
    gateWidths: widths,
  };
  if (track.startS >= built.center.length) track.startS = 0;
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
  if (erasing) { erasing = false; if (eraseChanged) { pushHistory(); say('Erased.'); } return; }
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
      // start line: own gate at startS, independent of checkpoints
      const s0 = gateAt(track, track.startS % n / n);
      ctx.strokeStyle = '#fff'; ctx.lineWidth = 5;
      ctx.beginPath(); ctx.moveTo(s0.a[0], s0.a[1]); ctx.lineTo(s0.b[0], s0.b[1]); ctx.stroke();
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
  items.push([(track?.startS ?? -1) >= 0 && n >= 8, 'Start line placed']);
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
  const isTracks = v === 'tracks';
  (gid('view-tracks') as HTMLElement).hidden = !isTracks;
  (gid('view-placeholder') as HTMLElement).hidden = isTracks;
  if (!isTracks) gid('placeholder-title').textContent = v === 'teams' ? 'My Teams' : 'Races';
  (Object.entries({ 'nav-tracks': 'tracks', 'nav-teams': 'teams', 'nav-races': 'races' }) as [string, MainView][])
    .forEach(([id, vv]) => gid(id).classList.toggle('active', vv === v));
  say(isTracks ? '' : 'Page under construction — check back later.');
}
gid('nav-tracks').onclick = () => showView('tracks');
gid('nav-teams').onclick = () => showView('teams');
gid('nav-races').onclick = () => showView('races');
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
  track.startS = Math.min(track.startS ?? 0, track.centerline.length - 1);
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
    track.startS = Math.min(track.startS ?? 0, track.centerline.length - 1);
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
  rebuildTrack(false);
}
let fitT = 0;
new ResizeObserver(() => { window.clearTimeout(fitT); fitT = window.setTimeout(fitCanvas, 120); }).observe(canvas);
// restore slider state from draft before first rebuild (else width snaps to default)
async function boot() {
  await storeReady();
  const v = await loadView();
  if (v) view = v;
  await bootRestore();
  await refreshList();
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
