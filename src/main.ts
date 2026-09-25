import { blendSeam, bridgeGap, checkpoints, closeLoop, dist, edges, gateAt, minSetDist, nearestIndex, resample, ribbon, sampleArc, sampleLine, seamPatch, smooth, smoothOpen, uid, validateGeometry } from './track';
import type { Pt, Track } from './track';
import { deleteTrack, listTracks, loadDraft, loadPieces, saveDraft, savePieces, saveTrack } from './storage';

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

const SNAP = 40;    // endpoint magnet radius — joining halves feels magnetic
const ERASE_R = 24;

let pieces: Pt[][] = [];
let active = 0;
interface Snap { pieces: Pt[][]; gates: number[]; widths: number[]; general: number }
let history: Snap[] = [];
let hIndex = -1;
let track: Track | null = null;
let tool: 'free' | 'line' | 'arc' | 'erase' | 'gate' = 'free';
let setStartMode = false;
let drawing: Pt[] | null = null;
let attachEnd: 'head' | 'tail' | 'new' = 'new';
let lineStart: Pt | null = null;
let arcPts: Pt[] = [];
let hover: Pt | null = null;
let erasing = false;
let eraseChanged = false;
let lastRejection: string | null = null; // shown in checklist so message + requirements agree

const clonePieces = (ps: Pt[][]): Pt[][] => ps.map((s) => s.map((p) => [...p] as Pt));
const allRaw = (): Pt[] => pieces.flat();

