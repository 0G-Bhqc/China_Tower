// Verifies the distant ridge lines actually reach the frame, and by how much.
//
// Why measure at all: the change is aesthetic, and an aesthetic change that
// silently renders nothing is worse than no change. This probe answers three
// questions numerically instead of by eye:
//   1. Do the ridges compile and draw? (console errors + draw-call delta)
//   2. Do they reach the frame? (pixels that change when they are hidden)
//   3. How much of the frame do they own? (vertical extent of that change)
//
// The measurement trap: water, boats, lanterns glint and petals animate, so
// diffing two frames taken at different times flags the whole lower half.
// Three grabs per tower separate the two: ON(t1) vs ON(t2) is the animation
// noise floor; ON(t1) vs OFF(t3) is signal + noise. Only pixels that are
// STABLE across the two ON grabs and CHANGED against OFF are counted as
// ridge, which isolates the static far field from the moving near field.
//
// God rays MUST be off for every grab (`norays=1`). The ridge geometry is
// rendered into the god-ray mask, so hiding the ranges also re-shapes the
// shafts across the whole sky — a change far larger than the skyline itself,
// and one that made an early run report the ranges as healthy when they were
// nearly invisible.
const zlib = require('zlib');
const fs = require('fs');
const path = require('path');

// Resolve playwright from the project first, then from any known external
// runtime cache. The path used to be pinned to one machine's codex cache, so a
// cleared cache (or a second machine) broke every probe with no explanation.
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

// Overridable so the probe can point at any preview server, not just the
// canonical dev port.
const PORT = process.env.PROBE_PORT || '5173';
const BASE = `http://127.0.0.1:${PORT}/`;
const browserExecutable =
  process.env.PROBE_BROWSER || 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';
const SETTLE_MS = 2000;
const VIEWPORT = { width: 1000, height: 800 };
const OUT_DIR = path.join(__dirname, '..', 'evidence', 'distant-ranges');

// Each probe run gets its own immutable directory. Overwriting the previous
// PNGs is what made the last two rounds of evidence untrustworthy: the numbers
// people were quoting came from a build that no longer existed on disk.
function resolveRunDir() {
  const explicit = process.argv.find((a) => a.startsWith('--run='));
  const name = explicit ? explicit.slice(6) : null;
  if (name) return path.join(OUT_DIR, name);
  const existing = fs.existsSync(OUT_DIR)
    ? fs
        .readdirSync(OUT_DIR, { withFileTypes: true })
        .filter((d) => d.isDirectory() && /^run-\d{3}$/.test(d.name))
        .map((d) => Number.parseInt(d.name.slice(4), 10))
    : [];
  const next = existing.length ? Math.max(...existing) + 1 : 1;
  return path.join(OUT_DIR, `run-${String(next).padStart(3, '0')}`);
}

// Fall back to playwright's bundled browser when the configured one is absent,
// rather than failing with an opaque launch error.
function launchOptions() {
  const options = { headless: true };
  // Hardware GL by default. SwiftShader software rendering stalls the renderer
  // on this scene — screenshots hang after a couple of navigations — while the
  // discrete GPU renders the same frames in ~300 ms. Set PROBE_SOFTWARE_GL=1
  // to opt back into the deterministic-but-glacial software path.
  if (!process.env.PROBE_SOFTWARE_GL) {
    options.args = ['--ignore-gpu-blocklist'];
  } else {
    options.args = ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'];
  }
  if (fs.existsSync(browserExecutable)) options.executablePath = browserExecutable;
  return options;
}

