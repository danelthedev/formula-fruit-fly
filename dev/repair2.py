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
    return m, mi

lo, hi = 0.836, 0.864
win = [pts[i] for i in range(n) if lo <= i / n <= hi]
cx = sum(q[0] for q in win) / len(win)
cy = sum(q[1] for q in win) / len(win)
best = None
for step in [12.0, 14.0, 16.0, 18.0, 20.0]:
    new = [list(q) for q in pts]
    for i in range(n):
        f = i / n
        if not (lo <= f <= hi):
            continue
        edge = min((f - lo) / 0.006, (hi - f) / 0.006, 1.0)
        w = 0.5 * (1 - math.cos(math.pi * max(0.0, min(1.0, edge))))
        dx, dy = pts[i][0] - cx, pts[i][1] - cy
        L = math.hypot(dx, dy) or 1.0
        new[i][0] = pts[i][0] + w * step * dx / L
        new[i][1] = pts[i][1] + w * step * dy / L
    m, mi = minr(new, 0.83, 0.87)
    clear = min(
        math.hypot(new[j][0] - new[mi][0], new[j][1] - new[mi][1])
        for j in range(n) if min(abs(j - mi), n - abs(j - mi)) > 30
    )
    print(f'step={step}: minR={m:.1f} clearance={clear:.1f}')
    if m >= 25 and clear > 60:
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
