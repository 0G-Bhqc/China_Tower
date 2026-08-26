const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { chromium } = require('C:/Users/admin/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright');

const projectRoot = path.resolve(__dirname, '..');
const distRoot = path.join(projectRoot, 'dist');
const requestedPass = process.argv[2];
const passId = typeof requestedPass === 'string' && /^[a-z0-9-]+$/i.test(requestedPass)
  ? requestedPass
  : 'form-refinement';
const requestedPavilion = typeof process.argv[3] === 'string' && /^[a-z0-9-]+$/i.test(process.argv[3])
  ? process.argv[3]
  : 'yueyang';
const requestedLod = typeof process.argv[4] === 'string' && /^lod[0-2]$/i.test(process.argv[4])
  ? process.argv[4].toLowerCase()
  : null;
const lodQuery = requestedLod ? `&lod=${encodeURIComponent(requestedLod)}` : '';
const outDir = path.join(projectRoot, 'evidence', requestedPavilion, 'renders', passId);
const browserExecutable = 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';
const views = ['front', 'three-quarter', 'right', 'rear', 'left', 'elevated'];
const contentTypes = {
  '.css': 'text/css; charset=utf-8',
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
};

function serve(request, response) {
  const requestPath = new URL(request.url, 'http://127.0.0.1').pathname;
  const relativePath = requestPath === '/' ? 'index.html' : requestPath.replace(/^\/+/, '');
  const filePath = path.resolve(distRoot, relativePath);
  if (!filePath.startsWith(distRoot + path.sep) && filePath !== path.join(distRoot, 'index.html')) {
    response.writeHead(403).end('Forbidden');
    return;
  }
  fs.readFile(filePath, (error, data) => {
    if (error) {
      response.writeHead(404).end('Not found');
      return;
    }
    response.writeHead(200, {
      'Cache-Control': 'no-store',
      'Content-Type': contentTypes[path.extname(filePath)] || 'application/octet-stream',
    });
    response.end(data);
  });
}

async function main() {
  fs.mkdirSync(outDir, { recursive: true });
  const server = http.createServer(serve);
  await new Promise((resolve) => server.listen(4173, '127.0.0.1', resolve));
  console.log('review server: http://127.0.0.1:4173');

  console.log('launching bundled Chromium');
  const browser = await chromium.launch({
    headless: true,
    executablePath: browserExecutable,
    timeout: 20000,
    args: ['--ignore-gpu-blocklist'],
  });
  console.log('Chromium launched');

  const failures = [];
  try {
    const page = await browser.newPage({ viewport: { width: 1600, height: 900 }, deviceScaleFactor: 1 });
    page.on('console', (message) => {
      if (message.type() === 'error' && !message.text().includes('404')) failures.push(`console: ${message.text()}`);
    });
    page.on('pageerror', (error) => failures.push(`page: ${error.message}`));

    for (const view of views) {
      const url = `http://127.0.0.1:4173/?review=1&pass=${encodeURIComponent(passId)}&pavilion=${encodeURIComponent(requestedPavilion)}&view=${encodeURIComponent(view)}${lodQuery}`;
      console.log(`loading ${view}`);
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
      await page.waitForFunction(() => window.__CHINA_TOWERS_READY__ === true, null, { timeout: 30000 });
      await page.waitForTimeout(500);
      const output = path.join(outDir, `${view}.png`);
      await page.locator('#scene').screenshot({ path: output });
      const webgl = await page.locator('#scene').evaluate((canvas) => Boolean(canvas.getContext('webgl2') || canvas.getContext('webgl')));
      console.log(`${view}: ${output} webgl=${webgl}`);
    }

    // Lighting is reviewed separately from silhouette: neutral confirms palette and
    // material values, while grazing reveals missing relief or implausible gloss.
    for (const light of ['neutral', 'grazing']) {
      console.log(`loading three-quarter-${light}`);
      await page.goto(`http://127.0.0.1:4173/?review=1&pass=${encodeURIComponent(passId)}&pavilion=${encodeURIComponent(requestedPavilion)}&view=three-quarter&light=${light}${lodQuery}`, { waitUntil: 'domcontentloaded', timeout: 30000 });
      await page.waitForFunction(() => window.__CHINA_TOWERS_READY__ === true, null, { timeout: 30000 });
      await page.waitForTimeout(500);
      const output = path.join(outDir, `three-quarter-${light}.png`);
      await page.locator('#scene').screenshot({ path: output });
      console.log(`three-quarter-${light}: ${output}`);
    }

    console.log('loading map-stripped');
    await page.goto(`http://127.0.0.1:4173/?review=1&maps=0&pass=${encodeURIComponent(passId)}&pavilion=${encodeURIComponent(requestedPavilion)}&view=three-quarter${lodQuery}`, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await page.waitForFunction(() => window.__CHINA_TOWERS_READY__ === true, null, { timeout: 30000 });
    await page.waitForTimeout(500);
    const strippedOutput = path.join(outDir, 'three-quarter-map-stripped.png');
    await page.locator('#scene').screenshot({ path: strippedOutput });
    console.log(`map-stripped: ${strippedOutput}`);

    for (const view of ['front', 'right', 'rear', 'left']) {
      console.log(`loading silhouette-${view}`);
      await page.goto(`http://127.0.0.1:4173/?review=1&silhouette=1&pass=${encodeURIComponent(passId)}&pavilion=${encodeURIComponent(requestedPavilion)}&view=${view}${lodQuery}`, { waitUntil: 'domcontentloaded', timeout: 30000 });
      await page.waitForFunction(() => window.__CHINA_TOWERS_READY__ === true, null, { timeout: 30000 });
      await page.waitForTimeout(300);
      const silhouetteOutput = path.join(outDir, `silhouette-${view}.png`);
      await page.locator('#scene').screenshot({ path: silhouetteOutput });
      console.log(`silhouette-${view}: ${silhouetteOutput}`);
    }
  } finally {
    await browser.close();
    await new Promise((resolve) => server.close(resolve));
  }

  if (failures.length) {
    throw new Error(failures.join('\n'));
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
