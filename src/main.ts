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
import { detectDeviceQualityProfile, createAdaptiveGovernor } from './runtime/DeviceQualityProfile';
import type { PavilionModelLoadOptions } from './runtime/loadVerifiedGlb';
import { getPavilionAssemblyRuntime } from './runtime/PavilionAssemblyRuntime';

// 启动报错显形: 顶层初始化(WebGL/环境/面板)一旦抛错, 原先只会永远转圈。
// 这里把首个错误写进 loader 状态行, 卡住时一眼可见原因。
function showBootError(message: string, detail?: unknown): void {
  const loaderStatus = document.getElementById('loader-status');
  if (loaderStatus) loaderStatus.textContent = message;
  console.error('[boot]', message, detail ?? '');
}
window.addEventListener('error', (event) => {
  if (window.__CHINA_TOWERS_READY__) return;
  const msg = event.message || '未知错误';
  showBootError(`启动受阻 · ${String(msg).slice(0, 60)} · 请截图控制台发我`);
});
window.addEventListener('unhandledrejection', (event) => {
  if (window.__CHINA_TOWERS_READY__) return;
  const reason = event.reason instanceof Error ? event.reason.message : String(event.reason ?? '');
  showBootError(`资源加载受阻 · ${reason.slice(0, 60)} · 请截图控制台发我`);
});

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
      // 自适应降载档位（0=满载，见 DeviceQualityProfile governor）。
      adaptiveLevel: number;
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
const seal = document.querySelector<HTMLElement>('#tower-seal');
const english = document.querySelector<HTMLElement>('#tower-english');
const location = document.querySelector<HTMLElement>('#tower-location');
const description = document.querySelector<HTMLElement>('#tower-description');
const status = document.querySelector<HTMLElement>('#status');
const cards = [...document.querySelectorAll<HTMLButtonElement>('[data-pavilion]')];
const explodeButton = document.querySelector<HTMLButtonElement>('#explode');
const toggleDebugScreenshotButton = document.querySelector<HTMLButtonElement>('#toggle-debug-screenshot');
const lowAngleButton = document.querySelector<HTMLButtonElement>('#low-angle');
const resetButton = document.querySelector<HTMLButtonElement>('#reset-view');
const reviewParams = new URLSearchParams(window.location.search);

// 状态行文案统一中文为主（界面其余文字全中文，状态行原先混着英文大写标签）。
const STATUS_IDLE = '高模就绪 · 拖拽检视';
const reviewView = reviewParams.get('view');
const requestedLightMode = reviewParams.get('light');
const noShadow = reviewParams.get('noshadow') === '1';
const hideGLB = reviewParams.get('hideglb') === '1';
const debugLoop = reviewParams.get('debug') === '1';
const lightMode: 'neutral' | 'grazing' | 'reference' = requestedLightMode === 'neutral' || requestedLightMode === 'grazing'
  ? requestedLightMode
  : 'reference';

const deviceQuality = detectDeviceQualityProfile();
let renderer: THREE.WebGLRenderer;
try {
  renderer = new THREE.WebGLRenderer({
    canvas: sceneCanvas,
    antialias: deviceQuality.id !== 'mobile',
    alpha: false,
    powerPreference: 'high-performance',
    logarithmicDepthBuffer: true,
  });
} catch (error) {
  // 无 WebGL 的机器(远程桌面/旧驱动/被禁用的 GPU) previously 卡死转圈:
  // 直接说明原因, 不再静默。
  showBootError('WebGL 初始化失败 · 请换 Chrome/Edge 并开启硬件加速后重试', error);
  throw error;
}
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

