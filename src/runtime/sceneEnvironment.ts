import * as THREE from 'three';
import { RGBELoader } from 'three/examples/jsm/loaders/RGBELoader.js';
import { Sky } from 'three/examples/jsm/objects/Sky.js';
import { Water } from 'three/examples/jsm/objects/Water.js';
import type { PavilionId } from '../createPavilionGalleryModel';
import { getSceneSpec, type SceneLayerId, type SceneMood } from './sceneCatalog';
import { isAbortError, loadVerifiedGlb } from './loadVerifiedGlb';
import { createStoneSurfaceTextures, createRockSurfaceTextures, setWorldRepeat } from './proceduralSurfaces';
import { recolorMeshSurfaces, type SemanticPalette } from './semanticSurfaceRecolor';

// The beyond-pavilion world, HDRI-driven:
//  - far field: photographic equirectangular sky (Poly Haven, CC0) used as
//    both scene background and the PBR environment (IBL) source
//  - middle field: real audited scene packs for tengwang/huanghe, upgraded
//    procedural landscape for yueyang (alpha foliage cards, displaced islands)
//  - near field: stone terrace plaza with procedural paving, skirt wall and
//    shoreline rocks, surrounded by a planar-reflection water plane that runs
//    to the fogged horizon

export type SceneEnvironmentRuntime = {
  root: THREE.Group;
  groundY: number;
  setPavilion: (id: PavilionId) => void;
  setMood: (mood: SceneMood | null) => void;
  update: (deltaSeconds: number, camera?: THREE.Camera) => void;
  dispose: () => void;
};

const PLAZA_RADIUS = 34;
const PLAZA_Y = -0.02;
const WATER_Y = -0.62;
// Water runs to 2000m so its edge sits past the exponential-fog kill radius
// (≥99% fogged); at 800m the plane rim was still ~15% visible as a straight
// horizon seam against the HDRI sky.
const WATER_HALF_EXTENT = 2000;

type TowerSky = {
  file: string;
  fogColor: string;
  fogDensity: number;
  waterColor: string;
  waterOpacity: number;
  bloomStrength: number;
  // Sun direction used for the analytic key light, the water specular and the
  // Sky-shader fallback; tuned per tower against the loaded HDRI during QC.
  sunDirection: [number, number, number];
  sunColor: string;
  sunIntensity: number;
  // Tint for the far cloud cards so the drift band matches each tower's sky
  // (milky dawn, warm daylight, sunset-lit).
  cloudColor: string;
  // Visible sun disc: world-unit size at the 1600m placement, colour and HDR
  // intensity per tower. Tengwang's dusk carries the 正赤如丹 vermilion disc,
  // flattened onto the water-sky line via diskDirection.
  sunDisk: { size: number; color: string; intensity: number };
  diskDirection?: [number, number, number];
  backgroundIntensity: number;
  // Per-tower tone-mapping exposure: the dawn lake needs less than the
  // dusk/clear skies, otherwise the frame washes to white.
  exposure: number;
  backgroundRotationY: number;
  // Softens the equirect backdrop into aerial haze (岳阳's 晨雾) without
  // touching the IBL, which stays pin-sharp for PBR reflections.
  backgroundBlurriness: number;
  fallbackSky: { turbidity: number; rayleigh: number };
};

const TOWER_SKIES: Record<PavilionId, TowerSky> = {
  yueyang: {
    file: '/assets/hdri/lakeside_dawn.hdr',
    fogColor: '#a9b2a9', fogDensity: 0.0011,
    waterColor: '#35525c', waterOpacity: 0.92,
    bloomStrength: 0.22,
    sunDirection: [-0.6, 0.3, 0.74],
    sunColor: '#f6dcae', sunIntensity: 2.2,
    cloudColor: '#eef1ec',
    sunDisk: { size: 95, color: '#ffedb0', intensity: 2.2 },
    // Puts the HDR's open lake (not the shoreline cliff) behind the default
    // camera corridor; the cliff stays as a hazy far shore at the sides.
    backgroundIntensity: 0.78,
    exposure: 0.93,
    backgroundRotationY: 2.4,
    // A whisper of backdrop softness keeps the 晨雾 mood without smearing the
    // far shore into mush.
    backgroundBlurriness: 0.012,
    fallbackSky: { turbidity: 6, rayleigh: 1.8 },
  },
  huanghe: {
    file: '/assets/hdri/shanghai_riverside.hdr',
    fogColor: '#aab4bc', fogDensity: 0.0014,
    waterColor: '#3c5f72', waterOpacity: 0.88,
    bloomStrength: 0.14,
    sunDirection: [0.55, 0.85, 0.3],
    sunColor: '#fff3da', sunIntensity: 2.6,
    cloudColor: '#fdf5e6',
    sunDisk: { size: 130, color: '#fff3cf', intensity: 2.8 },
    // 展示用日轮比主光略低 (34°), 默认取景抬头即可见; 主光仍保持高角度短影。
    diskDirection: [0.55, 0.26, 0.3],
    // Frames the HDRI's own 长江大桥 across the background; rotation 0 left
    // blurry riverbank foliage hanging over the water like curtains.
    backgroundIntensity: 1.0,
    exposure: 1.02,
    backgroundRotationY: 1.75,
    backgroundBlurriness: 0,
    fallbackSky: { turbidity: 4.2, rayleigh: 1.2 },
  },
  tengwang: {
    file: '/assets/hdri/qwantani_dusk_2_puresky.hdr',
    fogColor: '#c7a493', fogDensity: 0.0012,
    // 秋水共长天一色: the dusk water takes a violet-grey tone pulled toward
    // the sky instead of a dark slate, so horizon and lake read as one field.
    waterColor: '#4c4f63', waterOpacity: 0.9,
    bloomStrength: 0.3,
    sunDirection: [-0.85, 0.16, -0.35],
    sunColor: '#ffbe82', sunIntensity: 2.3,
    cloudColor: '#f2c4a2',
    // 正赤如丹: a large vermilion disc flattened onto the water-sky junction.
    sunDisk: { size: 380, color: '#f04a14', intensity: 6.8 },
    diskDirection: [-0.85, 0.024, -0.35],
    backgroundIntensity: 1.08,
    exposure: 1.05,
    backgroundRotationY: 0,
    backgroundBlurriness: 0.006,
    fallbackSky: { turbidity: 8, rayleigh: 2.4 },
  },
};

// Shared with main.ts so the analytic key light matches each tower's sky.
export const TOWER_SUN_PRESETS: Record<PavilionId, { direction: [number, number, number]; color: string; intensity: number }> = {
  yueyang: { direction: TOWER_SKIES.yueyang.sunDirection, color: TOWER_SKIES.yueyang.sunColor, intensity: TOWER_SKIES.yueyang.sunIntensity },
  huanghe: { direction: TOWER_SKIES.huanghe.sunDirection, color: TOWER_SKIES.huanghe.sunColor, intensity: TOWER_SKIES.huanghe.sunIntensity },
  tengwang: { direction: TOWER_SKIES.tengwang.sunDirection, color: TOWER_SKIES.tengwang.sunColor, intensity: TOWER_SKIES.tengwang.sunIntensity },
};

export function getTowerBloomStrength(id: PavilionId): number {
  return TOWER_SKIES[id].bloomStrength;
}

// Crepuscular-ray strength per tower: the dusk tengwang sky carries the
// strongest streaks, dawn yueyang a whisper, and the high-sun huanghe nearly
// none (a noon sun casts no visible shafts). Kept modest — the tinted combine
// gates on tonal headroom, and oversubscribed strength reads as a warm veil.
const TOWER_GODRAY_STRENGTH: Record<PavilionId, number> = {
  yueyang: 0.32,
  // A high sun casts no crepuscular shafts — huanghe's beams read as CG.
  huanghe: 0.05,
  tengwang: 0.5,
};

export function getTowerGodRayStrength(id: PavilionId): number {
  return TOWER_GODRAY_STRENGTH[id];
}

function disposeMaterial(material: THREE.Material | THREE.Material[]): void {
  for (const item of Array.isArray(material) ? material : [material]) item.dispose();
}

function disposeObjectTree(root: THREE.Object3D): void {
  const geometries = new Set<THREE.BufferGeometry>();
  const materials = new Set<THREE.Material>();
  root.traverse((object) => {
    if (!(object instanceof THREE.Mesh)) return;
    geometries.add(object.geometry);
    for (const material of Array.isArray(object.material) ? object.material : [object.material]) materials.add(material);
  });
  geometries.forEach((geometry) => geometry.dispose());
  materials.forEach((material) => material.dispose());
}

function createWaterNormalTexture(quality: 'hero' | 'standard' | 'mobile'): THREE.CanvasTexture {
  // Tileable domain-warped FBM wave field — the standard recipe behind
  // high-quality procedural water normal maps. Value noise on integer lattice
  // periods wraps seamlessly at every octave, a warped second field breaks the
  // lattice look, and central-difference normals give rolling swell with fine
  // capillary chaos on top. No sine sums: those read as concentric CG rings.
  const size = quality === 'hero' ? 512 : 256;
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const context = canvas.getContext('2d');
  if (!context) throw new Error('Canvas 2D context unavailable for water normal texture');

  const latticeHash = (ix: number, iy: number, salt: number): number => {
    const h = Math.sin(ix * 127.1 + iy * 311.7 + salt * 74.7) * 43758.5453;
    return h - Math.floor(h);
  };
  // Smooth periodic value noise: `cx` × `cy` lattice cells across the tile
  // (independent counts per axis so crests can stretch without breaking the
  // seamless wrap).
  const noise = (u: number, v: number, cx: number, cy: number, salt: number): number => {
    const x = u * cx;
    const y = v * cy;
    const ix = Math.floor(x);
    const iy = Math.floor(y);
    const fx = x - ix;
    const fy = y - iy;
    const sx = fx * fx * (3 - 2 * fx);
    const sy = fy * fy * (3 - 2 * fy);
    const wrap = (i: number, c: number): number => ((i % c) + c) % c;
    const n00 = latticeHash(wrap(ix, cx), wrap(iy, cy), salt);
    const n10 = latticeHash(wrap(ix + 1, cx), wrap(iy, cy), salt);
    const n01 = latticeHash(wrap(ix, cx), wrap(iy + 1, cy), salt);
    const n11 = latticeHash(wrap(ix + 1, cx), wrap(iy + 1, cy), salt);
    return n00 + (n10 - n00) * sx + (n01 - n00) * sy + (n00 - n10 - n01 + n11) * sx * sy;
  };

  const BASE_CELL_X = 2;
  const BASE_CELL_Y = 5;
  const OCTAVES = 6;
  // Anisotropic field: frequency along u is ~0.4× that along v, so crests
  // elongate downwind the way a real lake reads from a low camera. Integer
  // factors per octave keep every octave tileable.
  const field = (u: number, v: number, salt: number): number => {
    // Low-frequency wind-patch mask: broad calm/rippled zones so the distant
    // surface varies in character instead of showing one uniform weave (the
    // "plastic wrap" failure). Integer cells stay tileable, and the Water
    // shader's large-scale uv2/uv3 samples turn the mask into metre-scale
    // patchiness on the horizon.
    const patch = noise(u, v, 2, 2, salt + 77) * 0.65 + noise(u, v, 3, 3, salt + 91) * 0.35;
    const patchGain = 0.3 + patch * 1.2;
    let sum = 0;
    let amplitude = 0.53;
    let cx = BASE_CELL_X;
    let cy = BASE_CELL_Y;
    for (let octave = 0; octave < OCTAVES; octave += 1) {
      sum += (noise(u, v, cx, cy, salt + octave * 17) * 2 - 1) * amplitude * patchGain;
      amplitude *= 0.55;
      cx *= 2;
      cy *= 2;
    }
    return sum;
  };

  const height = new Float32Array(size * size);
  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      const u = x / size;
      const v = y / size;
      // Domain warp with a second FBM field (both periodic) so no straight
      // lattice artifact survives.
      const wu = u + field(u, v, 91) * 0.09;
      const wv = v + field(u, v, 137) * 0.09;
      height[y * size + x] = field(wu, wv, 7);
    }
  }

  const image = context.createImageData(size, size);
  const sample = (x: number, y: number): number => {
    const xi = (x + size) % size;
    const yi = (y + size) % size;
    return height[yi * size + xi];
  };
  const strength = 2.1;
  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      const dx = (sample(x + 1, y) - sample(x - 1, y)) * strength;
      const dy = (sample(x, y + 1) - sample(x, y - 1)) * strength;
      const invLen = 1 / Math.hypot(dx, dy, 1);
      const offset = (y * size + x) * 4;
      image.data[offset] = Math.round((-dx * invLen * 0.5 + 0.5) * 255);
      image.data[offset + 1] = Math.round((-dy * invLen * 0.5 + 0.5) * 255);
      image.data[offset + 2] = Math.round((invLen * 0.5 + 0.5) * 255);
      image.data[offset + 3] = 255;
    }
  }
  context.putImageData(image, 0, 0);
  const texture = new THREE.CanvasTexture(canvas);
  texture.wrapS = THREE.RepeatWrapping;
  texture.wrapT = THREE.RepeatWrapping;
  texture.repeat.set(36, 36);
  texture.anisotropy = 8;
  texture.needsUpdate = true;
  return texture;
}

