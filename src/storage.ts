import type { Track } from './track';
// ponytail: IndexedDB (GBs, same origin, no server) with localStorage fallback
// when IDB can't open (private mode etc). Story 3 weights will share this DB.
export interface DraftPieces { pieces: import('./track').Pt[][]; active: number; w?: number; h?: number } // w/h: canvas backing size the pieces live in
export interface View { s: number; ox: number; oy: number }
export interface BgState { data: string; x: number; y: number; s: number }

const DB = 'racing-sim', STORE = 'kv', K = {
  tracks: 'rs.v1.tracks',
  draft: 'rs.v1.draft',
  pieces: 'rs.v1.pieces',
  view: 'rs.v1.view',
  bg: 'rs.v1.bg',
  migrated: 'rs.v1.migrated',
};

let db: IDBDatabase | null = null;
let useLs = false;

const req = <T>(r: IDBRequest<T>): Promise<T> => new Promise((res, rej) => {
  r.onsuccess = () => res(r.result);
  r.onerror = () => rej(r.error);
});

async function openDb(): Promise<IDBDatabase> {
  const r = indexedDB.open(DB, 1);
  r.onupgradeneeded = () => r.result.createObjectStore(STORE);
  return req(r);
}

// Open once + one-time copy of legacy localStorage keys (removed after).
export async function ready(): Promise<void> {
  if (db || useLs) return;
  try {
    db = await openDb();
    if (await rawGet(K.migrated)) return;
    for (const k of [K.tracks, K.draft, K.pieces, K.view, K.bg]) {
      let v: string | null = null;
      try { v = localStorage.getItem(k); } catch { /* ignore */ }
      if (v != null) await rawSet(k, v);
    }
    await rawSet(K.migrated, '1');
    for (const k of [K.tracks, K.draft, K.pieces, K.view, K.bg]) {
      try { localStorage.removeItem(k); } catch { /* ignore */ }
    }
  } catch {
    db = null; useLs = true;
  }
}

function rawGet(key: string): Promise<string | null> {
  if (!db) return Promise.resolve(null);
  try {
    return req<IDBValidKey | undefined>(db.transaction(STORE).objectStore(STORE).get(key))
      .then((v) => (typeof v === 'string' ? v : null));
  } catch {
    return Promise.resolve(null);
  }
}

function rawSet(key: string, val: string | null): Promise<void> {
  if (!db) return Promise.resolve();
  const tx = db.transaction(STORE, 'readwrite');
  const st = tx.objectStore(STORE);
  return (val == null ? req(st.delete(key)) : req(st.put(val, key))).then(() => undefined);
}

async function kvGet(key: string): Promise<string | null> {
  if (useLs) {
    try { return localStorage.getItem(key); } catch { return null; }
  }
  const v = await rawGet(key);
  return v;
}

async function kvSet(key: string, val: string | null): Promise<void> {
  if (useLs) {
    try {
      if (val == null) localStorage.removeItem(key);
      else localStorage.setItem(key, val);
    } catch { /* quota: best effort, same as before */ }
    return;
  }
  await rawSet(key, val);
}

const parse = <T>(s: string | null): T | null => {
  try { return JSON.parse(s || 'null'); } catch { return null; }
};

export const listTracks = async (): Promise<Track[]> => {
  const d = parse<Record<string, Track>>(await kvGet(K.tracks)) ?? {};
  return Object.values(d).sort((a, b) => a.name.localeCompare(b.name));
};
// throws on quota failure so Save can say so (everything else is best-effort)
export const saveTrack = async (t: Track): Promise<void> => {
  const d = parse<Record<string, Track>>(await kvGet(K.tracks)) ?? {};
  d[t.id] = t;
  await kvSet(K.tracks, JSON.stringify(d));
};
export const deleteTrack = async (id: string): Promise<void> => {
  const d = parse<Record<string, Track>>(await kvGet(K.tracks)) ?? {};
  delete d[id];
  await kvSet(K.tracks, JSON.stringify(d)).catch(() => {});
};

export const saveDraft = async (t: Track | null): Promise<void> => {
  await kvSet(K.draft, t ? JSON.stringify(t) : null).catch(() => {});
};
export const loadDraft = async (): Promise<Track | null> => parse(await kvGet(K.draft));

export const savePieces = async (d: DraftPieces): Promise<void> => {
  await kvSet(K.pieces, JSON.stringify(d)).catch(() => {});
};
export const loadPieces = async (): Promise<DraftPieces | null> => {
  const d = parse<DraftPieces>(await kvGet(K.pieces));
  return d?.pieces?.length ? d : null;
};

export const saveView = (v: View): void => {
  void kvSet(K.view, JSON.stringify(v)).catch(() => {});
};
export const loadView = async (): Promise<View | null> => {
  const d = parse<View>(await kvGet(K.view));
  return d && isFinite(d.s) && isFinite(d.ox) && isFinite(d.oy) ? d : null;
};

export const saveBg = (b: BgState | null): void => {
  void kvSet(K.bg, b ? JSON.stringify(b) : null).catch(() => {});
};
export const loadBg = async (): Promise<BgState | null> => {
  const d = parse<BgState>(await kvGet(K.bg));
  return d && typeof d.data === 'string' && [d.x, d.y, d.s].every(isFinite) && d.s > 0 ? d : null;
};
