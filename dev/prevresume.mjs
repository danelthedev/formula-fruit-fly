import { chromium } from 'playwright-core';
const browser = await chromium.launch({
  executablePath: '/home/danel/.cache/ms-playwright/chromium-1234/chrome-linux64/chrome',
  args: ['--use-gl=swiftshader', '--enable-unsafe-swiftshader'],
});
const page = await browser.newPage({ viewport: { width: 1600, height: 1000 } });
const errs = [];
page.on('pageerror', (e) => errs.push(String(e)));
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
await page.fill('#in-name', 'P');
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
await page.click('.practice-card button');
// let it train ~20s (a few epochs), then manual preview
await page.waitForTimeout(20000);
const e0 = await page.evaluate(() => document.querySelector('.practice-card .stat')?.textContent);
await page.click('#btn-preview-now');
console.log('manual preview requested at:', JSON.stringify(e0));
// wait for canvas switch
let saw = false;
for (let i = 0; i < 20; i++) {
  await page.waitForTimeout(1000);
  if (await page.evaluate(() => !document.getElementById('view-tracks').hidden)) { saw = true; break; }
}
console.log('manual preview on canvas:', saw);
// wait for return (up to 100s)
let back = false;
for (let i = 0; i < 100; i++) {
  await page.waitForTimeout(1000);
  if (await page.evaluate(() => !document.getElementById('view-races').hidden)) { back = true; break; }
}
console.log('returned to practice:', back);
const e1 = await page.evaluate(() => document.querySelector('.practice-card .stat')?.textContent);
console.log('stat now:', JSON.stringify(e1));
// training resumes? epoch advances within 25s
await page.waitForTimeout(25000);
const e2 = await page.evaluate(() => document.querySelector('.practice-card .stat')?.textContent);
console.log('stat later:', JSON.stringify(e2));
console.log('errors:', JSON.stringify(errs));
await browser.close();