// --- Minimal PNG reader (no dependency available in this workspace) --------
function decodePng(buffer) {
  if (buffer.readUInt32BE(0) !== 0x89504e47) throw new Error('not a PNG');
  let offset = 8;
  let width = 0;
  let height = 0;
  let bitDepth = 0;
  let colorType = 0;
  const idat = [];
  while (offset < buffer.length) {
    const length = buffer.readUInt32BE(offset);
    const type = buffer.toString('ascii', offset + 4, offset + 8);
    const data = buffer.subarray(offset + 8, offset + 8 + length);
    if (type === 'IHDR') {
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
      bitDepth = data[8];
      colorType = data[9];
    } else if (type === 'IDAT') {
      idat.push(data);
    } else if (type === 'IEND') {
      break;
    }
    offset += 12 + length;
  }
  if (bitDepth !== 8) throw new Error(`unsupported bit depth ${bitDepth}`);
  const channels = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 }[colorType];
  if (!channels) throw new Error(`unsupported colour type ${colorType}`);
  const raw = zlib.inflateSync(Buffer.concat(idat));
  const stride = width * channels;
  const out = Buffer.alloc(stride * height);
  let pos = 0;
  for (let y = 0; y < height; y += 1) {
    const filter = raw[pos];
    pos += 1;
    const line = raw.subarray(pos, pos + stride);
    pos += stride;
    const cur = out.subarray(y * stride, (y + 1) * stride);
    const prev = y > 0 ? out.subarray((y - 1) * stride, y * stride) : null;
    for (let x = 0; x < stride; x += 1) {
      const a = x >= channels ? cur[x - channels] : 0;
      const b = prev ? prev[x] : 0;
      const c = prev && x >= channels ? prev[x - channels] : 0;
      let value = line[x];
      if (filter === 1) value += a;
      else if (filter === 2) value += b;
      else if (filter === 3) value += (a + b) >> 1;
      else if (filter === 4) {
        const p = a + b - c;
        const pa = Math.abs(p - a);
        const pb = Math.abs(p - b);
        const pc = Math.abs(p - c);
        value += pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
      } else if (filter !== 0) {
        throw new Error(`bad PNG filter ${filter}`);
      }
      cur[x] = value & 0xff;
    }
  }
  return { width, height, channels, data: out };
}

function maxChannelDelta(a, b, index, channels) {
  let delta = 0;
  for (let c = 0; c < channels; c += 1) {
    const d = Math.abs(a[index + c] - b[index + c]);
    if (d > delta) delta = d;
  }
  return delta;
}

/**
 * Pixels that are stable across the two ON grabs and change when the ranges
 * are hidden — i.e. the static far field, with the animated near field
 * (water, boats, glint, lanterns) subtracted out.
 */
function measureRidgeFootprint(onA, onB, off, horizonRowPx) {
  const { width, height, channels } = onA;
  const CHANGE_T = 10;
  const STABLE_T = 6;
  // Strong-change threshold. The reflection segment of the band is strong
  // (large stable delta), the aerially-faded sky segment is not — counting
  // both into one footprint let the reflection carry the skyline verdict.
  const STRONG_T = 24;
  let noisePixels = 0;
  let ridgePixels = 0;
  let stablePixels = 0;
  let minRow = height;
  let maxRow = -1;
  // Sky-segment tracking: pixels above the waterline only. The mirror RT
  // re-renders the ranges, so hiding them also changes the water — wanted,
  // but not evidence the skyline is visible (see the row-profile notes).
  let skyRidgePixels = 0;
  let skyStrongPixels = 0;
  let skyMinRow = height;
  let skyMaxRow = -1;
  const rowHits = new Uint32Array(height);
  const noiseRows = new Uint32Array(height);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const index = (y * width + x) * channels;
      if (maxChannelDelta(onA.data, onB.data, index, channels) > STABLE_T) {
        noisePixels += 1;
        noiseRows[y] += 1;
        continue;
      }
      stablePixels += 1;
      const delta = maxChannelDelta(onA.data, off.data, index, channels);
      if (delta <= CHANGE_T) continue;
      ridgePixels += 1;
      rowHits[y] += 1;
      if (y < minRow) minRow = y;
      if (y > maxRow) maxRow = y;
    }
  }
  // The water is the animated half of the frame, so the first row where motion
  // is sustained IS the waterline — same logic as rowProfiles/findHorizon.
  // Preferred source is the live camera: the exact projected row of the water
  // plane at infinity. The motion-derived line reads ~13% LOW on this scene
  // (the far water is near-still, so sustained motion only starts where the
  // near water breaks up), which pulls sky pixels into the water segment and
  // makes every tower's skyline read as reflection-only.
  const horizonRow = horizonRowPx ?? findHorizon(noiseRows, width, height);
  for (let y = 0; horizonRow >= 0 && y < horizonRow; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const index = (y * width + x) * channels;
      if (maxChannelDelta(onA.data, onB.data, index, channels) > STABLE_T) continue;
      const delta = maxChannelDelta(onA.data, off.data, index, channels);
      if (delta <= CHANGE_T) continue;
      skyRidgePixels += 1;
      if (delta > STRONG_T) {
        skyStrongPixels += 1;
        if (y < skyMinRow) skyMinRow = y;
        if (y > skyMaxRow) skyMaxRow = y;
      }
    }
  }
  return {
    noisePct: (noisePixels / (width * height)) * 100,
    stablePct: (stablePixels / (width * height)) * 100,
    ridgePctOfFrame: (ridgePixels / (width * height)) * 100,
    ridgePctOfStable: stablePixels ? (ridgePixels / stablePixels) * 100 : 0,
    topRowPct: maxRow >= 0 ? (minRow / height) * 100 : null,
    bottomRowPct: maxRow >= 0 ? (maxRow / height) * 100 : null,
    heightPct: maxRow >= 0 ? ((maxRow - minRow + 1) / height) * 100 : 0,
    // Sky-segment metrics (above the waterline). horizonRowPct + skyTopRowPct
    // give the skyline's on-screen height directly.
    horizonRowPct: horizonRow >= 0 ? (horizonRow / height) * 100 : null,
    skyRidgePctOfFrame: horizonRow >= 0 ? (skyRidgePixels / (width * height)) * 100 : null,
    skyStrongPctOfFrame: horizonRow >= 0 ? (skyStrongPixels / (width * height)) * 100 : null,
    skyTopRowPct: skyMaxRow >= 0 ? (skyMinRow / height) * 100 : null,
    skyBottomRowPct: skyMaxRow >= 0 ? (Math.min(skyMaxRow, horizonRow) / height) * 100 : null,
    rowHits,
    width,
    height,
  };
}

