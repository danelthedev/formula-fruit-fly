// Skip-probe: fresh team (skip disabled) → short train → back to setup
// (skip enabled) → skip → quali pane with board entries.
import { chromium } from 'playwright-core';
const browser = await chromium.launch({
  executablePath: '/home/danel/.cache/ms-playwright/chromium-1234/chrome-linux64/chrome',
  args: ['--use-gl=swiftshader', '--enable-unsafe-swiftshader'],
});
const page = await browser.newPage({ viewport: { width: 1600, height: 1000 } });
const errs = [];
page.on('pageerror', (e) => errs.push(String(e).slice(0, 200)));
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
await page.click('#nav-races');
await page.waitForTimeout(300);
await page.click('#btn-race-single');
await page.waitForTimeout(400);
await page.locator('#race-teams input[type="checkbox"]').evaluateAll((els) => els.forEach((e) => { e.checked = true; }));
console.log('SKIP DISABLED (fresh):', await page.evaluate(() => document.getElementById('btn-race-skip').disabled));
await page.fill('#in-ga-pop', '6');
await page.fill('#in-ga-explore', '10');
await page.fill('#in-ga-finalize', '0');
await page.fill('#in-ga-preview', '0');
await page.click('#btn-race-begin');
await page.waitForFunction(() => !document.getElementById('btn-start-quali').disabled, null, { timeout: 300000 });
console.log('trained, quali unlocked');
await page.click('#btn-practice-back');
await page.waitForTimeout(800);
console.log('SKIP ENABLED (trained):', await page.evaluate(() => !document.getElementById('btn-race-skip').disabled));
await page.click('#btn-race-skip');
await page.waitForFunction(() => document.querySelectorAll('#quali-board li').length > 0, null, { timeout: 180000 });
console.log('QUALI VIA SKIP:', await page.evaluate(() => [...document.querySelectorAll('#quali-board li')].map((li) => li.innerText.replace(/\n/g, ' ')).join(' // ')));
console.log('errors:', JSON.stringify(errs));
await browser.close();
