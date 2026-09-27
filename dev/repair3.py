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

# apex outward normal: apex minus centroid of wide window
loW, hiW = 0.82, 0.88
win = [pts[i] for i in range(n) if loW <= i / n <= hiW]
cx = sum(q[0] for q in win) / len(win)
cy = sum(q[1] for q in win) / len(win)
ai = int(0.853 * n)
ax, ay = pts[ai][0] - cx, pts[ai][1] - cy
L = math.hypot(ax, ay) or 1.0
nx, ny = ax / L, ay / L  # outward normal at apex
print(f'apex frac=0.853 normal=({nx:.2f},{ny:.2f})')
best = None
for amp in [4.0, 6.0, 8.0, 10.0, 12.0, 14.0]:
    new = [list(q) for q in pts]
    for i in range(n):
        f = i / n
        g = math.exp(-((f - 0.853) ** 2) / (2 * 0.008 ** 2))
        new[i][0] = pts[i][0] + amp * g * nx
        new[i][1] = pts[i][1] + amp * g * ny
    m, mf = minr(new, 0.83, 0.88)
    clear = min(
        math.hypot(new[j][0] - new[int(mf * n)][0], new[j][1] - new[int(mf * n)][1])
        for j in range(n) if min(abs(j - int(mf * n)), n - abs(j - int(mf * n))) > 30
    )
    print(f'amp={amp}: minR={m:.1f} at {mf:.4f} clearance={clear:.1f}')
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