function configureEnvironmentMaterials(root: THREE.Object3D, defaultLayer: SceneLayerId): void {
  root.traverse((object) => {
    if (!(object instanceof THREE.Mesh)) return;
    const nameLayer = /(?:^|-)scene-(near|mid|far)(?:-|$)/.exec(object.name)?.[1] as SceneLayerId | undefined;
    const sourceLayer = typeof object.userData.sceneLayer === 'string'
      ? object.userData.sceneLayer as SceneLayerId
      : nameLayer ?? defaultLayer;
    const materials = Array.isArray(object.material) ? object.material : [object.material];
    for (const material of materials) {
      material.transparent = false;
      material.depthTest = true;
      material.depthWrite = true;
      if (material instanceof THREE.MeshStandardMaterial || material instanceof THREE.MeshPhysicalMaterial) {
        material.roughness = Math.max(material.roughness, sourceLayer === 'near' ? 0.82 : 0.94);
        material.metalness = Math.min(material.metalness, 0.05);
      }
      material.needsUpdate = true;
    }
    object.castShadow = sourceLayer === 'near';
    object.receiveShadow = true;
    object.userData.sceneLayer = sourceLayer;
    object.userData.sourceBackedEnvironment = true;
  });
}

function applyQualityToPackage(root: THREE.Object3D, quality: 'hero' | 'standard' | 'mobile'): void {
  const layerVisibility = (layer: SceneLayerId): boolean => {
    if (quality === 'hero') return true;
    if (quality === 'standard') return layer !== 'far';
    return layer === 'near';
  };
  root.traverse((object) => {
    const layer = object.userData.sceneLayer as SceneLayerId | undefined;
    if (layer) object.visible = layerVisibility(layer);
  });
}

type LandscapeBuild = {
  root: THREE.Group;
  materials: THREE.Material[];
  boats: THREE.Group[];
  trees: THREE.Group[];
};

// Far-field cloud band: a handful of soft canvas cards circling slowly inside
// the fog kill radius (beyond ~450m the Exp2 fog would erase them), tinted per
// tower in applyTowerLook so the drift band agrees with the HDRI sky.
// Broken glitter band for the water's sun path: dense bright dashes near the
// horizon thinning and scattering toward the viewer.
function createSunStreakTexture(): THREE.CanvasTexture {
  const width = 128;
  const height = 512;
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext('2d');
  if (!context) throw new Error('Canvas 2D context unavailable for sun streak texture');
  context.clearRect(0, 0, width, height);
  for (let dash = 0; dash < 1100; dash += 1) {
    const t = hashNoise(dash, 301);
    const y = t * height;
    const spread = 6 + t * 30;
    const x = width / 2 + (hashNoise(dash, 307) - 0.5) * 2 * spread;
    const dashWidth = 1.5 + hashNoise(dash, 311) * 4.5;
    const dashHeight = 1 + hashNoise(dash, 313) * 2.5;
    context.globalAlpha = (1 - t) * 0.55 * (0.35 + hashNoise(dash, 317) * 0.65);
    context.fillStyle = '#ffffff';
    context.fillRect(x - dashWidth / 2, y, dashWidth, dashHeight);
  }
  context.globalAlpha = 1;
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  return texture;
}

function createCloudTexture(): THREE.CanvasTexture {
  const size = 256;
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const context = canvas.getContext('2d');
  if (!context) throw new Error('Canvas 2D context unavailable for cloud texture');
  // Composite a dozen offset radial blobs into one cumulus-ish silhouette;
  // flattening the bottom third keeps the card grounded like real cloud base.
  context.clearRect(0, 0, size, size);
  for (let index = 0; index < 14; index += 1) {
    const u = hashNoise(index, 31);
    const v = hashNoise(index, 37);
    const r = size * (0.1 + hashNoise(index, 41) * 0.16);
    const x = size * (0.2 + u * 0.6);
    const y = size * (0.3 + v * 0.28);
    const gradient = context.createRadialGradient(x, y, 0, x, y, r);
    gradient.addColorStop(0, 'rgba(255,255,255,0.5)');
    gradient.addColorStop(1, 'rgba(255,255,255,0)');
    context.fillStyle = gradient;
    context.beginPath();
    context.arc(x, y, r, 0, Math.PI * 2);
    context.fill();
  }
  // Fade the bottom edge so the card base dissolves instead of clipping.
  const fade = context.createLinearGradient(0, size * 0.55, 0, size);
  fade.addColorStop(0, 'rgba(0,0,0,0)');
  fade.addColorStop(1, 'rgba(0,0,0,1)');
  context.globalCompositeOperation = 'destination-out';
  context.fillStyle = fade;
  context.fillRect(0, size * 0.55, size, size * 0.45);
  context.globalCompositeOperation = 'source-over';
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  return texture;
}

function createCloudBand(parent: THREE.Object3D, quality: 'hero' | 'standard' | 'mobile', texture: THREE.Texture): { group: THREE.Group; materials: THREE.MeshBasicMaterial[] } {
  const group = new THREE.Group();
  group.name = 'poetic-cloud-band';
  const materials: THREE.MeshBasicMaterial[] = [];
  const count = quality === 'mobile' ? 3 : 5;
  for (let index = 0; index < count; index += 1) {
    const material = new THREE.MeshBasicMaterial({
      map: texture,
      transparent: true,
      opacity: 0.42,
      depthWrite: false,
      fog: true,
      side: THREE.DoubleSide,
    });
    materials.push(material);
    const card = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), material);
    const angle = (index / count) * Math.PI * 2 + hashNoise(index, 51) * 1.4;
    const radius = 300 + hashNoise(index, 53) * 140;
    card.name = `poetic-cloud-${index}`;
    card.position.set(Math.cos(angle) * radius, 120 + hashNoise(index, 57) * 110, Math.sin(angle) * radius);
    const size = 150 + hashNoise(index, 59) * 130;
    card.scale.set(size, size * 0.42, 1);
    card.lookAt(0, card.position.y * 0.86, 0);
    group.add(card);
  }
  parent.add(group);
  return { group, materials };
}

// ---------------------------------------------------------------------------
// Upgraded procedural landscape (yueyang primary, tengwang/huanghe fallback):
// alpha foliage trees, displaced islands rising from the water, rock shoreline.
// ---------------------------------------------------------------------------

// Solid procedural tree: tapered trunk, 4-5 upward-outward branches, and a
// foliage canopy of crossed leaf-cluster cards hung at the branch tips. The
// cluster texture (ragged leaf masses with transparent gaps) plus alpha-tested
// depth material keeps both the silhouette and the shadows believable — the
// old versions were either flat cards or popcorn blobs.
function createLeafClusterTexture(): THREE.CanvasTexture {
  const size = 256;
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const context = canvas.getContext('2d');
  if (!context) throw new Error('Canvas 2D context unavailable for leaf cluster texture');
  context.clearRect(0, 0, size, size);
  for (let cluster = 0; cluster < 14; cluster += 1) {
    const cx = size * (0.14 + hashNoise(cluster, 201) * 0.72);
    const cy = size * (0.14 + hashNoise(cluster, 211) * 0.72);
    const spread = size * (0.06 + hashNoise(cluster, 217) * 0.06);
    for (let leaf = 0; leaf < 30; leaf += 1) {
      const angle = hashNoise(cluster * 31 + leaf, 221) * Math.PI * 2;
      const distance = Math.pow(hashNoise(cluster * 17 + leaf, 227), 0.55) * spread;
      const x = cx + Math.cos(angle) * distance;
      const y = cy + Math.sin(angle) * distance * 0.85;
      const tone = hashNoise(cluster * 7 + leaf, 229);
      // Three greens per cluster: deep base, mid, sunlit tip.
      const green = tone > 0.66 ? '#5d8a4a' : tone > 0.33 ? '#47703c' : '#365a30';
      context.save();
      context.translate(x, y);
      context.rotate(angle + hashNoise(leaf, cluster) * 1.2);
      context.globalAlpha = 0.94;
      context.fillStyle = green;
      context.beginPath();
      context.ellipse(0, 0, size * 0.042, size * 0.017, 0, 0, Math.PI * 2);
      context.fill();
      context.restore();
    }
  }
  // 径向 alpha 掩码: 卡片边缘渐隐成圆形 tuft, 近看不再暴露矩形切边。
  const mask = context.createRadialGradient(size / 2, size / 2, size * 0.2, size / 2, size / 2, size * 0.5);
  mask.addColorStop(0, 'rgba(0,0,0,1)');
  mask.addColorStop(0.8, 'rgba(0,0,0,1)');
  mask.addColorStop(1, 'rgba(0,0,0,0)');
  context.globalCompositeOperation = 'destination-in';
  context.fillStyle = mask;
  context.fillRect(0, 0, size, size);
  context.globalCompositeOperation = 'source-over';
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  return texture;
}

