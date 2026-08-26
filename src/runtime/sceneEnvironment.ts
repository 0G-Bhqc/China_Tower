import * as THREE from 'three';
import { Sky } from 'three/examples/jsm/objects/Sky.js';
import { Water } from 'three/examples/jsm/objects/Water.js';
import type { PavilionId } from '../createPavilionGalleryModel';
import { getSceneSpec, type SceneCue, type SceneLayerId, type SceneMood } from './sceneCatalog';
import { isAbortError, loadVerifiedGlb } from './loadVerifiedGlb';

export type SceneEnvironmentRuntime = {
  root: THREE.Group;
  groundY: number;
  setPavilion: (id: PavilionId) => void;
  setCueMood: (mood: SceneMood) => void;
  setCueFocus: (cue: SceneCue) => void;
  update: (deltaSeconds: number) => void;
  setReducedMotion: (reduced: boolean) => void;
  dispose: () => void;
};

type LandscapeBuild = {
  root: THREE.Group;
  materials: THREE.Material[];
};

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

function createMaterial(materials: THREE.Material[], color: number, roughness = 0.86, metalness = 0): THREE.MeshStandardMaterial {
  const material = new THREE.MeshStandardMaterial({ color, roughness, metalness, envMapIntensity: 0.42 });
  materials.push(material);
  return material;
}

function addBox(
  parent: THREE.Object3D,
  materials: THREE.Material[],
  name: string,
  size: [number, number, number],
  position: [number, number, number],
  material: THREE.Material,
  rotationY = 0,
): THREE.Mesh {
  const mesh = new THREE.Mesh(new THREE.BoxGeometry(...size), material);
  mesh.name = name;
  mesh.position.set(...position);
  mesh.rotation.y = rotationY;
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  parent.add(mesh);
  return mesh;
}

function addCylinder(
  parent: THREE.Object3D,
  name: string,
  radius: number,
  height: number,
  position: [number, number, number],
  material: THREE.Material,
  segments = 8,
): THREE.Mesh {
  const mesh = new THREE.Mesh(new THREE.CylinderGeometry(radius * 0.88, radius, height, segments), material);
  mesh.name = name;
  mesh.position.set(...position);
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  parent.add(mesh);
  return mesh;
}

function addRailing(
  parent: THREE.Object3D,
  materials: THREE.Material[],
  name: string,
  start: THREE.Vector3,
  end: THREE.Vector3,
  height: number,
  material: THREE.Material,
): void {
  const middle = start.clone().add(end).multiplyScalar(0.5);
  const length = start.distanceTo(end);
  const beam = addBox(parent, materials, `${name}-top`, [length, 0.12, 0.12], [middle.x, middle.y + height, middle.z], material, -Math.atan2(end.z - start.z, end.x - start.x));
  beam.rotation.y = -Math.atan2(end.z - start.z, end.x - start.x);
  const posts = Math.max(2, Math.ceil(length / 1.8));
  for (let index = 0; index <= posts; index += 1) {
    const point = start.clone().lerp(end, index / posts);
    addCylinder(parent, `${name}-post-${index}`, 0.055, height, [point.x, point.y + height * 0.5, point.z], material, 6);
  }
}

function createPine(
  parent: THREE.Object3D,
  materials: THREE.Material[],
  name: string,
  position: [number, number, number],
  scale: number,
  foliageColor: number,
): void {
  const trunk = createMaterial(materials, 0x3c2b20, 0.96);
  const foliage = createMaterial(materials, foliageColor, 0.92);
  const group = new THREE.Group();
  group.name = name;
  group.position.set(...position);
  group.scale.setScalar(scale);
  addCylinder(group, `${name}-trunk`, 0.22, 3.4, [0, 1.7, 0], trunk, 7);
  for (let layer = 0; layer < 3; layer += 1) {
    const cone = new THREE.Mesh(new THREE.ConeGeometry(1.45 - layer * 0.27, 2.35, 8), foliage);
    cone.name = `${name}-foliage-${layer}`;
    cone.position.y = 2.8 + layer * 1.25;
    cone.castShadow = true;
    cone.receiveShadow = true;
    group.add(cone);
  }
  parent.add(group);
}