// 运行时自适应：加载定档之后，帧率说了算。慢窗口逐级降载
//（DPR→bloom→godrays→DPR），快窗口带迟滞回升；`?noadapt=1` 旁路保探针确定性。
const adaptiveGovernor = createAdaptiveGovernor({
  bloomAvailable: deviceQuality.id !== 'mobile' && reviewParams.get('nobloom') !== '1',
  godRaysAvailable: deviceQuality.id !== 'mobile' && reviewParams.get('norays') !== '1',
  onLevel: (state) => {
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, deviceQuality.pixelRatioCap * state.pixelRatioScale));
    // DPR 换了绘制缓冲尺寸必须跟上：逐帧 resize 按 CSS 尺寸早退，
    // 看不到 pixelRatio 变化，这里手动推一次。
    renderer.setSize(sceneCanvas.clientWidth, sceneCanvas.clientHeight, false);
    postStack?.setSize(sceneCanvas.clientWidth, sceneCanvas.clientHeight);
    postStack?.setBloomEnabled(state.bloomOn);
    postStack?.setGodRaysEnabled(state.godRaysOn);
    (window as unknown as { __ADAPTIVE_LEVEL__?: number }).__ADAPTIVE_LEVEL__ = state.level;
    if (window.__CHINA_TOWERS_DIAGNOSTICS__) {
      window.__CHINA_TOWERS_DIAGNOSTICS__.adaptiveLevel = state.level;
      window.__CHINA_TOWERS_DIAGNOSTICS__.appliedPixelRatio = renderer.getPixelRatio();
    }
    // 状态行不碰：诗境机位/仰视等状态文案优先，档位只进 diagnostics，
    // 探针读数，界面不添乱。
  },
});

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
// 碰撞外壳与包络跨度随 safetyBounds 一起在 frameModel 里 baked:
/// 热循环里不再 clone()/getSize()/new 数组, 零分配。
let cameraCollisionBounds: THREE.Box3 | null = null;
let cameraSafetySpan = 1;
let cameraGroundY = 0;
let cameraClearance = 0.35;
// 热循环 scratch: 约束推挤 / 飞行插值 / 漂移步进共用, 逐帧零 new。
const constrainScratch = new THREE.Vector3();
const flightScratchA = new THREE.Vector3();
const flightScratchB = new THREE.Vector3();

const HIGH_MODEL_IDS = new Set<PavilionId>(['yueyang', 'huanghe', 'tengwang']);

type PavilionFactory = (options?: PavilionModelLoadOptions) => THREE.Group;

