// Culprit probe: name the mesh that fills the screen during a flicker dip.
// In-page rAF sampler walks the scene graph each frame and records every mesh
// whose world bounding sphere contains the camera (plus a center-ray raycast).
// CDP screencast gives composited luma; dips are correlated by wall clock and
// the near-camera mesh list is dumped for each dip frame.
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

const SAMPLER = `
  (function () {
    const THREE = window.__CHINA_TOWERS_THREE__;
    const scene = window.__CHINA_TOWERS_SCENE__;
    const camera = window.__CHINA_TOWERS_CAMERA__;
    window.__CULPRIT_RING__ = [];
    const ring = window.__CULPRIT_RING__;
    const v = new THREE.Vector3();
    const box = new THREE.Box3();
    function sample() {
      const nearList = [];
      scene.updateMatrixWorld(false);
      scene.traverse((obj) => {
        if (!obj.visible) return;
        const geom = obj.geometry;
        if (!geom) return;
        if (!geom.boundingSphere) geom.computeBoundingSphere();
        const s = geom.boundingSphere;
        v.copy(s.center).applyMatrix4(obj.matrixWorld);
        const scale = obj.matrixWorld.getMaxScaleOnAxis();
        const r = s.radius * scale;
        const dist = v.distanceTo(camera.position);
        if (dist <= r + 0.5) {
          nearList.push({
            name: obj.name || obj.type,
            parent: obj.parent ? (obj.parent.name || obj.parent.type) : '-',
            dist: Number(dist.toFixed(2)),
            radius: Number(r.toFixed(2)),
          });
        }
      });
      ring.push({
        t: performance.now(),
        cam: [camera.position.x, camera.position.y, camera.position.z].map((n) => Number(n.toFixed(2))),
        nearPlane: camera.near,
        nearList: nearList.slice(0, 12),
      });
      if (ring.length > 3000) ring.shift();
      requestAnimationFrame(sample);
    }
    requestAnimationFrame(sample);
  })()
`;

(async () => {
  const pavilion = process.env.PAVILION || 'yueyang';
  const browser = await chromium.launch({ headless: true, executablePath: 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe', args: ['--ignore-gpu-blocklist'] });
  const page = await browser.newPage({ viewport: { width: 1000, height: 800 } });
  await page.goto(`http://127.0.0.1:5173/?pavilion=${pavilion}&quality=standard`, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await page.waitForFunction(() => window.__CHINA_TOWERS_READY__ === true, null, { timeout: 120000 });
  await page.waitForTimeout(1500);
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
  const ring = await page.evaluate(() => { const r = window.__CULPRIT_RING__; window.__CULPRIT_RING__ = []; return r || []; });

  const seq = frames.map((f) => ({ perf: f.ts - timeOrigin, luma: pngLuma(f.buf) }));
  const dips = [];
  for (let i = 3; i < seq.length - 1; i++) {
    const win = seq.slice(Math.max(0, i - 4), i + 5).map((s) => s.luma);
    const med = median(win);
    if (med > 0.05 && seq[i].luma < med * 0.55) dips.push({ idx: i, perf: seq[i].perf, luma: seq[i].luma, med });
  }
  console.log(`frames ${seq.length}, ring ${ring.length}, dips ${dips.length}`);
  for (const d of dips.slice(0, 5)) {
    console.log(`\n=== dip idx ${d.idx} luma ${d.luma.toFixed(3)} (med ${d.med.toFixed(3)}) @perf ${d.perf.toFixed(0)} ===`);
    const near = ring.filter((s) => Math.abs(s.t - d.perf) < 40);
    for (const s of near.slice(0, 3)) {
      console.log(`  t=${s.t.toFixed(0)} cam=(${s.cam.join(',')}) nearPlane=${s.nearPlane.toFixed(3)}`);
      if (!s.nearList.length) console.log('    (no mesh sphere contains camera)');
      for (const m of s.nearList) console.log(`    ~ ${m.name} [parent ${m.parent}] dist=${m.dist} r=${m.radius}`);
    }
    if (!near.length) console.log('  (no ring entries within 40ms)');
  }
  // Save dip neighbourhood images for the first two dips
  for (const d of dips.slice(0, 2)) {
    for (let k = -1; k <= 1; k++) {
      const j = d.idx + k;
      if (j >= 0 && j < frames.length) fs.writeFileSync(`evidence/culprit-${d.idx}-off${k >= 0 ? '+' : ''}${k}.png`, frames[j].buf);
    }
  }
  fs.writeFileSync(`evidence/culprit-report-${pavilion}.json`, JSON.stringify({ dips, ring: ring.slice(-400) }, null, 1));
  console.log(`\nwrote evidence/culprit-report-${pavilion}.json`);
  await browser.close();
})();
