import './style.css';
import * as THREE from 'three';
import {
  configureYueyangTowerRenderer,
  createYueyangTowerInspectControls,
  createYueyangTowerLookDevLights,
} from './createYueyangTowerStructuralModel';
import { createSceneEnvironment, TOWER_SUN_PRESETS, getTowerBloomStrength, getTowerGodRayStrength } from './runtime/sceneEnvironment';
import { createPostStack } from './runtime/postProcessing';
import { createPoetryPanel } from './runtime/poetryPanel';
import { createPavilionSteles, findSteleRoot } from './runtime/steleMesh';
import { createAmbientAtmosphere } from './runtime/ambientAtmosphere';
import { disposeObjectDeep } from './runtime/deepDispose';
import { getSceneSpec, type SceneCue } from './runtime/sceneCatalog';
import {
  createPavilionStudyModel,
  PAVILION_SPECS,
  type PavilionId,
  type PavilionSpec,
} from './createPavilionGalleryModel';
import { detectDeviceQualityProfile } from './runtime/DeviceQualityProfile';
import type { PavilionModelLoadOptions } from './runtime/loadVerifiedGlb';
import { getPavilionAssemblyRuntime } from './runtime/PavilionAssemblyRuntime';

declare global {
  interface Window {
    __CHINA_TOWERS_READY__?: boolean;
    __CHINA_TOWERS_DIAGNOSTICS__?: {
      activeId: PavilionId;
      modelName: string;
      runtimeLod: string;
      ready: boolean;
      loadError: boolean;
      degraded: boolean;
      failureReason: string | null;
      assetState: 'loading' | 'ready' | 'degraded';
      partCount: number;
      selectedPart: string | null;
      explodedAmount: number;
      qualityProfile: 'hero' | 'standard' | 'mobile';
      pixelRatioCap: number;
      appliedPixelRatio: number;
      shadowMapSize: number;
      shadowTechnique: 'pcf-soft' | 'pcf';
      shadowRadius: number;
      shadowBlurSamples: number;
      toneMappingExposure: number;
      environmentIntensity: number;
      lightMode: 'neutral' | 'grazing' | 'reference';
      renderCalls: number;
      renderTriangles: number;
      // Framing, exposed so probes can reason about the horizon instead of
      // guessing. Camera height is the single number that decides how a
      // distant skyline reads, and it is derived here from the model span
      // rather than authored anywhere, so it cannot be read off the source.
      cameraPosition: number[];
      cameraTarget: number[];
      cameraFov: number;
    };
    __CHINA_TOWERS_PARTS__?: Array<{ id: string; label: string; category: string }>;
    __CHINA_TOWERS_UI__?: {
      setLoaderVisible(visible: boolean): void;
      setLoaderProgress(ratio: number, status: string): void;
      setModelMeta(meta: { modelName: string; runtimeLod: string; renderTriangles: number; partCount: number }): void;
    };
    activeModel?: THREE.Group;
    __activeModelDebug?: {
      name: string;
      children: number;
      bounds: { min: number[]; max: number[]; size: number[] };
    };
    __frameModelLogs?: Array<{ centre: number[]; span: number; distance: number; multiplier: number }>;
    __CHINA_TOWERS_SCENE__?: THREE.Scene;
    __CHINA_TOWERS_CAMERA__?: THREE.Camera;
    __CHINA_TOWERS_RENDERER__?: THREE.WebGLRenderer;
  }
}

const canvas = document.querySelector<HTMLCanvasElement>('#scene');
if (!canvas) throw new Error('Missing #scene canvas');
const sceneCanvas: HTMLCanvasElement = canvas;
const title = document.querySelector<HTMLElement>('#tower-title');
const english = document.querySelector<HTMLElement>('#tower-english');
const location = document.querySelector<HTMLElement>('#tower-location');
const description = document.querySelector<HTMLElement>('#tower-description');
const status = document.querySelector<HTMLElement>('#status');
const cards = [...document.querySelectorAll<HTMLButtonElement>('[data-pavilion]')];
const explodeButton = document.querySelector<HTMLButtonElement>('#explode');
const highModelDebugButton = document.querySelector<HTMLButtonElement>('#high-model-debug');
const toggleDebugScreenshotButton = document.querySelector<HTMLButtonElement>('#toggle-debug-screenshot');
const lowAngleButton = document.querySelector<HTMLButtonElement>('#low-angle');
const resetButton = document.querySelector<HTMLButtonElement>('#reset-view');
const reviewParams = new URLSearchParams(window.location.search);
const reviewView = reviewParams.get('view');
const requestedLightMode = reviewParams.get('light');
const noShadow = reviewParams.get('noshadow') === '1';
const hideGLB = reviewParams.get('hideglb') === '1';
const debugLoop = reviewParams.get('debug') === '1';
const lightMode: 'neutral' | 'grazing' | 'reference' = requestedLightMode === 'neutral' || requestedLightMode === 'grazing'
  ? requestedLightMode
  : 'reference';

const deviceQuality = detectDeviceQualityProfile();
const renderer = new THREE.WebGLRenderer({
  canvas: sceneCanvas,
  antialias: deviceQuality.id !== 'mobile',
  alpha: false,
  powerPreference: 'high-performance',
  logarithmicDepthBuffer: true,
});
configureYueyangTowerRenderer(renderer);
renderer.shadowMap.enabled = !noShadow;
renderer.shadowMap.type = deviceQuality.shadowTechnique === 'pcf-soft' ? THREE.PCFSoftShadowMap : THREE.PCFShadowMap;
// Shadows render on demand: sun position/model only change on tower switches
// and framing passes, both of which set sunKey.shadow.needsUpdate. Auto-update
// otherwise re-rendered a 4096px shadow map every single frame.
renderer.shadowMap.autoUpdate = false;
renderer.toneMappingExposure = deviceQuality.toneMappingExposure;
renderer.setPixelRatio(Math.min(window.devicePixelRatio, deviceQuality.pixelRatioCap));

const scene = new THREE.Scene();
// Background, fog and environment come from the HDRI-driven poetic scene
// module (per-tower sky + IBL). No static colour here — the environment owns
// them so switching pavilions re-grades the whole atmosphere.
scene.environmentIntensity = deviceQuality.environmentIntensity;
const lightRig = createYueyangTowerLookDevLights(lightMode);
scene.add(lightRig);
const sunKey = lightRig.getObjectByName('sun-key') as THREE.DirectionalLight;
sunKey.shadow.mapSize.set(deviceQuality.shadowMapSize, deviceQuality.shadowMapSize);
sunKey.shadow.radius = deviceQuality.shadowRadius;
sunKey.shadow.blurSamples = deviceQuality.shadowBlurSamples;
sunKey.shadow.bias = -0.00025;
sunKey.shadow.normalBias = 0.03;
scene.add(sunKey.target);

