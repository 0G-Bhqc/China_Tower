import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';

/**
 * Merge per-material geometry groups into single meshes so multi-thousand-mesh
 * GLB masters stop costing one draw call per mesh. Multi-material meshes and
 * non-indexed geometry are kept intact. Safety rules learned the hard way:
 *  - groups are keyed on material + FULL attribute/morph signature;
 *  - merging always works on CLONES (originals are never mutated), so a group
 *    whose mergeGeometries fails is re-added exactly as it was — components
 *    can never silently disappear;
 *  - original geometries are disposed only after their group merged cleanly.
 * Run AFTER the assembly's final placement and BEFORE
 * registerPavilionAssembly. Returns the resulting visible mesh count.
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
  type Group = { material: THREE.Material; geometries: THREE.BufferGeometry[]; owners: THREE.Mesh[] };
  const groups = new Map<string, Group>();
  const kept: THREE.Mesh[] = [];
  const seenGeometries = new Set<THREE.BufferGeometry>();
  const disposedOriginals = new Set<THREE.BufferGeometry>();
  for (const mesh of meshList) {
    const materials = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
    const geometry = mesh.geometry;
    if (materials.length !== 1 || !geometry.index) {
      kept.push(mesh);
      continue;
    }
    const morphCount = Object.keys(geometry.morphAttributes).length;
    const attributesKey = Object.keys(geometry.attributes).sort()
      .map((name) => `${name}:${geometry.getAttribute(name).itemSize}`)
      .join('|');
    const key = `${materials[0].uuid}::${attributesKey}::morph${morphCount}`;
    let group = groups.get(key);
    if (!group) {
      group = { material: materials[0], geometries: [], owners: [] };
      groups.set(key, group);
    }
    // Always bake into a clone: originals must survive untouched for the
    // failure fallback (and some geometries are shared by several meshes).
    const baked = geometry.clone();
    baked.applyMatrix4(new THREE.Matrix4().multiplyMatrices(inverseAssembly, mesh.matrixWorld));
    group.geometries.push(baked);
    group.owners.push(mesh);
  }
  // Merge per group; only successful groups consume their members.
  let mergedIndex = 0;
  for (const group of groups.values()) {
    if (group.geometries.length === 0) continue;
    let merged: THREE.BufferGeometry | null = null;
    if (group.geometries.length === 1) {
      merged = group.geometries[0];
    } else {
      try {
        merged = mergeGeometries(group.geometries, false);
      } catch {
        merged = null;
      }
    }
    if (!merged) {
      // Failure fallback: original meshes stay exactly as they were.
      for (const owner of group.owners) assembly.add(owner);
      continue;
    }
    merged.computeBoundingBox();
    merged.computeBoundingSphere();
    const mesh = new THREE.Mesh(merged, group.material);
    mesh.name = `merged-component-${String(mergedIndex).padStart(3, '0')}`;
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    assembly.add(mesh);
    mergedIndex += 1;
    for (const owner of group.owners) {
      owner.parent?.remove(owner);
      if (!disposedOriginals.has(owner.geometry)) {
        disposedOriginals.add(owner.geometry);
        owner.geometry.dispose();
      }
    }
    for (const baked of group.geometries) baked.dispose();
  }
  for (const mesh of kept) assembly.add(mesh);
  // Dispose the original geometries of successfully merged groups (once per
  // unique geometry; merged outputs are fresh buffers).
  return mergedIndex + kept.length;
}