function frameModel(view = activeView) {
  if (!activeModel) return;
  const lowAngleActive = view === 'low-angle';
  lowAngleButton?.setAttribute('aria-pressed', String(lowAngleActive));
  if (lowAngleButton) lowAngleButton.innerHTML = lowAngleActive ? '退出仰视 <kbd>V</kbd>' : '仰视建筑 <kbd>V</kbd>';
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
  cameraCollisionBounds = bounds.clone().expandByScalar(cameraClearance);
  cameraSafetySpan = bounds.getSize(new THREE.Vector3()).length();
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
    // 2026-09 实测修正: targetLift 0.5 把视点钉在屋顶、塔身被压出画底,
    // NDC 中心 y=-0.8。降到 0.04 让塔居中、水面作前景, 相机高度同步回落。
    const camHeight = activeSpec.id === 'huanghe' ? 0.32 : 0.34;
    camera.position.set(
      centre.x + Math.sin(defaultAzimuth) * distance * 1.16,
      centre.y + distance * camHeight,
      centre.z + Math.cos(defaultAzimuth) * distance * 1.16,
    );
    // The tengwang podium is wide and low relative to the tower, so the
    // default target needs more lift to keep the roof crown in frame;
    // huanghe keeps the target near mid-tower so the whole body (not just
    // the roof) sits in frame with water as foreground (NDC 中心 -0.43 仍踩底:
    // 视点高于塔心 4.6m, 再降到 0.04; 岳阳同理 0.14→0.08)。
    const targetLift = activeSpec.id === 'tengwang' ? 0.2 : activeSpec.id === 'huanghe' ? 0.04 : activeSpec.id === 'yueyang' ? 0.02 : 0.14;
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
    constrainScratch.copy(camera.position).sub(obstacle.center);
    const distance = constrainScratch.length();
    const clearance = obstacle.radius + Math.max(cameraClearance, 0.6);
    if (distance >= clearance) continue;
    if (distance < 1e-4) {
      camera.position.x = obstacle.center.x + clearance;
      continue;
    }
    camera.position.copy(obstacle.center).addScaledVector(constrainScratch.divideScalar(distance), clearance);
    if (camera.position.y < minimumY) camera.position.y = minimumY;
  }
  if (activeSpec.id === 'tengwang') return;

  // 零分配版 soft push: 原 exits 数组 + sort 每帧 new 5 个对象, 改手动取最小。
  const collisionBounds = cameraCollisionBounds ?? cameraSafetyBounds;
  if (collisionBounds.containsPoint(camera.position)) {
    let exitAxis: 'x' | 'z' = 'x';
    let exitValue = collisionBounds.min.x;
    let exitDistance = Math.abs(camera.position.x - exitValue);
    const testExit = (axis: 'x' | 'z', value: number, at: number): void => {
      const candidate = Math.abs(at - value);
      if (candidate < exitDistance) {
        exitDistance = candidate;
        exitAxis = axis;
        exitValue = value;
      }
    };
    // 注: testExit 闭包每帧分配一次(单个函数对象), 相对原 5 对象+排序可忽略;
    // 若需绝对零分配可继续内联展开。
    testExit('x', collisionBounds.max.x, camera.position.x);
    testExit('z', collisionBounds.min.z, camera.position.z);
    testExit('z', collisionBounds.max.z, camera.position.z);
    if (exitDistance < 0.05) {
      camera.position[exitAxis] = exitValue;
    } else {
      const factor = 0.25;
      camera.position[exitAxis] = THREE.MathUtils.lerp(
        camera.position[exitAxis],
        exitValue,
        factor
      );
    }
  }

  const distanceToModel = cameraSafetyBounds.distanceToPoint(camera.position);
  const desiredNear = THREE.MathUtils.clamp(distanceToModel * 0.08, 0.03, Math.max(0.08, cameraSafetySpan / 100));
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
  // 仰视与诗境互斥: 进仰视先清诗境(氛围/漂移/诗句卡/焦距), 否则残留暮色与长焦。
  cancelCueFlight();
  hideSceneReading();
  activeView = enabled ? 'low-angle' : 'default';
  lowAngleButton?.setAttribute('aria-pressed', String(enabled));
  if (lowAngleButton) lowAngleButton.innerHTML = enabled ? '退出仰视 <kbd>V</kbd>' : '仰视建筑 <kbd>V</kbd>';
  frameModel(activeView);
  if (status) status.textContent = enabled
    ? '仰视模式 · 拖拽观察檐下与牌匾'
    : STATUS_IDLE;
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
  if (explodeButton) explodeButton.innerHTML = next ? '收拢构件 <kbd>E</kbd>' : '展开构件 <kbd>E</kbd>';
  explodeButton?.setAttribute('aria-pressed', String(next));
  if (status) status.textContent = next ? '构件展开 · 旋转查看层次' : STATUS_IDLE;
}

const SEAL_TEXT: Record<string, string> = { yueyang: '岳陽', huanghe: '黃鶴', tengwang: '滕王' };
function updateCopy(spec: PavilionSpec) {
  document.documentElement.style.setProperty('--accent', spec.accent);
  if (title) title.textContent = spec.nameCN;
  if (seal) seal.textContent = SEAL_TEXT[spec.id] ?? spec.nameCN;
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
  midPos: THREE.Vector3;
  fromTarget: THREE.Vector3;
  midTarget: THREE.Vector3;
  toTarget: THREE.Vector3;
  fromFov: number;
  toFov: number;
  drift: THREE.Vector3;
  start: number;
  duration: number;
};

let cueFlight: CueFlight | null = null;
let cueHold: { drift: THREE.Vector3; settledAt: number } | null = null;
let activeCueId: string | null = null;
// 落幅漂移的帧间隔提示与锚点(防漂移失控), 由 render() 每帧刷新。
let renderDeltaHint = 0.016;
const holdAnchorPos = new THREE.Vector3();
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

const READING_AUTOHIDE_MS = 10000;
function armReadingAutohide(ms: number = READING_AUTOHIDE_MS): void {
  if (readingTimer !== null) window.clearTimeout(readingTimer);
  readingTimer = window.setTimeout(hideSceneReading, ms);
}

function showSceneReading(cue: SceneCue): void {
  if (!readingPanel || !readingTitle || !readingLine || !readingObservation) return;
  readingTitle.textContent = cue.title;
  readingLine.textContent = `「${cue.line}」`;
  const shotEl = document.querySelector<HTMLElement>('#reading-shot');
  if (shotEl) {
    shotEl.textContent = cue.shot ? `◈ 运镜 · ${cue.shot}` : '';
    shotEl.hidden = !cue.shot;
  }
  readingObservation.textContent = `${cue.observation}`;
  readingPanel.classList.add('is-visible');
  armReadingAutohide(14000);
}