function createTree(
  parent: THREE.Object3D,
  canopyMaterial: THREE.MeshStandardMaterial,
  canopyShadeMaterial: THREE.MeshStandardMaterial,
  canopyDepthMaterial: THREE.MeshDepthMaterial,
  trunkMaterial: THREE.Material,
  name: string,
  position: [number, number, number],
  scale: number,
  crown: 'broad' | 'narrow' = 'broad',
): THREE.Group {
  const group = new THREE.Group();
  group.name = name;
  group.position.set(...position);
  group.scale.setScalar(scale);
  group.rotation.y = hashNoise(position[0] * 13.7 + position[2] * 7.1, 2) * Math.PI * 2;
  // Deterministic sway phase so the wind loop in update() desynchronises
  // neighbouring crowns instead of oscillating in lockstep.
  group.userData.swayPhase = hashNoise(position[0] * 3.7 + position[2] * 9.1, 17) * Math.PI * 2;

  const trunkHeight = 3.2;
  const trunk = new THREE.Mesh(new THREE.CylinderGeometry(0.12, 0.36, trunkHeight, 7), trunkMaterial);
  trunk.position.y = trunkHeight * 0.5;
  trunk.castShadow = true;
  group.add(trunk);

  // Branch skeleton: limbs angle upward-outward from the trunk's upper third.
  const branchCount = 4 + Math.floor(hashNoise(position[0] + 3.1, position[2] - 1.7) * 2);
  const branchTips: Array<{ x: number; y: number; z: number }> = [];
  for (let branch = 0; branch < branchCount; branch += 1) {
    const angle = (branch / branchCount) * Math.PI * 2 + hashNoise(branch * 7.3, position[0] + position[2]) * 0.9;
    const tilt = 0.62 + hashNoise(branch, position[2]) * 0.25;
    const limb = new THREE.Mesh(new THREE.CylinderGeometry(0.035, 0.09, 2.2, 5), trunkMaterial);
    limb.position.set(Math.cos(angle) * 0.5, trunkHeight * (0.82 + branch * 0.05), Math.sin(angle) * 0.5);
    limb.rotation.z = -Math.cos(angle) * tilt;
    limb.rotation.x = Math.sin(angle) * tilt;
    limb.castShadow = true;
    group.add(limb);
    branchTips.push({
      x: Math.cos(angle) * (0.5 + Math.sin(tilt) * 1.6),
      y: trunkHeight * (0.82 + branch * 0.05) + Math.cos(tilt) * 1.6,
      z: Math.sin(angle) * (0.5 + Math.sin(tilt) * 1.6),
    });
  }

  // Canopy core: displaced icosahedron blobs over the branch tips — solid
  // volume so the crown has a real silhouette from any angle. Flat-shaded
  // with a green-biased two-tone vertex gradient (dark undersides).
  const cardGeometry = new THREE.PlaneGeometry(1.45, 1.45);
  const puffCount = branchTips.length + 3;
  for (let puff = 0; puff < puffCount; puff += 1) {
    const radius = (puff < branchTips.length ? 1.0 : 0.7) + hashNoise(puff * 3.7, position[0] + puff) * 0.5;
    const centre = puff < branchTips.length
      ? { x: branchTips[puff].x * 0.9, y: branchTips[puff].y + 0.4, z: branchTips[puff].z * 0.9 }
      : (() => {
          const angle = hashNoise(puff * 5.9, position[2]) * Math.PI * 2;
          const layer = puff - branchTips.length;
          return {
            x: Math.cos(angle) * (0.55 - layer * 0.12),
            y: trunkHeight + 2.1 + layer * 0.75,
            z: Math.sin(angle) * (0.55 - layer * 0.12),
          };
        })();
    const blobGeometry = new THREE.IcosahedronGeometry(radius, 2);
    const posAttr = blobGeometry.getAttribute('position');
    const vertex = new THREE.Vector3();
    const colors = new Float32Array(posAttr.count * 3);
    const blobSeed = puff * 13.1 + position[0] * 0.7 + position[2] * 1.3;
    for (let v = 0; v < posAttr.count; v += 1) {
      vertex.fromBufferAttribute(posAttr, v);
      const displacement = 1
        + (hashNoise(Math.round(vertex.x * 11) + blobSeed, Math.round(vertex.y * 13) - Math.round(vertex.z * 7)) - 0.5) * 0.5;
      vertex.multiplyScalar(displacement);
      posAttr.setXYZ(v, vertex.x, vertex.y, vertex.z);
      const heightT = THREE.MathUtils.clamp((vertex.y / radius) * 0.5 + 0.5, 0, 1);
      const shade = 0.5 + heightT * 0.45 + (hashNoise(v, blobSeed) - 0.5) * 0.1;
      colors[v * 3] = shade * 0.72;
      colors[v * 3 + 1] = shade;
      colors[v * 3 + 2] = shade * 0.68;
    }
    posAttr.needsUpdate = true;
    blobGeometry.setAttribute('color', new THREE.BufferAttribute(colors, 3));
    blobGeometry.computeVertexNormals();
    const blob = new THREE.Mesh(blobGeometry, puff % 2 === 0 ? canopyShadeMaterial : canopyMaterial);
    blob.position.set(centre.x, centre.y, centre.z);
    blob.castShadow = true;
    group.add(blob);
    // Leaf-cluster cards hug the blob's surface as foliage texture — detail
    // on a solid volume, never a floating billboard.
    // 中式层叠冠盘: 水平叶盘自下而上收分, 底宽上窄如整形的园柏。
    const layerCount = crown === 'narrow' ? 5 : 4;
    for (let layer = 0; layer < layerCount; layer += 1) {
      const t = layer / (layerCount - 1);
      const layerY = centre.y - radius * 0.35 + (1 - t) * radius * 1.15;
      const layerRadius = radius * (crown === 'narrow' ? 0.85 - t * 0.55 : 1.15 - t * 0.7);
      const disc = new THREE.Mesh(cardGeometry, layer % 2 === 0 ? canopyMaterial : canopyShadeMaterial);
      disc.rotation.x = -Math.PI / 2;
      disc.rotation.z = hashNoise(puff * 3.3 + layer, position[0]) * Math.PI;
      disc.scale.set(layerRadius * 1.42, layerRadius * 1.06, 1);
      disc.position.set(centre.x, layerY, centre.z);
      disc.castShadow = true;
      disc.customDepthMaterial = canopyDepthMaterial;
      group.add(disc);
    }
    // 交叉竖卡补侧影, 平视时冠体也有叶量。
    for (let card = 0; card < 2; card += 1) {
      const cardAngle = hashNoise(puff * 7.7 + card, position[2]) * Math.PI * 2;
      const leaf = new THREE.Mesh(cardGeometry, card % 2 === 0 ? canopyMaterial : canopyShadeMaterial);
      leaf.position.set(centre.x + Math.cos(cardAngle) * radius * 0.3, centre.y + radius * 0.1, centre.z + Math.sin(cardAngle) * radius * 0.3);
      leaf.rotation.y = cardAngle + hashNoise(card, puff) * 1.4;
      leaf.rotation.x = (hashNoise(card, puff) - 0.5) * 0.5;
      leaf.scale.setScalar(radius * 0.72);
      leaf.castShadow = true;
      leaf.customDepthMaterial = canopyDepthMaterial;
      group.add(leaf);
    }
  }
  parent.add(group);
  return group;
}

function createRockShore(
  parent: THREE.Object3D,
  rockMaterial: THREE.Material,
  name: string,
): void {
  for (let index = 0; index < 22; index += 1) {
    const angle = (index / 22) * Math.PI * 2 + hashAngle(index);
    const radius = PLAZA_RADIUS + 0.4 + hashNoise(index, 3) * 2.6;
    const scale = 0.8 + hashNoise(index, 7) * 1.7;
    // Detail level 1 plus per-vertex fbm displacement turns the icosphere
    // facets into weathered, jagged blocks; flat dodecahedra read as props.
    const geometry = new THREE.DodecahedronGeometry(scale, 1);
    const position = geometry.getAttribute('position');
    const vertex = new THREE.Vector3();
    for (let v = 0; v < position.count; v += 1) {
      vertex.fromBufferAttribute(position, v);
      const displacement = 1
        + (hashNoise(index * 131 + Math.round(vertex.x * 37), Math.round(vertex.y * 41 + vertex.z * 53)) - 0.5) * 0.42;
      vertex.multiplyScalar(displacement);
      // Flatten the base so each rock settles into the shoreline instead of
      // perching on a point.
      vertex.y *= 0.62;
      position.setXYZ(v, vertex.x, vertex.y, vertex.z);
    }
    geometry.computeVertexNormals();
    const rock = new THREE.Mesh(geometry, rockMaterial);
    rock.name = `${name}-${index}`;
    rock.position.set(Math.cos(angle) * radius, WATER_Y + 0.12 + hashNoise(index, 11) * 0.5, Math.sin(angle) * radius);
    rock.rotation.set(hashAngle(index * 3), hashAngle(index * 5), hashAngle(index * 7));
    rock.scale.set(1.5, 0.62, 1.05);
    rock.castShadow = true;
    rock.receiveShadow = true;
    parent.add(rock);
  }
}

function hashAngle(seed: number): number {
  const value = Math.sin(seed * 127.1) * 43758.5453;
  return (value - Math.floor(value)) * Math.PI * 2;
}

function hashNoise(seed: number, salt: number): number {
  const value = Math.sin(seed * 269.5 + salt * 183.3) * 43758.5453;
  return value - Math.floor(value);
}

