import * as THREE from 'three';
import { PAVILION_SPECS } from './createPavilionGalleryModel';
import { selectAvailableLod, type RuntimeLod } from './runtime/DeviceQualityProfile';
import { isAbortError, loadVerifiedGlb, type PavilionModelLoadOptions } from './runtime/loadVerifiedGlb';
import { registerPavilionAssembly } from './runtime/PavilionAssemblyRuntime';
import { createPlaqueMesh, type PlaqueSpec } from './runtime/createPlaqueMesh';
import { needsSemanticRecolor, recolorMeshSurfaces, type SemanticPalette, isNearWhitePlaceholder } from './runtime/semanticSurfaceRecolor';
import { generateTengwangRoofTextures, generateTengwangWoodTextures, generateTengwangWallTextures, NORMAL_STRENGTH, AO_STRENGTH } from './createTengwangProceduralTextures';

// Pre-generated texture caches (singletons per session)
let cachedRoofTextures: ReturnType<typeof generateTengwangRoofTextures> | null = null;
let cachedWoodTextures: ReturnType<typeof generateTengwangWoodTextures> | null = null;
let cachedWallTextures: ReturnType<typeof generateTengwangWallTextures> | null = null;

function getOrCreateRoofTextures() {
  if (!cachedRoofTextures) {
    cachedRoofTextures = generateTengwangRoofTextures('#1f2a25');
  }
  return cachedRoofTextures;
}

function getOrCreateWoodTextures() {
  if (!cachedWoodTextures) {
    cachedWoodTextures = generateTengwangWoodTextures('#3a1c16');
  }
  return cachedWoodTextures;
}

function getOrCreateWallTextures() {
  if (!cachedWallTextures) {
    cachedWallTextures = generateTengwangWallTextures('#5e574b');
  }
  return cachedWallTextures;
}

const TENGWANG_LODS: Record<RuntimeLod, string> = {
  lod0: '/assets/tengwang-main-tower-highmodel.glb',
  lod1: '/assets/tengwang-main-tower-lod1.glb',
  lod2: '/assets/tengwang-main-tower-lod2.glb',
};

// High-precision source: 3D资产/滕王阁（1）/3d66.com_22753718.max
// Convert to GLB and place at: public/assets/tengwang-high-precision/tengwang-22753718.glb
const TENGWANG_HIGH_PRECISION_GLB = '/assets/tengwang-high-precision/tengwang-22753718.glb';

// Load order: high-precision first, then semantic GLB, then LOD0 fallback.
const TENGWANG_SEMANTIC_GLB = TENGWANG_LODS.lod0;

// Tengwang reads as dark grey-green tile roofs on strong vermilion work.
const TENGWANG_SEMANTIC_PALETTE: SemanticPalette = {
  roof: 0x3d4a44,
  timber: 0x4e241c,
  vermilion: 0x93352a,
  wall: 0xd8cbae,
  stone: 0x94907f,
};

const TENGWANG_PLAQUES: PlaqueSpec[] = [
  {
    text: '滕王阁',
    width: 3.6,
    height: 0.9,
    bgColor: '#0f1f4f',
    textColor: '#d4af37',
    position: [0, 13.8, 3.6],
    rotation: [0, Math.PI, 0],
    font: '"Noto Serif SC", "SimSun", "STSong", serif',
  },
];

function attachPlaques(root: THREE.Group): void {
  for (const spec of TENGWANG_PLAQUES) {
    const plaque = createPlaqueMesh(spec);
    plaque.position.set(...spec.position);
    plaque.userData.pavilionPlaque = { text: spec.text, bgColor: spec.bgColor, textColor: spec.textColor };
    root.add(plaque);
  }
}

function calibratedMaterial(source: THREE.Material): THREE.Material {
  // Always clone and force opaque so the high-precision model never renders
  // as an invisible/faint silhouette because of transparency or zero opacity.
  const clone = source.clone();
  clone.transparent = false;
  clone.opacity = 1;
  clone.depthWrite = true;
  if (clone instanceof THREE.MeshStandardMaterial || clone instanceof THREE.MeshPhysicalMaterial) {
    clone.roughness = Math.min(clone.roughness, 0.5);
    clone.metalness = Math.min(clone.metalness, 0.05);
    if (clone instanceof THREE.MeshPhysicalMaterial) {
      clone.clearcoat = 0.18;
      clone.clearcoatRoughness = 0.28;
    }
    clone.envMapIntensity = 0.85;
    clone.name = `${source.name}-source-preserved`;
  }
  return clone;
}