function createDeciduousTree(
  parent: THREE.Object3D,
  materials: THREE.Material[],
  name: string,
  position: [number, number, number],
  scale: number,
  foliageColor: number,
): void {
  const trunk = createMaterial(materials, 0x4b3022, 0.94);
  const foliage = createMaterial(materials, foliageColor, 0.9);
  const group = new THREE.Group();
  group.name = name;
  group.position.set(...position);
  group.scale.setScalar(scale);
  addCylinder(group, `${name}-trunk`, 0.28, 4.2, [0, 2.1, 0], trunk, 7);
  for (let index = 0; index < 5; index += 1) {
    const angle = (index / 5) * Math.PI * 2;
    const crown = new THREE.Mesh(new THREE.SphereGeometry(1.2, 8, 6), foliage);
    crown.name = `${name}-crown-${index}`;
    crown.position.set(Math.cos(angle) * 0.75, 4.3 + (index % 2) * 0.7, Math.sin(angle) * 0.75);
    crown.scale.set(1.15, 0.85, 1.15);
    crown.castShadow = true;
    crown.receiveShadow = true;
    group.add(crown);
  }
  parent.add(group);
}

function createRidge(
  parent: THREE.Object3D,
  materials: THREE.Material[],
  name: string,
  z: number,
  color: number,
  phase: number,
): void {
  const geometry = new THREE.PlaneGeometry(160, 28, 40, 1);
  const position = geometry.getAttribute('position');
  for (let index = 0; index < position.count; index += 1) {
    const x = position.getX(index);
    if (position.getY(index) > 0) {
      const u = (x + 80) / 160;
      position.setY(index, 2.5 + Math.sin(u * 12 + phase) * 1.8 + Math.sin(u * 29 + phase * 0.7) * 0.75);
    } else {
      position.setY(index, -6);
    }
  }
  position.needsUpdate = true;
  geometry.computeVertexNormals();
  const mesh = new THREE.Mesh(geometry, createMaterial(materials, color, 1));
  mesh.name = name;
  mesh.position.set(0, 7, z);
  mesh.receiveShadow = true;
  parent.add(mesh);
}

function createBoat(parent: THREE.Object3D, materials: THREE.Material[], name: string, position: [number, number, number], rotationY: number, accent: number): void {
  const hull = createMaterial(materials, 0x382b25, 0.93);
  const roof = createMaterial(materials, accent, 0.72);
  const group = new THREE.Group();
  group.name = name;
  group.position.set(...position);
  group.rotation.y = rotationY;
  addBox(group, materials, `${name}-hull`, [3.8, 0.38, 1.05], [0, 0.25, 0], hull, 0);
  addBox(group, materials, `${name}-cabin`, [1.25, 0.65, 0.78], [-0.25, 0.7, 0], roof, 0);
  addCylinder(group, `${name}-mast`, 0.04, 2.4, [1.1, 1.25, 0], hull, 6);
  parent.add(group);
}

function createLantern(parent: THREE.Object3D, materials: THREE.Material[], name: string, position: [number, number, number], warmColor: number): void {
  const dark = createMaterial(materials, 0x28221d, 0.8);
  const glow = createMaterial(materials, warmColor, 0.48);
  addCylinder(parent, `${name}-post`, 0.06, 2.2, [position[0], position[1] + 1.1, position[2]], dark, 6);
  addBox(parent, materials, `${name}-lantern`, [0.36, 0.5, 0.36], [position[0], position[1] + 2.35, position[2]], glow);
  addBox(parent, materials, `${name}-cap`, [0.52, 0.08, 0.52], [position[0], position[1] + 2.63, position[2]], dark);
}

