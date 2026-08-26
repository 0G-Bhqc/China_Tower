import * as THREE from 'three';
import { RoomEnvironment } from 'three/examples/jsm/environments/RoomEnvironment.js';
import { EffectComposer } from 'three/examples/jsm/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/examples/jsm/postprocessing/RenderPass.js';
import { BokehPass } from 'three/examples/jsm/postprocessing/BokehPass.js';
import { UnrealBloomPass } from 'three/examples/jsm/postprocessing/UnrealBloomPass.js';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';

export type ProceduralModelOptions = {
  wireframe?: boolean;
  castShadow?: boolean;
  receiveShadow?: boolean;
  textureSize?: number;
  textureAnisotropy?: number;
  qualityPriority?: 'reference-fidelity' | 'balanced';
};

export type ProceduralModelRuntime = {
  nodes: Record<string, THREE.Object3D>;
  meshes: Record<string, THREE.Mesh>;
  sockets: Record<string, THREE.Object3D>;
  colliders: Record<string, unknown>;
  destructionGroups: Record<string, THREE.Object3D[]>;
};

type SculptMaterialSpec = Record<string, any>;

// bevelEnabled defaults to true on THREE.ExtrudeGeometry and rounds every
// corner — sharp/pointed profiles (blades, fork tines, spikes) need
// bevelEnabled: false plus lineTo()-only path segments near the tip, since a
// curve command cannot produce a true converging point.
function buildExtrudeShape(points: [number, number][], holes?: [number, number][][]): THREE.Shape {
  const shape = new THREE.Shape();
  if (points.length > 0) {
    shape.moveTo(points[0][0], points[0][1]);
    for (let i = 1; i < points.length; i += 1) {
      shape.lineTo(points[i][0], points[i][1]);
    }
  }
  // Cutouts (e.g. an oval wire-cutter hole) as THREE.Path added to shape.holes —
  // dep-free boolean subtraction via the tessellator, no CSG library needed.
  for (const loop of holes ?? []) {
    if (loop.length < 3) continue;
    const path = new THREE.Path();
    path.moveTo(loop[0][0], loop[0][1]);
    for (let i = 1; i < loop.length; i += 1) path.lineTo(loop[i][0], loop[i][1]);
    path.closePath();
    shape.holes.push(path);
  }
  return shape;
}

// Build an N-gon oval loop (for hole authoring from a compact {cx,cy,rx,ry} descriptor).
function ovalLoop(cx: number, cy: number, rx: number, ry: number, seg = 24): [number, number][] {
  const loop: [number, number][] = [];
  for (let i = 0; i < seg; i += 1) {
    const a = (i / seg) * Math.PI * 2;
    loop.push([cx + Math.cos(a) * rx, cy + Math.sin(a) * ry]);
  }
  return loop;
}

function buildExtrudeGeometry(profile: { points: [number, number][]; depth: number; holes?: [number, number][][]; ovalHoles?: { cx: number; cy: number; rx: number; ry: number }[] }): THREE.ExtrudeGeometry {
  const holes = [...(profile.holes ?? []), ...((profile.ovalHoles ?? []).map((o) => ovalLoop(o.cx, o.cy, o.rx, o.ry)))];
  const shape = buildExtrudeShape(profile.points, holes);
  return new THREE.ExtrudeGeometry(shape, {
    depth: profile.depth,
    bevelEnabled: false,
    steps: 1,
  });
}

function buildLatheGeometry(profile: { points: [number, number][]; segments?: number }): THREE.LatheGeometry {
  const points = profile.points.map(([x, y]) => new THREE.Vector2(Math.max(0.0001, x), y));
  return new THREE.LatheGeometry(points, profile.segments ?? 24);
}


function buildHelmetRoofGeometry(segments = 40): THREE.BufferGeometry {
  const stride = segments + 1;
  const positions: number[] = [];
  const uvs: number[] = [];
  const indices: number[] = [];
  const shellThickness = 0.07;
  const heightAt = (u: number, v: number): number => {
    const nx = Math.abs(u * 2 - 1);
    const nz = Math.abs(v * 2 - 1);
    const ring = Math.max(nx, nz);
    const eased = ring * ring * (3 - 2 * ring);
    return THREE.MathUtils.lerp(0.36, -0.23, eased) + 0.22 * Math.pow(nx * nz, 2.4);
  };
  for (let layer = 0; layer < 2; layer += 1) {
    for (let z = 0; z <= segments; z += 1) {
      const v = z / segments;
      for (let x = 0; x <= segments; x += 1) {
        const u = x / segments;
        positions.push(u - 0.5, heightAt(u, v) - layer * shellThickness, v);
        uvs.push(u, v);
      }
    }
  }
  const offset = stride * stride;
  for (let z = 0; z < segments; z += 1) {
    for (let x = 0; x < segments; x += 1) {
      const a = z * stride + x, b = a + 1, c = a + stride, d = c + 1;
      indices.push(a, c, b, b, c, d, a + offset, b + offset, c + offset, b + offset, d + offset, c + offset);
    }
  }
  const perimeter: number[] = [];
  for (let x = 0; x <= segments; x += 1) perimeter.push(x);
  for (let z = 1; z <= segments; z += 1) perimeter.push(z * stride + segments);
  for (let x = segments - 1; x >= 0; x -= 1) perimeter.push(segments * stride + x);
  for (let z = segments - 1; z > 0; z -= 1) perimeter.push(z * stride);
  for (let i = 0; i < perimeter.length; i += 1) {
    const a = perimeter[i], b = perimeter[(i + 1) % perimeter.length];
    indices.push(a, b + offset, a + offset, a, b, b + offset);
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geometry.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
  geometry.setIndex(indices);
  geometry.computeVertexNormals();
  geometry.computeBoundingBox();
  geometry.computeBoundingSphere();
  return geometry;
}

function hashString(value: string): number {
  let hash = 2166136261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

function readLayerNumber(value: unknown, keys: string[], fallback: number): number {
  if (typeof value === 'number') return value;
  if (value && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    for (const key of keys) {
      if (typeof record[key] === 'number') return record[key] as number;
    }
  }
  return fallback;
}

function hexToRgb(hex: string): [number, number, number] {
  const normalized = /^#[0-9a-f]{3}$/i.test(hex)
    ? '#' + hex.slice(1).split('').map((part) => part + part).join('')
    : hex;
  const value = /^#[0-9a-f]{6}$/i.test(normalized) ? Number.parseInt(normalized.slice(1), 16) : 0x8a7a5f;
  return [clampAlbedoChannel((value >> 16) & 255), clampAlbedoChannel((value >> 8) & 255), clampAlbedoChannel(value & 255)];
}

function materialPalette(spec: SculptMaterialSpec): string[] {
  const palette = spec.colorVariation?.palette;
  if (Array.isArray(palette) && palette.length > 0) return palette.filter((value) => typeof value === 'string');
  const secondary = spec.albedo?.secondary;
  const colors = [spec.baseColor ?? spec.color ?? spec.albedo?.dominant, ...(Array.isArray(secondary) ? secondary : [])];
  return colors.filter((value): value is string => typeof value === 'string' && value.startsWith('#'));
}

function clamp01(value: number): number {
  return Math.max(0, Math.min(1, value));
}

function clampAlbedoChannel(value: number): number {
  return Math.max(30, Math.min(240, Math.round(value)));
}

function clampPbrF0(value: number): number {
  return Math.max(0.02, Math.min(1, value));
}

function clampPbrIor(value: number): number {
  return Math.max(1, Math.min(2.5, value));
}

function clampPbrMetalness(value: number): number {
  return value >= 0.5 ? 1 : 0;
}

function clampedAlbedoColor(spec: SculptMaterialSpec): THREE.Color {
  const source = typeof spec.baseColor === 'string' ? spec.baseColor : '#8A7A5F';
  const [red, green, blue] = hexToRgb(source);
  return new THREE.Color(red / 255, green / 255, blue / 255);
}

function smoothCurve(value: number): number {
  return value * value * (3 - 2 * value);
}

function periodicHash(x: number, y: number, seed: number, periodX: number, periodY: number): number {
  const wrappedX = ((x % periodX) + periodX) % periodX;
  const wrappedY = ((y % periodY) + periodY) % periodY;
  let value = Math.imul(wrappedX + seed * 17, 374761393) ^ Math.imul(wrappedY + seed * 31, 668265263);
  value = Math.imul(value ^ (value >>> 13), 1274126177);
  return ((value ^ (value >>> 16)) >>> 0) / 4294967295;
}

function periodicValueNoise(u: number, v: number, seed: number, periodX: number, periodY: number): number {
  const x = u * periodX;
  const y = v * periodY;
  const x0 = Math.floor(x);
  const y0 = Math.floor(y);
  const tx = smoothCurve(x - x0);
  const ty = smoothCurve(y - y0);
  const a = periodicHash(x0, y0, seed, periodX, periodY);
  const b = periodicHash(x0 + 1, y0, seed, periodX, periodY);
  const c = periodicHash(x0, y0 + 1, seed, periodX, periodY);
  const d = periodicHash(x0 + 1, y0 + 1, seed, periodX, periodY);
  return THREE.MathUtils.lerp(THREE.MathUtils.lerp(a, b, tx), THREE.MathUtils.lerp(c, d, tx), ty);
}

type SurfaceBand = {
  frequency: number;
  amplitude: number;
  stretchX: number;
  stretchY: number;
  ridge: boolean;
};

function surfaceBands(spec: SculptMaterialSpec): SurfaceBand[] {
  const source = Array.isArray(spec.surfaceFrequencyBands) ? spec.surfaceFrequencyBands : [];
  const parsed = source.flatMap((item: unknown) => {
    if (!item || typeof item !== 'object') return [];
    const band = item as Record<string, unknown>;
    const frequency = typeof band.frequency === 'number' ? band.frequency : 0;
    const amplitude = typeof band.amplitude === 'number' ? band.amplitude : 0;
    if (frequency <= 0 || amplitude <= 0) return [];
    const stretch = Array.isArray(band.stretch) ? band.stretch : [1, 1];
    const description = `${String(band.pattern ?? '')} ${String(band.role ?? '')}`.toLowerCase();
    return [{
      frequency,
      amplitude,
      stretchX: typeof stretch[0] === 'number' ? Math.max(0.1, stretch[0]) : 1,
      stretchY: typeof stretch[1] === 'number' ? Math.max(0.1, stretch[1]) : 1,
      ridge: /(ridge|groove|grain|fiber|striated|crack)/.test(description),
    }];
  });
  return parsed.length > 0 ? parsed : [
    { frequency: 2, amplitude: 0.42, stretchX: 1, stretchY: 1, ridge: false },
    { frequency: 12, amplitude: 0.22, stretchX: 1, stretchY: 1, ridge: false },
    { frequency: 56, amplitude: 0.08, stretchX: 1, stretchY: 1, ridge: false },
  ];
}

function sampleSurface(u: number, v: number, bands: SurfaceBand[], seed: number): number {
  let value = 0;
  let weight = 0;
  for (let index = 0; index < bands.length; index += 1) {
    const band = bands[index];
    const periodX = Math.max(1, Math.round(band.frequency * band.stretchX));
    const periodY = Math.max(1, Math.round(band.frequency * band.stretchY));
    let sample = periodicValueNoise(u, v, seed + index * 1013, periodX, periodY);
    if (band.ridge) sample = 1 - Math.abs(sample * 2 - 1);
    value += sample * band.amplitude;
    weight += band.amplitude;
  }
  return weight > 0 ? clamp01(value / weight) : 0.5;
}

function mixPalette(colors: [number, number, number][], value: number): [number, number, number] {
  if (colors.length === 1) return colors[0];
  const scaled = clamp01(value) * (colors.length - 1);
  const index = Math.min(colors.length - 2, Math.floor(scaled));
  const mix = scaled - index;
  const a = colors[index];
  const b = colors[index + 1];
  return [
    Math.round(THREE.MathUtils.lerp(a[0], b[0], mix)),
    Math.round(THREE.MathUtils.lerp(a[1], b[1], mix)),
    Math.round(THREE.MathUtils.lerp(a[2], b[2], mix)),
  ];
}

type ColorGradientStop = { offset: number; color: string };
type ColorGradientSpec = {
  type: 'linear' | 'radial';
  axis: [number, number];
  stops: ColorGradientStop[];
};

function parseRgba(value: string): [number, number, number] {
  const match = /rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)/.exec(value);
  if (!match) return [138, 122, 95];
  return [clampAlbedoChannel(Number(match[1])), clampAlbedoChannel(Number(match[2])), clampAlbedoChannel(Number(match[3]))];
}

// Analytical per-pixel gradient sample. The extraction schema's colorGradient carries
// exact rgba(...) stop colors (see extract_part_color_recipe.py), so this samples the
// same trend directly in JS math rather than round-tripping through a Canvas 2D
// createLinearGradient/createRadialGradient object — same visual result, and it composes
// directly with the existing noise/height-correlated colorVariation blend below.
function sampleColorGradient(gradient: ColorGradientSpec, u: number, v: number): [number, number, number] {
  const stops = gradient.stops.length >= 2 ? gradient.stops : [{ offset: 0, color: 'rgba(138,122,95,1)' }, { offset: 1, color: 'rgba(138,122,95,1)' }];
  let t: number;
  if (gradient.type === 'radial') {
    const [cx, cy] = gradient.axis;
    const dx = u - cx;
    const dy = v - cy;
    const maxRadius = Math.max(0.001, Math.hypot(Math.max(cx, 1 - cx), Math.max(cy, 1 - cy)));
    t = clamp01(Math.hypot(dx, dy) / maxRadius);
  } else {
    const [ax, ay] = gradient.axis;
    const projection = (u - 0.5) * ax + (v - 0.5) * ay;
    const maxProjection = 0.5 * (Math.abs(ax) + Math.abs(ay)) || 0.5;
    t = clamp01(projection / maxProjection + 0.5);
  }
  const scaled = t * (stops.length - 1);
  const index = Math.min(stops.length - 2, Math.max(0, Math.floor(scaled)));
  const mix = scaled - index;
  const a = parseRgba(stops[index].color);
  const b = parseRgba(stops[index + 1].color);
  return [
    THREE.MathUtils.lerp(a[0], b[0], mix),
    THREE.MathUtils.lerp(a[1], b[1], mix),
    THREE.MathUtils.lerp(a[2], b[2], mix),
  ];
}

function writePixel(data: Uint8ClampedArray, offset: number, red: number, green: number, blue: number): void {
  data[offset] = Math.max(0, Math.min(255, Math.round(red)));
  data[offset + 1] = Math.max(0, Math.min(255, Math.round(green)));
  data[offset + 2] = Math.max(0, Math.min(255, Math.round(blue)));
  data[offset + 3] = 255;
}

function makeCanvas(size: number): HTMLCanvasElement {
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  return canvas;
}

function createMapTexture(
  canvas: HTMLCanvasElement,
  colorSpace: THREE.ColorSpace,
  spec: SculptMaterialSpec,
  options: ProceduralModelOptions,
): THREE.CanvasTexture {
  const texture = new THREE.CanvasTexture(canvas);
  const projection = spec.textureProjection && typeof spec.textureProjection === 'object' ? spec.textureProjection : {};
  const repeat = Array.isArray(projection.repeat) ? projection.repeat : [2, 2];
  texture.colorSpace = colorSpace;
  texture.wrapS = THREE.RepeatWrapping;
  texture.wrapT = THREE.RepeatWrapping;
  texture.repeat.set(
    typeof repeat[0] === 'number' ? repeat[0] : 2,
    typeof repeat[1] === 'number' ? repeat[1] : 2,
  );
  texture.anisotropy = Math.max(1, Math.round(options.textureAnisotropy ?? projection.anisotropy ?? 8));
  texture.needsUpdate = true;
  return texture;
}

type ProceduralTextureSet = {
  albedo: THREE.Texture;
  roughness: THREE.Texture;
  height: THREE.Texture;
  normal: THREE.Texture;
  ao: THREE.Texture;
  source: 'reference-pixel-extraction' | 'procedural';
};

function referenceMapUrl(spec: SculptMaterialSpec, channel: string): string | null {
  const reference = spec.referencePbr;
  if (!reference || typeof reference !== 'object') return null;
  if (reference.usable === false) return null;
  const confidence = typeof reference.confidence === 'number'
    ? reference.confidence
    : (typeof reference.estimatedFidelity === 'number' ? reference.estimatedFidelity : 0);
  const threshold = typeof reference.targetThreshold === 'number' ? reference.targetThreshold : 0.7;
  if (confidence < threshold) return null;
  const maps = reference.maps;
  if (!maps || typeof maps !== 'object') return null;
  const map = (maps as Record<string, unknown>)[channel];
  if (!map || typeof map !== 'object') return null;
  const record = map as Record<string, unknown>;
  const url = typeof record.url === 'string' && record.url.trim() ? record.url : record.path;
  return typeof url === 'string' && url.trim() ? url : null;
}

function createLoadedMapTexture(
  url: string,
  colorSpace: THREE.ColorSpace,
  spec: SculptMaterialSpec,
  options: ProceduralModelOptions,
): THREE.Texture {
  const texture = new THREE.TextureLoader().load(url);
  const projection = spec.textureProjection && typeof spec.textureProjection === 'object' ? spec.textureProjection : {};
  const repeat = Array.isArray(projection.repeat) ? projection.repeat : [1, 1];
  texture.colorSpace = colorSpace;
  texture.wrapS = THREE.RepeatWrapping;
  texture.wrapT = THREE.RepeatWrapping;
  texture.repeat.set(
    typeof repeat[0] === 'number' ? repeat[0] : 1,
    typeof repeat[1] === 'number' ? repeat[1] : 1,
  );
  texture.anisotropy = Math.max(1, Math.round(options.textureAnisotropy ?? projection.anisotropy ?? 8));
  texture.needsUpdate = true;
  return texture;
}

function makeReferenceTextureSet(spec: SculptMaterialSpec, options: ProceduralModelOptions): ProceduralTextureSet | null {
  const albedo = referenceMapUrl(spec, 'albedo');
  const roughness = referenceMapUrl(spec, 'roughness');
  const height = referenceMapUrl(spec, 'height');
  const normal = referenceMapUrl(spec, 'normal');
  const ao = referenceMapUrl(spec, 'ao');
  if (!albedo || !roughness || !height || !normal || !ao) return null;
  return {
    albedo: createLoadedMapTexture(albedo, THREE.SRGBColorSpace, spec, options),
    roughness: createLoadedMapTexture(roughness, THREE.NoColorSpace, spec, options),
    height: createLoadedMapTexture(height, THREE.NoColorSpace, spec, options),
    normal: createLoadedMapTexture(normal, THREE.NoColorSpace, spec, options),
    ao: createLoadedMapTexture(ao, THREE.NoColorSpace, spec, options),
    source: 'reference-pixel-extraction',
  };
}

function makeProceduralTextureSet(
  id: string,
  spec: SculptMaterialSpec,
  options: ProceduralModelOptions,
): ProceduralTextureSet | null {
  if (typeof document === 'undefined') return null;
  const qualityFirst = (options.qualityPriority ?? 'reference-fidelity') === 'reference-fidelity';
  const requested = options.textureSize ?? spec.textureResolution;
  const requestedSize = typeof requested === 'number' && Number.isFinite(requested)
    ? requested
    : (qualityFirst ? 1024 : 512);
  const size = Math.max(256, Math.min(2048, 2 ** Math.round(Math.log2(requestedSize))));
  const canvases = {
    albedo: makeCanvas(size),
    roughness: makeCanvas(size),
    height: makeCanvas(size),
    normal: makeCanvas(size),
    ao: makeCanvas(size),
  };
  const contexts = {
    albedo: canvases.albedo.getContext('2d'),
    roughness: canvases.roughness.getContext('2d'),
    height: canvases.height.getContext('2d'),
    normal: canvases.normal.getContext('2d'),
    ao: canvases.ao.getContext('2d'),
  };
  if (!contexts.albedo || !contexts.roughness || !contexts.height || !contexts.normal || !contexts.ao) return null;
  const images = {
    albedo: contexts.albedo.createImageData(size, size),
    roughness: contexts.roughness.createImageData(size, size),
    height: contexts.height.createImageData(size, size),
    normal: contexts.normal.createImageData(size, size),
    ao: contexts.ao.createImageData(size, size),
  };
  const seed = hashString(id);
  const bands = surfaceBands(spec);
  const heightField = new Float32Array(size * size);
  const roughnessField = new Float32Array(size * size);
  const palette = materialPalette(spec);
  const fallback = typeof spec.baseColor === 'string' ? spec.baseColor : '#8A7A5F';
  const colors = (palette.length >= 2 ? palette : [fallback, '#6E614B', '#A08F70']).map(hexToRgb);
  const baseRoughness = clamp01(readLayerNumber(spec.roughness, ['base'], 0.76));
  const roughnessVariation = clamp01(readLayerNumber(spec.roughness, ['variation'], 0.18));
  const colorAmplitude = clamp01(readLayerNumber(spec.colorVariation, ['amplitude', 'variation'], 0.18));
  const heightCorrelation = clamp01(readLayerNumber(spec.colorVariation, ['heightCorrelation'], 0.3));
  const colorGradient: ColorGradientSpec | undefined = spec.colorGradient;
  for (let y = 0; y < size; y += 1) {
    const v = y / size;
    for (let x = 0; x < size; x += 1) {
      const u = x / size;
      const index = y * size + x;
      const height = sampleSurface(u, v, bands, seed + 101);
      const roughNoise = sampleSurface(u, v, bands, seed + 7001);
      const colorNoise = sampleSurface(u, v, bands, seed + 15013);
      heightField[index] = height;
      roughnessField[index] = clamp01(baseRoughness + (roughNoise - 0.5) * roughnessVariation * 2);
      let color: [number, number, number];
      if (colorGradient) {
        // Evidence-derived spatial gradient (Plan 1.3 Workstream C) takes priority
        // over the noise-based palette blend below — it is a measured trend, not a guess.
        color = sampleColorGradient(colorGradient, u, v);
      } else {
        const paletteValue = clamp01(
          0.5 + (colorNoise - 0.5) * colorAmplitude * 2 + (height - 0.5) * heightCorrelation
        );
        color = mixPalette(colors, paletteValue);
      }
      writePixel(images.albedo.data, index * 4, color[0], color[1], color[2]);
    }
  }
  const normalStrength = Math.max(0.05, readLayerNumber(spec.normal, ['strength', 'amplitude'], 0.35));
  const aoStrength = clamp01(readLayerNumber(spec.ambientOcclusion, ['cavityStrength', 'strength'], 0.35));
  for (let y = 0; y < size; y += 1) {
    const up = ((y - 1 + size) % size) * size;
    const down = ((y + 1) % size) * size;
    for (let x = 0; x < size; x += 1) {
      const left = (x - 1 + size) % size;
      const right = (x + 1) % size;
      const index = y * size + x;
      const center = heightField[index];
      const dx = (heightField[y * size + right] - heightField[y * size + left]) * normalStrength * 6;
      const dy = (heightField[down + x] - heightField[up + x]) * normalStrength * 6;
      const inverseLength = 1 / Math.sqrt(dx * dx + dy * dy + 1);
      const normalX = -dx * inverseLength;
      const normalY = -dy * inverseLength;
      const normalZ = inverseLength;
      const neighborAverage = (
        heightField[y * size + left] + heightField[y * size + right]
        + heightField[up + x] + heightField[down + x]
      ) * 0.25;
      const cavity = Math.max(0, neighborAverage - center);
      const ao = clamp01(1 - aoStrength * (cavity * 12 + (1 - center) * 0.16));
      const offset = index * 4;
      const heightByte = center * 255;
      const roughnessByte = roughnessField[index] * 255;
      writePixel(images.height.data, offset, heightByte, heightByte, heightByte);
      writePixel(images.roughness.data, offset, roughnessByte, roughnessByte, roughnessByte);
      writePixel(
        images.normal.data, offset,
        (normalX * 0.5 + 0.5) * 255,
        (normalY * 0.5 + 0.5) * 255,
        (normalZ * 0.5 + 0.5) * 255,
      );
      writePixel(images.ao.data, offset, ao * 255, ao * 255, ao * 255);
    }
  }
  contexts.albedo.putImageData(images.albedo, 0, 0);
  contexts.roughness.putImageData(images.roughness, 0, 0);
  contexts.height.putImageData(images.height, 0, 0);
  contexts.normal.putImageData(images.normal, 0, 0);
  contexts.ao.putImageData(images.ao, 0, 0);
  return {
    albedo: createMapTexture(canvases.albedo, THREE.SRGBColorSpace, spec, options),
    roughness: createMapTexture(canvases.roughness, THREE.NoColorSpace, spec, options),
    height: createMapTexture(canvases.height, THREE.NoColorSpace, spec, options),
    normal: createMapTexture(canvases.normal, THREE.NoColorSpace, spec, options),
    ao: createMapTexture(canvases.ao, THREE.NoColorSpace, spec, options),
    source: 'procedural',
  };
}

function createSculptMaterial(id: string, spec: SculptMaterialSpec, options: ProceduralModelOptions, denseComponent = false): THREE.MeshPhysicalMaterial {
  // Reference maps remain audit evidence until clean crops are admitted.
  const textures = makeProceduralTextureSet(id, spec, options);
  const material = new THREE.MeshPhysicalMaterial({
    color: textures ? 0xffffff : clampedAlbedoColor(spec),
    roughness: textures ? 1 : clamp01(readLayerNumber(spec.roughness, ['base'], 0.76)),
    metalness: clampPbrMetalness(readLayerNumber(spec.metalness, ['base'], 0.0)),
    clearcoat: clamp01(readLayerNumber(spec.clearcoat, ['base', 'amount'], 0)),
    clearcoatRoughness: clamp01(readLayerNumber(spec.clearcoatRoughness, ['base'], 0.25)),
    transmission: clamp01(readLayerNumber(spec.transmission, ['base', 'amount'], 0)),
    ior: clampPbrIor(readLayerNumber(spec.ior, ['base', 'value'], 1.5)),
    thickness: Math.max(0, readLayerNumber(spec.thickness, ['base', 'amount'], 0)),
    attenuationDistance: Math.max(0.001, readLayerNumber(spec.attenuationDistance, ['base', 'value'], Infinity)),
    attenuationColor: new THREE.Color(typeof spec.attenuationColor === 'string' ? spec.attenuationColor : '#ffffff'),
    sheen: clamp01(readLayerNumber(spec.sheen, ['base', 'amount'], 0)),
    sheenColor: new THREE.Color(typeof spec.sheenColor === 'string' ? spec.sheenColor : '#ffffff'),
    sheenRoughness: clamp01(readLayerNumber(spec.sheenRoughness, ['base'], 1.0)),
    iridescence: clamp01(readLayerNumber(spec.iridescence, ['base', 'amount'], 0)),
    iridescenceIOR: clampPbrIor(readLayerNumber(spec.iridescenceIOR, ['base', 'value'], 1.3)),
    anisotropy: clamp01(readLayerNumber(spec.anisotropy, ['base', 'amount'], 0)),
    anisotropyRotation: readLayerNumber(spec.anisotropy, ['rotation'], 0),
    specularIntensity: clampPbrF0(readLayerNumber(spec.specularF0 ?? spec.f0 ?? spec.specularIntensity, ['base', 'value'], 1.0)),
    specularColor: new THREE.Color(typeof spec.specularColor === 'string' ? spec.specularColor : '#ffffff'),
    emissive: new THREE.Color(typeof spec.emissive === 'string' ? spec.emissive : '#000000'),
    emissiveIntensity: Math.max(0, readLayerNumber(spec.emissiveIntensity, ['base'], 1.0)),
    opacity: clamp01(readLayerNumber(spec.opacity, ['base'], 1)),
    transparent: readLayerNumber(spec.transmission, ['base', 'amount'], 0) > 0 || readLayerNumber(spec.opacity, ['base'], 1) < 1,
    alphaTest: Math.max(0, readLayerNumber(spec.alpha, ['cutoff', 'alphaTest'], 0)),
    wireframe: options.wireframe ?? false,
    side: spec.doubleSided === true ? THREE.DoubleSide : THREE.FrontSide,
    flatShading: spec.flatShading === true,
  });
  if (textures) {
    material.map = textures.albedo;
    material.roughnessMap = textures.roughness;
    material.normalMap = textures.normal;
    material.normalScale.setScalar(Math.max(0.05, readLayerNumber(spec.normal, ['strength', 'amplitude'], 0.35)));
    material.aoMap = textures.ao;
    material.aoMap.channel = 0;
    material.aoMapIntensity = readLayerNumber(spec.ambientOcclusion, ['cavityStrength', 'strength'], 0.35);
    const denseMesh = denseComponent || spec.denseMesh === true || spec.geometryDensity === 'dense' || spec.topologyClass === 'dense';
    const bumpScale = Math.max(0, readLayerNumber(spec.bump, ['amplitude', 'strength'], 0));
    const effectiveBumpScale = denseMesh ? Math.max(0.05, bumpScale) : bumpScale;
    if (effectiveBumpScale > 0) {
      material.bumpMap = textures.height;
      material.bumpScale = effectiveBumpScale;
    }
    const displacementScale = Math.max(0, readLayerNumber(spec.displacement, ['amplitude', 'strength'], 0));
    const effectiveDisplacementScale = denseMesh ? Math.max(0.005, displacementScale) : displacementScale;
    if (effectiveDisplacementScale > 0) {
      material.displacementMap = textures.height;
      material.displacementScale = effectiveDisplacementScale;
      material.displacementBias = -effectiveDisplacementScale * 0.5;
    }
  }
  material.envMapIntensity = readLayerNumber(spec, ['envMapIntensity'], 0.8);
  material.userData.sculptMaterial = spec;
  material.userData.proceduralMapsIndependent = true;
  material.userData.pbrConstraints = { albedoRange: [30, 240], binaryMetalness: true, f0Range: [0.02, 1], iorRange: [1, 2.5] };
  material.userData.pbrTextureSource = textures?.source ?? 'flat-fallback';
  material.userData.referencePbr = spec.referencePbr ?? null;
  material.userData.referenceMaterialId = spec.referenceMaterialId ?? spec.materialReference?.profileId ?? null;
  material.userData.materialEvidence = spec.materialEvidence ?? null;
  material.userData.validationViews = spec.materialReference?.validationViews ?? [];
  material.needsUpdate = true;
  return material;
}

type AttachmentEndpoint = {
  start: THREE.Vector3;
  midpoint: THREE.Vector3;
  quaternion: THREE.Quaternion;
  length: number;
  baseRadius: number;
  endRadius: number;
};

function readVector3(value: unknown, fallback: [number, number, number]): THREE.Vector3 {
  if (Array.isArray(value) && value.length === 3 && value.every((item) => typeof item === 'number')) {
    return new THREE.Vector3(value[0], value[1], value[2]);
  }
  return new THREE.Vector3(fallback[0], fallback[1], fallback[2]);
}

function readNumber(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

function makeAttachmentEndpoint(attachment: unknown): AttachmentEndpoint | null {
  if (!attachment || typeof attachment !== 'object') return null;
  const record = attachment as Record<string, unknown>;
  const start = readVector3(record.localStart, [0, 0, 0]);
  const end = readVector3(record.localEnd, [0, 1, 0]);
  const delta = end.clone().sub(start);
  const length = delta.length();
  if (length <= 0.0001) return null;
  const direction = delta.clone().normalize();
  const quaternion = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), direction);
  const baseRadius = Math.max(0.005, readNumber(record.baseRadius, 0.06));
  const endRadius = Math.max(0.003, readNumber(record.endRadius, baseRadius * 0.55));
  return {
    start,
    midpoint: delta.multiplyScalar(0.5),
    quaternion,
    length,
    baseRadius,
    endRadius,
  };
}