// The exported high-precision GLB carries one source-scene backdrop sheet
// (a 2-triangle ~1745x1431 flat plane). It dwarfs the whole complex, inflates
// every span-derived camera/explode/shadow computation, and covers the app
// ground with an untextured sheet. Everything else — including the wide
// multi-layer podium slabs (~170 units across) — is native architecture and
// must stay, so this threshold sits between the backdrop (>1700) and the
// largest legitimate structure (~174).
const MAX_IN_AREA_FOOTPRINT = 200;

function removeOutOfAreaGeometry(assembly: THREE.Object3D): number {
  assembly.updateMatrixWorld(true);
  const removals: Array<{ mesh: THREE.Mesh; parent: THREE.Object3D }> = [];
  assembly.traverse((object) => {
    if (!(object instanceof THREE.Mesh)) return;
    const bounds = new THREE.Box3().setFromObject(object);
    if (bounds.isEmpty()) return;
    const size = bounds.getSize(new THREE.Vector3());
    if (Math.max(size.x, size.z) > MAX_IN_AREA_FOOTPRINT) {
      removals.push({ mesh: object, parent: object.parent ?? assembly });
    }
  });
  for (const { mesh, parent } of removals) {
    parent.remove(mesh);
    mesh.geometry.dispose();
  }
  if (removals.length > 0) {
    console.info(`[Tengwang] Removed ${removals.length} out-of-area source-scene mesh(es) (footprint > ${MAX_IN_AREA_FOOTPRINT}).`);
  }
  return removals.length;
}