const poeticEnvironment = createSceneEnvironment(scene, deviceQuality.id, renderer);
// Review toggle: `?noranges=1` hides the distant ridge lines so the far
// field's contribution to the 壮阔 reading can be A/B'd — same pattern as
// `?norays=1`. Not a quality switch; the ranges cost ~2k triangles.
if (reviewParams.get('noranges') === '1') {
  const distantRanges = poeticEnvironment.root.getObjectByName('distant-ranges');
  if (distantRanges) distantRanges.visible = false;
}
// `?nobg=1` drops the HDRI background (IBL stays) — flicker probes for the
// bloom/HalfFloat overflow path.
if (reviewParams.get('nobg') === '1') {
  scene.background = null;
}
// `?nowater=1` hides the water plane entirely — its mirror RT is the largest
// per-frame re-render, so it needs its own isolation switch (flicker probes).
if (reviewParams.get('nowater') === '1') {
  const water = poeticEnvironment.root.getObjectByName('poetic-river-or-lake');
  if (water) water.visible = false;
}
scene.add(poeticEnvironment.root);

// The shore-rock ring sits exactly where a ground-level orbit travels: with
// the camera clamped to plaza height it plows into the rocks and a rock face
// fills the whole lens for several frames — the measured flicker dips. The
// rocks are static, so collect their world bounding spheres once and use them
// as soft push-out obstacles in constrainInspectionCamera.
const cameraObstacles: Array<{ center: THREE.Vector3; radius: number }> = [];
poeticEnvironment.root.updateMatrixWorld(true);
poeticEnvironment.root.traverse((obj) => {
  if (!(obj instanceof THREE.Mesh) || !obj.name.startsWith('scene-shore-rock')) return;
  const geometry = obj.geometry;
  if (!geometry.boundingSphere) geometry.computeBoundingSphere();
  cameraObstacles.push({
    center: geometry.boundingSphere.center.clone().applyMatrix4(obj.matrixWorld),
    radius: geometry.boundingSphere.radius * obj.matrixWorld.getMaxScaleOnAxis(),
  });
});

// 诗境氛围层:水岸雾气 / 飘絮落英 / 暮色流萤,随楼切换配置。
const atmosphere = createAmbientAtmosphere(deviceQuality.id);
scene.add(atmosphere.root);

const camera = new THREE.PerspectiveCamera(42, 1, 0.1, 180);
const controls = createYueyangTowerInspectControls(camera, sceneCanvas);
controls.enableDamping = true;
controls.dampingFactor = 0.075;
controls.minPolarAngle = Math.PI * 0.08;
controls.maxPolarAngle = Math.PI * 0.68;
controls.enablePan = true;

// HDR chain + bloom finish: hero/standard get bloom + god rays, mobile keeps
// the single-pass film grade so the per-tower mood survives on the low tier.
// `?nopost=1` bypasses the whole post chain (bloom, god rays, grade) for
// A/B isolation of flicker sources; the raw renderer.render path stays live.
const noPost = reviewParams.get('nopost') === '1';
const postStack = noPost ? null : createPostStack(renderer, scene, camera, deviceQuality.id);
// The god-ray mask pass must not see the water (its onBeforeRender would
// re-render the mirror scene) or the atmosphere billboards (they would punch
// solid holes in the mask).
postStack?.setGodRaysExcluded([
  poeticEnvironment.root.getObjectByName('poetic-river-or-lake') ?? null,
  atmosphere.root,
]);

// 诗文抽屉 + 场景碑匾:碑匾立于广场前侧缘,随楼切换显隐,点击开对应篇目。
const poetryPanel = createPoetryPanel();
const steles = createPavilionSteles();
for (const [id, stele] of Object.entries(steles)) {
  stele.visible = id === 'yueyang';
  scene.add(stele);
}

function applyTowerAtmosphere(id: PavilionId): void {
  const preset = TOWER_SUN_PRESETS[id];
  sunKey.color = new THREE.Color(preset.color);
  // A firm, slightly warm key with restrained fills — real sunlight reads
  // through strong directional contrast, not through even ambient wash.
  sunKey.intensity = preset.intensity * 0.88;
  sunKey.castShadow = true;
  // Per-tower film grade + crepuscular rays follow the same sun preset the
  // HDRI and key light use, so sky, shadows, streaks and grade all agree.
  postStack?.setGrade(id);
  const godRayStrength = reviewParams.get('norays') === '1' ? 0 : getTowerGodRayStrength(id);
  postStack?.setGodRays(new THREE.Vector3(...preset.direction), godRayStrength, preset.color);
  // Cool sky fill and warm ground bounce in the hemisphere light, a low rim
  // to pick eave edges out of the sky; fills stay dim so shadows stay shadows.
  const fill = lightRig.getObjectByName('sky-fill') as THREE.DirectionalLight | null;
  const rim = lightRig.getObjectByName('warm-rim') as THREE.DirectionalLight | null;
  const hemi = lightRig.children.find((child): child is THREE.HemisphereLight => child instanceof THREE.HemisphereLight) ?? null;
  if (fill) fill.intensity = 0.12;
  if (rim) rim.intensity = 0.45;
  if (hemi) {
    hemi.intensity = 0.28;
    hemi.color.set(0xb9cfe4);
    hemi.groundColor.set(0x8a7562);
  }
}

function updateControlDistances(bounds: THREE.Box3) {
  const size = bounds.getSize(new THREE.Vector3());
  const span = Math.max(size.x, size.y, size.z);
  const minDistance = activeSpec.id === 'tengwang'
    ? Math.max(3, span * 0.015)
    : Math.max(12, span * 0.18);
  const maxDistance = Math.max(68, span * 1.6);
  controls.minDistance = minDistance;
  controls.maxDistance = maxDistance;
}

let activeSpec: PavilionSpec = PAVILION_SPECS[0];
let activeModel: THREE.Group | null = null;
let exploded = false;
let explodedAmount = 0;
let explodedTarget = 0;
let selectionSequence = 0;
let activeLoadController: AbortController | null = null;
let activeView = reviewView ?? 'default';
let cameraSafetyBounds: THREE.Box3 | null = null;
let cameraGroundY = 0;
let cameraClearance = 0.35;

const HIGH_MODEL_IDS = new Set<PavilionId>(['yueyang', 'huanghe', 'tengwang']);

type PavilionFactory = (options?: PavilionModelLoadOptions) => THREE.Group;