async function openPage(page, query) {
  await page.goto(`${BASE}${query}`, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await page.waitForFunction(
    () => window.__CHINA_TOWERS_READY__ === true && window.__CHINA_TOWERS_DIAGNOSTICS__?.ready === true,
    null,
    { timeout: 240000 },
  );
  await page.waitForTimeout(SETTLE_MS);
}

async function grab(page) {
  const png = await page.screenshot({ type: 'png' });
  return { png, image: decodePng(png) };
}

/**
 * Row-by-row profile of the change. Needed because the footprint metric alone
 * conflates two different things: the ridge silhouette above the horizon, and
 * its planar reflection in the water below it (the mirror RT re-renders the
 * ranges, so hiding them changes the water too — which is wanted, but is not
 * evidence the skyline is visible). Sky rows are static (HDRI backdrop, god
 * rays and bloom all depend on the camera only), so any change up there is
 * unambiguously the ridge.
 */
/**
 * Two row profiles, so the skyline can be told apart from everything that
 * moves. `ridge` counts pixels that are stable across the two ON grabs and
 * change when the ranges are hidden — the static far field. `noise` counts
 * pixels that moved on their own: water, boats, glint, drifting petals.
 *
 * The split matters because the horizon itself is located by the noise: the
 * water is the animated half of the frame, so the first row where motion
 * becomes sustained IS the waterline. Everything above it that changes is the
 * ridge, and the gap between the ridge's top row and that waterline is the
 * skyline's on-screen height — the one number that says whether the ranges
 * read as a distant range or as nothing at all.
 */
function rowProfiles(on, on2, off) {
  const { width, height, channels } = on;
  const ridge = new Uint32Array(height);
  const noise = new Uint32Array(height);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const index = (y * width + x) * channels;
      if (maxChannelDelta(on.data, on2.data, index, channels) > 6) {
        noise[y] += 1;
        continue;
      }
      if (maxChannelDelta(on.data, off.data, index, channels) > 10) ridge[y] += 1;
    }
  }
  return { ridge, noise, width, height };
}

/** First row from the top where motion is sustained — the waterline. */
function findHorizon(noise, width, height) {
  const threshold = width * 0.04;
  let run = 0;
  for (let y = 0; y < height; y += 1) {
    run = noise[y] > threshold ? run + 1 : 0;
    if (run >= 12) return y - 11;
  }
  return -1;
}

function rowExtent(rows, width, height) {
  const threshold = width * 0.01;
  let top = -1;
  let bottom = -1;
  for (let y = 0; y < height; y += 1) {
    if (rows[y] > threshold) {
      if (top < 0) top = y;
      bottom = y;
    }
  }
  return { top, bottom };
}

