import * as THREE from 'three';

/**
 * Procedural PBR texture generator for Tengwang Tower.
 *
 * This module generates albedo, roughness, normal, height, and AO maps
 * procedurally, matching the detail level of Yueyang Tower's sculpt system.
 */

const TILE_RIDGE_STRENGTH = 0.65;
const TILE_SPACING = 0.14;
const WOOD_GRAIN_SCALE = 15.0;
const SURFACE_NOISE_SCALE = 8.0;
export const NORMAL_STRENGTH = 0.8;
export const AO_STRENGTH = 0.5;

function hash(x: number, y: number, seed: number): number {
  let h = Math.sin(x * 127.1 + y * 311.7 + seed * 113.5) * 43758.5453;
  return h - Math.floor(h);
}

function smoothNoise(x: number, y: number, seed: number): number {
  const ix = Math.floor(x);
  const iy = Math.floor(y);
  const fx = x - ix;
  const fy = y - iy;
  const ux = fx * fx * (3 - 2 * fx);
  const uy = fy * fy * (3 - 2 * fy);

  const a = hash(ix, iy, seed);
  const b = hash(ix + 1, iy, seed);
  const c = hash(ix, iy + 1, seed);
  const d = hash(ix + 1, iy + 1, seed);

  return a + (b - a) * ux + (c - a) * uy + (a - b - c + d) * ux * uy;
}

function fbm(x: number, y: number, octaves: number, seed: number): number {
  let value = 0;
  let amplitude = 0.5;
  let frequency = 1;
  let maxValue = 0;
  for (let i = 0; i < octaves; i++) {
    value += amplitude * smoothNoise(x * frequency, y * frequency, seed + i * 100);
    maxValue += amplitude;
    amplitude *= 0.5;
    frequency *= 2;
  }
  return value / maxValue;
}

export interface TengwangProceduralTextures {
  albedo: THREE.Texture;
  roughness: THREE.Texture;
  normal: THREE.Texture;
  height: THREE.Texture;
  ao: THREE.Texture;
}

function createCanvas(size: number): HTMLCanvasElement {
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  return canvas;
}

