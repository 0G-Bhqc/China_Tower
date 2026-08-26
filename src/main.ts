import './style.css';
import * as THREE from 'three';
import {
  configureYueyangTowerRenderer,
  createYueyangTowerEnvironment,
  createYueyangTowerInspectControls,
  createYueyangTowerLookDevLights,
} from './createYueyangTowerStructuralModel';
import {
  createPavilionStudyModel,
  disposePavilionModel,
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
renderer.toneMappingExposure = deviceQuality.toneMappingExposure;
renderer.setPixelRatio(Math.min(window.devicePixelRatio, deviceQuality.pixelRatioCap));

const scene = new THREE.Scene();
scene.background = new THREE.Color('#6b7280');
scene.fog = new THREE.FogExp2('#6b7280', 0.007);
scene.environment = createYueyangTowerEnvironment(renderer);
scene.environmentIntensity = deviceQuality.environmentIntensity;
const lightRig = createYueyangTowerLookDevLights(lightMode);
scene.add(lightRig);
const sunKey = lightRig.getObjectByName('sun-key') as THREE.DirectionalLight;
sunKey.shadow.mapSize.set(deviceQuality.shadowMapSize, deviceQuality.shadowMapSize);
sunKey.shadow.radius = deviceQuality.shadowRadius;
sunKey.shadow.blurSamples = deviceQuality.shadowBlurSamples;
sunKey.shadow.bias = -0.00025;
sunKey.shadow.normalBias = 0.03;
sunKey.shadow.mapSize.set(2048, 2048);
scene.add(sunKey.target);

const ground = new THREE.Mesh(
  new THREE.CircleGeometry(52, 96),
  new THREE.MeshStandardMaterial({ color: '#a49c8d', roughness: 0.98, metalness: 0, depthWrite: true }),
);
ground.rotation.x = -Math.PI / 2;
ground.position.y = -0.05; // Sink 5 cm so the ground never coincides with pavilion base slabs
// Receive shadows: without a contact shadow every pavilion reads as floating
// in the air. The positive polygonOffset below only biases depth ordering;
// shadow reception is unaffected by it.
ground.receiveShadow = true;
// Extreme positive polygonOffset guarantees the ground renders strictly behind
// any pavilion foundation geometry, even when that geometry also applies its
// own (negative) polygonOffset.  Combined with the 5 cm y-sink, z-fighting
// between ground and base becomes structurally impossible.
(ground.material as THREE.MeshStandardMaterial).polygonOffset = true;
(ground.material as THREE.MeshStandardMaterial).polygonOffsetFactor = 50;
(ground.material as THREE.MeshStandardMaterial).polygonOffsetUnits = 100;
(ground.material as THREE.MeshStandardMaterial).depthFunc = THREE.LessEqualDepth;
ground.renderOrder = -1; // Render first, write depth, never overwritten
scene.add(ground);

const camera = new THREE.PerspectiveCamera(42, 1, 0.1, 180);
const controls = createYueyangTowerInspectControls(camera, sceneCanvas);
controls.enableDamping = true;
controls.dampingFactor = 0.075;
controls.minPolarAngle = Math.PI * 0.08;
controls.maxPolarAngle = Math.PI * 0.68;
controls.enablePan = true;

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
  cameraGroundY = Math.max(ground.position.y, bounds.min.y);
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
    // The tengwang podium is wide and low relative to the tower, so the
    // default target needs more lift to keep the roof crown in frame.
    const targetLift = activeSpec.id === 'tengwang' ? 0.16 : 0.06;
    camera.position.set(centre.x + distance * 0.82, centre.y + distance * 0.54, centre.z + distance * 0.82);
    controls.target.copy(centre).add(new THREE.Vector3(0, size.y * targetLift, 0));
  }
  camera.near = view === 'low-angle'
    ? THREE.MathUtils.clamp(span / 500, 0.03, 0.12)
    : Math.max(0.1, span / 100);
  camera.far = Math.max(180, span * 12);
  camera.updateProjectionMatrix();
  const shadowExtent = Math.max(12, span * 0.78);
  sunKey.position.copy(centre).add(new THREE.Vector3(-span * 0.72, span * 1.08, span * 0.66));
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
  if (activeSpec.id === 'tengwang') return;
  const minimumY = cameraGroundY + cameraClearance;
  if (camera.position.y < minimumY) camera.position.y = minimumY;

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
  if (Math.abs(camera.near - desiredNear) > 0.01) {
    camera.near = desiredNear;
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
    disposePavilionModel(activeModel);
  }
  activeSpec = spec;
  window.__CHINA_TOWERS_READY__ = false;
  updateCopy(spec);
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
      disposePavilionModel(loadingFallback);
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
      alert('No renderer canvas available');
      return;
    }
    const dataUrl = canvas.toDataURL('image/png');
    const base64 = dataUrl.split(',')[1];
    const binary = Uint8Array.from(atob(base64), c => c.charCodeAt(0));
    const blob = new Blob([binary], { type: 'image/png' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `tengwang-debug-${Date.now()}.png`;
    a.click();
    URL.revokeObjectURL(url);
    alert('Debug screenshot saved');
  } catch (e) {
    alert('Screenshot failed: ' + e);
  }
});
window.addEventListener('keydown', (event) => {
  if (event.key >= '1' && event.key <= '3') {
    const spec = PAVILION_SPECS[Number(event.key) - 1];
    if (spec) selectPavilion(spec.id);
  }
  if (event.key.toLowerCase() === 'e') setExploded(!exploded);
  if (event.key.toLowerCase() === 'v') setLowAngleView(activeView !== 'low-angle');
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

function resize() {
  const width = sceneCanvas.clientWidth;
  const height = sceneCanvas.clientHeight;
  renderer.setSize(width, height, false);
  camera.aspect = width / Math.max(1, height);
  camera.updateProjectionMatrix();
}

function render() {
  resize();
  controls.update();
  constrainInspectionCamera();
  const assemblyRuntime = getPavilionAssemblyRuntime(activeModel);
  if (assemblyRuntime && Math.abs(explodedTarget - explodedAmount) > 0.001) {
    explodedAmount = THREE.MathUtils.lerp(explodedAmount, explodedTarget, 0.14);
    if (Math.abs(explodedTarget - explodedAmount) < 0.002) explodedAmount = explodedTarget;
    assemblyRuntime.setExploded(explodedAmount);
  }
  if (window.__CHINA_TOWERS_DIAGNOSTICS__) {
    window.__CHINA_TOWERS_DIAGNOSTICS__.explodedAmount = assemblyRuntime?.explodedAmount ?? 0;
  }
  renderer.render(scene, camera);
  if (debugLoop && activeSpec.id === 'tengwang') {
    console.log('[Tengwang] render loop active, diagnostics ready:', !!window.__CHINA_TOWERS_DIAGNOSTICS__?.ready, 'model:', activeModel?.name, 'children:', activeModel?.children.length);
  }
  if (window.__CHINA_TOWERS_DIAGNOSTICS__) {
    window.__CHINA_TOWERS_DIAGNOSTICS__.renderCalls = renderer.info.render.calls;
    window.__CHINA_TOWERS_DIAGNOSTICS__.renderTriangles = renderer.info.render.triangles;
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