function printProfiles({ ridge, noise, width, height }) {
  const buckets = 25;
  console.log('          row           ridge (stable+changed)      noise (moved on its own)');
  for (let b = 0; b < buckets; b += 1) {
    const from = Math.floor((b * height) / buckets);
    const to = Math.max(from + 1, Math.floor(((b + 1) * height) / buckets));
    let r = 0;
    let n = 0;
    for (let y = from; y < to; y += 1) {
      r += ridge[y];
      n += noise[y];
    }
    const rPct = r / (to - from) / width * 100;
    const nPct = n / (to - from) / width * 100;
    console.log(
      `            ${String(Math.round((from / height) * 100)).padStart(3)}% | ` +
        `${rPct.toFixed(1).padStart(5)}% ${'#'.repeat(Math.round(rPct / 2)).padEnd(22)} ` +
        `${nPct.toFixed(1).padStart(5)}% ${'~'.repeat(Math.round(nPct / 2))}`,
    );
  }
}

// --analyze reads a previous run. Default to the newest run directory; the
// flat layout is still readable so the pre-run-001 PNGs stay analysable.
function resolveReadDir() {
  const explicit = process.argv.find((a) => a.startsWith('--run='));
  if (explicit) return path.join(OUT_DIR, explicit.slice(6));
  const runs = fs.existsSync(OUT_DIR)
    ? fs
        .readdirSync(OUT_DIR, { withFileTypes: true })
        .filter((d) => d.isDirectory() && /^run-\d{3}$/.test(d.name))
        .map((d) => d.name)
        .sort()
    : [];
  return runs.length ? path.join(OUT_DIR, runs[runs.length - 1]) : OUT_DIR;
}

async function analyzeSaved() {
  const readDir = resolveReadDir();
  console.log(`analyzing ${path.relative(process.cwd(), readDir)}`);
  for (const id of ['yueyang', 'huanghe', 'tengwang']) {
    const onPath = path.join(readDir, `${id}-ranges-on.png`);
    const on2Path = path.join(readDir, `${id}-ranges-on2.png`);
    const offPath = path.join(readDir, `${id}-ranges-off.png`);
    if (!fs.existsSync(onPath) || !fs.existsSync(offPath) || !fs.existsSync(on2Path)) {
      console.log(`${id}: missing saved grabs, run without --analyze first`);
      continue;
    }
    const on = decodePng(fs.readFileSync(onPath));
    const on2 = decodePng(fs.readFileSync(on2Path));
    const off = decodePng(fs.readFileSync(offPath));
    const profiles = rowProfiles(on, on2, off);
    const { width, height } = profiles;
    const horizon = findHorizon(profiles.noise, width, height);
    const extent = rowExtent(profiles.ridge, width, height);
    console.log(`\n${id}  (${width}x${height})`);
    printProfiles(profiles);
    const pct = (row) => (row >= 0 ? `${((row / height) * 100).toFixed(1)}%` : 'n/a');
    console.log(
      `          waterline row ${pct(horizon)} | ridge rows ${pct(extent.top)} .. ${pct(extent.bottom)}` +
        (horizon >= 0 && extent.top >= 0
          ? ` | skyline height ${(((horizon - extent.top) / height) * 100).toFixed(1)}% of frame`
          : ''),
    );
  }
}

// Mirrors the ridge maths in src/runtime/distantRanges.ts. Duplicated rather
// than imported because that module is TypeScript and ESM; if the crest
// constants change there, change them here too.
// Mirrors TOWER_SKIES in src/runtime/sceneEnvironment.ts. `sun` is the
// DISC direction (diskDirection ?? sunDirection) — that is what the ridge
// corridor is baked against and what the visible sun follows. Quoting
// sunDirection instead is wrong wherever a tower overrides the disc: for
// huanghe the two differ in Y, and the bearing is what the corridor reads.
const RANGE_SPECS = {
  yueyang: {
    sun: [-0.6, 0.3, 0.74],
    corridor: 0.5,
    layers: [
      { radius: 560, height: 36, seed: 11 },
      { radius: 1150, height: 78, seed: 3 },
      { radius: 1560, height: 140, seed: 7 },
    ],
  },
  huanghe: {
    // diskDirection, not sunDirection — the disc is what the corridor aims at.
    sun: [0.55, 0.26, 0.3],
    corridor: 0.35,
    layers: [
      { radius: 760, height: 66, seed: 5 },
      { radius: 1180, height: 107, seed: 13 },
      { radius: 1660, height: 176, seed: 21 },
    ],
  },
  tengwang: {
    sun: [-0.85, 0.024, -0.35],
    corridor: 0.45,
    layers: [
      { radius: 900, height: 50, seed: 17 },
      { radius: 1260, height: 93, seed: 23 },
      { radius: 1680, height: 162, seed: 31 },
    ],
  },
};

