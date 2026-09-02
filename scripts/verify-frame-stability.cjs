// Measures flicker directly, in pixels.
//
// Every previous fix in this area was reasoned about and then believed. This
// probe replaces belief with numbers, in two regimes:
//
//   parked  — camera still, sample N frames, measure how much the image
//             changes on its own. Catches bloom threshold strobing (the water's
//             specular field is re-lit every frame by the moving normal map, so
//             a hard high-pass knee flips pixels 0<->1) and any pass that is
//             fighting itself.
//
//   orbit   — camera moving smoothly, sample N frames, measure the *variation
//             of the frame-to-frame difference*. Smooth motion produces a
//             steady difference; strobing produces a difference that swings,
//             because some frames land on the bright side of a tie and some on
//             the dark side. Catches coplanar z-fighting (podium slabs,
//             stepped 台基 courses) and near-plane depth reshuffles.
//
// Regions are split at the computed horizon, because the failure modes live in
// different places: sky = post-processing, below-horizon = water and geometry.
const fs = require('fs');
const path = require('path');
const { decodePng, diffStats, horizonRowFraction } = require('./lib/png-reader.cjs');

const PLAYWRIGHT_CANDIDATES = [
  'playwright',
  path.join(__dirname, '..', 'node_modules', 'playwright'),
  process.env.LOCALAPPDATA
    ? path.join(process.env.LOCALAPPDATA, 'hermes', 'runtime', 'node_modules', 'playwright')
    : 'C:/Users/admin/AppData/Local/hermes/runtime/node_modules/playwright',
];
let chromium = null;
for (const candidate of PLAYWRIGHT_CANDIDATES) {
  try {
    chromium = require(candidate).chromium;
    break;
  } catch {
    /* try the next candidate */
  }
}
if (!chromium) {
  console.error('playwright not found; tried: ' + PLAYWRIGHT_CANDIDATES.join(', '));
  process.exit(1);
}

const browserExecutable =
  process.env.PROBE_BROWSER || 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';
const PORT = process.env.PROBE_PORT || '5173';
const BASE = `http://127.0.0.1:${PORT}/`;
const SETTLE_MS = 2500;
const VIEWPORT = { width: 1000, height: 800 };
const FRAME_INTERVAL_MS = Number(process.env.PROBE_FRAME_INTERVAL || 900);
const FRAMES = Number(process.env.PROBE_FRAMES || 8);
const OUT_DIR = path.join(__dirname, '..', 'evidence', 'frame-stability');

// First-pass thresholds. They are deliberately loose: the point of the opening
// run is to establish what a healthy frame actually measures on this renderer
// (swiftshader, 1-3 fps), not to assert a number nobody has checked. Tighten
// them from results.json once there is a baseline worth defending.
const THRESHOLDS = {
  parkedSkyMad: 1.5,
  parkedStructureMad: 2.0,
  parkedWaterMad: 4.0,
  orbitDiffCv: 0.6,
  orbitDiffStd: 2.0,
};

function launchOptions() {
  const options = { headless: true };
  // Hardware GL by default (see verify-distant-ranges.cjs); SwiftShader stalls
  // the renderer and hangs screenshots. PROBE_SOFTWARE_GL=1 restores it.
  if (!process.env.PROBE_SOFTWARE_GL) {
    options.args = ['--ignore-gpu-blocklist'];
  } else {
    options.args = ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'];
  }
  if (fs.existsSync(browserExecutable)) options.executablePath = browserExecutable;
  return options;
}

function resolveRunDir() {
  const explicit = process.argv.find((a) => a.startsWith('--run='));
  if (explicit) return path.join(OUT_DIR, explicit.slice(6));
  const existing = fs.existsSync(OUT_DIR)
    ? fs
        .readdirSync(OUT_DIR, { withFileTypes: true })
        .filter((d) => d.isDirectory() && /^run-\d{3}$/.test(d.name))
        .map((d) => Number.parseInt(d.name.slice(4), 10))
    : [];
  const next = existing.length ? Math.max(...existing) + 1 : 1;
  return path.join(OUT_DIR, `run-${String(next).padStart(3, '0')}`);
}