export function generateTengwangRoofTextures(baseColorHex: string, size = 1024): TengwangProceduralTextures {
  const albedoCanvas = createCanvas(size);
  const roughnessCanvas = createCanvas(size);
  const normalCanvas = createCanvas(size);
  const heightCanvas = createCanvas(size);
  const aoCanvas = createCanvas(size);

  const albedoCtx = albedoCanvas.getContext('2d')!;
  const roughnessCtx = roughnessCanvas.getContext('2d')!;
  const normalCtx = normalCanvas.getContext('2d')!;
  const heightCtx = heightCanvas.getContext('2d')!;
  const aoCtx = aoCanvas.getContext('2d')!;

  const baseColor = new THREE.Color(baseColorHex);

  const albedoData = albedoCtx.createImageData(size, size);
  const roughnessData = roughnessCtx.createImageData(size, size);
  const normalData = normalCtx.createImageData(size, size);
  const heightData = heightCtx.createImageData(size, size);
  const aoData = aoCtx.createImageData(size, size);

  const tileWidth = TILE_SPACING * size;

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const idx = (y * size + x) * 4;

      // Tile ridge pattern
      const tilePhase = (x / tileWidth) % 1;
      const ridge = 0.5 + 0.5 * Math.sin(tilePhase * Math.PI * 2);
      const ridgeFactor = 0.7 + 0.3 * ridge;

      // Surface noise for micro-detail
      const nx = x / size * SURFACE_NOISE_SCALE;
      const ny = y / size * SURFACE_NOISE_SCALE;
      const noise = fbm(nx, ny, 4, 42);
      const microDetail = 0.9 + 0.2 * noise;

      // Height field
      const heightValue = ridgeFactor * 0.6 + microDetail * 0.4;

      // Albedo with color variation
      const colorVar = 0.92 + 0.16 * noise;
      const albedoR = Math.min(255, baseColor.r * 255 * colorVar * ridgeFactor);
      const albedoG = Math.min(255, baseColor.g * 255 * colorVar * ridgeFactor);
      const albedoB = Math.min(255, baseColor.b * 255 * colorVar * ridgeFactor);

      albedoData.data[idx] = albedoR;
      albedoData.data[idx + 1] = albedoG;
      albedoData.data[idx + 2] = albedoB;
      albedoData.data[idx + 3] = 255;

      // Roughness variation
      const roughBase = 0.55;
      const roughVar = 0.15 * noise + 0.1 * (1 - ridgeFactor);
      const roughnessValue = Math.min(1, roughBase + roughVar);
      roughnessData.data[idx] = Math.floor(roughnessValue * 255);
      roughnessData.data[idx + 1] = Math.floor(roughnessValue * 255);
      roughnessData.data[idx + 2] = Math.floor(roughnessValue * 255);
      roughnessData.data[idx + 3] = 255;

      // Height
      heightData.data[idx] = Math.floor(heightValue * 255);
      heightData.data[idx + 1] = Math.floor(heightValue * 255);
      heightData.data[idx + 2] = Math.floor(heightValue * 255);
      heightData.data[idx + 3] = 255;

      // Normal map (tile ridge + micro bumps)
      const dx = (fbm(nx + 0.01, ny, 4, 42) - fbm(nx - 0.01, ny, 4, 42)) * NORMAL_STRENGTH;
      const dy = (fbm(nx, ny + 0.01, 4, 42) - fbm(nx, ny - 0.01, 4, 42)) * NORMAL_STRENGTH;
      const dz = 1.0;
      const invLen = 1 / Math.sqrt(dx * dx + dy * dy + dz * dz);
      normalData.data[idx] = Math.floor((dx * invLen * 0.5 + 0.5) * 255);
      normalData.data[idx + 1] = Math.floor((dy * invLen * 0.5 + 0.5) * 255);
      normalData.data[idx + 2] = Math.floor((dz * invLen * 0.5 + 0.5) * 255);
      normalData.data[idx + 3] = 255;

      // AO (cavities between tiles)
      const ao = 0.85 + 0.15 * ridgeFactor;
      aoData.data[idx] = Math.floor(ao * 255);
      aoData.data[idx + 1] = Math.floor(ao * 255);
      aoData.data[idx + 2] = Math.floor(ao * 255);
      aoData.data[idx + 3] = 255;
    }
  }

  albedoCtx.putImageData(albedoData, 0, 0);
  roughnessCtx.putImageData(roughnessData, 0, 0);
  normalCtx.putImageData(normalData, 0, 0);
  heightCtx.putImageData(heightData, 0, 0);
  aoCtx.putImageData(aoData, 0, 0);

  return {
    albedo: createTexture(albedoCanvas, THREE.SRGBColorSpace),
    roughness: createTexture(roughnessCanvas, THREE.NoColorSpace),
    normal: createTexture(normalCanvas, THREE.NoColorSpace),
    height: createTexture(heightCanvas, THREE.NoColorSpace),
    ao: createTexture(aoCanvas, THREE.NoColorSpace),
  };
}

