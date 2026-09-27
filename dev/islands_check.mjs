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
await page.fill('#in-name', 'I');
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
await page.click('#btn-race-begin');
await page.waitForTimeout(800);
await page.fill('#in-ga-pop', '6');
const islVal = await page.evaluate(() => document.getElementById('in-ga-islands').value);
console.log('islands input default:', islVal);
await page.click('.practice-card button');
await page.waitForTimeout(25000);
const cards = await page.evaluate(() => [...document.querySelectorAll('.practice-card')].map((c) => c.innerText.replace(/\n/g, ' | ')));
console.log('CARDS:', JSON.stringify(cards, null, 1));
// stop training, run quali
const btns2 = await page.$$('.practice-card button');
for (const b of btns2) { if ((await b.textContent()) === 'Stop') await b.click(); }
await page.waitForTimeout(500);
await page.click('#btn-start-quali');
await page.waitForTimeout(20000);
const board = await page.evaluate(() => [...document.querySelectorAll('#quali-board li')].map((li) => li.innerText.replace(/\n/g, ' ')));
console.log('QUALI BOARD:', JSON.stringify(board));
console.log('errors:', JSON.stringify(errs));
await browser.close();
