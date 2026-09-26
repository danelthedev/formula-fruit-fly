import { chromium } from 'playwright-core';
const browser = await chromium.launch({ executablePath: '/home/danel/.cache/ms-playwright/chromium-1234/chrome-linux64/chrome' });
const page = await browser.newPage({ viewport: { width: 1600, height: 1000 } });
const errs = [];
page.on('pageerror', (e) => errs.push(String(e)));
page.on('console', (m) => { if (m.type() === 'error') errs.push('console: ' + m.text().slice(0, 200)); });
await page.goto('http://localhost:5199/');
await page.evaluate(() => { localStorage.clear(); indexedDB.deleteDatabase('racing-sim'); });
await page.reload();
await page.waitForSelector('#editor');
await page.waitForTimeout(800);
await page.click('#nav-races');
await page.waitForTimeout(400);
await page.click('#btn-race-single');
await page.waitForTimeout(800);
const s = await page.evaluate(() => ({
  setupHidden: document.getElementById('race-setup').hidden,
  landingHidden: document.getElementById('race-landing').hidden,
  hint: document.getElementById('race-setup-hint').textContent,
}));
console.log(JSON.stringify(s));
console.log('errors:', JSON.stringify(errs));
await browser.close();
