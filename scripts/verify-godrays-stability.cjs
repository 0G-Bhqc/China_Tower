// Verifies that no post-processing pass is gated on camera motion.
//
// Background: the god-rays pass used to be faded out while the camera moved, to
// claw back the cost of the full-scene depth re-render behind its mask. A
// *continuous* programmatic drag only crosses that gate once, which is why an
// early probe reported it as clean — but a real hand drag is a series of pushes
// with pauses between them, so the gate flipped over and over and the sky
// pumped under the user's fingers.
//
// This probe is self-calibrating:
//   1. Measure the draw-call delta between `?norays=1` (mask pass disabled) and
//      normal. That IS the magnitude of one gate flip.
//   2. Drive a stop-start drag — push, pause long enough for any dwell to
//      expire, push again — sampling draw calls throughout.
//   3. Pass only if the observed spread stays well under half a gate flip.
//
// Ordinary frustum-culling variation is a few percent and is expected; a
// motion-gated pass shows up as a step of the full gate magnitude.
const fs = require('fs');
const path = require('path');

// Resolve playwright from the project first, then from any known external
// runtime cache. It used to be pinned to one machine's codex cache, so a
// cleared cache (or a second machine) broke the probe with no explanation.
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
const SETTLE_MS = 1500; // long enough for a frame to land at ~1-3fps under swiftshader
const VIEWPORT = { width: 1000, height: 800 };
const OUT_DIR = path.join(__dirname, '..', 'evidence', 'godrays-stability');

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

// Each run gets its own immutable directory; see verify-distant-ranges.cjs.
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

// `--towers=yueyang,huanghe` limits the sweep. The probe is expensive under
// swiftshader, so a one-tower smoke run has to be possible.
function resolveTowers() {
  const explicit = process.argv.find((a) => a.startsWith('--towers='));
  if (!explicit) return ['yueyang', 'huanghe', 'tengwang'];
  return explicit
    .slice(9)
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

async function sample(page) {
  return page.evaluate(() => window.__CHINA_TOWERS_DIAGNOSTICS__?.renderCalls ?? -1);
}

async function probeTower(page, id) {
  // --- Step 1: calibrate the gate magnitude -----------------------------
  await openPage(page, `?pavilion=${id}&quality=standard`);
  const quality = await page.evaluate(() => window.__CHINA_TOWERS_DIAGNOSTICS__?.qualityProfile);
  const withRays = await sample(page);
  await openPage(page, `?pavilion=${id}&quality=standard&norays=1`);
  const withoutRays = await sample(page);
  const gateDelta = Math.abs(withRays - withoutRays);
  console.log(`\n--- ${id} ---`);
  console.log(`quality profile      : ${quality}`);
  console.log(`draw calls with rays : ${withRays}`);
  console.log(`draw calls, no rays  : ${withoutRays}`);
  console.log(`gate flip magnitude  : ${gateDelta} calls`);
  if (gateDelta < 100) throw new Error(`${id}: god rays mask pass appears absent — cannot calibrate.`);

  // --- Step 2: stop-start drag ------------------------------------------
  await openPage(page, `?pavilion=${id}&quality=standard`);
  const samples = [{ phase: 'parked-baseline', calls: await sample(page) }];

  const box = await page.locator('#scene').boundingBox();
  const cx = box.x + box.width / 2;
  const cy = box.y + box.height / 2;

  for (let i = 0; i < 6; i += 1) {
    await page.mouse.move(cx, cy);
    await page.mouse.down();
    for (let s = 1; s <= 6; s += 1) await page.mouse.move(cx + s * 7, cy);
    await page.mouse.up();
    await page.waitForTimeout(SETTLE_MS);
    samples.push({ phase: `after-push-${i + 1}`, calls: await sample(page) });
    await page.waitForTimeout(1200); // the pause that used to re-arm the gate
    samples.push({ phase: `after-pause-${i + 1}`, calls: await sample(page) });
  }
  await page.waitForTimeout(SETTLE_MS);
  samples.push({ phase: 'parked-final', calls: await sample(page) });

  const calls = samples.map((s) => s.calls).filter((c) => c > 0);
  const min = Math.min(...calls);
  const max = Math.max(...calls);
  const spread = max - min;

  console.log('stop-start drag samples:');
  for (const s of samples) console.log(`  ${s.phase.padEnd(18)} renderCalls=${s.calls}`);
  console.log(`min=${min} max=${max} spread=${spread} (${((spread / min) * 100).toFixed(1)}% of baseline)`);

  // The gate signature is the push->pause transition, NOT the global spread.
  // A scene with asymmetric content (huanghe's skyline props sit on one side)
  // legitimately swings draw calls across the orbit as culling follows the
  // view — that spread grew to 1213 calls across 6 pushes while every
  // push->pause pair moved by 0-3. A motion gate does the opposite: the pair
  // diverges by ~gateDelta as the dwell expires. So the verdict reads the
  // worst pair delta; the spread stays informational.
  let worstPairDelta = 0;
  for (let i = 0; i < 6; i += 1) {
    const push = samples.find((s) => s.phase === `after-push-${i + 1}`)?.calls ?? -1;
    const pause = samples.find((s) => s.phase === `after-pause-${i + 1}`)?.calls ?? -1;
    if (push > 0 && pause > 0) worstPairDelta = Math.max(worstPairDelta, Math.abs(push - pause));
  }

  // A gate flip is worth `gateDelta` calls; culling jitter is a few calls.
  const threshold = gateDelta * 0.5;
  const passed = worstPairDelta < threshold;
  console.log(
    passed
      ? `PASS — worst push->pause delta ${worstPairDelta} < half a gate flip (${threshold.toFixed(0)}); no motion-gated pass`
      : `FAIL — worst push->pause delta ${worstPairDelta} approaches a gate flip (${gateDelta}); a pass is still gated on motion`,
  );

  return {
    id,
    quality,
    withRays,
    withoutRays,
    gateDelta,
    min,
    max,
    spread,
    worstPairDelta,
    spreadPctOfBaseline: Number(((spread / min) * 100).toFixed(2)),
    threshold: Number(threshold.toFixed(0)),
    passed,
    samples,
  };
}

async function main() {
  const RUN_DIR = resolveRunDir();
  const towers = resolveTowers();
  fs.mkdirSync(RUN_DIR, { recursive: true });
  const browser = await chromium.launch(launchOptions());
  const errors = [];
  const results = [];
  let failed = false;
  try {
    // min(w,h) must be >= 720 or the quality detector forces the mobile tier,
    // which disables water/god rays/bloom entirely and cannot flicker at all.
    const page = await browser.newPage({ viewport: VIEWPORT });
    page.on('pageerror', (e) => errors.push(e.message));
    page.on('console', (m) => {
      if (m.type() === 'error' && !m.text().includes('404') && !m.text().includes('favicon')) errors.push(m.text());
    });

    for (const id of towers) {
      try {
        results.push(await probeTower(page, id));
      } catch (error) {
        failed = true;
        results.push({ id, passed: false, error: String(error && error.message ? error.message : error) });
        console.log(`FAIL ${id}: ${error && error.message ? error.message : error}`);
      }
    }
  } finally {
    await browser.close();
  }

  for (const r of results) if (!r.passed) failed = true;

  fs.writeFileSync(
    path.join(RUN_DIR, 'results.json'),
    JSON.stringify(
      {
        generatedAt: new Date().toISOString(),
        base: BASE,
        viewport: VIEWPORT,
        settleMs: SETTLE_MS,
        towers,
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
