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
await page.waitForTimeout(500);
// seed track + team + RANDOM weights (5443) so skip-to-quali unlocks
await page.evaluate((t) => new Promise((res, rej) => {
  const q = indexedDB.open('racing-sim', 1);
  q.onsuccess = () => {
    const tx = q.result.transaction('kv', 'readwrite');
    const st = tx.objectStore('kv');
    const d = {}; d[t.id] = t; st.put(JSON.stringify(d), 'rs.v1.tracks');
    tx.oncomplete = () => res();
  };
  q.onerror = () => rej();
}), track);
await page.click('#nav-teams'); await page.waitForTimeout(300);
await page.click('#btn-team-new'); await page.waitForTimeout(200);
await page.click('#btn-team-save'); await page.waitForTimeout(400);
const teamId = await page.evaluate(() => new Promise((res, rej) => {
  const q = indexedDB.open('racing-sim', 1);
  q.onsuccess = () => {
    const g = q.result.transaction('kv').objectStore('kv').get('rs.v1.teams');
    g.onsuccess = () => { const raw = g.result ? JSON.parse(g.result) : []; res((Array.isArray(raw) ? raw : Object.values(raw))[0]?.id ?? null); };
    g.onerror = () => rej();
  };
}));
console.log('TEAM:', teamId);
await page.evaluate((tid) => new Promise((res, rej) => {
  const w = new Array(5443).fill(0); w[5440] = 0.5; w[5441] = -3; w[5442] = 0;
  const q = indexedDB.open('racing-sim', 1);
  q.onsuccess = () => {
    const tx = q.result.transaction('kv', 'readwrite');
    const st = tx.objectStore('kv');
    st.put(JSON.stringify({ v: 2, teamId: tid, teamName: 'Team 1', arch: [16, 64, 64, 3], weights: w }), `rs.v1.weights.${tid}`);
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
// wait for quali rows, then click first row ASAP (mid-run) and check .sel sticks
await page.waitForSelector('#quali-board li');
await page.waitForTimeout(100);
const bb = await page.locator('#quali-board').boundingBox();
await page.mouse.move(bb.x + 100, bb.y + 30);
await page.mouse.down();
await page.waitForTimeout(150);
await page.mouse.up();
await page.waitForTimeout(500);
const midSel = await page.evaluate(() => document.querySelectorAll('#quali-board li.sel').length);
const midLive = await page.evaluate(() => document.querySelectorAll('#quali-board li.live').length);
await page.waitForTimeout(1500);
const selCount = await page.evaluate(() => document.querySelectorAll('#quali-board li.sel').length);
const rows = await page.evaluate(() => [...document.querySelectorAll('#quali-board li')].map((li) => li.className + ' :: ' + li.innerText.replace(/\n/g, ' ').slice(0, 60)).join('\n'));
console.log('MID-RUN sel:', midSel, 'live rows:', midLive);
console.log('SEL COUNT (expect >=1):', selCount);
console.log('ROWS:\n' + rows);
console.log('errors:', JSON.stringify(errs));
await browser.close();
