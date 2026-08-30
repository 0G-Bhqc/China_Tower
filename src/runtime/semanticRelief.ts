import * as THREE from 'three';
import {
  generateTengwangRoofTextures,
  generateTengwangWoodTextures,
  generateTengwangWallTextures,
  NORMAL_STRENGTH,
} from '../createTengwangProceduralTextures';

// Zone-matched procedural relief for semantically recolored meshes.
//
// The semantic recolour pass paints albedo as vertex colours on flat
// placeholder geometry; layering the zone normal/roughness maps on top gives
// those surfaces the tile-ridge / wood-grain / plaster bump they otherwise
// lack. Albedo maps are deliberately NOT attached — vertex colours stay the
// single albedo source.
//
// The texture sets are session singletons shared by every tower loader
// (only the normal/roughness patterns are used, which are palette-agnostic),
// so they are flagged `userData.shared` and survive disposeObjectDeep when a
// pavilion is switched out.

type ZoneTextures = { normal: THREE.Texture; roughness: THREE.Texture };

const cache: Partial<Record<'roof' | 'wood' | 'wall', ZoneTextures>> = {};

function markShared(textures: ZoneTextures): ZoneTextures {
  for (const texture of [textures.normal, textures.roughness]) {
    texture.userData = { ...texture.userData, shared: true };
  }
  return textures;
}

function getZoneTextures(zone: 'roof' | 'wood' | 'wall'): ZoneTextures {
  const cachedTextures = cache[zone];
  if (cachedTextures) return cachedTextures;
  let generated: ZoneTextures;
  if (zone === 'roof') generated = generateTengwangRoofTextures('#1f2a25');
  else if (zone === 'wood') generated = generateTengwangWoodTextures('#3a1c16');
  else generated = generateTengwangWallTextures('#5e574b');
  cache[zone] = markShared(generated);
  return cache[zone]!;
}

/**
 * Attach zone-matched normal/roughness relief to every vertex-colour mesh
 * under `root` that carries a `semanticZone` marker. Returns the count of
 * meshes that received relief.
 */
export function applySemanticRelief(root: THREE.Object3D, normalScale = NORMAL_STRENGTH * 0.7): number {
  let applied = 0;
  root.traverse((object) => {
    if (!(object instanceof THREE.Mesh)) return;
    const material = Array.isArray(object.material) ? object.material[0] : object.material;
    if (!(material instanceof THREE.MeshStandardMaterial) || !material.vertexColors) return;
    if (!object.geometry.getAttribute('uv')) return;
    const zone = object.userData.semanticZone as string | null;
    const textures = zone === 'roof'
      ? getZoneTextures('roof')
      : zone === 'timber' || zone === 'vermilion'
        ? getZoneTextures('wood')
        : zone === 'wall' || zone === 'stone'
          ? getZoneTextures('wall')
          : null;
    if (!textures) return;
    material.normalMap = textures.normal;
    material.roughnessMap = textures.roughness;
    material.normalScale.set(normalScale, normalScale);
    material.needsUpdate = true;
    applied += 1;
  });
  return applied;
}