function frameModel(view = activeView) {
  if (!activeModel) return;
  const lowAngleActive = view === 'low-angle';
  lowAngleButton?.setAttribute('aria-pressed', String(lowAngleActive));
  if (lowAngleButton) lowAngleButton.textContent = lowAngleActive ? '退出仰视' : '仰视建筑';
  const bounds = new THREE.Box3().setFromObject(activeModel);
  // Loaders that carry a large site (e.g. the Penglai walled courtyard) expose
  // a focus box around the main building; frame the camera on that so the
  // pavilion stays inspectable while the courtyard extends around it. Tengwang
  // frames on its full bounds: its out-of-area site junk is removed at load,
  // and the podium+tower composition needs the whole footprint in frame.
  const useFocusBox = activeSpec.id !== 'tengwang' && activeModel.userData.focusBounds instanceof THREE.Box3;
  const focusBounds = useFocusBox ? activeModel.userData.focusBounds : bounds;
  const centre = focusBounds.getCenter(new THREE.Vector3());
  const size = focusBounds.getSize(new THREE.Vector3());
  const span = Math.max(size.x, size.y, size.z);
  cameraSafetyBounds = bounds.clone();
  cameraGroundY = Math.max(poeticEnvironment.groundY, bounds.min.y);
  cameraClearance = Math.max(0.2, Math.min(0.6, span * 0.012));
  const distanceMultiplier = activeSpec.id === 'tengwang'
    ? (window.innerWidth < 720 ? 1.15 : 1.45)
    : (window.innerWidth < 720 ? 1.96 : 1.62);
  const distance = Math.max(span * distanceMultiplier, 12);
  const reviewDirections: Record<string, THREE.Vector3> = {
    front: new THREE.Vector3(0, 0.22, 1),
    right: new THREE.Vector3(1, 0.22, 0),
    rear: new THREE.Vector3(0, 0.22, -1),
    left: new THREE.Vector3(-1, 0.22, 0),
    elevated: new THREE.Vector3(0.72, 0.92, 0.72),
    'three-quarter': new THREE.Vector3(0.82, 0.54, 0.82),
  };
  const reviewDirection = reviewDirections[view];
  sunKey.shadow.needsUpdate = true;
  updateControlDistances(bounds);
  if (view === 'low-angle') {
    const eyeHeight = THREE.MathUtils.clamp(size.y * 0.065, 1.2, 2.2);
    const horizontalDirection = new THREE.Vector3(0.72, 0, 1).normalize();
    camera.position.copy(centre).addScaledVector(horizontalDirection, distance * 0.72);
    camera.position.y = cameraGroundY + eyeHeight;
    controls.target.set(centre.x, bounds.min.y + size.y * 0.58, centre.z);
  } else if (reviewDirection) {
    camera.position.copy(centre).addScaledVector(reviewDirection.normalize(), distance);
    controls.target.copy(centre).add(new THREE.Vector3(0, size.y * 0.06, 0));
  } else {
    // The tengwang default frame swings ~24° around the tower so the
    // vermilion dusk disc (正赤如丹) clears the intro title and shares the
    // shot with the pavilion; other towers keep the classic 45° corner view.
    // 黄鹤楼同样向太阳方位偏转并抬头取景, 让白金日轮进入画面上缘。
    const defaultAzimuth = activeSpec.id === 'tengwang'
      ? 1.22
      : activeSpec.id === 'huanghe'
        ? 1.15
        : Math.PI * 0.25;
    // huanghe's camera sat at 0.6 of the framing distance — 44 m above the
    // water, pitched 18.7° down, which put the horizon 6% from the top of the
    // frame (scripts/verify-distant-ranges.cjs --camera). With 42° of fov that
    // leaves roughly 48 px of sky, and a distant range needs somewhere to
    // stand: huanghe's ridges measured the weakest footprint of the three
    // purely because there was no sky left to show them in. Dropping to 0.46
    // puts the horizon near the upper third without cropping the roof.
    const camHeight = activeSpec.id === 'huanghe' ? 0.46 : 0.34;
    camera.position.set(
      centre.x + Math.sin(defaultAzimuth) * distance * 1.16,
      centre.y + distance * camHeight,
      centre.z + Math.cos(defaultAzimuth) * distance * 1.16,
    );
    // The tengwang podium is wide and low relative to the tower, so the
    // default target needs more lift to keep the roof crown in frame;
    // huanghe raises the target further so the frame tilts into the sky.
    const targetLift = activeSpec.id === 'tengwang' ? 0.2 : activeSpec.id === 'huanghe' ? 0.5 : 0.14;
    controls.target.copy(centre).add(new THREE.Vector3(0, size.y * targetLift, 0));
  }
  camera.near = view === 'low-angle'
    ? THREE.MathUtils.clamp(span / 500, 0.03, 0.12)
    : Math.max(0.1, span / 100);
  // Far reaches past the water horizon so the HDRI sky and the fogged water
  // blend without clipping: the water plane now extends to 2000m to die inside
  // the fog, so the far floor must clear it.
  camera.far = Math.max(2600, span * 12);
  camera.updateProjectionMatrix();
  const shadowExtent = Math.max(12, span * 0.78);
  // Key light direction follows the per-tower HDRI sun so shadows, water
  // speculars and the photographic sky agree on one sun.
  const sunDirection = new THREE.Vector3(...TOWER_SUN_PRESETS[activeSpec.id].direction).normalize();
  sunKey.position.copy(centre).addScaledVector(sunDirection, span * 1.3);
  sunKey.target.position.copy(centre).add(new THREE.Vector3(0, size.y * 0.12, 0));
  const shadowCamera = sunKey.shadow.camera as THREE.OrthographicCamera;
  shadowCamera.left = -shadowExtent;
  shadowCamera.right = shadowExtent;
  shadowCamera.top = shadowExtent;
  shadowCamera.bottom = -shadowExtent;
  const baseShadowNear = Math.max(0.1, span * 0.02);
  shadowCamera.near = activeSpec.id === 'tengwang'
    ? Math.max(baseShadowNear, span * 0.06, 1.2)
    : baseShadowNear;
  shadowCamera.far = span * 4.2;
  shadowCamera.updateProjectionMatrix();
  updateControlDistances(bounds);
  controls.update();
}