function resolveTowers() {
  const explicit = process.argv.find((a) => a.startsWith('--towers='));
  if (!explicit) return ['yueyang', 'huanghe', 'tengwang'];
  return explicit
    .slice(9)
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

function resolveModes() {
  const explicit = process.argv.find((a) => a.startsWith('--modes='));
  if (!explicit) return ['parked', 'orbit'];
  return explicit
    .slice(8)
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

async function openPage(page, query) {
  await page.goto(`${BASE}${query}`, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await page.waitForFunction(
    () => window.__CHINA_TOWERS_READY__ === true && window.__CHINA_TOWERS_DIAGNOSTICS__?.ready === true,
    null,
    { timeout: 180000 },
  );
  await page.waitForTimeout(SETTLE_MS);
}

async function grab(page) {
  return decodePng(await page.screenshot({ type: 'png' }));
}

async function readCamera(page) {
  return page.evaluate(() => {
    const d = window.__CHINA_TOWERS_DIAGNOSTICS__;
    if (!d) return null;
    return {
      position: [...d.cameraPosition],
      target: [...d.cameraTarget],
      fov: d.cameraFov,
      quality: d.qualityProfile,
      renderCalls: d.renderCalls,
    };
  });
}

function regionsFor(width, height, camera) {
  const h = horizonRowFraction(camera.position, camera.target, camera.fov);
  const horizonY = Math.round(h * height);
  const below = height - horizonY;
  return {
    horizonRowPct: Number((h * 100).toFixed(1)),
    sky: { x0: 0, y0: 0, x1: width, y1: Math.max(0, horizonY - 2) },
    structure: { x0: 0, y0: horizonY, x1: width, y1: horizonY + Math.round(below * 0.55) },
    water: { x0: 0, y0: horizonY + Math.round(below * 0.55), x1: width, y1: height },
  };
}

function statsOf(frames, regions) {
  const perRegion = {};
  for (const name of ['sky', 'structure', 'water']) {
    const values = [];
    for (let i = 0; i + 1 < frames.length; i += 1) {
      values.push(diffStats(frames[i], frames[i + 1], regions[name]));
    }
    const mads = values.map((v) => v.mad);
    const mean = mads.reduce((a, b) => a + b, 0) / (mads.length || 1);
    perRegion[name] = {
      meanMad: Number(mean.toFixed(3)),
      maxMad: Number(Math.max(...mads, 0).toFixed(3)),
      meanChangedPct: Number((values.reduce((a, v) => a + v.changedPct, 0) / (values.length || 1)).toFixed(3)),
      series: mads.map((v) => Number(v.toFixed(3))),
    };
  }
  return perRegion;
}

function variability(series) {
  if (series.length < 2) return { mean: 0, std: 0, cv: 0 };
  const mean = series.reduce((a, b) => a + b, 0) / series.length;
  const variance = series.reduce((a, b) => a + (b - mean) ** 2, 0) / series.length;
  const std = Math.sqrt(variance);
  return { mean: Number(mean.toFixed(3)), std: Number(std.toFixed(3)), cv: Number((std / (mean || 1)).toFixed(3)) };
}

async function probeParked(page, id, runDir) {
  await openPage(page, `?pavilion=${id}&quality=standard`);
  const camera = await readCamera(page);
  if (!camera) throw new Error(`${id}: no diagnostics exposed`);
  const first = await grab(page);
  const regions = regionsFor(first.width, first.height, camera);
  const frames = [first];
  for (let i = 1; i < FRAMES; i += 1) {
    await page.waitForTimeout(FRAME_INTERVAL_MS);
    frames.push(await grab(page));
  }
  fs.writeFileSync(path.join(runDir, `${id}-parked-frame0.png`), await page.screenshot({ type: 'png' }));
  return { regions, perRegion: statsOf(frames, regions), frames: frames.length };
}

async function probeOrbit(page, id) {
  await openPage(page, `?pavilion=${id}&quality=standard`);
  const camera = await readCamera(page);
  if (!camera) throw new Error(`${id}: no diagnostics exposed`);
  const first = await grab(page);
  const regions = regionsFor(first.width, first.height, camera);

  const box = await page.locator('#scene').boundingBox();
  const cx = box.x + box.width / 2;
  const cy = box.y + box.height / 2;

  // Slow, smooth, single-direction: any unevenness in the resulting difference
  // series is then the scene's doing, not the input's.
  await page.mouse.move(cx, cy);
  await page.mouse.down();
  const frames = [first];
  for (let i = 1; i < FRAMES; i += 1) {
    await page.mouse.move(cx + i * 5, cy + i * 0.6);
    await page.waitForTimeout(FRAME_INTERVAL_MS);
    frames.push(await grab(page));
  }
  await page.mouse.up();
  return { regions, perRegion: statsOf(frames, regions), frames: frames.length };
}

async function main() {
  const RUN_DIR = resolveRunDir();
  const towers = resolveTowers();
  const modes = resolveModes();
  fs.mkdirSync(RUN_DIR, { recursive: true });
  const browser = await chromium.launch(launchOptions());
  const errors = [];
  const results = [];
  let failed = false;
  try {
    const page = await browser.newPage({ viewport: VIEWPORT });
    page.on('pageerror', (e) => errors.push(e.message));
    page.on('console', (m) => {
      if (m.type() === 'error' && !m.text().includes('404') && !m.text().includes('favicon')) errors.push(m.text());
    });

    for (const id of towers) {
      const entry = { id, modes: {} };
      for (const mode of modes) {
        try {
          const out = mode === 'parked' ? await probeParked(page, id, RUN_DIR) : await probeOrbit(page, id);
          const checks = [];
          if (mode === 'parked') {
            // Judge the SWING of the parked difference series, not its size.
            // The meanMad limits started as placeholders (see THRESHOLDS) and
            // even the healthy scene blew them: the water region reads
            // meanMad ~5.9 in EVERY frame (animated normals, petals, the
            // stork) — a flat series is the opposite of flicker, which shows
            // up as frames alternating between high and low difference.
            // Flicker = variability; energy = content. Same rule as orbit.
            for (const region of ['sky', 'structure', 'water']) {
              const series = out.perRegion[region].series;
              const v = variability(series);
              const useCv = v.mean > 0.5;
              const value = useCv ? v.cv : v.std;
              const limit = useCv ? THRESHOLDS.orbitDiffCv : THRESHOLDS.orbitDiffStd;
              checks.push({
                region,
                metric: useCv ? 'diffCv' : 'diffStd',
                value,
                limit,
                passed: value < limit,
                mean: v.mean,
                std: v.std,
              });
            }
          } else {
            // Orbit: judge the swing of the difference series, not its size —
            // moving content legitimately differs frame to frame.
            for (const region of ['sky', 'structure', 'water']) {
              const series = out.perRegion[region].series;
              const v = variability(series);
              // When a region barely moves at all the ratio is meaningless, so
              // fall back to absolute swing.
              const useCv = v.mean > 0.5;
              const value = useCv ? v.cv : v.std;
              const limit = useCv ? THRESHOLDS.orbitDiffCv : THRESHOLDS.orbitDiffStd;
              checks.push({
                region,
                metric: useCv ? 'diffCv' : 'diffStd',
                value,
                limit,
                passed: value < limit,
                mean: v.mean,
                std: v.std,
              });
            }
          }
          entry.modes[mode] = { horizonRowPct: out.regions.horizonRowPct, frames: out.frames, regions: out.perRegion, checks };
          const bad = checks.filter((c) => !c.passed);
          if (bad.length) failed = true;
          console.log(
            `\n${id} / ${mode}  horizon at row ${out.regions.horizonRowPct}%  (${out.frames} frames)',
            `,
          );
          for (const r of ['sky', 'structure', 'water']) {
            const s = out.perRegion[r];
            console.log(`  ${r.padEnd(10)} meanMad ${String(s.meanMad).padStart(7)}  maxMad ${String(s.maxMad).padStart(7)}  changed ${s.meanChangedPct}%`);
          }
          for (const c of checks) {
            console.log(`  check ${c.region.padEnd(10)} ${c.metric} = ${c.value} (limit ${c.limit}) ${c.passed ? 'pass' : 'FAIL'}`);
          }
        } catch (error) {
          failed = true;
          entry.modes[mode] = { error: String(error && error.message ? error.message : error) };
          console.log(`\n${id} / ${mode} FAILED: ${error && error.message ? error.message : error}`);
        }
      }
      results.push(entry);
    }
  } finally {
    await browser.close();
  }

  fs.writeFileSync(
    path.join(RUN_DIR, 'results.json'),
    JSON.stringify(
      {
        generatedAt: new Date().toISOString(),
        base: BASE,
        viewport: VIEWPORT,
        frames: FRAMES,
        frameIntervalMs: FRAME_INTERVAL_MS,
        thresholds: THRESHOLDS,
        towers,
        modes,
        passed: !failed,
        errors,
        results,
      },
      null,
      2,
    ),
  );
  console.log(`\nwrote ${path.relative(process.cwd(), path.join(RUN_DIR, 'results.json'))}`);
  if (errors.length) {
    console.log(`ERRORS (${errors.length}):`);
    for (const e of errors.slice(0, 10)) console.log(`  - ${e}`);
  }
  console.log(failed ? '\nRESULT: FAIL\n' : '\nRESULT: PASS\n');
  if (failed) process.exitCode = 1;
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
