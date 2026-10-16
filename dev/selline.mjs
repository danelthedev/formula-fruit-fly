import { readFileSync } from 'node:fs';
import { chromium } from 'playwright-core';
const track = JSON.parse(readFileSync('/home/danel/Projects/racing_sim/assets/tracks/Portimao GP.json', 'utf8'));
const browser = await chromium.launch({
  executablePath: '/home/danel/.cache/ms-playwright/chromium-1234/chrome-linux64/chrome',
  args: ['--use-gl=swiftshader', '--enable-unsafe-swiftshader'],
});
const page = await browser.newPage({ viewport: { width: 1600, height: 1000 } });
const errs = [];
page.on('pageerror', (e) => errs.push('PAGEERROR: ' + String(e).slice(0, 200)));
await page.goto('http://localhost:5199/');
await page.evaluate(() => { localStorage.clear(); indexedDB.deleteDatabase('racing-sim'); });
await page.reload();
await page.waitForSelector('#editor');
await page.evaluate((t) => new Promise((res) => {
  const q = indexedDB.open('racing-sim', 1);
  q.onsuccess = () => {
    const tx = q.result.transaction('kv', 'readwrite');
    tx.objectStore('kv').put(JSON.stringify({ [t.id]: t }), 'rs.v1.tracks');
    tx.oncomplete = () => res();
  };
}), track);
await page.click('#nav-teams'); await page.waitForTimeout(300);
await page.click('#btn-team-new'); await page.waitForTimeout(200);
await page.click('#btn-team-save'); await page.waitForTimeout(400);
const teamId = await page.evaluate(() => new Promise((res) => {
  const q = indexedDB.open('racing-sim', 1);
  q.onsuccess = () => {
    const g = q.result.transaction('kv').objectStore('kv').get('rs.v1.teams');
    g.onsuccess = () => { const raw = JSON.parse(g.result || '[]'); res((Array.isArray(raw) ? raw : Object.values(raw))[0]?.id); };
  };
}));
await page.evaluate((tid) => new Promise((res) => {
  const w = new Array(5443).fill(0); w[5440] = 3; w[5441] = -3; w[5442] = 0;
  const q = indexedDB.open('racing-sim', 1);
  q.onsuccess = () => {
    const tx = q.result.transaction('kv', 'readwrite');
    const st = tx.objectStore('kv');
    st.put(JSON.stringify({ v: 2, teamId: tid, teamName: 'T', arch: [16, 64, 64, 3], weights: w }), `rs.v1.weights.${tid}`);
    st.put(JSON.stringify([w]), `rs.v1.population.${tid}`);
    tx.oncomplete = () => res();
  };
}), teamId);
await page.click('#nav-races'); await page.waitForTimeout(300);
await page.click('#btn-race-single'); await page.waitForTimeout(400);
await page.selectOption('#sel-race-track', track.id); await page.waitForTimeout(300);
await page.locator('#race-teams input[type="checkbox"]').evaluateAll((els) => els.forEach((e) => { e.checked = true; }));
await page.waitForFunction(() => !document.getElementById('btn-race-skip').disabled, { timeout: 30000 });
await page.click('#btn-race-skip');
await page.waitForFunction(() => !document.getElementById('btn-start-race').disabled, { timeout: 120000 });
console.log('QUALI DONE');
// select first driver post-quali, screenshot, sample line pixels
const bb = await page.locator('#quali-board').boundingBox();
await page.mouse.move(bb.x + 100, bb.y + 30);
await page.mouse.down(); await page.waitForTimeout(120); await page.mouse.up();
await page.waitForTimeout(600);
console.log('sel rows:', await page.evaluate(() => document.querySelectorAll('#quali-board li.sel').length));
const px = await page.evaluate(() => {
  const cv = document.getElementById('quali-canvas');
  const c = cv.getContext('2d');
  const d = c.getImageData(0, 0, cv.width, cv.height).data;
  let green = 0, red = 0, white = 0;
  for (let i = 0; i < d.length; i += 4) {
    const [r, g, b] = [d[i], d[i + 1], d[i + 2]];
    if (g > 200 && r < 120 && b < 180) green++;
    else if (r > 200 && g < 110 && b < 110) red++;
    else if (r > 230 && g > 230 && b > 230) white++;
  }
  return { green, red, white };
});
console.log('pixels:', JSON.stringify(px));
await page.screenshot({ path: '/tmp/selline.png' });
console.log('errors:', JSON.stringify(errs));
await browser.close();