// 诗句卡手动收起 + 悬停暂留: 关闭按钮立收; 鼠标停在卡上时不自动消失,
// 移开后给 4 秒宽限再收。
document.getElementById('reading-close')?.addEventListener('click', hideSceneReading);
readingPanel?.addEventListener('mouseenter', () => {
  if (readingTimer !== null) {
    window.clearTimeout(readingTimer);
    readingTimer = null;
  }
});
readingPanel?.addEventListener('mouseleave', () => {
  if (readingPanel.classList.contains('is-visible')) armReadingAutohide(4000);
});

function buildCueButtons(): void {
  if (!cueButtonsContainer) return;
  cueButtonsContainer.innerHTML = '';
  const cues = getSceneSpec(activeSpec.id).cues;
  cues.forEach((cue, index) => {
    const button = document.createElement('button');
    button.type = 'button';
    button.dataset.cue = cue.id;
    const numeral = ['壹', '贰', '叁'][index] ?? String(index + 1);
    button.innerHTML = `<i>${numeral} · ${cue.title}</i><span>${cue.line}</span>`;
    button.setAttribute('aria-label', `诗境机位${numeral} · ${cue.title} · ${cue.line} · ${cue.shot ?? ''}`);
    button.title = cue.shot ? `${cue.line} —— ${cue.shot}` : cue.line;
    button.addEventListener('click', () => flyToCue(cue));
    cueButtonsContainer.appendChild(button);
  });
  markActiveCueButton();
}

function markActiveCueButton(): void {
  if (!cueButtonsContainer) return;
  for (const btn of cueButtonsContainer.querySelectorAll<HTMLButtonElement>('button[data-cue]')) {
    const on = btn.dataset.cue === activeCueId;
    btn.classList.toggle('is-active', on);
    btn.setAttribute('aria-pressed', String(on));
  }
}

function flyToCue(cue: SceneCue): void {
  const toPos = new THREE.Vector3(...cue.camera.position);
  const toTarget = new THREE.Vector3(...cue.camera.target);
  const fromPos = camera.position.clone();
  const fromTarget = controls.target.clone();
  // 意象构图: 只在“看出去”的镜位(水/天/台)向太阳方位横移, 让日轮霞光
  // 入画、主阁偏居一侧; 看塔看阶的镜位保持中轴, 横移只会把塔推出画外
  // (2026-09 实测: 6m 横移把 31m 塔顶出 NDC 18 个单位)。
  const preset = TOWER_SUN_PRESETS[activeSpec.id];
  const sunFlat = new THREE.Vector3(preset.direction[0], 0, preset.direction[2]).normalize();
  const lateral = new THREE.Vector3(-sunFlat.z, 0, sunFlat.x);
  const camDistance = toPos.distanceTo(toTarget);
  const isWaterCue = cue.focus === 'water' || cue.focus === 'horizon';
  const composesLandscape = cue.focus === 'water' || cue.focus === 'horizon' || cue.focus === 'platform';
  const frameShift = composesLandscape
    ? (cue.mood.name === 'clearDay' ? 1.8 : 4) * THREE.MathUtils.clamp(camDistance / 40, 0.35, 1.1)
    : 0;
  toPos.addScaledVector(lateral, frameShift);
  toTarget.addScaledVector(lateral, frameShift * 0.55);
  // 电影弧线: 中点抬升 + 侧弯, 飞行先扬后落, 不再是直线穿楼。
  const dist = fromPos.distanceTo(toPos);
  const lift = THREE.MathUtils.clamp(dist * 0.1, 1.2, 5);
  const midPos = fromPos.clone().lerp(toPos, 0.5);
  midPos.y += lift;
  midPos.addScaledVector(lateral, -frameShift * 0.25);
  const midTarget = fromTarget.clone().lerp(toTarget, 0.5);
  midTarget.y += lift * 0.3;
  const toFov = cue.camera.fov ?? 42;
  cueFlight = {
    fromPos,
    toPos,
    midPos,
    fromTarget,
    midTarget,
    toTarget,
    fromFov: (camera as THREE.PerspectiveCamera).fov,
    toFov,
    drift: new THREE.Vector3(...(cue.drift ?? [0, 0, 0])),
    start: performance.now(),
    // 按距离定长: 近景 2.4s, 远景 3.4s, 意境需要呼吸感。
    duration: THREE.MathUtils.clamp(2100 + dist * 22, 2400, 3400),
  };
  cueHold = null;
  activeCueId = cue.id;
  markActiveCueButton();
  document.body.classList.add('in-cue');
  controls.enabled = false;
  controls.autoRotate = false;
  poeticEnvironment.setMood(cue.mood);
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
  // Grade bias per cue mood: dawn lifts cool and bright, autumn dusk (and the
  // deeper 落霞 dusk) sinks warm and dark — the difference between 晨雾 and 落霞.
  postStack?.setMoodBias(
    cue.mood.name === 'dawn'
      ? { tint: [0.98, 1.0, 1.04], exposure: 0.02 }
      : cue.mood.name === 'autumnDusk' || cue.mood.name === 'deepDusk'
        ? { tint: [1.09, 0.95, 0.86], exposure: isWaterCue ? -0.06 : -0.04 }
        : cue.focus === 'tower'
          ? { tint: [1.0, 1.0, 1.02], exposure: 0.02 }
          : { tint: [1.0, 1.0, 1.0], exposure: 0.015 },
  );
  showSceneReading(cue);
  if (status) status.textContent = `诗境机位 · ${cue.title} · ${cue.line}`;
}