function ridgeCrest(theta, seed) {
  const octaves = [3, 5, 11, 23];
  const weights = [1, 0.55, 0.3, 0.16];
  const total = weights.reduce((a, b) => a + b, 0);
  let sum = 0;
  for (let i = 0; i < octaves.length; i += 1) {
    sum += (1 - Math.abs(Math.sin(theta * octaves[i] + seed * (i + 1) * 1.7))) * weights[i];
  }
  const noise = sum / total;
  return 0.28 + 0.72 * Math.min(1, Math.max(0, (noise - 0.12) / 0.58));
}

function wrapAngle(a) {
  return Math.atan2(Math.sin(a), Math.cos(a));
}

/** Screen row (0% = top of frame) of a world point, exact projective form. */
function screenRow(point, camPos, camTarget, fovDeg, heightPx) {
  const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
  const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
  const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
  const norm = (a) => {
    const l = Math.hypot(a[0], a[1], a[2]) || 1;
    return [a[0] / l, a[1] / l, a[2] / l];
  };
  const zAxis = norm(sub(camPos, camTarget));
  const xAxis = norm(cross([0, 1, 0], zAxis));
  const yAxis = cross(zAxis, xAxis);
  const d = sub(point, camPos);
  const yCam = dot(d, yAxis);
  const zCam = dot(d, zAxis);
  const yNdc = yCam / -zCam / Math.tan(((fovDeg / 2) * Math.PI) / 180);
  return ((1 - yNdc) / 2) * heightPx;
}

/**
 * Screen position of a world point as {row%, col%}, plus whether it is in
 * frame at all. Row/col only mean something when `inFrame` is true: the
 * projection divides by -zCam, so anything behind the camera still returns a
 * finite-looking number that is pure nonsense. Reporting the numbers without
 * the behind-test is how a disc sitting 176° off-axis can look "in shot".
 */
function screenPoint(point, camPos, camTarget, fovDeg, widthPx, heightPx) {
  const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
  const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
  const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
  const norm = (a) => {
    const l = Math.hypot(a[0], a[1], a[2]) || 1;
    return [a[0] / l, a[1] / l, a[2] / l];
  };
  const zAxis = norm(sub(camPos, camTarget));
  const xAxis = norm(cross([0, 1, 0], zAxis));
  const yAxis = cross(zAxis, xAxis);
  const d = sub(point, camPos);
  const xCam = dot(d, xAxis);
  const yCam = dot(d, yAxis);
  const zCam = dot(d, zAxis);
  const behind = zCam > 0;
  const tanHalf = Math.tan(((fovDeg / 2) * Math.PI) / 180);
  const aspect = widthPx / heightPx;
  const yNdc = yCam / -zCam / tanHalf;
  const xNdc = xCam / -zCam / (tanHalf * aspect);
  const row = ((1 - yNdc) / 2) * heightPx;
  const col = ((xNdc + 1) / 2) * widthPx;
  return {
    behind,
    rowPct: (row / heightPx) * 100,
    colPct: (col / widthPx) * 100,
    inFrame: !behind && row >= 0 && row <= heightPx && col >= 0 && col <= widthPx,
  };
}

