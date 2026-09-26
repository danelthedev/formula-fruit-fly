import { chromium } from 'playwright-core';
const browser = await chromium.launch({ executablePath: '/home/danel/.cache/ms-playwright/chromium-1234/chrome-linux64/chrome' });
const page = await browser.newPage({ viewport: { width: 1600, height: 1000 } });
await page.goto('http://localhost:5199/');
await page.evaluate(() => { localStorage.clear(); indexedDB.deleteDatabase('racing-sim'); });
await page.reload();
await page.waitForSelector('#editor');
await page.waitForTimeout(800);
const box = await page.locator('#editor').boundingBox();
const X = (cx) => box.x + (cx / 960) * box.width;
const Y = (cy) => box.y + (cy / 600) * box.height;
const pts = [];
for (let a = 0; a <= 50; a++) {
  const t = (a / 50) * Math.PI * 2;
  pts.push([480 + 200 * Math.cos(t), 300 + 120 * Math.sin(t)]);
}
await page.mouse.move(X(pts[0][0]), Y(pts[0][1]));
await page.mouse.down();
for (const [x, y] of pts.slice(1)) await page.mouse.move(X(x), Y(y), { steps: 2 });
await page.mouse.up();
await page.waitForTimeout(400);
await page.fill('#in-name', 'Q');
await page.click('#btn-save');
await page.waitForTimeout(400);
await page.click('#nav-teams');
await page.waitForTimeout(300);
for (const nm of ['Red', 'Blue']) {
  await page.click('#btn-team-new');
  await page.waitForTimeout(200);
  await page.fill('#in-team-name', nm);
  await page.click('#btn-team-save');
  await page.waitForTimeout(300);
}
await page.click('#nav-races');
await page.waitForTimeout(300);
await page.click('#btn-race-single');
await page.waitForTimeout(400);
const s = await page.evaluate(() => ({
  setupHidden: document.getElementById('race-setup').hidden,
  tracks: document.getElementById('sel-race-track').innerHTML.slice(0, 120),
  teamrows: document.querySelectorAll('#race-teams .race-teamrow').length,
  hint: document.getElementById('race-setup-hint').textContent,
  status: document.getElementById('status').textContent,
}));
console.log(JSON.stringify(s, null, 1));
await browser.close();