function prepareHighModel(assembly: THREE.Group): void {
  removeOutOfAreaGeometry(assembly);
  const materials = new Map<string, THREE.Material>();
  let meshIndex = 0;
  const rawBounds = new THREE.Box3().setFromObject(assembly);
  const modelHeight = Math.max(rawBounds.max.y - rawBounds.min.y, 0.001);

  // Foundation tier tracking: assign increasing polygonOffset per layer so
  // stacked flat slabs no longer z-fight each other or the global ground.
  // Also applies a tiny Y-axis nudge per layer to physically separate
  // co-planar geometry — the most reliable way to kill z-fighting.
  const foundationLayers: Array<{ minY: number; layerIndex: number; yNudge: number }> = [];
  const BASE_LAYER_HEIGHT = modelHeight * 0.25; // bottom quarter is "foundation"
  const LAYER_Y_NUDGE = 0.03; // 3 cm vertical separation per layer

  // First pass: collect foundation mesh Y-ranges for layer-index assignment.
  assembly.traverse((object) => {
    if (!(object instanceof THREE.Mesh)) return;
    object.geometry.computeBoundingBox();
    const geoBox = object.geometry.boundingBox ?? new THREE.Box3();
    const localMinY = geoBox.min.y;
    if (localMinY < BASE_LAYER_HEIGHT) {
      foundationLayers.push({ minY: localMinY, layerIndex: 0, yNudge: 0 });
    }
  });
  foundationLayers.sort((a, b) => a.minY - b.minY);
  let currentLayer = 0;
  let lastMinY = -Infinity;
  const LAYER_THRESHOLD = 0.15; // metres of Y-range = new layer
  for (const entry of foundationLayers) {
    if (entry.minY - lastMinY > LAYER_THRESHOLD) currentLayer++;
    entry.layerIndex = currentLayer;
    entry.yNudge = currentLayer * LAYER_Y_NUDGE;
    lastMinY = entry.minY;
  }

  assembly.traverse((object) => {
    if (!(object instanceof THREE.Mesh)) return;
    const sourceMaterials = Array.isArray(object.material) ? object.material : [object.material];
    const calibratedMaterials = sourceMaterials.map((source) => {
      let calibrated = materials.get(source.name);
      if (!calibrated) {
        calibrated = calibratedMaterial(source);
        materials.set(source.name, calibrated);
      }
      return calibrated;
    });
    // A mesh with one source material must retain a scalar material.  Assigning
    // a one-element array makes Three.js look for geometry groups and can leave
    // the complete model unrendered.
    object.material = Array.isArray(object.material) ? calibratedMaterials : calibratedMaterials[0];
    object.castShadow = true;
    object.receiveShadow = true;

    // Aggressive polygonOffset + physical Y-nudge for every foundation/bottom-tier mesh.
    // Covers: deck, platform, terrace, base, foundation, step, stair,
    // granite, stone, plinth, 台基, 底座, 踏步, 台阶, 石作 — plus all
    // meshes whose geometry sits in the lower quarter of the model.
    object.geometry.computeBoundingBox();
    const geometryBox = object.geometry.boundingBox ?? new THREE.Box3();
    const localCenterY = (geometryBox.min.y + geometryBox.max.y) / 2;
    const isFoundationName = /deck|platform|step mass|terrace|foundation|base|step|stair|granite|stone|plinth|台基|底座|踏步|台阶|石作|podium|铺砖/i.test(object.name);
    const isLowTier = localCenterY < BASE_LAYER_HEIGHT;
    const isFlatSlab = (geometryBox.max.y - geometryBox.min.y) < (geometryBox.max.x - geometryBox.min.x) * 0.6 &&
                       (geometryBox.max.y - geometryBox.min.y) < (geometryBox.max.z - geometryBox.min.z) * 0.6;

    if (isFoundationName || isLowTier || isFlatSlab) {
      const effectiveMaterials = Array.isArray(object.material) ? object.material : [object.material];
      // Find layer index for deeper-slab offset escalation.
      const matchedLayer = foundationLayers.find((layer) => Math.abs(layer.minY - geometryBox.min.y) < LAYER_THRESHOLD * 2);
      const layerIndex = matchedLayer ? matchedLayer.layerIndex : 0;
      const layerEscalation = layerIndex * 3;
      const yNudge = matchedLayer ? matchedLayer.yNudge : 0;

      // Physically nudge the mesh upward to separate co-planar layers.
      // This is the single most effective anti-z-fighting measure.
      object.position.y += yNudge;

      effectiveMaterials.forEach((material) => {
        material.polygonOffset = true;
        // Extreme values — the default near/far ratio makes modest values
        // ineffective on large scenes.  These are tuned for a ~30m model.
        material.polygonOffsetFactor = -(20 + layerEscalation);
        material.polygonOffsetUnits = -(40 + layerEscalation * 6);
        material.depthWrite = true;
        material.depthTest = true;
        // Foundation slabs should always be single-sided opaque so the
        // invisible underside never competes for depth.
        material.side = THREE.FrontSide;
        // Render foundation earlier so it sits behind the ground in the
        // depth buffer even when polygonOffset is insufficient.
        material.depthFunc = THREE.LessEqualDepth;
      });
    }
  });

  // Apply semantic surface recolouring for untextured placeholder geometry,
  // matching the Penglai/Yueyang pattern so the high-precision asset gets the
  // same readable architectural palette without overwriting real textures.
  assembly.traverse((object) => {
    if (!(object instanceof THREE.Mesh)) return;
    const effective = Array.isArray(object.material) ? object.material[0] : object.material;
    if (needsSemanticRecolor(effective)) {
      recolorMeshSurfaces(object, TENGWANG_SEMANTIC_PALETTE);
    } else if (isNearWhitePlaceholder(effective)) {
      object.name = `${object.name ?? 'tengwang-mesh'}-untextured-placeholder`;
    }
    object.name = `tengwang-highmodel-component-${String(++meshIndex).padStart(3, '0')}`;
    object.userData.pickingPart = object.name;
  });

  // Normalize the imported high-precision model into the shared pavilion
  // gallery scale. The source scene may be authored at unusual world scale,
  // so compute actual bounds and rescale to a consistent target size.
  const normalizeBounds = new THREE.Box3().setFromObject(assembly);
  const rawSize = normalizeBounds.getSize(new THREE.Vector3());
  const rawHeight = rawSize.y;
  const rawSpan = Math.max(rawSize.x, rawSize.y, rawSize.z);

  // Find the dominant vertical structure (main pavilion) so we do not scale
  // to the full site footprint; that would leave the building a few metres
  // wide and invisible. Instead: scale that structure to ~30 m, matching
  // the Penglai pattern, and publish a world-space focus box for the shared
  // camera framer.
  assembly.updateMatrixWorld(true);
  let maxHeight = 0;
  const meshBoxes: THREE.Box3[] = [];
  assembly.traverse((object) => {
    if (!(object instanceof THREE.Mesh)) return;
    const box = new THREE.Box3().setFromObject(object);
    if (!box.isEmpty() && box.max.y - box.min.y > 0.5) {
      meshBoxes.push(box);
      maxHeight = Math.max(maxHeight, box.max.y - box.min.y);
    }
  });
  const focus = new THREE.Box3();
  let hasFocus = false;
  for (const box of meshBoxes) {
    if (box.max.y - box.min.y >= maxHeight * 0.55) {
      if (!hasFocus) {
        focus.copy(box);
        hasFocus = true;
      } else {
        focus.union(box);
      }
    }
  }
  const focusSpan = hasFocus
    ? Math.max(focus.max.x - focus.min.x, focus.max.z - focus.min.z, focus.max.y - focus.min.y)
    : 0;
  const horizontalSpan = Math.max(normalizeBounds.max.x - normalizeBounds.min.x, normalizeBounds.max.z - normalizeBounds.min.z);
  const scale = focusSpan > 0 ? 30 / focusSpan : horizontalSpan > 0 ? 28 / horizontalSpan : 0.4;
  assembly.scale.setScalar(scale);
  const scaledFocus = focus.clone();
  scaledFocus.min.multiplyScalar(scale);
  scaledFocus.max.multiplyScalar(scale);
  assembly.userData.focusBounds = scaledFocus;
  assembly.updateMatrixWorld(true);
  const bounds = new THREE.Box3().setFromObject(assembly);
  const centre = bounds.getCenter(new THREE.Vector3());
  console.log('[Tengwang] postScale bounds:', bounds.min.toString(), '->', bounds.max.toString(), 'centre:', centre.toString(), 'span:', Math.max(...bounds.getSize(new THREE.Vector3()).toArray()));

  // Centre on the gallery ground plane; keep the base grounded.
  assembly.position.x -= centre.x;
  assembly.position.z -= centre.z;
  assembly.position.y -= bounds.min.y;

  // The focus box was computed in pre-centering local space. Convert it to
  // world space now so the shared camera framer looks at the actual model
  // instead of an empty offset point.
  assembly.updateWorldMatrix(true, false);
  const worldFocus = new THREE.Box3();
  worldFocus.set(
    scaledFocus.min.clone().applyMatrix4(assembly.matrixWorld),
    scaledFocus.max.clone().applyMatrix4(assembly.matrixWorld),
  );
  assembly.userData.focusBounds = worldFocus;

  console.log('[Tengwang] final assembly pos:', assembly.position.toString(), 'scale:', assembly.scale.toString());

  // Final bounds after centering
  const finalBounds = new THREE.Box3().setFromObject(assembly);
  const finalCentre = finalBounds.getCenter(new THREE.Vector3());
  console.log('[Tengwang] final bounds:', finalBounds.min.toString(), '->', finalBounds.max.toString(), 'centre:', finalCentre.toString());

  // Check mesh visibility before adding to root
  let visibleMeshCount = 0;
  let hiddenMeshCount = 0;
  assembly.traverse((obj) => {
    if (obj instanceof THREE.Mesh) {
      if (obj.visible) visibleMeshCount++;
      else hiddenMeshCount++;
    }
  });
  console.log(`[Tengwang] Mesh visibility: ${visibleMeshCount} visible, ${hiddenMeshCount} hidden`);

  // Ensure model is visible by checking if it's within reasonable bounds
  if (finalBounds.isEmpty() || finalBounds.getSize(new THREE.Vector3()).length() < 1) {
    console.warn('[Tengwang] Model bounds are too small, model may not be visible');
  }

  assembly.updateMatrixWorld(true);
}

