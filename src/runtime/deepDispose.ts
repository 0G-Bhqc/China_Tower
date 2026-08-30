import * as THREE from 'three';

// Full GPU-side teardown for a removed model subtree. Material.dispose()
// does NOT release its textures, so swapping pavilions with the previous
// shallow dispose leaked every GLB atlas (tens to hundreds of MB of VRAM
// per switch, cumulative across visits).

const TEXTURE_SLOTS: string[] = [
  'map', 'normalMap', 'roughnessMap', 'metalnessMap', 'aoMap', 'emissiveMap',
  'alphaMap', 'bumpMap', 'displacementMap', 'specularMap', 'envMap', 'lightMap',
  'clearcoatMap', 'clearcoatNormalMap', 'clearcoatRoughnessMap',
  'sheenColorMap', 'sheenRoughnessMap', 'transmissionMap', 'thicknessMap',
  'iridescenceMap', 'iridescenceThicknessMap',
];

/**
 * Dispose every geometry, material and texture under `root`.
 * Textures marked `userData.shared = true` are session-cached singletons
 * (e.g. the procedural relief maps reused across tower re-entries) and are
 * skipped so a re-entry finds them alive.
 */
export function disposeObjectDeep(root: THREE.Object3D): void {
  const geometries = new Set<THREE.BufferGeometry>();
  const materials = new Set<THREE.Material>();
  const textures = new Set<THREE.Texture>();
  root.traverse((object) => {
    if (!(object instanceof THREE.Mesh)) return;
    if (object.geometry) geometries.add(object.geometry);
    const sourceMaterials = Array.isArray(object.material) ? object.material : [object.material];
    for (const material of sourceMaterials) {
      if (!material) continue;
      materials.add(material);
      const record = material as unknown as Record<string, unknown>;
      for (const slot of TEXTURE_SLOTS) {
        const texture = record[slot];
        if (texture instanceof THREE.Texture && texture.userData?.shared !== true) textures.add(texture);
      }
    }
  });
  for (const geometry of geometries) geometry.dispose();
  for (const material of materials) material.dispose();
  for (const texture of textures) texture.dispose();
}