// ---- init ----
{
  const saved = loadPieces();
  const draft = loadDraft();
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
function persist() {
  savePieces({ pieces, active, w: canvas.width, h: canvas.height });
  saveDraft(track);
}
// snapshots cover pieces + checkpoints + widths: undo spans everything
function capture(): Snap {
  return {
    pieces: clonePieces(pieces),
    gates: track?.gates.slice() ?? [],
    widths: track?.gateWidths?.slice() ?? [],
    general: track?.width ?? 60,
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
let incoming: { gates: number[]; widths: number[] } | null = null;
function applySnap(s: Snap) {
  pieces = clonePieces(s.pieces); fixActive();
  incoming = { gates: s.gates.slice(), widths: s.widths.slice() };
  els.width.value = String(s.general); els.widthVal.textContent = String(s.general);
  selectedGate = null;
}

// ---- geometry pipeline ----
function buildFromPiece(piece: Pt[]): { center: Pt[]; closed: boolean } | null {
  if (piece.length < 2) return null;
  const rs = resample(piece, 8, false);
  const { loop, closed } = closeLoop(bridgeGap(rs)); // near-miss gaps auto-bridged
  if (!closed) return { center: smoothOpen(loop), closed };
  return { center: blendSeam(smooth(loop)), closed }; // seam corner cut + G1 bridge
}

// Rebuild track from active piece. Returns false + reverts when the new
// geometry crosses itself (stays on last-good state). Ribbon overlaps merge.
function rebuildTrack(keepStart = true): boolean {
  lastRejection = null; // fresh verdict each rebuild; set below on reject
  if (!pieces.length) { track = null; persist(); render(); return true; }
  fixActive();
  const built = buildFromPiece(pieces[active]);
  if (!built || built.center.length < 2) { track = null; persist(); render(); return true; }
  const w = Number(els.width.value);
  const prevGates = incoming?.gates ?? track?.gates ?? [];
  const prevWidths = incoming?.widths ?? track?.gateWidths ?? prevGates.map(() => track?.width ?? w);
  incoming = null;
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
    startS: keepStart ? (prev?.startS ?? 0) : 0,
    closed: built.closed,
    gates: prevGates, // manual gates are fractions: survive geometry rebuilds
    gateWidths: prevWidths,
  };
  if (track.startS >= built.center.length) track.startS = 0;
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
  let best: Ep | null = null, bd = SNAP;
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
function addStroke(seg: Pt[], attach: 'head' | 'tail' | 'new') {
  if (seg.length < 2) return;
  if (attach === 'new') { pieces.push(seg); active = pieces.length - 1; }
  else if (attach === 'tail') pieces[active].push(...seg.slice(1));
  else pieces[active].unshift(...seg.slice(1).reverse());
  tryMerge(attach === 'head');
  commit();
  if (track?.closed) say(`Loop closed (${track.centerline.length} pts) — set the start line.`);
}

// ---- eraser: drag to delete points within radius (splits pieces) ----
function eraseAt(p: Pt): boolean {
  let changed = false;
  const before = allRaw().length;
  const out: Pt[][] = [];
  for (const pc of pieces) {
    let run: Pt[] = [];
    for (const q of pc) {
      if (dist(q, p) > ERASE_R) run.push(q);
      else { if (run.length >= 2) out.push(run); run = []; }
    }
    if (run.length >= 2) out.push(run);
  }
  const after = out.flat().length;
  changed = after !== before;
  if (changed) { pieces = out; fixActive(); rebuildTrack(); }
  return changed;
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
  // scale client px -> canvas backing px (fixes offset when CSS scales the canvas)
  const r = canvas.getBoundingClientRect();
  return [(e.clientX - r.left) * (canvas.width / r.width), (e.clientY - r.top) * (canvas.height / r.height)];
};
canvas.addEventListener('pointerdown', (e) => {
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
  if (tool === 'gate') { toggleGate(p); return; }
  if (tool === 'arc') {
    const s = snapToEndpoint(p);
    if (arcPts.length === 0) {
      if (pieces.length && !s) { say('Start arcs from a glowing dot.'); return; }
      if (s) { active = s.piece; attachEnd = s.end; } else attachEnd = 'new';
    }
    arcPts.push(s ? [...s.p] as Pt : p);
    if (arcPts.length === 3) {
      const seg = sampleArc(arcPts[0], arcPts[1], arcPts[2]);
      arcPts = []; hover = null;
      addStroke(attachEnd === 'new' ? seg : [seg[0], ...seg.slice(1)], attachEnd);
    } else { say(`Arc: click point ${arcPts.length + 1} of 3 (Esc cancels)`); render(); }
    return;
  }
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
  hover = pos(e);
  if (tool === 'arc' && arcPts.length > 0) { render(); return; }
  if (tool === 'erase') { render(); if (erasing && eraseAt(hover)) eraseChanged = true; return; }
  if (!drawing) return;
  const p = hover;
  if (tool === 'line' && lineStart) {
    const s = snapToEndpoint(p); // magnetic line ends: precise joins
    drawing = [lineStart, s ? [...s.p] as Pt : p];
    renderLive();
    return;
  }
  if (dist(p, drawing[drawing.length - 1]) > 3) { drawing.push(p); renderLive(); }
});
canvas.addEventListener('pointerup', (e) => {
  if (erasing) { erasing = false; if (eraseChanged) { pushHistory(); say('Erased.'); } return; }
  if (tool === 'line' && lineStart) {
    const end = pos(e);
    const s = snapToEndpoint(end);
    const seg = sampleLine(lineStart, s ? [...s.p] as Pt : end);
    lineStart = null; drawing = null;
    addStroke(seg, attachEnd);
    return;
  }
  if (!drawing) return;
  const min = attachEnd === 'new' ? 8 : 2; // continuations can be tiny
  if (drawing.length >= min) addStroke(drawing, attachEnd);
  drawing = null;
});
window.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && setStartMode) { setArmed(false); say('Start placement cancelled'); return; }
  if (e.key === 'Escape' && arcPts.length) { arcPts = []; hover = null; render(); say('Arc cancelled'); }
});
canvas.addEventListener('contextmenu', (e) => {
  e.preventDefault();
  if (arcPts.length) { arcPts = []; hover = null; render(); say('Arc cancelled'); }
});

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
// live: does the in-progress stroke overlap existing track?
function liveOverlap(): boolean {
  if (!drawing || drawing.length < 4 || !pieces.length) return false;
  const w = Number(els.width.value);
  const committed = allRaw();
  const skip = Math.ceil(w / 3);
  const mid = committed.slice(skip, committed.length - skip);
  if (mid.length === 0) return false;
  return minSetDist(mid, drawing) < w;
}
function renderLive() {
  render();
  if (!drawing) return;
  const bad = liveOverlap();
  ctx.strokeStyle = bad ? '#f44' : '#ff0'; ctx.lineWidth = bad ? 3 : 2; ctx.setLineDash([6, 4]);
  pathOf(drawing, false); ctx.stroke(); ctx.setLineDash([]);
  if (bad) say('Too close to existing track — leave a full track-width gap.');
}
function render() {
  ctx.clearRect(0, 0, canvas.width, canvas.height);
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
      ctx.strokeStyle = '#ff0'; ctx.lineWidth = 2; ctx.setLineDash([6, 4]);
      pathOf(sampleArc(arcPts[0], arcPts[1], hover), false); ctx.stroke(); ctx.setLineDash([]);
    }
  }
  // eraser cursor
  if (tool === 'erase' && hover) {
    ctx.strokeStyle = '#f44'; ctx.lineWidth = 1;
    ctx.beginPath(); ctx.arc(hover[0], hover[1], ERASE_R, 0, Math.PI * 2); ctx.stroke();
  }
  syncGateEditor(); validate();
}

