import { chromium } from 'playwright';

const browser = await chromium.launch({
  executablePath: 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--no-sandbox'],
});
const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
page.on('console', (m) => { if (m.type() === 'error') console.log('[page-error]', m.text().slice(0, 200)); });

console.log('shot: tengwang');
await page.goto('http://127.0.0.1:5173/?interactive=1&pavilion=tengwang', { waitUntil: 'load', timeout: 60000 });
try {
  await page.waitForFunction(() => window.__CHINA_TOWERS_READY__ === true, null, { timeout: 180000 });
} catch { console.log('  (ready flag timeout, shooting anyway)'); }
await page.waitForTimeout(5000);
await page.screenshot({ path: 'docs/screenshots/tengwang.png', timeout: 120000 });
console.log('  saved docs/screenshots/tengwang.png');
console.log('  diag:', JSON.stringify(await page.evaluate(() => window.__CHINA_TOWERS_DIAGNOSTICS__ ?? null)));
await browser.close();
console.log('done');