function createBoat(parent: THREE.Object3D, materials: THREE.Material[], name: string, position: [number, number, number], rotationY: number, accent: number): THREE.Group {
  const hullMaterial = new THREE.MeshStandardMaterial({ color: 0x3a2c20, roughness: 0.78, metalness: 0 });
  const canopyMaterial = new THREE.MeshStandardMaterial({ color: 0x2c2620, roughness: 0.88, metalness: 0, side: THREE.DoubleSide });
  const ribMaterial = new THREE.MeshStandardMaterial({ color: 0x503c28, roughness: 0.85, metalness: 0 });
  const sailMaterial = new THREE.MeshStandardMaterial({ color: 0xd9cfb4, roughness: 0.92, metalness: 0, side: THREE.DoubleSide });
  materials.push(hullMaterial, canopyMaterial, ribMaterial, sailMaterial);
  const group = new THREE.Group();
  group.name = name;
  group.position.set(position[0], WATER_Y + 0.1, position[2]);
  group.rotation.y = rotationY;
  // Shadow map is on-demand (renderer.shadowMap.autoUpdate = false), so a
  // continuously bobbing boat must not cast a stale swimming shadow.

  // Hull: a half-ellipsoid shell flipped dome-down, rimmed with a gunwale
  // band; the keel sits just below the waterline.
  const hull = new THREE.Mesh(new THREE.SphereGeometry(1, 18, 12, 0, Math.PI * 2, 0, Math.PI / 2), hullMaterial);
  hull.scale.set(2.9, 0.62, 0.95);
  hull.rotation.x = Math.PI;
  hull.position.y = 0.18;
  group.add(hull);
  const gunwale = new THREE.Mesh(new THREE.TorusGeometry(1, 0.045, 6, 24), hullMaterial);
  gunwale.scale.set(2.62, 0.8, 1);
  gunwale.rotation.x = Math.PI / 2;
  gunwale.position.y = 0.16;
  group.add(gunwale);
  for (const benchX of [-1.2, 0.3, 1.4]) {
    const bench = new THREE.Mesh(new THREE.BoxGeometry(0.14, 0.05, 1.5), ribMaterial);
    bench.position.set(benchX, 0.12, 0);
    group.add(bench);
  }

  // Arched bamboo canopy over the stern half, stiffened by three rib rings.
  const canopy = new THREE.Mesh(
    new THREE.CylinderGeometry(0.62, 0.68, 2.0, 12, 1, true, 0, Math.PI),
    canopyMaterial,
  );
  canopy.rotation.z = Math.PI / 2;
  canopy.rotation.y = Math.PI / 2;
  canopy.position.set(-0.75, 0.42, 0);
  group.add(canopy);
  for (const ribX of [-1.55, -0.75, 0.05]) {
    const rib = new THREE.Mesh(new THREE.TorusGeometry(0.6, 0.025, 5, 12, Math.PI), ribMaterial);
    rib.rotation.y = Math.PI / 2;
    rib.position.set(ribX, 0.42, 0);
    group.add(rib);
  }

  // Mast with a belted, belly-curved sail forward of the canopy.
  const mast = new THREE.Mesh(new THREE.CylinderGeometry(0.04, 0.055, 2.9, 6), ribMaterial);
  mast.position.set(1.15, 1.35, 0);
  group.add(mast);
  const sailGeometry = new THREE.PlaneGeometry(1.35, 1.9, 6, 6);
  const sailPosition = sailGeometry.getAttribute('position');
  for (let v = 0; v < sailPosition.count; v += 1) {
    const localX = sailPosition.getX(v);
    const localY = sailPosition.getY(v);
    sailPosition.setZ(v, Math.cos(localX * 1.15) * 0.16 - Math.abs(localY) * 0.05);
    sailPosition.setY(v, localY * (1 - Math.max(0, localX) * 0.18));
  }
  sailGeometry.computeVertexNormals();
  const sail = new THREE.Mesh(sailGeometry, sailMaterial);
  sail.position.set(1.15, 1.85, 0.02);
  sail.rotation.y = 0.12;
  group.add(sail);
  for (const batten of [-0.7, -0.15, 0.4, 0.85]) {
    const battenMesh = new THREE.Mesh(new THREE.CylinderGeometry(0.016, 0.016, 1.28, 5), ribMaterial);
    battenMesh.rotation.z = Math.PI / 2;
    battenMesh.position.set(1.15 + Math.sin(batten * 1.15) * 0.1, 1.85 + batten, 0.02 + Math.cos(batten * 1.15) * 0.14);
    group.add(battenMesh);
  }
  // Stern scull oar.
  const oar = new THREE.Mesh(new THREE.CylinderGeometry(0.025, 0.04, 2.6, 5), ribMaterial);
  oar.position.set(-2.1, 0.35, 0.3);
  oar.rotation.z = 0.9;
  oar.rotation.x = 0.25;
  group.add(oar);
  parent.add(group);
  return group;
}

function createGlowSpriteTexture(): THREE.CanvasTexture {
  // Shared soft halo used by lantern glow sprites: a two-stop radial falloff
  // so the additive sprite melts into the HDRI dusk instead of reading as a
  // hard billboard.
  const canvas = document.createElement('canvas');
  canvas.width = 128;
  canvas.height = 128;
  const context = canvas.getContext('2d');
  if (!context) throw new Error('Canvas 2D context unavailable for glow sprite texture');
  const gradient = context.createRadialGradient(64, 64, 0, 64, 64, 64);
  gradient.addColorStop(0, 'rgba(255, 226, 172, 0.9)');
  gradient.addColorStop(0.35, 'rgba(255, 202, 134, 0.32)');
  gradient.addColorStop(1, 'rgba(255, 192, 122, 0)');
  context.fillStyle = gradient;
  context.fillRect(0, 0, 128, 128);
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  return texture;
}

function createLantern(parent: THREE.Object3D, materials: THREE.Material[], name: string, position: [number, number, number], warmColor: number, glowMaterials: THREE.MeshStandardMaterial[], glowSpriteMaterials: THREE.SpriteMaterial[], glowTexture: THREE.Texture): void {
  const dark = new THREE.MeshStandardMaterial({ color: 0x28221d, roughness: 0.8, metalness: 0 });
  materials.push(dark);
  const post = new THREE.Mesh(new THREE.CylinderGeometry(0.06, 0.08, 2.2, 6), dark);
  post.name = `${name}-post`;
  post.position.set(position[0], PLAZA_Y + 1.1, position[2]);
  post.castShadow = true;
  parent.add(post);
  const glow = new THREE.MeshStandardMaterial({ color: warmColor, roughness: 0.42, metalness: 0, emissive: warmColor, emissiveIntensity: 0.55 });
  materials.push(glow);
  glowMaterials.push(glow);
  const lantern = new THREE.Mesh(new THREE.BoxGeometry(0.36, 0.5, 0.36), glow);
  lantern.name = `${name}-lantern`;
  lantern.position.set(position[0], PLAZA_Y + 2.32, position[2]);
  parent.add(lantern);
  const cap = new THREE.Mesh(new THREE.BoxGeometry(0.52, 0.08, 0.52), dark);
  cap.position.set(position[0], PLAZA_Y + 2.62, position[2]);
  parent.add(cap);
  const halo = new THREE.SpriteMaterial({
    map: glowTexture,
    color: warmColor,
    transparent: true,
    opacity: 0.34,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
  });
  glowSpriteMaterials.push(halo);
  const haloSprite = new THREE.Sprite(halo);
  haloSprite.name = `${name}-halo`;
  haloSprite.position.set(position[0], PLAZA_Y + 2.32, position[2]);
  haloSprite.scale.setScalar(2.8);
  parent.add(haloSprite);
}

// Per-tower near-field layout: each plaza gets its own tree-ring rhythm,
// scale range and lantern stations so the three scenes don't read as copies.
const LANDSCAPE_LAYOUTS: Record<PavilionId, {
  crown: 'broad' | 'narrow';
  treeAngles: number[];
  treeRadius: [number, number];
  treeScale: [number, number];
  lanterns: Array<[number, number]>;
}> = {
  yueyang: {
    crown: 'broad',
    treeAngles: [75, 105, 138, 168, 200, 232, 262, 292, 322, 352],
    treeRadius: [14, 24],
    treeScale: [0.85, 1.35],
    lanterns: [[-8.4, 8.4], [8.4, 8.4], [-19, -19], [19, -19], [-22, 3], [22, 3]],
  },
  huanghe: {
    crown: 'narrow',
    treeAngles: [80, 110, 145, 175, 208, 238, 268, 300, 330, 8],
    treeRadius: [15, 25],
    treeScale: [0.95, 1.5],
    lanterns: [[-9.5, 7], [9.5, 7], [-17, -17], [17, -17], [-24, -4], [24, -4]],
  },
  tengwang: {
    crown: 'broad',
    treeAngles: [8, 32, 62, 88, 116, 142, 168, 192, 344],
    treeRadius: [16, 26],
    treeScale: [0.9, 1.4],
    lanterns: [[-7, 9.5], [7, 9.5], [-20, -16], [20, -16], [-18, 16], [18, 16]],
  },
};

function createLandscape(
  id: PavilionId,
  quality: 'hero' | 'standard' | 'mobile',
  shared: { canopyWarm: THREE.MeshStandardMaterial; canopyCool: THREE.MeshStandardMaterial; canopyDark: THREE.MeshStandardMaterial; canopyWarmShade: THREE.MeshStandardMaterial; canopyCoolShade: THREE.MeshStandardMaterial; canopyDarkShade: THREE.MeshStandardMaterial; canopyDepthMaterial: THREE.MeshDepthMaterial; trunk: THREE.Material; rock: THREE.Material },
  glowMaterials: THREE.MeshStandardMaterial[],
  glowSpriteMaterials: THREE.SpriteMaterial[],
  glowTexture: THREE.Texture,
): LandscapeBuild {
  const root = new THREE.Group();
  root.name = `${id}-interpretive-landscape`;
  const materials: THREE.Material[] = [];
  const trees: THREE.Group[] = [];
  const near = new THREE.Group();
  near.name = `${id}-near-site-layer`;
  near.userData.sceneLayer = 'near';
  const mid = new THREE.Group();
  mid.name = `${id}-mid-site-layer`;
  mid.userData.sceneLayer = 'mid';
  root.add(near, mid);
  const boats: THREE.Group[] = [];

  // Trees on the terrace edge — a fuller ring (10-14), keeping the default
  // camera corridor (+x/+z ≈ 45°) clear. Tengwang also skips the rear arc
  // where its veranda band sits.
  const canopy = id === 'tengwang' ? shared.canopyWarm : id === 'huanghe' ? shared.canopyDark : shared.canopyCool;
  const canopyShade = id === 'tengwang' ? shared.canopyWarmShade : id === 'huanghe' ? shared.canopyDarkShade : shared.canopyCoolShade;
  const layout = LANDSCAPE_LAYOUTS[id];
  layout.treeAngles.forEach((degrees, index) => {
    const angle = (degrees * Math.PI) / 180;
    const radius = layout.treeRadius[0] + hashNoise(index, id.length) * (layout.treeRadius[1] - layout.treeRadius[0]);
    const treeScale = layout.treeScale[0] + hashNoise(index, 5) * (layout.treeScale[1] - layout.treeScale[0]);
    // Every third tree uses the shade material — mixed tonality across the ring.
    const treeCanopy = index % 3 === 2 ? canopyShade : canopy;
    trees.push(createTree(near, treeCanopy, canopyShade, shared.canopyDepthMaterial, shared.trunk, `${id}-tree-${index}`, [Math.cos(angle) * radius, PLAZA_Y, Math.sin(angle) * radius], treeScale, layout.crown));
  });

  layout.lanterns.forEach(([lanternX, lanternZ], index) => {
    createLantern(near, materials, `${id}-lantern-${index}`, [lanternX, 0, lanternZ], 0xd98e58, glowMaterials, glowSpriteMaterials, glowTexture);
  });

  if (id === 'yueyang') {
    boats.push(createBoat(mid, materials, `${id}-sail-1`, [-54, 0, -66], 0.4, 0x8b5d3f));
    boats.push(createBoat(mid, materials, `${id}-sail-2`, [44, 0, -82], -0.25, 0x9a6a45));
    // Junshan sits far enough out that the dawn fog grades it into the sky —
    // up close the bank sheet would break the 洞庭一碧 emptiness. The tones
    // stay pale grey-green: dark ridges mirror in the water as heavy black
    // smears, which reads wrong against a milky dawn lake.
  } else if (id === 'huanghe') {
    boats.push(createBoat(mid, materials, `${id}-river-boat-1`, [-50, 0, -64], 0.3, 0x8b5d3f));
    // Distant Wuhan-style river city silhouette across the water.
    const cityMaterial = new THREE.MeshStandardMaterial({ color: 0x4c545c, roughness: 1, metalness: 0 });
    materials.push(cityMaterial);
    for (let index = -9; index <= 9; index += 1) {
      const width = 3 + ((index + 9) % 3) * 1.6;
      const height = 4 + ((index * 13) % 7 + 7) * 1.35;
      const block = new THREE.Mesh(new THREE.BoxGeometry(width, height, 3.2), cityMaterial);
      block.name = `${id}-river-city-${index}`;
      block.position.set(index * 7.2, WATER_Y + height * 0.42, -96 - Math.abs(index % 2) * 6);
      mid.add(block);
    }
    const tower = new THREE.Mesh(new THREE.ConeGeometry(2.6, 9, 8), cityMaterial);
    tower.name = `${id}-landmark-pagoda`;
    tower.position.set(-14, WATER_Y + 4.4, -92);
    mid.add(tower);
  } else {
    boats.push(createBoat(mid, materials, `${id}-river-boat-1`, [-46, 0, -62], -0.2, 0x9a5c42));
    boats.push(createBoat(mid, materials, `${id}-river-boat-2`, [40, 0, -78], 0.35, 0x8b5d3f));
  }

  if (quality === 'mobile') mid.visible = false;
  root.userData.sceneLayers = { near, mid };
  root.userData.interpretive = true;
  root.userData.sourcePackageStatus = getSceneSpec(id).packageStatus;
  return { root, materials, boats, trees };
}

