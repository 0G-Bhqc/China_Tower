// Ground-truth probe: in-page canvas luma sampling AND CDP screencast in the
// SAME session. If composited frames dip while the in-page canvas never does,
// the "black flash" is a screencast/compositor artifact (undamaged-region
// padding), not rendered content — and vice versa.
const { chromium } = require('../node_modules/playwright');
const fs = require('fs');
const zlib = require('zlib');

function pngLuma(buf) {
  let o = 8, w = 0, h = 0, ct = 0; const idat = [];
  while (o < buf.length) {
    const len = buf.readUInt32BE(o), type = buf.toString('ascii', o + 4, o + 8);
    const d = buf.subarray(o + 8, o + 8 + len);
    if (type === 'IHDR') { w = d.readUInt32BE(0); h = d.readUInt32BE(4); ct = d[9]; }
    else if (type === 'IDAT') idat.push(d);
    o += 12 + len;
  }
  const ch = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 }[ct];
  const stride = w * ch;
  const raw = zlib.inflateSync(Buffer.concat(idat));
  const out = Buffer.alloc(h * stride);
  for (let y = 0; y < h; y += 1) {
    const f = raw[y * (stride + 1)];
    const line = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1));
    const prev = y > 0 ? out.subarray((y - 1) * stride, y * stride) : null;
    const cur = out.subarray(y * stride, (y + 1) * stride);
    for (let x = 0; x < stride; x += 1) {
      const a = x >= ch ? cur[x - ch] : 0, b = prev ? prev[x] : 0, c = prev && x >= ch ? prev[x - ch] : 0;
      let v = line[x];
      if (f === 1) v += a; else if (f === 2) v += b; else if (f === 3) v += (a + b) >> 1;
      else if (f === 4) { const p = a + b - c, pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c); v += pa <= pb && pa <= pc ? a : pb <= pc ? b : c; }
      cur[x] = v & 0xff;
    }
  }
  let s = 0, n = 0;
  for (let y = 0; y < h; y += 8) for (let x = 0; x < w; x += 8) {
    const i = (y * w + x) * ch;
    s += (0.2126 * out[i] + 0.7152 * out[i + 1] + 0.0722 * out[i + 2]) / 255; n++;
  }
  return s / n;
}
function median(a) { const s = [...a].sort((x, y) => x - y); return s[Math.floor(s.length / 2)]; }

function findDips(values, timeStamps) {
  const dips = [];
  for (let i = 4; i < values.length - 2; i++) {
    const win = values.slice(Math.max(0, i - 5), i + 6);
    const med = median(win);
    if (med > 0.05 && values[i] < med * 0.55) dips.push({ idx: i, t: timeStamps[i], luma: values[i], med });
  }
  return dips;
}

const SAMPLER = `
  (function () {
    const canvas = document.querySelector('body > canvas');
    const small = document.createElement('canvas');
    small.width = 64; small.height = 36;
    const ctx = small.getContext('2d', { willReadFrequently: true });
    window.__SAMPLER_HISTORY__ = [];
    function sample() {
      try {
        ctx.drawImage(canvas, 0, 0, 64, 36);
        const d = ctx.getImageData(0, 0, 64, 36).data;
        let all = 0;
        for (let i = 0; i < d.length; i += 4) all += (0.2126 * d[i] + 0.7152 * d[i + 1] + 0.0722 * d[i + 2]) / 255;
        window.__SAMPLER_HISTORY__.push({ t: performance.now(), all: all / (64 * 36) });
      } catch (e) {}
      requestAnimationFrame(sample);
    }
    requestAnimationFrame(sample);
  })()
`;

(async () => {
  const pavilion = process.env.PAVILION || 'tengwang';
  const extra = process.env.EXTRA || '';
  const browser = await chromium.launch({ headless: true, executablePath: 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe', args: ['--ignore-gpu-blocklist'] });
  const page = await browser.newPage({ viewport: { width: 1000, height: 800 } });
  await page.goto(`http://127.0.0.1:5173/?pavilion=${pavilion}&quality=standard${extra}`, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await page.waitForFunction(() => window.__CHINA_TOWERS_READY__ === true, null, { timeout: 120000 });
  await page.waitForTimeout(1200);
  const timeOrigin = await page.evaluate(() => performance.timeOrigin);
  await page.evaluate(SAMPLER);

  const cdp = await page.context().newCDPSession(page);
  const frames = [];
  cdp.on('Page.screencastFrame', async (ev) => {
    frames.push({ ts: Date.now(), buf: Buffer.from(ev.data, 'base64') });
    try { await cdp.send('Page.screencastFrameAck', { sessionId: ev.sessionId }); } catch {}
  });
  await cdp.send('Page.startScreencast', { format: 'png', everyNthFrame: 1 });

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
  await page.waitForTimeout(600);
  await cdp.send('Page.stopScreencast');
  const inPage = await page.evaluate(() => { const h = window.__SAMPLER_HISTORY__; window.__SAMPLER_HISTORY__ = []; return h || []; });

  const cdpLumas = frames.map((f) => pngLuma(f.buf));
  const cdpTimes = frames.map((f) => f.ts - timeOrigin);
  const cdpDips = findDips(cdpLumas, cdpTimes);
  const pageLumas = inPage.map((s) => s.all);
  const pageTimes = inPage.map((s) => s.t);
  const pageDips = findDips(pageLumas, pageTimes);

  console.log(`pavilion=${pavilion}${extra} cdpFrames=${frames.length} cdpDips=${cdpDips.length} | pageFrames=${inPage.length} pageDips=${pageDips.length}`);
  for (const d of cdpDips.slice(0, 6)) console.log(`  CDP dip idx=${d.idx} luma=${d.luma.toFixed(3)} med=${d.med.toFixed(3)} @perf ${d.t.toFixed(0)}`);
  for (const d of pageDips.slice(0, 6)) console.log(`  PAGE dip idx=${d.idx} luma=${d.luma.toFixed(3)} med=${d.med.toFixed(3)} @perf ${d.t.toFixed(0)}`);
  // Cross-match: count CDP dips with a page dip within 120ms
  const matched = cdpDips.filter((c) => pageDips.some((p) => Math.abs(p.t - c.t) < 120)).length;
  console.log(`CDP dips matched by a PAGE dip within 120ms: ${matched}/${cdpDips.length}`);
  fs.writeFileSync(`evidence/ground-truth-${pavilion}.json`, JSON.stringify({
    cdpDips, pageDips,
    pageLumas: pageLumas.map((l, i) => ({ t: pageTimes[i], luma: Number(l.toFixed(3)) })).slice(-800),
  }));
  await browser.close();
})();