function cancelCueFlight(): void {
  if (!cueFlight && !sunMood && !cueHold) return;
  cueFlight = null;
  cueHold = null;
  activeCueId = null;
  markActiveCueButton();
  document.body.classList.remove('in-cue');
  // 落幅焦距回正: 诗境长焦/广角不带回日常检视。
  const persp = camera as THREE.PerspectiveCamera;
  if (Math.abs(persp.fov - 42) > 0.1) {
    persp.fov = 42;
    persp.updateProjectionMatrix();
  }
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
  if (cueFlight) {
    const progress = Math.min(1, (performance.now() - cueFlight.start) / cueFlight.duration);
    const eased = easeInOutCubic(progress);
    // 二次贝塞尔弧线飞行: 起→中→落, 中点抬升带来“先扬后落”的呼吸。
    // scratch 复用, 一帧零 new (原 4 次 clone)。
    flightScratchA.copy(cueFlight.fromPos).lerp(cueFlight.midPos, eased);
    flightScratchB.copy(cueFlight.midPos).lerp(cueFlight.toPos, eased);
    camera.position.copy(flightScratchA.lerp(flightScratchB, eased));
    flightScratchA.copy(cueFlight.fromTarget).lerp(cueFlight.midTarget, eased);
    flightScratchB.copy(cueFlight.midTarget).lerp(cueFlight.toTarget, eased);
    controls.target.copy(flightScratchA.lerp(flightScratchB, eased));
    // 诗境运镜期间相机朝向由本系统接管: 每帧显式 lookAt, 不把朝向留给
    // OrbitControls 的阻尼/限位做“二次解释”(2026-09 实测: 落幅视线偏 33°,
    // 塔被甩出画外)。用户拖拽即 cancel, 之后朝向归还 controls。
    camera.lookAt(controls.target);
    // 焦距同步呼吸: 广角铺陈与长焦压缩在飞行中渐入, 落幅即定调。
    const persp = camera as THREE.PerspectiveCamera;
    persp.fov = THREE.MathUtils.lerp(cueFlight.fromFov, cueFlight.toFov, eased);
    persp.updateProjectionMatrix();
    if (progress >= 1) {
      cueHold = { drift: cueFlight.drift.clone(), settledAt: performance.now() };
      holdAnchorPos.copy(cueFlight.toPos);
      cueFlight = null;
      controls.enabled = true;
      // 落幅后保持可交互: 用户可微调, 漂移在后台轻推, 一碰即停(见 pointerdown)。
    }
    return;
  }
  // 落幅漂移: 推/横移/上升三选一 + 正弦呼吸, 幅度克制(≤0.6m/4s), 构图不散。
  if (cueHold && controls.enabled) {
    const dt = Math.min(0.05, Math.max(0.001, renderDeltaHint || 0.016));
    const t = (performance.now() - cueHold.settledAt) / 1000;
    const breathe = 1 + Math.sin(t * 0.5) * 0.15;
    flightScratchA.copy(cueHold.drift).multiplyScalar(dt * breathe);
    // 漂移限幅: 离落幅点超过 3.5m 即停, 防止推进楼里或水里。
    if (camera.position.distanceTo(holdAnchorPos) < 3.5) {
      camera.position.add(flightScratchA);
      controls.target.addScaledVector(flightScratchA, 0.82);
      camera.lookAt(controls.target);
    }
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
    adaptiveLevel: 0,
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
  if (status) status.textContent = HIGH_MODEL_IDS.has(spec.id) ? '已验证高模 · 加载中…' : STATUS_IDLE;
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
    if (status) status.textContent = '已验证高模 · 加载中…';
    if (window.__CHINA_TOWERS_UI__) {
      window.__CHINA_TOWERS_UI__.setLoaderVisible(true);
      window.__CHINA_TOWERS_UI__.setLoaderProgress(0, '已验证高模 · 加载中…');
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
      adaptiveLevel: 0,
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
      if (status) status.textContent = '高模资产缺失 · 已降级显示';
    }
    console.error(`Failed to load pavilion module: ${spec.id}`, error);
  }
}

