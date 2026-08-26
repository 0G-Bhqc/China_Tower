import * as THREE from 'three';
import { createPavilionStudyModel, PAVILION_SPECS } from './createPavilionGalleryModel';
import { selectAvailableLod, type RuntimeLod } from './runtime/DeviceQualityProfile';
import { isAbortError, loadVerifiedGlb, type PavilionModelLoadOptions } from './runtime/loadVerifiedGlb';
import { registerPavilionAssembly } from './runtime/PavilionAssemblyRuntime';

const FEIYUN_LODS: Record<RuntimeLod, string> = {
  lod0: '/assets/feiyun-main-tower-highmodel.glb',
  lod1: '/assets/feiyun-main-tower-lod1.glb',
  lod2: '/assets/feiyun-main-tower-lod2.glb',
};

// Use the B4-corrected runtime packs (review-005) instead of the flat B3 semantic
// GLB.  The runtime packs preserve recovered-Material #26/#27/#28 and the
// hero/standard/mobile detail atlas assignments, avoiding the 341-mesh all-doors
// placeholder look that makes the tower appear blurry/糊状.
const FEIYUN_RUNTIME_PACKS = {
  hero: {
    core: '/assets/feiyun-runtime/feiyun-hero-core.c17ad69a149e.glb',
    roof: '/assets/feiyun-runtime/feiyun-hero-roof.f54dbfb5ea8f.glb',
    detail: '/assets/feiyun-runtime/feiyun-hero-detail.69f7f09aa82a.glb',
  },
  standard: {
    core: '/assets/feiyun-runtime/feiyun-standard-core.ae3085dd4a39.glb',
    roof: '/assets/feiyun-runtime/feiyun-standard-roof.fc90da07dfd6.glb',
    detail: '/assets/feiyun-runtime/feiyun-standard-detail.53c1cc1a369c.glb',
  },
  mobile: {
    core: '/assets/feiyun-runtime/feiyun-mobile-core.1196aedfed67.glb',
    roof: '/assets/feiyun-runtime/feiyun-mobile-roof.390d01062f48.glb',
    detail: '/assets/feiyun-runtime/feiyun-mobile-detail.43922bb4b591.glb',
  },
  pickingProxy: '/assets/feiyun-runtime/feiyun-picking-proxy.a1d0548c9515.glb',
};

const FALLBACK_COLORS: Record<string, number> = {
  'Material #26': 0xc8c8c8,
  'Material #27': 0xc8c8c8,
  'Material #28': 0xc8c8c8,
  'g3-facade-doors-windows': 0x8c7e6d,
  'g3-facade-railings': 0x5c4a3a,
  'g3-facade-walls': 0x9e9083,
  'g3-roof-system-eaves': 0x4a5d4a,
  'g3-roof-system-ornaments-finial': 0x8c7e3a,
  'g3-roof-system-ridges': 0x3d4a3d,
  'g3-roof-system-sheathing': 0x5a6b5a,
  'g3-roof-system-tiles': 0x4a5a4a,
  'g3-foundation': 0x6b6b6b,
  'g3-podium': 0x7a7a7a,
  'g3-secondary-details': 0x6e7a6e,
  'g3-structural-frame-brackets-dougong': 0x6b4423,
  'g3-structural-frame-columns': 0x5c3a1e,
};

function createArchitecturalMaterial(source: THREE.Material): THREE.MeshStandardMaterial {
  const sourceStandard = source as THREE.MeshStandardMaterial;
  const material = new THREE.MeshStandardMaterial({
    color: sourceStandard.color?.getHex() ?? 0xffffff,
    map: sourceStandard.map ?? null,
    roughness: 0.68,
    metalness: 0,
    envMapIntensity: 0.48,
  });
  material.name = `${source.name}-source-textured`;
  // If the GLB did not carry a recovered texture, fall back to a neutral tone
  // instead of the source's black placeholder colour.
  if (!material.map) {
    material.color.setHex(FALLBACK_COLORS[source.name] ?? 0x9c7655);
  }
  return material;
}