export function generateTengwangWoodTextures(baseColorHex: string, size = 1024): TengwangProceduralTextures {
  const albedoCanvas = createCanvas(size);
  const roughnessCanvas = createCanvas(size);
  const normalCanvas = createCanvas(size);
  const heightCanvas = createCanvas(size);
  const aoCanvas = createCanvas(size);

  const albedoCtx = albedoCanvas.getContext('2d')!;
  const roughnessCtx = roughnessCanvas.getContext('2d')!;
  const normalCtx = normalCanvas.getContext('2d')!;
  const heightCtx = heightCanvas.getContext('2d')!;
  const aoCtx = aoCanvas.getContext('2d')!;

  const baseColor = new THREE.Color(baseColorHex);

  const albedoData = albedoCtx.createImageData(size, size);
  const roughnessData = roughnessCtx.createImageData(size, size);
  const normalData = normalCtx.createImageData(size, size);
  const heightData = heightCtx.createImageData(size, size);
  const aoData = aoCtx.createImageData(size, size);

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const idx = (y * size + x) * 4;

      // Wood grain pattern
      const nx = x / size * WOOD_GRAIN_SCALE;
      const ny = y / size * WOOD_GRAIN_SCALE;
      const grain = Math.sin(ny * 20 + fbm(nx, ny, 3, 7) * 3) * 0.5 + 0.5;
      const grainDetail = fbm(nx * 2, ny * 2, 2, 13);

      // Height field (wood grain relief)
      const heightValue = grain * 0.5 + grainDetail * 0.3;

      // Albedo with wood grain color variation
      const colorVar = 0.88 + 0.24 * grain;
      const albedoR = Math.min(255, baseColor.r * 255 * colorVar);
      const albedoG = Math.min(255, baseColor.g * 255 * colorVar);
      const albedoB = Math.min(255, baseColor.b * 255 * colorVar);

      albedoData.data[idx] = albedoR;
      albedoData.data[idx + 1] = albedoG;
      albedoData.data[idx + 2] = albedoB;
      albedoData.data[idx + 3] = 255;

      // Roughness variation
      const roughBase = 0.65;
      const roughVar = 0.2 * grainDetail;
      const roughnessValue = Math.min(1, roughBase + roughVar);
      roughnessData.data[idx] = Math.floor(roughnessValue * 255);
      roughnessData.data[idx + 1] = Math.floor(roughnessValue * 255);
      roughnessData.data[idx + 2] = Math.floor(roughnessValue * 255);
      roughnessData.data[idx + 3] = 255;

      // Height
      heightData.data[idx] = Math.floor(heightValue * 255);
      heightData.data[idx + 1] = Math.floor(heightValue * 255);
      heightData.data[idx + 2] = Math.floor(heightValue * 255);
      heightData.data[idx + 3] = 255;

      // Normal map (wood grain relief)
      const dx = (fbm(nx + 0.02, ny, 3, 7) - fbm(nx - 0.02, ny, 3, 7)) * NORMAL_STRENGTH;
      const dy = (fbm(nx, ny + 0.02, 3, 7) - fbm(nx, ny - 0.02, 3, 7)) * NORMAL_STRENGTH;
      const dz = 1.0;
      const invLen = 1 / Math.sqrt(dx * dx + dy * dy + dz * dz);
      normalData.data[idx] = Math.floor((dx * invLen * 0.5 + 0.5) * 255);
      normalData.data[idx + 1] = Math.floor((dy * invLen * 0.5 + 0.5) * 255);
      normalData.data[idx + 2] = Math.floor((dz * invLen * 0.5 + 0.5) * 255);
      normalData.data[idx + 3] = 255;

      // AO (cracks between wood planks)
      const ao = 0.8 + 0.2 * grain;
      aoData.data[idx] = Math.floor(ao * 255);
      aoData.data[idx + 1] = Math.floor(ao * 255);
      aoData.data[idx + 2] = Math.floor(ao * 255);
      aoData.data[idx + 3] = 255;
    }
  }

  albedoCtx.putImageData(albedoData, 0, 0);
  roughnessCtx.putImageData(roughnessData, 0, 0);
  normalCtx.putImageData(normalData, 0, 0);
  heightCtx.putImageData(heightData, 0, 0);
  aoCtx.putImageData(aoData, 0, 0);

  return {
    albedo: createTexture(albedoCanvas, THREE.SRGBColorSpace),
    roughness: createTexture(roughnessCanvas, THREE.NoColorSpace),
    normal: createTexture(normalCanvas, THREE.NoColorSpace),
    height: createTexture(heightCanvas, THREE.NoColorSpace),
    ao: createTexture(aoCanvas, THREE.NoColorSpace),
  };
}

