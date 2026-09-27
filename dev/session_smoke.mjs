// Session smoke: drawn oval, explore 8 + finalize 4, preview every 5. Logs title/board,
// waits for Start Quali to enable, screenshots the session view.
import { chromium } from 'playwright-core';
const browser = await chromium.launch({
  executablePath: '/home/danel/.cache/ms-playwright/chromium-1234/chrome-linux64/chrome',
  args: ['--use-gl=swiftshader', '--enable-unsafe-swiftshader'],
});
const page = await browser.newPage({ viewport: { width: 1600, height: 1000 } });
const errs = [];
page.on('pageerror', (e) => errs.push(String(e).slice(0, 300)));
page.on('console', (m) => { if (m.type() === 'error') errs.push('console: ' + m.text().slice(0, 200)); });
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
await page.fill('#in-name', 'S');
await page.click('#btn-save');
await page.waitForTimeout(400);
await page.click('#nav-teams');
await page.waitForTimeout(300);
await page.click('#btn-team-new');
await page.waitForTimeout(200);
await page.click('#btn-team-save');
await page.waitForTimeout(300);
await page.click('#btn-team-new');
await page.waitForTimeout(200);
await page.click('#btn-team-save');
await page.waitForTimeout(300);
await page.click('#nav-races');
await page.waitForTimeout(300);
await page.click('#btn-race-single');
await page.waitForTimeout(400);
await page.locator('#race-teams input[type="checkbox"]').evaluateAll((els) => els.forEach((e) => { e.checked = true; }));
await page.fill('#in-ga-pop', '6');
await page.fill('#in-ga-explore', '8');
await page.fill('#in-ga-finalize', '4');
await page.fill('#in-ga-preview', '5');
await page.click('#btn-race-begin');
await page.waitForTimeout(2000);
console.log('TITLE:', await page.evaluate(() => document.getElementById('practice-title').innerText));
console.log('BOARD:', await page.evaluate(() => document.getElementById('practice-board').innerText.replace(/\n/g, ' | ')));
let unlocked = false;
let pinned = true;
let shot = false;
const t0 = Date.now();
while (Date.now() - t0 < 420000) {
  await page.waitForTimeout(5000);
  const s = await page.evaluate(() => ({
    tracksHidden: document.getElementById('view-tracks').hidden,
    practiceShown: !document.getElementById('race-practice').hidden,
    qualiDis: document.getElementById('btn-start-quali').disabled,
    title: document.getElementById('practice-title').innerText,
  }));
  if (!s.tracksHidden || !s.practiceShown) pinned = false;
  if (!shot && /Previewing/.test(await page.evaluate(() => document.getElementById('status').innerText))) { shot = true; await page.screenshot({ path: '/tmp/session_preview.png' }); console.log('PREVIEW SHOT TAKEN'); }
  console.log('POLL:', s.title, '| tracksHidden:', s.tracksHidden, '| qualiDis:', s.qualiDis);
  if (!s.qualiDis) { unlocked = true; break; }
}
console.log(unlocked ? 'QUALI UNLOCKED' : 'QUALI STILL LOCKED (timeout)');
console.log('VIEW PINNED:', pinned);
console.log('TITLE:', await page.evaluate(() => document.getElementById('practice-title').innerText));
console.log('BOARD:', await page.evaluate(() => document.getElementById('practice-board').innerText.replace(/\n/g, ' | ')));
console.log('HINT:', await page.evaluate(() => document.getElementById('practice-hint').innerText));
await page.screenshot({ path: '/tmp/session_smoke.png' });
console.log('errors:', JSON.stringify(errs));
await browser.close();
