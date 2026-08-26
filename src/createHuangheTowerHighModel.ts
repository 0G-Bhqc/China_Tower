import * as THREE from 'three';
import { PAVILION_SPECS } from './createPavilionGalleryModel';
import { selectAvailableLod, type RuntimeLod } from './runtime/DeviceQualityProfile';
import { isAbortError, loadVerifiedGlb, type PavilionModelLoadOptions } from './runtime/loadVerifiedGlb';
import { registerPavilionAssembly } from './runtime/PavilionAssemblyRuntime';
import { needsSemanticRecolor, recolorMeshSurfaces, type SemanticPalette } from './runtime/semanticSurfaceRecolor';

const HUANGHE_LODS: Record<RuntimeLod, string> = {
  lod0: '/assets/huanghe-main-tower-highmodel.glb',
  lod1: '/assets/huanghe-main-tower-lod1.glb',
  lod2: '/assets/huanghe-main-tower-lod2.glb',
};
// Load order: complete high-precision master first, then the decimated
// desktop LOD as a fetch/parse fallback.
const HUANGHE_PRIMARY_GLB = HUANGHE_LODS.lod0;
const HUANGHE_FALLBACK_GLB = HUANGHE_LODS.lod1;

// Huanghe wears golden glazed tiles on vermilion timber over a stone podium.
const HUANGHE_SEMANTIC_PALETTE: SemanticPalette = {
  roof: 0x8f6a28,
  timber: 0x5a2a20,
  vermilion: 0x8c3126,
  wall: 0xd6c5a3,
  stone: 0x97917f,
};

function calibratedMaterial(source: THREE.Material): THREE.Material {
  // Preserve the original GLB material and texture. Only adjust PBR response
  // so the imported asset behaves consistently under the shared light rig.
  // Values follow the audited Hermes calibration (env 0.42); stronger
  // environment response washes the tile atlases out to near-white.
  if (source instanceof THREE.MeshStandardMaterial || source instanceof THREE.MeshPhysicalMaterial) {
    const clone = source.clone();
    clone.transparent = false;
    clone.opacity = 1;
    clone.depthWrite = true;
    clone.depthTest = true;
    clone.roughness = Math.min(clone.roughness, 0.72);
    clone.metalness = Math.min(clone.metalness, 0.12);
    clone.envMapIntensity = 0.42;
    // The exported roof material (#25/#26) carries a near-white grunge mask as
    // its base-colour texture (avg #cacaca) instead of a glazed-tile atlas, so
    // the roofs render white. Strip it; the semantic placeholder recolour then
    // gives these faces the golden-tile response with procedural ridges.
    if (/material #2[56]/i.test(source.name ?? '') && clone.map) {
      clone.map = null;
    }
    clone.name = `${source.name}-huanghe-calibrated`;
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
    // Placeholder materials (no texture, near-white diffuse) carry large
    // vertex counts in this asset; recolour their faces semantically instead
    // of showing blank clay.
    const effective = Array.isArray(object.material) ? object.material[0] : object.material;
    if (needsSemanticRecolor(effective)) {
      // The roof mesh (#25) spans the whole tower, so the in-mesh height gate
      // would zone its lower tiers as stone. Every upward face in this asset's
      // placeholder geometry is roof; stone lives in separate meshes.
      recolorMeshSurfaces(object, HUANGHE_SEMANTIC_PALETTE, { upwardZone: 'roof' });
    }
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
