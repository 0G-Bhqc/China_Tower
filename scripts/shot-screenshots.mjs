import { chromium } from 'playwright';
import { existsSync, mkdirSync } from 'node:fs';

const OUT = 'docs/screenshots';
mkdirSync(OUT, { recursive: true });

const SHOTS = [
  { name: 'yueyang', url: 'http://127.0.0.1:5173/?interactive=1' },
  { name: 'huanghe', url: 'http://127.0.0.1:5173/?interactive=1&pavilion=huanghe' },
  { name: 'tengwang', url: 'http://127.0.0.1:5173/?interactive=1&pavilion=tengwang' },
];

// WebGL 用 SwiftShader 软渲染出图；本机装有 Edge 时优先用 Edge，否则退回 Playwright 自带 Chromium。
const EDGE = 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';
const browser = await chromium.launch({
  executablePath: existsSync(EDGE) ? EDGE : undefined,
  args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--no-sandbox'],
});
const page = await browser.newPage({ viewport: { width: 1600, height: 900 } });
page.on('console', (m) => { if (m.type() === 'error') console.log('[page-error]', m.text().slice(0, 200)); });

for (const s of SHOTS) {
  console.log('shot:', s.name);
  await page.goto(s.url, { waitUntil: 'load', timeout: 60000 });
  try {
    await page.waitForFunction(() => window.__CHINA_TOWERS_READY__ === true, null, { timeout: 120000 });
  } catch { console.log('  (ready flag timeout, shooting anyway)'); }
  await page.waitForTimeout(4000);
  const file = `${OUT}/${s.name}.png`;
  await page.screenshot({ path: file });
  console.log('  saved', file);
  const diag = await page.evaluate(() => window.__CHINA_TOWERS_DIAGNOSTICS__ ?? null);
  console.log('  diag:', JSON.stringify(diag));
}
await browser.close();
console.log('done');
