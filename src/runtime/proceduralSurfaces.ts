import * as THREE from 'three';

// Shared procedural surface factory for the poetic environment: stone plaza
// paving, alpha foliage cards and shoreline rock. All maps derive from the
// same value-noise fbm used by createTengwangProceduralTextures so the whole
// scene shares one grain language.

function hash(x: number, y: number): number {
  const s = Math.sin(x * 127.1 + y * 311.7) * 43758.5453123;
  return s - Math.floor(s);
}

function smoothNoise(x: number, y: number): number {
  const xi = Math.floor(x);
  const yi = Math.floor(y);
  const xf = x - xi;
  const yf = y - yi;
  const u = xf * xf * (3 - 2 * xf);
  const v = yf * yf * (3 - 2 * yf);
  const a = hash(xi, yi);
  const b = hash(xi + 1, yi);
  const c = hash(xi, yi + 1);
  const d = hash(xi + 1, yi + 1);
  return a * (1 - u) * (1 - v) + b * u * (1 - v) + c * (1 - u) * v + d * u * v;
}

function fbm(x: number, y: number, octaves = 4): number {
  let value = 0;
  let amplitude = 0.5;
  let total = 0;
  for (let index = 0; index < octaves; index += 1) {
    value += smoothNoise(x, y) * amplitude;
    total += amplitude;
    x *= 2.03;
    y *= 2.01;
    amplitude *= 0.5;
  }
  return value / total;
}

function createCanvas(size: number): { canvas: HTMLCanvasElement; context: CanvasRenderingContext2D } {
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const context = canvas.getContext('2d');
  if (!context) throw new Error('Canvas 2D context unavailable for procedural surface');
  return { canvas, context };
}

function toTexture(canvas: HTMLCanvasElement, srgb: boolean): THREE.CanvasTexture {
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = srgb ? THREE.SRGBColorSpace : THREE.NoColorSpace;
  texture.wrapS = THREE.MirroredRepeatWrapping;
  texture.wrapT = THREE.MirroredRepeatWrapping;
  texture.anisotropy = 8;
  texture.needsUpdate = true;
  return texture;
}

function heightToNormalTexture(height: (x: number, y: number) => number, size: number, strength: number): THREE.CanvasTexture {
  // Pre-bake the height field once: sampling the closure 4x per pixel at
  // 2048px meant millions of redundant fbm evaluations and a multi-second
  // bake. One pass into a grid, then the normal pass is pure array math.
  const grid = new Float32Array(size * size);
  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      grid[y * size + x] = height(x, y);
    }
  }
  const { canvas, context } = createCanvas(size);
  const image = context.createImageData(size, size);
  const sample = (x: number, y: number): number => grid[(((y % size) + size) % size) * size + (((x % size) + size) % size)];
  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      const dx = sample(x + 1, y) - sample(x - 1, y);
      const dy = sample(x, y + 1) - sample(x, y - 1);
      const nx = -dx * strength;
      const ny = -dy * strength;
      const nz = 1;
      const length = Math.hypot(nx, ny, nz);
      const offset = (y * size + x) * 4;
      image.data[offset] = Math.round(((nx / length) * 0.5 + 0.5) * 255);
      image.data[offset + 1] = Math.round(((ny / length) * 0.5 + 0.5) * 255);
      image.data[offset + 2] = Math.round(((nz / length) * 0.5 + 0.5) * 255);
      image.data[offset + 3] = 255;
    }
  }
  context.putImageData(image, 0, 0);
  return toTexture(canvas, false);
}

export type StoneSurfaceTextures = {
  albedo: THREE.Texture;
  roughness: THREE.Texture;
  normal: THREE.Texture;
};

