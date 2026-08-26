import * as THREE from 'three';
import { selectAvailableLod, type RuntimeLod } from './runtime/DeviceQualityProfile';
import { isAbortError, loadVerifiedGlb, type PavilionModelLoadOptions } from './runtime/loadVerifiedGlb';
import { registerPavilionAssembly } from './runtime/PavilionAssemblyRuntime';
import { groundAssembly, stabilizeFoundationDepth } from './runtime/grounding';
import { needsSemanticRecolor, recolorMeshSurfaces, type SemanticPalette, isNearWhitePlaceholder } from './runtime/semanticSurfaceRecolor';

const PENGLAI_LODS: Record<RuntimeLod, string> = {
  lod0: '/assets/penglai-main-pavilion-highmodel.glb',
  lod1: '/assets/penglai-main-pavilion-lod1.glb',
  lod2: '/assets/penglai-main-pavilion-lod2.glb',
};
const PENGLAI_SEMANTIC_GLB = PENGLAI_LODS.lod1;

// Penglai: grey-teal tile roofs, dark timber, lime-washed walls, granite base.
const PENGLAI_SEMANTIC_PALETTE: SemanticPalette = {
  roof: 0x46554e,
  timber: 0x5b3120,
  vermilion: 0x86362a,
  wall: 0xd9ccae,
  stone: 0x8f8b7d,
};

function calibratedMaterial(source: THREE.Material): THREE.Material {
  // Preserve the original GLB material and texture instead of replacing it with
  // a procedural shader. Only tune PBR response for the shared lighting rig.
  if (source instanceof THREE.MeshStandardMaterial || source instanceof THREE.MeshPhysicalMaterial) {
    const clone = source.clone();
    clone.roughness = Math.min(clone.roughness, 0.78);
    clone.metalness = Math.min(clone.metalness, 0.12);
    clone.envMapIntensity = 0.46;
    clone.name = `${source.name}-source-preserved`;
    return clone;
  }
  return source;
}

function prepareHighModel(assembly: THREE.Group): void {
  const materials = new Map<string, THREE.Material>();
  let meshIndex = 0;
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
    // 95% of this asset's geometry sits on untextured materials (4.05M verts
    // near-white); recolour placeholder meshes face-by-face semantically.
    const effective = Array.isArray(object.material) ? object.material[0] : object.material;
    if (needsSemanticRecolor(effective)) {
      recolorMeshSurfaces(object, PENGLAI_SEMANTIC_PALETTE);
    } else if (isNearWhitePlaceholder(effective)) {
      object.name = `${object.name ?? 'penglai-mesh'}-untextured-placeholder`;
    }
    object.name = `penglai-highmodel-component-${String(++meshIndex).padStart(3, '0')}`;
    object.userData.pickingPart = object.name;
    object.castShadow = true;
    object.receiveShadow = true;
  });
  // The admitted subset is the full walled courtyard (up to ~230 m across).
  // Scaling by the whole courtyard span left the main pavilion a few metres
  // wide and impossible to inspect.  Instead: find the dominant vertical
  // structure (the main pavilion), scale the assembly so THAT spans ~30 m,
  // centre the gallery on it, and publish a world-space focus box that the
  // shared camera framing prefers over the full courtyard bounds.
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
  const rawBounds = new THREE.Box3().setFromObject(assembly);
  const horizontalSpan = Math.max(
    rawBounds.max.x - rawBounds.min.x,
    rawBounds.max.z - rawBounds.min.z,
  );
  const scale = focusSpan > 0 ? 30 / focusSpan : horizontalSpan > 0 ? 28 / horizontalSpan : 0.4;
  assembly.scale.setScalar(scale);
  assembly.updateMatrixWorld(true);
  const bounds = new THREE.Box3().setFromObject(assembly);
  const focusCentre = hasFocus
    ? focus.getCenter(new THREE.Vector3()).multiplyScalar(scale)
    : bounds.getCenter(new THREE.Vector3());
  assembly.position.x -= focusCentre.x;
  assembly.position.z -= focusCentre.z;
  assembly.position.y -= bounds.min.y;
  assembly.updateMatrixWorld(true);
  const worldFocus = new THREE.Box3();
  if (hasFocus) {
    worldFocus.copy(focus);
    worldFocus.min.multiplyScalar(scale).add(assembly.position);
    worldFocus.max.multiplyScalar(scale).add(assembly.position);
  } else {
    worldFocus.copy(bounds);
  }
  assembly.userData.focusBounds = worldFocus;
  stabilizeFoundationDepth(assembly);
  groundAssembly(assembly, 0.025);
}

export function createPenglaiPavilionHighModel(loadOptions: PavilionModelLoadOptions = {}): THREE.Group {
  const root = new THREE.Group();
  root.name = 'penglai-highmodel-root';
  const runtimeLod = selectAvailableLod(PENGLAI_LODS);
  root.userData.runtimeLod = runtimeLod;
  root.userData.sculptRuntime = { nodes: { root }, meshes: {}, sockets: {}, colliders: {}, destructionGroups: { pavilion: [] } };

  void loadVerifiedGlb(PENGLAI_SEMANTIC_GLB, loadOptions)
    .then((gltf) => {
      const assembly = gltf.scene;
      assembly.name = 'penglai-highmodel-main-pavilion-cluster';
      prepareHighModel(assembly);
      registerPavilionAssembly(root, assembly, 'penglai');
      root.add(assembly);
      if (assembly.userData.focusBounds instanceof THREE.Box3) {
        root.userData.focusBounds = assembly.userData.focusBounds;
      }
      root.userData.highModelReady = true;
      root.userData.highModelSource = 'semantic-hierarchy';
      window.dispatchEvent(new CustomEvent('china-towers-model-ready', { detail: 'penglai' }));
    })
    .catch((semanticError: unknown) => {
      if (isAbortError(semanticError)) return;
      console.warn('Penglai semantic GLB failed to load, falling back to LOD0.', semanticError);
      return loadVerifiedGlb(PENGLAI_LODS.lod0, loadOptions).then((gltf) => {
        const assembly = gltf.scene;
        assembly.name = 'penglai-highmodel-main-pavilion-cluster';
        prepareHighModel(assembly);
        registerPavilionAssembly(root, assembly, 'penglai');
        root.add(assembly);
        if (assembly.userData.focusBounds instanceof THREE.Box3) {
          root.userData.focusBounds = assembly.userData.focusBounds;
        }
        root.userData.highModelReady = true;
        root.userData.highModelSource = 'lod0-fallback';
        window.dispatchEvent(new CustomEvent('china-towers-model-ready', { detail: 'penglai' }));
      });
    })
    .catch((error: unknown) => {
      if (isAbortError(error)) return;
      root.userData.highModelReady = false;
      root.userData.highModelLoadError = true;
      root.userData.highModelLoadErrorReason = 'asset-fetch-or-parse-failed';
      window.dispatchEvent(new CustomEvent('china-towers-model-ready', { detail: 'penglai' }));
      console.error('Penglai runtime GLB failed to load.', error);
    });
  return root;
}
