import * as THREE from 'three';
import { PAVILION_SPECS } from './createPavilionGalleryModel';
import { selectAvailableLod, type RuntimeLod } from './runtime/DeviceQualityProfile';
import { isAbortError, loadVerifiedGlb, type PavilionModelLoadOptions } from './runtime/loadVerifiedGlb';
import { registerPavilionAssembly } from './runtime/PavilionAssemblyRuntime';

const HUANGHE_LODS: Record<RuntimeLod, string> = {
  lod0: '/assets/huanghe-main-tower-highmodel.glb',
  lod1: '/assets/huanghe-main-tower-lod1.glb',
  lod2: '/assets/huanghe-main-tower-lod2.glb',
};
// Load order: complete high-precision master first, then the decimated
// desktop LOD as a fetch/parse fallback.
const HUANGHE_PRIMARY_GLB = HUANGHE_LODS.lod0;
const HUANGHE_FALLBACK_GLB = HUANGHE_LODS.lod1;

function calibratedMaterial(source: THREE.Material): THREE.Material {
  const clone = source.clone();
  clone.transparent = false;
  clone.opacity = 1;
  clone.depthWrite = true;
  clone.depthTest = true;
  if (clone instanceof THREE.MeshStandardMaterial || clone instanceof THREE.MeshPhysicalMaterial) {
    clone.roughness = Math.min(clone.roughness, 0.5);
    clone.metalness = Math.min(clone.metalness, 0.05);
    clone.envMapIntensity = 0.85;
    if (clone instanceof THREE.MeshPhysicalMaterial) {
      clone.clearcoat = 0.18;
      clone.clearcoatRoughness = 0.28;
    }
  }
  clone.name = `${source.name}-huanghe-calibrated`;
  return clone;
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
    object.castShadow = true;
    object.receiveShadow = true;
  });
  assembly.scale.setScalar(0.42);
  assembly.updateMatrixWorld(true);
  const bounds = new THREE.Box3().setFromObject(assembly);
  const centre = bounds.getCenter(new THREE.Vector3());
  assembly.position.x -= centre.x;
  assembly.position.z -= centre.z;
  assembly.position.y -= bounds.min.y;
  assembly.updateMatrixWorld(true);
}

export function createHuangheTowerHighModel(loadOptions: PavilionModelLoadOptions = {}): THREE.Group {
  const root = new THREE.Group();
  root.name = 'huanghe-highmodel-root';
  console.log('[Huanghe] Creating high model root');
  const runtimeLod = selectAvailableLod(HUANGHE_LODS);
  root.userData.runtimeLod = runtimeLod;
  const fallbackSpec = PAVILION_SPECS.find((spec) => spec.id === 'huanghe');
  root.userData.sculptRuntime = { nodes: { root }, meshes: {}, sockets: {}, colliders: {}, destructionGroups: { tower: [] } };

  void loadVerifiedGlb(HUANGHE_PRIMARY_GLB, loadOptions)
    .then((gltf) => {
      console.log('[Huanghe] High-precision GLB loaded', gltf.scene, 'children:', gltf.scene.children.length);
      const assembly = gltf.scene;
      assembly.name = 'huanghe-highmodel-complete-tower';
      root.userData.runtimeLod = 'lod0';
      prepareHighModel(assembly);
      registerPavilionAssembly(root, assembly, 'huanghe');
      root.add(assembly);
      root.userData.highModelReady = true;
      root.userData.highModelSource = 'high-precision';
      console.log('[Huanghe] Model ready, added to root');
      window.dispatchEvent(new CustomEvent('china-towers-model-ready', { detail: 'huanghe' }));
    })
    .catch((primaryError: unknown) => {
      if (isAbortError(primaryError)) return;
      console.warn('Huanghe high-precision GLB failed to load, falling back to LOD1.', primaryError);
      return loadVerifiedGlb(HUANGHE_FALLBACK_GLB, loadOptions).then((gltf) => {
        const assembly = gltf.scene;
        assembly.name = 'huanghe-highmodel-complete-tower';
        root.userData.runtimeLod = 'lod1';
        prepareHighModel(assembly);
        registerPavilionAssembly(root, assembly, 'huanghe');
        root.add(assembly);
        root.userData.highModelReady = true;
        root.userData.highModelSource = 'lod1-fallback';
        console.log('[Huanghe] LOD1 fallback ready');
        window.dispatchEvent(new CustomEvent('china-towers-model-ready', { detail: 'huanghe' }));
      });
    })
    .catch((error: unknown) => {
      if (isAbortError(error)) return;
      root.userData.highModelReady = false;
      root.userData.highModelLoadError = true;
      root.userData.highModelLoadErrorReason = 'asset-fetch-or-parse-failed';
      window.dispatchEvent(new CustomEvent('china-towers-model-ready', { detail: 'huanghe' }));
      console.error('Huanghe runtime GLB failed to load.', error);
    });
  return root;
}