function validate() {
  const items: [boolean, string][] = [];
  const n = track?.centerline.length ?? 0;
  items.push([(track?.closed ?? false) && n >= 32, `Closed loop (${n} pts)`]);
  items.push([(track?.width ?? 0) >= 20, `Width ${track?.width ?? '—'}px`]);
  if (lastRejection) items.push([false, lastRejection]);
  items.push([(track?.startS ?? -1) >= 0 && n >= 8, 'Start/finish placed']);
  const ng = track?.gates.length ?? 0;
  items.push([ng >= 3, `${ng} checkpoints placed (need 3+, Checkpoint tool)`]);
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
els.clear.onclick = () => { pieces = []; active = 0; arcPts = []; hover = null; selectedGate = null; commit(); say('Cleared'); };
els.width.oninput = () => {
  els.widthVal.textContent = els.width.value;
  // untouched gates (still at the old general width) follow the slider; customized stay
  if (track) {
    const oldW = track.width, newW = Number(els.width.value);
    track.gateWidths ??= track.gates.map(() => oldW);
    track.gates.forEach((_, i) => { if (Math.abs((track!.gateWidths?.[i] ?? oldW) - oldW) < 0.5) track!.gateWidths![i] = newW; });
  }
  rebuildTrack();
};
els.width.onchange = () => pushHistory(); // one undo step per drag, not per tick
// Start-pick mode: armed → must pick a point (or Esc/click button to cancel).
// Everything else in the panel locks while armed.
function setArmed(on: boolean) {
  if (on && (!track || !track.closed)) { say('Draw a closed loop first'); return; }
  setStartMode = on;
  els.start.textContent = on ? 'Set start: ON — click the track' : 'Set start: off';
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
function toggleGate(p: Pt) {
  if (!track || !track.closed || track.centerline.length < 8) { say('Close the loop first, then place checkpoints.'); return; }
  const dseg = (g: { a: Pt; b: Pt }): number => {
    const vx = g.b[0] - g.a[0], vy = g.b[1] - g.a[1], L2 = vx * vx + vy * vy || 1;
    const tt = Math.max(0, Math.min(1, ((p[0] - g.a[0]) * vx + (p[1] - g.a[1]) * vy) / L2));
    return Math.hypot(p[0] - (g.a[0] + vx * tt), p[1] - (g.a[1] + vy * tt));
  };
  let bi = -1, bd = 14;
  checkpoints(track).forEach((g, i) => { const d = dseg(g); if (d < bd) { bd = d; bi = i; } });
  track.gateWidths ??= track.gates.map(() => track!.width);
  if (bi >= 0) {
    selectedGate = selectedGate === bi ? null : bi;
    say(selectedGate === null ? 'Checkpoint deselected' : `Checkpoint ${bi + 1} selected — set its width below`);
  } else {
    const fr = nearestIndex(track.centerline, p) / track.centerline.length;
    track.gates.push(fr);
    track.gateWidths.push(track.width);
    const order = track.gates.map((g, i) => i).sort((a, b) => track!.gates[a] - track!.gates[b]);
    track.gates = order.map((i) => track!.gates[i]);
    track.gateWidths = order.map((i) => track!.gateWidths![i]);
    selectedGate = track.gates.indexOf(fr);
    say(`Checkpoint ${track.gates.length} placed at width ${track.width}`);
  }
  pushHistory(); syncGateEditor(); persist(); render();
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
  tool = t; arcPts = []; hover = null; lineStart = null; drawing = null; erasing = false;
  for (const [id, tt] of [['btn-tool-free', 'free'], ['btn-tool-line', 'line'], ['btn-tool-arc', 'arc'], ['btn-tool-erase', 'erase'], ['btn-tool-gate', 'gate']] as const)
    document.getElementById(id)?.classList.toggle('active', tt === t);
  canvas.style.cursor = t === 'erase' ? 'cell' : 'crosshair';
  say(t === 'free' ? 'Free: drag from a glowing dot to extend, or start fresh'
    : t === 'line' ? 'Line: drag; both ends snap to dots'
    : t === 'arc' ? 'Arc: click 3 points (start, via, end)'
    : t === 'gate' ? 'Checkpoints: click road to add, click gate to select + size'
    : 'Erase: drag over track to delete sections');
  syncGateEditor(); render();
};
gid('btn-tool-free').onclick = () => setTool('free');
gid('btn-tool-line').onclick = () => setTool('line');
gid('btn-tool-arc').onclick = () => setTool('arc');
gid('btn-tool-erase').onclick = () => setTool('erase');
gid('btn-tool-gate').onclick = () => setTool('gate');
(gid('in-gate-width') as HTMLInputElement).oninput = (e) => {
  const v = Number((e.target as HTMLInputElement).value);
  gid('gate-width-val').textContent = String(v);
  if (track && selectedGate !== null && track.gateWidths) {
    track.gateWidths[selectedGate] = v;
    persist(); render();
  }
};
(gid('in-gate-width') as HTMLInputElement).onchange = () => pushHistory();
gid('btn-gate-remove').onclick = () => {
  if (!track || selectedGate === null) return;
  track.gates.splice(selectedGate, 1);
  track.gateWidths?.splice(selectedGate, 1);
  selectedGate = null;
  say(`Checkpoint removed (${track.gates.length} left)`);
  pushHistory(); persist(); render();
};
els.save.onclick = () => {
  if (!track || track.centerline.length < 8) { say('Draw a valid loop first'); return; }
  track.name = els.name.value.trim() || `Track ${new Date().toLocaleString()}`;
  saveTrack(track); refreshList(); say(`Saved "${track.name}"`);
};
els.load.onclick = () => {
  const t = listTracks().find((t) => t.id === els.sel.value);
  if (!t) return;
  track = { ...t, gates: t.gates ?? [], gateWidths: t.gateWidths ?? (t.gates ?? []).map(() => t.width) };
  pieces = [t.centerline.map((p) => [...p] as Pt)]; active = 0; selectedGate = null;
  els.width.value = String(t.width); els.widthVal.textContent = String(t.width);
  commit(); say(`Loaded "${t.name}"`);
};
els.del.onclick = () => { if (els.sel.value) { deleteTrack(els.sel.value); refreshList(); say('Deleted'); } };
els.exp.onclick = () => {
  if (!track) { say('Nothing to export'); return; }
  const blob = new Blob([JSON.stringify(track, null, 2)], { type: 'application/json' });
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
    pieces = [track.centerline.map((p) => [...p] as Pt)]; active = 0; selectedGate = null;
    commit(); refreshList(); say(`Imported (${track.centerline.length} pts)`);
  } catch { say('Import failed: invalid track JSON'); }
  els.file.value = '';
};
function refreshList() {
  const ts = listTracks();
  els.sel.innerHTML = ts.map((t) => `<option value="${t.id}">${t.name} (${t.centerline.length}pts)</option>`).join('');
}
refreshList();
// Canvas fills its flex container: backing store tracks CSS size, stored
// geometry scales proportionally (incl. undo history, so undo stays valid).
// Space the stored pieces live in. Fresh sessions start at the canvas attrs;
let spaceW = 0, spaceH = 0;
function fitCanvas() {
  const r = canvas.getBoundingClientRect();
  const w = Math.max(50, Math.round(r.width)), h = Math.max(50, Math.round(r.height));
  if (!spaceW) {
    // stored pieces remember their own space; legacy drafts assumed 960x600
    const d = loadPieces();
    spaceW = d?.w ?? 960; spaceH = d?.h ?? 600;
  }
  if (w !== canvas.width || h !== canvas.height) {
    const sx = w / spaceW, sy = h / spaceH; // 1.0 when reopening at same window: no-op
    spaceW = w; spaceH = h;
    if (sx !== 1 || sy !== 1) {
      const sc = (ps: Pt[][]) => { for (const pc of ps) for (const p of pc) { p[0] *= sx; p[1] *= sy; } };
      sc(pieces);
      for (const hs of history) sc(hs.pieces);
      drawing = null; lineStart = null; hover = null;
    }
    canvas.width = w; canvas.height = h;
  }
  rebuildTrack(false);
}
let fitT = 0;
new ResizeObserver(() => { window.clearTimeout(fitT); fitT = window.setTimeout(fitCanvas, 120); }).observe(canvas);
// restore slider state from draft before first rebuild (else width snaps to default)
{
  const d = loadDraft();
  if (d) {
    els.width.value = String(d.width); els.widthVal.textContent = String(d.width);
  }
}
fitCanvas();
