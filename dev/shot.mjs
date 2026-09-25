import { chromium } from 'playwright-core';
import fs from 'node:fs';

// Usage: node dev/shot.mjs <track.json> <out.png> [width]
const track = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
const out = process.argv[3] || '/tmp/shot.png';
const width = process.argv[4] ? Number(process.argv[4]) : null;
const browser = await chromium.launch({
  executablePath: '/home/danel/.cache/ms-playwright/chromium-1234/chrome-linux64/chrome',
});
const page = await browser.newPage({ viewport: { width: 1600, height: 1000 } });
await page.goto('http://localhost:5199/');
await page.evaluate((t) => {
  localStorage.setItem('rs.v1.pieces', JSON.stringify({ pieces: [t.centerline], active: 0 }));
  localStorage.setItem('rs.v1.draft', JSON.stringify(t));
}, track);
await page.reload();
await page.waitForSelector('#editor');
if (width !== null) {
  await page.evaluate((w) => {
    const el = document.getElementById('in-width');
    el.value = String(w);
    el.dispatchEvent(new Event('input', { bubbles: true }));
  }, width);
  await page.waitForTimeout(300);
}
await page.waitForTimeout(500);
await page.locator('#editor').screenshot({ path: out });
await browser.close();
console.log('saved', out);
