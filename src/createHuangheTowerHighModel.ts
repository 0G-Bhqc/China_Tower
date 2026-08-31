import * as THREE from 'three';
import { selectAvailableLod, type RuntimeLod } from './runtime/DeviceQualityProfile';
import { isAbortError, loadVerifiedGlb, type PavilionModelLoadOptions } from './runtime/loadVerifiedGlb';
import { registerPavilionAssembly } from './runtime/PavilionAssemblyRuntime';
import { needsSemanticRecolor, recolorMeshSurfaces, type SemanticPalette } from './runtime/semanticSurfaceRecolor';
import { applySemanticRelief } from './runtime/semanticRelief';

const HUANGHE_LODS: Record<RuntimeLod, string> = {
  lod0: '/assets/huanghe-main-tower-highmodel.glb',
  lod1: '/assets/huanghe-main-tower-lod1.glb',
  lod2: '/assets/huanghe-main-tower-lod2.glb',
};

// Degrade one LOD at a time from the tier's preferred asset so a failed fetch
// never jumps straight back to the full master.
const DEGRADE_ORDER: Record<RuntimeLod, RuntimeLod[]> = {
  lod0: ['lod1', 'lod2'],
  lod1: ['lod2', 'lod0'],
  lod2: ['lod1', 'lod0'],
};

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
      // placeholder geometry is roof; stone lives in separate meshes. The
      // steep slope band (0.18 < normal.y ≤ 0.55) must also zone as roof —
      // on this mesh those faces are tile slopes, and leaving them under the
      // vertical gate scattered plaster-pink patches through the golden
      // tiers, which read as glitter at distance.
      recolorMeshSurfaces(object, HUANGHE_SEMANTIC_PALETTE, { upwardZone: 'roof', slopeAsRoof: true, verticalZone: 'vermilion' });
      // The exported placeholder layer (#25, 2M tris) is coplanar with the
      // textured body mesh underneath across the whole tower. polygonOffset
      // cannot separate them — the renderer runs a logarithmic depth buffer,
      // which disables fixed-function depth offset — so the two layers
      // stippled into coloured sparkle. Shrink the placeholder a fraction of
      // a percent toward its origin instead: coplanar regions now sit a few
      // mm BEHIND the textured body and lose the depth test cleanly, while
      // eave tips and soffits outside the body footprint still render.
      object.scale.multiplyScalar(0.9985);
    }
    object.castShadow = true;
    object.receiveShadow = true;
  });
  applySemanticRelief(assembly);
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
  root.userData.sculptRuntime = { nodes: { root }, meshes: {}, sockets: {}, colliders: {}, destructionGroups: { tower: [] } };

  // Quality-tier asset selection: selectAvailableLod resolves the device
  // profile (hero→lod0, standard→lod1, mobile→lod2, ?lod= override) and the
  // chain degrades one LOD at a time from there.
  const preferredLod = selectAvailableLod(HUANGHE_LODS);
  root.userData.runtimeLod = preferredLod;
  const stages = [
    { url: HUANGHE_LODS[preferredLod], lod: preferredLod, source: preferredLod === 'lod0' ? 'high-precision' : `${preferredLod}-tier` },
    ...DEGRADE_ORDER[preferredLod].map((lod) => ({ url: HUANGHE_LODS[lod], lod, source: `${lod}-fallback` })),
  ];
  let stageIndex = 0;

  const loadStage = (): void => {
    const stage = stages[stageIndex++];
    loadVerifiedGlb(stage.url, loadOptions)
      .then((gltf) => {
        const assembly = gltf.scene;
        assembly.name = 'huanghe-highmodel-complete-tower';
        root.userData.runtimeLod = stage.lod;
        prepareHighModel(assembly);
        registerPavilionAssembly(root, assembly, 'huanghe');
        root.add(assembly);
        // No runtime plaque here: the GLB carries its own 黄鹤楼 board on the
        // top storey — an added one doubled it in the wrong spot.
        root.userData.highModelReady = true;
        root.userData.highModelSource = stage.source;
        window.dispatchEvent(new CustomEvent('china-towers-model-ready', { detail: 'huanghe' }));
      })
      .catch((error: unknown) => {
        if (isAbortError(error)) return;
        if (stageIndex < stages.length) {
          console.warn(`Huanghe GLB ${stage.url} failed, degrading LOD.`, error);
          loadStage();
          return;
        }
        root.userData.highModelReady = false;
        root.userData.highModelLoadError = true;
        root.userData.highModelLoadErrorReason = 'asset-fetch-or-parse-failed';
        window.dispatchEvent(new CustomEvent('china-towers-model-ready', { detail: 'huanghe' }));
        console.error('Huanghe runtime GLB failed to load.', error);
      });
  };
  loadStage();
  return root;
}