function constrainInspectionCamera(): void {
  if (!cameraSafetyBounds) return;
  // Ground clamp applies to every tower — tengwang included — so the orbit
  // can never dip the eye below the plaza or the water. Only the collision-box
  // push-out is skipped for tengwang: its wide podium bounds made the push
  // fight the intended close framing.
  const minimumY = Math.max(poeticEnvironment.groundY, cameraGroundY) + cameraClearance;
  if (camera.position.y < minimumY) camera.position.y = minimumY;
  // Shore-rock soft push applies to every tower (the rocks belong to the
  // shared environment, and the ground-level orbit corridor runs through the
  // ring on all three). The correction is per-frame absolute — a partial
  // nudge loses to a continuous drag, which re-penetrates faster than a 30%
  // lerp can return, and the lens ends up inside the rock again. The sphere
  // boundary is smooth, so the resolved path reads as the camera gliding
  // around the obstacle instead of a snap.
  for (const obstacle of cameraObstacles) {
    const offset = camera.position.clone().sub(obstacle.center);
    const distance = offset.length();
    const clearance = obstacle.radius + Math.max(cameraClearance, 0.6);
    if (distance >= clearance) continue;
    if (distance < 1e-4) {
      camera.position.x = obstacle.center.x + clearance;
      continue;
    }
    camera.position.copy(obstacle.center).addScaledVector(offset.divideScalar(distance), clearance);
    if (camera.position.y < minimumY) camera.position.y = minimumY;
  }
  if (activeSpec.id === 'tengwang') return;

  const collisionBounds = cameraSafetyBounds.clone().expandByScalar(cameraClearance);
  if (collisionBounds.containsPoint(camera.position)) {
    // Soft push: only nudge toward the nearest boundary, don't snap.
    const exits = [
      { distance: Math.abs(camera.position.x - collisionBounds.min.x), axis: 'x' as const, value: collisionBounds.min.x },
      { distance: Math.abs(camera.position.x - collisionBounds.max.x), axis: 'x' as const, value: collisionBounds.max.x },
      { distance: Math.abs(camera.position.z - collisionBounds.min.z), axis: 'z' as const, value: collisionBounds.min.z },
      { distance: Math.abs(camera.position.z - collisionBounds.max.z), axis: 'z' as const, value: collisionBounds.max.z },
    ].sort((a, b) => a.distance - b.distance);
    const nearestExit = exits[0];
    if (nearestExit.distance < 0.05) {
      camera.position[nearestExit.axis] = nearestExit.value;
    } else {
      const factor = 0.25;
      camera.position[nearestExit.axis] = THREE.MathUtils.lerp(
        camera.position[nearestExit.axis],
        nearestExit.value,
        factor
      );
    }
  }

  const distanceToModel = cameraSafetyBounds.distanceToPoint(camera.position);
  const desiredNear = THREE.MathUtils.clamp(distanceToModel * 0.08, 0.03, Math.max(0.08, cameraSafetyBounds.getSize(new THREE.Vector3()).length() / 100));
  // Near-plane hysteresis. `near` sets how the renderer's logarithmic depth
  // buffer distributes precision, so retuning it continuously while orbiting
  // shifts every depth value each frame: surfaces sitting a hair apart — the
  // podium slabs, the stepped 台基 courses — cross the comparison threshold
  // back and forth and strobe. Only retune on a change big enough to be worth
  // the depth reshuffle (>20%), and refresh the projection matrix when we do
  // (the old code dropped that, so the retune only ever landed on the next
  // resize — the one time it must not happen mid-frame).
  if (Math.abs(desiredNear - camera.near) > camera.near * 0.2) {
    camera.near = desiredNear;
    camera.updateProjectionMatrix();
  }
}

function setLowAngleView(enabled: boolean): void {
  activeView = enabled ? 'low-angle' : 'default';
  lowAngleButton?.setAttribute('aria-pressed', String(enabled));
  if (lowAngleButton) lowAngleButton.textContent = enabled ? '退出仰视' : '仰视建筑';
  frameModel(activeView);
  if (status) status.textContent = enabled
    ? 'LOW ANGLE · 拖拽观察檐下与牌匾'
    : 'ORBIT · DRAG TO INSPECT';
}

function setExploded(next: boolean) {
  if (!activeModel) return;
  exploded = next;
  explodedTarget = next ? 1 : 0;
  const assemblyRuntime = getPavilionAssemblyRuntime(activeModel);
  if (!assemblyRuntime) {
    activeModel.children.forEach((part) => {
      const origin = part.userData.explodeOrigin as THREE.Vector3 | undefined;
      if (!origin) return;
      part.position.copy(origin).multiplyScalar(next ? 1.16 : 1);
    });
  }
  if (explodeButton) explodeButton.textContent = next ? '收拢构件' : '展开构件';
  explodeButton?.setAttribute('aria-pressed', String(next));
  if (status) status.textContent = next ? 'EXPLODED VIEW · 可旋转查看构件层次' : 'ORBIT · DRAG TO INSPECT';
}

function updateCopy(spec: PavilionSpec) {
  document.documentElement.style.setProperty('--accent', spec.accent);
  if (title) title.textContent = spec.nameCN;
  if (english) english.textContent = spec.nameEN;
  if (location) location.textContent = `${spec.location} · ${spec.era}`;
  if (description) description.textContent = spec.description;
  cards.forEach((card) => {
    const active = card.dataset.pavilion === spec.id;
    card.classList.toggle('is-active', active);
    card.setAttribute('aria-pressed', String(active));
  });
}

async function loadPavilionFactory(spec: PavilionSpec): Promise<PavilionFactory> {
  if (spec.id === 'yueyang') {
    const module = await import('./createYueyangTowerNativeModel');
    return module.createYueyangTowerNativeModel;
  }
  if (spec.id === 'tengwang') {
    const module = await import('./createTengwangTowerHighModel');
    return module.createTengwangTowerHighModel;
  }
  if (spec.id === 'huanghe') {
    const module = await import('./createHuangheTowerHighModel');
    return module.createHuangheTowerHighModel;
  }
  return () => createPavilionStudyModel(spec);
}

// ---------------------------------------------------------------------------
// 诗境机位「一键入诗」: sceneCatalog 为每楼准备了三个诗中视角(机位 + 诗句 +
// 观察导语)。点击按钮以缓动飞行把相机送入机位,面板淡入诗句;拖拽/滚轮打断。
// ---------------------------------------------------------------------------

const cueButtonsContainer = document.querySelector<HTMLElement>('#scene-cue-buttons');
const readingPanel = document.querySelector<HTMLElement>('#scene-reading');
const readingTitle = document.querySelector<HTMLElement>('#reading-title');
const readingLine = document.querySelector<HTMLElement>('#reading-line');
const readingObservation = document.querySelector<HTMLElement>('#reading-observation');

type CueFlight = {
  fromPos: THREE.Vector3;
  toPos: THREE.Vector3;
  fromTarget: THREE.Vector3;
  toTarget: THREE.Vector3;
  start: number;
  duration: number;
};

let cueFlight: CueFlight | null = null;
let readingTimer: number | null = null;
// While a poetic cue is active the key light drifts toward the cue's mood sun
// (the environment module blends fog/water in parallel) and the hemisphere
// fill takes the mood's ambient tone; god rays bias with the mood sun.
let sunMood: { color: string; intensity: number; ambient: string; ambientIntensity: number } | null = null;
const sunTmpColor = new THREE.Color();
const ambientTmpColor = new THREE.Color();

const easeInOutCubic = (t: number): number => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);

function hideSceneReading(): void {
  readingPanel?.classList.remove('is-visible');
  if (readingTimer !== null) {
    window.clearTimeout(readingTimer);
    readingTimer = null;
  }
}

function showSceneReading(cue: SceneCue): void {
  if (!readingPanel || !readingTitle || !readingLine || !readingObservation) return;
  readingTitle.textContent = cue.title;
  readingLine.textContent = cue.line;
  readingObservation.textContent = cue.observation;
  readingPanel.classList.add('is-visible');
  if (readingTimer !== null) window.clearTimeout(readingTimer);
  readingTimer = window.setTimeout(hideSceneReading, 10000);
}

function buildCueButtons(): void {
  if (!cueButtonsContainer) return;
  cueButtonsContainer.innerHTML = '';
  for (const cue of getSceneSpec(activeSpec.id).cues) {
    const button = document.createElement('button');
    button.type = 'button';
    button.textContent = cue.title;
    button.setAttribute('aria-label', `诗境机位 · ${cue.title} · ${cue.line}`);
    button.addEventListener('click', () => flyToCue(cue));
    cueButtonsContainer.appendChild(button);
  }
}