function createLandscape(id: PavilionId, quality: 'hero' | 'standard' | 'mobile'): LandscapeBuild {
  const root = new THREE.Group();
  root.name = `${id}-interpretive-landscape`;
  const materials: THREE.Material[] = [];
  const near = new THREE.Group();
  near.name = `${id}-near-site-layer`;
  near.userData.sceneLayer = 'near';
  const mid = new THREE.Group();
  mid.name = `${id}-mid-site-layer`;
  mid.userData.sceneLayer = 'mid';
  root.add(near, mid);

  const stone = createMaterial(materials, id === 'tengwang' ? 0x5e554c : 0x807c70, 0.98);
  const stoneDark = createMaterial(materials, id === 'huanghe' ? 0x596166 : 0x5e554c, 0.98);
  const path = createMaterial(materials, id === 'tengwang' ? 0x8a7d6e : 0x9a9586, 0.98);
  const rail = createMaterial(materials, id === 'huanghe' ? 0x382d29 : 0x3d2a22, 0.78);
  const bank = createMaterial(materials, id === 'tengwang' ? 0x6d625b : 0x6d746c, 0.98);

  const ring = new THREE.Mesh(new THREE.RingGeometry(id === 'tengwang' ? 17 : 15, id === 'tengwang' ? 30 : 26, 12), stone);
  ring.name = `${id}-raised-stone-terrace-ring`;
  ring.rotation.x = -Math.PI / 2;
  ring.position.y = 0.04;
  ring.receiveShadow = true;
  near.add(ring);

  const frontWidth = id === 'tengwang' ? 7 : 5.5;
  for (let index = 0; index < 8; index += 1) {
    const depth = 0.72;
    const width = frontWidth + (index < 2 ? 2.4 : 0);
    const z = 11.5 + index * 0.86;
    addBox(near, materials, `${id}-entry-step-${index}`, [width, 0.22, depth], [0, 0.11 + index * 0.035, z], index % 2 ? path : stone);
  }
  addRailing(near, materials, `${id}-left-entry-rail`, new THREE.Vector3(-frontWidth * 0.52, 0.1, 11), new THREE.Vector3(-frontWidth * 0.88, 0.1, 18), 1.05, rail);
  addRailing(near, materials, `${id}-right-entry-rail`, new THREE.Vector3(frontWidth * 0.52, 0.1, 11), new THREE.Vector3(frontWidth * 0.88, 0.1, 18), 1.05, rail);

  const bankMesh = addBox(near, materials, `${id}-shoreline-bank`, [100, 0.32, 4.6], [0, -0.02, -7.5], bank);
  bankMesh.receiveShadow = true;
  for (let index = -8; index <= 8; index += 1) {
    const x = index * 3.2 + (index % 2) * 0.4;
    const rock = new THREE.Mesh(new THREE.DodecahedronGeometry(0.55 + Math.abs(index % 3) * 0.13, 0), stoneDark);
    rock.name = `${id}-shore-rock-${index}`;
    rock.position.set(x, 0.25 + (index % 2) * 0.12, -5.7 - (index % 3) * 0.55);
    rock.scale.set(1.4, 0.65, 0.9);
    rock.castShadow = true;
    near.add(rock);
  }

  const warm = id === 'tengwang' ? 0xd98e58 : 0xd5a05a;
  createLantern(near, materials, `${id}-lantern-left`, [-7.8, 0, 8.7], warm);
  createLantern(near, materials, `${id}-lantern-right`, [7.8, 0, 8.7], warm);

  if (id === 'tengwang') {
    const autumn = [0x9c5e3e, 0xb67745, 0x7c6a3f];
    [[-21, 0, -1], [21, 0, 1], [-25, 0, 10], [25, 0, 12], [-17, 0, -10], [17, 0, -10]].forEach(([x, y, z], index) => createDeciduousTree(near, materials, `${id}-autumn-tree-${index}`, [x, y, z], 1.25 + (index % 2) * 0.2, autumn[index % autumn.length]));
  } else {
    const pineColor = id === 'huanghe' ? 0x405f52 : 0x3e5d51;
    [[-21, 0, 1], [21, 0, 1], [-25, 0, 8], [25, 0, 9], [-23, 0, -10], [23, 0, -10]].forEach(([x, y, z], index) => createPine(near, materials, `${id}-pine-${index}`, [x, y, z], 1.1 + (index % 3) * 0.18, pineColor));
  }

  if (id === 'huanghe') {
    for (let index = -7; index <= 7; index += 1) {
      const width = 1.6 + ((index + 7) % 3) * 0.7;
      const height = 2.5 + ((index * 13) % 5 + 5) * 0.65;
      addBox(mid, materials, `${id}-river-city-${index}`, [width, height, 1.8], [index * 4.4, height / 2 - 0.1, -47 - Math.abs(index % 2) * 2], stoneDark);
    }
    addBox(mid, materials, `${id}-river-bridge`, [70, 0.38, 1.1], [0, 1.3, -39], rail, 0.03);
    for (let index = -7; index <= 7; index += 1) addCylinder(mid, `${id}-bridge-pier-${index}`, 0.18, 1.5, [index * 4.4, 0.6, -39], rail, 8);
  } else if (id === 'yueyang') {
    [[-5, 0, -19], [12, 0, -25]].forEach(([x, y, z], index) => createBoat(mid, materials, `${id}-lake-boat-${index}`, [x, y, z], index ? -0.35 : 0.25, 0x8b5d3f));
    createRidge(mid, materials, `${id}-junshan-near-ridge`, -43, 0x637974, 0.5);
    createRidge(mid, materials, `${id}-junshan-far-ridge`, -61, 0x82918c, 2.1);
  } else {
    [[-8, 0, -19], [13, 0, -24]].forEach(([x, y, z], index) => createBoat(mid, materials, `${id}-river-boat-${index}`, [x, y, z], index ? 0.3 : -0.22, 0x9a5c42));
    createRidge(mid, materials, `${id}-ganjiang-far-bank`, -46, 0x6f6865, 1.2);
    createRidge(mid, materials, `${id}-ganjiang-city-bank`, -62, 0x837a76, 2.6);
  }

  if (quality === 'mobile') mid.visible = false;
  root.userData.sceneLayers = { near, mid };
  root.userData.interpretive = true;
  root.userData.sourcePackageStatus = getSceneSpec(id).packageStatus;
  root.userData.provenance = {
    status: getSceneSpec(id).packageStatus,
    sourceLabel: getSceneSpec(id).sourceLabel,
    packageReport: getSceneSpec(id).packageReport,
  };
  return { root, materials };
}

