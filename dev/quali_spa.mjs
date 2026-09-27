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
// import Spa track
await page.click('#btn-import');
await page.waitForTimeout(200);
await (await page.$('#file-import')).setInputFiles('/home/danel/Projects/racing_sim/assets/tracks/Spa GP.json');
await page.waitForFunction(() => (document.getElementById('status')?.innerText ?? '').startsWith('Imported'), { timeout: 15000 });
await page.fill('#in-name', 'SpaQ');
await page.click('#btn-save');
await page.waitForFunction(() => (document.getElementById('status')?.innerText ?? '').startsWith('Saved'), { timeout: 15000 });
// team
await page.click('#nav-teams');
await page.waitForTimeout(400);
await page.click('#btn-team-new');
await page.waitForTimeout(300);
await page.click('#btn-team-save');
await page.waitForTimeout(400);
// race setup: 1 driver for speed
await page.click('#nav-races');
await page.waitForTimeout(400);
await page.click('#btn-race-single');
await page.waitForTimeout(600);
await page.fill('#in-race-drivers', '1');
await page.click('#btn-race-begin');
await page.waitForTimeout(1000);
// import trained weights via practice card Import button
const impBtn = await page.evaluate(() => {
  const btns = [...document.querySelectorAll('#practice-teams button')];
  const b = btns.find((x) => x.textContent === 'Import weights');
  return b ? true : false;
});
console.log('import button found:', impBtn);
await page.evaluate(() => {
  const btns = [...document.querySelectorAll('#practice-teams button')];
  (btns.find((x) => x.textContent === 'Import weights')).click();
});
await page.waitForTimeout(300);
await (await page.$('#file-weights')).setInputFiles('/tmp/spa_champ_weights.json');
await page.waitForFunction(() => (document.getElementById('status')?.innerText ?? '').includes('imported'), { timeout: 15000 });
console.log('weights imported');
// quali
await page.click('#btn-start-quali');
console.log('quali started, waiting for completion...');
await page.waitForFunction(() => !(document.getElementById('btn-start-race')).disabled, { timeout: 300000 });
const board = await page.evaluate(() => [...document.querySelectorAll('#quali-board li')].map((li) => li.innerText.replace(/\n/g, ' | ')));
console.log('QUALI BOARD:', JSON.stringify(board, null, 1));
await page.locator('#race-quali').screenshot({ path: '/tmp/quali_spa.png' });
console.log('errors:', JSON.stringify(errs));
await browser.close();
