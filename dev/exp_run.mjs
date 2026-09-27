// Param-search probe (session UI): seed track, set explore/finalize counts, begin,
// log title+board every 30s until quali unlocks or timeout.
// argv: port trackAsset exploreN finalizeN maxWaitMin logPath
import { readFileSync, appendFileSync } from 'node:fs';
import { chromium } from 'playwright-core';
const [port, trackAsset, exploreS, finalizeS, previewS, maxWaitS, logPath] = process.argv.slice(2);
const track = JSON.parse(readFileSync(`/home/danel/Projects/racing_sim/assets/tracks/${trackAsset}`, 'utf8'));
const browser = await chromium.launch({
  executablePath: '/home/danel/.cache/ms-playwright/chromium-1234/chrome-linux64/chrome',
  args: ['--use-gl=swiftshader', '--enable-unsafe-swiftshader'],
});
const page = await browser.newPage({ viewport: { width: 1600, height: 1000 } });
const errs = [];
page.on('pageerror', (e) => errs.push(String(e).slice(0, 200)));
const log = (o) => appendFileSync(logPath, JSON.stringify(o) + '\n');
await page.goto(`http://localhost:${port}/`);
await page.evaluate(() => { localStorage.clear(); indexedDB.deleteDatabase('racing-sim'); });
await page.reload();
await page.waitForSelector('#editor');
await page.waitForTimeout(800);
for (let attempt = 0; attempt < 8; attempt++) {
  try {
    await page.evaluate((t) => new Promise((res, rej) => {
      const q = indexedDB.open('racing-sim', 1);
      q.onsuccess = () => {
        const db = q.result;
        if (!db.objectStoreNames.contains('kv')) { rej(new Error('no kv store yet')); return; }
        const tx = db.transaction('kv', 'readwrite');
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
    log({ ev: 'seeded', attempt });
    break;
  } catch (e) { log({ ev: 'seed-retry', attempt, err: String(e).slice(0, 120) }); await page.waitForTimeout(1000); }
}
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
await page.check('#race-teams input[type="checkbox"]');
await page.fill('#in-ga-explore', exploreS);
await page.fill('#in-ga-finalize', finalizeS);
await page.fill('#in-ga-preview', previewS);
await page.click('#btn-race-begin');
await page.waitForTimeout(2000);
const t0 = Date.now();
const maxMs = Number(maxWaitS) * 60 * 1000;
log({ ev: 'start', track: trackAsset, explore: exploreS, finalize: finalizeS, preview: previewS });
let unlocked = false;
while (Date.now() - t0 < maxMs) {
  await page.waitForTimeout(30000);
  const title = await page.evaluate(() => document.getElementById('practice-title')?.innerText ?? 'NOTITLE');
  const board = await page.evaluate(() => document.getElementById('practice-board')?.innerText.replace(/\n/g, ' | ') ?? 'NOBOARD');
  const q = await page.evaluate(() => ({ dis: document.getElementById('btn-start-quali').disabled }));
  log({ ev: 'tick', t: Math.round((Date.now() - t0) / 1000), title, board, qualiDisabled: q.dis });
  if (!q.dis) { unlocked = true; break; }
}
log({ ev: 'end', unlocked, errs });
await browser.close();
