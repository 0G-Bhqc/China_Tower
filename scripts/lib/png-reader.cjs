// Minimal dependency-free PNG reader plus frame-difference statistics.
//
// Why hand-rolled: the probes need per-pixel access to compare two screenshots,
// and this workspace has no image library that is worth pulling in for one
// function. Supports the 8-bit RGB/RGBA/greyscale PNGs that Chromium's
// screenshot API produces.
const zlib = require('zlib');

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
      const v = line[x];
      let value;
      if (filter === 0) value = v;
      else if (filter === 1) value = v + a;
      else if (filter === 2) value = v + b;
      else if (filter === 3) value = v + ((a + b) >> 1);
      else if (filter === 4) {
        const p = a + b - c;
        const pa = Math.abs(p - a);
        const pb = Math.abs(p - b);
        const pc = Math.abs(p - c);
        value = v + (pa <= pb && pa <= pc ? a : pb <= pc ? b : c);
      } else throw new Error(`unsupported filter ${filter}`);
      cur[x] = value & 0xff;
    }
  }
  return { width, height, channels, data: out };
}

// Mean and max per-pixel luminance difference between two decoded frames,
// optionally limited to a rectangle in pixel coordinates.
function diffStats(a, b, rect) {
  if (a.width !== b.width || a.height !== b.height) throw new Error('frame size mismatch');
  const box = rect || { x0: 0, y0: 0, x1: a.width, y1: a.height };
  const { channels } = a;
  let sum = 0;
  let max = 0;
  let count = 0;
  let changed = 0;
  // Luma is sampled on every 2nd pixel in both axes. The signals being looked
  // for — a bloom halo blinking, a coplanar slab strobing — cover thousands of
  // pixels; nothing here depends on single-pixel detail, and this keeps a
  // 1000x800 comparison from dominating the probe's runtime.
  for (let y = box.y0; y < box.y1; y += 2) {
    for (let x = box.x0; x < box.x1; x += 2) {
      const i = (y * a.width + x) * channels;
      const la = 0.2126 * a.data[i] + 0.7152 * a.data[i + 1] + 0.0722 * a.data[i + 2];
      const lb = 0.2126 * b.data[i] + 0.7152 * b.data[i + 1] + 0.0722 * b.data[i + 2];
      const d = Math.abs(la - lb);
      sum += d;
      if (d > max) max = d;
      if (d > 2) changed += 1;
      count += 1;
    }
  }
  return {
    mad: count ? sum / count : 0,
    maxDiff: max,
    changedPct: count ? (changed / count) * 100 : 0,
    samples: count,
  };
}

// Where the horizon sits, as a fraction of frame height from the top.
// `fov` is the camera's vertical field of view in degrees.
function horizonRowFraction(cameraPosition, cameraTarget, fov) {
  const dx = cameraTarget[0] - cameraPosition[0];
  const dy = cameraTarget[1] - cameraPosition[1];
  const dz = cameraTarget[2] - cameraPosition[2];
  const len = Math.hypot(dx, dy, dz) || 1;
  const fy = dy / len;
  // Angle between the view axis and the horizontal plane.
  const alpha = Math.asin(Math.min(1, Math.abs(fy)));
  const halfFov = (fov * Math.PI) / 360;
  const ndcY = (Math.tan(alpha) / Math.tan(halfFov)) * (fy < 0 ? 1 : -1);
  return Math.max(0, Math.min(1, (1 - ndcY) / 2));
}

module.exports = { decodePng, diffStats, horizonRowFraction };