// ---------------------------------------------------------------------------
// Animated details: bird flock (孤鹜/雁阵), boat bobbing, lantern breathing.
// ---------------------------------------------------------------------------

type BirdFlock = { group: THREE.Group; update: (elapsed: number) => void };

function createBirdFlock(count: number, options: { solo?: boolean } = {}): BirdFlock {
  const solo = options.solo === true;
  const group = new THREE.Group();
  group.name = solo ? 'poetic-solo-duck' : 'poetic-bird-flock';
  const material = new THREE.MeshBasicMaterial({ color: 0x2c2521, side: THREE.DoubleSide, fog: false });
  const flapSpeed = solo ? 3.4 : 7.5;
  const birds: Array<{ pivot: THREE.Group; right: THREE.Mesh; left: THREE.Mesh; phase: number }> = [];
  for (let index = 0; index < count; index += 1) {
    const pivot = new THREE.Group();
    const s = solo ? 2.1 : 1;
    if (solo) {
      // 孤鹜: 身躯 + 头颈 + 尾 + 分段双翼, 剪影在落霞前也读得出鸟形。
      const body = new THREE.Mesh(new THREE.SphereGeometry(0.5, 10, 8), material);
      body.scale.set(2.05 * s, 0.42 * s, 0.5 * s);
      pivot.add(body);
      const neck = new THREE.Mesh(new THREE.CylinderGeometry(0.07 * s, 0.15 * s, 0.6 * s, 6), material);
      neck.position.set(0.9 * s, 0.3 * s, 0);
      neck.rotation.z = -0.75;
      pivot.add(neck);
      const head = new THREE.Mesh(new THREE.SphereGeometry(0.16 * s, 8, 6), material);
      head.position.set(1.34 * s, 0.56 * s, 0);
      pivot.add(head);
      const tail = new THREE.Mesh(new THREE.ConeGeometry(0.2 * s, 0.85 * s, 6), material);
      tail.position.set(-1.1 * s, 0.1 * s, 0);
      tail.rotation.z = Math.PI / 2 + 0.22;
      pivot.add(tail);
    }
    // 双翼: 沿 ±z 展开的收窄翼面 (root 弦 → 外段前缘), 绕 x 轴扇展。
    const wingSpan = (solo ? 1.55 : 1.05) * (s === 1 ? 1 : s);
    const wingGeometry = new THREE.BufferGeometry();
    wingGeometry.setAttribute('position', new THREE.BufferAttribute(new Float32Array([
      0.3, 0, 0.14,   -0.4, 0, 0.24,   0.05, 0.1, wingSpan * 0.62,
      -0.4, 0, 0.24,  -0.12, 0.14, wingSpan,   0.05, 0.1, wingSpan * 0.62,
    ]), 3));
    wingGeometry.computeVertexNormals();
    const right = new THREE.Mesh(wingGeometry, material);
    const left = new THREE.Mesh(wingGeometry, material);
    left.scale.z = -1;
    pivot.add(right, left);
    // V formation trailing behind the leader.
    const rank = Math.ceil(index / 2);
    const side = index % 2 === 0 ? 1 : -1;
    pivot.position.set(-rank * 1.7, -rank * 0.18, side * rank * 1.1);
    pivot.userData.phase = index * 1.31;
    group.add(pivot);
    birds.push({ pivot, right, left, phase: index * 1.31 });
  }
  let baseX = -140;
  return {
    group,
    update: (elapsed: number) => {
      baseX += solo ? 0.01 : 0.016;
      if (baseX > 180) baseX = solo ? -120 : -200;
      if (solo) {
        group.position.set(baseX, 15.5 + Math.sin(elapsed * 0.2) * 1.4, -14);
        group.rotation.y = Math.PI * 0.03;
      } else {
        group.position.set(baseX, 20 + Math.sin(elapsed * 0.22) * 1.6, -26);
        group.rotation.y = Math.PI * 0.04;
      }
      for (const bird of birds) {
        // 扇展-滑翔节律: 振幅被慢周期包络调制, 峰值间翼面回到上扬滑翔位。
        const envelope = solo ? Math.max(0.15, Math.sin(elapsed * 0.85 + bird.phase) ** 2) : 1;
        const flap = Math.sin(elapsed * flapSpeed + bird.phase) * envelope + (solo ? 0.18 : 0);
        const amp = solo ? 0.6 : 0.55;
        bird.right.rotation.x = -flap * amp;
        bird.left.rotation.x = flap * amp;
        bird.pivot.position.y = bird.pivot.userData.baseY ?? (bird.pivot.userData.baseY = bird.pivot.position.y);
        bird.pivot.position.y = (bird.pivot.userData.baseY as number) + Math.sin(elapsed * 1.4 + bird.phase) * 0.24;
      }
    },
  };
}

// ---------------------------------------------------------------------------