// Generated from ObjectSculptSpec target: Yueyang Tower
// Sculpt build pass: structural-pass
// This factory is intentionally pass-gated. Finish browser screenshot review before unlocking deeper passes.
export function createYueyangTowerModel(options: ProceduralModelOptions = {}): THREE.Group {
  const root = new THREE.Group();
  root.name = "Yueyang Tower";
  root.userData.reconstructionEvidence = {"itemFamily": null, "subtype": null, "componentAdapter": null, "route": null, "exactnessTier": null, "referenceCamera": {"solved": false, "fovDegrees": 46, "aspect": 1.5007451564828613, "orientation": {"yaw": -28, "pitch": -8, "roll": 0}, "positionHint": [25, 17, 30], "note": "Approximate three-quarter review camera; no projection route. Match by browser overlay before fidelity claims."}, "approximationNotes": []};
  root.userData.materialPipeline = {};
  root.userData.materialReferenceRegistry = null;

  const materialMap: Record<string, THREE.Material> = {};
  materialMap["granite-stone"] = createSculptMaterial(
    "granite-stone",
    {"id": "granite-stone", "name": "Weathered pale granite", "type": "physical", "shaderModel": "MeshPhysicalMaterial", "baseColor": "#8F8C82", "color": "#8F8C82", "albedo": {"dominant": "#8F8C82", "secondary": ["#68664F", "#B4B0A4"], "samplingNotes": "Reference-observed region with contamination limitation recorded in referencePbr."}, "colorVariation": {"palette": ["#8F8C82", "#68664F", "#B4B0A4"], "pattern": "low-amplitude object-space mottling", "amplitude": 0.06, "heightCorrelation": 0.1}, "textureResolution": 1024, "textureProjection": {"mode": "world-units", "repeat": [2, 2], "anisotropy": 8, "texelDensityIntent": "Stable object-scale detail."}, "surfaceFrequencyBands": [{"id": "macro", "frequency": 2, "amplitude": 0.12, "role": "broad value breakup"}, {"id": "meso", "frequency": 12, "amplitude": 0.06, "role": "construction/grain relief"}, {"id": "micro", "frequency": 54, "amplitude": 0.025, "role": "grazing-highlight breakup"}], "roughness": {"base": 0.78, "variation": 0.1, "map": "independent-reference-evidence", "localResponse": "higher in cavities and lower on exposed edges"}, "metalness": {"base": 0, "variation": 0.02}, "normal": {"pattern": "independent-reference-height-derived", "strength": 0.22, "scale": 24, "space": "tangent"}, "bump": {"pattern": "independent fine field", "amplitude": 0.02, "scale": 38}, "displacement": {"pattern": "none for blockout", "amplitude": 0, "scale": 1, "silhouetteAffects": false}, "ambientOcclusion": {"cavityStrength": 0.28, "contactShadowBias": 0.35, "notes": "Construction seams and intersections only."}, "wear": {"edgeWear": 0.02, "scratches": [], "chips": []}, "dirt": {"amount": 0.03, "cavityBias": 0.7, "color": "#211B18"}, "localOverrides": [{"id": "granite-base.course-seams", "region": "platform courses", "roughness": 0.9, "aoStrength": 0.45, "evidenceRefs": ["full-object"]}], "referencePbr": {"version": "1", "sourceImage": "E:\\Station\\China_Tower\\evidence\\yueyang\\detail-zones\\ground-floor.png", "extractor": "img2threejs/extract_pbr_evidence.py", "method": "single-image inferred independent channels", "verdict": "pass-with-crop-contamination-warning", "usable": true, "confidence": 0.909, "estimatedFidelity": 0.909, "targetThreshold": 0.7, "hardLimit": "Evidence maps mix nearby sky/architecture and are audit inputs, not production textures until material-pass crop review.", "maps": {"albedo": {"path": "E:\\Station\\China_Tower\\evidence\\yueyang\\pbr\\granite-stone\\granite-stone_albedo.png", "channel": "albedo", "source": "reference-pixel-extraction"}, "roughness": {"path": "E:\\Station\\China_Tower\\evidence\\yueyang\\pbr\\granite-stone\\granite-stone_roughness.png", "channel": "roughness", "source": "reference-pixel-extraction"}, "height": {"path": "E:\\Station\\China_Tower\\evidence\\yueyang\\pbr\\granite-stone\\granite-stone_height.png", "channel": "height", "source": "reference-pixel-extraction"}, "normal": {"path": "E:\\Station\\China_Tower\\evidence\\yueyang\\pbr\\granite-stone\\granite-stone_normal.png", "channel": "normal", "source": "reference-pixel-extraction"}, "ao": {"path": "E:\\Station\\China_Tower\\evidence\\yueyang\\pbr\\granite-stone\\granite-stone_ao.png", "channel": "ao", "source": "reference-pixel-extraction"}}}, "shaderNotes": ["Keep albedo, roughness, height/normal and AO independent.", "Do not bind extracted evidence maps in blockout; crop contamination must be corrected before material pass."], "secondary": ["#68664F", "#B4B0A4"]},
    options
  );
  materialMap["red-lacquer"] = createSculptMaterial(
    "red-lacquer",
    {"id": "red-lacquer", "name": "Dark red lacquered columns", "type": "physical", "shaderModel": "MeshPhysicalMaterial", "baseColor": "#641A18", "color": "#641A18", "albedo": {"dominant": "#641A18", "secondary": ["#2F1716", "#8C2C27"], "samplingNotes": "Reference-observed region with contamination limitation recorded in referencePbr."}, "colorVariation": {"palette": ["#641A18", "#2F1716", "#8C2C27"], "pattern": "low-amplitude object-space mottling", "amplitude": 0.06, "heightCorrelation": 0.1}, "textureResolution": 1024, "textureProjection": {"mode": "world-units", "repeat": [2, 2], "anisotropy": 8, "texelDensityIntent": "Stable object-scale detail."}, "surfaceFrequencyBands": [{"id": "macro", "frequency": 2, "amplitude": 0.12, "role": "broad value breakup"}, {"id": "meso", "frequency": 12, "amplitude": 0.06, "role": "construction/grain relief"}, {"id": "micro", "frequency": 54, "amplitude": 0.025, "role": "grazing-highlight breakup"}], "roughness": {"base": 0.3, "variation": 0.1, "map": "independent-reference-evidence", "localResponse": "higher in cavities and lower on exposed edges"}, "metalness": {"base": 0, "variation": 0.02}, "normal": {"pattern": "independent-reference-height-derived", "strength": 0.22, "scale": 24, "space": "tangent"}, "bump": {"pattern": "independent fine field", "amplitude": 0.02, "scale": 38}, "displacement": {"pattern": "none for blockout", "amplitude": 0, "scale": 1, "silhouetteAffects": false}, "ambientOcclusion": {"cavityStrength": 0.28, "contactShadowBias": 0.35, "notes": "Construction seams and intersections only."}, "wear": {"edgeWear": 0.02, "scratches": [], "chips": []}, "dirt": {"amount": 0.03, "cavityBias": 0.7, "color": "#211B18"}, "localOverrides": [{"id": "red-lacquer.column-clearcoat", "region": "column crowns and lit vertical bands", "roughness": 0.22, "clearcoat": 0.42, "clearcoatRoughness": 0.24, "evidenceRefs": ["full-object"]}], "referencePbr": {"version": "1", "sourceImage": "E:\\Station\\China_Tower\\evidence\\yueyang\\detail-zones\\ground-floor.png", "extractor": "img2threejs/extract_pbr_evidence.py", "method": "single-image inferred independent channels", "verdict": "pass-with-crop-contamination-warning", "usable": true, "confidence": 0.909, "estimatedFidelity": 0.909, "targetThreshold": 0.7, "hardLimit": "Evidence maps mix nearby sky/architecture and are audit inputs, not production textures until material-pass crop review.", "maps": {"albedo": {"path": "E:\\Station\\China_Tower\\evidence\\yueyang\\pbr\\red-lacquer\\red-lacquer_albedo.png", "channel": "albedo", "source": "reference-pixel-extraction"}, "roughness": {"path": "E:\\Station\\China_Tower\\evidence\\yueyang\\pbr\\red-lacquer\\red-lacquer_roughness.png", "channel": "roughness", "source": "reference-pixel-extraction"}, "height": {"path": "E:\\Station\\China_Tower\\evidence\\yueyang\\pbr\\red-lacquer\\red-lacquer_height.png", "channel": "height", "source": "reference-pixel-extraction"}, "normal": {"path": "E:\\Station\\China_Tower\\evidence\\yueyang\\pbr\\red-lacquer\\red-lacquer_normal.png", "channel": "normal", "source": "reference-pixel-extraction"}, "ao": {"path": "E:\\Station\\China_Tower\\evidence\\yueyang\\pbr\\red-lacquer\\red-lacquer_ao.png", "channel": "ao", "source": "reference-pixel-extraction"}}}, "shaderNotes": ["Keep albedo, roughness, height/normal and AO independent.", "Do not bind extracted evidence maps in blockout; crop contamination must be corrected before material pass."], "secondary": ["#2F1716", "#8C2C27"], "clearcoat": 0.35, "clearcoatRoughness": 0.28},
    options
  );
  materialMap["dark-timber"] = createSculptMaterial(
    "dark-timber",
    {"id": "dark-timber", "name": "Dark stained timber frame", "type": "physical", "shaderModel": "MeshPhysicalMaterial", "baseColor": "#211817", "color": "#211817", "albedo": {"dominant": "#211817", "secondary": ["#4B2D23", "#0E0B0B"], "samplingNotes": "Reference-observed region with contamination limitation recorded in referencePbr."}, "colorVariation": {"palette": ["#211817", "#4B2D23", "#0E0B0B"], "pattern": "low-amplitude object-space mottling", "amplitude": 0.06, "heightCorrelation": 0.1}, "textureResolution": 1024, "textureProjection": {"mode": "world-units", "repeat": [2, 2], "anisotropy": 8, "texelDensityIntent": "Stable object-scale detail."}, "surfaceFrequencyBands": [{"id": "macro", "frequency": 2, "amplitude": 0.12, "role": "broad value breakup"}, {"id": "meso", "frequency": 12, "amplitude": 0.06, "role": "construction/grain relief"}, {"id": "micro", "frequency": 54, "amplitude": 0.025, "role": "grazing-highlight breakup"}], "roughness": {"base": 0.56, "variation": 0.1, "map": "independent-reference-evidence", "localResponse": "higher in cavities and lower on exposed edges"}, "metalness": {"base": 0, "variation": 0.02}, "normal": {"pattern": "independent-reference-height-derived", "strength": 0.22, "scale": 24, "space": "tangent"}, "bump": {"pattern": "independent fine field", "amplitude": 0.02, "scale": 38}, "displacement": {"pattern": "none for blockout", "amplitude": 0, "scale": 1, "silhouetteAffects": false}, "ambientOcclusion": {"cavityStrength": 0.28, "contactShadowBias": 0.35, "notes": "Construction seams and intersections only."}, "wear": {"edgeWear": 0.02, "scratches": [], "chips": []}, "dirt": {"amount": 0.03, "cavityBias": 0.7, "color": "#211B18"}, "localOverrides": [{"id": "dark-timber.cavity-shadow", "region": "under-eave bracket bands", "roughness": 0.72, "dirtAmount": 0.14, "evidenceRefs": ["full-object"]}], "referencePbr": {"version": "1", "sourceImage": "E:\\Station\\China_Tower\\evidence\\yueyang\\detail-zones\\middle-balcony.png", "extractor": "img2threejs/extract_pbr_evidence.py", "method": "single-image inferred independent channels", "verdict": "pass-with-crop-contamination-warning", "usable": true, "confidence": 0.829, "estimatedFidelity": 0.829, "targetThreshold": 0.7, "hardLimit": "Evidence maps mix nearby sky/architecture and are audit inputs, not production textures until material-pass crop review.", "maps": {"albedo": {"path": "E:\\Station\\China_Tower\\evidence\\yueyang\\pbr\\dark-timber\\dark-timber_albedo.png", "channel": "albedo", "source": "reference-pixel-extraction"}, "roughness": {"path": "E:\\Station\\China_Tower\\evidence\\yueyang\\pbr\\dark-timber\\dark-timber_roughness.png", "channel": "roughness", "source": "reference-pixel-extraction"}, "height": {"path": "E:\\Station\\China_Tower\\evidence\\yueyang\\pbr\\dark-timber\\dark-timber_height.png", "channel": "height", "source": "reference-pixel-extraction"}, "normal": {"path": "E:\\Station\\China_Tower\\evidence\\yueyang\\pbr\\dark-timber\\dark-timber_normal.png", "channel": "normal", "source": "reference-pixel-extraction"}, "ao": {"path": "E:\\Station\\China_Tower\\evidence\\yueyang\\pbr\\dark-timber\\dark-timber_ao.png", "channel": "ao", "source": "reference-pixel-extraction"}}}, "shaderNotes": ["Keep albedo, roughness, height/normal and AO independent.", "Do not bind extracted evidence maps in blockout; crop contamination must be corrected before material pass."], "secondary": ["#4B2D23", "#0E0B0B"]},
    options
  );
  materialMap["glazed-tile"] = createSculptMaterial(
    "glazed-tile",
    {"id": "glazed-tile", "name": "Warm yellow glazed roof tiles", "type": "physical", "shaderModel": "MeshPhysicalMaterial", "baseColor": "#D5962F", "color": "#D5962F", "albedo": {"dominant": "#D5962F", "secondary": ["#8F4D1F", "#EDB84F"], "samplingNotes": "Reference-observed region with contamination limitation recorded in referencePbr."}, "colorVariation": {"palette": ["#D5962F", "#8F4D1F", "#EDB84F"], "pattern": "low-amplitude object-space mottling", "amplitude": 0.06, "heightCorrelation": 0.1}, "textureResolution": 1024, "textureProjection": {"mode": "world-units", "repeat": [2, 2], "anisotropy": 8, "texelDensityIntent": "Stable object-scale detail."}, "surfaceFrequencyBands": [{"id": "macro", "frequency": 2, "amplitude": 0.12, "role": "broad value breakup"}, {"id": "meso", "frequency": 12, "amplitude": 0.06, "role": "construction/grain relief"}, {"id": "micro", "frequency": 54, "amplitude": 0.025, "role": "grazing-highlight breakup"}], "roughness": {"base": 0.34, "variation": 0.1, "map": "independent-reference-evidence", "localResponse": "higher in cavities and lower on exposed edges"}, "metalness": {"base": 0, "variation": 0.02}, "normal": {"pattern": "independent-reference-height-derived", "strength": 0.22, "scale": 24, "space": "tangent"}, "bump": {"pattern": "independent fine field", "amplitude": 0.02, "scale": 38}, "displacement": {"pattern": "none for blockout", "amplitude": 0, "scale": 1, "silhouetteAffects": false}, "ambientOcclusion": {"cavityStrength": 0.28, "contactShadowBias": 0.35, "notes": "Construction seams and intersections only."}, "wear": {"edgeWear": 0.02, "scratches": [], "chips": []}, "dirt": {"amount": 0.03, "cavityBias": 0.7, "color": "#211B18"}, "localOverrides": [{"id": "glazed-tile.ridge-highlight", "region": "tile row crowns", "roughness": 0.25, "clearcoat": 0.25, "evidenceRefs": ["official-main"]}], "referencePbr": {"version": "1", "sourceImage": "E:\\Station\\China_Tower\\evidence\\yueyang\\detail-zones\\roof-and-finial.png", "extractor": "img2threejs/extract_pbr_evidence.py", "method": "single-image inferred independent channels", "verdict": "pass-with-crop-contamination-warning", "usable": true, "confidence": 0.829, "estimatedFidelity": 0.829, "targetThreshold": 0.7, "hardLimit": "Evidence maps mix nearby sky/architecture and are audit inputs, not production textures until material-pass crop review.", "maps": {"albedo": {"path": "E:\\Station\\China_Tower\\evidence\\yueyang\\pbr\\glazed-tile\\glazed-tile_albedo.png", "channel": "albedo", "source": "reference-pixel-extraction"}, "roughness": {"path": "E:\\Station\\China_Tower\\evidence\\yueyang\\pbr\\glazed-tile\\glazed-tile_roughness.png", "channel": "roughness", "source": "reference-pixel-extraction"}, "height": {"path": "E:\\Station\\China_Tower\\evidence\\yueyang\\pbr\\glazed-tile\\glazed-tile_height.png", "channel": "height", "source": "reference-pixel-extraction"}, "normal": {"path": "E:\\Station\\China_Tower\\evidence\\yueyang\\pbr\\glazed-tile\\glazed-tile_normal.png", "channel": "normal", "source": "reference-pixel-extraction"}, "ao": {"path": "E:\\Station\\China_Tower\\evidence\\yueyang\\pbr\\glazed-tile\\glazed-tile_ao.png", "channel": "ao", "source": "reference-pixel-extraction"}}}, "shaderNotes": ["Keep albedo, roughness, height/normal and AO independent.", "Do not bind extracted evidence maps in blockout; crop contamination must be corrected before material pass."], "secondary": ["#8F4D1F", "#EDB84F"], "clearcoat": 0.24, "clearcoatRoughness": 0.3},
    options
  );
  materialMap["gold-accent"] = createSculptMaterial(
    "gold-accent",
    {"id": "gold-accent", "name": "Muted gold ornamental accents", "type": "physical", "shaderModel": "MeshPhysicalMaterial", "baseColor": "#B47D23", "color": "#B47D23", "albedo": {"dominant": "#B47D23", "secondary": ["#513311", "#D2A84A"], "samplingNotes": "Reference-observed region with contamination limitation recorded in referencePbr."}, "colorVariation": {"palette": ["#B47D23", "#513311", "#D2A84A"], "pattern": "low-amplitude object-space mottling", "amplitude": 0.06, "heightCorrelation": 0.1}, "textureResolution": 1024, "textureProjection": {"mode": "world-units", "repeat": [2, 2], "anisotropy": 8, "texelDensityIntent": "Stable object-scale detail."}, "surfaceFrequencyBands": [{"id": "macro", "frequency": 2, "amplitude": 0.12, "role": "broad value breakup"}, {"id": "meso", "frequency": 12, "amplitude": 0.06, "role": "construction/grain relief"}, {"id": "micro", "frequency": 54, "amplitude": 0.025, "role": "grazing-highlight breakup"}], "roughness": {"base": 0.38, "variation": 0.1, "map": "independent-reference-evidence", "localResponse": "higher in cavities and lower on exposed edges"}, "metalness": {"base": 0.72, "variation": 0.02}, "normal": {"pattern": "independent-reference-height-derived", "strength": 0.22, "scale": 24, "space": "tangent"}, "bump": {"pattern": "independent fine field", "amplitude": 0.02, "scale": 38}, "displacement": {"pattern": "none for blockout", "amplitude": 0, "scale": 1, "silhouetteAffects": false}, "ambientOcclusion": {"cavityStrength": 0.28, "contactShadowBias": 0.35, "notes": "Construction seams and intersections only."}, "wear": {"edgeWear": 0.02, "scratches": [], "chips": []}, "dirt": {"amount": 0.03, "cavityBias": 0.7, "color": "#211B18"}, "localOverrides": [{"id": "plaque-material.gold-on-black", "region": "plaque and sparse lattice accents", "roughness": 0.32, "baseColor": "#C18D31", "evidenceRefs": ["full-object"]}], "referencePbr": {"version": "1", "sourceImage": "E:\\Station\\China_Tower\\evidence\\yueyang\\detail-zones\\ground-floor.png", "extractor": "img2threejs/extract_pbr_evidence.py", "method": "single-image inferred independent channels", "verdict": "pass-with-crop-contamination-warning", "usable": true, "confidence": 0.909, "estimatedFidelity": 0.909, "targetThreshold": 0.7, "hardLimit": "Evidence maps mix nearby sky/architecture and are audit inputs, not production textures until material-pass crop review.", "maps": {"albedo": {"path": "E:\\Station\\China_Tower\\evidence\\yueyang\\pbr\\gold-accent\\gold-accent_albedo.png", "channel": "albedo", "source": "reference-pixel-extraction"}, "roughness": {"path": "E:\\Station\\China_Tower\\evidence\\yueyang\\pbr\\gold-accent\\gold-accent_roughness.png", "channel": "roughness", "source": "reference-pixel-extraction"}, "height": {"path": "E:\\Station\\China_Tower\\evidence\\yueyang\\pbr\\gold-accent\\gold-accent_height.png", "channel": "height", "source": "reference-pixel-extraction"}, "normal": {"path": "E:\\Station\\China_Tower\\evidence\\yueyang\\pbr\\gold-accent\\gold-accent_normal.png", "channel": "normal", "source": "reference-pixel-extraction"}, "ao": {"path": "E:\\Station\\China_Tower\\evidence\\yueyang\\pbr\\gold-accent\\gold-accent_ao.png", "channel": "ao", "source": "reference-pixel-extraction"}}}, "shaderNotes": ["Keep albedo, roughness, height/normal and AO independent.", "Do not bind extracted evidence maps in blockout; crop contamination must be corrected before material pass."], "secondary": ["#513311", "#D2A84A"]},
    options
  );

  const nodes: Record<string, THREE.Object3D> = { root };
  const meshes: Record<string, THREE.Mesh> = {};
  const sockets: Record<string, THREE.Object3D> = {};
  const colliders: Record<string, unknown> = {};
  const destructionGroups: Record<string, THREE.Object3D[]> = {};

  const attachment_root_0 = null;
  const endpoint_root_0 = makeAttachmentEndpoint(attachment_root_0);
  const node_root_0 = new THREE.Group();
  node_root_0.name = "Yueyang Tower assembly root__pivot";
  node_root_0.scale.set(1, 1, 1);
  if (endpoint_root_0) {
    node_root_0.position.copy(endpoint_root_0.start);
    node_root_0.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_root_0.position.set(0.0, 0.0, 0.0);
    node_root_0.rotation.set(0.0, 0.0, 0.0);
  }
  node_root_0.userData.sculptComponent = {"id": "root", "name": "Yueyang Tower assembly root", "level": "macro", "role": "body", "importance": 0.95, "confidence": 0.82, "primitive": "box", "topologyClass": "assembled-solid", "topologyRationale": "A minimal pickable assembly anchor; visible architecture remains in named child masses.", "geometryDescriptor": {"topologyIntent": "architectural blockout with separable masses", "edgeTreatment": {"type": "chamfer", "bevelRadius": 0.025, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "vertex normals from generated geometry"}, "parent": null, "attachment": null, "dimensions": {"width": 0.01, "height": 0.01, "depth": 0.01, "units": "metres", "confidence": 0.82}, "transform": {"position": [0, 0, 0], "rotation": [0, 0, 0], "scale": [1, 1, 1]}, "actionProfile": {"animationRole": "static-part", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.9}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Broad-phase proxy; refine after form acceptance."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "root", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "dark-timber"}}, "material": "dark-timber", "materialLayers": ["dark-timber"], "deformations": [], "joints": [], "seams": [], "localFeatures": [], "surfaceDetail": {"macroRoughness": 0.12, "microRoughness": 0.08, "bumpAmplitude": 0.02, "normalPattern": "material-specific independent field", "displacementPattern": "none in blockout", "occlusionPattern": "contact and construction seams", "edgeWearPattern": "subtle exposed edge variation", "notes": "Blockout uses scalar PBR response; extracted maps remain review evidence until material pass."}, "colorMaterialRecipe": {"dominantAlbedo": "rgba(30, 22, 20, 1)", "secondaryAlbedo": "rgba(77, 45, 34, 1)", "materialClass": "wood", "materialClassConfidence": 0.82}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "blockout"};
  node_root_0.userData.actionProfile = {"animationRole": "static-part", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.9}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Broad-phase proxy; refine after form acceptance."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "root", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "dark-timber"}};
  (nodes["root"] ?? root).add(node_root_0);
  nodes["root"] = node_root_0;
  const mesh_root_0Geometry = endpoint_root_0
    ? new THREE.CylinderGeometry(endpoint_root_0.endRadius, endpoint_root_0.baseRadius, endpoint_root_0.length, 32, 12)
    : new THREE.BoxGeometry(1, 1, 1, 12, 12, 12);
  if (!endpoint_root_0) {
    mesh_root_0Geometry.scale(0.01, 0.01, 0.01);
  }
  const mesh_root_0 = new THREE.Mesh(
    mesh_root_0Geometry,
    materialMap["dark-timber"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_root_0.name = "Yueyang Tower assembly root";
  if (endpoint_root_0) {
    mesh_root_0.position.copy(endpoint_root_0.midpoint);
    mesh_root_0.quaternion.copy(endpoint_root_0.quaternion);
  }
  mesh_root_0.castShadow = options.castShadow ?? true;
  mesh_root_0.receiveShadow = options.receiveShadow ?? true;
  mesh_root_0.userData.sculptComponent = {"id": "root", "name": "Yueyang Tower assembly root", "level": "macro", "role": "body", "importance": 0.95, "confidence": 0.82, "primitive": "box", "topologyClass": "assembled-solid", "topologyRationale": "A minimal pickable assembly anchor; visible architecture remains in named child masses.", "geometryDescriptor": {"topologyIntent": "architectural blockout with separable masses", "edgeTreatment": {"type": "chamfer", "bevelRadius": 0.025, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "vertex normals from generated geometry"}, "parent": null, "attachment": null, "dimensions": {"width": 0.01, "height": 0.01, "depth": 0.01, "units": "metres", "confidence": 0.82}, "transform": {"position": [0, 0, 0], "rotation": [0, 0, 0], "scale": [1, 1, 1]}, "actionProfile": {"animationRole": "static-part", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.9}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Broad-phase proxy; refine after form acceptance."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "root", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "dark-timber"}}, "material": "dark-timber", "materialLayers": ["dark-timber"], "deformations": [], "joints": [], "seams": [], "localFeatures": [], "surfaceDetail": {"macroRoughness": 0.12, "microRoughness": 0.08, "bumpAmplitude": 0.02, "normalPattern": "material-specific independent field", "displacementPattern": "none in blockout", "occlusionPattern": "contact and construction seams", "edgeWearPattern": "subtle exposed edge variation", "notes": "Blockout uses scalar PBR response; extracted maps remain review evidence until material pass."}, "colorMaterialRecipe": {"dominantAlbedo": "rgba(30, 22, 20, 1)", "secondaryAlbedo": "rgba(77, 45, 34, 1)", "materialClass": "wood", "materialClassConfidence": 0.82}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "blockout"};
  node_root_0.add(mesh_root_0);
  meshes["root"] = mesh_root_0;
  colliders["root"] = {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Broad-phase proxy; refine after form acceptance."};
  destructionGroups["root"] ??= [];
  destructionGroups["root"].push(node_root_0);

  const attachment_granite_base_1 = null;
  const endpoint_granite_base_1 = makeAttachmentEndpoint(attachment_granite_base_1);
  const node_granite_base_1 = new THREE.Group();
  node_granite_base_1.name = "Granite platform__pivot";
  node_granite_base_1.scale.set(1, 1, 1);
  if (endpoint_granite_base_1) {
    node_granite_base_1.position.copy(endpoint_granite_base_1.start);
    node_granite_base_1.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_granite_base_1.position.set(0.0, 0.8467144191840549, 0.0);
    node_granite_base_1.rotation.set(0.0, 0.0, 0.0);
  }
  node_granite_base_1.userData.sculptComponent = {"id": "granite-base", "name": "Granite platform", "level": "macro", "role": "platform", "importance": 0.95, "confidence": 0.82, "primitive": "box", "topologyClass": "assembled-solid", "topologyRationale": "Visible rigid rectangular stone courses form a discrete load-bearing plinth.", "geometryDescriptor": {"topologyIntent": "architectural blockout with separable masses", "edgeTreatment": {"type": "chamfer", "bevelRadius": 0.025, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "vertex normals from generated geometry"}, "parent": "root", "attachment": null, "dimensions": {"width": 17.8, "height": 1.6934288383681098, "depth": 15.1, "units": "metres", "confidence": 0.82}, "transform": {"position": [0, 0.8467144191840549, 0], "rotation": [0, 0, 0], "scale": [1, 1, 1]}, "actionProfile": {"animationRole": "static-part", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.9}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": true, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Broad-phase proxy; refine after form acceptance."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "granite-base", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "dark-timber"}}, "material": "granite-stone", "materialLayers": ["granite-stone"], "deformations": [], "joints": [], "seams": [], "localFeatures": [{"id": "granite-base.course-seams", "type": "seam", "realization": "procedural course grooves", "evidenceRefs": ["full-object"]}], "surfaceDetail": {"macroRoughness": 0.12, "microRoughness": 0.08, "bumpAmplitude": 0.02, "normalPattern": "material-specific independent field", "displacementPattern": "none in blockout", "occlusionPattern": "contact and construction seams", "edgeWearPattern": "subtle exposed edge variation", "notes": "Blockout uses scalar PBR response; extracted maps remain review evidence until material pass."}, "colorMaterialRecipe": {"dominantAlbedo": "rgba(148, 145, 135, 1)", "secondaryAlbedo": "rgba(94, 92, 86, 1)", "materialClass": "stone", "materialClassConfidence": 0.82}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "blockout"};
  node_granite_base_1.userData.actionProfile = {"animationRole": "static-part", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.9}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": true, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Broad-phase proxy; refine after form acceptance."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "granite-base", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "dark-timber"}};
  (nodes["root"] ?? root).add(node_granite_base_1);
  nodes["granite-base"] = node_granite_base_1;
  const mesh_granite_base_1Geometry = endpoint_granite_base_1
    ? new THREE.CylinderGeometry(endpoint_granite_base_1.endRadius, endpoint_granite_base_1.baseRadius, endpoint_granite_base_1.length, 32, 12)
    : new THREE.BoxGeometry(1, 1, 1, 12, 12, 12);
  if (!endpoint_granite_base_1) {
    mesh_granite_base_1Geometry.scale(17.8, 1.6934288383681098, 15.1);
  }
  const mesh_granite_base_1 = new THREE.Mesh(
    mesh_granite_base_1Geometry,
    materialMap["granite-stone"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_granite_base_1.name = "Granite platform";
  if (endpoint_granite_base_1) {
    mesh_granite_base_1.position.copy(endpoint_granite_base_1.midpoint);
    mesh_granite_base_1.quaternion.copy(endpoint_granite_base_1.quaternion);
  }
  mesh_granite_base_1.castShadow = options.castShadow ?? true;
  mesh_granite_base_1.receiveShadow = options.receiveShadow ?? true;
  mesh_granite_base_1.userData.sculptComponent = {"id": "granite-base", "name": "Granite platform", "level": "macro", "role": "platform", "importance": 0.95, "confidence": 0.82, "primitive": "box", "topologyClass": "assembled-solid", "topologyRationale": "Visible rigid rectangular stone courses form a discrete load-bearing plinth.", "geometryDescriptor": {"topologyIntent": "architectural blockout with separable masses", "edgeTreatment": {"type": "chamfer", "bevelRadius": 0.025, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "vertex normals from generated geometry"}, "parent": "root", "attachment": null, "dimensions": {"width": 17.8, "height": 1.6934288383681098, "depth": 15.1, "units": "metres", "confidence": 0.82}, "transform": {"position": [0, 0.8467144191840549, 0], "rotation": [0, 0, 0], "scale": [1, 1, 1]}, "actionProfile": {"animationRole": "static-part", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.9}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": true, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Broad-phase proxy; refine after form acceptance."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "granite-base", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "dark-timber"}}, "material": "granite-stone", "materialLayers": ["granite-stone"], "deformations": [], "joints": [], "seams": [], "localFeatures": [{"id": "granite-base.course-seams", "type": "seam", "realization": "procedural course grooves", "evidenceRefs": ["full-object"]}], "surfaceDetail": {"macroRoughness": 0.12, "microRoughness": 0.08, "bumpAmplitude": 0.02, "normalPattern": "material-specific independent field", "displacementPattern": "none in blockout", "occlusionPattern": "contact and construction seams", "edgeWearPattern": "subtle exposed edge variation", "notes": "Blockout uses scalar PBR response; extracted maps remain review evidence until material pass."}, "colorMaterialRecipe": {"dominantAlbedo": "rgba(148, 145, 135, 1)", "secondaryAlbedo": "rgba(94, 92, 86, 1)", "materialClass": "stone", "materialClassConfidence": 0.82}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "blockout"};
  node_granite_base_1.add(mesh_granite_base_1);
  meshes["granite-base"] = mesh_granite_base_1;
  colliders["granite-base"] = {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Broad-phase proxy; refine after form acceptance."};
  destructionGroups["granite-base"] ??= [];
  destructionGroups["granite-base"].push(node_granite_base_1);

  const attachment_storey_one_2 = null;
  const endpoint_storey_one_2 = makeAttachmentEndpoint(attachment_storey_one_2);
  const node_storey_one_2 = new THREE.Group();
  node_storey_one_2.name = "First storey mass__pivot";
  node_storey_one_2.scale.set(1, 1, 1);
  if (endpoint_storey_one_2) {
    node_storey_one_2.position.copy(endpoint_storey_one_2.start);
    node_storey_one_2.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_storey_one_2.position.set(0.0, 3.991653690439116, 0.0);
    node_storey_one_2.rotation.set(0.0, 0.0, 0.0);
  }
  node_storey_one_2.userData.sculptComponent = {"id": "storey-one", "name": "First storey mass", "level": "macro", "role": "storey", "importance": 0.95, "confidence": 0.82, "primitive": "box", "topologyClass": "assembled-solid", "topologyRationale": "The first storey reads as a rigid rectangular post-and-panel envelope at blockout distance.", "geometryDescriptor": {"topologyIntent": "architectural blockout with separable masses", "edgeTreatment": {"type": "chamfer", "bevelRadius": 0.025, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "vertex normals from generated geometry"}, "parent": "root", "attachment": null, "dimensions": {"width": 15, "height": 4.596449704142012, "depth": 12.4, "units": "metres", "confidence": 0.82}, "transform": {"position": [0, 3.991653690439116, 0], "rotation": [0, 0, 0], "scale": [1, 1, 1]}, "actionProfile": {"animationRole": "static-part", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.9}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": true, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Broad-phase proxy; refine after form acceptance."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "storey-one", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "dark-timber"}}, "material": "dark-timber", "materialLayers": ["dark-timber"], "deformations": [], "joints": [], "seams": [], "localFeatures": [{"id": "door-lattice-system.gold-grid", "type": "linework", "realization": "repeated geometry in structural/form pass", "evidenceRefs": ["full-object"]}], "surfaceDetail": {"macroRoughness": 0.12, "microRoughness": 0.08, "bumpAmplitude": 0.02, "normalPattern": "material-specific independent field", "displacementPattern": "none in blockout", "occlusionPattern": "contact and construction seams", "edgeWearPattern": "subtle exposed edge variation", "notes": "Blockout uses scalar PBR response; extracted maps remain review evidence until material pass."}, "colorMaterialRecipe": {"dominantAlbedo": "rgba(30, 22, 20, 1)", "secondaryAlbedo": "rgba(77, 45, 34, 1)", "materialClass": "wood", "materialClassConfidence": 0.82}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "blockout"};
  node_storey_one_2.userData.actionProfile = {"animationRole": "static-part", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.9}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": true, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Broad-phase proxy; refine after form acceptance."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "storey-one", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "dark-timber"}};
  (nodes["root"] ?? root).add(node_storey_one_2);
  nodes["storey-one"] = node_storey_one_2;
  const mesh_storey_one_2Geometry = endpoint_storey_one_2
    ? new THREE.CylinderGeometry(endpoint_storey_one_2.endRadius, endpoint_storey_one_2.baseRadius, endpoint_storey_one_2.length, 32, 12)
    : new THREE.BoxGeometry(1, 1, 1, 12, 12, 12);
  if (!endpoint_storey_one_2) {
    mesh_storey_one_2Geometry.scale(15, 4.596449704142012, 12.4);
  }
  const mesh_storey_one_2 = new THREE.Mesh(
    mesh_storey_one_2Geometry,
    materialMap["dark-timber"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_storey_one_2.name = "First storey mass";
  if (endpoint_storey_one_2) {
    mesh_storey_one_2.position.copy(endpoint_storey_one_2.midpoint);
    mesh_storey_one_2.quaternion.copy(endpoint_storey_one_2.quaternion);
  }
  mesh_storey_one_2.castShadow = options.castShadow ?? true;
  mesh_storey_one_2.receiveShadow = options.receiveShadow ?? true;
  mesh_storey_one_2.userData.sculptComponent = {"id": "storey-one", "name": "First storey mass", "level": "macro", "role": "storey", "importance": 0.95, "confidence": 0.82, "primitive": "box", "topologyClass": "assembled-solid", "topologyRationale": "The first storey reads as a rigid rectangular post-and-panel envelope at blockout distance.", "geometryDescriptor": {"topologyIntent": "architectural blockout with separable masses", "edgeTreatment": {"type": "chamfer", "bevelRadius": 0.025, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "vertex normals from generated geometry"}, "parent": "root", "attachment": null, "dimensions": {"width": 15, "height": 4.596449704142012, "depth": 12.4, "units": "metres", "confidence": 0.82}, "transform": {"position": [0, 3.991653690439116, 0], "rotation": [0, 0, 0], "scale": [1, 1, 1]}, "actionProfile": {"animationRole": "static-part", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.9}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": true, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Broad-phase proxy; refine after form acceptance."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "storey-one", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "dark-timber"}}, "material": "dark-timber", "materialLayers": ["dark-timber"], "deformations": [], "joints": [], "seams": [], "localFeatures": [{"id": "door-lattice-system.gold-grid", "type": "linework", "realization": "repeated geometry in structural/form pass", "evidenceRefs": ["full-object"]}], "surfaceDetail": {"macroRoughness": 0.12, "microRoughness": 0.08, "bumpAmplitude": 0.02, "normalPattern": "material-specific independent field", "displacementPattern": "none in blockout", "occlusionPattern": "contact and construction seams", "edgeWearPattern": "subtle exposed edge variation", "notes": "Blockout uses scalar PBR response; extracted maps remain review evidence until material pass."}, "colorMaterialRecipe": {"dominantAlbedo": "rgba(30, 22, 20, 1)", "secondaryAlbedo": "rgba(77, 45, 34, 1)", "materialClass": "wood", "materialClassConfidence": 0.82}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "blockout"};
  node_storey_one_2.add(mesh_storey_one_2);
  meshes["storey-one"] = mesh_storey_one_2;
  colliders["storey-one"] = {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Broad-phase proxy; refine after form acceptance."};
  destructionGroups["storey-one"] ??= [];
  destructionGroups["storey-one"].push(node_storey_one_2);

  const attachment_lower_eave_3 = null;
  const endpoint_lower_eave_3 = makeAttachmentEndpoint(attachment_lower_eave_3);
  const node_lower_eave_3 = new THREE.Group();
  node_lower_eave_3.name = "Lower swept eave__pivot";
  node_lower_eave_3.scale.set(1, 1, 1);
  if (endpoint_lower_eave_3) {
    node_lower_eave_3.position.copy(endpoint_lower_eave_3.start);
    node_lower_eave_3.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_lower_eave_3.position.set(0.0, 6.7132357521021495, -7.75);
    node_lower_eave_3.rotation.set(0.0, 0.0, 0.0);
  }
  node_lower_eave_3.userData.sculptComponent = {"id": "lower-eave", "name": "Lower swept eave", "level": "macro", "role": "roof-shell", "importance": 0.95, "confidence": 0.82, "primitive": "extrude", "topologyClass": "conforming-shell", "topologyRationale": "A thin custom-profile roof shell follows the structural frame and defines the lower silhouette.", "geometryDescriptor": {"topologyIntent": "architectural blockout with separable masses", "edgeTreatment": {"type": "chamfer", "bevelRadius": 0.025, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "vertex normals from generated geometry", "profile2D": {"points": [[-0.5, -0.12], [-0.43, 0.02], [-0.18, 0.11], [0, 0.13], [0.18, 0.11], [0.43, 0.02], [0.5, -0.12], [0.42, -0.2], [-0.42, -0.2]], "depth": 1}}, "parent": "root", "attachment": null, "dimensions": {"width": 18.6, "height": 1.814388041108689, "depth": 15.5, "units": "metres", "confidence": 0.82}, "transform": {"position": [0, 6.7132357521021495, -7.75], "rotation": [0, 0, 0], "scale": [1, 1, 1]}, "actionProfile": {"animationRole": "static-part", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.9}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": true, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Broad-phase proxy; refine after form acceptance."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "lower-eave", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "dark-timber"}}, "material": "glazed-tile", "materialLayers": ["glazed-tile"], "deformations": [], "joints": [], "seams": [], "localFeatures": [{"id": "eave-corner-system.curved-ridges", "type": "ridge", "realization": "curved corner ridge geometry in form pass", "evidenceRefs": ["full-object", "official-main"]}], "surfaceDetail": {"macroRoughness": 0.12, "microRoughness": 0.08, "bumpAmplitude": 0.02, "normalPattern": "material-specific independent field", "displacementPattern": "none in blockout", "occlusionPattern": "contact and construction seams", "edgeWearPattern": "subtle exposed edge variation", "notes": "Blockout uses scalar PBR response; extracted maps remain review evidence until material pass."}, "colorMaterialRecipe": {"dominantAlbedo": "rgba(218, 153, 50, 1)", "secondaryAlbedo": "rgba(139, 74, 26, 1)", "materialClass": "ceramic", "materialClassConfidence": 0.84}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "blockout"};
  node_lower_eave_3.userData.actionProfile = {"animationRole": "static-part", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.9}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": true, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Broad-phase proxy; refine after form acceptance."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "lower-eave", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "dark-timber"}};
  (nodes["root"] ?? root).add(node_lower_eave_3);
  nodes["lower-eave"] = node_lower_eave_3;
  const mesh_lower_eave_3Geometry = endpoint_lower_eave_3
    ? new THREE.CylinderGeometry(endpoint_lower_eave_3.endRadius, endpoint_lower_eave_3.baseRadius, endpoint_lower_eave_3.length, 32, 12)
    : buildExtrudeGeometry({"points": [[-0.5, -0.12], [-0.43, 0.02], [-0.18, 0.11], [0, 0.13], [0.18, 0.11], [0.43, 0.02], [0.5, -0.12], [0.42, -0.2], [-0.42, -0.2]], "depth": 1});
  if (!endpoint_lower_eave_3) {
    mesh_lower_eave_3Geometry.scale(18.6, 1.814388041108689, 15.5);
  }
  const mesh_lower_eave_3 = new THREE.Mesh(
    mesh_lower_eave_3Geometry,
    materialMap["glazed-tile"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_lower_eave_3.name = "Lower swept eave";
  if (endpoint_lower_eave_3) {
    mesh_lower_eave_3.position.copy(endpoint_lower_eave_3.midpoint);
    mesh_lower_eave_3.quaternion.copy(endpoint_lower_eave_3.quaternion);
  }
  mesh_lower_eave_3.castShadow = options.castShadow ?? true;
  mesh_lower_eave_3.receiveShadow = options.receiveShadow ?? true;
  mesh_lower_eave_3.userData.sculptComponent = {"id": "lower-eave", "name": "Lower swept eave", "level": "macro", "role": "roof-shell", "importance": 0.95, "confidence": 0.82, "primitive": "extrude", "topologyClass": "conforming-shell", "topologyRationale": "A thin custom-profile roof shell follows the structural frame and defines the lower silhouette.", "geometryDescriptor": {"topologyIntent": "architectural blockout with separable masses", "edgeTreatment": {"type": "chamfer", "bevelRadius": 0.025, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "vertex normals from generated geometry", "profile2D": {"points": [[-0.5, -0.12], [-0.43, 0.02], [-0.18, 0.11], [0, 0.13], [0.18, 0.11], [0.43, 0.02], [0.5, -0.12], [0.42, -0.2], [-0.42, -0.2]], "depth": 1}}, "parent": "root", "attachment": null, "dimensions": {"width": 18.6, "height": 1.814388041108689, "depth": 15.5, "units": "metres", "confidence": 0.82}, "transform": {"position": [0, 6.7132357521021495, -7.75], "rotation": [0, 0, 0], "scale": [1, 1, 1]}, "actionProfile": {"animationRole": "static-part", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.9}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": true, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Broad-phase proxy; refine after form acceptance."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "lower-eave", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "dark-timber"}}, "material": "glazed-tile", "materialLayers": ["glazed-tile"], "deformations": [], "joints": [], "seams": [], "localFeatures": [{"id": "eave-corner-system.curved-ridges", "type": "ridge", "realization": "curved corner ridge geometry in form pass", "evidenceRefs": ["full-object", "official-main"]}], "surfaceDetail": {"macroRoughness": 0.12, "microRoughness": 0.08, "bumpAmplitude": 0.02, "normalPattern": "material-specific independent field", "displacementPattern": "none in blockout", "occlusionPattern": "contact and construction seams", "edgeWearPattern": "subtle exposed edge variation", "notes": "Blockout uses scalar PBR response; extracted maps remain review evidence until material pass."}, "colorMaterialRecipe": {"dominantAlbedo": "rgba(218, 153, 50, 1)", "secondaryAlbedo": "rgba(139, 74, 26, 1)", "materialClass": "ceramic", "materialClassConfidence": 0.84}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "blockout"};
  node_lower_eave_3.add(mesh_lower_eave_3);
  meshes["lower-eave"] = mesh_lower_eave_3;
  colliders["lower-eave"] = {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Broad-phase proxy; refine after form acceptance."};
  destructionGroups["lower-eave"] ??= [];
  destructionGroups["lower-eave"].push(node_lower_eave_3);

  const attachment_storey_two_4 = null;
  const endpoint_storey_two_4 = makeAttachmentEndpoint(attachment_storey_two_4);
  const node_storey_two_4 = new THREE.Group();
  node_storey_two_4.name = "Second storey gallery mass__pivot";
  node_storey_two_4.scale.set(1, 1, 1);
  if (endpoint_storey_two_4) {
    node_storey_two_4.position.copy(endpoint_storey_two_4.start);
    node_storey_two_4.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_storey_two_4.position.set(0.0, 8.950981002802866, 0.0);
    node_storey_two_4.rotation.set(0.0, 0.0, 0.0);
  }
  node_storey_two_4.userData.sculptComponent = {"id": "storey-two", "name": "Second storey gallery mass", "level": "macro", "role": "storey", "importance": 0.95, "confidence": 0.82, "primitive": "box", "topologyClass": "assembled-solid", "topologyRationale": "The second storey is a separable rectangular volume inside a projecting gallery.", "geometryDescriptor": {"topologyIntent": "architectural blockout with separable masses", "edgeTreatment": {"type": "chamfer", "bevelRadius": 0.025, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "vertex normals from generated geometry"}, "parent": "root", "attachment": null, "dimensions": {"width": 12.8, "height": 3.628776082217378, "depth": 10.3, "units": "metres", "confidence": 0.82}, "transform": {"position": [0, 8.950981002802866, 0], "rotation": [0, 0, 0], "scale": [1, 1, 1]}, "actionProfile": {"animationRole": "static-part", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.9}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": true, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Broad-phase proxy; refine after form acceptance."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "storey-two", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "dark-timber"}}, "material": "dark-timber", "materialLayers": ["dark-timber"], "deformations": [], "joints": [], "seams": [], "localFeatures": [{"id": "second-storey.open-gallery-shadow-gap", "type": "negative-space", "realization": "projecting deck plus inset wall volume", "evidenceRefs": ["full-object"]}], "surfaceDetail": {"macroRoughness": 0.12, "microRoughness": 0.08, "bumpAmplitude": 0.02, "normalPattern": "material-specific independent field", "displacementPattern": "none in blockout", "occlusionPattern": "contact and construction seams", "edgeWearPattern": "subtle exposed edge variation", "notes": "Blockout uses scalar PBR response; extracted maps remain review evidence until material pass."}, "colorMaterialRecipe": {"dominantAlbedo": "rgba(30, 22, 20, 1)", "secondaryAlbedo": "rgba(77, 45, 34, 1)", "materialClass": "wood", "materialClassConfidence": 0.82}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "blockout"};
  node_storey_two_4.userData.actionProfile = {"animationRole": "static-part", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.9}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": true, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Broad-phase proxy; refine after form acceptance."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "storey-two", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "dark-timber"}};
  (nodes["root"] ?? root).add(node_storey_two_4);
  nodes["storey-two"] = node_storey_two_4;
  const mesh_storey_two_4Geometry = endpoint_storey_two_4
    ? new THREE.CylinderGeometry(endpoint_storey_two_4.endRadius, endpoint_storey_two_4.baseRadius, endpoint_storey_two_4.length, 32, 12)
    : new THREE.BoxGeometry(1, 1, 1, 12, 12, 12);
  if (!endpoint_storey_two_4) {
    mesh_storey_two_4Geometry.scale(12.8, 3.628776082217378, 10.3);
  }
  const mesh_storey_two_4 = new THREE.Mesh(
    mesh_storey_two_4Geometry,
    materialMap["dark-timber"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_storey_two_4.name = "Second storey gallery mass";
  if (endpoint_storey_two_4) {
    mesh_storey_two_4.position.copy(endpoint_storey_two_4.midpoint);
    mesh_storey_two_4.quaternion.copy(endpoint_storey_two_4.quaternion);
  }
  mesh_storey_two_4.castShadow = options.castShadow ?? true;
  mesh_storey_two_4.receiveShadow = options.receiveShadow ?? true;
  mesh_storey_two_4.userData.sculptComponent = {"id": "storey-two", "name": "Second storey gallery mass", "level": "macro", "role": "storey", "importance": 0.95, "confidence": 0.82, "primitive": "box", "topologyClass": "assembled-solid", "topologyRationale": "The second storey is a separable rectangular volume inside a projecting gallery.", "geometryDescriptor": {"topologyIntent": "architectural blockout with separable masses", "edgeTreatment": {"type": "chamfer", "bevelRadius": 0.025, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "vertex normals from generated geometry"}, "parent": "root", "attachment": null, "dimensions": {"width": 12.8, "height": 3.628776082217378, "depth": 10.3, "units": "metres", "confidence": 0.82}, "transform": {"position": [0, 8.950981002802866, 0], "rotation": [0, 0, 0], "scale": [1, 1, 1]}, "actionProfile": {"animationRole": "static-part", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.9}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": true, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Broad-phase proxy; refine after form acceptance."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "storey-two", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "dark-timber"}}, "material": "dark-timber", "materialLayers": ["dark-timber"], "deformations": [], "joints": [], "seams": [], "localFeatures": [{"id": "second-storey.open-gallery-shadow-gap", "type": "negative-space", "realization": "projecting deck plus inset wall volume", "evidenceRefs": ["full-object"]}], "surfaceDetail": {"macroRoughness": 0.12, "microRoughness": 0.08, "bumpAmplitude": 0.02, "normalPattern": "material-specific independent field", "displacementPattern": "none in blockout", "occlusionPattern": "contact and construction seams", "edgeWearPattern": "subtle exposed edge variation", "notes": "Blockout uses scalar PBR response; extracted maps remain review evidence until material pass."}, "colorMaterialRecipe": {"dominantAlbedo": "rgba(30, 22, 20, 1)", "secondaryAlbedo": "rgba(77, 45, 34, 1)", "materialClass": "wood", "materialClassConfidence": 0.82}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "blockout"};
  node_storey_two_4.add(mesh_storey_two_4);
  meshes["storey-two"] = mesh_storey_two_4;
  colliders["storey-two"] = {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Broad-phase proxy; refine after form acceptance."};
  destructionGroups["storey-two"] ??= [];
  destructionGroups["storey-two"].push(node_storey_two_4);

  const attachment_middle_eave_5 = null;
  const endpoint_middle_eave_5 = makeAttachmentEndpoint(attachment_middle_eave_5);
  const node_middle_eave_5 = new THREE.Group();
  node_middle_eave_5.name = "Middle swept eave__pivot";
  node_middle_eave_5.scale.set(1, 1, 1);
  if (endpoint_middle_eave_5) {
    node_middle_eave_5.position.copy(endpoint_middle_eave_5.start);
    node_middle_eave_5.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_middle_eave_5.position.set(0.0, 11.188726253503583, -6.45);
    node_middle_eave_5.rotation.set(0.0, 0.0, 0.0);
  }
  node_middle_eave_5.userData.sculptComponent = {"id": "middle-eave", "name": "Middle swept eave", "level": "macro", "role": "roof-shell", "importance": 0.95, "confidence": 0.82, "primitive": "extrude", "topologyClass": "conforming-shell", "topologyRationale": "A thinner custom-profile shell repeats the lower eave with mild upward taper.", "geometryDescriptor": {"topologyIntent": "architectural blockout with separable masses", "edgeTreatment": {"type": "chamfer", "bevelRadius": 0.025, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "vertex normals from generated geometry", "profile2D": {"points": [[-0.5, -0.12], [-0.43, 0.02], [-0.18, 0.11], [0, 0.13], [0.18, 0.11], [0.43, 0.02], [0.5, -0.12], [0.42, -0.2], [-0.42, -0.2]], "depth": 1}}, "parent": "root", "attachment": null, "dimensions": {"width": 15.6, "height": 1.6329492369978202, "depth": 12.9, "units": "metres", "confidence": 0.82}, "transform": {"position": [0, 11.188726253503583, -6.45], "rotation": [0, 0, 0], "scale": [1, 1, 1]}, "actionProfile": {"animationRole": "static-part", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.9}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": true, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Broad-phase proxy; refine after form acceptance."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "middle-eave", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "dark-timber"}}, "material": "glazed-tile", "materialLayers": ["glazed-tile"], "deformations": [], "joints": [], "seams": [], "localFeatures": [{"id": "roof-tile-system.instanced-rows", "type": "ridge", "realization": "instanced roof tile rows in form pass", "evidenceRefs": ["full-object", "official-main"]}], "surfaceDetail": {"macroRoughness": 0.12, "microRoughness": 0.08, "bumpAmplitude": 0.02, "normalPattern": "material-specific independent field", "displacementPattern": "none in blockout", "occlusionPattern": "contact and construction seams", "edgeWearPattern": "subtle exposed edge variation", "notes": "Blockout uses scalar PBR response; extracted maps remain review evidence until material pass."}, "colorMaterialRecipe": {"dominantAlbedo": "rgba(218, 153, 50, 1)", "secondaryAlbedo": "rgba(139, 74, 26, 1)", "materialClass": "ceramic", "materialClassConfidence": 0.84}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "blockout"};
  node_middle_eave_5.userData.actionProfile = {"animationRole": "static-part", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.9}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": true, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Broad-phase proxy; refine after form acceptance."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "middle-eave", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "dark-timber"}};
  (nodes["root"] ?? root).add(node_middle_eave_5);
  nodes["middle-eave"] = node_middle_eave_5;
  const mesh_middle_eave_5Geometry = endpoint_middle_eave_5
    ? new THREE.CylinderGeometry(endpoint_middle_eave_5.endRadius, endpoint_middle_eave_5.baseRadius, endpoint_middle_eave_5.length, 32, 12)
    : buildExtrudeGeometry({"points": [[-0.5, -0.12], [-0.43, 0.02], [-0.18, 0.11], [0, 0.13], [0.18, 0.11], [0.43, 0.02], [0.5, -0.12], [0.42, -0.2], [-0.42, -0.2]], "depth": 1});
  if (!endpoint_middle_eave_5) {
    mesh_middle_eave_5Geometry.scale(15.6, 1.6329492369978202, 12.9);
  }
  const mesh_middle_eave_5 = new THREE.Mesh(
    mesh_middle_eave_5Geometry,
    materialMap["glazed-tile"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_middle_eave_5.name = "Middle swept eave";
  if (endpoint_middle_eave_5) {
    mesh_middle_eave_5.position.copy(endpoint_middle_eave_5.midpoint);
    mesh_middle_eave_5.quaternion.copy(endpoint_middle_eave_5.quaternion);
  }
  mesh_middle_eave_5.castShadow = options.castShadow ?? true;
  mesh_middle_eave_5.receiveShadow = options.receiveShadow ?? true;
  mesh_middle_eave_5.userData.sculptComponent = {"id": "middle-eave", "name": "Middle swept eave", "level": "macro", "role": "roof-shell", "importance": 0.95, "confidence": 0.82, "primitive": "extrude", "topologyClass": "conforming-shell", "topologyRationale": "A thinner custom-profile shell repeats the lower eave with mild upward taper.", "geometryDescriptor": {"topologyIntent": "architectural blockout with separable masses", "edgeTreatment": {"type": "chamfer", "bevelRadius": 0.025, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "vertex normals from generated geometry", "profile2D": {"points": [[-0.5, -0.12], [-0.43, 0.02], [-0.18, 0.11], [0, 0.13], [0.18, 0.11], [0.43, 0.02], [0.5, -0.12], [0.42, -0.2], [-0.42, -0.2]], "depth": 1}}, "parent": "root", "attachment": null, "dimensions": {"width": 15.6, "height": 1.6329492369978202, "depth": 12.9, "units": "metres", "confidence": 0.82}, "transform": {"position": [0, 11.188726253503583, -6.45], "rotation": [0, 0, 0], "scale": [1, 1, 1]}, "actionProfile": {"animationRole": "static-part", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.9}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": true, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Broad-phase proxy; refine after form acceptance."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "middle-eave", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "dark-timber"}}, "material": "glazed-tile", "materialLayers": ["glazed-tile"], "deformations": [], "joints": [], "seams": [], "localFeatures": [{"id": "roof-tile-system.instanced-rows", "type": "ridge", "realization": "instanced roof tile rows in form pass", "evidenceRefs": ["full-object", "official-main"]}], "surfaceDetail": {"macroRoughness": 0.12, "microRoughness": 0.08, "bumpAmplitude": 0.02, "normalPattern": "material-specific independent field", "displacementPattern": "none in blockout", "occlusionPattern": "contact and construction seams", "edgeWearPattern": "subtle exposed edge variation", "notes": "Blockout uses scalar PBR response; extracted maps remain review evidence until material pass."}, "colorMaterialRecipe": {"dominantAlbedo": "rgba(218, 153, 50, 1)", "secondaryAlbedo": "rgba(139, 74, 26, 1)", "materialClass": "ceramic", "materialClassConfidence": 0.84}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "blockout"};
  node_middle_eave_5.add(mesh_middle_eave_5);
  meshes["middle-eave"] = mesh_middle_eave_5;
  colliders["middle-eave"] = {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Broad-phase proxy; refine after form acceptance."};
  destructionGroups["middle-eave"] ??= [];
  destructionGroups["middle-eave"].push(node_middle_eave_5);

  const attachment_storey_three_6 = null;
  const endpoint_storey_three_6 = makeAttachmentEndpoint(attachment_storey_three_6);
  const node_storey_three_6 = new THREE.Group();
  node_storey_three_6.name = "Third storey mass__pivot";
  node_storey_three_6.scale.set(1, 1, 1);
  if (endpoint_storey_three_6) {
    node_storey_three_6.position.copy(endpoint_storey_three_6.start);
    node_storey_three_6.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_storey_three_6.position.set(0.0, 13.48695110557459, 0.0);
    node_storey_three_6.rotation.set(0.0, 0.0, 0.0);
  }
  node_storey_three_6.userData.sculptComponent = {"id": "storey-three", "name": "Third storey mass", "level": "macro", "role": "storey", "importance": 0.95, "confidence": 0.82, "primitive": "box", "topologyClass": "assembled-solid", "topologyRationale": "The upper enclosed rectangular volume is visibly smaller but not pagoda-like in taper.", "geometryDescriptor": {"topologyIntent": "architectural blockout with separable masses", "edgeTreatment": {"type": "chamfer", "bevelRadius": 0.025, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "vertex normals from generated geometry"}, "parent": "root", "attachment": null, "dimensions": {"width": 9.9, "height": 3.2054188726253505, "depth": 7.9, "units": "metres", "confidence": 0.82}, "transform": {"position": [0, 13.48695110557459, 0], "rotation": [0, 0, 0], "scale": [1, 1, 1]}, "actionProfile": {"animationRole": "static-part", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.9}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": true, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Broad-phase proxy; refine after form acceptance."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "storey-three", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "dark-timber"}}, "material": "dark-timber", "materialLayers": ["dark-timber"], "deformations": [], "joints": [], "seams": [], "localFeatures": [{"id": "plaque-carrier", "type": "surface-relief", "realization": "separate plaque mesh", "evidenceRefs": ["full-object"]}], "surfaceDetail": {"macroRoughness": 0.12, "microRoughness": 0.08, "bumpAmplitude": 0.02, "normalPattern": "material-specific independent field", "displacementPattern": "none in blockout", "occlusionPattern": "contact and construction seams", "edgeWearPattern": "subtle exposed edge variation", "notes": "Blockout uses scalar PBR response; extracted maps remain review evidence until material pass."}, "colorMaterialRecipe": {"dominantAlbedo": "rgba(30, 22, 20, 1)", "secondaryAlbedo": "rgba(77, 45, 34, 1)", "materialClass": "wood", "materialClassConfidence": 0.82}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "blockout"};
  node_storey_three_6.userData.actionProfile = {"animationRole": "static-part", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.9}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": true, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Broad-phase proxy; refine after form acceptance."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "storey-three", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "dark-timber"}};
  (nodes["root"] ?? root).add(node_storey_three_6);
  nodes["storey-three"] = node_storey_three_6;
  const mesh_storey_three_6Geometry = endpoint_storey_three_6
    ? new THREE.CylinderGeometry(endpoint_storey_three_6.endRadius, endpoint_storey_three_6.baseRadius, endpoint_storey_three_6.length, 32, 12)
    : new THREE.BoxGeometry(1, 1, 1, 12, 12, 12);
  if (!endpoint_storey_three_6) {
    mesh_storey_three_6Geometry.scale(9.9, 3.2054188726253505, 7.9);
  }
  const mesh_storey_three_6 = new THREE.Mesh(
    mesh_storey_three_6Geometry,
    materialMap["dark-timber"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_storey_three_6.name = "Third storey mass";
  if (endpoint_storey_three_6) {
    mesh_storey_three_6.position.copy(endpoint_storey_three_6.midpoint);
    mesh_storey_three_6.quaternion.copy(endpoint_storey_three_6.quaternion);
  }
  mesh_storey_three_6.castShadow = options.castShadow ?? true;
  mesh_storey_three_6.receiveShadow = options.receiveShadow ?? true;
  mesh_storey_three_6.userData.sculptComponent = {"id": "storey-three", "name": "Third storey mass", "level": "macro", "role": "storey", "importance": 0.95, "confidence": 0.82, "primitive": "box", "topologyClass": "assembled-solid", "topologyRationale": "The upper enclosed rectangular volume is visibly smaller but not pagoda-like in taper.", "geometryDescriptor": {"topologyIntent": "architectural blockout with separable masses", "edgeTreatment": {"type": "chamfer", "bevelRadius": 0.025, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "vertex normals from generated geometry"}, "parent": "root", "attachment": null, "dimensions": {"width": 9.9, "height": 3.2054188726253505, "depth": 7.9, "units": "metres", "confidence": 0.82}, "transform": {"position": [0, 13.48695110557459, 0], "rotation": [0, 0, 0], "scale": [1, 1, 1]}, "actionProfile": {"animationRole": "static-part", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.9}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": true, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Broad-phase proxy; refine after form acceptance."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "storey-three", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "dark-timber"}}, "material": "dark-timber", "materialLayers": ["dark-timber"], "deformations": [], "joints": [], "seams": [], "localFeatures": [{"id": "plaque-carrier", "type": "surface-relief", "realization": "separate plaque mesh", "evidenceRefs": ["full-object"]}], "surfaceDetail": {"macroRoughness": 0.12, "microRoughness": 0.08, "bumpAmplitude": 0.02, "normalPattern": "material-specific independent field", "displacementPattern": "none in blockout", "occlusionPattern": "contact and construction seams", "edgeWearPattern": "subtle exposed edge variation", "notes": "Blockout uses scalar PBR response; extracted maps remain review evidence until material pass."}, "colorMaterialRecipe": {"dominantAlbedo": "rgba(30, 22, 20, 1)", "secondaryAlbedo": "rgba(77, 45, 34, 1)", "materialClass": "wood", "materialClassConfidence": 0.82}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "blockout"};
  node_storey_three_6.add(mesh_storey_three_6);
  meshes["storey-three"] = mesh_storey_three_6;
  colliders["storey-three"] = {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Broad-phase proxy; refine after form acceptance."};
  destructionGroups["storey-three"] ??= [];
  destructionGroups["storey-three"].push(node_storey_three_6);

  const attachment_helmet_roof_7 = null;
  const endpoint_helmet_roof_7 = makeAttachmentEndpoint(attachment_helmet_roof_7);
  const node_helmet_roof_7 = new THREE.Group();
  node_helmet_roof_7.name = "Curved helmet roof blockout__pivot";
  node_helmet_roof_7.scale.set(1, 1, 1);
  if (endpoint_helmet_roof_7) {
    node_helmet_roof_7.position.copy(endpoint_helmet_roof_7.start);
    node_helmet_roof_7.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_helmet_roof_7.position.set(0.0, 16.389971971348494, -5.2);
    node_helmet_roof_7.rotation.set(0.0, 0.0, 0.0);
  }
  node_helmet_roof_7.userData.sculptComponent = {"id": "helmet-roof", "name": "Curved helmet roof blockout", "level": "macro", "role": "roof-shell", "importance": 0.95, "confidence": 0.82, "primitive": "extrude", "topologyClass": "conforming-shell", "topologyRationale": "A closed two-axis parametric shell preserves the central crown, depressed eave bands and four rising corners visible in orbit views.", "geometryDescriptor": {"topologyIntent": "architectural blockout with separable masses", "edgeTreatment": {"type": "chamfer", "bevelRadius": 0.025, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "vertex normals from generated geometry", "profile2D": {"points": [[-0.5, 0.08], [-0.42, -0.08], [-0.2, -0.19], [0, -0.23], [0.2, -0.19], [0.42, -0.08], [0.5, 0.08], [0.32, 0.17], [0.1, 0.29], [0, 0.36], [-0.1, 0.29], [-0.32, 0.17]], "depth": 1}}, "parent": "root", "attachment": null, "dimensions": {"width": 12.5, "height": 3.870694487698537, "depth": 10.4, "units": "metres", "confidence": 0.82}, "transform": {"position": [0, 16.389971971348494, -5.2], "rotation": [0, 0, 0], "scale": [1, 1, 1]}, "actionProfile": {"animationRole": "static-part", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.9}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": true, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Broad-phase proxy; refine after form acceptance."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "helmet-roof", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "dark-timber"}}, "material": "glazed-tile", "materialLayers": ["glazed-tile"], "deformations": [], "joints": [], "seams": [], "localFeatures": [{"id": "helmet-roof.edge-profile", "type": "contour", "realization": "custom extruded blockout profile; two-axis shell deferred", "evidenceRefs": ["full-object", "official-main"]}], "surfaceDetail": {"macroRoughness": 0.12, "microRoughness": 0.08, "bumpAmplitude": 0.02, "normalPattern": "material-specific independent field", "displacementPattern": "none in blockout", "occlusionPattern": "contact and construction seams", "edgeWearPattern": "subtle exposed edge variation", "notes": "Blockout uses scalar PBR response; extracted maps remain review evidence until material pass."}, "colorMaterialRecipe": {"dominantAlbedo": "rgba(218, 153, 50, 1)", "secondaryAlbedo": "rgba(139, 74, 26, 1)", "materialClass": "ceramic", "materialClassConfidence": 0.84}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "blockout"};
  node_helmet_roof_7.userData.actionProfile = {"animationRole": "static-part", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.9}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": true, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Broad-phase proxy; refine after form acceptance."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "helmet-roof", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "dark-timber"}};
  (nodes["root"] ?? root).add(node_helmet_roof_7);
  nodes["helmet-roof"] = node_helmet_roof_7;
  const mesh_helmet_roof_7Geometry = endpoint_helmet_roof_7
    ? new THREE.CylinderGeometry(endpoint_helmet_roof_7.endRadius, endpoint_helmet_roof_7.baseRadius, endpoint_helmet_roof_7.length, 32, 12)
    : buildHelmetRoofGeometry();
  if (!endpoint_helmet_roof_7) {
    mesh_helmet_roof_7Geometry.scale(12.5, 3.870694487698537, 10.4);
  }
  const mesh_helmet_roof_7 = new THREE.Mesh(
    mesh_helmet_roof_7Geometry,
    materialMap["glazed-tile"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_helmet_roof_7.name = "Curved helmet roof blockout";
  if (endpoint_helmet_roof_7) {
    mesh_helmet_roof_7.position.copy(endpoint_helmet_roof_7.midpoint);
    mesh_helmet_roof_7.quaternion.copy(endpoint_helmet_roof_7.quaternion);
  }
  mesh_helmet_roof_7.castShadow = options.castShadow ?? true;
  mesh_helmet_roof_7.receiveShadow = options.receiveShadow ?? true;
  mesh_helmet_roof_7.userData.sculptComponent = {"id": "helmet-roof", "name": "Curved helmet roof blockout", "level": "macro", "role": "roof-shell", "importance": 0.95, "confidence": 0.82, "primitive": "extrude", "topologyClass": "conforming-shell", "topologyRationale": "A closed two-axis parametric shell preserves the central crown, depressed eave bands and four rising corners visible in orbit views.", "geometryDescriptor": {"topologyIntent": "architectural blockout with separable masses", "edgeTreatment": {"type": "chamfer", "bevelRadius": 0.025, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "vertex normals from generated geometry", "profile2D": {"points": [[-0.5, 0.08], [-0.42, -0.08], [-0.2, -0.19], [0, -0.23], [0.2, -0.19], [0.42, -0.08], [0.5, 0.08], [0.32, 0.17], [0.1, 0.29], [0, 0.36], [-0.1, 0.29], [-0.32, 0.17]], "depth": 1}}, "parent": "root", "attachment": null, "dimensions": {"width": 12.5, "height": 3.870694487698537, "depth": 10.4, "units": "metres", "confidence": 0.82}, "transform": {"position": [0, 16.389971971348494, -5.2], "rotation": [0, 0, 0], "scale": [1, 1, 1]}, "actionProfile": {"animationRole": "static-part", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.9}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": true, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Broad-phase proxy; refine after form acceptance."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "helmet-roof", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "dark-timber"}}, "material": "glazed-tile", "materialLayers": ["glazed-tile"], "deformations": [], "joints": [], "seams": [], "localFeatures": [{"id": "helmet-roof.edge-profile", "type": "contour", "realization": "custom extruded blockout profile; two-axis shell deferred", "evidenceRefs": ["full-object", "official-main"]}], "surfaceDetail": {"macroRoughness": 0.12, "microRoughness": 0.08, "bumpAmplitude": 0.02, "normalPattern": "material-specific independent field", "displacementPattern": "none in blockout", "occlusionPattern": "contact and construction seams", "edgeWearPattern": "subtle exposed edge variation", "notes": "Blockout uses scalar PBR response; extracted maps remain review evidence until material pass."}, "colorMaterialRecipe": {"dominantAlbedo": "rgba(218, 153, 50, 1)", "secondaryAlbedo": "rgba(139, 74, 26, 1)", "materialClass": "ceramic", "materialClassConfidence": 0.84}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "blockout"};
  node_helmet_roof_7.add(mesh_helmet_roof_7);
  meshes["helmet-roof"] = mesh_helmet_roof_7;
  colliders["helmet-roof"] = {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Broad-phase proxy; refine after form acceptance."};
  destructionGroups["helmet-roof"] ??= [];
  destructionGroups["helmet-roof"].push(node_helmet_roof_7);

  const attachment_roof_finial_8 = null;
  const endpoint_roof_finial_8 = makeAttachmentEndpoint(attachment_roof_finial_8);
  const node_roof_finial_8 = new THREE.Group();
  node_roof_finial_8.name = "Central roof finial__pivot";
  node_roof_finial_8.scale.set(1, 1, 1);
  if (endpoint_roof_finial_8) {
    node_roof_finial_8.position.copy(endpoint_roof_finial_8.start);
    node_roof_finial_8.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_roof_finial_8.position.set(0.0, 18.603525381501093, 0.0);
    node_roof_finial_8.rotation.set(0.0, 0.0, 0.0);
  }
  node_roof_finial_8.userData.sculptComponent = {"id": "roof-finial", "name": "Central roof finial", "level": "macro", "role": "ornament", "importance": 0.95, "confidence": 0.82, "primitive": "lathe", "topologyClass": "continuous-sculpt", "topologyRationale": "The small axial ornament is rotationally symmetric with a stacked turned profile and its lower endpoint contacts the helmet-roof crown.", "geometryDescriptor": {"topologyIntent": "architectural blockout with separable masses", "edgeTreatment": {"type": "chamfer", "bevelRadius": 0.025, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "vertex normals from generated geometry", "latheProfile": {"points": [[0.18, -0.5], [0.28, -0.32], [0.12, -0.12], [0.22, 0.05], [0.1, 0.25], [0.03, 0.5]], "segments": 20}}, "parent": "root", "attachment": null, "dimensions": {"width": 0.65, "height": 1.6329492369978202, "depth": 0.65, "units": "metres", "confidence": 0.82}, "transform": {"position": [0, 18.603525381501093, 0], "rotation": [0, 0, 0], "scale": [1, 1, 1]}, "actionProfile": {"animationRole": "static-part", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.9}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": true, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Broad-phase proxy; refine after form acceptance."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "roof-finial", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "dark-timber"}}, "material": "gold-accent", "materialLayers": ["gold-accent"], "deformations": [], "joints": [], "seams": [], "localFeatures": [{"id": "roof-finial.stacked-profile", "type": "ridge", "realization": "lathed stacked profile", "evidenceRefs": ["full-object"]}], "surfaceDetail": {"macroRoughness": 0.12, "microRoughness": 0.08, "bumpAmplitude": 0.02, "normalPattern": "material-specific independent field", "displacementPattern": "none in blockout", "occlusionPattern": "contact and construction seams", "edgeWearPattern": "subtle exposed edge variation", "notes": "Blockout uses scalar PBR response; extracted maps remain review evidence until material pass."}, "colorMaterialRecipe": {"dominantAlbedo": "rgba(190, 133, 39, 1)", "secondaryAlbedo": "rgba(82, 51, 18, 1)", "materialClass": "metal", "materialClassConfidence": 0.72}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "blockout"};
  node_roof_finial_8.userData.actionProfile = {"animationRole": "static-part", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.9}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": true, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Broad-phase proxy; refine after form acceptance."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "roof-finial", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "dark-timber"}};
  (nodes["root"] ?? root).add(node_roof_finial_8);
  nodes["roof-finial"] = node_roof_finial_8;
  const mesh_roof_finial_8Geometry = endpoint_roof_finial_8
    ? new THREE.CylinderGeometry(endpoint_roof_finial_8.endRadius, endpoint_roof_finial_8.baseRadius, endpoint_roof_finial_8.length, 32, 12)
    : buildLatheGeometry({"points": [[0.18, -0.5], [0.28, -0.32], [0.12, -0.12], [0.22, 0.05], [0.1, 0.25], [0.03, 0.5]], "segments": 20});
  if (!endpoint_roof_finial_8) {
    mesh_roof_finial_8Geometry.scale(0.65, 1.6329492369978202, 0.65);
  }
  const mesh_roof_finial_8 = new THREE.Mesh(
    mesh_roof_finial_8Geometry,
    materialMap["gold-accent"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_roof_finial_8.name = "Central roof finial";
  if (endpoint_roof_finial_8) {
    mesh_roof_finial_8.position.copy(endpoint_roof_finial_8.midpoint);
    mesh_roof_finial_8.quaternion.copy(endpoint_roof_finial_8.quaternion);
  }
  mesh_roof_finial_8.castShadow = options.castShadow ?? true;
  mesh_roof_finial_8.receiveShadow = options.receiveShadow ?? true;
  mesh_roof_finial_8.userData.sculptComponent = {"id": "roof-finial", "name": "Central roof finial", "level": "macro", "role": "ornament", "importance": 0.95, "confidence": 0.82, "primitive": "lathe", "topologyClass": "continuous-sculpt", "topologyRationale": "The small axial ornament is rotationally symmetric with a stacked turned profile and its lower endpoint contacts the helmet-roof crown.", "geometryDescriptor": {"topologyIntent": "architectural blockout with separable masses", "edgeTreatment": {"type": "chamfer", "bevelRadius": 0.025, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "vertex normals from generated geometry", "latheProfile": {"points": [[0.18, -0.5], [0.28, -0.32], [0.12, -0.12], [0.22, 0.05], [0.1, 0.25], [0.03, 0.5]], "segments": 20}}, "parent": "root", "attachment": null, "dimensions": {"width": 0.65, "height": 1.6329492369978202, "depth": 0.65, "units": "metres", "confidence": 0.82}, "transform": {"position": [0, 18.603525381501093, 0], "rotation": [0, 0, 0], "scale": [1, 1, 1]}, "actionProfile": {"animationRole": "static-part", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.9}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": true, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Broad-phase proxy; refine after form acceptance."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "roof-finial", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "dark-timber"}}, "material": "gold-accent", "materialLayers": ["gold-accent"], "deformations": [], "joints": [], "seams": [], "localFeatures": [{"id": "roof-finial.stacked-profile", "type": "ridge", "realization": "lathed stacked profile", "evidenceRefs": ["full-object"]}], "surfaceDetail": {"macroRoughness": 0.12, "microRoughness": 0.08, "bumpAmplitude": 0.02, "normalPattern": "material-specific independent field", "displacementPattern": "none in blockout", "occlusionPattern": "contact and construction seams", "edgeWearPattern": "subtle exposed edge variation", "notes": "Blockout uses scalar PBR response; extracted maps remain review evidence until material pass."}, "colorMaterialRecipe": {"dominantAlbedo": "rgba(190, 133, 39, 1)", "secondaryAlbedo": "rgba(82, 51, 18, 1)", "materialClass": "metal", "materialClassConfidence": 0.72}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "blockout"};
  node_roof_finial_8.add(mesh_roof_finial_8);
  meshes["roof-finial"] = mesh_roof_finial_8;
  colliders["roof-finial"] = {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Broad-phase proxy; refine after form acceptance."};
  destructionGroups["roof-finial"] ??= [];
  destructionGroups["roof-finial"].push(node_roof_finial_8);

  const attachment_first_floor_deck_9 = null;
  const endpoint_first_floor_deck_9 = makeAttachmentEndpoint(attachment_first_floor_deck_9);
  const node_first_floor_deck_9 = new THREE.Group();
  node_first_floor_deck_9.name = "First floor deck__pivot";
  node_first_floor_deck_9.scale.set(1, 1, 1);
  if (endpoint_first_floor_deck_9) {
    node_first_floor_deck_9.position.copy(endpoint_first_floor_deck_9.start);
    node_first_floor_deck_9.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_first_floor_deck_9.position.set(0.0, 1.8748676424789787, 0.0);
    node_first_floor_deck_9.rotation.set(0.0, 0.0, 0.0);
  }
  node_first_floor_deck_9.userData.sculptComponent = {"id": "first-floor-deck", "name": "First floor deck", "level": "meso", "role": "deck", "importance": 0.76, "confidence": 0.82, "primitive": "box", "topologyClass": "assembled-solid", "topologyRationale": "A rigid rectangular timber floor plate separates base and first-storey frame.", "geometryDescriptor": {"topologyIntent": "separable architectural sub-assembly", "edgeTreatment": {"type": "chamfer", "bevelRadius": 0.012, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "vertex normals from generated geometry"}, "parent": "root", "attachment": null, "dimensions": {"width": 15.4, "height": 0.338685767673622, "depth": 12.8, "units": "metres", "confidence": 0.82}, "transform": {"position": [0, 1.8748676424789787, 0], "rotation": [0, 0, 0], "scale": [1, 1, 1]}, "actionProfile": {"animationRole": "static-part", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.9}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": true, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Broad-phase proxy; refine after form acceptance."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "first-floor-deck", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "dark-timber"}}, "material": "dark-timber", "materialLayers": ["dark-timber"], "deformations": [], "joints": [], "seams": [], "localFeatures": [], "surfaceDetail": {"macroRoughness": 0.12, "microRoughness": 0.08, "bumpAmplitude": 0.02, "normalPattern": "material-specific independent field", "displacementPattern": "none in blockout", "occlusionPattern": "contact and construction seams", "edgeWearPattern": "subtle exposed edge variation", "notes": "Blockout uses scalar PBR response; extracted maps remain review evidence until material pass."}, "colorMaterialRecipe": {"dominantAlbedo": "rgba(30, 22, 20, 1)", "secondaryAlbedo": "rgba(77, 45, 34, 1)", "materialClass": "wood", "materialClassConfidence": 0.82}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "structural-pass"};
  node_first_floor_deck_9.userData.actionProfile = {"animationRole": "static-part", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.9}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": true, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Broad-phase proxy; refine after form acceptance."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "first-floor-deck", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "dark-timber"}};
  (nodes["root"] ?? root).add(node_first_floor_deck_9);
  nodes["first-floor-deck"] = node_first_floor_deck_9;
  const mesh_first_floor_deck_9Geometry = endpoint_first_floor_deck_9
    ? new THREE.CylinderGeometry(endpoint_first_floor_deck_9.endRadius, endpoint_first_floor_deck_9.baseRadius, endpoint_first_floor_deck_9.length, 32, 12)
    : new THREE.BoxGeometry(1, 1, 1, 12, 12, 12);
  if (!endpoint_first_floor_deck_9) {
    mesh_first_floor_deck_9Geometry.scale(15.4, 0.338685767673622, 12.8);
  }
  const mesh_first_floor_deck_9 = new THREE.Mesh(
    mesh_first_floor_deck_9Geometry,
    materialMap["dark-timber"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_first_floor_deck_9.name = "First floor deck";
  if (endpoint_first_floor_deck_9) {
    mesh_first_floor_deck_9.position.copy(endpoint_first_floor_deck_9.midpoint);
    mesh_first_floor_deck_9.quaternion.copy(endpoint_first_floor_deck_9.quaternion);
  }
  mesh_first_floor_deck_9.castShadow = options.castShadow ?? true;
  mesh_first_floor_deck_9.receiveShadow = options.receiveShadow ?? true;
  mesh_first_floor_deck_9.userData.sculptComponent = {"id": "first-floor-deck", "name": "First floor deck", "level": "meso", "role": "deck", "importance": 0.76, "confidence": 0.82, "primitive": "box", "topologyClass": "assembled-solid", "topologyRationale": "A rigid rectangular timber floor plate separates base and first-storey frame.", "geometryDescriptor": {"topologyIntent": "separable architectural sub-assembly", "edgeTreatment": {"type": "chamfer", "bevelRadius": 0.012, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "vertex normals from generated geometry"}, "parent": "root", "attachment": null, "dimensions": {"width": 15.4, "height": 0.338685767673622, "depth": 12.8, "units": "metres", "confidence": 0.82}, "transform": {"position": [0, 1.8748676424789787, 0], "rotation": [0, 0, 0], "scale": [1, 1, 1]}, "actionProfile": {"animationRole": "static-part", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.9}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": true, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Broad-phase proxy; refine after form acceptance."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "first-floor-deck", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "dark-timber"}}, "material": "dark-timber", "materialLayers": ["dark-timber"], "deformations": [], "joints": [], "seams": [], "localFeatures": [], "surfaceDetail": {"macroRoughness": 0.12, "microRoughness": 0.08, "bumpAmplitude": 0.02, "normalPattern": "material-specific independent field", "displacementPattern": "none in blockout", "occlusionPattern": "contact and construction seams", "edgeWearPattern": "subtle exposed edge variation", "notes": "Blockout uses scalar PBR response; extracted maps remain review evidence until material pass."}, "colorMaterialRecipe": {"dominantAlbedo": "rgba(30, 22, 20, 1)", "secondaryAlbedo": "rgba(77, 45, 34, 1)", "materialClass": "wood", "materialClassConfidence": 0.82}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "structural-pass"};
  node_first_floor_deck_9.add(mesh_first_floor_deck_9);
  meshes["first-floor-deck"] = mesh_first_floor_deck_9;
  colliders["first-floor-deck"] = {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Broad-phase proxy; refine after form acceptance."};
  destructionGroups["first-floor-deck"] ??= [];
  destructionGroups["first-floor-deck"].push(node_first_floor_deck_9);

  const attachment_second_floor_gallery_10 = null;
  const endpoint_second_floor_gallery_10 = makeAttachmentEndpoint(attachment_second_floor_gallery_10);
  const node_second_floor_gallery_10 = new THREE.Group();
  node_second_floor_gallery_10.name = "Second floor gallery deck__pivot";
  node_second_floor_gallery_10.scale.set(1, 1, 1);
  if (endpoint_second_floor_gallery_10) {
    node_second_floor_gallery_10.position.copy(endpoint_second_floor_gallery_10.start);
    node_second_floor_gallery_10.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_second_floor_gallery_10.position.set(0.0, 7.35431952662722, 0.0);
    node_second_floor_gallery_10.rotation.set(0.0, 0.0, 0.0);
  }
  node_second_floor_gallery_10.userData.sculptComponent = {"id": "second-floor-gallery", "name": "Second floor gallery deck", "level": "meso", "role": "gallery", "importance": 0.76, "confidence": 0.82, "primitive": "box", "topologyClass": "assembled-solid", "topologyRationale": "The projecting rigid deck creates the observable open gallery perimeter.", "geometryDescriptor": {"topologyIntent": "separable architectural sub-assembly", "edgeTreatment": {"type": "chamfer", "bevelRadius": 0.012, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "vertex normals from generated geometry"}, "parent": "root", "attachment": null, "dimensions": {"width": 14.4, "height": 0.38706944876985366, "depth": 11.8, "units": "metres", "confidence": 0.82}, "transform": {"position": [0, 7.35431952662722, 0], "rotation": [0, 0, 0], "scale": [1, 1, 1]}, "actionProfile": {"animationRole": "static-part", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.9}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": true, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Broad-phase proxy; refine after form acceptance."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "second-floor-gallery", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "dark-timber"}}, "material": "dark-timber", "materialLayers": ["dark-timber"], "deformations": [], "joints": [], "seams": [], "localFeatures": [{"id": "balcony-railing-system.lattice-bays", "type": "linework", "realization": "instanced railing bays", "evidenceRefs": ["full-object"]}], "surfaceDetail": {"macroRoughness": 0.12, "microRoughness": 0.08, "bumpAmplitude": 0.02, "normalPattern": "material-specific independent field", "displacementPattern": "none in blockout", "occlusionPattern": "contact and construction seams", "edgeWearPattern": "subtle exposed edge variation", "notes": "Blockout uses scalar PBR response; extracted maps remain review evidence until material pass."}, "colorMaterialRecipe": {"dominantAlbedo": "rgba(30, 22, 20, 1)", "secondaryAlbedo": "rgba(77, 45, 34, 1)", "materialClass": "wood", "materialClassConfidence": 0.82}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "structural-pass"};
  node_second_floor_gallery_10.userData.actionProfile = {"animationRole": "static-part", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.9}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": true, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Broad-phase proxy; refine after form acceptance."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "second-floor-gallery", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "dark-timber"}};
  (nodes["root"] ?? root).add(node_second_floor_gallery_10);
  nodes["second-floor-gallery"] = node_second_floor_gallery_10;
  const mesh_second_floor_gallery_10Geometry = endpoint_second_floor_gallery_10
    ? new THREE.CylinderGeometry(endpoint_second_floor_gallery_10.endRadius, endpoint_second_floor_gallery_10.baseRadius, endpoint_second_floor_gallery_10.length, 32, 12)
    : new THREE.BoxGeometry(1, 1, 1, 12, 12, 12);
  if (!endpoint_second_floor_gallery_10) {
    mesh_second_floor_gallery_10Geometry.scale(14.4, 0.38706944876985366, 11.8);
  }
  const mesh_second_floor_gallery_10 = new THREE.Mesh(
    mesh_second_floor_gallery_10Geometry,
    materialMap["dark-timber"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_second_floor_gallery_10.name = "Second floor gallery deck";
  if (endpoint_second_floor_gallery_10) {
    mesh_second_floor_gallery_10.position.copy(endpoint_second_floor_gallery_10.midpoint);
    mesh_second_floor_gallery_10.quaternion.copy(endpoint_second_floor_gallery_10.quaternion);
  }
  mesh_second_floor_gallery_10.castShadow = options.castShadow ?? true;
  mesh_second_floor_gallery_10.receiveShadow = options.receiveShadow ?? true;
  mesh_second_floor_gallery_10.userData.sculptComponent = {"id": "second-floor-gallery", "name": "Second floor gallery deck", "level": "meso", "role": "gallery", "importance": 0.76, "confidence": 0.82, "primitive": "box", "topologyClass": "assembled-solid", "topologyRationale": "The projecting rigid deck creates the observable open gallery perimeter.", "geometryDescriptor": {"topologyIntent": "separable architectural sub-assembly", "edgeTreatment": {"type": "chamfer", "bevelRadius": 0.012, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "vertex normals from generated geometry"}, "parent": "root", "attachment": null, "dimensions": {"width": 14.4, "height": 0.38706944876985366, "depth": 11.8, "units": "metres", "confidence": 0.82}, "transform": {"position": [0, 7.35431952662722, 0], "rotation": [0, 0, 0], "scale": [1, 1, 1]}, "actionProfile": {"animationRole": "static-part", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.9}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": true, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Broad-phase proxy; refine after form acceptance."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "second-floor-gallery", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "dark-timber"}}, "material": "dark-timber", "materialLayers": ["dark-timber"], "deformations": [], "joints": [], "seams": [], "localFeatures": [{"id": "balcony-railing-system.lattice-bays", "type": "linework", "realization": "instanced railing bays", "evidenceRefs": ["full-object"]}], "surfaceDetail": {"macroRoughness": 0.12, "microRoughness": 0.08, "bumpAmplitude": 0.02, "normalPattern": "material-specific independent field", "displacementPattern": "none in blockout", "occlusionPattern": "contact and construction seams", "edgeWearPattern": "subtle exposed edge variation", "notes": "Blockout uses scalar PBR response; extracted maps remain review evidence until material pass."}, "colorMaterialRecipe": {"dominantAlbedo": "rgba(30, 22, 20, 1)", "secondaryAlbedo": "rgba(77, 45, 34, 1)", "materialClass": "wood", "materialClassConfidence": 0.82}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "structural-pass"};
  node_second_floor_gallery_10.add(mesh_second_floor_gallery_10);
  meshes["second-floor-gallery"] = mesh_second_floor_gallery_10;
  colliders["second-floor-gallery"] = {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Broad-phase proxy; refine after form acceptance."};
  destructionGroups["second-floor-gallery"] ??= [];
  destructionGroups["second-floor-gallery"].push(node_second_floor_gallery_10);

  const attachment_third_floor_deck_11 = null;
  const endpoint_third_floor_deck_11 = makeAttachmentEndpoint(attachment_third_floor_deck_11);
  const node_third_floor_deck_11 = new THREE.Group();
  node_third_floor_deck_11.name = "Third floor deck__pivot";
  node_third_floor_deck_11.scale.set(1, 1, 1);
  if (endpoint_third_floor_deck_11) {
    node_third_floor_deck_11.position.copy(endpoint_third_floor_deck_11.start);
    node_third_floor_deck_11.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_third_floor_deck_11.position.set(0.0, 11.793522267206479, 0.0);
    node_third_floor_deck_11.rotation.set(0.0, 0.0, 0.0);
  }
  node_third_floor_deck_11.userData.sculptComponent = {"id": "third-floor-deck", "name": "Third floor deck", "level": "meso", "role": "deck", "importance": 0.76, "confidence": 0.82, "primitive": "box", "topologyClass": "assembled-solid", "topologyRationale": "A rigid rectangular timber floor plate separates second and third storeys.", "geometryDescriptor": {"topologyIntent": "separable architectural sub-assembly", "edgeTreatment": {"type": "chamfer", "bevelRadius": 0.012, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "vertex normals from generated geometry"}, "parent": "root", "attachment": null, "dimensions": {"width": 10.7, "height": 0.3144939271255061, "depth": 8.7, "units": "metres", "confidence": 0.82}, "transform": {"position": [0, 11.793522267206479, 0], "rotation": [0, 0, 0], "scale": [1, 1, 1]}, "actionProfile": {"animationRole": "static-part", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.9}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": true, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Broad-phase proxy; refine after form acceptance."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "third-floor-deck", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "dark-timber"}}, "material": "dark-timber", "materialLayers": ["dark-timber"], "deformations": [], "joints": [], "seams": [], "localFeatures": [], "surfaceDetail": {"macroRoughness": 0.12, "microRoughness": 0.08, "bumpAmplitude": 0.02, "normalPattern": "material-specific independent field", "displacementPattern": "none in blockout", "occlusionPattern": "contact and construction seams", "edgeWearPattern": "subtle exposed edge variation", "notes": "Blockout uses scalar PBR response; extracted maps remain review evidence until material pass."}, "colorMaterialRecipe": {"dominantAlbedo": "rgba(30, 22, 20, 1)", "secondaryAlbedo": "rgba(77, 45, 34, 1)", "materialClass": "wood", "materialClassConfidence": 0.82}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "structural-pass"};
  node_third_floor_deck_11.userData.actionProfile = {"animationRole": "static-part", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.9}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": true, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Broad-phase proxy; refine after form acceptance."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "third-floor-deck", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "dark-timber"}};
  (nodes["root"] ?? root).add(node_third_floor_deck_11);
  nodes["third-floor-deck"] = node_third_floor_deck_11;
  const mesh_third_floor_deck_11Geometry = endpoint_third_floor_deck_11
    ? new THREE.CylinderGeometry(endpoint_third_floor_deck_11.endRadius, endpoint_third_floor_deck_11.baseRadius, endpoint_third_floor_deck_11.length, 32, 12)
    : new THREE.BoxGeometry(1, 1, 1, 12, 12, 12);
  if (!endpoint_third_floor_deck_11) {
    mesh_third_floor_deck_11Geometry.scale(10.7, 0.3144939271255061, 8.7);
  }
  const mesh_third_floor_deck_11 = new THREE.Mesh(
    mesh_third_floor_deck_11Geometry,
    materialMap["dark-timber"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_third_floor_deck_11.name = "Third floor deck";
  if (endpoint_third_floor_deck_11) {
    mesh_third_floor_deck_11.position.copy(endpoint_third_floor_deck_11.midpoint);
    mesh_third_floor_deck_11.quaternion.copy(endpoint_third_floor_deck_11.quaternion);
  }
  mesh_third_floor_deck_11.castShadow = options.castShadow ?? true;
  mesh_third_floor_deck_11.receiveShadow = options.receiveShadow ?? true;
  mesh_third_floor_deck_11.userData.sculptComponent = {"id": "third-floor-deck", "name": "Third floor deck", "level": "meso", "role": "deck", "importance": 0.76, "confidence": 0.82, "primitive": "box", "topologyClass": "assembled-solid", "topologyRationale": "A rigid rectangular timber floor plate separates second and third storeys.", "geometryDescriptor": {"topologyIntent": "separable architectural sub-assembly", "edgeTreatment": {"type": "chamfer", "bevelRadius": 0.012, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "vertex normals from generated geometry"}, "parent": "root", "attachment": null, "dimensions": {"width": 10.7, "height": 0.3144939271255061, "depth": 8.7, "units": "metres", "confidence": 0.82}, "transform": {"position": [0, 11.793522267206479, 0], "rotation": [0, 0, 0], "scale": [1, 1, 1]}, "actionProfile": {"animationRole": "static-part", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.9}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": true, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Broad-phase proxy; refine after form acceptance."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "third-floor-deck", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "dark-timber"}}, "material": "dark-timber", "materialLayers": ["dark-timber"], "deformations": [], "joints": [], "seams": [], "localFeatures": [], "surfaceDetail": {"macroRoughness": 0.12, "microRoughness": 0.08, "bumpAmplitude": 0.02, "normalPattern": "material-specific independent field", "displacementPattern": "none in blockout", "occlusionPattern": "contact and construction seams", "edgeWearPattern": "subtle exposed edge variation", "notes": "Blockout uses scalar PBR response; extracted maps remain review evidence until material pass."}, "colorMaterialRecipe": {"dominantAlbedo": "rgba(30, 22, 20, 1)", "secondaryAlbedo": "rgba(77, 45, 34, 1)", "materialClass": "wood", "materialClassConfidence": 0.82}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "structural-pass"};
  node_third_floor_deck_11.add(mesh_third_floor_deck_11);
  meshes["third-floor-deck"] = mesh_third_floor_deck_11;
  colliders["third-floor-deck"] = {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Broad-phase proxy; refine after form acceptance."};
  destructionGroups["third-floor-deck"] ??= [];
  destructionGroups["third-floor-deck"].push(node_third_floor_deck_11);

  const attachment_beam_band_one_12 = null;
  const endpoint_beam_band_one_12 = makeAttachmentEndpoint(attachment_beam_band_one_12);
  const node_beam_band_one_12 = new THREE.Group();
  node_beam_band_one_12.name = "First-storey beam band__pivot";
  node_beam_band_one_12.scale.set(1, 1, 1);
  if (endpoint_beam_band_one_12) {
    node_beam_band_one_12.position.copy(endpoint_beam_band_one_12.start);
    node_beam_band_one_12.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_beam_band_one_12.position.set(0.0, 6.072151977577079, 0.0);
    node_beam_band_one_12.rotation.set(0.0, 0.0, 0.0);
  }
  node_beam_band_one_12.userData.sculptComponent = {"id": "beam-band-one", "name": "First-storey beam band", "level": "meso", "role": "beam-band", "importance": 0.76, "confidence": 0.82, "primitive": "box", "topologyClass": "assembled-solid", "topologyRationale": "A discrete horizontal beam/fang band caps the first-storey column rhythm.", "geometryDescriptor": {"topologyIntent": "separable architectural sub-assembly", "edgeTreatment": {"type": "chamfer", "bevelRadius": 0.012, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "vertex normals from generated geometry"}, "parent": "root", "attachment": null, "dimensions": {"width": 15.5, "height": 0.508028651510433, "depth": 12.9, "units": "metres", "confidence": 0.82}, "transform": {"position": [0, 6.072151977577079, 0], "rotation": [0, 0, 0], "scale": [1, 1, 1]}, "actionProfile": {"animationRole": "static-part", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.9}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": true, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Broad-phase proxy; refine after form acceptance."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "beam-band-one", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "dark-timber"}}, "material": "dark-timber", "materialLayers": ["dark-timber"], "deformations": [], "joints": [], "seams": [], "localFeatures": [{"id": "dougong-system.stepped-brackets", "type": "ridge", "realization": "instanced stepped block groups", "evidenceRefs": ["full-object"]}], "surfaceDetail": {"macroRoughness": 0.12, "microRoughness": 0.08, "bumpAmplitude": 0.02, "normalPattern": "material-specific independent field", "displacementPattern": "none in blockout", "occlusionPattern": "contact and construction seams", "edgeWearPattern": "subtle exposed edge variation", "notes": "Blockout uses scalar PBR response; extracted maps remain review evidence until material pass."}, "colorMaterialRecipe": {"dominantAlbedo": "rgba(30, 22, 20, 1)", "secondaryAlbedo": "rgba(77, 45, 34, 1)", "materialClass": "wood", "materialClassConfidence": 0.82}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "structural-pass"};
  node_beam_band_one_12.userData.actionProfile = {"animationRole": "static-part", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.9}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": true, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Broad-phase proxy; refine after form acceptance."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "beam-band-one", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "dark-timber"}};
  (nodes["root"] ?? root).add(node_beam_band_one_12);
  nodes["beam-band-one"] = node_beam_band_one_12;
  const mesh_beam_band_one_12Geometry = endpoint_beam_band_one_12
    ? new THREE.CylinderGeometry(endpoint_beam_band_one_12.endRadius, endpoint_beam_band_one_12.baseRadius, endpoint_beam_band_one_12.length, 32, 12)
    : new THREE.BoxGeometry(1, 1, 1, 12, 12, 12);
  if (!endpoint_beam_band_one_12) {
    mesh_beam_band_one_12Geometry.scale(15.5, 0.508028651510433, 12.9);
  }
  const mesh_beam_band_one_12 = new THREE.Mesh(
    mesh_beam_band_one_12Geometry,
    materialMap["dark-timber"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_beam_band_one_12.name = "First-storey beam band";
  if (endpoint_beam_band_one_12) {
    mesh_beam_band_one_12.position.copy(endpoint_beam_band_one_12.midpoint);
    mesh_beam_band_one_12.quaternion.copy(endpoint_beam_band_one_12.quaternion);
  }
  mesh_beam_band_one_12.castShadow = options.castShadow ?? true;
  mesh_beam_band_one_12.receiveShadow = options.receiveShadow ?? true;
  mesh_beam_band_one_12.userData.sculptComponent = {"id": "beam-band-one", "name": "First-storey beam band", "level": "meso", "role": "beam-band", "importance": 0.76, "confidence": 0.82, "primitive": "box", "topologyClass": "assembled-solid", "topologyRationale": "A discrete horizontal beam/fang band caps the first-storey column rhythm.", "geometryDescriptor": {"topologyIntent": "separable architectural sub-assembly", "edgeTreatment": {"type": "chamfer", "bevelRadius": 0.012, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "vertex normals from generated geometry"}, "parent": "root", "attachment": null, "dimensions": {"width": 15.5, "height": 0.508028651510433, "depth": 12.9, "units": "metres", "confidence": 0.82}, "transform": {"position": [0, 6.072151977577079, 0], "rotation": [0, 0, 0], "scale": [1, 1, 1]}, "actionProfile": {"animationRole": "static-part", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.9}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": true, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Broad-phase proxy; refine after form acceptance."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "beam-band-one", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "dark-timber"}}, "material": "dark-timber", "materialLayers": ["dark-timber"], "deformations": [], "joints": [], "seams": [], "localFeatures": [{"id": "dougong-system.stepped-brackets", "type": "ridge", "realization": "instanced stepped block groups", "evidenceRefs": ["full-object"]}], "surfaceDetail": {"macroRoughness": 0.12, "microRoughness": 0.08, "bumpAmplitude": 0.02, "normalPattern": "material-specific independent field", "displacementPattern": "none in blockout", "occlusionPattern": "contact and construction seams", "edgeWearPattern": "subtle exposed edge variation", "notes": "Blockout uses scalar PBR response; extracted maps remain review evidence until material pass."}, "colorMaterialRecipe": {"dominantAlbedo": "rgba(30, 22, 20, 1)", "secondaryAlbedo": "rgba(77, 45, 34, 1)", "materialClass": "wood", "materialClassConfidence": 0.82}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "structural-pass"};
  node_beam_band_one_12.add(mesh_beam_band_one_12);
  meshes["beam-band-one"] = mesh_beam_band_one_12;
  colliders["beam-band-one"] = {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Broad-phase proxy; refine after form acceptance."};
  destructionGroups["beam-band-one"] ??= [];
  destructionGroups["beam-band-one"].push(node_beam_band_one_12);

  const attachment_beam_band_two_13 = null;
  const endpoint_beam_band_two_13 = makeAttachmentEndpoint(attachment_beam_band_two_13);
  const node_beam_band_two_13 = new THREE.Group();
  node_beam_band_two_13.name = "Second-storey beam band__pivot";
  node_beam_band_two_13.scale.set(1, 1, 1);
  if (endpoint_beam_band_two_13) {
    node_beam_band_two_13.position.copy(endpoint_beam_band_two_13.start);
    node_beam_band_two_13.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_beam_band_two_13.position.set(0.0, 10.62021800062286, 0.0);
    node_beam_band_two_13.rotation.set(0.0, 0.0, 0.0);
  }
  node_beam_band_two_13.userData.sculptComponent = {"id": "beam-band-two", "name": "Second-storey beam band", "level": "meso", "role": "beam-band", "importance": 0.76, "confidence": 0.82, "primitive": "box", "topologyClass": "assembled-solid", "topologyRationale": "A second rigid beam/fang band supports the middle eave.", "geometryDescriptor": {"topologyIntent": "separable architectural sub-assembly", "edgeTreatment": {"type": "chamfer", "bevelRadius": 0.012, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "vertex normals from generated geometry"}, "parent": "root", "attachment": null, "dimensions": {"width": 13.1, "height": 0.45964497041420127, "depth": 10.6, "units": "metres", "confidence": 0.82}, "transform": {"position": [0, 10.62021800062286, 0], "rotation": [0, 0, 0], "scale": [1, 1, 1]}, "actionProfile": {"animationRole": "static-part", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.9}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": true, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Broad-phase proxy; refine after form acceptance."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "beam-band-two", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "dark-timber"}}, "material": "dark-timber", "materialLayers": ["dark-timber"], "deformations": [], "joints": [], "seams": [], "localFeatures": [], "surfaceDetail": {"macroRoughness": 0.12, "microRoughness": 0.08, "bumpAmplitude": 0.02, "normalPattern": "material-specific independent field", "displacementPattern": "none in blockout", "occlusionPattern": "contact and construction seams", "edgeWearPattern": "subtle exposed edge variation", "notes": "Blockout uses scalar PBR response; extracted maps remain review evidence until material pass."}, "colorMaterialRecipe": {"dominantAlbedo": "rgba(30, 22, 20, 1)", "secondaryAlbedo": "rgba(77, 45, 34, 1)", "materialClass": "wood", "materialClassConfidence": 0.82}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "structural-pass"};
  node_beam_band_two_13.userData.actionProfile = {"animationRole": "static-part", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.9}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": true, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Broad-phase proxy; refine after form acceptance."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "beam-band-two", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "dark-timber"}};
  (nodes["root"] ?? root).add(node_beam_band_two_13);
  nodes["beam-band-two"] = node_beam_band_two_13;
  const mesh_beam_band_two_13Geometry = endpoint_beam_band_two_13
    ? new THREE.CylinderGeometry(endpoint_beam_band_two_13.endRadius, endpoint_beam_band_two_13.baseRadius, endpoint_beam_band_two_13.length, 32, 12)
    : new THREE.BoxGeometry(1, 1, 1, 12, 12, 12);
  if (!endpoint_beam_band_two_13) {
    mesh_beam_band_two_13Geometry.scale(13.1, 0.45964497041420127, 10.6);
  }
  const mesh_beam_band_two_13 = new THREE.Mesh(
    mesh_beam_band_two_13Geometry,
    materialMap["dark-timber"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_beam_band_two_13.name = "Second-storey beam band";
  if (endpoint_beam_band_two_13) {
    mesh_beam_band_two_13.position.copy(endpoint_beam_band_two_13.midpoint);
    mesh_beam_band_two_13.quaternion.copy(endpoint_beam_band_two_13.quaternion);
  }
  mesh_beam_band_two_13.castShadow = options.castShadow ?? true;
  mesh_beam_band_two_13.receiveShadow = options.receiveShadow ?? true;
  mesh_beam_band_two_13.userData.sculptComponent = {"id": "beam-band-two", "name": "Second-storey beam band", "level": "meso", "role": "beam-band", "importance": 0.76, "confidence": 0.82, "primitive": "box", "topologyClass": "assembled-solid", "topologyRationale": "A second rigid beam/fang band supports the middle eave.", "geometryDescriptor": {"topologyIntent": "separable architectural sub-assembly", "edgeTreatment": {"type": "chamfer", "bevelRadius": 0.012, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "vertex normals from generated geometry"}, "parent": "root", "attachment": null, "dimensions": {"width": 13.1, "height": 0.45964497041420127, "depth": 10.6, "units": "metres", "confidence": 0.82}, "transform": {"position": [0, 10.62021800062286, 0], "rotation": [0, 0, 0], "scale": [1, 1, 1]}, "actionProfile": {"animationRole": "static-part", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.9}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": true, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Broad-phase proxy; refine after form acceptance."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "beam-band-two", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "dark-timber"}}, "material": "dark-timber", "materialLayers": ["dark-timber"], "deformations": [], "joints": [], "seams": [], "localFeatures": [], "surfaceDetail": {"macroRoughness": 0.12, "microRoughness": 0.08, "bumpAmplitude": 0.02, "normalPattern": "material-specific independent field", "displacementPattern": "none in blockout", "occlusionPattern": "contact and construction seams", "edgeWearPattern": "subtle exposed edge variation", "notes": "Blockout uses scalar PBR response; extracted maps remain review evidence until material pass."}, "colorMaterialRecipe": {"dominantAlbedo": "rgba(30, 22, 20, 1)", "secondaryAlbedo": "rgba(77, 45, 34, 1)", "materialClass": "wood", "materialClassConfidence": 0.82}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "structural-pass"};
  node_beam_band_two_13.add(mesh_beam_band_two_13);
  meshes["beam-band-two"] = mesh_beam_band_two_13;
  colliders["beam-band-two"] = {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Broad-phase proxy; refine after form acceptance."};
  destructionGroups["beam-band-two"] ??= [];
  destructionGroups["beam-band-two"].push(node_beam_band_two_13);

  const attachment_beam_band_three_14 = null;
  const endpoint_beam_band_three_14 = makeAttachmentEndpoint(attachment_beam_band_three_14);
  const node_beam_band_three_14 = new THREE.Group();
  node_beam_band_three_14.name = "Third-storey beam band__pivot";
  node_beam_band_three_14.scale.set(1, 1, 1);
  if (endpoint_beam_band_three_14) {
    node_beam_band_three_14.position.copy(endpoint_beam_band_three_14.start);
    node_beam_band_three_14.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_beam_band_three_14.position.set(0.0, 15.05942074120212, 0.0);
    node_beam_band_three_14.rotation.set(0.0, 0.0, 0.0);
  }
  node_beam_band_three_14.userData.sculptComponent = {"id": "beam-band-three", "name": "Third-storey beam band", "level": "meso", "role": "beam-band", "importance": 0.76, "confidence": 0.82, "primitive": "box", "topologyClass": "assembled-solid", "topologyRationale": "A compact upper beam/fang band supports the helmet roof.", "geometryDescriptor": {"topologyIntent": "separable architectural sub-assembly", "edgeTreatment": {"type": "chamfer", "bevelRadius": 0.012, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "vertex normals from generated geometry"}, "parent": "root", "attachment": null, "dimensions": {"width": 10.2, "height": 0.42335720959202744, "depth": 8.2, "units": "metres", "confidence": 0.82}, "transform": {"position": [0, 15.05942074120212, 0], "rotation": [0, 0, 0], "scale": [1, 1, 1]}, "actionProfile": {"animationRole": "static-part", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.9}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": true, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Broad-phase proxy; refine after form acceptance."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "beam-band-three", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "dark-timber"}}, "material": "dark-timber", "materialLayers": ["dark-timber"], "deformations": [], "joints": [], "seams": [], "localFeatures": [], "surfaceDetail": {"macroRoughness": 0.12, "microRoughness": 0.08, "bumpAmplitude": 0.02, "normalPattern": "material-specific independent field", "displacementPattern": "none in blockout", "occlusionPattern": "contact and construction seams", "edgeWearPattern": "subtle exposed edge variation", "notes": "Blockout uses scalar PBR response; extracted maps remain review evidence until material pass."}, "colorMaterialRecipe": {"dominantAlbedo": "rgba(30, 22, 20, 1)", "secondaryAlbedo": "rgba(77, 45, 34, 1)", "materialClass": "wood", "materialClassConfidence": 0.82}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "structural-pass"};
  node_beam_band_three_14.userData.actionProfile = {"animationRole": "static-part", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.9}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": true, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Broad-phase proxy; refine after form acceptance."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "beam-band-three", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "dark-timber"}};
  (nodes["root"] ?? root).add(node_beam_band_three_14);
  nodes["beam-band-three"] = node_beam_band_three_14;
  const mesh_beam_band_three_14Geometry = endpoint_beam_band_three_14
    ? new THREE.CylinderGeometry(endpoint_beam_band_three_14.endRadius, endpoint_beam_band_three_14.baseRadius, endpoint_beam_band_three_14.length, 32, 12)
    : new THREE.BoxGeometry(1, 1, 1, 12, 12, 12);
  if (!endpoint_beam_band_three_14) {
    mesh_beam_band_three_14Geometry.scale(10.2, 0.42335720959202744, 8.2);
  }
  const mesh_beam_band_three_14 = new THREE.Mesh(
    mesh_beam_band_three_14Geometry,
    materialMap["dark-timber"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_beam_band_three_14.name = "Third-storey beam band";
  if (endpoint_beam_band_three_14) {
    mesh_beam_band_three_14.position.copy(endpoint_beam_band_three_14.midpoint);
    mesh_beam_band_three_14.quaternion.copy(endpoint_beam_band_three_14.quaternion);
  }
  mesh_beam_band_three_14.castShadow = options.castShadow ?? true;
  mesh_beam_band_three_14.receiveShadow = options.receiveShadow ?? true;
  mesh_beam_band_three_14.userData.sculptComponent = {"id": "beam-band-three", "name": "Third-storey beam band", "level": "meso", "role": "beam-band", "importance": 0.76, "confidence": 0.82, "primitive": "box", "topologyClass": "assembled-solid", "topologyRationale": "A compact upper beam/fang band supports the helmet roof.", "geometryDescriptor": {"topologyIntent": "separable architectural sub-assembly", "edgeTreatment": {"type": "chamfer", "bevelRadius": 0.012, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "vertex normals from generated geometry"}, "parent": "root", "attachment": null, "dimensions": {"width": 10.2, "height": 0.42335720959202744, "depth": 8.2, "units": "metres", "confidence": 0.82}, "transform": {"position": [0, 15.05942074120212, 0], "rotation": [0, 0, 0], "scale": [1, 1, 1]}, "actionProfile": {"animationRole": "static-part", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.9}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": true, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Broad-phase proxy; refine after form acceptance."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "beam-band-three", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "dark-timber"}}, "material": "dark-timber", "materialLayers": ["dark-timber"], "deformations": [], "joints": [], "seams": [], "localFeatures": [], "surfaceDetail": {"macroRoughness": 0.12, "microRoughness": 0.08, "bumpAmplitude": 0.02, "normalPattern": "material-specific independent field", "displacementPattern": "none in blockout", "occlusionPattern": "contact and construction seams", "edgeWearPattern": "subtle exposed edge variation", "notes": "Blockout uses scalar PBR response; extracted maps remain review evidence until material pass."}, "colorMaterialRecipe": {"dominantAlbedo": "rgba(30, 22, 20, 1)", "secondaryAlbedo": "rgba(77, 45, 34, 1)", "materialClass": "wood", "materialClassConfidence": 0.82}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "structural-pass"};
  node_beam_band_three_14.add(mesh_beam_band_three_14);
  meshes["beam-band-three"] = mesh_beam_band_three_14;
  colliders["beam-band-three"] = {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Broad-phase proxy; refine after form acceptance."};
  destructionGroups["beam-band-three"] ??= [];
  destructionGroups["beam-band-three"].push(node_beam_band_three_14);

  const attachment_railing_front_15 = null;
  const endpoint_railing_front_15 = makeAttachmentEndpoint(attachment_railing_front_15);
  const node_railing_front_15 = new THREE.Group();
  node_railing_front_15.name = "Front gallery railing carrier__pivot";
  node_railing_front_15.scale.set(1, 1, 1);
  if (endpoint_railing_front_15) {
    node_railing_front_15.position.copy(endpoint_railing_front_15.start);
    node_railing_front_15.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_railing_front_15.position.set(0.0, 8.104266583618811, 5.78);
    node_railing_front_15.rotation.set(0.0, 0.0, 0.0);
  }
  node_railing_front_15.userData.sculptComponent = {"id": "railing-front", "name": "Front gallery railing carrier", "level": "meso", "role": "railing", "importance": 0.76, "confidence": 0.82, "primitive": "box", "topologyClass": "assembled-solid", "topologyRationale": "A thin rigid carrier establishes the front railing silhouette before lattice instancing.", "geometryDescriptor": {"topologyIntent": "separable architectural sub-assembly", "edgeTreatment": {"type": "chamfer", "bevelRadius": 0.012, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "vertex normals from generated geometry"}, "parent": "root", "attachment": null, "dimensions": {"width": 13.4, "height": 1.1128246652133293, "depth": 0.14, "units": "metres", "confidence": 0.82}, "transform": {"position": [0, 8.104266583618811, 5.78], "rotation": [0, 0, 0], "scale": [1, 1, 1]}, "actionProfile": {"animationRole": "static-part", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.9}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": true, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Broad-phase proxy; refine after form acceptance."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "railing-front", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "dark-timber"}}, "material": "dark-timber", "materialLayers": ["dark-timber"], "deformations": [], "joints": [], "seams": [], "localFeatures": [], "surfaceDetail": {"macroRoughness": 0.12, "microRoughness": 0.08, "bumpAmplitude": 0.02, "normalPattern": "material-specific independent field", "displacementPattern": "none in blockout", "occlusionPattern": "contact and construction seams", "edgeWearPattern": "subtle exposed edge variation", "notes": "Blockout uses scalar PBR response; extracted maps remain review evidence until material pass."}, "colorMaterialRecipe": {"dominantAlbedo": "rgba(30, 22, 20, 1)", "secondaryAlbedo": "rgba(77, 45, 34, 1)", "materialClass": "wood", "materialClassConfidence": 0.82}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "structural-pass"};
  node_railing_front_15.userData.actionProfile = {"animationRole": "static-part", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.9}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": true, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Broad-phase proxy; refine after form acceptance."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "railing-front", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "dark-timber"}};
  (nodes["root"] ?? root).add(node_railing_front_15);
  nodes["railing-front"] = node_railing_front_15;
  const mesh_railing_front_15Geometry = endpoint_railing_front_15
    ? new THREE.CylinderGeometry(endpoint_railing_front_15.endRadius, endpoint_railing_front_15.baseRadius, endpoint_railing_front_15.length, 32, 12)
    : new THREE.BoxGeometry(1, 1, 1, 12, 12, 12);
  if (!endpoint_railing_front_15) {
    mesh_railing_front_15Geometry.scale(13.4, 1.1128246652133293, 0.14);
  }
  const mesh_railing_front_15 = new THREE.Mesh(
    mesh_railing_front_15Geometry,
    materialMap["dark-timber"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_railing_front_15.name = "Front gallery railing carrier";
  if (endpoint_railing_front_15) {
    mesh_railing_front_15.position.copy(endpoint_railing_front_15.midpoint);
    mesh_railing_front_15.quaternion.copy(endpoint_railing_front_15.quaternion);
  }
  mesh_railing_front_15.castShadow = options.castShadow ?? true;
  mesh_railing_front_15.receiveShadow = options.receiveShadow ?? true;
  mesh_railing_front_15.userData.sculptComponent = {"id": "railing-front", "name": "Front gallery railing carrier", "level": "meso", "role": "railing", "importance": 0.76, "confidence": 0.82, "primitive": "box", "topologyClass": "assembled-solid", "topologyRationale": "A thin rigid carrier establishes the front railing silhouette before lattice instancing.", "geometryDescriptor": {"topologyIntent": "separable architectural sub-assembly", "edgeTreatment": {"type": "chamfer", "bevelRadius": 0.012, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "vertex normals from generated geometry"}, "parent": "root", "attachment": null, "dimensions": {"width": 13.4, "height": 1.1128246652133293, "depth": 0.14, "units": "metres", "confidence": 0.82}, "transform": {"position": [0, 8.104266583618811, 5.78], "rotation": [0, 0, 0], "scale": [1, 1, 1]}, "actionProfile": {"animationRole": "static-part", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.9}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": true, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Broad-phase proxy; refine after form acceptance."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "railing-front", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "dark-timber"}}, "material": "dark-timber", "materialLayers": ["dark-timber"], "deformations": [], "joints": [], "seams": [], "localFeatures": [], "surfaceDetail": {"macroRoughness": 0.12, "microRoughness": 0.08, "bumpAmplitude": 0.02, "normalPattern": "material-specific independent field", "displacementPattern": "none in blockout", "occlusionPattern": "contact and construction seams", "edgeWearPattern": "subtle exposed edge variation", "notes": "Blockout uses scalar PBR response; extracted maps remain review evidence until material pass."}, "colorMaterialRecipe": {"dominantAlbedo": "rgba(30, 22, 20, 1)", "secondaryAlbedo": "rgba(77, 45, 34, 1)", "materialClass": "wood", "materialClassConfidence": 0.82}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "structural-pass"};
  node_railing_front_15.add(mesh_railing_front_15);
  meshes["railing-front"] = mesh_railing_front_15;
  colliders["railing-front"] = {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Broad-phase proxy; refine after form acceptance."};
  destructionGroups["railing-front"] ??= [];
  destructionGroups["railing-front"].push(node_railing_front_15);

  const attachment_railing_back_16 = null;
  const endpoint_railing_back_16 = makeAttachmentEndpoint(attachment_railing_back_16);
  const node_railing_back_16 = new THREE.Group();
  node_railing_back_16.name = "Rear gallery railing carrier__pivot";
  node_railing_back_16.scale.set(1, 1, 1);
  if (endpoint_railing_back_16) {
    node_railing_back_16.position.copy(endpoint_railing_back_16.start);
    node_railing_back_16.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_railing_back_16.position.set(0.0, 8.104266583618811, -5.78);
    node_railing_back_16.rotation.set(0.0, 0.0, 0.0);
  }
  node_railing_back_16.userData.sculptComponent = {"id": "railing-back", "name": "Rear gallery railing carrier", "level": "meso", "role": "railing", "importance": 0.76, "confidence": 0.82, "primitive": "box", "topologyClass": "assembled-solid", "topologyRationale": "A mirrored thin carrier encodes the inferred rear gallery boundary.", "geometryDescriptor": {"topologyIntent": "separable architectural sub-assembly", "edgeTreatment": {"type": "chamfer", "bevelRadius": 0.012, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "vertex normals from generated geometry"}, "parent": "root", "attachment": null, "dimensions": {"width": 13.4, "height": 1.1128246652133293, "depth": 0.14, "units": "metres", "confidence": 0.82}, "transform": {"position": [0, 8.104266583618811, -5.78], "rotation": [0, 0, 0], "scale": [1, 1, 1]}, "actionProfile": {"animationRole": "static-part", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.9}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": true, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Broad-phase proxy; refine after form acceptance."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "railing-back", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "dark-timber"}}, "material": "dark-timber", "materialLayers": ["dark-timber"], "deformations": [], "joints": [], "seams": [], "localFeatures": [], "surfaceDetail": {"macroRoughness": 0.12, "microRoughness": 0.08, "bumpAmplitude": 0.02, "normalPattern": "material-specific independent field", "displacementPattern": "none in blockout", "occlusionPattern": "contact and construction seams", "edgeWearPattern": "subtle exposed edge variation", "notes": "Blockout uses scalar PBR response; extracted maps remain review evidence until material pass."}, "colorMaterialRecipe": {"dominantAlbedo": "rgba(30, 22, 20, 1)", "secondaryAlbedo": "rgba(77, 45, 34, 1)", "materialClass": "wood", "materialClassConfidence": 0.82}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "structural-pass"};
  node_railing_back_16.userData.actionProfile = {"animationRole": "static-part", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.9}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": true, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Broad-phase proxy; refine after form acceptance."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "railing-back", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "dark-timber"}};
  (nodes["root"] ?? root).add(node_railing_back_16);
  nodes["railing-back"] = node_railing_back_16;
  const mesh_railing_back_16Geometry = endpoint_railing_back_16
    ? new THREE.CylinderGeometry(endpoint_railing_back_16.endRadius, endpoint_railing_back_16.baseRadius, endpoint_railing_back_16.length, 32, 12)
    : new THREE.BoxGeometry(1, 1, 1, 12, 12, 12);
  if (!endpoint_railing_back_16) {
    mesh_railing_back_16Geometry.scale(13.4, 1.1128246652133293, 0.14);
  }
  const mesh_railing_back_16 = new THREE.Mesh(
    mesh_railing_back_16Geometry,
    materialMap["dark-timber"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_railing_back_16.name = "Rear gallery railing carrier";
  if (endpoint_railing_back_16) {
    mesh_railing_back_16.position.copy(endpoint_railing_back_16.midpoint);
    mesh_railing_back_16.quaternion.copy(endpoint_railing_back_16.quaternion);
  }
  mesh_railing_back_16.castShadow = options.castShadow ?? true;
  mesh_railing_back_16.receiveShadow = options.receiveShadow ?? true;
  mesh_railing_back_16.userData.sculptComponent = {"id": "railing-back", "name": "Rear gallery railing carrier", "level": "meso", "role": "railing", "importance": 0.76, "confidence": 0.82, "primitive": "box", "topologyClass": "assembled-solid", "topologyRationale": "A mirrored thin carrier encodes the inferred rear gallery boundary.", "geometryDescriptor": {"topologyIntent": "separable architectural sub-assembly", "edgeTreatment": {"type": "chamfer", "bevelRadius": 0.012, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "vertex normals from generated geometry"}, "parent": "root", "attachment": null, "dimensions": {"width": 13.4, "height": 1.1128246652133293, "depth": 0.14, "units": "metres", "confidence": 0.82}, "transform": {"position": [0, 8.104266583618811, -5.78], "rotation": [0, 0, 0], "scale": [1, 1, 1]}, "actionProfile": {"animationRole": "static-part", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.9}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": true, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Broad-phase proxy; refine after form acceptance."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "railing-back", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "dark-timber"}}, "material": "dark-timber", "materialLayers": ["dark-timber"], "deformations": [], "joints": [], "seams": [], "localFeatures": [], "surfaceDetail": {"macroRoughness": 0.12, "microRoughness": 0.08, "bumpAmplitude": 0.02, "normalPattern": "material-specific independent field", "displacementPattern": "none in blockout", "occlusionPattern": "contact and construction seams", "edgeWearPattern": "subtle exposed edge variation", "notes": "Blockout uses scalar PBR response; extracted maps remain review evidence until material pass."}, "colorMaterialRecipe": {"dominantAlbedo": "rgba(30, 22, 20, 1)", "secondaryAlbedo": "rgba(77, 45, 34, 1)", "materialClass": "wood", "materialClassConfidence": 0.82}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "structural-pass"};
  node_railing_back_16.add(mesh_railing_back_16);
  meshes["railing-back"] = mesh_railing_back_16;
  colliders["railing-back"] = {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Broad-phase proxy; refine after form acceptance."};
  destructionGroups["railing-back"] ??= [];
  destructionGroups["railing-back"].push(node_railing_back_16);

  const attachment_railing_left_17 = null;
  const endpoint_railing_left_17 = makeAttachmentEndpoint(attachment_railing_left_17);
  const node_railing_left_17 = new THREE.Group();
  node_railing_left_17.name = "Left gallery railing carrier__pivot";
  node_railing_left_17.scale.set(1, 1, 1);
  if (endpoint_railing_left_17) {
    node_railing_left_17.position.copy(endpoint_railing_left_17.start);
    node_railing_left_17.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_railing_left_17.position.set(-7.08, 8.104266583618811, 0.0);
    node_railing_left_17.rotation.set(0.0, 0.0, 0.0);
  }
  node_railing_left_17.userData.sculptComponent = {"id": "railing-left", "name": "Left gallery railing carrier", "level": "meso", "role": "railing", "importance": 0.76, "confidence": 0.82, "primitive": "box", "topologyClass": "assembled-solid", "topologyRationale": "A thin rigid side carrier preserves the rectangular gallery perimeter.", "geometryDescriptor": {"topologyIntent": "separable architectural sub-assembly", "edgeTreatment": {"type": "chamfer", "bevelRadius": 0.012, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "vertex normals from generated geometry"}, "parent": "root", "attachment": null, "dimensions": {"width": 0.14, "height": 1.1128246652133293, "depth": 11.4, "units": "metres", "confidence": 0.82}, "transform": {"position": [-7.08, 8.104266583618811, 0], "rotation": [0, 0, 0], "scale": [1, 1, 1]}, "actionProfile": {"animationRole": "static-part", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.9}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": true, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Broad-phase proxy; refine after form acceptance."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "railing-left", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "dark-timber"}}, "material": "dark-timber", "materialLayers": ["dark-timber"], "deformations": [], "joints": [], "seams": [], "localFeatures": [], "surfaceDetail": {"macroRoughness": 0.12, "microRoughness": 0.08, "bumpAmplitude": 0.02, "normalPattern": "material-specific independent field", "displacementPattern": "none in blockout", "occlusionPattern": "contact and construction seams", "edgeWearPattern": "subtle exposed edge variation", "notes": "Blockout uses scalar PBR response; extracted maps remain review evidence until material pass."}, "colorMaterialRecipe": {"dominantAlbedo": "rgba(30, 22, 20, 1)", "secondaryAlbedo": "rgba(77, 45, 34, 1)", "materialClass": "wood", "materialClassConfidence": 0.82}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "structural-pass"};
  node_railing_left_17.userData.actionProfile = {"animationRole": "static-part", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.9}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": true, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Broad-phase proxy; refine after form acceptance."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "railing-left", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "dark-timber"}};
  (nodes["root"] ?? root).add(node_railing_left_17);
  nodes["railing-left"] = node_railing_left_17;
  const mesh_railing_left_17Geometry = endpoint_railing_left_17
    ? new THREE.CylinderGeometry(endpoint_railing_left_17.endRadius, endpoint_railing_left_17.baseRadius, endpoint_railing_left_17.length, 32, 12)
    : new THREE.BoxGeometry(1, 1, 1, 12, 12, 12);
  if (!endpoint_railing_left_17) {
    mesh_railing_left_17Geometry.scale(0.14, 1.1128246652133293, 11.4);
  }
  const mesh_railing_left_17 = new THREE.Mesh(
    mesh_railing_left_17Geometry,
    materialMap["dark-timber"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_railing_left_17.name = "Left gallery railing carrier";
  if (endpoint_railing_left_17) {
    mesh_railing_left_17.position.copy(endpoint_railing_left_17.midpoint);
    mesh_railing_left_17.quaternion.copy(endpoint_railing_left_17.quaternion);
  }
  mesh_railing_left_17.castShadow = options.castShadow ?? true;
  mesh_railing_left_17.receiveShadow = options.receiveShadow ?? true;
  mesh_railing_left_17.userData.sculptComponent = {"id": "railing-left", "name": "Left gallery railing carrier", "level": "meso", "role": "railing", "importance": 0.76, "confidence": 0.82, "primitive": "box", "topologyClass": "assembled-solid", "topologyRationale": "A thin rigid side carrier preserves the rectangular gallery perimeter.", "geometryDescriptor": {"topologyIntent": "separable architectural sub-assembly", "edgeTreatment": {"type": "chamfer", "bevelRadius": 0.012, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "vertex normals from generated geometry"}, "parent": "root", "attachment": null, "dimensions": {"width": 0.14, "height": 1.1128246652133293, "depth": 11.4, "units": "metres", "confidence": 0.82}, "transform": {"position": [-7.08, 8.104266583618811, 0], "rotation": [0, 0, 0], "scale": [1, 1, 1]}, "actionProfile": {"animationRole": "static-part", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.9}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": true, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Broad-phase proxy; refine after form acceptance."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "railing-left", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "dark-timber"}}, "material": "dark-timber", "materialLayers": ["dark-timber"], "deformations": [], "joints": [], "seams": [], "localFeatures": [], "surfaceDetail": {"macroRoughness": 0.12, "microRoughness": 0.08, "bumpAmplitude": 0.02, "normalPattern": "material-specific independent field", "displacementPattern": "none in blockout", "occlusionPattern": "contact and construction seams", "edgeWearPattern": "subtle exposed edge variation", "notes": "Blockout uses scalar PBR response; extracted maps remain review evidence until material pass."}, "colorMaterialRecipe": {"dominantAlbedo": "rgba(30, 22, 20, 1)", "secondaryAlbedo": "rgba(77, 45, 34, 1)", "materialClass": "wood", "materialClassConfidence": 0.82}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "structural-pass"};
  node_railing_left_17.add(mesh_railing_left_17);
  meshes["railing-left"] = mesh_railing_left_17;
  colliders["railing-left"] = {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Broad-phase proxy; refine after form acceptance."};
  destructionGroups["railing-left"] ??= [];
  destructionGroups["railing-left"].push(node_railing_left_17);

  const attachment_railing_right_18 = null;
  const endpoint_railing_right_18 = makeAttachmentEndpoint(attachment_railing_right_18);
  const node_railing_right_18 = new THREE.Group();
  node_railing_right_18.name = "Right gallery railing carrier__pivot";
  node_railing_right_18.scale.set(1, 1, 1);
  if (endpoint_railing_right_18) {
    node_railing_right_18.position.copy(endpoint_railing_right_18.start);
    node_railing_right_18.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_railing_right_18.position.set(7.08, 8.104266583618811, 0.0);
    node_railing_right_18.rotation.set(0.0, 0.0, 0.0);
  }
  node_railing_right_18.userData.sculptComponent = {"id": "railing-right", "name": "Right gallery railing carrier", "level": "meso", "role": "railing", "importance": 0.76, "confidence": 0.82, "primitive": "box", "topologyClass": "assembled-solid", "topologyRationale": "A mirrored thin side carrier preserves the rectangular gallery perimeter.", "geometryDescriptor": {"topologyIntent": "separable architectural sub-assembly", "edgeTreatment": {"type": "chamfer", "bevelRadius": 0.012, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "vertex normals from generated geometry"}, "parent": "root", "attachment": null, "dimensions": {"width": 0.14, "height": 1.1128246652133293, "depth": 11.4, "units": "metres", "confidence": 0.82}, "transform": {"position": [7.08, 8.104266583618811, 0], "rotation": [0, 0, 0], "scale": [1, 1, 1]}, "actionProfile": {"animationRole": "static-part", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.9}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": true, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Broad-phase proxy; refine after form acceptance."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "railing-right", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "dark-timber"}}, "material": "dark-timber", "materialLayers": ["dark-timber"], "deformations": [], "joints": [], "seams": [], "localFeatures": [], "surfaceDetail": {"macroRoughness": 0.12, "microRoughness": 0.08, "bumpAmplitude": 0.02, "normalPattern": "material-specific independent field", "displacementPattern": "none in blockout", "occlusionPattern": "contact and construction seams", "edgeWearPattern": "subtle exposed edge variation", "notes": "Blockout uses scalar PBR response; extracted maps remain review evidence until material pass."}, "colorMaterialRecipe": {"dominantAlbedo": "rgba(30, 22, 20, 1)", "secondaryAlbedo": "rgba(77, 45, 34, 1)", "materialClass": "wood", "materialClassConfidence": 0.82}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "structural-pass"};
  node_railing_right_18.userData.actionProfile = {"animationRole": "static-part", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.9}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": true, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Broad-phase proxy; refine after form acceptance."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "railing-right", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "dark-timber"}};
  (nodes["root"] ?? root).add(node_railing_right_18);
  nodes["railing-right"] = node_railing_right_18;
  const mesh_railing_right_18Geometry = endpoint_railing_right_18
    ? new THREE.CylinderGeometry(endpoint_railing_right_18.endRadius, endpoint_railing_right_18.baseRadius, endpoint_railing_right_18.length, 32, 12)
    : new THREE.BoxGeometry(1, 1, 1, 12, 12, 12);
  if (!endpoint_railing_right_18) {
    mesh_railing_right_18Geometry.scale(0.14, 1.1128246652133293, 11.4);
  }
  const mesh_railing_right_18 = new THREE.Mesh(
    mesh_railing_right_18Geometry,
    materialMap["dark-timber"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_railing_right_18.name = "Right gallery railing carrier";
  if (endpoint_railing_right_18) {
    mesh_railing_right_18.position.copy(endpoint_railing_right_18.midpoint);
    mesh_railing_right_18.quaternion.copy(endpoint_railing_right_18.quaternion);
  }
  mesh_railing_right_18.castShadow = options.castShadow ?? true;
  mesh_railing_right_18.receiveShadow = options.receiveShadow ?? true;
  mesh_railing_right_18.userData.sculptComponent = {"id": "railing-right", "name": "Right gallery railing carrier", "level": "meso", "role": "railing", "importance": 0.76, "confidence": 0.82, "primitive": "box", "topologyClass": "assembled-solid", "topologyRationale": "A mirrored thin side carrier preserves the rectangular gallery perimeter.", "geometryDescriptor": {"topologyIntent": "separable architectural sub-assembly", "edgeTreatment": {"type": "chamfer", "bevelRadius": 0.012, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "vertex normals from generated geometry"}, "parent": "root", "attachment": null, "dimensions": {"width": 0.14, "height": 1.1128246652133293, "depth": 11.4, "units": "metres", "confidence": 0.82}, "transform": {"position": [7.08, 8.104266583618811, 0], "rotation": [0, 0, 0], "scale": [1, 1, 1]}, "actionProfile": {"animationRole": "static-part", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.9}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": true, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Broad-phase proxy; refine after form acceptance."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "railing-right", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "dark-timber"}}, "material": "dark-timber", "materialLayers": ["dark-timber"], "deformations": [], "joints": [], "seams": [], "localFeatures": [], "surfaceDetail": {"macroRoughness": 0.12, "microRoughness": 0.08, "bumpAmplitude": 0.02, "normalPattern": "material-specific independent field", "displacementPattern": "none in blockout", "occlusionPattern": "contact and construction seams", "edgeWearPattern": "subtle exposed edge variation", "notes": "Blockout uses scalar PBR response; extracted maps remain review evidence until material pass."}, "colorMaterialRecipe": {"dominantAlbedo": "rgba(30, 22, 20, 1)", "secondaryAlbedo": "rgba(77, 45, 34, 1)", "materialClass": "wood", "materialClassConfidence": 0.82}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "structural-pass"};
  node_railing_right_18.add(mesh_railing_right_18);
  meshes["railing-right"] = mesh_railing_right_18;
  colliders["railing-right"] = {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Broad-phase proxy; refine after form acceptance."};
  destructionGroups["railing-right"] ??= [];
  destructionGroups["railing-right"].push(node_railing_right_18);

  const attachment_upper_plaque_19 = null;
  const endpoint_upper_plaque_19 = makeAttachmentEndpoint(attachment_upper_plaque_19);
  const node_upper_plaque_19 = new THREE.Group();
  node_upper_plaque_19.name = "Upper plaque carrier__pivot";
  node_upper_plaque_19.scale.set(1, 1, 1);
  if (endpoint_upper_plaque_19) {
    node_upper_plaque_19.position.copy(endpoint_upper_plaque_19.start);
    node_upper_plaque_19.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_upper_plaque_19.position.set(0.0, 14.212706322018064, 4.02);
    node_upper_plaque_19.rotation.set(0.0, 0.0, 0.0);
  }
  node_upper_plaque_19.userData.sculptComponent = {"id": "upper-plaque", "name": "Upper plaque carrier", "level": "meso", "role": "plaque", "importance": 0.76, "confidence": 0.82, "primitive": "plane-card", "topologyClass": "material-only", "topologyRationale": "A flat plaque/decal carrier sits on the front facade and has negligible independent volume.", "geometryDescriptor": {"topologyIntent": "separable architectural sub-assembly", "edgeTreatment": {"type": "chamfer", "bevelRadius": 0.012, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "vertex normals from generated geometry"}, "parent": "root", "attachment": null, "dimensions": {"width": 3.6, "height": 0.9434817813765184, "depth": 0.03, "units": "metres", "confidence": 0.82}, "transform": {"position": [0, 14.212706322018064, 4.02], "rotation": [0, 0, 0], "scale": [1, 1, 1]}, "actionProfile": {"animationRole": "static-part", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.9}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": true, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Broad-phase proxy; refine after form acceptance."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "upper-plaque", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "dark-timber"}}, "material": "gold-accent", "materialLayers": ["gold-accent"], "deformations": [], "joints": [], "seams": [], "localFeatures": [], "surfaceDetail": {"macroRoughness": 0.12, "microRoughness": 0.08, "bumpAmplitude": 0.02, "normalPattern": "material-specific independent field", "displacementPattern": "none in blockout", "occlusionPattern": "contact and construction seams", "edgeWearPattern": "subtle exposed edge variation", "notes": "Blockout uses scalar PBR response; extracted maps remain review evidence until material pass."}, "colorMaterialRecipe": {"dominantAlbedo": "rgba(190, 133, 39, 1)", "secondaryAlbedo": "rgba(82, 51, 18, 1)", "materialClass": "metal", "materialClassConfidence": 0.72}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "structural-pass"};
  node_upper_plaque_19.userData.actionProfile = {"animationRole": "static-part", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.9}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": true, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Broad-phase proxy; refine after form acceptance."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "upper-plaque", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "dark-timber"}};
  (nodes["root"] ?? root).add(node_upper_plaque_19);
  nodes["upper-plaque"] = node_upper_plaque_19;
  const mesh_upper_plaque_19Geometry = endpoint_upper_plaque_19
    ? new THREE.CylinderGeometry(endpoint_upper_plaque_19.endRadius, endpoint_upper_plaque_19.baseRadius, endpoint_upper_plaque_19.length, 32, 12)
    : new THREE.PlaneGeometry(1, 1, 24, 24);
  if (!endpoint_upper_plaque_19) {
    mesh_upper_plaque_19Geometry.scale(3.6, 0.9434817813765184, 0.03);
  }
  const mesh_upper_plaque_19 = new THREE.Mesh(
    mesh_upper_plaque_19Geometry,
    materialMap["gold-accent"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_upper_plaque_19.name = "Upper plaque carrier";
  if (endpoint_upper_plaque_19) {
    mesh_upper_plaque_19.position.copy(endpoint_upper_plaque_19.midpoint);
    mesh_upper_plaque_19.quaternion.copy(endpoint_upper_plaque_19.quaternion);
  }
  mesh_upper_plaque_19.castShadow = options.castShadow ?? true;
  mesh_upper_plaque_19.receiveShadow = options.receiveShadow ?? true;
  mesh_upper_plaque_19.userData.sculptComponent = {"id": "upper-plaque", "name": "Upper plaque carrier", "level": "meso", "role": "plaque", "importance": 0.76, "confidence": 0.82, "primitive": "plane-card", "topologyClass": "material-only", "topologyRationale": "A flat plaque/decal carrier sits on the front facade and has negligible independent volume.", "geometryDescriptor": {"topologyIntent": "separable architectural sub-assembly", "edgeTreatment": {"type": "chamfer", "bevelRadius": 0.012, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "vertex normals from generated geometry"}, "parent": "root", "attachment": null, "dimensions": {"width": 3.6, "height": 0.9434817813765184, "depth": 0.03, "units": "metres", "confidence": 0.82}, "transform": {"position": [0, 14.212706322018064, 4.02], "rotation": [0, 0, 0], "scale": [1, 1, 1]}, "actionProfile": {"animationRole": "static-part", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.9}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": true, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Broad-phase proxy; refine after form acceptance."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "upper-plaque", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "dark-timber"}}, "material": "gold-accent", "materialLayers": ["gold-accent"], "deformations": [], "joints": [], "seams": [], "localFeatures": [], "surfaceDetail": {"macroRoughness": 0.12, "microRoughness": 0.08, "bumpAmplitude": 0.02, "normalPattern": "material-specific independent field", "displacementPattern": "none in blockout", "occlusionPattern": "contact and construction seams", "edgeWearPattern": "subtle exposed edge variation", "notes": "Blockout uses scalar PBR response; extracted maps remain review evidence until material pass."}, "colorMaterialRecipe": {"dominantAlbedo": "rgba(190, 133, 39, 1)", "secondaryAlbedo": "rgba(82, 51, 18, 1)", "materialClass": "metal", "materialClassConfidence": 0.72}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "structural-pass"};
  node_upper_plaque_19.add(mesh_upper_plaque_19);
  meshes["upper-plaque"] = mesh_upper_plaque_19;
  colliders["upper-plaque"] = {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Broad-phase proxy; refine after form acceptance."};
  destructionGroups["upper-plaque"] ??= [];
  destructionGroups["upper-plaque"].push(node_upper_plaque_19);

  const attachment_front_steps_20 = null;
  const endpoint_front_steps_20 = makeAttachmentEndpoint(attachment_front_steps_20);
  const node_front_steps_20 = new THREE.Group();
  node_front_steps_20.name = "Front stone step mass__pivot";
  node_front_steps_20.scale.set(1, 1, 1);
  if (endpoint_front_steps_20) {
    node_front_steps_20.position.copy(endpoint_front_steps_20.start);
    node_front_steps_20.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_front_steps_20.position.set(0.0, 0.42335720959202744, 8.05);
    node_front_steps_20.rotation.set(0.0, 0.0, 0.0);
  }
  node_front_steps_20.userData.sculptComponent = {"id": "front-steps", "name": "Front stone step mass", "level": "meso", "role": "stair", "importance": 0.76, "confidence": 0.82, "primitive": "box", "topologyClass": "assembled-solid", "topologyRationale": "The visible access steps form a discrete rigid stone mass in the front axis.", "geometryDescriptor": {"topologyIntent": "separable architectural sub-assembly", "edgeTreatment": {"type": "chamfer", "bevelRadius": 0.012, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "vertex normals from generated geometry"}, "parent": "root", "attachment": null, "dimensions": {"width": 5.6, "height": 0.6652756150731861, "depth": 2.2, "units": "metres", "confidence": 0.82}, "transform": {"position": [0, 0.42335720959202744, 8.05], "rotation": [0, 0, 0], "scale": [1, 1, 1]}, "actionProfile": {"animationRole": "static-part", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.9}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": true, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Broad-phase proxy; refine after form acceptance."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "front-steps", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "dark-timber"}}, "material": "granite-stone", "materialLayers": ["granite-stone"], "deformations": [], "joints": [], "seams": [], "localFeatures": [], "surfaceDetail": {"macroRoughness": 0.12, "microRoughness": 0.08, "bumpAmplitude": 0.02, "normalPattern": "material-specific independent field", "displacementPattern": "none in blockout", "occlusionPattern": "contact and construction seams", "edgeWearPattern": "subtle exposed edge variation", "notes": "Blockout uses scalar PBR response; extracted maps remain review evidence until material pass."}, "colorMaterialRecipe": {"dominantAlbedo": "rgba(148, 145, 135, 1)", "secondaryAlbedo": "rgba(94, 92, 86, 1)", "materialClass": "stone", "materialClassConfidence": 0.82}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "structural-pass"};
  node_front_steps_20.userData.actionProfile = {"animationRole": "static-part", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.9}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": true, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Broad-phase proxy; refine after form acceptance."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "front-steps", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "dark-timber"}};
  (nodes["root"] ?? root).add(node_front_steps_20);
  nodes["front-steps"] = node_front_steps_20;
  const mesh_front_steps_20Geometry = endpoint_front_steps_20
    ? new THREE.CylinderGeometry(endpoint_front_steps_20.endRadius, endpoint_front_steps_20.baseRadius, endpoint_front_steps_20.length, 32, 12)
    : new THREE.BoxGeometry(1, 1, 1, 12, 12, 12);
  if (!endpoint_front_steps_20) {
    mesh_front_steps_20Geometry.scale(5.6, 0.6652756150731861, 2.2);
  }
  const mesh_front_steps_20 = new THREE.Mesh(
    mesh_front_steps_20Geometry,
    materialMap["granite-stone"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_front_steps_20.name = "Front stone step mass";
  if (endpoint_front_steps_20) {
    mesh_front_steps_20.position.copy(endpoint_front_steps_20.midpoint);
    mesh_front_steps_20.quaternion.copy(endpoint_front_steps_20.quaternion);
  }
  mesh_front_steps_20.castShadow = options.castShadow ?? true;
  mesh_front_steps_20.receiveShadow = options.receiveShadow ?? true;
  mesh_front_steps_20.userData.sculptComponent = {"id": "front-steps", "name": "Front stone step mass", "level": "meso", "role": "stair", "importance": 0.76, "confidence": 0.82, "primitive": "box", "topologyClass": "assembled-solid", "topologyRationale": "The visible access steps form a discrete rigid stone mass in the front axis.", "geometryDescriptor": {"topologyIntent": "separable architectural sub-assembly", "edgeTreatment": {"type": "chamfer", "bevelRadius": 0.012, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "vertex normals from generated geometry"}, "parent": "root", "attachment": null, "dimensions": {"width": 5.6, "height": 0.6652756150731861, "depth": 2.2, "units": "metres", "confidence": 0.82}, "transform": {"position": [0, 0.42335720959202744, 8.05], "rotation": [0, 0, 0], "scale": [1, 1, 1]}, "actionProfile": {"animationRole": "static-part", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.9}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": true, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Broad-phase proxy; refine after form acceptance."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "front-steps", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "dark-timber"}}, "material": "granite-stone", "materialLayers": ["granite-stone"], "deformations": [], "joints": [], "seams": [], "localFeatures": [], "surfaceDetail": {"macroRoughness": 0.12, "microRoughness": 0.08, "bumpAmplitude": 0.02, "normalPattern": "material-specific independent field", "displacementPattern": "none in blockout", "occlusionPattern": "contact and construction seams", "edgeWearPattern": "subtle exposed edge variation", "notes": "Blockout uses scalar PBR response; extracted maps remain review evidence until material pass."}, "colorMaterialRecipe": {"dominantAlbedo": "rgba(148, 145, 135, 1)", "secondaryAlbedo": "rgba(94, 92, 86, 1)", "materialClass": "stone", "materialClassConfidence": 0.82}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "structural-pass"};
  node_front_steps_20.add(mesh_front_steps_20);
  meshes["front-steps"] = mesh_front_steps_20;
  colliders["front-steps"] = {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Broad-phase proxy; refine after form acceptance."};
  destructionGroups["front-steps"] ??= [];
  destructionGroups["front-steps"].push(node_front_steps_20);

  const attachment_door_lattice_carrier_21 = null;
  const endpoint_door_lattice_carrier_21 = makeAttachmentEndpoint(attachment_door_lattice_carrier_21);
  const node_door_lattice_carrier_21 = new THREE.Group();
  node_door_lattice_carrier_21.name = "Door lattice carrier__pivot";
  node_door_lattice_carrier_21.scale.set(1, 1, 1);
  if (endpoint_door_lattice_carrier_21) {
    node_door_lattice_carrier_21.position.copy(endpoint_door_lattice_carrier_21.start);
    node_door_lattice_carrier_21.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_door_lattice_carrier_21.position.set(0.0, 3.6892556835876675, 6.22);
    node_door_lattice_carrier_21.rotation.set(0.0, 0.0, 0.0);
  }
  node_door_lattice_carrier_21.userData.sculptComponent = {"id": "door-lattice-carrier", "name": "Door lattice carrier", "level": "meso", "role": "facade-panel", "importance": 0.76, "confidence": 0.82, "primitive": "plane-card", "topologyClass": "material-only", "topologyRationale": "A thin facade carrier reserves the observed repeated gold lattice system for the form pass.", "geometryDescriptor": {"topologyIntent": "separable architectural sub-assembly", "edgeTreatment": {"type": "chamfer", "bevelRadius": 0.012, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "vertex normals from generated geometry"}, "parent": "root", "attachment": null, "dimensions": {"width": 9.4, "height": 2.782061663033323, "depth": 0.03, "units": "metres", "confidence": 0.82}, "transform": {"position": [0, 3.6892556835876675, 6.22], "rotation": [0, 0, 0], "scale": [1, 1, 1]}, "actionProfile": {"animationRole": "static-part", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.9}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": true, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Broad-phase proxy; refine after form acceptance."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "door-lattice-carrier", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "dark-timber"}}, "material": "gold-accent", "materialLayers": ["gold-accent"], "deformations": [], "joints": [], "seams": [], "localFeatures": [], "surfaceDetail": {"macroRoughness": 0.12, "microRoughness": 0.08, "bumpAmplitude": 0.02, "normalPattern": "material-specific independent field", "displacementPattern": "none in blockout", "occlusionPattern": "contact and construction seams", "edgeWearPattern": "subtle exposed edge variation", "notes": "Blockout uses scalar PBR response; extracted maps remain review evidence until material pass."}, "colorMaterialRecipe": {"dominantAlbedo": "rgba(190, 133, 39, 1)", "secondaryAlbedo": "rgba(82, 51, 18, 1)", "materialClass": "metal", "materialClassConfidence": 0.72}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "structural-pass"};
  node_door_lattice_carrier_21.userData.actionProfile = {"animationRole": "static-part", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.9}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": true, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Broad-phase proxy; refine after form acceptance."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "door-lattice-carrier", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "dark-timber"}};
  (nodes["root"] ?? root).add(node_door_lattice_carrier_21);
  nodes["door-lattice-carrier"] = node_door_lattice_carrier_21;
  const mesh_door_lattice_carrier_21Geometry = endpoint_door_lattice_carrier_21
    ? new THREE.CylinderGeometry(endpoint_door_lattice_carrier_21.endRadius, endpoint_door_lattice_carrier_21.baseRadius, endpoint_door_lattice_carrier_21.length, 32, 12)
    : new THREE.PlaneGeometry(1, 1, 24, 24);
  if (!endpoint_door_lattice_carrier_21) {
    mesh_door_lattice_carrier_21Geometry.scale(9.4, 2.782061663033323, 0.03);
  }
  const mesh_door_lattice_carrier_21 = new THREE.Mesh(
    mesh_door_lattice_carrier_21Geometry,
    materialMap["gold-accent"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_door_lattice_carrier_21.name = "Door lattice carrier";
  if (endpoint_door_lattice_carrier_21) {
    mesh_door_lattice_carrier_21.position.copy(endpoint_door_lattice_carrier_21.midpoint);
    mesh_door_lattice_carrier_21.quaternion.copy(endpoint_door_lattice_carrier_21.quaternion);
  }
  mesh_door_lattice_carrier_21.castShadow = options.castShadow ?? true;
  mesh_door_lattice_carrier_21.receiveShadow = options.receiveShadow ?? true;
  mesh_door_lattice_carrier_21.userData.sculptComponent = {"id": "door-lattice-carrier", "name": "Door lattice carrier", "level": "meso", "role": "facade-panel", "importance": 0.76, "confidence": 0.82, "primitive": "plane-card", "topologyClass": "material-only", "topologyRationale": "A thin facade carrier reserves the observed repeated gold lattice system for the form pass.", "geometryDescriptor": {"topologyIntent": "separable architectural sub-assembly", "edgeTreatment": {"type": "chamfer", "bevelRadius": 0.012, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "vertex normals from generated geometry"}, "parent": "root", "attachment": null, "dimensions": {"width": 9.4, "height": 2.782061663033323, "depth": 0.03, "units": "metres", "confidence": 0.82}, "transform": {"position": [0, 3.6892556835876675, 6.22], "rotation": [0, 0, 0], "scale": [1, 1, 1]}, "actionProfile": {"animationRole": "static-part", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.9}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": true, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Broad-phase proxy; refine after form acceptance."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "door-lattice-carrier", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "dark-timber"}}, "material": "gold-accent", "materialLayers": ["gold-accent"], "deformations": [], "joints": [], "seams": [], "localFeatures": [], "surfaceDetail": {"macroRoughness": 0.12, "microRoughness": 0.08, "bumpAmplitude": 0.02, "normalPattern": "material-specific independent field", "displacementPattern": "none in blockout", "occlusionPattern": "contact and construction seams", "edgeWearPattern": "subtle exposed edge variation", "notes": "Blockout uses scalar PBR response; extracted maps remain review evidence until material pass."}, "colorMaterialRecipe": {"dominantAlbedo": "rgba(190, 133, 39, 1)", "secondaryAlbedo": "rgba(82, 51, 18, 1)", "materialClass": "metal", "materialClassConfidence": 0.72}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "structural-pass"};
  node_door_lattice_carrier_21.add(mesh_door_lattice_carrier_21);
  meshes["door-lattice-carrier"] = mesh_door_lattice_carrier_21;
  colliders["door-lattice-carrier"] = {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Broad-phase proxy; refine after form acceptance."};
  destructionGroups["door-lattice-carrier"] ??= [];
  destructionGroups["door-lattice-carrier"].push(node_door_lattice_carrier_21);

  // repetition system: first-storey-columns (InstancedMesh, rectangular-perimeter, count=24, level=meso)
  {
    const parent = nodes["root"] ?? root;
    const geo = new THREE.CylinderGeometry(0.5, 0.5, 1, 48, 16);
    const mat = materialMap["red-lacquer"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 });
    // Contract (PLAN_1.5 WS-E): instanceScale is ABSOLUTE, in the parent pivot's
    // local units -- it is never multiplied by the parent component's own declared
    // dimensional scale. This falls out of the same fix as componentTree: the pivot
    // Group this cluster is parented to always carries identity scale (dimensions are
    // baked into that component's OWN geometry, not exposed on the Group), so an
    // instanced fastener/tooth/spoke sized [0.05, 0.05, 0.05] renders at exactly that
    // size regardless of how non-uniformly its host component is shaped, and a
    // `radial` ring's placement stays circular instead of being squashed into an
    // ellipse by a non-uniform host.
    const scl = [0.42, 3.55, 0.42];
    const axis = new THREE.Vector3(0.0, 1.0, 0.0).normalize();
    const radius = 12.4;
    const seed = Math.abs(axis.z) < 0.9 ? new THREE.Vector3(0, 0, 1) : new THREE.Vector3(1, 0, 0);
    const perp = new THREE.Vector3().crossVectors(axis, seed).normalize();
    // One InstancedMesh = one draw call for all repeated parts (teeth/fasteners/spokes),
    // replacing the former per-instance Mesh clone loop (real-time perf principle).
    const cluster = new THREE.InstancedMesh(geo, mat, 24);
    const _m = new THREE.Matrix4();
    const _p = new THREE.Vector3();
    const _q = new THREE.Quaternion();
    const _s = new THREE.Vector3(scl[0], scl[1], scl[2]);
    for (let i = 0; i < 24; i++) {
      const ang = ((0.0) + (i * 360) / 24) * Math.PI / 180;
      const dir = perp.clone().applyQuaternion(new THREE.Quaternion().setFromAxisAngle(axis, ang));
      _p.copy(radius > 0 ? dir.clone().multiplyScalar(radius * 0.5) : new THREE.Vector3());
      _q.setFromUnitVectors(new THREE.Vector3(1, 0, 0), dir);
      _m.compose(_p, _q, _s);
      cluster.setMatrixAt(i, _m);
    }
    cluster.instanceMatrix.needsUpdate = true;
    cluster.castShadow = options.castShadow ?? true;
    cluster.receiveShadow = options.receiveShadow ?? true;
    cluster.name = "first-storey-columns";
    parent.add(cluster);
  }

  // repetition system: second-storey-columns (InstancedMesh, rectangular-perimeter, count=20, level=meso)
  {
    const parent = nodes["root"] ?? root;
    const geo = new THREE.CylinderGeometry(0.5, 0.5, 1, 48, 16);
    const mat = materialMap["red-lacquer"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 });
    // Contract (PLAN_1.5 WS-E): instanceScale is ABSOLUTE, in the parent pivot's
    // local units -- it is never multiplied by the parent component's own declared
    // dimensional scale. This falls out of the same fix as componentTree: the pivot
    // Group this cluster is parented to always carries identity scale (dimensions are
    // baked into that component's OWN geometry, not exposed on the Group), so an
    // instanced fastener/tooth/spoke sized [0.05, 0.05, 0.05] renders at exactly that
    // size regardless of how non-uniformly its host component is shaped, and a
    // `radial` ring's placement stays circular instead of being squashed into an
    // ellipse by a non-uniform host.
    const scl = [0.34, 2.75, 0.34];
    const axis = new THREE.Vector3(0.0, 1.0, 0.0).normalize();
    const radius = 10.3;
    const seed = Math.abs(axis.z) < 0.9 ? new THREE.Vector3(0, 0, 1) : new THREE.Vector3(1, 0, 0);
    const perp = new THREE.Vector3().crossVectors(axis, seed).normalize();
    // One InstancedMesh = one draw call for all repeated parts (teeth/fasteners/spokes),
    // replacing the former per-instance Mesh clone loop (real-time perf principle).
    const cluster = new THREE.InstancedMesh(geo, mat, 20);
    const _m = new THREE.Matrix4();
    const _p = new THREE.Vector3();
    const _q = new THREE.Quaternion();
    const _s = new THREE.Vector3(scl[0], scl[1], scl[2]);
    for (let i = 0; i < 20; i++) {
      const ang = ((0.0) + (i * 360) / 20) * Math.PI / 180;
      const dir = perp.clone().applyQuaternion(new THREE.Quaternion().setFromAxisAngle(axis, ang));
      _p.copy(radius > 0 ? dir.clone().multiplyScalar(radius * 0.5) : new THREE.Vector3());
      _q.setFromUnitVectors(new THREE.Vector3(1, 0, 0), dir);
      _m.compose(_p, _q, _s);
      cluster.setMatrixAt(i, _m);
    }
    cluster.instanceMatrix.needsUpdate = true;
    cluster.castShadow = options.castShadow ?? true;
    cluster.receiveShadow = options.receiveShadow ?? true;
    cluster.name = "second-storey-columns";
    parent.add(cluster);
  }

  // repetition system: third-storey-columns (InstancedMesh, rectangular-perimeter, count=16, level=meso)
  {
    const parent = nodes["root"] ?? root;
    const geo = new THREE.CylinderGeometry(0.5, 0.5, 1, 48, 16);
    const mat = materialMap["red-lacquer"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 });
    // Contract (PLAN_1.5 WS-E): instanceScale is ABSOLUTE, in the parent pivot's
    // local units -- it is never multiplied by the parent component's own declared
    // dimensional scale. This falls out of the same fix as componentTree: the pivot
    // Group this cluster is parented to always carries identity scale (dimensions are
    // baked into that component's OWN geometry, not exposed on the Group), so an
    // instanced fastener/tooth/spoke sized [0.05, 0.05, 0.05] renders at exactly that
    // size regardless of how non-uniformly its host component is shaped, and a
    // `radial` ring's placement stays circular instead of being squashed into an
    // ellipse by a non-uniform host.
    const scl = [0.3, 2.35, 0.3];
    const axis = new THREE.Vector3(0.0, 1.0, 0.0).normalize();
    const radius = 7.9;
    const seed = Math.abs(axis.z) < 0.9 ? new THREE.Vector3(0, 0, 1) : new THREE.Vector3(1, 0, 0);
    const perp = new THREE.Vector3().crossVectors(axis, seed).normalize();
    // One InstancedMesh = one draw call for all repeated parts (teeth/fasteners/spokes),
    // replacing the former per-instance Mesh clone loop (real-time perf principle).
    const cluster = new THREE.InstancedMesh(geo, mat, 16);
    const _m = new THREE.Matrix4();
    const _p = new THREE.Vector3();
    const _q = new THREE.Quaternion();
    const _s = new THREE.Vector3(scl[0], scl[1], scl[2]);
    for (let i = 0; i < 16; i++) {
      const ang = ((0.0) + (i * 360) / 16) * Math.PI / 180;
      const dir = perp.clone().applyQuaternion(new THREE.Quaternion().setFromAxisAngle(axis, ang));
      _p.copy(radius > 0 ? dir.clone().multiplyScalar(radius * 0.5) : new THREE.Vector3());
      _q.setFromUnitVectors(new THREE.Vector3(1, 0, 0), dir);
      _m.compose(_p, _q, _s);
      cluster.setMatrixAt(i, _m);
    }
    cluster.instanceMatrix.needsUpdate = true;
    cluster.castShadow = options.castShadow ?? true;
    cluster.receiveShadow = options.receiveShadow ?? true;
    cluster.name = "third-storey-columns";
    parent.add(cluster);
  }

  // repetition system: dougong-levels (InstancedMesh, rectangular-perimeter, count=44, level=meso)
  {
    const parent = nodes["root"] ?? root;
    const geo = new THREE.BoxGeometry(1, 1, 1, 12, 12, 12);
    const mat = materialMap["dark-timber"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 });
    // Contract (PLAN_1.5 WS-E): instanceScale is ABSOLUTE, in the parent pivot's
    // local units -- it is never multiplied by the parent component's own declared
    // dimensional scale. This falls out of the same fix as componentTree: the pivot
    // Group this cluster is parented to always carries identity scale (dimensions are
    // baked into that component's OWN geometry, not exposed on the Group), so an
    // instanced fastener/tooth/spoke sized [0.05, 0.05, 0.05] renders at exactly that
    // size regardless of how non-uniformly its host component is shaped, and a
    // `radial` ring's placement stays circular instead of being squashed into an
    // ellipse by a non-uniform host.
    const scl = [0.5, 0.24, 0.34];
    const axis = new THREE.Vector3(0.0, 1.0, 0.0).normalize();
    const radius = 13.4;
    const seed = Math.abs(axis.z) < 0.9 ? new THREE.Vector3(0, 0, 1) : new THREE.Vector3(1, 0, 0);
    const perp = new THREE.Vector3().crossVectors(axis, seed).normalize();
    // One InstancedMesh = one draw call for all repeated parts (teeth/fasteners/spokes),
    // replacing the former per-instance Mesh clone loop (real-time perf principle).
    const cluster = new THREE.InstancedMesh(geo, mat, 44);
    const _m = new THREE.Matrix4();
    const _p = new THREE.Vector3();
    const _q = new THREE.Quaternion();
    const _s = new THREE.Vector3(scl[0], scl[1], scl[2]);
    for (let i = 0; i < 44; i++) {
      const ang = ((0.0) + (i * 360) / 44) * Math.PI / 180;
      const dir = perp.clone().applyQuaternion(new THREE.Quaternion().setFromAxisAngle(axis, ang));
      _p.copy(radius > 0 ? dir.clone().multiplyScalar(radius * 0.5) : new THREE.Vector3());
      _q.setFromUnitVectors(new THREE.Vector3(1, 0, 0), dir);
      _m.compose(_p, _q, _s);
      cluster.setMatrixAt(i, _m);
    }
    cluster.instanceMatrix.needsUpdate = true;
    cluster.castShadow = options.castShadow ?? true;
    cluster.receiveShadow = options.receiveShadow ?? true;
    cluster.name = "dougong-levels";
    parent.add(cluster);
  }


  // Replace generic radial fallbacks with evidence-aligned rectangular architecture systems.
  for (const name of ['first-storey-columns', 'second-storey-columns', 'third-storey-columns', 'dougong-levels']) {
    const generated = root.getObjectByName(name);
    if (generated?.parent) generated.parent.remove(generated);
  }

  const perimeterSamples = (count: number, width: number, depth: number, y: number) => {
    const result: { position: THREE.Vector3; rotationY: number }[] = [];
    const perimeter = 2 * (width + depth);
    for (let index = 0; index < count; index += 1) {
      let distance = (index / count) * perimeter;
      let x = -width / 2, z = -depth / 2, rotationY = 0;
      if (distance < width) { x += distance; rotationY = 0; }
      else if ((distance -= width) < depth) { x = width / 2; z += distance; rotationY = Math.PI / 2; }
      else if ((distance -= depth) < width) { x = width / 2 - distance; z = depth / 2; rotationY = Math.PI; }
      else { distance -= width; z = depth / 2 - distance; rotationY = -Math.PI / 2; }
      result.push({ position: new THREE.Vector3(x, y, z), rotationY });
    }
    return result;
  };

  const addPerimeterCluster = (
    name: string,
    count: number,
    width: number,
    depth: number,
    y: number,
    scale: [number, number, number],
    geometry: THREE.BufferGeometry,
    material: THREE.Material,
  ) => {
    const cluster = new THREE.InstancedMesh(geometry, material, count);
    const matrix = new THREE.Matrix4();
    const quaternion = new THREE.Quaternion();
    const instanceScale = new THREE.Vector3(...scale);
    perimeterSamples(count, width, depth, y).forEach((sample, index) => {
      quaternion.setFromAxisAngle(new THREE.Vector3(0, 1, 0), sample.rotationY);
      matrix.compose(sample.position, quaternion, instanceScale);
      cluster.setMatrixAt(index, matrix);
    });
    cluster.instanceMatrix.needsUpdate = true;
    cluster.castShadow = options.castShadow ?? true;
    cluster.receiveShadow = options.receiveShadow ?? true;
    cluster.name = name;
    cluster.userData.sculptRepetitionSystem = name;
    root.add(cluster);
    return cluster;
  };

  const red = materialMap['red-lacquer'] ?? new THREE.MeshStandardMaterial({ color: '#641a18' });
  const timber = materialMap['dark-timber'] ?? new THREE.MeshStandardMaterial({ color: '#211817' });
  const postGeometry = new THREE.CylinderGeometry(0.5, 0.5, 1, 20, 1);
  addPerimeterCluster('first-storey-columns', 24, 14.5, 11.8, 3.99, [0.42, 4.29, 0.42], postGeometry, red);
  addPerimeterCluster('second-storey-columns', 20, 12.2, 9.7, 8.95, [0.34, 3.33, 0.34], postGeometry, red);
  addPerimeterCluster('third-storey-columns', 16, 9.3, 7.3, 13.49, [0.3, 2.84, 0.3], postGeometry, red);

  const bracketGeometry = new THREE.BoxGeometry(1, 1, 1);
  addPerimeterCluster('dougong-level-one', 16, 15.2, 12.5, 6.22, [0.55, 0.29, 0.36], bracketGeometry, timber);
  addPerimeterCluster('dougong-level-two', 16, 12.9, 10.4, 10.72, [0.48, 0.27, 0.32], bracketGeometry, timber);
  addPerimeterCluster('dougong-level-three', 12, 10.0, 7.9, 15.13, [0.42, 0.25, 0.3], bracketGeometry, timber);

  for (const id of ['railing-front', 'railing-back', 'railing-left', 'railing-right']) {
    const railingMesh = meshes[id];
    if (railingMesh) {
      railingMesh.visible = true;
      railingMesh.scale.y = 0.13;
      railingMesh.position.y = 0.46;
      railingMesh.userData.explodeWithParent = true;
    }
  }
  addPerimeterCluster('balcony-lattice-bays', 44, 13.6, 11.5, 8.09, [0.09, 1.02, 0.09], bracketGeometry, timber);

  // The authored storey masses become inner wall cores so the exterior timber skeleton remains visible.
  meshes['storey-one']?.scale.set(0.84, 0.95, 0.82);
  meshes['storey-two']?.scale.set(0.84, 0.95, 0.82);
  meshes['storey-three']?.scale.set(0.84, 0.95, 0.82);

  root.userData.sculptRuntime = { nodes, meshes, sockets, colliders, destructionGroups } satisfies ProceduralModelRuntime;
  root.userData.lookDevTargets = {"qualityPriority": "reference-fidelity", "materialPass": {"albedoPaletteRequired": true, "roughnessVariationRequired": true, "normalOrBumpRequired": true, "localOverridesRequired": true, "minimumTextureResolution": 1024, "preferredTextureResolution": 2048, "independentMapChannels": ["albedo", "roughness", "height", "normal", "ambient-occlusion"], "requiredSurfaceFrequencyBands": ["macro", "meso", "micro"], "geometryReliefRequiredWhenSilhouetteAffected": true, "referencePbrExtraction": {"requiredWhenSourceImagePresent": true, "targetThreshold": 0.7, "stopOnLowConfidence": true, "script": "forge/stage1_intake/extract_pbr_evidence.py", "acceptedLimitation": "single-image extraction is reference-derived inference, not exact photogrammetry"}, "mustAvoid": ["single flat albedo per material", "uniform roughness", "albedo texture reused as roughness/height/normal/AO", "single-frequency random noise", "plastic-looking smooth bark, stone, cloth, foliage, or aged material", "local color/detail described only in prose without material masks", "claiming exact PBR recovery when confidence is below the target threshold"]}, "lightingPass": {"requiredTerms": ["key light", "fill light", "rim or environment light", "exposure", "tone mapping", "background", "contact shadow"], "mustAvoid": ["ambient-only lighting", "flat value range", "missing contact shadow", "reference lighting copied without separating material readability"]}, "screenshotReview": ["Compare albedo palette and local color zones.", "Compare roughness/normal/bump response under light.", "Compare cavity dirt, edge wear, stains, moss, scratches, or other local masks.", "Compare key/fill/rim structure, exposure, tone mapping, background, and contact shadows.", "Capture a neutral-light render to verify material readability without reference lighting.", "Capture a grazing-light close-up to expose flat normals, uniform roughness, tiling, and plastic highlights.", "Capture a reference-matched render from the same camera framing as the source."]};
  root.userData.actionReadiness = {
    note: 'Use root.userData.sculptRuntime.nodes for transforms, sockets for attachments, colliders for physics proxies, and destructionGroups for breakable sets.',
  };
  return root;
}