function flyToCue(cue: SceneCue): void {
  cueFlight = {
    fromPos: camera.position.clone(),
    toPos: new THREE.Vector3(...cue.camera.position),
    fromTarget: controls.target.clone(),
    toTarget: new THREE.Vector3(...cue.camera.target),
    start: performance.now(),
    duration: 1900,
  };
  controls.enabled = false;
  poeticEnvironment.setMood(cue.mood);
  const preset = TOWER_SUN_PRESETS[activeSpec.id];
  const moodSunRatio = cue.mood.sunIntensity / preset.intensity;
  sunMood = {
    color: cue.mood.sunColor,
    intensity: cue.mood.sunIntensity * 0.88,
    ambient: cue.mood.ambientColor,
    ambientIntensity: cue.mood.ambientIntensity * 0.28,
  };
  // Dusk cues throw longer crepuscular shafts; bright ones pull back.
  postStack?.setGodRays(
    new THREE.Vector3(...preset.direction),
    (reviewParams.get('norays') === '1' ? 0 : getTowerGodRayStrength(activeSpec.id)) * moodSunRatio,
    cue.mood.sunColor,
  );
  // Grade bias per cue mood: dawn lifts cool and bright, autumn dusk sinks
  // warm and dark — the difference between 晨雾 and 落霞.
  postStack?.setMoodBias(
    cue.mood.name === 'dawn'
      ? { tint: [0.98, 1.0, 1.04], exposure: 0.015 }
      : cue.mood.name === 'autumnDusk'
        ? { tint: [1.08, 0.96, 0.88], exposure: -0.05 }
        : { tint: [1.0, 1.0, 1.0], exposure: 0.015 },
  );
  // 意象构图: 整帧向太阳方位横移, 让日轮/霞光真正入画, 主阁偏向一侧。
  const sunFlat = new THREE.Vector3(preset.direction[0], 0, preset.direction[2]).normalize();
  const lateral = new THREE.Vector3(-sunFlat.z, 0, sunFlat.x);
  const camDistance = cueFlight.toPos.distanceTo(cueFlight.toTarget);
  const frameShift = (cue.mood.name === 'clearDay' ? 2.5 : 7) * THREE.MathUtils.clamp(camDistance / 40, 0.4, 1.2);
  cueFlight.toPos.addScaledVector(lateral, frameShift);
  cueFlight.toTarget.addScaledVector(lateral, frameShift * 0.55);
  showSceneReading(cue);
  if (status) status.textContent = `POETIC VIEW · ${cue.title}`;
}

function cancelCueFlight(): void {
  if (!cueFlight && !sunMood) return;
  cueFlight = null;
  poeticEnvironment.setMood(null);
  sunMood = null;
  postStack?.setMoodBias(null);
  controls.autoRotate = false;
  // Restore the tower's own atmosphere (grade, god rays, light rig) in one
  // idempotent call; the render-loop lerp eases the sun back on top.
  applyTowerAtmosphere(activeSpec.id);
  controls.enabled = true;
}

function updateCueFlight(): void {
  if (!cueFlight) return;
  const progress = Math.min(1, (performance.now() - cueFlight.start) / cueFlight.duration);
  const eased = easeInOutCubic(progress);
  camera.position.lerpVectors(cueFlight.fromPos, cueFlight.toPos, eased);
  controls.target.lerpVectors(cueFlight.fromTarget, cueFlight.toTarget, eased);
  if (progress >= 1) {
    cueFlight = null;
    controls.enabled = true;
    // Once the cue settles, a whisper-slow drift keeps the frame alive —
    // cinematic hold instead of a frozen still.
    controls.autoRotate = true;
    controls.autoRotateSpeed = 0.22;
  }
}

sceneCanvas.addEventListener('pointerdown', () => {
  cancelCueFlight();
  hideSceneReading();
});
sceneCanvas.addEventListener('wheel', () => {
  cancelCueFlight();
  hideSceneReading();
}, { passive: true });

function activateModel(model: THREE.Group, spec: PavilionSpec) {
  activeModel = model;
  window.activeModel = model;
  window.__CHINA_TOWERS_PARTS__ = [];
  explodedAmount = 0;
  explodedTarget = 0;
  activeModel.children.forEach((part) => {
    if (!part.userData.explodeOrigin) part.userData.explodeOrigin = part.position.clone();
  });
  scene.add(activeModel);
  if (hideGLB) model.visible = false;
  
  // Expose for debugging
  window.__activeModelDebug = {
    name: model.name,
    children: model.children.length,
    bounds: (() => {
      const b = new THREE.Box3().setFromObject(model);
      return { min: Array.from(b.min), max: Array.from(b.max), size: Array.from(b.getSize(new THREE.Vector3())) };
    })()
  };
  
  window.__CHINA_TOWERS_DIAGNOSTICS__ = {
    activeId: spec.id,
    modelName: model.name,
    runtimeLod: String(model.userData.runtimeLod ?? 'pending'),
    ready: false,
    loadError: false,
    degraded: false,
    failureReason: null,
    assetState: 'loading',
    partCount: 0,
    selectedPart: null,
    explodedAmount: 0,
    qualityProfile: deviceQuality.id,
    pixelRatioCap: deviceQuality.pixelRatioCap,
    appliedPixelRatio: renderer.getPixelRatio(),
    shadowMapSize: deviceQuality.shadowMapSize,
    shadowTechnique: deviceQuality.shadowTechnique,
    shadowRadius: deviceQuality.shadowRadius,
    shadowBlurSamples: deviceQuality.shadowBlurSamples,
    toneMappingExposure: deviceQuality.toneMappingExposure,
    environmentIntensity: deviceQuality.environmentIntensity,
    lightMode,
    renderCalls: 0,
    renderTriangles: 0,
    cameraPosition: [0, 0, 0],
    cameraTarget: [0, 0, 0],
    cameraFov: 0,
  };
  // Expose THREE for runtime browser patching.
  (window as any).__CHINA_TOWERS_THREE__ = THREE;
  (window as any).__CHINA_TOWERS_SCENE__ = scene;
  (window as any).__CHINA_TOWERS_CAMERA__ = camera;
  (window as any).__CHINA_TOWERS_RENDERER__ = renderer;
  // Defer camera framing for verified high models until the async GLB/pack
  // loader finishes and dispatches `china-towers-model-ready`.  Framing too
  // early on an empty root produces span=0 and leaves the camera at the
  // world origin, which makes a correctly-loaded model invisible.
  if (activeModel.children.length > 0) {
    frameModel();
  }
  if (status) status.textContent = HIGH_MODEL_IDS.has(spec.id) ? 'LOADING VERIFIED HIGH MODEL…' : 'ORBIT · DRAG TO INSPECT';
}

