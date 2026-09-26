import type { Pt } from './track.ts';

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

// Mini livery preview: top-down single-seater, nose up, real F1 proportions
// (length:width ≈ 2.8:1). Primary = body, secondary = wings/stripe/halo.
export function drawCarPreview(ctx: CanvasRenderingContext2D, w: number, h: number, primary: string, secondary: string) {
  ctx.clearRect(0, 0, w, h);
  const cx = w / 2;
  const L = h * 0.9, y0 = (h - L) / 2; // front tip y
  const Wt = L / 2.8; // overall width incl. wheels
  const Y = (f: number) => y0 + f * L; // fraction along car
  const X = (f: number) => f * Wt; // fraction of width (half-widths)
  const shade = (hex: string, f: number) => {
    const n = parseInt(hex.slice(1), 16);
    return `rgb(${Math.round(((n >> 16) & 255) * f)},${Math.round(((n >> 8) & 255) * f)},${Math.round((n & 255) * f)})`;
  };
  const poly = (pts: Pt[], fill: string, edge = true) => {
    ctx.fillStyle = fill;
    ctx.beginPath();
    pts.forEach(([x, y], i) => (i ? ctx.lineTo(cx + x, y) : ctx.moveTo(cx + x, y)));
    ctx.closePath(); ctx.fill();
    if (edge) { ctx.strokeStyle = 'rgba(0,0,0,0.35)'; ctx.lineWidth = 2; ctx.stroke(); }
  };
  const wheel = (fx: number, fy: number, ww: number, wh: number) => {
    ctx.fillStyle = '#141414';
    ctx.beginPath();
    ctx.roundRect(cx + X(fx) - ww / 2, Y(fy) - wh / 2, ww, wh, ww * 0.25);
    ctx.fill();
  };
  poly([[-X(0.37), Y(0.33)], [X(0.37), Y(0.33)], [X(0.37), Y(0.8)], [-X(0.37), Y(0.8)]], shade(primary, 0.35), false); // floor in dark body color
  poly([[-X(0.075), Y(0.0)], [X(0.075), Y(0.0)], [X(0.12), Y(0.36)], [-X(0.12), Y(0.36)]], primary); // nose (tip under wing, base under sidepods)
  poly([[-X(0.3), Y(0.34)], [X(0.3), Y(0.34)], [X(0.34), Y(0.62)], [-X(0.34), Y(0.62)]], primary); // sidepods
  poly([[-X(0.1), Y(0.6)], [X(0.1), Y(0.6)], [X(0.15), Y(0.9)], [-X(0.15), Y(0.9)]], primary); // engine cover bridges to rear wing
  ctx.strokeStyle = '#0d0d0d'; ctx.lineWidth = 3; // front suspension arms
  ctx.beginPath();
  ctx.moveTo(cx - X(0.08), Y(0.3)); ctx.lineTo(cx - X(0.33), Y(0.3));
  ctx.moveTo(cx + X(0.08), Y(0.3)); ctx.lineTo(cx + X(0.33), Y(0.3));
  ctx.stroke();
  wheel(-0.4, 0.3, X(0.2), L * 0.13); wheel(0.4, 0.3, X(0.2), L * 0.13); // front wheels
  wheel(-0.39, 0.72, X(0.22), L * 0.15); wheel(0.39, 0.72, X(0.22), L * 0.15); // rear wheels
  poly([[-X(0.5), Y(0.0)], [X(0.5), Y(0.0)], [X(0.44), Y(0.035)], [-X(0.44), Y(0.035)]], secondary, false); // front wing (no edge: its stroke read as a gap over the nose)
  poly([[-X(0.5), Y(0.0)], [-X(0.44), Y(0.0)], [-X(0.44), Y(0.06)], [-X(0.5), Y(0.06)]], secondary); // endplates
  poly([[X(0.5), Y(0.0)], [X(0.44), Y(0.0)], [X(0.44), Y(0.06)], [X(0.5), Y(0.06)]], secondary);
  poly([[-X(0.035), Y(0.52)], [X(0.035), Y(0.52)], [X(0.035), Y(0.88)], [-X(0.035), Y(0.88)]], secondary, false); // engine stripe
  ctx.fillStyle = '#0a0a0a'; // cockpit
  ctx.beginPath();
  ctx.ellipse(cx, Y(0.47), X(0.09), L * 0.045, 0, 0, Math.PI * 2);
  ctx.fill();
  ctx.strokeStyle = secondary; // halo
  ctx.lineWidth = Math.max(2, Wt * 0.03);
  ctx.beginPath();
  ctx.ellipse(cx, Y(0.46), X(0.14), L * 0.07, 0, Math.PI * 1.05, Math.PI * 1.95);
  ctx.stroke();
  poly([[-X(0.42), Y(0.9)], [X(0.42), Y(0.9)], [X(0.42), Y(0.95)], [-X(0.42), Y(0.95)]], secondary, false); // rear wing (no edge: sits on the engine cover)
  poly([[-X(0.42), Y(0.88)], [-X(0.38), Y(0.88)], [-X(0.38), Y(0.97)], [-X(0.42), Y(0.97)]], secondary); // endplates
  poly([[X(0.42), Y(0.88)], [X(0.38), Y(0.88)], [X(0.38), Y(0.97)], [X(0.42), Y(0.97)]], secondary);
}
