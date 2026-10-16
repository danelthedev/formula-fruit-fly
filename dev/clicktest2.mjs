import { chromium } from 'playwright-core';
const browser = await chromium.launch({
  executablePath: '/home/danel/.cache/ms-playwright/chromium-1234/chrome-linux64/chrome',
});
const page = await browser.newPage({ viewport: { width: 800, height: 600 } });
await page.setContent(`<ul id="b"></ul><div id="log"></div>
<script>
const ul = document.getElementById('b');
const log = [];
setInterval(() => {
  ul.innerHTML = '';
  for (let i = 0; i < 5; i++) {
    const li = document.createElement('li');
    li.dataset.key = 'k' + i;
    li.innerHTML = '<span>row ' + i + '</span>';
    ul.appendChild(li);
  }
}, 16);
ul.onclick = (e) => log.push('click target=' + (e.target.tagName || '?') + ' key=' + ((e.target.closest && e.target.closest('li')?.dataset.key) ?? 'NONE') + ' efp=' + (document.elementFromPoint(e.clientX, e.clientY)?.closest('li')?.dataset.key ?? 'NONE'));
ul.onmousedown = (e) => log.push('down efp=' + (document.elementFromPoint(e.clientX, e.clientY)?.closest('li')?.dataset.key ?? 'NONE'));
window.getLog = () => log.join(' | ');
</script>`);
await page.waitForTimeout(300);
const box = await page.locator('#b').boundingBox();
await page.mouse.move(box.x + 40, box.y + 30);
await page.mouse.down();
await page.waitForTimeout(150);
await page.mouse.up();
await page.waitForTimeout(300);
console.log('LOG:', await page.evaluate(() => window.getLog()));
await browser.close();