async function selectPavilion(id: PavilionId) {
  const spec = PAVILION_SPECS.find((item) => item.id === id);
  if (!spec || spec.id === activeSpec.id && activeModel) return;
  const requestSequence = ++selectionSequence;
  activeLoadController?.abort();
  activeLoadController = new AbortController();
  if (activeModel) {
    getPavilionAssemblyRuntime(activeModel)?.dispose();
    scene.remove(activeModel);
    // Deep dispose: geometry + materials + every texture slot. The previous
    // shallow pass leaked the GLB atlases on every tower switch.
    disposeObjectDeep(activeModel);
  }
  cancelCueFlight();
  hideSceneReading();
  activeSpec = spec;
  window.__CHINA_TOWERS_READY__ = false;
  updateCopy(spec);
  applyTowerAtmosphere(spec.id);
  poeticEnvironment.setPavilion(spec.id);
  atmosphere.setPavilion(spec.id);
  buildCueButtons();
  postStack?.setBloomStrength(getTowerBloomStrength(spec.id));
  poetryPanel.setPavilion(spec.id);
  for (const [id, stele] of Object.entries(steles)) stele.visible = id === spec.id;
  const loadingFallback = HIGH_MODEL_IDS.has(spec.id) ? null : createPavilionStudyModel(spec);
  if (loadingFallback) {
    loadingFallback.name = `${spec.id}-module-loading-fallback`;
    loadingFallback.userData.moduleLoading = true;
    activateModel(loadingFallback, spec);
  } else {
    if (status) status.textContent = 'LOADING VERIFIED HIGH MODEL…';
    if (window.__CHINA_TOWERS_UI__) {
      window.__CHINA_TOWERS_UI__.setLoaderVisible(true);
      window.__CHINA_TOWERS_UI__.setLoaderProgress(0, 'LOADING VERIFIED HIGH MODEL…');
    }
    window.__CHINA_TOWERS_DIAGNOSTICS__ = {
      activeId: spec.id,
      modelName: `${spec.id}-loading`,
      runtimeLod: 'pending',
      ready: false,
      loadError: false,
      degraded: false,
      failureReason: null,
      assetState: 'loading',
      partCount: 0,
      selectedPart: null,
      explodedAmount: 0,
      qualityProfile: deviceQuality.id,
      pixelRatioCap: deviceQuality.pixelRatioCap,
      appliedPixelRatio: renderer.getPixelRatio(),
      shadowMapSize: deviceQuality.shadowMapSize,
      shadowTechnique: deviceQuality.shadowTechnique,
      shadowRadius: deviceQuality.shadowRadius,
      shadowBlurSamples: deviceQuality.shadowBlurSamples,
      toneMappingExposure: deviceQuality.toneMappingExposure,
      environmentIntensity: deviceQuality.environmentIntensity,
      lightMode,
      renderCalls: 0,
      renderTriangles: 0,
      cameraPosition: [0, 0, 0],
      cameraTarget: [0, 0, 0],
      cameraFov: 0,
    };
    frameModel();
  }
  try {
    const factory = await loadPavilionFactory(spec);
    if (requestSequence !== selectionSequence || activeSpec.id !== spec.id) return;
    const model = factory({
      signal: activeLoadController.signal,
      onProgress: (progress) => window.dispatchEvent(new CustomEvent('china-towers-model-progress', {
        detail: { id: spec.id, lod: activeModel?.userData.runtimeLod ?? 'lod0', ...progress },
      })),
    });
    if (loadingFallback) {
      scene.remove(loadingFallback);
      disposeObjectDeep(loadingFallback);
    }
    activateModel(model, spec);
    if (!HIGH_MODEL_IDS.has(spec.id)) window.__CHINA_TOWERS_READY__ = true;
  } catch (error) {
    if (requestSequence !== selectionSequence || activeSpec.id !== spec.id) return;
    if (loadingFallback) {
      loadingFallback.userData.highModelLoadError = true;
      loadingFallback.userData.highModelLoadErrorReason = 'module-import-failed';
      activateModel(loadingFallback, spec);
      window.__CHINA_TOWERS_READY__ = true;
    } else {
      window.__CHINA_TOWERS_READY__ = true;
      if (window.__CHINA_TOWERS_DIAGNOSTICS__) {
        window.__CHINA_TOWERS_DIAGNOSTICS__.loadError = true;
        window.__CHINA_TOWERS_DIAGNOSTICS__.degraded = true;
        window.__CHINA_TOWERS_DIAGNOSTICS__.failureReason = 'module-import-failed';
        window.__CHINA_TOWERS_DIAGNOSTICS__.assetState = 'degraded';
      }
      if (status) status.textContent = 'DEGRADED VIEW · HIGH MODEL ASSET UNAVAILABLE';
    }
    console.error(`Failed to load pavilion module: ${spec.id}`, error);
  }
}