async function probeCamera() {
  const browser = await chromium.launch({
    ...launchOptions(),
  });
  try {
    const page = await browser.newPage({ viewport: VIEWPORT });
    for (const id of ['yueyang', 'huanghe', 'tengwang']) {
      // Deliberately not openPage(): this mode only needs the camera numbers,
      // which are live before the scene has finished settling. Waiting for the
      // full ready handshake took >15 min to never return on one run, and the
      // diagnostics it needs are populated well before that.
      const t0 = Date.now();
      await page.goto(`${BASE}?pavilion=${id}&quality=standard`, {
        waitUntil: 'domcontentloaded',
        timeout: 60000,
      });
      console.log(`  [${id}] domcontentloaded ${((Date.now() - t0) / 1000).toFixed(1)}s`);
      // Wait for the camera to be FRAMED, not merely to exist. `fov` is set at
      // construction, so `cameraFov > 0` is true while the camera is still
      // parked at the origin — an early run happily projected ridge rows from a
      // camera 0.2 m from the tower and reported the horizon at row -1410%.
      // Framing only lands once the model has loaded, hence: ready AND moved.
      try {
        await page.waitForFunction(
          () => {
            const d = window.__CHINA_TOWERS_DIAGNOSTICS__;
            if (!d?.ready) return false;
            return Math.hypot(d.cameraPosition[0], d.cameraPosition[2]) > 1;
          },
          null,
          { timeout: 120000 },
        );
      } catch (error) {
        console.log(`  [${id}] NOT FRAMED after ${((Date.now() - t0) / 1000).toFixed(1)}s: ${error.message.split('\n')[0]}`);
        continue;
      }
      console.log(`  [${id}] framed ${((Date.now() - t0) / 1000).toFixed(1)}s`);
      const info = await page.evaluate(() => {
        const d = window.__CHINA_TOWERS_DIAGNOSTICS__;
        return { pos: d.cameraPosition.slice(), target: d.cameraTarget.slice(), fov: d.cameraFov };
      });
      const spec = RANGE_SPECS[id];
      // The camera looks past the tower, so the ridge it frames is the one on
      // the far side of the origin: bearing = direction away from the camera.
      const bearing = Math.atan2(-info.pos[0], -info.pos[2]);
      const sunBearing = Math.atan2(spec.sun[0], spec.sun[2]);
      const corridor = 1 - spec.corridor * Math.exp(-((wrapAngle(bearing - sunBearing) / 0.26) ** 2));
      const horizonRow = screenRow([info.pos[0] * 40, -0.62, info.pos[2] * 40], info.pos, info.target, info.fov, 800);
      console.log(
        `\n${id}: camera y=${info.pos[1].toFixed(1)} (${(info.pos[1] + 0.62).toFixed(1)} m above water), ` +
          `dist=${Math.hypot(info.pos[0], info.pos[2]).toFixed(1)} m, fov=${info.fov}`,
      );
      console.log(
        `     view bearing ${bearing.toFixed(2)} rad, sun bearing ${sunBearing.toFixed(2)} rad, corridor x${corridor.toFixed(2)}`,
      );
      // The disc is parked at camera.position + diskDir * 1600, so "is the sun
      // in shot" is a question about the camera's orientation, not the sky.
      const diskLen = Math.hypot(spec.sun[0], spec.sun[1], spec.sun[2]);
      const diskPoint = [
        info.pos[0] + (spec.sun[0] / diskLen) * 1600,
        info.pos[1] + (spec.sun[1] / diskLen) * 1600,
        info.pos[2] + (spec.sun[2] / diskLen) * 1600,
      ];
      const disc = screenPoint(diskPoint, info.pos, info.target, info.fov, 1000, 800);
      console.log(
        `     sun disc: ${disc.behind ? 'BEHIND camera' : `row ${disc.rowPct.toFixed(1)}% col ${disc.colPct.toFixed(1)}%`}` +
          ` -> ${disc.inFrame ? 'IN FRAME' : 'off frame'}`,
      );
      console.log(`     horizon at row ${((horizonRow / 800) * 100).toFixed(1)}% of frame`);
      // Sweep the bearing and keep only the samples whose projected COLUMN
      // lands inside the frame. One bearing is not a skyline: the crest noise
      // swings from 0.28 to 0.85, so a single sample can land in a valley and
      // report a 150 m peak as a 22 m hill. Sweeping and filtering by column
      // also handles the fact that screen column is not linear in bearing.
      const SAMPLES = 241;
      const SWEEP = 0.7;
      let frameTopPct = 100;
      let frameBottomPct = 0;
      for (const layer of spec.layers) {
        let topPct = 100;
        let bottomPct = 0;
        let sumPct = 0;
        let inFrame = 0;
        let aboveHorizon = 0;
        for (let i = 0; i < SAMPLES; i += 1) {
          const theta = bearing - SWEEP + (2 * SWEEP * i) / (SAMPLES - 1);
          const layerCorridor =
            1 - spec.corridor * Math.exp(-((wrapAngle(theta - sunBearing) / 0.26) ** 2));
          const height = layer.height * ridgeCrest(theta, layer.seed) * layerCorridor;
          const point = [
            Math.sin(theta) * layer.radius,
            -0.62 + height,
            Math.cos(theta) * layer.radius,
          ];
          const s = screenPoint(point, info.pos, info.target, info.fov, 1000, 800);
          if (s.behind || s.colPct < 0 || s.colPct > 100) continue;
          inFrame += 1;
          sumPct += s.rowPct;
          if (s.rowPct < topPct) topPct = s.rowPct;
          if (s.rowPct > bottomPct) bottomPct = s.rowPct;
          if (s.rowPct < (horizonRow / 800) * 100) aboveHorizon += 1;
        }
        if (!inFrame) continue;
        if (topPct < frameTopPct) frameTopPct = topPct;
        if (bottomPct > frameBottomPct) frameBottomPct = bottomPct;
        console.log(
          `     d=${String(layer.radius).padStart(4)} H=${String(layer.height).padStart(3)} ` +
            `skyline rows ${topPct.toFixed(1)}%..${bottomPct.toFixed(1)}% (mean ${(sumPct / inFrame).toFixed(1)}%) ` +
            `band ${(bottomPct - topPct).toFixed(1)}% | ${((aboveHorizon / inFrame) * 100).toFixed(0)}% above horizon`,
        );
      }
      console.log(
        `     == whole range spans rows ${frameTopPct.toFixed(1)}%..${frameBottomPct.toFixed(1)}% ` +
          `= ${(frameBottomPct - frameTopPct).toFixed(1)}% of frame height`,
      );
    }
  } finally {
    await browser.close();
  }
}

