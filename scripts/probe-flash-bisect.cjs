// CDP-based black-flash probe: Page.captureScreenshot reads the COMPOSITED
// frame — exactly what the user sees — unlike drawImage sampling which races
// the WebGL default framebuffer. Serial-ish capture loop, luma per frame,
// stop-start drag throughout. Yields frames per second ~5-15, enough to
// catch a flash that lasts >100ms; for shorter flashes we also count
// "dip frames" relative to the rolling median.
const { chromium } = require('../node_modules/playwright');
const fs = require('fs');
const zlib = require('zlib');

function pngLuma(buf) {
  // minimal PNG decode (RGB/RGBA 8-bit) — reuse logic
  let offset = 8, width = 0, height = 0, colorType = 0;
  const idat = [];
  while (offset < buf.length) {
    const length = buf.readUInt32BE(offset);
    const type = buf.toString('ascii', offset + 4, offset + 8);
    const data = buf.subarray(offset + 8, offset + 8 + length);
    if (type === 'IHDR') { width = data.readUInt32BE(0); height = data.readUInt32BE(4); colorType = data[9]; }
    else if (type === 'IDAT') idat.push(data);
    offset += 12 + length;
  }
  const channels = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 }[colorType];
  const stride = width * channels;
  const raw = zlib.inflateSync(Buffer.concat(idat));
  const out = Buffer.alloc(height * stride);
  for (let y = 0; y < height; y += 1) {
    const filter = raw[y * (stride + 1)];
    const line = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1));
    const prev = y > 0 ? out.subarray((y - 1) * stride, y * stride) : null;
    const cur = out.subarray(y * stride, (y + 1) * stride);
    for (let x = 0; x < stride; x += 1) {
      const a = x >= channels ? cur[x - channels] : 0;
      const b = prev ? prev[x] : 0;
      const c = prev && x >= channels ? prev[x - channels] : 0;
      let v = line[x];
      if (filter === 1) v += a; else if (filter === 2) v += b;
      else if (filter === 3) v += (a + b) >> 1;
      else if (filter === 4) { const p = a + b - c, pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c); v += pa <= pb && pa <= pc ? a : pb <= pc ? b : c; }
      cur[x] = v & 0xff;
    }
  }
  // downsample: every 8th pixel in both axes
  let sum = 0, n = 0;
  const skyRows = Math.round(height * 0.3);
  let skySum = 0, skyN = 0, waterSum = 0, waterN = 0;
  for (let y = 0; y < height; y += 8) {
    for (let x = 0; x < width; x += 8) {
      const i = (y * width + x) * channels;
      const l = (0.2126 * out[i] + 0.7152 * out[i + 1] + 0.0722 * out[i + 2]) / 255;
      sum += l; n++;
      if (y < skyRows) { skySum += l; skyN++; } else { waterSum += l; waterN++; }
    }
  }
  return { all: sum / n, sky: skySum / skyN, water: waterSum / waterN };
}

function median(arr) { const s = [...arr].sort((a, b) => a - b); return s[Math.floor(s.length / 2)]; }

(async () => {
  const pavilion = process.env.PAVILION || 'yueyang';
  const extra = process.env.EXTRA || '';
  const configs = [
    ['baseline', `?pavilion=${pavilion}&quality=standard${extra}`],
    ['nobloom', `?pavilion=${pavilion}&quality=standard${extra}&nobloom=1`],
    ['norays', `?pavilion=${pavilion}&quality=standard${extra}&norays=1`],
  ];
  const browser = await chromium.launch({ headless: true, executablePath: 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe', args: ['--ignore-gpu-blocklist'] });
  const results = [];
  for (const [label, query] of configs) {
    const page = await browser.newPage({ viewport: { width: 1000, height: 800 } });
    await page.goto(`http://127.0.0.1:5173/${query}`, { waitUntil: 'domcontentloaded', timeout: 60000 });
    await page.waitForFunction(() => window.__CHINA_TOWERS_READY__ === true, null, { timeout: 120000 });
    await page.waitForTimeout(1200);
    const cdp = await page.context().newCDPSession(page);
    const history = [];
    let stop = false;
    (async () => {
      while (!stop) {
        try {
          const shot = await cdp.send('Page.captureScreenshot', { format: 'png', everyNthFrame: 1 });
          history.push({ t: Date.now(), ...pngLuma(Buffer.from(shot.data, 'base64')) });
        } catch { /* session closed */ }
        if (stop) break;
      }
    })();
    const box = await page.locator('#scene').boundingBox();
    const cx = box.x + box.width / 2, cy = box.y + box.height / 2;
    for (let i = 0; i < 7; i++) {
      await page.mouse.move(cx - 120, cy);
      await page.mouse.down();
      for (let s = 1; s <= 8; s++) await page.mouse.move(cx - 120 + s * 30, cy, { steps: 2 });
      await page.mouse.up();
      await page.waitForTimeout(450);
      await page.mouse.move(cx + 120, cy + 40);
      await page.mouse.down();
      for (let s = 1; s <= 8; s++) await page.mouse.move(cx + 120 - s * 30, cy + 40 - s * 5, { steps: 2 });
      await page.mouse.up();
      await page.waitForTimeout(450);
    }
    await page.waitForTimeout(500);
    stop = true;
    await page.waitForTimeout(300);
    // analyze
    const frames = history.filter((f) => f.t > 0);
    const lumas = frames.map((f) => f.all);
    const dips = [];
    for (let i = 4; i < frames.length - 2; i++) {
      const win = frames.slice(Math.max(0, i - 5), i + 6).map((f) => f.all);
      const med = median(win);
      if (med > 0.05 && frames[i].all < med * 0.55) dips.push({ idx: i, all: frames[i].all, med, sky: frames[i].sky, water: frames[i].water });
    }
    const summary = {
      label,
      frames: frames.length,
      fps: frames.length > 1 ? Number((frames.length / ((frames[frames.length - 1].t - frames[0].t) / 1000)).toFixed(1)) : 0,
      dipCount: dips.length,
      deepest: dips.length ? (Math.max(...dips.map((d) => (1 - d.all / d.med) * 100))).toFixed(0) + '%' : 'n/a',
      region: dips.length ? (dips[0].sky < dips[0].water ? 'sky-leading' : 'water-leading') : 'n/a',
      lumaMin: Number(Math.min(...lumas)).toFixed(3),
      lumaMedian: Number(median(lumas)).toFixed(3),
    };
    console.log(JSON.stringify(summary));
    if (dips.length) fs.writeFileSync(`evidence/cdp-dips-${pavilion}-${label}.json`, JSON.stringify(dips, null, 2));
    await page.close();
  }
  await browser.close();
  console.log('done');
})();