export function createYueyangTowerLookDevLights(
  mode: 'neutral' | 'grazing' | 'reference' = 'neutral',
): THREE.Group {
  const lights = new THREE.Group();
  lights.name = "Yueyang Tower look-dev lights";
  const hemi = new THREE.HemisphereLight(
    mode === 'reference' ? 0xfff0d6 : 0xf2f4ff,
    0x363b42,
    mode === 'grazing' ? 0.28 : mode === 'reference' ? 0.72 : 0.85,
  );
  lights.add(hemi);
  const key = new THREE.DirectionalLight(
    mode === 'reference' ? 0xffcf8a : 0xfff4e8,
    mode === 'grazing' ? 4.2 : mode === 'reference' ? 2.6 : 2.15,
  );
  key.name = 'sun-key';
  if (mode === 'grazing') key.position.set(7.5, 1.1, 4.0);
  else if (mode === 'reference') key.position.set(-4.5, 7.5, 5.0);
  else key.position.set(-4.0, 6.0, 5.5);
  key.castShadow = true;
  key.shadow.mapSize.set(4096, 4096);
  key.shadow.bias = -0.00025;
  key.shadow.normalBias = 0.018;
  key.shadow.radius = 7;
  key.shadow.blurSamples = 24;
  key.shadow.camera.near = 0.5;
  key.shadow.camera.far = 30;
  key.shadow.camera.left = -2.6;
  key.shadow.camera.right = 2.6;
  key.shadow.camera.top = 2.6;
  key.shadow.camera.bottom = -2.6;
  key.shadow.camera.updateProjectionMatrix();
  lights.add(key);
  const fill = new THREE.DirectionalLight(0xa8c4ff, mode === 'grazing' ? 0.12 : 0.42);
  fill.name = 'sky-fill';
  fill.position.set(4.0, 3.0, 3.5);
  lights.add(fill);
  const rim = new THREE.DirectionalLight(0xfff1c4, mode === 'grazing' ? 0.28 : 0.85);
  rim.name = 'warm-rim';
  rim.position.set(0.5, 4.5, -6.0);
  lights.add(rim);
  lights.userData.reviewMode = mode;
  lights.userData.lightingFromPhoto = ["key light: warm directional sun from upper camera-left, intensity 2.4, soft shadow radius 3", "fill light: cool sky hemisphere, intensity 0.85, keeps dark timber above black clipping", "rim/environment light: blue-sky environment plus subtle rear rim; ACES Filmic tone mapping, exposure 1.05, pale-sky background, contact shadow on neutral ground plane"];
  lights.userData.lookDevTargets = {"qualityPriority": "reference-fidelity", "materialPass": {"albedoPaletteRequired": true, "roughnessVariationRequired": true, "normalOrBumpRequired": true, "localOverridesRequired": true, "minimumTextureResolution": 1024, "preferredTextureResolution": 2048, "independentMapChannels": ["albedo", "roughness", "height", "normal", "ambient-occlusion"], "requiredSurfaceFrequencyBands": ["macro", "meso", "micro"], "geometryReliefRequiredWhenSilhouetteAffected": true, "referencePbrExtraction": {"requiredWhenSourceImagePresent": true, "targetThreshold": 0.7, "stopOnLowConfidence": true, "script": "forge/stage1_intake/extract_pbr_evidence.py", "acceptedLimitation": "single-image extraction is reference-derived inference, not exact photogrammetry"}, "mustAvoid": ["single flat albedo per material", "uniform roughness", "albedo texture reused as roughness/height/normal/AO", "single-frequency random noise", "plastic-looking smooth bark, stone, cloth, foliage, or aged material", "local color/detail described only in prose without material masks", "claiming exact PBR recovery when confidence is below the target threshold"]}, "lightingPass": {"requiredTerms": ["key light", "fill light", "rim or environment light", "exposure", "tone mapping", "background", "contact shadow"], "mustAvoid": ["ambient-only lighting", "flat value range", "missing contact shadow", "reference lighting copied without separating material readability"]}, "screenshotReview": ["Compare albedo palette and local color zones.", "Compare roughness/normal/bump response under light.", "Compare cavity dirt, edge wear, stains, moss, scratches, or other local masks.", "Compare key/fill/rim structure, exposure, tone mapping, background, and contact shadows.", "Capture a neutral-light render to verify material readability without reference lighting.", "Capture a grazing-light close-up to expose flat normals, uniform roughness, tiling, and plastic highlights.", "Capture a reference-matched render from the same camera framing as the source."]};
  return lights;
}