async function main() {
  if (process.argv.includes('--analyze')) {
    await analyzeSaved();
    return;
  }
  if (process.argv.includes('--camera')) {
    await probeCamera();
    return;
  }
  const RUN_DIR = resolveRunDir();
  fs.mkdirSync(RUN_DIR, { recursive: true });
  const browser = await chromium.launch(launchOptions());
  const errors = [];
  const results = [];
  try {
    // min(w,h) >= 720 or the quality detector picks the mobile tier and
    // strips the water and post stack, changing what is being measured.
    const page = await browser.newPage({ viewport: VIEWPORT });
    page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
    page.on('console', (m) => {
      if (m.type() === 'error' && !m.text().includes('404') && !m.text().includes('favicon')) {
        errors.push(`console: ${m.text().slice(0, 400)}`);
      }
    });

    for (const id of ['yueyang', 'huanghe', 'tengwang']) {
      const base = `?pavilion=${id}&quality=standard&norays=1`;

      await openPage(page, base);
      const quality = await page.evaluate(() => window.__CHINA_TOWERS_DIAGNOSTICS__?.qualityProfile);
      // Exact waterline row from the LIVE camera, not from motion noise: the
      // far water on this scene is near-still, so the motion-derived line sits
      // ~13% below the true horizon and swallows the skyline segment. The
      // water plane extends to 2 km and its far edge projects to the eye-level
      // horizon: project a point far ahead of the camera AT CAMERA HEIGHT
      // (the projected row is pitch-dependent only, so any horizontal
      // direction gives the same row).
      const cam = await page.evaluate(() => {
        const d = window.__CHINA_TOWERS_DIAGNOSTICS__;
        return { pos: d.cameraPosition.slice(), target: d.cameraTarget.slice(), fov: d.cameraFov };
      });
      const flat = Math.hypot(cam.target[0] - cam.pos[0], cam.target[2] - cam.pos[2]) || 1;
      const lookX = (cam.target[0] - cam.pos[0]) / flat;
      const lookZ = (cam.target[2] - cam.pos[2]) / flat;
      const eyeHorizonRow = screenRow(
        [cam.pos[0] + lookX * 1000, cam.pos[1], cam.pos[2] + lookZ * 1000],
        cam.pos, cam.target, cam.fov, VIEWPORT.height,
      );
      const callsWith = await page.evaluate(() => window.__CHINA_TOWERS_DIAGNOSTICS__?.renderCalls ?? -1);
      const onA = await grab(page);
      await page.waitForTimeout(1200);
      const onB = await grab(page);

      await openPage(page, `${base}&noranges=1`);
      const callsWithout = await page.evaluate(() => window.__CHINA_TOWERS_DIAGNOSTICS__?.renderCalls ?? -1);
      const off = await grab(page);

      fs.writeFileSync(path.join(RUN_DIR, `${id}-ranges-on.png`), onA.png);
      fs.writeFileSync(path.join(RUN_DIR, `${id}-ranges-on2.png`), onB.png);
      fs.writeFileSync(path.join(RUN_DIR, `${id}-ranges-off.png`), off.png);
      const metrics = measureRidgeFootprint(onA.image, onB.image, off.image, eyeHorizonRow);
      results.push({
        id,
        quality,
        callsWith,
        callsWithout,
        callDelta: callsWith - callsWithout,
        cameraHorizonRowPct: (eyeHorizonRow / VIEWPORT.height) * 100,
        ...metrics,
      });
    }
  } finally {
    await browser.close();
  }

  console.log('\n=== distant ranges verification ===\n');
  for (const r of results) {
    console.log(
      `${r.id.padEnd(9)} quality=${String(r.quality).padEnd(9)} drawCalls ${r.callsWithout} -> ${r.callsWith} (delta ${r.callDelta})`,
    );
    console.log(
      `          ridge footprint ${r.ridgePctOfFrame.toFixed(2)}% of frame, ` +
        `${r.ridgePctOfStable.toFixed(2)}% of stable pixels`,
    );
    console.log(
      `          band rows ${r.topRowPct?.toFixed(1)}% .. ${r.bottomRowPct?.toFixed(1)}% ` +
        `(height ${r.heightPct.toFixed(1)}% of frame) | animation noise ${r.noisePct.toFixed(2)}%`,
    );
    console.log(
      `          sky segment: waterline ${r.horizonRowPct?.toFixed(1)}%, ` +
        `strong-sky ${r.skyStrongPctOfFrame?.toFixed(2)}% of frame ` +
        `(rows ${r.skyTopRowPct?.toFixed(1) ?? 'n/a'}% .. ${r.skyBottomRowPct?.toFixed(1) ?? 'n/a'}%)`,
    );
  }
  console.log('');
  if (errors.length) {
    console.log(`ERRORS (${errors.length}):`);
    for (const e of errors.slice(0, 10)) console.log(`  - ${e}`);
  } else {
    console.log('ERRORS: none');
  }

  let failed = false;
  const failures = [];
  for (const r of results) {
    const fail = (reason) => {
      failed = true;
      failures.push(`${r.id}: ${reason}`);
      console.log(`FAIL ${r.id}: ${reason}`);
    };
    if (r.quality === 'mobile') fail('mobile quality tier, measurement is not meaningful');
    if (r.callDelta < 3) fail(`hiding the ranges changed draw calls by only ${r.callDelta} — they are not being drawn`);
    if (r.ridgePctOfStable < 0.5) fail(`ridges reach only ${r.ridgePctOfStable.toFixed(2)}% of stable pixels — effectively invisible`);
    // The skyline verdict reads the SKY segment only. The full band bottoms out
    // at the frame edge because the mirror reflection changes too — judging it
    // turned every run with a healthy reflection into a false FAIL.
    if (r.skyStrongPctOfFrame == null) fail('waterline not found — cannot locate the sky segment');
    else if (r.skyStrongPctOfFrame < 0.5) {
      fail(
        `sky segment above the waterline holds only ${r.skyStrongPctOfFrame.toFixed(2)}% of the frame in strong pixels — ` +
          'the skyline is too faint to read (deltas mostly under 24/255)',
      );
    }
  }

  // Persist the numbers next to the images. Console-only metrics meant every
  // previous run's measurements were lost as soon as the terminal scrolled, so
  // a later tuning change had nothing to be compared against.
  fs.writeFileSync(
    path.join(RUN_DIR, 'results.json'),
    JSON.stringify(
      {
        generatedAt: new Date().toISOString(),
        base: BASE,
        viewport: VIEWPORT,
        settleMs: SETTLE_MS,
        failures,
        passed: !failed,
        errors,
        results,
      },
      null,
      2,
    ),
  );
  console.log(`\nwrote ${path.relative(process.cwd(), path.join(RUN_DIR, 'results.json'))}`);
  console.log(failed ? '\nRESULT: FAIL\n' : '\nRESULT: PASS\n');
  // Exit non-zero so the probe can gate a build instead of being advisory text.
  if (failed) process.exitCode = 1;
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
