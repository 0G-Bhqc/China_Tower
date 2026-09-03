// Poison isolation: park the camera at the known poison pose, then toggle
// suspect objects (horizon glow / sun disc / sun streaks / water / sunset
// bank / stork) one at a time and grid-scan the bloom bright RT for the NaN
// row after each toggle. Names the object whose hiding clears the poison.
const { chromium } = require('../node_modules/playwright');
const fs = require('fs');

const PATCH = `
  (function () {
    window.__TRACER_READY__ = false;
    import('/node_modules/.vite/deps/three_examples_jsm_postprocessing_UnrealBloomPass__js.js?v=23ff1a00').then(({ UnrealBloomPass }) => {
      const renderer = window.__CHINA_TOWERS_RENDERER__;
      function h2f(h) {
        const s = (h & 0x8000) >> 15, e = (h & 0x7c00) >> 10, m = h & 0x3ff;
        if (e === 0) return (s ? -1 : 1) * Math.pow(2, -14) * (m / 1024);
        if (e === 0x1f) return m ? NaN : (s ? -1 : 1) * Infinity;
        return (s ? -1 : 1) * (1 + m / 1024) * Math.pow(2, e - 15);
      }
      window.__BRIGHT_BAD_ROWS__ = null;
      let bloom = null;
      let pendingScan = false;
      window.__ARM_SCAN__ = () => { pendingScan = true; };
      const orig = UnrealBloomPass.prototype.render;
      UnrealBloomPass.prototype.render = function (...args) {
        if (!bloom) bloom = this;
        const result = orig.apply(this, args);
        if (pendingScan && bloom) {
          pendingScan = false;
          const rt = bloom.renderTargetBright;
          const buf = new Uint16Array(4);
          const rows = [];
          for (let y = 0; y < rt.height; y += 2) {
            let badInRow = 0;
            for (let x = 0; x < rt.width; x += 8) {
              try { renderer.readRenderTargetPixels(rt, x, y, 1, 1, buf); } catch (e) { continue; }
              const v = [buf[0], buf[1], buf[2]].map(h2f);
              if (v.some((n) => Number.isNaN(n) || n === Infinity || n === -Infinity)) badInRow++;
            }
            if (badInRow > 0) rows.push([y, badInRow]);
          }
          window.__BRIGHT_BAD_ROWS__ = rows;
        }
        return result;
      };
      window.__TRACER_READY__ = true;
    });
  })()
`;

(async () => {
  const pavilion = process.env.PAVILION || 'tengwang';
  const browser = await chromium.launch({ headless: true, executablePath: 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe', args: ['--ignore-gpu-blocklist'] });
  const page = await browser.newPage({ viewport: { width: 1000, height: 800 } });
  page.on('pageerror', (err) => console.log('[pageerror]', String(err).slice(0, 300)));
  await page.goto(`http://127.0.0.1:5173/?pavilion=${pavilion}&quality=standard`, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await page.waitForFunction(() => window.__CHINA_TOWERS_READY__ === true, null, { timeout: 120000 });
  await page.waitForTimeout(1000);
  await page.evaluate(PATCH);
  await page.waitForFunction(() => window.__TRACER_READY__ === true, null, { timeout: 30000 });

  const pose = { pos: [39.693372356651885, 0.3433757425977956, 26.43474379865914], tgt: [0, 8.37, 0.21] };
  const scene = () => `window.__CHINA_TOWERS_SCENE__`;
  const toggles = [
    ['all-on', null],
    ['no-horizon-glow', 'poetic-horizon-glow'],
    ['no-sun-disc', 'poetic-sun-disc'],
    ['no-sun-streaks', '*streak'],
    ['no-water', 'poetic-river-or-lake'],
    ['no-sunset-bank', 'poetic-sunset-bank'],
    ['no-cloud-band', 'poetic-cloud-band'],
  ];
  for (const [label, target] of toggles) {
    // reset all visible, then hide target
    await page.evaluate(() => {
      const scene = window.__CHINA_TOWERS_SCENE__;
      for (const name of ['poetic-horizon-glow', 'poetic-sun-disc', 'poetic-sun-streak', 'poetic-sun-streak-inner', 'poetic-river-or-lake', 'poetic-sunset-bank', 'poetic-cloud-band']) {
        const obj = scene.getObjectByName(name);
        if (obj) obj.visible = true;
      }
    });
    if (target) {
      await page.evaluate((t) => {
        const scene = window.__CHINA_TOWERS_SCENE__;
        if (t === '*streak') {
          for (const n of ['poetic-sun-streak', 'poetic-sun-streak-inner']) {
            const o = scene.getObjectByName(n);
            if (o) o.visible = false;
          }
        } else {
          const o = scene.getObjectByName(t);
          if (o) o.visible = false;
        }
      }, target);
    }
    // park camera at the poison pose (set every toggle; controls will fight, so disable damping influence by setting both position and target then updating)
    await page.evaluate((p) => {
      const cam = window.__CHINA_TOWERS_CAMERA__;
      cam.position.set(p.pos[0], p.pos[1], p.pos[2]);
      cam.lookAt(p.tgt[0], p.tgt[1], p.tgt[2]);
    }, pose);
    await page.waitForTimeout(120);
    await page.evaluate(() => window.__ARM_SCAN__());
    await page.waitForTimeout(120);
    const rows = await page.evaluate(() => window.__BRIGHT_BAD_ROWS__);
    console.log(`${label}: bad rows = ${rows ? JSON.stringify(rows.slice(0, 6)) : 'null'}`);
  }
  await browser.close();
})();
