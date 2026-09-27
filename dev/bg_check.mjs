// BG verification: Portimao + synthetic SVG underlay, short session, screenshot.
import { readFileSync } from 'node:fs';
import { chromium } from 'playwright-core';
const track = JSON.parse(readFileSync('/home/danel/Projects/racing_sim/assets/tracks/Portimao GP.json', 'utf8'));
const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="644" height="510"><rect width="644" height="510" fill="#1c3a24"/><circle cx="322" cy="255" r="180" fill="#2a5a34"/><path d="M0 255H644M322 0V510" stroke="#3a7a44" stroke-width="4"/></svg>`;
track.bg = { data: 'data:image/svg+xml,' + encodeURIComponent(svg), x: 41, y: 50, s: 1 };
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
await page.waitForTimeout(800);
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
await page.selectOption('#sel-race-track', track.id);
await page.waitForTimeout(300);
await page.locator('#race-teams input[type="checkbox"]').evaluateAll((els) => els.forEach((e) => { e.checked = true; }));
await page.fill('#in-ga-pop', '6');
await page.fill('#in-ga-explore', '10');
await page.fill('#in-ga-finalize', '0');
await page.fill('#in-ga-preview', '0');
await page.click('#btn-race-begin');
await page.waitForTimeout(12000);
await page.screenshot({ path: '/tmp/session_bg.png' });
console.log('TITLE:', await page.evaluate(() => document.getElementById('practice-title').innerText));
// quali: untrained drivers crash fast, but the scene (with bg) still paints
await page.click('#btn-start-quali');
await page.waitForFunction(() => document.querySelectorAll('#quali-board li').length > 0, null, { timeout: 180000 });
await page.waitForTimeout(3000);
await page.screenshot({ path: '/tmp/quali_bg.png' });
console.log('QUALI BOARD:', await page.evaluate(() => [...document.querySelectorAll('#quali-board li')].map((li) => li.innerText.replace(/\n/g, ' ')).join(' // ')));
console.log('errors:', JSON.stringify(errs));
await browser.close();