function createWaterNormalTexture(): THREE.CanvasTexture {
  const canvas = document.createElement('canvas');
  canvas.width = 128;
  canvas.height = 128;
  const context = canvas.getContext('2d');
  if (!context) throw new Error('Canvas 2D context unavailable for water normal texture');
  const image = context.createImageData(canvas.width, canvas.height);
  for (let y = 0; y < canvas.height; y += 1) {
    for (let x = 0; x < canvas.width; x += 1) {
      const waveA = Math.sin(x * 0.21 + y * 0.08);
      const waveB = Math.cos(x * 0.07 - y * 0.18);
      const offset = (y * canvas.width + x) * 4;
      image.data[offset] = Math.round(128 + waveA * 54);
      image.data[offset + 1] = Math.round(128 + waveB * 54);
      image.data[offset + 2] = 255;
      image.data[offset + 3] = 255;
    }
  }
  context.putImageData(image, 0, 0);
  const texture = new THREE.CanvasTexture(canvas);
  texture.wrapS = THREE.RepeatWrapping;
  texture.wrapT = THREE.RepeatWrapping;
  texture.repeat.set(4, 4);
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
        material.envMapIntensity = sourceLayer === 'near' ? 0.48 : 0.26;
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

export function createSceneEnvironment(scene: THREE.Scene, quality: 'hero' | 'standard' | 'mobile'): SceneEnvironmentRuntime {
  const root = new THREE.Group();
  root.name = 'source-backed-poetic-environment';
  const ground = new THREE.Mesh(new THREE.CircleGeometry(64, 96), new THREE.MeshStandardMaterial({ color: 0x77746b, roughness: 0.98, metalness: 0, depthWrite: true }));
  ground.name = 'scene-presentation-ground';
  ground.rotation.x = -Math.PI / 2;
  ground.position.y = -0.12;
  ground.receiveShadow = true;
  root.add(ground);

  const fallbackLandscapes = new Map<PavilionId, LandscapeBuild>();
  for (const id of ['yueyang', 'huanghe', 'tengwang'] as PavilionId[]) {
    const landscape = createLandscape(id, quality);
    landscape.root.visible = id === 'yueyang';
    fallbackLandscapes.set(id, landscape);
    root.add(landscape.root);
  }

  const sky = new Sky();
  sky.name = 'poetic-sky-dome';
  sky.scale.setScalar(1000);
  sky.material.fog = false;
  root.add(sky);

  const waterNormals = createWaterNormalTexture();
  const water = new Water(new THREE.PlaneGeometry(110, 44, 1, 1), {
    textureWidth: quality === 'hero' ? 512 : 256,
    textureHeight: quality === 'hero' ? 512 : 256,
    waterNormals,
    sunDirection: new THREE.Vector3(-0.35, 0.8, 0.45).normalize(),
    sunColor: 0xd9c18d,
    waterColor: 0x496d75,
    distortionScale: 2.2,
    fog: true,
    alpha: 0.9,
  });
  water.name = 'poetic-river-or-lake';
  water.rotation.x = -Math.PI / 2;
  water.renderOrder = -1;
  water.material.transparent = true;
  root.add(water);

  // A restrained physical cue marker keeps the line of poetry tied to a place
  // in the scene: water, steps and terrace cues receive a warm reflection ring;
  // tower/horizon cues remain unmarked so the building silhouette stays clean.
  const focusHalo = new THREE.Mesh(
    new THREE.RingGeometry(0.78, 1.05, 40),
    new THREE.MeshBasicMaterial({
      color: 0xe0b269,
      transparent: true,
      opacity: 0.2,
      depthTest: false,
      depthWrite: false,
      side: THREE.DoubleSide,
    }),
  );
  focusHalo.name = 'poetic-scene-focus-halo';
  focusHalo.rotation.x = -Math.PI / 2;
  focusHalo.renderOrder = 4;
  focusHalo.visible = false;
  root.add(focusHalo);

  const packageRoots = new Map<PavilionId, THREE.Group>();
  const packagePromises = new Map<PavilionId, Promise<void>>();
  let loadController: AbortController | null = null;
  let activePavilion: PavilionId = 'yueyang';
  let reducedMotion = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false;
  let targetMood: SceneMood | null = null;
  let currentMood: SceneMood | null = null;
  let focusTime = 0;
  let focusVisible = false;

  function colorValue(value: string): THREE.Color { return new THREE.Color(value); }

  function applyMood(mood: SceneMood, immediate = false): void {
    if (!currentMood || immediate) currentMood = { ...mood };
    const active = currentMood;
    const blend = immediate ? 1 : 0.075;
    const mix = (from: string, to: string) => colorValue(from).lerp(colorValue(to), blend).getStyle();
    active.skyTop = mix(active.skyTop, mood.skyTop);
    active.skyBottom = mix(active.skyBottom, mood.skyBottom);
    active.fogColor = mix(active.fogColor, mood.fogColor);
    active.sunColor = mix(active.sunColor, mood.sunColor);
    active.waterColor = mix(active.waterColor, mood.waterColor);
    active.ambientColor = mix(active.ambientColor, mood.ambientColor);
    active.fogDensity = THREE.MathUtils.lerp(active.fogDensity, mood.fogDensity, blend);
    active.sunIntensity = THREE.MathUtils.lerp(active.sunIntensity, mood.sunIntensity, blend);
    active.waterOpacity = THREE.MathUtils.lerp(active.waterOpacity, mood.waterOpacity, blend);
    active.ambientIntensity = THREE.MathUtils.lerp(active.ambientIntensity, mood.ambientIntensity, blend);
    const uniforms = sky.material.uniforms;
    uniforms.turbidity.value = 4.8 + active.fogDensity * 100;
    uniforms.rayleigh.value = 1.35;
    uniforms.mieCoefficient.value = 0.006;
    uniforms.mieDirectionalG.value = 0.8;
    uniforms.sunPosition.value.set(-22, 18 + active.sunIntensity * 2, 28);
    scene.fog = new THREE.FogExp2(colorValue(active.fogColor), active.fogDensity);
    scene.background = colorValue(active.skyTop);
    const waterMaterial = water.material as THREE.ShaderMaterial;
    waterMaterial.uniforms.waterColor.value.set(active.waterColor);
    waterMaterial.uniforms.sunColor.value.set(active.sunColor);
    waterMaterial.uniforms.alpha.value = active.waterOpacity;
    water.material.opacity = active.waterOpacity;
  }

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

  async function loadPackageInternal(id: PavilionId): Promise<void> {
    const spec = getSceneSpec(id);
    if (quality === 'mobile' || spec.packageStatus !== 'source-backed' || !spec.packageUrl) return;
    const cached = packageRoots.get(id);
    if (cached) {
      cached.visible = true;
      applyQualityToPackage(cached, quality);
      fallbackLandscapes.get(id)!.root.visible = false;
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
      applyQualityToPackage(packageRoot, quality);
      packageRoots.set(id, packageRoot);
      root.add(packageRoot);
      fallbackLandscapes.get(id)!.root.visible = false;
    } catch (error) {
      if (!isAbortError(error)) console.warn(`[sceneEnvironment] ${id} source scene package unavailable`, error);
    }
  }

  const setPavilion = (id: PavilionId): void => {
    activePavilion = id;
    for (const [landscapeId, landscape] of fallbackLandscapes) landscape.root.visible = landscapeId === id;
    for (const [packageId, packageRoot] of packageRoots) packageRoot.visible = packageId === id;
    const cached = packageRoots.get(id);
    if (cached) {
      applyQualityToPackage(cached, quality);
      fallbackLandscapes.get(id)!.root.visible = false;
    }
    const spec = getSceneSpec(id);
    water.position.set(...spec.defaultWater.position);
    water.rotation.set(...spec.defaultWater.rotation);
    water.scale.set(spec.defaultWater.size[0] / 110, spec.defaultWater.size[1] / 44, 1);
    void loadPackage(id);
  };

  setPavilion('yueyang');

  return {
    root,
    groundY: ground.position.y,
    setPavilion,
    setCueMood: (mood) => { targetMood = mood; if (!currentMood) applyMood(mood, true); },
    setCueFocus: (cue) => {
      focusVisible = cue.focus === 'water' || cue.focus === 'steps' || cue.focus === 'platform';
      focusHalo.visible = focusVisible;
      focusHalo.position.set(...cue.anchor);
      focusHalo.position.y += 0.012;
      (focusHalo.material as THREE.MeshBasicMaterial).color.set(cue.mood.sunColor);
      focusTime = 0;
    },
    update: (deltaSeconds) => {
      if (targetMood) applyMood(targetMood);
      const uniforms = (water.material as THREE.ShaderMaterial).uniforms;
      if (!reducedMotion) uniforms.time.value += deltaSeconds * (quality === 'hero' ? 0.38 : 0.2);
      if (focusVisible) {
        focusTime += deltaSeconds;
        const pulse = reducedMotion ? 1 : 1 + Math.sin(focusTime * 1.6) * 0.08;
        focusHalo.scale.set(1.65 * pulse, 0.72 * pulse, 1);
        (focusHalo.material as THREE.MeshBasicMaterial).opacity = reducedMotion
          ? 0.16
          : 0.14 + (Math.sin(focusTime * 1.6) + 1) * 0.035;
      }
    },
    setReducedMotion: (reduced) => { reducedMotion = reduced; },
    dispose: () => {
      loadController?.abort();
      waterNormals.dispose();
      water.geometry.dispose();
      disposeMaterial(water.material);
      focusHalo.geometry.dispose();
      disposeMaterial(focusHalo.material);
      ground.geometry.dispose();
      disposeMaterial(ground.material);
      sky.geometry.dispose();
      disposeMaterial(sky.material);
      for (const landscape of fallbackLandscapes.values()) disposeObjectTree(landscape.root);
      for (const packageRoot of packageRoots.values()) disposeObjectTree(packageRoot);
      packagePromises.clear();
      packageRoots.clear();
      scene.remove(root);
    },
  };
}