// PBR materials (clearcoat/iridescence/transmission/anisotropy) need an environment
// map to visually behave as intended — call this once per renderer and assign the
// result to scene.environment before rendering. No external HDR asset required.
export function createYueyangTowerEnvironment(renderer: THREE.WebGLRenderer): THREE.Texture {
  const pmrem = new THREE.PMREMGenerator(renderer);
  const texture = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
  pmrem.dispose();
  return texture;
}

// Plan 1.3 §3.2 — auto-framing by bounding box. The Divine Eye can only compare a
// render to the reference if the object is FRAMED consistently (an object framed
// differently scores as wrong even when its shape is right). This positions the camera
// deterministically from the object's bounding box so it fills the frame at a stable
// margin, and sets near/far to the object scale. Call after adding the model to the
// scene, and again on resize (after updating camera.aspect).
export function frameYueyangTowerCamera(
  camera: THREE.PerspectiveCamera,
  object: THREE.Object3D,
  options: { margin?: number; azimuthDeg?: number; elevationDeg?: number } = {},
): void {
  const box = new THREE.Box3().setFromObject(object);
  if (box.isEmpty()) return;
  const size = box.getSize(new THREE.Vector3());
  const center = box.getCenter(new THREE.Vector3());
  const margin = options.margin ?? 1.15;
  const maxDim = Math.max(size.x, size.y, size.z) * margin;
  const fov = (camera.fov * Math.PI) / 180;
  // distance so the largest object dimension fits vertically in the frame
  const distance = (maxDim / 2) / Math.tan(fov / 2);
  const az = ((options.azimuthDeg ?? 0) * Math.PI) / 180;
  const el = ((options.elevationDeg ?? 0) * Math.PI) / 180;
  const dir = new THREE.Vector3(
    Math.sin(az) * Math.cos(el),
    Math.sin(el),
    Math.cos(az) * Math.cos(el),
  );
  camera.position.copy(center).addScaledVector(dir, distance);
  camera.near = Math.max(0.01, distance - maxDim);
  camera.far = distance + maxDim * 2;
  camera.lookAt(center);
  camera.updateProjectionMatrix();
}