// Dressed-stone plaza: large slabs with wide recessed joints that survive
// mipmapping, per-slab tone drift, gentle surface wear. The joint band is a
// two-step bevel (shade + normal ramp) so the paving grid stays legible at
// distance instead of dissolving into grain.
export function createStoneSurfaceTextures(baseColorHex = '#8d8577', size = 1024): StoneSurfaceTextures {
  const base = new THREE.Color(baseColorHex);
  const { canvas, context } = createCanvas(size);
  const image = context.createImageData(size, size);
  const slab = size / 5;
  const jointHalf = slab * 0.055; // half-width of the recessed joint band
  const cellOf = (x: number, y: number): { cellX: number; cellY: number; joint: number } => {
    const cellX = Math.floor(x / slab);
    const cellY = Math.floor(y / slab + (cellX % 2) * 0.5);
    const inCellX = x - cellX * slab;
    const inCellY = y - (cellY - (cellX % 2) * 0.5) * slab;
    const joint = Math.min(inCellX, slab - inCellX, inCellY, slab - inCellY);
    return { cellX, cellY, joint };
  };
  const height = (x: number, y: number): number => {
    const { cellX, cellY, joint } = cellOf(x, y);
    // Smooth slab crown: high mid-slab, dropping into the joint bevel.
    const crown = Math.min(1, joint / (jointHalf * 2.4));
    const wear = fbm(x / 110, y / 110, 3);
    return crown * 0.5 + wear * 0.18 - hash(cellX, cellY) * 0.06;
  };
  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      const { cellX, cellY, joint } = cellOf(x, y);
      const jointMask = 1 - Math.min(1, joint / jointHalf); // 1 in the groove
      const bevel = Math.min(1, joint / (jointHalf * 2.2)); // edge rounding
      const mottle = fbm(x / 130, y / 130, 4);
      const grain = fbm(x / 22, y / 22, 2);
      const cellTone = 0.9 + hash(cellX, cellY) * 0.18;
      const tone = cellTone * (0.88 + mottle * 0.2) * (0.985 + grain * 0.03);
      const jointShade = 1 - jointMask * 0.5 - bevel * 0.1;
      const offset = (y * size + x) * 4;
      image.data[offset] = Math.min(255, base.r * 255 * tone * jointShade);
      image.data[offset + 1] = Math.min(255, base.g * 255 * tone * jointShade);
      image.data[offset + 2] = Math.min(255, base.b * 255 * tone * jointShade);
      image.data[offset + 3] = 255;
    }
  }
  context.putImageData(image, 0, 0);
  const albedo = toTexture(canvas, true);

  const roughCanvasData = (() => {
    const rough = createCanvas(size);
    const roughImage = rough.context.createImageData(size, size);
    for (let y = 0; y < size; y += 1) {
      for (let x = 0; x < size; x += 1) {
        const { cellX, cellY, joint } = cellOf(x, y);
        const jointMask = 1 - Math.min(1, joint / jointHalf);
        // Worn dressing reads semi-polished between the joints; grooves stay
        // rough and catch dirt.
        const polish = 0.72 + hash(cellX, cellY) * 0.1 + fbm(x / 70, y / 70, 3) * 0.1;
        const value = Math.min(255, Math.round((polish + jointMask * 0.2) * 255));
        const offset = (y * size + x) * 4;
        roughImage.data[offset] = value;
        roughImage.data[offset + 1] = value;
        roughImage.data[offset + 2] = value;
        roughImage.data[offset + 3] = 255;
      }
    }
    rough.context.putImageData(roughImage, 0, 0);
    return rough.canvas;
  })();
  const roughness = toTexture(roughCanvasData, false);
  const normal = heightToNormalTexture(height, size, 30);
  return { albedo, roughness, normal };
}

// Alpha foliage card: clustered leaf blobs with ragged transparent edges.
// Used with alphaTest on crossed planes instead of cone/sphere primitives.
export function createFoliageTexture(tone: 'warm' | 'cool' | 'dark' = 'cool', size = 512): THREE.CanvasTexture {
  const { canvas, context } = createCanvas(size);
  const palettes: Record<string, [string, string, string]> = {
    cool: ['#2f4a38', '#3d5f45', '#55765412'],
    warm: ['#6d5a33', '#8a6d3a', '#a5854312'],
    dark: ['#243b2c', '#31492f', '#435c3412'],
  };
  const [dark, mid, light] = palettes[tone];
  context.clearRect(0, 0, size, size);
  const drawLeaf = (x: number, y: number, radius: number, angle: number, color: string, alpha: number) => {
    context.save();
    context.translate(x, y);
    context.rotate(angle);
    context.globalAlpha = alpha;
    context.fillStyle = color;
    context.beginPath();
    context.ellipse(0, 0, radius, radius * 0.38, 0, 0, Math.PI * 2);
    context.fill();
    context.restore();
  };
  // Dense cluster core
  const clusters = 5;
  for (let cluster = 0; cluster < clusters; cluster += 1) {
    const cx = size * (0.3 + hash(cluster, 1) * 0.4);
    const cy = size * (0.3 + hash(cluster, 2) * 0.4);
    for (let leaf = 0; leaf < 90; leaf += 1) {
      const angle = hash(cluster * 31 + leaf, 3) * Math.PI * 2;
      const distance = Math.pow(hash(cluster * 17 + leaf, 4), 0.6) * size * 0.22;
      const shade = hash(cluster * 7 + leaf, 5);
      const color = shade > 0.62 ? light.slice(0, 7) : shade > 0.28 ? mid : dark;
      drawLeaf(cx + Math.cos(angle) * distance, cy + Math.sin(angle) * distance, size * (0.03 + hash(leaf, cluster) * 0.035), angle, color, 0.9);
    }
  }
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.needsUpdate = true;
  return texture;
}

export type RockSurfaceTextures = {
  albedo: THREE.Texture;
  normal: THREE.Texture;
};

export function createRockSurfaceTextures(baseColorHex = '#6f6a60', size = 512): RockSurfaceTextures {
  const base = new THREE.Color(baseColorHex);
  const { canvas, context } = createCanvas(size);
  const image = context.createImageData(size, size);
  const height = (x: number, y: number): number => fbm(x / 46, y / 46, 5) * 0.7 + fbm(x / 9, y / 9, 3) * 0.3;
  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      const tone = 0.72 + height(x, y) * 0.5;
      const offset = (y * size + x) * 4;
      image.data[offset] = Math.min(255, base.r * 255 * tone);
      image.data[offset + 1] = Math.min(255, base.g * 255 * tone);
      image.data[offset + 2] = Math.min(255, base.b * 255 * tone);
      image.data[offset + 3] = 255;
    }
  }
  context.putImageData(image, 0, 0);
  return { albedo: toTexture(canvas, true), normal: heightToNormalTexture(height, size, 16) };
}

// Wrap a repeat-scale helper so plaza/rock maps size in world metres.
export function setWorldRepeat(texture: THREE.Texture, metresPerTile: number, worldSize: number): void {
  const repeat = Math.max(1, Math.round(worldSize / metresPerTile));
  texture.repeat.set(repeat, repeat);
}