function prepareHighModel(assembly: THREE.Group): void {
  const materials = new Map<string, THREE.MeshStandardMaterial>();
  assembly.traverse((object) => {
    if (!(object instanceof THREE.Mesh)) return;
    const sourceMaterials = Array.isArray(object.material) ? object.material : [object.material];
    const calibrated = sourceMaterials.map((source) => {
      let material = materials.get(source.name);
      if (!material) {
        material = createArchitecturalMaterial(source);
        materials.set(source.name, material);
      }
      return material;
    });
    object.material = Array.isArray(object.material) ? calibrated : calibrated[0];
    object.castShadow = true;
    object.receiveShadow = true;
  });
  // Source tower is 36.6 × 36.7 × 30.8 m; preserve that exact proportion in
  // the common gallery, with its podium anchored to the ground plane.
  assembly.scale.setScalar(0.68);
  assembly.updateMatrixWorld(true);
  const bounds = new THREE.Box3().setFromObject(assembly);
  const centre = bounds.getCenter(new THREE.Vector3());
  assembly.position.x -= centre.x;
  assembly.position.z -= centre.z;
  assembly.position.y -= bounds.min.y;
  assembly.updateMatrixWorld(true);
}

export function createFeiyunTowerHighModel(loadOptions: PavilionModelLoadOptions = {}): THREE.Group {
  const root = new THREE.Group();
  root.name = 'feiyun-highmodel-root';
  const runtimeLod = selectAvailableLod(FEIYUN_LODS);
  root.userData.runtimeLod = runtimeLod;
  root.userData.sculptRuntime = { nodes: { root }, meshes: {}, sockets: {}, colliders: {}, destructionGroups: { tower: [] } };

  // Prefer the B4-corrected runtime packs (hero/standard/mobile detail atlases)
  // over the flat 3-material B3 semantic GLB, which was producing a blurry
  // placeholder look with 341 identical door/window meshes.
  async function loadRuntimePacks(): Promise<void> {
    const packs = FEIYUN_RUNTIME_PACKS;
    try {
      const [coreGltf, roofGltf, detailGltf] = await Promise.all([
        loadVerifiedGlb(packs.standard.core, loadOptions),
        loadVerifiedGlb(packs.standard.roof, loadOptions),
        loadVerifiedGlb(packs.standard.detail, loadOptions),
      ]);

      const assembly = new THREE.Group();
      assembly.name = 'feiyun-runtime-pack-assembly';

      if (coreGltf.scene) assembly.add(coreGltf.scene);
      if (roofGltf.scene) assembly.add(roofGltf.scene);
      if (detailGltf.scene) assembly.add(detailGltf.scene);

      prepareHighModel(assembly);
      registerPavilionAssembly(root, assembly, 'feiyun');
      root.add(assembly);
      root.userData.highModelReady = true;
      window.dispatchEvent(new CustomEvent('china-towers-model-ready', { detail: 'feiyun' }));
    } catch (error) {
      if (isAbortError(error)) return;
      console.warn('Feiyun runtime packs failed, falling back to LOD0.', error);
      try {
        const gltf = await loadVerifiedGlb(FEIYUN_LODS[runtimeLod], loadOptions);
        const assembly = gltf.scene;
        assembly.name = 'feiyun-highmodel-complete-tower';
        prepareHighModel(assembly);
        registerPavilionAssembly(root, assembly, 'feiyun');
        root.add(assembly);
        root.userData.highModelReady = true;
        window.dispatchEvent(new CustomEvent('china-towers-model-ready', { detail: 'feiyun' }));
      } catch (fallbackError) {
        if (isAbortError(fallbackError)) return;
        root.userData.highModelReady = false;
        root.userData.highModelLoadError = true;
        root.userData.highModelLoadErrorReason = 'asset-fetch-or-parse-failed';
        window.dispatchEvent(new CustomEvent('china-towers-model-ready', { detail: 'feiyun' }));
        console.error('Feiyun runtime GLB failed to load.', fallbackError);
      }
    }
  }

  void loadRuntimePacks();
  return root;
}