// Plan 1.3 §3.2c — PRESENTATION composer (DOF + bloom). CRITICAL (R-POSTFX): this is
// for the showcase/hero render ONLY. The Divine Eye's EVALUATION render MUST use a
// plain renderer with NO composer — bloom blows highlights and DOF blurs edges, which
// would corrupt the deterministic IoU/DCD/edge/blowout signals. Enable dof/bloom ONLY
// when the reference photo actually exhibits them (detect_reference_effects.py authorizes).
export function createYueyangTowerPresentationComposer(
  renderer: THREE.WebGLRenderer,
  scene: THREE.Scene,
  camera: THREE.Camera,
  options: { dof?: boolean; bloom?: boolean; bloomStrength?: number; dofFocus?: number; dofAperture?: number } = {},
): EffectComposer {
  const composer = new EffectComposer(renderer);
  composer.addPass(new RenderPass(scene, camera));
  if (options.dof) {
    composer.addPass(new BokehPass(scene, camera, {
      focus: options.dofFocus ?? 10.0,
      aperture: options.dofAperture ?? 0.0002,
      maxblur: 0.01,
    }));
  }
  if (options.bloom) {
    const size = new THREE.Vector2();
    renderer.getSize(size);
    composer.addPass(new UnrealBloomPass(size, options.bloomStrength ?? 0.4, 0.4, 0.85));
  }
  return composer;
}

export function configureYueyangTowerRenderer(renderer: THREE.WebGLRenderer): void {
  // Load-bearing for view-dependent finishes (anodized / Doppler): without ACES + sRGB
  // the environment reflection reads flat/washed instead of a believable metal response.
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.outputColorSpace = THREE.SRGBColorSpace;
}

export function createYueyangTowerInspectControls(
  camera: THREE.Camera,
  domElement: HTMLElement,
): OrbitControls {
  // View-dependent finishes only read correctly once the user orbits — their color
  // comes from the environment reflection, not albedo, so free rotation matters here.
  const controls = new OrbitControls(camera, domElement);
  controls.enableDamping = true;
  controls.minDistance = 1.0;
  controls.maxDistance = 8.0;
  controls.autoRotate = false;
  return controls;
}
