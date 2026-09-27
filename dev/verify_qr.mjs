// Verifies: direction display+reverse, simultaneous quali, race gaps + start lights.
import { readFileSync } from 'node:fs';
import { chromium } from 'playwright-core';
const track = JSON.parse(readFileSync('/home/danel/Projects/racing_sim/assets/tracks/Portimao GP.json', 'utf8'));
const pop = JSON.parse(readFileSync('/tmp/headless_pop.json', 'utf8'));
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
// --- direction: draw a loop, read label, reverse, read again
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
await page.waitForTimeout(500);
const dir1 = await page.evaluate(() => document.getElementById('track-direction').innerText);
await page.click('#btn-reverse');
await page.waitForTimeout(500);
const dir2 = await page.evaluate(() => document.getElementById('track-direction').innerText);
console.log('DIRECTION:', JSON.stringify(dir1), '->', JSON.stringify(dir2));
// --- seed Portimao + a team + mediocre weights, skip to quali
await page.evaluate((t) => new Promise((res, rej) => {
  const q = indexedDB.open('racing-sim', 1);
  q.onsuccess = () => {
    const tx = q.result.transaction('kv', 'readwrite');
    const st = tx.objectStore('kv');
    const get = st.get('rs.v1.tracks');
    get.onsuccess = () => {
      const d = get.result ? JSON.parse(get.result) : {};
      d[t.id] = t;
      st.put(JSON.stringify(d), 'rs.v1.tracks');
      tx.oncomplete = () => res();
    };
    get.onerror = () => rej();
  };
  q.onerror = () => rej();
}), track);
await page.click('#nav-teams');
await page.waitForTimeout(300);
await page.click('#btn-team-new');
await page.waitForTimeout(200);
await page.click('#btn-team-save');
await page.waitForTimeout(300);
const teamId = await page.evaluate(() => new Promise((res, rej) => {
  const q = indexedDB.open('racing-sim', 1);
  q.onsuccess = () => {
    const g = q.result.transaction('kv').objectStore('kv').get('rs.v1.teams');
    g.onsuccess = () => {
      const raw = g.result ? JSON.parse(g.result) : [];
      const arr = Array.isArray(raw) ? raw : Object.values(raw);
      res(arr[0]?.id ?? null);
    };
    g.onerror = () => rej();
  };
  q.onerror = () => rej();
}));
console.log('TEAM:', teamId);
await page.evaluate(({ tid, w }) => new Promise((res, rej) => {
  const q = indexedDB.open('racing-sim', 1);
  q.onsuccess = () => {
    const tx = q.result.transaction('kv', 'readwrite');
    const st = tx.objectStore('kv');
    st.put(JSON.stringify({ v: 2, teamId: tid, teamName: 'Team 1', arch: [16, 64, 64, 3], weights: [...w] }), `rs.v1.weights.${tid}`);
    st.put(JSON.stringify([[ ...w ]]), `rs.v1.population.${tid}`);
    tx.oncomplete = () => res();
  };
  q.onerror = () => rej();
}), { tid: teamId, w: pop.best });
await page.click('#nav-races');
await page.waitForTimeout(300);
await page.click('#btn-race-single');
await page.waitForTimeout(400);
await page.selectOption('#sel-race-track', track.id);
await page.waitForTimeout(300);
await page.locator('#race-teams input[type="checkbox"]').evaluateAll((els) => els.forEach((e) => { e.checked = true; }));
await page.waitForFunction(() => !document.getElementById('btn-race-skip').disabled, null, { timeout: 30000 });
await page.click('#btn-race-skip');
await page.waitForTimeout(8000);
await page.screenshot({ path: '/tmp/quali_sim.png' });
console.log('QUALI MID:', await page.evaluate(() => [...document.querySelectorAll('#quali-board li')].map((li) => li.innerText.replace(/\n/g, ' ')).join(' // ')));
await page.waitForFunction(() => !document.getElementById('btn-start-race').disabled, null, { timeout: 300000 });
console.log('QUALI DONE:', await page.evaluate(() => [...document.querySelectorAll('#quali-board li')].map((li) => li.innerText.replace(/\n/g, ' ')).join(' // ')));
await page.click('#btn-start-race');
await page.waitForTimeout(1800);
await page.screenshot({ path: '/tmp/race_lights.png' });
await page.waitForTimeout(12000);
await page.screenshot({ path: '/tmp/race_gaps.png' });
console.log('RACE BOARD:', await page.evaluate(() => [...document.querySelectorAll('#race-board li')].map((li) => li.innerText.replace(/\n/g, ' ')).join(' // ')));
console.log('errors:', JSON.stringify(errs));
await browser.close();
