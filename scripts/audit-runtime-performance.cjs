const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { chromium } = require('C:/Users/admin/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright');

const workspace = path.resolve(__dirname, '..');
const distRoot = path.join(workspace, 'dist');
const evidenceRoot = path.join(workspace, 'evidence', '3d-assets', 'runtime-performance');
const browserExecutable = 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';
const contentTypes = { '.css': 'text/css', '.html': 'text/html', '.js': 'text/javascript', '.json': 'application/json', '.glb': 'model/gltf-binary' };
const highModels = ['yueyang', 'huanghe', 'tengwang'];

function serve(request, response) {
  const pathname = new URL(request.url, 'http://127.0.0.1').pathname;
  const relative = pathname === '/' ? 'index.html' : pathname.replace(/^\/+/, '');
  const file = path.resolve(distRoot, relative);
  if (!file.startsWith(distRoot + path.sep) && file !== path.join(distRoot, 'index.html')) return response.writeHead(403).end();
  fs.readFile(file, (error, data) => {
    if (error) return response.writeHead(404).end();
    response.writeHead(200, { 'Content-Type': contentTypes[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-store' });
    response.end(data);
  });
}

async function readReadyDiagnostics(page, url) {
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
  await page.waitForFunction(() => window.__CHINA_TOWERS_READY__ === true && window.__CHINA_TOWERS_DIAGNOSTICS__?.ready === true, null, { timeout: 60000 });
  await page.waitForTimeout(300);
  const diagnostics = await page.evaluate(() => window.__CHINA_TOWERS_DIAGNOSTICS__);
  if (!diagnostics?.ready || diagnostics.loadError || diagnostics.renderCalls < 1 || diagnostics.renderTriangles < 1) {
    throw new Error(`Render metrics missing: ${JSON.stringify(diagnostics)}`);
  }
  return diagnostics;
}

async function main() {
  fs.mkdirSync(evidenceRoot, { recursive: true });
  const server = http.createServer(serve);
  await new Promise((resolve) => server.listen(4177, '127.0.0.1', resolve));
  const browser = await chromium.launch({ headless: true, executablePath: browserExecutable, args: ['--ignore-gpu-blocklist'] });
  const errors = [];
  try {
    const page = await browser.newPage({ viewport: { width: 1280, height: 720 }, deviceScaleFactor: 2 });
    page.on('pageerror', (error) => errors.push(error.message));
    page.on('console', (message) => { if (message.type() === 'error' && !message.text().includes('404')) errors.push(message.text()); });
    const tiers = [];
    for (const profile of ['hero', 'standard', 'mobile']) {
      const diagnostics = await readReadyDiagnostics(page, `http://127.0.0.1:4177/?pavilion=yueyang&quality=${profile}&view=three-quarter`);
      tiers.push({ profile, diagnostics });
    }
    if (!(tiers[0].diagnostics.renderTriangles >= tiers[1].diagnostics.renderTriangles && tiers[1].diagnostics.renderTriangles >= tiers[2].diagnostics.renderTriangles)) {
      throw new Error(`Yueyang LOD triangle ordering failed: ${JSON.stringify(tiers)}`);
    }
    const standardAssets = [];
    for (const id of highModels) {
      const diagnostics = await readReadyDiagnostics(page, `http://127.0.0.1:4177/?pavilion=${id}&quality=standard&view=three-quarter`);
      if (diagnostics.qualityProfile !== 'standard' || diagnostics.runtimeLod !== 'lod1') throw new Error(`Unexpected standard profile: ${JSON.stringify(diagnostics)}`);
      standardAssets.push({ id, renderCalls: diagnostics.renderCalls, renderTriangles: diagnostics.renderTriangles, partCount: diagnostics.partCount });
    }
    await page.goto('http://127.0.0.1:4177/?pavilion=yueyang&quality=standard', { waitUntil: 'domcontentloaded', timeout: 30000 });
    await page.waitForFunction(() => window.__CHINA_TOWERS_READY__ === true, null, { timeout: 60000 });
    const accessibility = await page.evaluate(() => ({
      canvas: { tabindex: document.querySelector('#scene')?.getAttribute('tabindex'), label: document.querySelector('#scene')?.getAttribute('aria-label') },
      status: { role: document.querySelector('#status')?.getAttribute('role'), live: document.querySelector('#status')?.getAttribute('aria-live') },
      explode: { pressed: document.querySelector('#explode')?.getAttribute('aria-pressed'), shortcuts: document.querySelector('#explode')?.getAttribute('aria-keyshortcuts') },
      activeCards: [...document.querySelectorAll('[data-pavilion][aria-pressed="true"]')].length,
    }));
    if (accessibility.canvas.tabindex !== '0' || !accessibility.canvas.label || accessibility.status.role !== 'status' || accessibility.status.live !== 'polite' || accessibility.explode.pressed !== 'false' || accessibility.explode.shortcuts !== 'E' || accessibility.activeCards !== 1) {
      throw new Error(`Accessibility contract failed: ${JSON.stringify(accessibility)}`);
    }
    if (errors.length) throw new Error(errors.join('\n'));
    const report = { schemaVersion: 1, generatedAt: new Date().toISOString(), tiers, standardAssets, accessibility, status: 'passed', note: 'Static renderer metrics are a reproducible budget signal, not a cross-device FPS certification.' };
    fs.writeFileSync(path.join(evidenceRoot, 'performance-audit.json'), `${JSON.stringify(report, null, 2)}\n`);
    console.log(`Runtime performance audit passed: 3 quality tiers, ${standardAssets.length} finished high models, accessibility semantics.`);
  } finally {
    await browser.close();
    await new Promise((resolve) => server.close(resolve));
  }
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
