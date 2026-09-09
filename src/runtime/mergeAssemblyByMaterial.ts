import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';

/**
 * 镜像实例的绕序修复: 烘焙带镜像(行列式<0)的节点变换进顶点后,
 * 三角面绕序反转——而 three.js 只对“变换矩阵行列式<0 的对象”做剔除补偿,
 * 烘焙后的合并网格行列式已回正, 补偿消失, 镜像部件会被当成背面整片剔除
 * (门扇镂空、构件凭空缺失)。烘焙时检测到镜像即翻转绕序, 法线保持
 * applyMatrix4 的 normalMatrix 结果(镜像下本来就是对的)。
 */
export function flipWindingIfMirrored(geometry: THREE.BufferGeometry, bakeMatrix: THREE.Matrix4): void {
  if (bakeMatrix.determinant() >= 0) return;
  const index = geometry.getIndex();
  if (index) {
    const array = index.array as Uint16Array | Uint32Array;
    for (let i = 0; i + 2 < array.length; i += 3) {
      const tmp = array[i + 1];
      array[i + 1] = array[i + 2];
      array[i + 2] = tmp;
    }
    index.needsUpdate = true;
  } else {
    for (const name of Object.keys(geometry.attributes)) {
      const attribute = geometry.getAttribute(name) as THREE.BufferAttribute;
      const itemSize = attribute.itemSize;
      const array = attribute.array as Float32Array;
      const tmp = new Float32Array(itemSize);
      for (let v = 0; v + 2 < attribute.count; v += 3) {
        for (let c = 0; c < itemSize; c += 1) tmp[c] = array[(v + 1) * itemSize + c];
        for (let c = 0; c < itemSize; c += 1) array[(v + 1) * itemSize + c] = array[(v + 2) * itemSize + c];
        for (let c = 0; c < itemSize; c += 1) array[(v + 2) * itemSize + c] = tmp[c];
      }
      attribute.needsUpdate = true;
    }
  }
  const morphs = geometry.morphAttributes as unknown as Record<string, THREE.BufferAttribute[] | undefined>;
  for (const key of Object.keys(morphs)) {
    for (const attribute of morphs[key] ?? []) {
      const itemSize = attribute.itemSize;
      const array = attribute.array as Float32Array;
      const tmp = new Float32Array(itemSize);
      for (let v = 0; v + 2 < attribute.count; v += 3) {
        for (let c = 0; c < itemSize; c += 1) tmp[c] = array[(v + 1) * itemSize + c];
        for (let c = 0; c < itemSize; c += 1) array[(v + 1) * itemSize + c] = array[(v + 2) * itemSize + c];
        for (let c = 0; c < itemSize; c += 1) array[(v + 2) * itemSize + c] = tmp[c];
      }
      attribute.needsUpdate = true;
    }
  }
}

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
    const bakeMatrix = new THREE.Matrix4().multiplyMatrices(inverseAssembly, mesh.matrixWorld);
    baked.applyMatrix4(bakeMatrix);
    flipWindingIfMirrored(baked, bakeMatrix);
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