export function createSceneEnvironment(
  scene: THREE.Scene,
  quality: 'hero' | 'standard' | 'mobile',
  renderer: THREE.WebGLRenderer,
): SceneEnvironmentRuntime {
  const root = new THREE.Group();
  root.name = 'source-backed-poetic-environment';

  const pmremGenerator = new THREE.PMREMGenerator(renderer);
  const hdriLoader = new RGBELoader();
  const hdriTextures = new Map<PavilionId, THREE.Texture>();
  const hdriEnvironments = new Map<PavilionId, THREE.Texture>();
  const skyMeshes = new Map<PavilionId, Sky>();

  // --- Terrace plaza (near field) --------------------------------------
  // Paving bakes cost real startup time (fbm per pixel), so hero gets the
  // 2048px master and standard stays at 1536 — slab joints and per-slab tone
  // survive the difference, the bake does not quadruple.
  const stoneTextures = createStoneSurfaceTextures('#97907e', quality === 'hero' ? 2048 : 1536);
  const plazaWorldSize = PLAZA_RADIUS * 2;
  setWorldRepeat(stoneTextures.albedo, 4.25, plazaWorldSize);
  setWorldRepeat(stoneTextures.roughness, 4.25, plazaWorldSize);
  setWorldRepeat(stoneTextures.normal, 4.25, plazaWorldSize);
  const plaza = new THREE.Mesh(
    new THREE.CircleGeometry(PLAZA_RADIUS, 128),
    new THREE.MeshStandardMaterial({
      color: 0xffffff,
      map: stoneTextures.albedo,
      roughnessMap: stoneTextures.roughness,
      normalMap: stoneTextures.normal,
      normalScale: new THREE.Vector2(0.7, 0.7),
      roughness: 1,
      metalness: 0,
    }),
  );
  plaza.name = 'scene-terrace-plaza';
  plaza.rotation.x = -Math.PI / 2;
  plaza.position.y = PLAZA_Y;
  plaza.receiveShadow = true;
  root.add(plaza);

  const skirtMaterial = new THREE.MeshStandardMaterial({ color: 0x7b7566, roughness: 0.98, metalness: 0, side: THREE.DoubleSide });
  const skirt = new THREE.Mesh(
    new THREE.CylinderGeometry(PLAZA_RADIUS + 0.15, PLAZA_RADIUS + 0.55, PLAZA_Y - (WATER_Y - 0.3), 96, 1, true),
    skirtMaterial,
  );
  skirt.name = 'scene-terrace-skirt';
  skirt.position.y = (PLAZA_Y + (WATER_Y - 0.3)) / 2;
  root.add(skirt);

  const rockTextures = createRockSurfaceTextures('#6f6a60', quality === 'hero' ? 1024 : 512);
  setWorldRepeat(rockTextures.albedo, 3, 6);
  setWorldRepeat(rockTextures.normal, 3, 6);
  const rockMaterial = new THREE.MeshStandardMaterial({
    color: 0xffffff,
    map: rockTextures.albedo,
    normalMap: rockTextures.normal,
    roughness: 0.96,
    metalness: 0,
  });
  createRockShore(root, rockMaterial, 'scene-shore-rock');

  // --- Terrace balustrade (望柱 + 寻杖栏杆) & front stair ----------------
  // A bare disc reads as a plaza, not a 台基. The classic raised-platform
  // dressing — a ring of balustrade posts with rails and panels, plus a grand
  // front stair descending to the water — is what makes it architecture.
  // Instanced meshes keep the whole ring at four draw calls.
  const balustradeStone = new THREE.MeshStandardMaterial({ color: 0xcfc9b8, roughness: 0.7, metalness: 0 });
  const bldRadius = PLAZA_RADIUS - 0.3;
  const postCount = 72;
  const angleStep = (Math.PI * 2) / postCount;
  const balusterDummy = new THREE.Object3D();
  const postMesh = new THREE.InstancedMesh(new THREE.BoxGeometry(0.16, 1.0, 0.16), balustradeStone, postCount);
  const capMesh = new THREE.InstancedMesh(new THREE.BoxGeometry(0.32, 0.09, 0.32), balustradeStone, postCount);
  const panelMesh = new THREE.InstancedMesh(new THREE.BoxGeometry(2.9, 0.4, 0.06), balustradeStone, postCount);
  const railMesh = new THREE.InstancedMesh(new THREE.BoxGeometry(2.96, 0.1, 0.1), balustradeStone, postCount);
  const stairAngle = Math.PI / 2; // +z front, facing the default camera corridor
  for (let index = 0; index < postCount; index += 1) {
    const angle = index * angleStep;
    const inStairGap = Math.abs(Math.atan2(Math.sin(angle - stairAngle), Math.cos(angle - stairAngle))) < angleStep * 2.6;
    const midAngle = angle + angleStep / 2;
    const chord = 2 * bldRadius * Math.sin(angleStep / 2);
    const faceTangent = -(midAngle + Math.PI / 2);
    balusterDummy.rotation.set(0, faceTangent, 0);
    balusterDummy.scale.set(1, 1, 1);
    const px = Math.cos(angle) * bldRadius;
    const pz = Math.sin(angle) * bldRadius;
    balusterDummy.position.set(px, PLAZA_Y + 0.5, pz);
    balusterDummy.updateMatrix();
    postMesh.setMatrixAt(index, balusterDummy.matrix);
    if (inStairGap) {
      // Zero-scale hides the panel/rail across the stair opening while the
      // posts keep marking the rim.
      balusterDummy.scale.setScalar(0.0001);
      balusterDummy.updateMatrix();
    }
    balusterDummy.position.set(Math.cos(midAngle) * bldRadius, PLAZA_Y + 0.55, Math.sin(midAngle) * bldRadius);
    balusterDummy.scale.x = inStairGap ? 0.0001 : chord / 2.9;
    balusterDummy.updateMatrix();
    panelMesh.setMatrixAt(index, balusterDummy.matrix);
    balusterDummy.position.y = PLAZA_Y + 0.92;
    balusterDummy.updateMatrix();
    railMesh.setMatrixAt(index, balusterDummy.matrix);
    if (!inStairGap) {
      balusterDummy.position.set(px, PLAZA_Y + 1.04, pz);
      balusterDummy.scale.setScalar(1);
      balusterDummy.updateMatrix();
      capMesh.setMatrixAt(index, balusterDummy.matrix);
    } else {
      balusterDummy.scale.setScalar(0.0001);
      balusterDummy.updateMatrix();
      capMesh.setMatrixAt(index, balusterDummy.matrix);
    }
  }
  for (const mesh of [postMesh, capMesh, panelMesh, railMesh]) {
    mesh.instanceMatrix.setUsage(THREE.StaticDrawUsage);
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    root.add(mesh);
  }

  // Grand front stair: three steps down from the rim toward the water with
  // 垂带 cheeks flanking.
  const stepWidth = 6.4;
  const stepDepth = 0.6;
  for (let index = 0; index < 3; index += 1) {
    const step = new THREE.Mesh(new THREE.BoxGeometry(stepWidth, 0.3, stepDepth), balustradeStone);
    step.position.set(0, PLAZA_Y - 0.17 - index * 0.3, bldRadius + 0.3 + index * stepDepth);
    step.receiveShadow = true;
    root.add(step);
  }
  for (const side of [-1, 1]) {
    const cheek = new THREE.Mesh(new THREE.BoxGeometry(0.55, 1.2, stepDepth * 3 + 0.3), balustradeStone);
    cheek.position.set(side * (stepWidth / 2 + 0.275), PLAZA_Y - 0.2, bldRadius + 0.3 + stepDepth);
    cheek.castShadow = true;
    cheek.receiveShadow = true;
    root.add(cheek);
  }

  // --- Water (middle field, runs to the fogged horizon) -----------------
  let water: Water | null = null;
  if (quality !== 'mobile') {
    water = new Water(new THREE.PlaneGeometry(WATER_HALF_EXTENT * 2, WATER_HALF_EXTENT * 2), {
      // Real-time planar reflection: the resolution is what makes roof
      // silhouettes read in the water instead of dissolving. Standard's
      // extra 1.5x over the old 512 buys back crispness for the every-
      // other-frame throttle below.
      textureWidth: quality === 'hero' ? 1024 : 768,
      textureHeight: quality === 'hero' ? 1024 : 768,
      waterNormals: createWaterNormalTexture(quality),
      sunDirection: new THREE.Vector3(...TOWER_SKIES.yueyang.sunDirection).normalize(),
      sunColor: 0xd9c18d,
      waterColor: 0x496d75,
      distortionScale: 1.9,
      fog: true,
    });
    water.name = 'poetic-river-or-lake';
    water.rotation.x = -Math.PI / 2;
    water.position.y = WATER_Y;
    // Calm river/lake: the blend leans toward the mirror so roof silhouettes
    // and the sky gradient actually read in the surface; the base water colour
    // still dominates at glancing angles.
    // `size` rescales the normal lookup — higher = finer waves. The warped
    // multi-octave normal map holds detail at 1.6 without frosting into
    // glitter; lower tiers keep slightly broader swell.
    const waterMaterial = water.material as THREE.ShaderMaterial;
    waterMaterial.uniforms.alpha.value = 0.85;
    waterMaterial.uniforms.size.value = quality === 'hero' ? 1.6 : 1.25;
    waterMaterial.uniforms.distortionScale.value = 1.9;
    waterMaterial.transparent = true;
    // Reflection throttle: Water re-renders the whole scene into its mirror
    // RT inside onBeforeRender, the single largest per-frame GPU cost in the
    // environment. On standard the update runs every other frame — the held
    // frame is invisible in practice because the mirror is fog-softened and
    // the camera rarely sweeps fast enough to expose the lag.
    if (quality === 'standard') {
      const baseOnBeforeRender = water.onBeforeRender;
      let reflectionFrame = 0;
      water.onBeforeRender = function reflectThrottle(
        this: Water,
        renderer: THREE.WebGLRenderer,
        scene: THREE.Scene,
        camera: THREE.Camera,
        geometry: THREE.BufferGeometry,
        material: THREE.Material,
        group: THREE.Group,
      ) {
        reflectionFrame += 1;
        if (reflectionFrame % 2 === 0) return;
        baseOnBeforeRender.call(this, renderer, scene, camera, geometry, material, group);
      };
    }
    root.add(water);
  }

  // --- Per-pavilion fallback landscapes ---------------------------------
  const glowMaterials: THREE.MeshStandardMaterial[] = [];
  const glowSpriteMaterials: THREE.SpriteMaterial[] = [];
  const glowTexture = createGlowSpriteTexture();
  const trunkMaterial = new THREE.MeshStandardMaterial({ color: 0x4b3222, roughness: 0.95, metalness: 0 });
  // Canopy per tone: the leaf-cluster texture carries the greens, the tint
  // only biases warm/cool; alpha-tested depth material keeps tree shadows
  // leaf-shaped instead of solid quads.
  const leafClusterTexture = createLeafClusterTexture();
  const canopyDepthMaterial = new THREE.MeshDepthMaterial({
    depthPacking: THREE.RGBADepthPacking,
    map: leafClusterTexture,
    alphaTest: 0.45,
  });
  const makeCanopy = (tint: number) => new THREE.MeshStandardMaterial({
    color: tint,
    map: leafClusterTexture,
    alphaTest: 0.45,
    side: THREE.DoubleSide,
    roughness: 0.9,
    metalness: 0,
  });
  const canopyWarm = makeCanopy(0xfff2dc);
  const canopyCool = makeCanopy(0xe9f4e6);
  const canopyDark = makeCanopy(0xcfe0cf);
  const makeCanopyShade = (tint: number) => {
    const material = makeCanopy(tint);
    material.color.multiply(new THREE.Color(0.8, 0.82, 0.8));
    return material;
  };
  const canopyWarmShade = makeCanopyShade(0xfff2dc);
  const canopyCoolShade = makeCanopyShade(0xe9f4e6);
  const canopyDarkShade = makeCanopyShade(0xcfe0cf);
  const shared = {
    canopyWarm, canopyCool, canopyDark,
    canopyWarmShade, canopyCoolShade, canopyDarkShade,
    canopyDepthMaterial, trunk: trunkMaterial, rock: rockMaterial,
  };

  const fallbackLandscapes = new Map<PavilionId, LandscapeBuild>();
  for (const id of ['yueyang', 'huanghe', 'tengwang'] as PavilionId[]) {
    const landscape = createLandscape(id, quality, shared, glowMaterials, glowSpriteMaterials, glowTexture);
    landscape.root.visible = id === 'yueyang';
    fallbackLandscapes.set(id, landscape);
    root.add(landscape.root);
  }
  const activeBoats = (): THREE.Group[] => fallbackLandscapes.get(activePavilion)?.boats ?? [];
  const activeTrees = (): THREE.Group[] => fallbackLandscapes.get(activePavilion)?.trees ?? [];

  // Source packages replace the mid-field context (islands, city silhouettes)
  // but NOT the near-field dressing — trees and lanterns stay so the terrace
  // keeps its life. (The old behaviour hid the whole fallback landscape with
  // the package, leaving tengwang/huanghe plazas bare.)
  const setFallbackLayers = (id: PavilionId, nearVisible: boolean, midVisible: boolean): void => {
    const landscape = fallbackLandscapes.get(id);
    if (!landscape) return;
    const layers = landscape.root.userData.sceneLayers as { near?: THREE.Group; mid?: THREE.Group } | undefined;
    landscape.root.visible = nearVisible || midVisible;
    if (layers?.near) layers.near.visible = nearVisible;
    if (layers?.mid) layers.mid.visible = midVisible;
  };

  // --- Bird flock (tengwang dusk; 落霞与孤鹜齐飞) ------------------------
  // One duck, not a formation — the line says 孤鹜, and a single silhouette
  // gliding across the sunset horizon is the whole image.
  const birdFlock = createBirdFlock(1, { solo: true });
  birdFlock.group.visible = false;
  root.add(birdFlock.group);

  // --- 落霞 sunset bank ---------------------------------------------------
  // Low warm-lit cloud cards clustered toward the tengwang sun azimuth, near
  // the horizon where water and sky already merge — 熔金落霞 over 秋水.
  const sunsetBank = new THREE.Group();
  sunsetBank.name = 'poetic-sunset-bank';
  const cloudTexture = createCloudTexture();
  const sunsetMaterial = new THREE.MeshBasicMaterial({
    map: cloudTexture,
    transparent: true,
    opacity: 0.66,
    depthWrite: false,
    fog: true,
    side: THREE.DoubleSide,
    color: 0xff9d6e,
  });
  const sunsetAzimuth = Math.atan2(TOWER_SKIES.tengwang.sunDirection[0], TOWER_SKIES.tengwang.sunDirection[2]);
  for (let index = 0; index < 4; index += 1) {
    const card = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), sunsetMaterial);
    card.name = `poetic-sunset-cloud-${index}`;
    const angle = sunsetAzimuth + (hashNoise(index, 141) - 0.5) * 1.1;
    const radius = 270 + hashNoise(index, 143) * 70;
    card.position.set(Math.sin(angle) * radius, 26 + hashNoise(index, 145) * 42, Math.cos(angle) * radius);
    const size = 170 + hashNoise(index, 147) * 110;
    card.scale.set(size, size * 0.36, 1);
    card.lookAt(0, card.position.y * 0.8, 0);
    sunsetBank.add(card);
  }
  sunsetBank.visible = false;
  root.add(sunsetBank);

  // --- Visible sun disc (太阳具象) ---------------------------------------
  // HDR-driven additive quad parked 1600m along the tower's sun vector each
  // frame. Tengwang's is flattened to the horizon and vermilion (正赤如丹);
  // HDR intensity > bloom threshold so it actually glows.
  const sunDiskMaterial = new THREE.ShaderMaterial({
    uniforms: {
      uColor: { value: new THREE.Color('#ffedb0') },
      uIntensity: { value: 3 },
    },
    vertexShader: /* glsl */ `
      varying vec2 vUv;
      void main() {
        vUv = uv;
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
      }
    `,
    fragmentShader: /* glsl */ `
      uniform vec3 uColor;
      uniform float uIntensity;
      varying vec2 vUv;
      void main() {
        float r = length(vUv - 0.5) * 2.0;
        // 硬边缘圆盘: 一轮明确的日面, 白热中心, 光晕收紧不散成泛白。
        float disc = 1.0 - smoothstep(0.26, 0.30, r);
        float whiteHot = smoothstep(0.18, 0.02, r);
        float halo = pow(max(0.0, 1.0 - r), 3.2) * 0.3;
        vec3 body = mix(uColor, vec3(1.6, 1.35, 1.05), whiteHot) * uIntensity;
        gl_FragColor = vec4(body * disc + uColor * halo * uIntensity * 0.4, 1.0);
      }
    `,
    transparent: true,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
  });
  const sunDisk = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), sunDiskMaterial);
  sunDisk.name = 'poetic-sun-disc';
  sunDisk.renderOrder = 2;
  root.add(sunDisk);

  // --- Sun light path on the water (阳光反射光路) ------------------------
  // A broken additive glitter band laid along the sun azimuth from the plaza
  // edge toward the horizon — the classic 阳光洒在水面 streak, tinted per
  // tower (vermilion for tengwang's dusk).
  const sunStreakTexture = createSunStreakTexture();
  const sunStreakMaterial = new THREE.MeshBasicMaterial({
    map: sunStreakTexture,
    transparent: true,
    opacity: 0.4,
    // Normal blending: additive washes out over an already-bright dusk lake,
    // while a painted tint reads as an actual reflection path.
    blending: THREE.NormalBlending,
    depthWrite: false,
    fog: true,
    color: '#ffd9a0',
  });
  const sunStreak = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), sunStreakMaterial);
  sunStreak.name = 'poetic-sun-streak';
  sunStreak.rotation.order = 'YXZ';
  sunStreak.rotation.x = -Math.PI / 2;
  sunStreak.scale.set(150, 640, 1);
  sunStreak.renderOrder = 1;
  root.add(sunStreak);
  // 内层亮带: 更短更亮, 与外层相位错开地闪烁, 合成波光粼粼。
  const sunStreakInnerMaterial = sunStreakMaterial.clone();
  const sunStreakInner = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), sunStreakInnerMaterial);
  sunStreakInner.name = 'poetic-sun-streak-inner';
  sunStreakInner.rotation.order = 'YXZ';
  sunStreakInner.rotation.x = -Math.PI / 2;
  sunStreakInner.scale.set(62, 300, 1);
  sunStreakInner.renderOrder = 1;
  root.add(sunStreakInner);
  let streakBaseOpacity = 0.4;

  // --- HDRI sky + IBL ----------------------------------------------------
  async function loadTowerSky(id: PavilionId): Promise<void> {
    const config = TOWER_SKIES[id];
    try {
      const texture = await hdriLoader.loadAsync(config.file);
      texture.mapping = THREE.EquirectangularReflectionMapping;
      hdriTextures.set(id, texture);
      const environment = pmremGenerator.fromEquirectangular(texture).texture;
      hdriEnvironments.set(id, environment);
      if (activePavilion === id) applyTowerLook(id, texture, environment);
    } catch (error) {
      console.warn(`[sceneEnvironment] HDRI unavailable for ${id}, using physical sky fallback.`, error);
      const fallbackScene = new THREE.Scene();
      const sky = new Sky();
      sky.scale.setScalar(1000);
      const uniforms = sky.material.uniforms;
      uniforms.turbidity.value = config.fallbackSky.turbidity;
      uniforms.rayleigh.value = config.fallbackSky.rayleigh;
      uniforms.mieCoefficient.value = 0.006;
      uniforms.mieDirectionalG.value = 0.8;
      uniforms.sunPosition.value.set(...config.sunDirection).normalize().multiplyScalar(100);
      fallbackScene.add(sky);
      const fallbackEnvironment = pmremGenerator.fromScene(fallbackScene, 0.04).texture;
      fallbackScene.remove(sky);
      hdriEnvironments.set(id, fallbackEnvironment);
      skyMeshes.set(id, sky);
      if (activePavilion === id) applyTowerLook(id, null, fallbackEnvironment, sky);
    }
  }

  let currentFog: THREE.FogExp2 = new THREE.FogExp2(new THREE.Color(TOWER_SKIES.yueyang.fogColor), TOWER_SKIES.yueyang.fogDensity);
  scene.fog = currentFog;
  // Placeholder until the HDRI arrives so the first frames are not black.
  scene.background = new THREE.Color(TOWER_SKIES.yueyang.fogColor);

  function applyTowerLook(id: PavilionId, background: THREE.Texture | null, environment: THREE.Texture, visibleSky?: Sky): void {
    const config = TOWER_SKIES[id];
    scene.background = background ?? null;
    if (background) {
      scene.backgroundRotation = new THREE.Euler(0, config.backgroundRotationY, 0);
      // Full-strength backdrop: the photographic HDRI IS the distant scenery
      // (far shores, city skylines); dimming it reads as a washed-out print.
      scene.backgroundIntensity = config.backgroundIntensity;
      // Per-tower exposure: dawn lakes wash out at the dusk-tuned default.
      renderer.toneMappingExposure = config.exposure;
      scene.backgroundBlurriness = config.backgroundBlurriness;
    }
    scene.environment = environment;
    // Outdoor HDRI skies carry far more irradiance than the old indoor
    // RoomEnvironment: keep IBL below the analytic key so shadows keep their
    // direction, but high enough that shadow sides hold colour.
    scene.environmentIntensity = quality === 'hero' ? 0.5 : quality === 'standard' ? 0.44 : 0.38;
    if (visibleSky) {
      const existing = skyMeshes.get(id);
      if (existing && !existing.parent) root.add(existing);
    } else {
      for (const sky of skyMeshes.values()) sky.parent?.remove(sky);
    }
    currentFog = new THREE.FogExp2(new THREE.Color(config.fogColor), config.fogDensity);
    scene.fog = currentFog;
    // Sun light path: laid along the tower's sun azimuth from the plaza edge
    // toward the horizon, tinted and weighted by the disc config.
    const streakAzimuth = Math.atan2(config.sunDirection[0], config.sunDirection[2]);
    sunStreak.rotation.y = streakAzimuth + Math.PI;
    sunStreak.position.set(Math.sin(streakAzimuth) * 344, WATER_Y + 0.05, Math.cos(streakAzimuth) * 344);
    streakBaseOpacity = THREE.MathUtils.clamp(config.sunDisk.intensity * 0.15, 0.3, 0.85);
    sunStreakMaterial.color.set(config.sunDisk.color).lerp(new THREE.Color(1, 1, 1), 0.3);
    sunStreakMaterial.opacity = streakBaseOpacity;
    sunStreakInnerMaterial.color.set(config.sunDisk.color).lerp(new THREE.Color(1, 1, 1), 0.55);
    sunStreakInnerMaterial.opacity = streakBaseOpacity * 1.3;
    sunStreakInner.rotation.y = sunStreak.rotation.y;
    sunStreakInner.position.set(sunStreak.position.x, WATER_Y + 0.06, sunStreak.position.z);
    if (water) {
      const waterMaterial = water.material as THREE.ShaderMaterial;
      waterMaterial.uniforms.waterColor.value.set(config.waterColor);
      waterMaterial.uniforms.sunColor.value.set(config.sunColor);
      waterMaterial.uniforms.sunDirection.value.set(...config.sunDirection).normalize();
      waterMaterial.uniforms.distortionScale.value = 1.9;
    }
    birdFlock.group.visible = id === 'tengwang';
    sunsetBank.visible = id === 'tengwang';
  }

  // --- Source scene packages (tengwang/huanghe real environments) --------
  const packageRoots = new Map<PavilionId, THREE.Group>();
  const packagePromises = new Map<PavilionId, Promise<void>>();
  let loadController: AbortController | null = null;
  let activePavilion: PavilionId = 'yueyang';

  async function loadPackage(id: PavilionId): Promise<void> {
    const existingPromise = packagePromises.get(id);
    if (existingPromise) return existingPromise;
    const task = loadPackageInternal(id);
    packagePromises.set(id, task);
    try {
      await task;
    } finally {
      if (packagePromises.get(id) === task) packagePromises.delete(id);
    }
  }

  // ---------------------------------------------------------------------------