cards.forEach((card) => card.addEventListener('click', () => selectPavilion(card.dataset.pavilion as PavilionId)));
explodeButton?.addEventListener('click', () => setExploded(!exploded));
lowAngleButton?.addEventListener('click', () => setLowAngleView(activeView !== 'low-angle'));
resetButton?.addEventListener('click', () => {
  getPavilionAssemblyRuntime(activeModel)?.clearSelection();
  if (window.__CHINA_TOWERS_DIAGNOSTICS__) window.__CHINA_TOWERS_DIAGNOSTICS__.selectedPart = null;
  setExploded(false);
  setLowAngleView(false);
});
toggleDebugScreenshotButton?.addEventListener('click', async () => {
  try {
    const renderer = window.__CHINA_TOWERS_RENDERER__;
    const canvas = renderer?.domElement;
    if (!canvas) {
      if (status) status.textContent = '诊断截图失败 · 渲染器未就绪';
      return;
    }
    const dataUrl = canvas.toDataURL('image/png');
    const base64 = dataUrl.split(',')[1];
    const binary = Uint8Array.from(atob(base64), c => c.charCodeAt(0));
    const blob = new Blob([binary], { type: 'image/png' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${activeSpec.id}-diagnostic-${Date.now()}.png`;
    a.click();
    URL.revokeObjectURL(url);
    // 行内 status 提示替代 alert：不打断浏览，且随 aria-live 播报。
    if (status) status.textContent = '已保存诊断截图 · DIAGNOSTIC SNAPSHOT SAVED';
  } catch (e) {
    if (status) status.textContent = '诊断截图失败 · 见控制台';
    console.error('[diagnostic-screenshot]', e);
  }
});
window.addEventListener('keydown', (event) => {
  // 浏览器/系统组合键不归页面管：Ctrl+R、Cmd+P 之类不能误触发视角与面板。
  if (event.metaKey || event.ctrlKey || event.altKey) return;
  if (event.key >= '1' && event.key <= '3') {
    const spec = PAVILION_SPECS[Number(event.key) - 1];
    if (spec) selectPavilion(spec.id);
  }
  if (event.key.toLowerCase() === 'e') setExploded(!exploded);
  if (event.key.toLowerCase() === 'v') setLowAngleView(activeView !== 'low-angle');
  if (event.key.toLowerCase() === 'p') poetryPanel.toggle();
  if (event.key.toLowerCase() === 'd') toggleDebugScreenshotButton?.click();
  if (event.key === 'Escape') poetryPanel.setOpen(false);
  if (event.key.toLowerCase() === 'r') {
    getPavilionAssemblyRuntime(activeModel)?.clearSelection();
    if (window.__CHINA_TOWERS_DIAGNOSTICS__) window.__CHINA_TOWERS_DIAGNOSTICS__.selectedPart = null;
    setExploded(false);
    setLowAngleView(false);
  }
});
window.addEventListener('china-towers-model-ready', (event) => {
  if ((event as CustomEvent<string>).detail === activeSpec.id) {
    frameModel();
    window.__CHINA_TOWERS_READY__ = true;
    if (window.__CHINA_TOWERS_UI__) {
      window.__CHINA_TOWERS_UI__.setLoaderVisible(false);
    }
    // 样式表就绪后揭示延迟显示的 HUD (shell + 诗文面板), 避免裸样式闪现。
    requestAnimationFrame(() => {
      document.querySelector('[data-shell-deferred')?.removeAttribute('style');
      document.querySelector('[data-panel-deferred')?.removeAttribute('style');
    });
    if (window.__CHINA_TOWERS_DIAGNOSTICS__) {
      const assemblyRuntime = getPavilionAssemblyRuntime(activeModel);
      window.__CHINA_TOWERS_DIAGNOSTICS__.ready = true;
      window.__CHINA_TOWERS_DIAGNOSTICS__.modelName = String(activeModel?.name ?? window.__CHINA_TOWERS_DIAGNOSTICS__.modelName);
      window.__CHINA_TOWERS_DIAGNOSTICS__.runtimeLod = String(activeModel?.userData.runtimeLod ?? 'lod0');
      window.__CHINA_TOWERS_DIAGNOSTICS__.partCount = assemblyRuntime?.parts.length ?? 0;
      const degraded = Boolean(activeModel?.userData.highModelLoadError);
      window.__CHINA_TOWERS_DIAGNOSTICS__.loadError = degraded;
      window.__CHINA_TOWERS_DIAGNOSTICS__.degraded = degraded;
      window.__CHINA_TOWERS_DIAGNOSTICS__.failureReason = degraded
        ? String(activeModel?.userData.highModelLoadErrorReason ?? 'asset-load-failed')
        : null;
      window.__CHINA_TOWERS_DIAGNOSTICS__.assetState = degraded ? 'degraded' : 'ready';
      window.__CHINA_TOWERS_PARTS__ = assemblyRuntime?.parts.map(({ id, label, category }) => ({ id, label, category })) ?? [];
    }
    if (status) status.textContent = activeModel?.userData.highModelLoadError
      ? 'DEGRADED VIEW · HIGH MODEL ASSET UNAVAILABLE'
      : 'HIGH MODEL READY · ORBIT TO INSPECT';
  }
});

const raycaster = new THREE.Raycaster();
let pointerStart: { id: number; x: number; y: number; time: number } | null = null;

sceneCanvas.addEventListener('pointerdown', (event) => {
  pointerStart = { id: event.pointerId, x: event.clientX, y: event.clientY, time: performance.now() };
});

sceneCanvas.addEventListener('pointerup', (event) => {
  if (!pointerStart || pointerStart.id !== event.pointerId) return;
  const movement = Math.hypot(event.clientX - pointerStart.x, event.clientY - pointerStart.y);
  const duration = performance.now() - pointerStart.time;
  pointerStart = null;
  if (movement > 5 || duration > 650) return;
  const runtime = getPavilionAssemblyRuntime(activeModel);
  if (!runtime) return;
  const rect = sceneCanvas.getBoundingClientRect();
  const pointer = new THREE.Vector2(
    ((event.clientX - rect.left) / rect.width) * 2 - 1,
    -((event.clientY - rect.top) / rect.height) * 2 + 1,
  );
  raycaster.setFromCamera(pointer, camera);
  // Steles sit outside the assembly pick set; a hit opens the poetry drawer
  // on the stele's inscribed work instead of selecting a tower part.
  const steleHit = raycaster.intersectObjects(Object.values(steles).filter((stele) => stele.visible), true)[0];
  const steleRoot = steleHit ? findSteleRoot(steleHit.object) : null;
  if (steleRoot) {
    poetryPanel.showWork(steleRoot.userData.steleWorkIndex as number);
    if (status) status.textContent = 'POETRY · 碑刻原文已打开';
    return;
  }
  const hit = runtime.pick(raycaster.ray);
  const selected = runtime.selectObject(hit?.object ?? null);
  if (window.__CHINA_TOWERS_DIAGNOSTICS__) {
    window.__CHINA_TOWERS_DIAGNOSTICS__.selectedPart = selected?.id ?? null;
  }
  if (status) {
    status.textContent = selected
      ? `SELECTED · ${selected.label} · ${selected.id}`
      : 'HIGH MODEL READY · ORBIT TO INSPECT';
  }
});
window.addEventListener('china-towers-model-progress', (event) => {
  const detail = (event as CustomEvent<{ id: PavilionId; lod: string; ratio: number }>).detail;
  if (!detail || detail.id !== activeSpec.id) return;
  const percentage = detail.ratio > 0 ? `${Math.min(100, Math.round(detail.ratio * 100))}%` : '…';
  if (status) status.textContent = `LOADING ${detail.lod.toUpperCase()} · ${percentage}`;
  if (window.__CHINA_TOWERS_UI__) {
    window.__CHINA_TOWERS_UI__.setLoaderProgress(detail.ratio ?? 0, `LOADING ${detail.lod.toUpperCase()} · ${percentage}`);
  }
});

let lastFrameWidth = -1;
let lastFrameHeight = -1;

function resize() {
  const width = sceneCanvas.clientWidth;
  const height = sceneCanvas.clientHeight;
  // Early-out on unchanged size: setSize + composer.setSize every frame is
  // wasted work (and stalls on some drivers via implicit glViewport churn).
  if (width === lastFrameWidth && height === lastFrameHeight) return;
  lastFrameWidth = width;
  lastFrameHeight = height;
  renderer.setSize(width, height, false);
  postStack?.setSize(width, height);
  camera.aspect = width / Math.max(1, height);
  camera.updateProjectionMatrix();
}

const renderClock = new THREE.Clock();

function render() {
  resize();
  controls.update();
  updateCueFlight();
  constrainInspectionCamera();
  // The composer runs several internal passes (water reflection, bloom), and
  // info.autoReset would otherwise zero the counters after every pass, leaving
  // diagnostics with just the final bloom quad. Reset once per frame instead.
  if (postStack) {
    renderer.info.autoReset = false;
    renderer.info.reset();
  }
  const frameDelta = renderClock.getDelta();
  poeticEnvironment.update(frameDelta, camera);
  atmosphere.update(frameDelta, performance.now() / 1000, camera);
  // Key light eases toward the active cue's mood sun, or back to the tower's
  // base sun when no cue is active; hemisphere fill takes the mood ambient.
  const sunBase = TOWER_SUN_PRESETS[activeSpec.id];
  const sunTarget = sunMood ?? { color: sunBase.color, intensity: sunBase.intensity * 0.88, ambient: '#b9cfe4', ambientIntensity: 0.28 };
  const sunBlend = 1 - Math.exp(-frameDelta * 2.2);
  sunKey.color.lerp(sunTmpColor.set(sunTarget.color), sunBlend);
  sunKey.intensity += (sunTarget.intensity - sunKey.intensity) * sunBlend;
  // No motion-gated passes. God rays used to fade out while the camera moved;
  // that coupled the frame's brightness to whether the user's hand was moving,
  // and a hand drag is a series of pushes and pauses — so the sky pumped under
  // the user's fingers. The mask is quarter-res and depth-only, so it just
  // runs every frame like the water mirror does.
  const hemi = lightRig.children.find((child): child is THREE.HemisphereLight => child instanceof THREE.HemisphereLight) ?? null;
  if (hemi) {
    hemi.color.lerp(ambientTmpColor.set(sunTarget.ambient), sunBlend);
    hemi.intensity += (sunTarget.ambientIntensity - hemi.intensity) * sunBlend;
  }
  if (postStack) postStack.render();
  else renderer.render(scene, camera);
  const assemblyRuntime = getPavilionAssemblyRuntime(activeModel);
  if (assemblyRuntime && Math.abs(explodedTarget - explodedAmount) > 0.001) {
    explodedAmount = THREE.MathUtils.lerp(explodedAmount, explodedTarget, 0.14);
    if (Math.abs(explodedTarget - explodedAmount) < 0.002) explodedAmount = explodedTarget;
    assemblyRuntime.setExploded(explodedAmount);
  }
  if (window.__CHINA_TOWERS_DIAGNOSTICS__) {
    window.__CHINA_TOWERS_DIAGNOSTICS__.explodedAmount = assemblyRuntime?.explodedAmount ?? 0;
  }
  if (debugLoop && activeSpec.id === 'tengwang') {
    console.log('[Tengwang] render loop active, diagnostics ready:', !!window.__CHINA_TOWERS_DIAGNOSTICS__?.ready, 'model:', activeModel?.name, 'children:', activeModel?.children.length);
  }
  if (window.__CHINA_TOWERS_DIAGNOSTICS__) {
    window.__CHINA_TOWERS_DIAGNOSTICS__.renderCalls = renderer.info.render.calls;
    window.__CHINA_TOWERS_DIAGNOSTICS__.renderTriangles = renderer.info.render.triangles;
    // toArray writes into the existing arrays — no per-frame allocation.
    camera.position.toArray(window.__CHINA_TOWERS_DIAGNOSTICS__.cameraPosition);
    controls.target.toArray(window.__CHINA_TOWERS_DIAGNOSTICS__.cameraTarget);
    window.__CHINA_TOWERS_DIAGNOSTICS__.cameraFov = camera.fov;
  }
  // Debug only (?debug=1): per-frame scene state ring for flicker forensics.
  // Correlates composited-pixel dips with the renderer's actual state on that
  // exact frame (background, fog, exposure, lights, near/far, post stack).
  if (debugLoop) {
    const w = window as unknown as { __SCENE_STATE_RING__?: Record<string, unknown>[] };
    const ring = (w.__SCENE_STATE_RING__ ??= []);
    const bg = scene.background;
    ring.push({
      t: performance.now(),
      calls: renderer.info.render.calls,
      tris: renderer.info.render.triangles,
      bg: bg ? ('isTexture' in bg ? 'hdri' : `color#${bg.getHexString()}`) : 'null',
      bgIntensity: scene.backgroundIntensity,
      envIntensity: scene.environmentIntensity,
      exposure: renderer.toneMappingExposure,
      fog: scene.fog ? `${scene.fog.color.getHexString()}/${('density' in scene.fog ? scene.fog.density : -1).toFixed(4)}` : 'null',
      near: camera.near,
      far: camera.far,
      camY: camera.position.y,
      post: postStack ? 'on' : 'off',
      water: poeticEnvironment.root.getObjectByName('poetic-river-or-lake')?.visible ? 'on' : 'off',
      ranges: poeticEnvironment.root.getObjectByName('distant-ranges')?.visible ? 'on' : 'off',
    });
    if (ring.length > 4000) ring.shift();
  }
  // Debug only (?debug=1): sample center pixel from the renderer to verify
  // visibility. readPixels stalls the GPU pipeline and must never run per-frame.
  if (debugLoop && activeSpec.id === 'tengwang' && renderer.info.render.calls > 0) {
    try {
      const gl = renderer.getContext();
      const pixels = new Uint8Array(4);
      gl.readPixels(Math.floor(sceneCanvas.width / 2), Math.floor(sceneCanvas.height / 2), 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, pixels);
      console.log('[Tengwang] center pixel:', Array.from(pixels).join(', '));
    } catch (e) {
      // ignore readPixels failures in some browsers
    }
  }
  if (window.__CHINA_TOWERS_UI__ && window.__CHINA_TOWERS_DIAGNOSTICS__?.ready) {
    window.__CHINA_TOWERS_UI__.setModelMeta({
      modelName: window.__CHINA_TOWERS_DIAGNOSTICS__.modelName,
      runtimeLod: window.__CHINA_TOWERS_DIAGNOSTICS__.runtimeLod,
      renderTriangles: window.__CHINA_TOWERS_DIAGNOSTICS__.renderTriangles,
      partCount: window.__CHINA_TOWERS_DIAGNOSTICS__.partCount,
    });
  }
  const loadingHighModel = HIGH_MODEL_IDS.has(activeSpec.id);
  if (!loadingHighModel || activeModel?.userData.highModelReady || activeModel?.userData.highModelLoadError) {
    window.__CHINA_TOWERS_READY__ = true;
    if (window.__CHINA_TOWERS_DIAGNOSTICS__) {
      window.__CHINA_TOWERS_DIAGNOSTICS__.ready = true;
      window.__CHINA_TOWERS_DIAGNOSTICS__.loadError = Boolean(activeModel?.userData.highModelLoadError);
      window.__CHINA_TOWERS_DIAGNOSTICS__.degraded = Boolean(activeModel?.userData.highModelLoadError);
      window.__CHINA_TOWERS_DIAGNOSTICS__.failureReason = activeModel?.userData.highModelLoadError
        ? String(activeModel?.userData.highModelLoadErrorReason ?? 'asset-load-failed')
        : null;
      window.__CHINA_TOWERS_DIAGNOSTICS__.assetState = activeModel?.userData.highModelLoadError ? 'degraded' : 'ready';
    }
  }
  requestAnimationFrame(render);
}

const requestedPavilion = new URLSearchParams(window.location.search).get('pavilion');
const initialPavilion = PAVILION_SPECS.find((spec) => spec.id === requestedPavilion)?.id ?? 'yueyang';
if (requestedPavilion === 'guanque') console.info('鹳雀楼已从 V3 产品范围移除，已切换到岳阳楼。');
selectPavilion(initialPavilion);
render();