export function generateTengwangWallTextures(baseColorHex: string, size = 1024): TengwangProceduralTextures {
  const albedoCanvas = createCanvas(size);
  const roughnessCanvas = createCanvas(size);
  const normalCanvas = createCanvas(size);
  const heightCanvas = createCanvas(size);
  const aoCanvas = createCanvas(size);

  const albedoCtx = albedoCanvas.getContext('2d')!;
  const roughnessCtx = roughnessCanvas.getContext('2d')!;
  const normalCtx = normalCanvas.getContext('2d')!;
  const heightCtx = heightCanvas.getContext('2d')!;
  const aoCtx = aoCanvas.getContext('2d')!;

  const baseColor = new THREE.Color(baseColorHex);

  const albedoData = albedoCtx.createImageData(size, size);
  const roughnessData = roughnessCtx.createImageData(size, size);
  const normalData = normalCtx.createImageData(size, size);
  const heightData = heightCtx.createImageData(size, size);
  const aoData = aoCtx.createImageData(size, size);

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const idx = (y * size + x) * 4;

      // Plaster wall with subtle variation
      const nx = x / size * SURFACE_NOISE_SCALE;
      const ny = y / size * SURFACE_NOISE_SCALE;
      const noise = fbm(nx, ny, 3, 99);
      const microCracks = fbm(nx * 4, ny * 4, 2, 77);

      // Height field
      const heightValue = noise * 0.3 + microCracks * 0.1;

      // Albedo with plaster variation
      const colorVar = 0.94 + 0.12 * noise;
      const albedoR = Math.min(255, baseColor.r * 255 * colorVar);
      const albedoG = Math.min(255, baseColor.g * 255 * colorVar);
      const albedoB = Math.min(255, baseColor.b * 255 * colorVar);

      albedoData.data[idx] = albedoR;
      albedoData.data[idx + 1] = albedoG;
      albedoData.data[idx + 2] = albedoB;
      albedoData.data[idx + 3] = 255;

      // Roughness
      const roughBase = 0.75;
      const roughVar = 0.15 * microCracks;
      const roughnessValue = Math.min(1, roughBase + roughVar);
      roughnessData.data[idx] = Math.floor(roughnessValue * 255);
      roughnessData.data[idx + 1] = Math.floor(roughnessValue * 255);
      roughnessData.data[idx + 2] = Math.floor(roughnessValue * 255);
      roughnessData.data[idx + 3] = 255;

      // Height
      heightData.data[idx] = Math.floor(heightValue * 255);
      heightData.data[idx + 1] = Math.floor(heightValue * 255);
      heightData.data[idx + 2] = Math.floor(heightValue * 255);
      heightData.data[idx + 3] = 255;

      // Normal (subtle bumps)
      const dx = (fbm(nx + 0.01, ny, 3, 99) - fbm(nx - 0.01, ny, 3, 99)) * NORMAL_STRENGTH * 0.6;
      const dy = (fbm(nx, ny + 0.01, 3, 99) - fbm(nx, ny - 0.01, 3, 99)) * NORMAL_STRENGTH * 0.6;
      const dz = 1.0;
      const invLen = 1 / Math.sqrt(dx * dx + dy * dy + dz * dz);
      normalData.data[idx] = Math.floor((dx * invLen * 0.5 + 0.5) * 255);
      normalData.data[idx + 1] = Math.floor((dy * invLen * 0.5 + 0.5) * 255);
      normalData.data[idx + 2] = Math.floor((dz * invLen * 0.5 + 0.5) * 255);
      normalData.data[idx + 3] = 255;

      // AO
      const ao = 0.88 + 0.12 * noise;
      aoData.data[idx] = Math.floor(ao * 255);
      aoData.data[idx + 1] = Math.floor(ao * 255);
      aoData.data[idx + 2] = Math.floor(ao * 255);
      aoData.data[idx + 3] = 255;
    }
  }

  albedoCtx.putImageData(albedoData, 0, 0);
  roughnessCtx.putImageData(roughnessData, 0, 0);
  normalCtx.putImageData(normalData, 0, 0);
  heightCtx.putImageData(heightData, 0, 0);
  aoCtx.putImageData(aoData, 0, 0);

  return {
    albedo: createTexture(albedoCanvas, THREE.SRGBColorSpace),
    roughness: createTexture(roughnessCanvas, THREE.NoColorSpace),
    normal: createTexture(normalCanvas, THREE.NoColorSpace),
    height: createTexture(heightCanvas, THREE.NoColorSpace),
    ao: createTexture(aoCanvas, THREE.NoColorSpace),
  };
}

function createTexture(canvas: HTMLCanvasElement, colorSpace: THREE.ColorSpace): THREE.CanvasTexture {
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = colorSpace;
  texture.wrapS = THREE.RepeatWrapping;
  texture.wrapT = THREE.RepeatWrapping;
  texture.anisotropy = 8;
  texture.needsUpdate = true;
  return texture;
}