// Source-package calibration (tengwang): the audited 临江组团 package ships its
// auxiliary pavilion cluster on untextured placeholder materials — near-white
// clay plus one salmon roof tone — which reads as unfinished clay against the
// fully materialised main tower. Orientation-based semantic recolouring gives
// the cluster the same language as the tower: green glazed roofs, vermilion
// woodwork, warm plaster walls, stone courtyards.
// ---------------------------------------------------------------------------

const TENGAUX_SEMANTIC_PALETTE: SemanticPalette = {
  roof: 0x367052,
  timber: 0x4e241c,
  vermilion: 0x93352a,
  wall: 0xdcd0b4,
  stone: 0x94907f,
};

// The huanghe site pack (1202 audited meshes: 白玉栏杆、灯烛、场地石作) ships in
// source-scene coordinates that are already tower-relative. Keep
// the native transform and lift the texture-less placeholder greys to dressed
// marble so the balustrades read as the real 白石 railings instead of clay.
function settleHuanghePackageInPlace(packageRoot: THREE.Object3D): void {
  packageRoot.position.set(0, 0, 0);
  packageRoot.rotation.set(0, 0, 0);
  packageRoot.updateMatrixWorld(true);
  packageRoot.traverse((object) => {
    if (!(object instanceof THREE.Mesh)) return;
    const materials = Array.isArray(object.material) ? object.material : [object.material];
    for (const material of materials) {
      if (!(material instanceof THREE.MeshStandardMaterial || material instanceof THREE.MeshPhysicalMaterial)) continue;
      if (isPlaceholderTexture(material.map)) {
        material.color.set(0xd8d2c2);
        material.roughness = 0.68;
        material.metalness = 0;
        material.needsUpdate = true;
      }
    }
  });
}

function isPlaceholderTexture(map: THREE.Texture | null): boolean {
  if (!map) return true;
  const image = map.image as { width?: number; height?: number } | undefined;
  // A 1x1 ImageBitmap is a DCC export placeholder, not a real texture.
  return Boolean(image?.width !== undefined && image.width <= 2 && (image.height ?? 0) <= 2);
}

