const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { chromium } = require('C:/Users/admin/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright');

const workspace = path.resolve(__dirname, '..');
const distRoot = path.join(workspace, 'dist');
const evidenceRoot = path.join(workspace, 'evidence', '3d-assets', 'runtime-smoke');
const browserExecutable = 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';
const contentTypes = { '.css': 'text/css', '.html': 'text/html', '.js': 'text/javascript', '.json': 'application/json', '.glb': 'model/gltf-binary' };

function serve(request, response) {
  const pathname = new URL(request.url, 'http://127.0.0.1').pathname;
  const relative = pathname === '/' ? 'index.html' : pathname.replace(/^\/+/, '');
  const file = path.resolve(distRoot, relative);
  if (!file.startsWith(distRoot + path.sep) && file !== path.join(distRoot, 'index.html')) return response.writeHead(403).end();
  fs.readFile(file, (error, data) => {
    if (error) return response.writeHead(404).end();
    response.writeHead(200, {
      'Content-Type': contentTypes[path.extname(file)] || 'application/octet-stream',
      'Content-Length': data.length,
      'Cache-Control': path.extname(file) === '.glb' ? 'public, max-age=31536000, immutable' : 'no-store',
    });
    response.end(data);
  });
}

async function main() {
  fs.mkdirSync(evidenceRoot, { recursive: true });
  const server = http.createServer(serve);
  await new Promise((resolve) => server.listen(4174, '127.0.0.1', resolve));
  const browser = await chromium.launch({ headless: true, executablePath: browserExecutable, args: ['--ignore-gpu-blocklist'] });
  const errors = [];
  const results = [];
  try {
    const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
    page.on('pageerror', (error) => errors.push(error.message));
    page.on('console', (message) => {
      if (message.type() === 'error' && !message.text().includes('404 (Not Found)')) errors.push(message.text());
    });
    for (const [id, lod] of [['yueyang', 'lod0'], ['huanghe', 'lod0'], ['tengwang', 'lod0']]) {
      const glbRequests = [];
      const listener = (request) => { if (request.url().endsWith('.glb')) glbRequests.push(new URL(request.url()).pathname); };
      page.on('request', listener);
      await page.goto(`http://127.0.0.1:4174/?review=1&pavilion=${id}&view=three-quarter&lod=${lod}`, { waitUntil: 'domcontentloaded', timeout: 30000 });
      await page.waitForFunction(() => window.__CHINA_TOWERS_READY__ === true, null, { timeout: 60000 });
      await page.waitForFunction(() => (window.__CHINA_TOWERS_DIAGNOSTICS__?.partCount ?? 0) > 0, null, { timeout: 60000 });
      const canvas = page.locator('#scene');
      const box = await canvas.boundingBox();
      if (!box) throw new Error(`Canvas bounds unavailable: ${id}`);
      const cameraBeforeOrbit = await page.evaluate(() => window.__CHINA_TOWERS_CAMERA__?.position.toArray());
      await page.mouse.move(box.x + box.width * 0.5, box.y + box.height * 0.5);
      await page.mouse.down();
      await page.mouse.move(box.x + box.width * 0.68, box.y + box.height * 0.5, { steps: 8 });
      await page.mouse.up();
      await page.waitForTimeout(120);
      const cameraAfterOrbit = await page.evaluate(() => window.__CHINA_TOWERS_CAMERA__?.position.toArray());
      const orbitDistance = cameraBeforeOrbit && cameraAfterOrbit
        ? Math.hypot(...cameraBeforeOrbit.map((value, index) => value - cameraAfterOrbit[index]))
        : 0;
      if (orbitDistance < 0.05) throw new Error(`Orbit drag did not move camera: ${id}`);
      await page.click('#low-angle');
      await page.waitForTimeout(120);
      await canvas.screenshot({ path: path.join(evidenceRoot, `${id}-low-angle.png`) });
      await page.click('#low-angle');
      const pickPoints = [[0.52, 0.54], [0.60, 0.54], [0.48, 0.62], [0.62, 0.64]];
      for (const [x, y] of pickPoints) {
        await canvas.click({ position: { x: box.width * x, y: box.height * y } });
        const selected = await page.evaluate(() => window.__CHINA_TOWERS_DIAGNOSTICS__?.selectedPart);
        if (selected) break;
      }
      await page.waitForFunction(() => Boolean(window.__CHINA_TOWERS_DIAGNOSTICS__?.selectedPart), null, { timeout: 5000 });
      const selectedPart = await page.evaluate(() => window.__CHINA_TOWERS_DIAGNOSTICS__?.selectedPart);
      await page.click('#explode');
      await page.waitForFunction(() => (window.__CHINA_TOWERS_DIAGNOSTICS__?.explodedAmount ?? 0) > 0.98, null, { timeout: 5000 });
      await canvas.screenshot({ path: path.join(evidenceRoot, `${id}-exploded.png`) });
      await page.click('#reset-view');
      await page.waitForFunction(() => (window.__CHINA_TOWERS_DIAGNOSTICS__?.explodedAmount ?? 1) < 0.001 && window.__CHINA_TOWERS_DIAGNOSTICS__?.selectedPart === null, null, { timeout: 5000 });
      const diagnostics = await page.evaluate(() => window.__CHINA_TOWERS_DIAGNOSTICS__);
      const parts = await page.evaluate(() => window.__CHINA_TOWERS_PARTS__ ?? []);
      await page.locator('#scene').screenshot({ path: path.join(evidenceRoot, `${id}.png`) });
      page.off('request', listener);
      results.push({ id, requestedLod: lod, diagnostics, parts, selectedPart, orbitDistance, interaction: 'orbit-low-angle-pick-explode-reset-passed', glbRequests: [...new Set(glbRequests)] });
    }

    await page.goto('http://127.0.0.1:4174/?review=1&pavilion=yueyang', { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => window.__CHINA_TOWERS_READY__ === true && window.__CHINA_TOWERS_DIAGNOSTICS__?.activeId === 'yueyang', null, { timeout: 60000 });
    const navigationIds = await page.locator('[data-pavilion]').evaluateAll((elements) => elements.map((element) => element.getAttribute('data-pavilion')));
    const expectedNavigationIds = ['yueyang', 'huanghe', 'tengwang'];
    if (JSON.stringify(navigationIds) !== JSON.stringify(expectedNavigationIds)) {
      throw new Error(`Product navigation scope failed: ${JSON.stringify(navigationIds)}`);
    }
    await page.goto('http://127.0.0.1:4174/?review=1&pavilion=feiyun', { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => window.__CHINA_TOWERS_READY__ === true && window.__CHINA_TOWERS_DIAGNOSTICS__?.activeId === 'yueyang', null, { timeout: 60000 });
    const legacyFeiyunRoute = await page.evaluate(() => window.__CHINA_TOWERS_DIAGNOSTICS__?.activeId);
    await page.goto('http://127.0.0.1:4174/?review=1&pavilion=penglai', { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => window.__CHINA_TOWERS_READY__ === true && window.__CHINA_TOWERS_DIAGNOSTICS__?.activeId === 'yueyang', null, { timeout: 60000 });
    const legacyPenglaiRoute = await page.evaluate(() => window.__CHINA_TOWERS_DIAGNOSTICS__?.activeId);
    if (legacyFeiyunRoute !== 'yueyang' || legacyPenglaiRoute !== 'yueyang') {
      throw new Error(`Legacy route fallback failed: feiyun=${legacyFeiyunRoute}, penglai=${legacyPenglaiRoute}`);
    }
    await page.goto('http://127.0.0.1:4174/?review=1&pavilion=yueyang', { waitUntil: 'domcontentloaded' });
    await page.click('[data-pavilion="huanghe"]');
    await page.waitForTimeout(25);
    await page.click('[data-pavilion="tengwang"]');
    await page.waitForFunction(() => window.__CHINA_TOWERS_READY__ === true && window.__CHINA_TOWERS_DIAGNOSTICS__?.activeId === 'tengwang', null, { timeout: 60000 });
    const rapidSwitch = await page.evaluate(() => window.__CHINA_TOWERS_DIAGNOSTICS__);
    if (rapidSwitch.activeId !== 'tengwang' || rapidSwitch.loadError) throw new Error(`Rapid-switch race failed: ${JSON.stringify(rapidSwitch)}`);
    await page.evaluate(() => {
      const panel = document.querySelector('#poetry-panel');
      const toggle = document.querySelector('#content-toggle');
      if (panel && !panel.classList.contains('is-open')) toggle?.click();
      document.querySelector('[data-content-view="building"]')?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    await page.waitForFunction(() => document.querySelector('#poetry-panel-kicker')?.textContent === '建筑现场', null, { timeout: 5000 });
    await page.evaluate(() => document.querySelector('[data-content-view="parts"]')?.dispatchEvent(new MouseEvent('click', { bubbles: true })));
    await page.waitForFunction(() => document.querySelector('#poetry-panel-kicker')?.textContent === '构件可读', null, { timeout: 5000 });

    const mobilePage = await browser.newPage({ viewport: { width: 390, height: 844 } });
    mobilePage.on('pageerror', (error) => errors.push(`mobile: ${error.message}`));
    mobilePage.on('console', (message) => {
      if (message.type() === 'error' && !message.text().includes('404 (Not Found)')) errors.push(`mobile: ${message.text()}`);
    });
    await mobilePage.goto('http://127.0.0.1:4174/?quality=mobile&pavilion=yueyang', { waitUntil: 'domcontentloaded', timeout: 30000 });
    await mobilePage.waitForFunction(() => window.__CHINA_TOWERS_READY__ === true && window.__CHINA_TOWERS_DIAGNOSTICS__?.activeId === 'yueyang', null, { timeout: 60000 });
    const mobileNavigation = await mobilePage.locator('[data-pavilion]').evaluateAll((elements) => elements.map((element) => ({ id: element.getAttribute('data-pavilion'), box: element.getBoundingClientRect().toJSON() })));
    const mobilePanel = await mobilePage.locator('#poetry-panel').boundingBox();
    if (!mobilePanel || mobileNavigation.some(({ box }) => box.top < 0 || box.bottom > 844 || box.right > 390)) {
      throw new Error(`Mobile layout bounds failed: ${JSON.stringify({ mobileNavigation, mobilePanel })}`);
    }
    await mobilePage.click('[data-pavilion="huanghe"]');
    await mobilePage.waitForFunction(() => window.__CHINA_TOWERS_READY__ === true && window.__CHINA_TOWERS_DIAGNOSTICS__?.activeId === 'huanghe', null, { timeout: 60000 });
    await mobilePage.close();

    for (const result of results) {
      if (result.diagnostics?.activeId !== result.id || !result.diagnostics.ready || result.diagnostics.loadError) {
        throw new Error(`Runtime smoke failed: ${JSON.stringify(result)}`);
      }
      if (!result.selectedPart || result.diagnostics.partCount < 1 || result.diagnostics.explodedAmount >= 0.001) {
        throw new Error(`Assembly interaction smoke failed: ${JSON.stringify(result)}`);
      }
    }
    if (errors.length) throw new Error(errors.join('\n'));
    const report = { schemaVersion: 2, generatedAt: new Date().toISOString(), results, rapidSwitch, status: 'passed' };
    fs.writeFileSync(path.join(workspace, 'evidence', '3d-assets', 'runtime-loading-smoke.json'), `${JSON.stringify(report, null, 2)}\n`);
    const partsReport = {
      schemaVersion: 1,
      generatedAt: report.generatedAt,
      assets: results.map(({ id, requestedLod, diagnostics, parts, selectedPart, orbitDistance, interaction }) => ({
        id,
        requestedLod,
        partCount: diagnostics.partCount,
        parts,
        selectedPart,
        resetExplodedAmount: diagnostics.explodedAmount,
        interaction,
        orbitDistance,
        granularity: 'retained-source-meshes',
        limitation: null,
      })),
      status: 'passed',
    };
    fs.writeFileSync(path.join(workspace, 'evidence', '3d-assets', 'runtime-parts.json'), `${JSON.stringify(partsReport, null, 2)}\n`);
    console.log(`Runtime smoke passed: ${results.length} direct loads + pick/explode/reset + rapid-switch cancellation.`);
  } finally {
    await browser.close();
    await new Promise((resolve) => server.close(resolve));
  }
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
