const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { chromium } = require('C:/Users/admin/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright');

const workspace = path.resolve(__dirname, '..');
const distRoot = path.join(workspace, 'dist');
const evidenceRoot = path.join(workspace, 'evidence', '3d-assets', 'runtime-quality');
const browserExecutable = 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';
const contentTypes = { '.css': 'text/css', '.html': 'text/html', '.js': 'text/javascript', '.json': 'application/json', '.glb': 'model/gltf-binary' };
const expectations = {
  // 真值见 DeviceQualityProfile.ts（曾与代码漂移：hero 2048/radius 5、
  // standard 1536/radius 3 是过期数，smoke 照着旧数必失败）。
  hero: { runtimeLod: 'lod0', pixelRatioCap: 1.75, shadowMapSize: 4096, shadowTechnique: 'pcf-soft', shadowRadius: 3.5, shadowBlurSamples: 16, toneMappingExposure: 1.05, environmentIntensity: 1.12 },
  standard: { runtimeLod: 'lod1', pixelRatioCap: 1.35, shadowMapSize: 2048, shadowTechnique: 'pcf-soft', shadowRadius: 2.5, shadowBlurSamples: 8, toneMappingExposure: 1.02, environmentIntensity: 1 },
  mobile: { runtimeLod: 'lod2', pixelRatioCap: 1, shadowMapSize: 768, shadowTechnique: 'pcf', shadowRadius: 1, shadowBlurSamples: 4, toneMappingExposure: 0.98, environmentIntensity: 0.9 },
};

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

function assertProfile(profile, diagnostics) {
  const expected = expectations[profile];
  for (const [field, value] of Object.entries(expected)) {
    if (diagnostics?.[field] !== value) throw new Error(`${profile} ${field}: expected ${value}, got ${diagnostics?.[field]}`);
  }
  if (diagnostics?.qualityProfile !== profile || diagnostics?.lightMode !== 'reference' || diagnostics?.loadError || !diagnostics?.ready) {
    throw new Error(`Invalid ${profile} diagnostics: ${JSON.stringify(diagnostics)}`);
  }
  if (diagnostics.appliedPixelRatio > diagnostics.pixelRatioCap) {
    throw new Error(`${profile} pixel ratio cap exceeded: ${diagnostics.appliedPixelRatio} > ${diagnostics.pixelRatioCap}`);
  }
  // 自适应档位必须上报（探针机上保持 0；慢机上报 >0 才是 governor 活着的证据）。
  if (typeof diagnostics?.adaptiveLevel !== 'number') {
    throw new Error(`${profile} adaptiveLevel missing from diagnostics`);
  }
}

async function main() {
  fs.mkdirSync(evidenceRoot, { recursive: true });
  const server = http.createServer(serve);
  await new Promise((resolve) => server.listen(4175, '127.0.0.1', resolve));
  const browser = await chromium.launch({ headless: true, executablePath: browserExecutable, args: ['--ignore-gpu-blocklist'] });
  const errors = [];
  try {
    const page = await browser.newPage({ viewport: { width: 1280, height: 720 }, deviceScaleFactor: 2 });
    page.on('pageerror', (error) => errors.push(error.message));
    page.on('console', (message) => { if (message.type() === 'error' && !message.text().includes('404')) errors.push(message.text()); });
    const results = [];
    for (const profile of Object.keys(expectations)) {
      await page.goto(`http://127.0.0.1:4175/?pavilion=yueyang&quality=${profile}&view=three-quarter`, { waitUntil: 'domcontentloaded', timeout: 30000 });
      await page.waitForFunction(() => window.__CHINA_TOWERS_READY__ === true && window.__CHINA_TOWERS_DIAGNOSTICS__?.ready === true, null, { timeout: 60000 });
      await page.waitForTimeout(300);
      const diagnostics = await page.evaluate(() => window.__CHINA_TOWERS_DIAGNOSTICS__);
      assertProfile(profile, diagnostics);
      await page.locator('#scene').screenshot({ path: path.join(evidenceRoot, `${profile}-yueyang.png`) });
      results.push({ profile, diagnostics });
    }
    if (errors.length) throw new Error(errors.join('\n'));
    fs.writeFileSync(path.join(evidenceRoot, 'quality-tier-smoke.json'), `${JSON.stringify({ schemaVersion: 1, generatedAt: new Date().toISOString(), results, status: 'passed' }, null, 2)}\n`);
    console.log(`Quality tier smoke passed: ${results.length} profiles.`);
  } finally {
    await browser.close();
    await new Promise((resolve) => server.close(resolve));
  }
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