// DEBUG override: replace all high-precision materials with a simple opaque
// DoubleSide red so the 426MB GLB is guaranteed visible even if its original
// PBR chain is incompatible with the app's light rig / env map.
function applyDebugMaterialOverride(assembly: THREE.Group): void {
  assembly.traverse((object) => {
    if (!(object instanceof THREE.Mesh)) return;
    object.material = new THREE.MeshBasicMaterial({
      color: 0xff3b30,
      side: THREE.DoubleSide,
      depthTest: true,
      depthWrite: true,
    });
  });
  console.warn('[Tengwang] Applied debug material override (opaque red, DoubleSide).');
}

export function createTengwangTowerHighModel(loadOptions: PavilionModelLoadOptions = {}): THREE.Group {
  const root = new THREE.Group();
  root.name = 'tengwang-highmodel-root';
  console.log('[Tengwang] Creating high model root');
  const runtimeLod = selectAvailableLod(TENGWANG_LODS);
  root.userData.runtimeLod = runtimeLod;
  const fallbackSpec = PAVILION_SPECS.find((spec) => spec.id === 'tengwang');
  root.userData.sculptRuntime = { nodes: { root }, meshes: {}, sockets: {}, colliders: {}, destructionGroups: { tower: [] } };

  const promise = loadVerifiedGlb(TENGWANG_HIGH_PRECISION_GLB, loadOptions);
  console.log('[Tengwang] Loading high-precision GLB:', TENGWANG_HIGH_PRECISION_GLB);
  promise
    .then((gltf) => {
      console.log('[Tengwang] High-precision GLB loaded');
      const assembly = gltf.scene;
      assembly.name = 'tengwang-highmodel-admitted-core';
      root.userData.runtimeLod = 'lod0hp';
      prepareHighModel(assembly);
      registerPavilionAssembly(root, assembly, 'tengwang');
      root.add(assembly);
      if (assembly.userData.focusBounds instanceof THREE.Box3) {
        root.userData.focusBounds = assembly.userData.focusBounds;
      }
      root.userData.highModelReady = true;
      root.userData.highModelSource = 'high-precision';
      console.log('[Tengwang] High-precision model ready (add before register)');
      window.dispatchEvent(new CustomEvent('china-towers-model-ready', { detail: 'tengwang' }));
    })
    .catch((highPrecisionError: unknown) => {
      if (isAbortError(highPrecisionError)) return;
      console.warn('Tengwang high-precision GLB failed, falling back to semantic GLB.', highPrecisionError);
      return loadVerifiedGlb(TENGWANG_SEMANTIC_GLB, loadOptions).then((gltf) => {
        console.log('[Tengwang] Semantic GLB loaded');
        const assembly = gltf.scene;
        assembly.name = 'tengwang-highmodel-admitted-core';
        root.userData.runtimeLod = 'lod0';
        prepareHighModel(assembly);
        registerPavilionAssembly(root, assembly, 'tengwang');
        if (assembly.userData.focusBounds instanceof THREE.Box3) {
          root.userData.focusBounds = assembly.userData.focusBounds;
        }
        root.add(assembly);
        root.userData.highModelReady = true;
        root.userData.highModelSource = 'semantic-hierarchy';
        console.log('[Tengwang] Semantic GLB ready');
        window.dispatchEvent(new CustomEvent('china-towers-model-ready', { detail: 'tengwang' }));
      });
    })
    .catch((semanticError: unknown) => {
      if (isAbortError(semanticError)) return;
      console.warn('Tengwang semantic GLB failed to load, falling back to LOD0.', semanticError);
      return loadVerifiedGlb(TENGWANG_LODS.lod0, loadOptions).then((gltf) => {
        const assembly = gltf.scene;
        assembly.name = 'tengwang-highmodel-admitted-core';
        root.userData.runtimeLod = 'lod0hp';
        prepareHighModel(assembly);
        root.add(assembly);
        root.userData.highModelReady = true;
        root.userData.highModelSource = 'lod0-fallback';
        console.log('[Tengwang] LOD0 fallback ready');
        window.dispatchEvent(new CustomEvent('china-towers-model-ready', { detail: 'tengwang' }));
      });
    })
    .catch((error: unknown) => {
      if (isAbortError(error)) return;
      root.userData.highModelReady = false;
      root.userData.highModelLoadError = true;
      root.userData.highModelLoadErrorReason = 'asset-fetch-or-parse-failed';
      window.dispatchEvent(new CustomEvent('china-towers-model-ready', { detail: 'tengwang' }));
      console.error('Tengwang runtime GLB failed to load.', error);
    });
  return root;
}
