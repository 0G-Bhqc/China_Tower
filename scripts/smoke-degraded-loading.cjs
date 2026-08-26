const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { chromium } = require('C:/Users/admin/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright');

const workspace = path.resolve(__dirname, '..');
const distRoot = path.join(workspace, 'dist');
const evidenceRoot = path.join(workspace, 'evidence', '3d-assets', 'runtime-degraded');
const browserExecutable = 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';
const contentTypes = { '.css': 'text/css', '.html': 'text/html', '.js': 'text/javascript', '.json': 'application/json', '.glb': 'model/gltf-binary' };

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

async function main() {
  fs.mkdirSync(evidenceRoot, { recursive: true });
  const server = http.createServer(serve);
  await new Promise((resolve) => server.listen(4176, '127.0.0.1', resolve));
  const browser = await chromium.launch({ headless: true, executablePath: browserExecutable, args: ['--ignore-gpu-blocklist'] });
  try {
    const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
    await page.route('**/assets/yueyang-architectural-lod.glb', (route) => route.fulfill({ status: 503, contentType: 'text/plain', body: 'intentional test failure' }));
    await page.goto('http://127.0.0.1:4176/?review=1&pavilion=yueyang&lod=lod0', { waitUntil: 'domcontentloaded', timeout: 30000 });
    await page.waitForFunction(() => window.__CHINA_TOWERS_READY__ === true && window.__CHINA_TOWERS_DIAGNOSTICS__?.assetState === 'degraded', null, { timeout: 30000 });
    const diagnostics = await page.evaluate(() => window.__CHINA_TOWERS_DIAGNOSTICS__);
    if (!diagnostics?.ready || !diagnostics.loadError || !diagnostics.degraded || diagnostics.failureReason !== 'asset-fetch-or-parse-failed') {
      throw new Error(`Degraded runtime contract failed: ${JSON.stringify(diagnostics)}`);
    }
    const status = await page.locator('#status').textContent();
    if (status !== 'DEGRADED VIEW · HIGH MODEL ASSET UNAVAILABLE') throw new Error(`Missing user-facing degraded status: ${status}`);
    await page.locator('#scene').screenshot({ path: path.join(evidenceRoot, 'yueyang-asset-503.png') });
    fs.writeFileSync(path.join(evidenceRoot, 'degraded-loading-smoke.json'), `${JSON.stringify({ schemaVersion: 1, generatedAt: new Date().toISOString(), diagnostics, status, statusResult: 'passed' }, null, 2)}\n`);
    console.log('Degraded loading smoke passed: intentional GLB 503 reaches a visible fallback and diagnostics.');
  } finally {
    await browser.close();
    await new Promise((resolve) => server.close(resolve));
  }
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
