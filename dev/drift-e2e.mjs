import fs from 'node:fs';
import { chromium } from 'playwright-core';
const file = JSON.parse(fs.readFileSync('/home/danel/Projects/racing_sim/problem track.json', 'utf8'));
const pointAt = (center, closed, fr) => {
  const n = center.length;
  const f = (((fr % 1) + 1) % 1) * n;
  const i = Math.floor(f) % n, r = f - Math.floor(f);
  const j = closed ? (i + 1) % n : Math.min(i + 1, n - 1);
  return [center[i][0] + (center[j][0] - center[i][0]) * r, center[i][1] + (center[j][1] - center[i][1]) * r];
};
const browser = await chromium.launch({
  executablePath: '/home/danel/.cache/ms-playwright/chromium-1234/chrome-linux64/chrome',
});
const page = await browser.newPage({ viewport: { width: 1600, height: 1000 } });
page.on('pageerror', (e) => console.log('PAGEERROR:', String(e).slice(0, 200)));
await page.goto('http://localhost:5199/');
await page.evaluate((t) => {
  localStorage.setItem('rs.v1.pieces', JSON.stringify({ pieces: [t.centerline], active: 0 }));
  localStorage.setItem('rs.v1.draft', JSON.stringify({ ...t, width: 60, gates: [0.05, 0.3, 0.55, 0.8], gateWidths: [60, 60, 60, 60], startS: 10, closed: false }));
}, file);
await page.reload();
await page.waitForSelector('#editor');
await page.waitForTimeout(800);
const snap = () => page.evaluate(() => {
  const d = JSON.parse(localStorage.getItem('rs.v1.draft') || 'null');
  return d ? { gates: d.gates, center: d.centerline, closed: d.closed, startS: d.startS } : null;
});
let s = await snap();
console.log('after seed-load: n=', s.center.length, 'closed=', s.closed, 'gates=', s.gates.map((g) => +g.toFixed(4)));
const worlds = (sn) => sn.gates.map((fr) => pointAt(sn.center, sn.closed, fr));
let prev = worlds(s);
for (let k = 1; k <= 3; k++) {
  await page.fill('#in-name', 'drift-probe');
  await page.click('#btn-save');
  await page.click('#btn-clear');
  await page.waitForTimeout(300);
  await page.selectOption('#sel-tracks', { index: 0 });
  await page.click('#btn-load');
  await page.waitForTimeout(600);
  s = await snap();
  const cur = worlds(s);
  const mv = cur.map((p, i) => Math.hypot(p[0] - prev[i][0], p[1] - prev[i][1]));
  console.log(`cycle${k}: n=${s.center.length} gateMove=${mv.map((v) => v.toFixed(3))}`);
  prev = cur;
}
await page.locator('#editor').screenshot({ path: '/tmp/drift-after.png' });
await browser.close();
