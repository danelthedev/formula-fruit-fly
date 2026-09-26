import type { Pt } from './track';

// ---- Team model (Story 2: Team Configurer) ----
export interface Team {
  id: string;
  name: string;
  primary: string;   // hex #rrggbb (car body)
  secondary: string; // hex #rrggbb (wings/stripe)
  topSpeed: number;      // 1-10
  acceleration: number;  // 1-10
  brakeEfficiency: number; // 1-10
  turningAbility: number;  // 1-10
}

// Central physics map (Stories 3-4 use physicsFor, never raw specs).
export interface PhysicsParams {
  vMax: number;     // px/s top speed
  engine: number;   // px/s^2 engine force
  brake: number;    // px/s^2 brake force
  steerMax: number; // rad max steer angle
  grip: number;     // lateral grip 1/s
}
export const SPEC_MAP = {
  vMax: (t: number) => 100 + t * 20,
  engine: (a: number) => 1000 + a * 350,
  brake: (b: number) => 1500 + b * 500,
  steerMax: (t: number) => 0.15 + t * 0.035,
  grip: (t: number) => 2 + t * 0.8,
};
export function physicsFor(t: Team): PhysicsParams {
  return {
    vMax: SPEC_MAP.vMax(t.topSpeed),
    engine: SPEC_MAP.engine(t.acceleration),
    brake: SPEC_MAP.brake(t.brakeEfficiency),
    steerMax: SPEC_MAP.steerMax(t.turningAbility),
    grip: SPEC_MAP.grip(t.turningAbility),
  };
}

export const blankTeam = (id: string): Team => ({
  id, name: '', primary: '#e10600', secondary: '#ffffff',
  topSpeed: 5, acceleration: 5, brakeEfficiency: 5, turningAbility: 5,
});

const clampSpec = (v: number) => { const r = Math.round(v); return Number.isFinite(r) ? Math.min(10, Math.max(1, r)) : 5; };
const okColor = (c: string) => /^#[0-9a-fA-F]{6}$/.test(c);

// Coerce a foreign object into a valid Team (import path); null when unusable.
export function sanitizeTeam(o: unknown): Team | null {
  if (!o || typeof o !== 'object') return null;
  const r = o as Record<string, unknown>;
  if (typeof r.name !== 'string' || !r.name.trim()) return null;
  return {
    id: typeof r.id === 'string' && r.id ? r.id : Math.random().toString(36).slice(2, 10),
    name: r.name.trim().slice(0, 40),
    primary: typeof r.primary === 'string' && okColor(r.primary) ? r.primary : '#e10600',
    secondary: typeof r.secondary === 'string' && okColor(r.secondary) ? r.secondary : '#ffffff',
    topSpeed: clampSpec(Number(r.topSpeed)),
    acceleration: clampSpec(Number(r.acceleration)),
    brakeEfficiency: clampSpec(Number(r.brakeEfficiency)),
    turningAbility: clampSpec(Number(r.turningAbility)),
  };
}

// Names: non-empty + unique (case-insensitive) among the others.
export function teamErrors(name: string, selfId: string, others: Team[]): string[] {
  const errs: string[] = [];
  const n = name.trim();
  if (!n) errs.push('Name is required.');
  if (n && others.some((t) => t.id !== selfId && t.name.toLowerCase() === n.toLowerCase()))
    errs.push(`"${n}" is already taken.`);
  return errs;
}

// Mini livery preview: top-down single-seater on a canvas ctx.
export function drawCarPreview(ctx: CanvasRenderingContext2D, w: number, h: number, primary: string, secondary: string) {
  ctx.clearRect(0, 0, w, h);
  const cx = w / 2, L = h * 0.86, back = h * 0.93, front = back - L;
  const body = (pts: Pt[], fill: string) => {
    ctx.fillStyle = fill;
    ctx.beginPath();
    pts.forEach(([x, y], i) => (i ? ctx.lineTo(cx + x, y) : ctx.moveTo(cx + x, y)));
    ctx.closePath(); ctx.fill();
  };
  ctx.fillStyle = '#111'; // wheels
  const ww = w * 0.09, wh = h * 0.16;
  for (const [wx, wy] of [[-w * 0.3, front + h * 0.1], [w * 0.3, front + h * 0.1], [-w * 0.32, back - h * 0.18], [w * 0.32, back - h * 0.18]] as Pt[]) {
    ctx.beginPath();
    ctx.roundRect(cx + wx - ww / 2, wy - wh / 2, ww, wh, 3);
    ctx.fill();
  }
  body([[-w * 0.42, front], [w * 0.42, front], [w * 0.34, front + h * 0.07], [-w * 0.34, front + h * 0.07]], secondary); // front wing
  body([[-w * 0.07, front], [w * 0.07, front], [w * 0.12, back - h * 0.1], [-w * 0.12, back - h * 0.1]], primary); // nose
  body([[-w * 0.2, back - h * 0.42], [w * 0.2, back - h * 0.42], [w * 0.24, back - h * 0.05], [-w * 0.24, back - h * 0.05]], primary); // sidepods
  body([[-w * 0.05, back - h * 0.34], [w * 0.05, back - h * 0.34], [w * 0.05, back - h * 0.12], [-w * 0.05, back - h * 0.12]], secondary); // stripe
  ctx.fillStyle = '#0a0a0a'; // cockpit
  ctx.beginPath();
  ctx.ellipse(cx, back - h * 0.44, w * 0.07, h * 0.09, 0, 0, Math.PI * 2);
  ctx.fill();
  body([[-w * 0.36, back - h * 0.06], [w * 0.36, back - h * 0.06], [w * 0.36, back], [-w * 0.36, back]], secondary); // rear wing
}
