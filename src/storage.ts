import type { Track } from './track';
// ponytail: localStorage only for v1; tracks are small (<100KB). IndexedDB when NN weights land (story 3).
const K = 'rs.v1.tracks';
const DRAFT = 'rs.v1.draft';

const read = (k: string): Record<string, Track> => {
  try { return JSON.parse(localStorage.getItem(k) || '{}'); } catch { return {}; }
};
const writeAll = (k: string, v: Record<string, Track>) => localStorage.setItem(k, JSON.stringify(v));

export const listTracks = () => Object.values(read(K)).sort((a, b) => a.name.localeCompare(b.name));
export const saveTrack = (t: Track) => { const all = read(K); all[t.id] = t; writeAll(K, all); };
export const deleteTrack = (id: string) => { const all = read(K); delete all[id]; writeAll(K, all); };
export const saveDraft = (t: Track | null) =>
  t ? localStorage.setItem(DRAFT, JSON.stringify(t)) : localStorage.removeItem(DRAFT);
export const loadDraft = (): Track | null => {
  try { return JSON.parse(localStorage.getItem(DRAFT) || 'null'); } catch { return null; }
};
export interface DraftPieces { pieces: import('./track').Pt[][]; active: number; w?: number; h?: number } // w/h: canvas backing size the pieces live in
const P = 'rs.v1.pieces';
export const savePieces = (d: DraftPieces) => {
  try { localStorage.setItem(P, JSON.stringify(d)); } catch { /* quota: draft lost, saved tracks safe */ }
};
export const loadPieces = (): DraftPieces | null => {
  try {
    const d = JSON.parse(localStorage.getItem(P) || 'null');
    if (!d?.pieces?.length) return null;
    return d;
  } catch { return null; }
};
export interface View { s: number; ox: number; oy: number }
const V = 'rs.v1.view';
export const saveView = (v: View) => {
  try { localStorage.setItem(V, JSON.stringify(v)); } catch { /* ignore */ }
};
export const loadView = (): View | null => {
  try {
    const d = JSON.parse(localStorage.getItem(V) || 'null');
    return d && isFinite(d.s) && isFinite(d.ox) && isFinite(d.oy) ? d : null;
  } catch { return null; }
};