cards.forEach((card) => card.addEventListener('click', () => selectPavilion(card.dataset.pavilion as PavilionId)));
explodeButton?.addEventListener('click', () => setExploded(!exploded));
lowAngleButton?.addEventListener('click', () => setLowAngleView(activeView !== 'low-angle'));
function resetInspection(): void {
  // 重置 = 全部回到楼的默认态: 诗境机位的 mood/自动缓转/诗句卡一并取消,
  // 否则相机回了默认位, 氛围却停在诗境里 (实测 R 键残留 mood 的缺陷)。
  cancelCueFlight();
  hideSceneReading();
  getPavilionAssemblyRuntime(activeModel)?.clearSelection();
  if (window.__CHINA_TOWERS_DIAGNOSTICS__) window.__CHINA_TOWERS_DIAGNOSTICS__.selectedPart = null;
  setExploded(false);
  setLowAngleView(false);
}
resetButton?.addEventListener('click', resetInspection);
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
    if (status) status.textContent = '诊断截图已保存';
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
    resetInspection();
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
      ? '高模资产缺失 · 已降级显示'
      : STATUS_IDLE;
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
    if (status) status.textContent = '碑刻原文 · 已在诗文面板打开';
    return;
  }
  const hit = runtime.pick(raycaster.ray);
  const selected = runtime.selectObject(hit?.object ?? null);
  if (window.__CHINA_TOWERS_DIAGNOSTICS__) {
    window.__CHINA_TOWERS_DIAGNOSTICS__.selectedPart = selected?.id ?? null;
  }
  if (status) {
    status.textContent = selected
      ? `已选构件 · ${selected.label} · ${selected.id}`
      : STATUS_IDLE;
  }
});
window.addEventListener('china-towers-model-progress', (event) => {
  const detail = (event as CustomEvent<{ id: PavilionId; lod: string; ratio: number }>).detail;
  if (!detail || detail.id !== activeSpec.id) return;
  const percentage = detail.ratio > 0 ? `${Math.min(100, Math.round(detail.ratio * 100))}%` : '…';
  if (status) status.textContent = `高模加载 ${detail.lod.toUpperCase()} · ${percentage}`;
  if (window.__CHINA_TOWERS_UI__) {
    window.__CHINA_TOWERS_UI__.setLoaderProgress(detail.ratio ?? 0, `高模加载 ${detail.lod.toUpperCase()} · ${percentage}`);
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
  renderDeltaHint = frameDelta;
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
  // 自适应 governor 吃帧间隔（含 composer 全开销），判决下一帧档位。
  // frameDelta 取自本帧开头（上一帧到本帧的真实间隔），正是要的负载信号。
  adaptiveGovernor.update(frameDelta * 1000);
  if (window.__CHINA_TOWERS_DIAGNOSTICS__) {
    window.__CHINA_TOWERS_DIAGNOSTICS__.adaptiveLevel = adaptiveGovernor.level;
  }
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
  // 诊断读数保留在 window 对象供探针读取, 不再上墙显示。
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