function recolorAuxiliaryPackageMeshes(packageRoot: THREE.Object3D, id: PavilionId): number {
  if (id !== 'tengwang') return 0;
  let recolored = 0;
  packageRoot.traverse((object) => {
    if (!(object instanceof THREE.Mesh)) return;
    const material = Array.isArray(object.material) ? object.material[0] : object.material;
    if (!(material instanceof THREE.MeshStandardMaterial) && !(material instanceof THREE.MeshPhysicalMaterial)) return;
    if (!isPlaceholderTexture(material.map)) return;
    // Only the near-white placeholders and the salmon roof tone are
    // placeholder-painted; the greys (#9ba1a8 etc.) are authored stone/wall
    // colours and keep their material. Tests run in sRGB because GLTF colours
    // are stored linear and the calibration thresholds are authored in sRGB.
    const srgb = material.color.clone().convertLinearToSRGB();
    const nearWhite = srgb.r > 0.78 && srgb.g > 0.78 && srgb.b > 0.78;
    const salmonRoof = srgb.r > 0.55 && srgb.r > srgb.b * 1.45 && srgb.g > 0.25 && srgb.g < 0.75;
    if (!nearWhite && !salmonRoof) return;
    if (!object.geometry.getAttribute('position')) return;
    if (recolorMeshSurfaces(object, TENGAUX_SEMANTIC_PALETTE, { slopeAsRoof: true })) recolored += 1;
  });
  if (recolored > 0) {
    console.info(`[sceneEnvironment] Recoloured ${recolored} auxiliary placeholder mesh(es) in the ${id} scene package.`);
  }
  return recolored;
}

async function loadPackageInternal(id: PavilionId): Promise<void> {
    const spec = getSceneSpec(id);
    if (quality === 'mobile' || spec.packageStatus !== 'source-backed' || !spec.packageUrl) return;
    const cached = packageRoots.get(id);
    if (cached) {
      cached.visible = true;
      applyQualityToPackage(cached, quality);
      setFallbackLayers(id, true, false);
      return;
    }
    loadController?.abort();
    const controller = new AbortController();
    loadController = controller;
    try {
      const gltf = await loadVerifiedGlb(spec.packageUrl, { signal: controller.signal });
      if (controller.signal.aborted || activePavilion !== id) return;
      const packageRoot = gltf.scene;
      if (controller.signal.aborted || activePavilion !== id) {
        disposeObjectTree(packageRoot);
        return;
      }
      packageRoot.name = `${id}-source-scene-package`;
      packageRoot.userData.provenance = {
        status: spec.packageStatus,
        sourceLabel: spec.sourceLabel,
        packageReport: spec.packageReport,
        availableLayers: spec.availableLayers,
      };
      configureEnvironmentMaterials(packageRoot, 'near');
      settleHuanghePackageInPlace(packageRoot);
      recolorAuxiliaryPackageMeshes(packageRoot, id);
      applyQualityToPackage(packageRoot, quality);
      packageRoots.set(id, packageRoot);
      root.add(packageRoot);
      setFallbackLayers(id, true, false);
    } catch (error) {
      if (!isAbortError(error)) console.warn(`[sceneEnvironment] ${id} source scene package unavailable`, error);
    }
  }

  let activeMood: SceneMood | null = null;
  // Cue-mood blending: while a poetic cue is active, fog and water drift
  // toward the cue's mood (each tower's three cues carry distinct dawn/clear/
  // dusk moods); on exit they ease back to the tower's base atmosphere.
  type MoodTarget = Pick<SceneMood, 'fogColor' | 'fogDensity' | 'waterColor' | 'sunColor'>;
  const moodTmpColor = new THREE.Color();
  const sunDirTmp = new THREE.Vector3();
  const setMood = (mood: SceneMood | null): void => {
    activeMood = mood;
  };

  const setPavilion = (id: PavilionId): void => {
    activePavilion = id;
    activeMood = null;
    for (const [landscapeId, landscape] of fallbackLandscapes) landscape.root.visible = landscapeId === id;
    for (const [packageId, packageRoot] of packageRoots) packageRoot.visible = packageId === id;
    // Package-backed towers get their mid-field from the audited package, so
    // pre-hide the interpretive mid layer before its async load resolves.
    const spec = getSceneSpec(id);
    if (spec.packageUrl && spec.packageStatus === 'source-backed') setFallbackLayers(id, true, false);
    const cached = packageRoots.get(id);
    if (cached) {
      applyQualityToPackage(cached, quality);
      setFallbackLayers(id, true, false);
    }
    const hdriTexture = hdriTextures.get(id);
    const environment = hdriEnvironments.get(id);
    if (environment) applyTowerLook(id, hdriTexture ?? null, environment, hdriTexture ? undefined : skyMeshes.get(id));
    else scene.background = new THREE.Color(TOWER_SKIES[id].fogColor);
    void loadTowerSky(id);
    void loadPackage(id);
  };

  setPavilion('yueyang');

  const clockStart = performance.now() / 1000;
  const update = (deltaSeconds: number, camera?: THREE.Camera): void => {
    const elapsed = performance.now() / 1000 - clockStart;
    // Sun disc tracks the camera along the tower's sun vector so it sits at
    // infinity; tengwang's diskDirection flattens it onto the water line.
    if (camera) {
      const skyConfig = TOWER_SKIES[activePavilion];
      const diskDirection = skyConfig.diskDirection ?? skyConfig.sunDirection;
      sunDirTmp.set(diskDirection[0], diskDirection[1], diskDirection[2]).normalize();
      sunDisk.position.copy(camera.position).addScaledVector(sunDirTmp, 1600);
      sunDisk.quaternion.copy(camera.quaternion);
      sunDisk.scale.setScalar(skyConfig.sunDisk.size);
      sunDiskMaterial.uniforms.uColor.value.set(skyConfig.sunDisk.color);
      sunDiskMaterial.uniforms.uIntensity.value = skyConfig.sunDisk.intensity;
    }
    if (water && !document.hidden) {
      const uniforms = (water.material as THREE.ShaderMaterial).uniforms;
      uniforms.time.value += deltaSeconds * (quality === 'hero' ? 0.42 : 0.22);
    }
    // Mood blend: ~1.5s exponential ease toward the cue mood (or the tower's
    // base atmosphere when a cue ends).
    const moodBase = TOWER_SKIES[activePavilion];
    const moodTarget: MoodTarget = activeMood ?? {
      fogColor: moodBase.fogColor,
      fogDensity: moodBase.fogDensity,
      waterColor: moodBase.waterColor,
      sunColor: moodBase.sunColor,
    };
    const moodBlend = 1 - Math.exp(-deltaSeconds * 2.2);
    currentFog.color.lerp(moodTmpColor.set(moodTarget.fogColor), moodBlend);
    currentFog.density += (moodTarget.fogDensity - currentFog.density) * moodBlend;
    if (water) {
      const uniforms = (water.material as THREE.ShaderMaterial).uniforms;
      uniforms.waterColor.value.lerp(moodTmpColor.set(moodTarget.waterColor), moodBlend);
      uniforms.sunColor.value.lerp(moodTmpColor.set(moodTarget.sunColor), moodBlend);
    }
    // 波光粼粼: 内外两层光路以不同相位闪烁, 亮度微微摇曳。
    const glint = 0.8 + 0.2 * Math.sin(elapsed * 2.1) * Math.sin(elapsed * 3.7 + 1.1);
    sunStreakMaterial.opacity = streakBaseOpacity * glint;
    sunStreakInnerMaterial.opacity = streakBaseOpacity * 1.3 * (0.7 + 0.3 * Math.sin(elapsed * 3.3 + 0.6));
    for (const boat of activeBoats()) {
      boat.position.y = WATER_Y + 0.12 + Math.sin(elapsed * 0.7 + boat.position.x) * 0.07;
      boat.rotation.z = Math.sin(elapsed * 0.55 + boat.position.z) * 0.025;
    }
    if (birdFlock.group.visible) birdFlock.update(elapsed);
    const lanternGlow = 0.5 + Math.sin(elapsed * 1.8) * 0.18;
    for (const glow of glowMaterials) glow.emissiveIntensity = lanternGlow;
    // Halo opacity rides the same breath as the emissive lanterns.
    const haloOpacity = 0.26 + Math.sin(elapsed * 1.8) * 0.1;
    for (const halo of glowSpriteMaterials) halo.opacity = haloOpacity;
    // Wind: desynchronised crown sway on the active landscape's trees.
    for (const tree of activeTrees()) {
      const phase = tree.userData.swayPhase as number;
      tree.rotation.z = Math.sin(elapsed * 0.85 + phase) * 0.014;
      tree.rotation.x = Math.cos(elapsed * 0.62 + phase * 1.7) * 0.01;
    }
  };

  return {
    root,
    groundY: PLAZA_Y,
    setPavilion,
    setMood,
    update,
    dispose: () => {
      loadController?.abort();
      if (water) {
        (water.material as THREE.ShaderMaterial).uniforms.waterNormals?.value?.dispose?.();
        water.geometry.dispose();
        disposeMaterial(water.material);
      }
      for (const texture of hdriTextures.values()) texture.dispose();
      for (const environment of hdriEnvironments.values()) environment.dispose();
      stoneTextures.albedo.dispose();
      stoneTextures.roughness.dispose();
      stoneTextures.normal.dispose();
      rockTextures.albedo.dispose();
      rockTextures.normal.dispose();
      skirt.geometry.dispose();
      disposeMaterial(skirtMaterial);
      plaza.geometry.dispose();
      disposeMaterial(plaza.material as THREE.Material);
      trunkMaterial.dispose();
      canopyWarm.dispose();
      canopyCool.dispose();
      canopyDark.dispose();
      canopyDepthMaterial.dispose();
      leafClusterTexture.dispose();
      rockMaterial.dispose();
      glowTexture.dispose();
      for (const halo of glowSpriteMaterials) halo.dispose();
      sunsetMaterial.dispose();
      sunsetBank.traverse((object) => {
        if (object instanceof THREE.Mesh) object.geometry.dispose();
      });
      sunDisk.geometry.dispose();
      sunDiskMaterial.dispose();
      sunStreak.geometry.dispose();
      sunStreakMaterial.dispose();
      sunStreakInner.geometry.dispose();
      sunStreakInnerMaterial.dispose();
      sunStreakTexture.dispose();
      cloudTexture.dispose();
      for (const landscape of fallbackLandscapes.values()) {
        for (const material of landscape.materials) material.dispose();
        disposeObjectTree(landscape.root);
      }
      birdFlock.group.traverse((object) => {
        if (object instanceof THREE.Mesh) object.geometry.dispose();
      });
      for (const packageRoot of packageRoots.values()) disposeObjectTree(packageRoot);
      packagePromises.clear();
      packageRoots.clear();
      pmremGenerator.dispose();
      scene.remove(root);
    },
  };
}
