import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';

/**
 * Merge per-material geometry groups into single meshes so multi-thousand-mesh
 * GLB masters stop costing one draw call per mesh. Multi-material meshes and
 * non-indexed geometry are kept intact; registered assembly parts become the
 * merged groups (pick/explode operate at that granularity). Merged meshes
 * bake their assembly-relative transform, so callers must run this AFTER the
 * assembly's final placement and BEFORE registerPavilionAssembly.
 * Returns the resulting visible mesh count.
 */
export function mergeAssemblyByMaterial(assembly: THREE.Group): number {
  assembly.updateMatrixWorld(true);
  // Bake each mesh's transform RELATIVE to the assembly, not world: merged
  // meshes re-enter as children of the assembly and must not inherit its
  // scale/position a second time.
  const inverseAssembly = new THREE.Matrix4().copy(assembly.matrixWorld).invert();
  const meshList: THREE.Mesh[] = [];
  assembly.traverse((object) => {
    if ((object as THREE.Mesh).isMesh) meshList.push(object as THREE.Mesh);
  });
  type Group = { material: THREE.Material; attributesKey: string; geometries: THREE.BufferGeometry[] };
  const groups = new Map<string, Group>();
  const kept: THREE.Mesh[] = [];
  const seenGeometries = new Set<THREE.BufferGeometry>();
  const bakedGeometries: THREE.BufferGeometry[] = [];
  for (const mesh of meshList) {
    const materials = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
    const geometry = mesh.geometry;
    if (materials.length !== 1 || !geometry.index) {
      kept.push(mesh);
      continue;
    }
    const attributesKey = Object.keys(geometry.attributes).sort()
      .map((name) => `${name}:${geometry.getAttribute(name).itemSize}`)
      .join('|');
    const key = `${materials[0].uuid}::${attributesKey}`;
    let group = groups.get(key);
    if (!group) {
      group = { material: materials[0], attributesKey, geometries: [] };
      groups.set(key, group);
    }
    // A geometry reused by several meshes must be cloned per instance before
    // its assembly-relative transform is baked in.
    let baked = geometry;
    if (seenGeometries.has(geometry)) baked = geometry.clone();
    seenGeometries.add(geometry);
    baked.applyMatrix4(new THREE.Matrix4().multiplyMatrices(inverseAssembly, mesh.matrixWorld));
    bakedGeometries.push(baked);
    group.geometries.push(baked);
  }

  for (const mesh of meshList) mesh.parent?.remove(mesh);

  let mergedIndex = 0;
  for (const group of groups.values()) {
    if (group.geometries.length === 0) continue;
    const merged = group.geometries.length === 1
      ? group.geometries[0]
      : mergeGeometries(group.geometries, false);
    if (!merged) continue;
    merged.computeBoundingBox();
    merged.computeBoundingSphere();
    const mesh = new THREE.Mesh(merged, group.material);
    mesh.name = `merged-component-${String(mergedIndex).padStart(3, '0')}`;
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    assembly.add(mesh);
    mergedIndex += 1;
  }
  for (const mesh of kept) assembly.add(mesh);
  for (const geometry of bakedGeometries) geometry.dispose();
  return mergedIndex + kept.length;
}
