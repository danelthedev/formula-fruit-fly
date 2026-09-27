import json, math
p = 'assets/tracks/Portimao GP.json'
t = json.load(open(p))
pts = [list(map(float, q)) for q in t['centerline']]
n = len(pts)

def radius(pts, i, R=2):
    a = pts[(i - R + n) % n]; b = pts[i]; c = pts[(i + R) % n]
    ab = math.hypot(b[0]-a[0], b[1]-a[1]); bc = math.hypot(c[0]-b[0], c[1]-b[1]); ca = math.hypot(a[0]-c[0], a[1]-c[1])
    area = abs((b[0]-a[0])*(c[1]-a[1]) - (c[0]-a[0])*(b[1]-a[1])) / 2
    return float('inf') if area < 1e-9 else (ab*bc*ca)/(4*area)

def minr(pts, lo, hi):
    m, mi = float('inf'), -1
    for i in range(n):
        f = i / n
        if lo <= f <= hi:
            r = radius(pts, i)
            if r < m:
                m, mi = r, i
    return m, (mi / n if mi >= 0 else -1)

i0, i1 = int(0.843 * n), int(0.863 * n)
P0, P1 = pts[i0], pts[i1]
# approximate apex direction: midpoint of original window vs chord midpoint
mid = pts[int(0.853 * n)]
chord_mid = [(P0[0] + P1[0]) / 2, (P0[1] + P1[1]) / 2]
side = [mid[0] - chord_mid[0], mid[1] - chord_mid[1]]
chord = math.hypot(P1[0] - P0[0], P1[1] - P0[1])
print(f'chord={chord:.1f} apex-side=({side[0]:.1f},{side[1]:.1f})')
best = None
for R in [26.0, 30.0, 34.0, 40.0]:
    if R < chord / 2 * 1.01:
        print(f'R={R}: chord too long, skip')
        continue
    # circle center: perpendicular bisector, on opposite side from apex bulge
    mx, my = chord_mid
    dx, dy = P1[0] - P0[0], P1[1] - P0[1]
    L = math.hypot(dx, dy) or 1.0
    nx, ny = -dy / L, dx / L  # left normal
    # choose center side so arc bulges toward apex side
    dot = nx * side[0] + ny * side[1]
    sx, sy = (nx, ny) if dot < 0 else (-nx, -ny)
    h = math.sqrt(max(R * R - (chord / 2) ** 2, 0))
    cx, cy = mx + sx * h, my + sy * h
    # sample arc from angle(P0) to angle(P1) going through apex side
    a0 = math.atan2(P0[1] - cy, P0[0] - cx)
    a1 = math.atan2(P1[1] - cy, P1[0] - cx)
    amid = math.atan2(mid[1] - cy, mid[0] - cx)
    # direction: increasing or decreasing?
    def angdiff(a, b):
        d = (b - a) % (2 * math.pi)
        return d
    # pick sweep passing through amid
    d1 = angdiff(a0, amid) + angdiff(amid, a1)
    d2 = angdiff(a1, amid) + angdiff(amid, a0)
    if d1 <= d2:
        sweep, start = d1, a0
        def ang(t):
            return start + sweep * t
    else:
        sweep, start = d2, a1
        def ang(t):
            return start + sweep * t
    cnt = i1 - i0 + 1
    new = [list(q) for q in pts]
    for k in range(cnt):
        a = ang(k / max(cnt - 1, 1))
        new[i0 + k] = [cx + R * math.cos(a), cy + R * math.sin(a)]
    m, mf = minr(new, 0.83, 0.88)
    print(f'R={R}: minR={m:.1f} at {mf:.4f}')
    if m >= 24:
        best = new
        break
if best:
    t['centerline'] = best
    gs, ws = t['gates'], t['gateWidths']
    t['gateWidths'] = [30 if (abs(g - 0.8333) < 0.005 or abs(g - 0.8778) < 0.005) else w for g, w in zip(gs, ws)]
    json.dump(t, open(p, 'w'))
    print('SAVED repaired track')
else:
    print('NOT saved')
