import * as THREE from 'three';
import { selectAvailableLod, type RuntimeLod } from './runtime/DeviceQualityProfile';
import { isAbortError, loadVerifiedGlb, type PavilionModelLoadOptions } from './runtime/loadVerifiedGlb';
import { registerPavilionAssembly } from './runtime/PavilionAssemblyRuntime';
import { recolorMeshSurfaces, type SemanticPalette } from './runtime/semanticSurfaceRecolor';

const YUEYANG_LODS: Record<RuntimeLod, string> = {
  lod0: '/assets/yueyang-architectural-lod.glb',
  lod1: '/assets/yueyang-architectural-lod1.glb',
  lod2: '/assets/yueyang-architectural-lod2.glb',
};
// Load order: complete high-precision master first, then the decimated
// desktop LOD as a fetch/parse fallback.
const YUEYANG_PRIMARY_GLB = YUEYANG_LODS.lod0;
const YUEYANG_FALLBACK_GLB = YUEYANG_LODS.lod1;

// Yueyang wears a golden glazed helmet roof over vermilion timber on a stone
// city-platform (roof tone follows the authored model's roofColor 0xc88738).
const YUEYANG_SEMANTIC_PALETTE: SemanticPalette = {
  roof: 0xc88738,
  timber: 0x5a2a20,
  vermilion: 0x8c3126,
  wall: 0xd6c5a3,
  stone: 0x97917f,
};

/**
 * The native export loses the textures of several materials and ships them as
 * flat placeholders: near-white clay AND pure-black roof/lattice materials
 * (#25/#26). Both need the semantic face recolour; the shared near-white test
 * alone misses the black ones.
 */
function isPlaceholderMaterial(material: THREE.Material): boolean {
  if (!(material instanceof THREE.MeshStandardMaterial) && !(material instanceof THREE.MeshPhysicalMaterial)) {
    return false;
  }
  if (material.map) return false;
  const { r, g, b } = material.color;
  const nearWhite = r > 0.78 && g > 0.78 && b > 0.78;
  const nearBlack = r < 0.12 && g < 0.12 && b < 0.12;
  return nearWhite || nearBlack;
}

function calibratedMaterial(source: THREE.Material): THREE.Material {
  // Preserve the original GLB material and texture. Only adjust PBR response
  // so the imported asset behaves consistently under the shared light rig
  // (same audited values as the Huanghe calibration).
  if (source instanceof THREE.MeshStandardMaterial || source instanceof THREE.MeshPhysicalMaterial) {
    const clone = source.clone();
    clone.transparent = false;
    clone.opacity = 1;
    clone.depthWrite = true;
    clone.depthTest = true;
    clone.roughness = Math.min(clone.roughness, 0.72);
    clone.metalness = Math.min(clone.metalness, 0.12);
    clone.envMapIntensity = 0.42;
    clone.name = `${source.name}-yueyang-calibrated`;
    return clone;
  }
  return source;
}

function prepareHighModel(assembly: THREE.Group): void {
  const materials = new Map<string, THREE.Material>();
  assembly.traverse((object) => {
    if (!(object instanceof THREE.Mesh)) return;
    const sourceMaterials = Array.isArray(object.material) ? object.material : [object.material];
    const calibrated = sourceMaterials.map((source) => {
      let material = materials.get(source.name);
      if (!material) {
        material = calibratedMaterial(source);
        materials.set(source.name, material);
      }
      return material;
    });
    object.material = Array.isArray(object.material) ? calibrated : calibrated[0];
    const effective = Array.isArray(object.material) ? object.material[0] : object.material;
    if (isPlaceholderMaterial(effective)) {
      recolorMeshSurfaces(object, YUEYANG_SEMANTIC_PALETTE);
    }
    object.castShadow = true;
    object.receiveShadow = true;
  });
  // The native asset is already at exhibit scale (~18x21x19); centre it on
  // the gallery ground plane and ground it without rescaling.
  assembly.updateMatrixWorld(true);
  const bounds = new THREE.Box3().setFromObject(assembly);
  const centre = bounds.getCenter(new THREE.Vector3());
  assembly.position.x -= centre.x;
  assembly.position.z -= centre.z;
  assembly.position.y -= bounds.min.y;
  assembly.updateMatrixWorld(true);
}

export function createYueyangTowerNativeModel(loadOptions: PavilionModelLoadOptions = {}): THREE.Group {
  const root = new THREE.Group();
  root.name = 'yueyang-highmodel-root';
  const runtimeLod = selectAvailableLod(YUEYANG_LODS);
  root.userData.runtimeLod = runtimeLod;
  root.userData.sculptRuntime = { nodes: { root }, meshes: {}, sockets: {}, colliders: {}, destructionGroups: { tower: [] } };

  void loadVerifiedGlb(YUEYANG_PRIMARY_GLB, loadOptions)
    .then((gltf) => {
      const assembly = gltf.scene;
      assembly.name = 'yueyang-highmodel-complete-tower';
      root.userData.runtimeLod = 'lod0';
      prepareHighModel(assembly);
      registerPavilionAssembly(root, assembly, 'yueyang');
      root.add(assembly);
      root.userData.highModelReady = true;
      root.userData.highModelSource = 'high-precision';
      window.dispatchEvent(new CustomEvent('china-towers-model-ready', { detail: 'yueyang' }));
    })
    .catch((primaryError: unknown) => {
      if (isAbortError(primaryError)) return;
      console.warn('Yueyang high-precision GLB failed to load, falling back to LOD1.', primaryError);
      return loadVerifiedGlb(YUEYANG_FALLBACK_GLB, loadOptions).then((gltf) => {
        const assembly = gltf.scene;
        assembly.name = 'yueyang-highmodel-complete-tower';
        root.userData.runtimeLod = 'lod1';
        prepareHighModel(assembly);
        registerPavilionAssembly(root, assembly, 'yueyang');
        root.add(assembly);
        root.userData.highModelReady = true;
        root.userData.highModelSource = 'lod1-fallback';
        window.dispatchEvent(new CustomEvent('china-towers-model-ready', { detail: 'yueyang' }));
      });
    })
    .catch((error: unknown) => {
      if (isAbortError(error)) return;
      root.userData.highModelReady = false;
      root.userData.highModelLoadError = true;
      root.userData.highModelLoadErrorReason = 'asset-fetch-or-parse-failed';
      window.dispatchEvent(new CustomEvent('china-towers-model-ready', { detail: 'yueyang' }));
      console.error('Yueyang runtime GLB failed to load.', error);
    });
  return root;
}
