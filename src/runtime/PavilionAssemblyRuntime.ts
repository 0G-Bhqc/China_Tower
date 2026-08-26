import * as THREE from 'three';

export type HighModelAssetId = 'yueyang' | 'huanghe' | 'tengwang' | 'feiyun' | 'penglai';

export type PavilionPartCategory = 'roof' | 'timber' | 'facade' | 'railing' | 'foundation' | 'ornament' | 'envelope';

export type PavilionPartRecord = {
  id: string;
  label: string;
  category: PavilionPartCategory;
  object: THREE.Mesh;
  origin: THREE.Vector3;
  explodeOffset: THREE.Vector3;
};

export type PavilionAssemblyRuntime = {
  assetId: HighModelAssetId;
  parts: PavilionPartRecord[];
  pickables: THREE.Mesh[];
  explodedAmount: number;
  selectedPartId: string | null;
  setExploded: (amount: number) => void;
  pick: (ray: THREE.Ray) => PavilionPartRecord | null;
  selectObject: (object: THREE.Object3D | null) => PavilionPartRecord | null;
  clearSelection: () => void;
  dispose: () => void;
};

const CATEGORY_LABELS: Record<PavilionPartCategory, string> = {
  roof: '屋面与翼角',
  timber: '木构承架',
  facade: '门窗与墙面',
  railing: '围廊与栏杆',
  foundation: '台基与石作',
  ornament: '脊饰与装饰',
  envelope: '建筑构件',
};

function materialSignature(mesh: THREE.Mesh): string {
  const materials = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
  return materials.map((material) => material.name).join(' ').toLowerCase();
}

function classifyPart(
  assetId: HighModelAssetId,
  mesh: THREE.Mesh,
  normalizedHeight: number,
): PavilionPartCategory {
  const signature = `${mesh.name} ${materialSignature(mesh)}`.toLowerCase();
  if (/(rail|balustrade|栏杆|围栏|gallery)/.test(signature)) return 'railing';
  if (/(stone|podium|platform|foundation|step|granite|石|台基|踏步)/.test(signature)) return 'foundation';
  if (/(window|door|lattice|facade|wall|plaster|窗|门|墙)/.test(signature)) return 'facade';
  if (/(gilt|gold|finial|ornament|ridge|雕|饰|脊)/.test(signature)) return 'ornament';
  if (/(roof|tile|eave|瓦|屋面|material #25|material #26)/.test(signature)) return 'roof';
  if (assetId === 'yueyang' && /22732580-02[456]/.test(signature)) return 'roof';
  if (assetId === 'tengwang' && /13009910-(67|69|71)-/.test(signature)) return 'roof';
  if (assetId === 'penglai' && /-033/.test(signature)) return 'roof';
  if (/(timber|wood|column|post|beam|red|木|柱|梁|枋)/.test(signature)) return 'timber';
  if (normalizedHeight < 0.16) return 'foundation';
  if (normalizedHeight > 0.68) return 'roof';
  return 'envelope';
}

function categoryFromSemanticNode(semanticNode: string): PavilionPartCategory | null {
  if (semanticNode === 'foundation' || semanticNode === 'podium') return 'foundation';
  if (semanticNode.startsWith('structural-frame/')) return 'timber';
  if (semanticNode === 'facade/railings') return 'railing';
  if (semanticNode.startsWith('facade/')) return 'facade';
  if (semanticNode === 'roof-system/ornaments-finial' || semanticNode === 'roof-system/ridges' || semanticNode === 'plaques') return 'ornament';
  if (semanticNode.startsWith('roof-system/')) return 'roof';
  if (semanticNode === 'secondary-details') return 'envelope';
  return null;
}

function localOffsetForWorldDirection(
  object: THREE.Object3D,
  worldDirection: THREE.Vector3,
  distance: number,
): THREE.Vector3 {
  const parent = object.parent;
  if (!parent) return worldDirection.clone().multiplyScalar(distance);
  parent.updateWorldMatrix(true, false);
  const worldOrigin = object.getWorldPosition(new THREE.Vector3());
  const worldTarget = worldOrigin.clone().addScaledVector(worldDirection, distance);
  const localOrigin = parent.worldToLocal(worldOrigin.clone());
  const localTarget = parent.worldToLocal(worldTarget);
  return localTarget.sub(localOrigin);
}

function highlightMaterial(source: THREE.Material): THREE.Material {
  const material = source.clone();
  // Material.clone() does not reliably carry application-authored shader
  // callbacks. Preserve semantic PBR overrides used by Feiyun and Penglai so
  // selection adds emissive feedback instead of reverting the mesh to white.
  material.onBeforeCompile = source.onBeforeCompile;
  material.customProgramCacheKey = source.customProgramCacheKey;
  if (material instanceof THREE.MeshStandardMaterial) {
    material.emissive.set(0xd48a20);
    material.emissiveIntensity = 0.42;
  }
  material.name = `${source.name}-selected`;
  return material;
}

export function registerPavilionAssembly(
  root: THREE.Group,
  assembly: THREE.Group,
  assetId: HighModelAssetId,
): PavilionAssemblyRuntime {
  assembly.updateMatrixWorld(true);
  const assemblyBounds = new THREE.Box3().setFromObject(assembly);
  const assemblyCentre = assemblyBounds.getCenter(new THREE.Vector3());
  const assemblySize = assemblyBounds.getSize(new THREE.Vector3());
  const span = Math.max(assemblySize.x, assemblySize.y, assemblySize.z, 1);
  const meshes: THREE.Mesh[] = [];
  assembly.traverse((object) => {
    if (object instanceof THREE.Mesh && object.visible) meshes.push(object);
  });

  const authoredStableIds = new Set<string>();
  const parts = meshes.map((mesh, index): PavilionPartRecord => {
    mesh.geometry.computeBoundingBox();
    const bounds = new THREE.Box3().setFromObject(mesh);
    const centre = bounds.getCenter(new THREE.Vector3());
    const normalizedHeight = THREE.MathUtils.clamp(
      (centre.y - assemblyBounds.min.y) / Math.max(assemblySize.y, 0.001),
      0,
      1,
    );
    const semanticNode = typeof mesh.userData.semanticNode === 'string' ? mesh.userData.semanticNode : null;
    const category = (semanticNode ? categoryFromSemanticNode(semanticNode) : null)
      ?? classifyPart(assetId, mesh, normalizedHeight);
    const authoredStableId = typeof mesh.userData.runtimeStableId === 'string'
      ? mesh.userData.runtimeStableId
      : null;
    if (authoredStableId) {
      if (authoredStableIds.has(authoredStableId)) {
        const deduped = `${authoredStableId}-dup-${index + 1}`;
        console.warn(`Duplicate authored runtime stable ID: ${authoredStableId}, deduplicated to ${deduped}`);
        mesh.userData.runtimeStableId = deduped;
      } else {
        authoredStableIds.add(authoredStableId);
      }
    }
    const id = authoredStableId ?? `${assetId}-${category}-${String(index + 1).padStart(3, '0')}`;
    const direction = centre.clone().sub(assemblyCentre);
    direction.y *= 0.55;
    if (direction.lengthSq() < 0.0001) {
      const angle = index * 2.399963;
      direction.set(Math.cos(angle), normalizedHeight - 0.5, Math.sin(angle));
    }
    direction.normalize();
    const coarseAssemblyFactor = meshes.length <= 3 ? 0.045 : null;
    const distance = span * (coarseAssemblyFactor ?? (category === 'roof' ? 0.16 : category === 'foundation' ? 0.09 : 0.125));
    const explodeOffset = localOffsetForWorldDirection(mesh, direction, distance);
    const origin = mesh.position.clone();
    mesh.name = mesh.name || id;
    mesh.userData.pavilionPart = {
      id,
      label: CATEGORY_LABELS[category],
      category,
      assetId,
      semanticNode,
      sourceObject: mesh.userData.sourceObject ?? null,
      sourceObjectHash: mesh.userData.sourceObjectHash ?? null,
    };
    mesh.userData.pickingPart = id;
    mesh.userData.explodeOrigin = origin.clone();
    mesh.userData.explodeOffset = explodeOffset.clone();
    return { id, label: `${CATEGORY_LABELS[category]} ${String(index + 1).padStart(2, '0')}`, category, object: mesh, origin, explodeOffset };
  });

  let selected: PavilionPartRecord | null = null;
  let selectedOriginalMaterials: THREE.Material[] | null = null;
  let selectedHighlightMaterials: THREE.Material[] = [];

  const clearSelection = () => {
    if (selected && selectedOriginalMaterials) {
      const hadArray = Array.isArray(selected.object.material);
      selected.object.material = hadArray ? selectedOriginalMaterials : selectedOriginalMaterials[0];
    }
    for (const material of selectedHighlightMaterials) material.dispose();
    selectedHighlightMaterials = [];
    selectedOriginalMaterials = null;
    selected = null;
    runtime.selectedPartId = null;
  };

  const runtime: PavilionAssemblyRuntime = {
    assetId,
    parts,
    pickables: meshes,
    explodedAmount: 0,
    selectedPartId: null,
    setExploded: (amount) => {
      const clamped = THREE.MathUtils.clamp(amount, 0, 1);
      runtime.explodedAmount = clamped;
      for (const part of parts) {
        part.object.position.copy(part.origin).addScaledVector(part.explodeOffset, clamped);
        part.object.updateMatrix();
      }
    },
    pick: (ray) => {
      let nearest: PavilionPartRecord | null = null;
      let nearestDistance = Number.POSITIVE_INFINITY;
      const hit = new THREE.Vector3();
      for (const part of parts) {
        if (!part.object.visible) continue;
        const bounds = new THREE.Box3().setFromObject(part.object);
        const point = ray.intersectBox(bounds, hit);
        if (!point) continue;
        const distance = ray.origin.distanceTo(point);
        if (distance < nearestDistance) {
          nearest = part;
          nearestDistance = distance;
        }
      }
      return nearest;
    },
    selectObject: (object) => {
      const part = object ? parts.find((candidate) => candidate.object === object || candidate.object === object.parent) ?? null : null;
      if (!part) {
        clearSelection();
        return null;
      }
      if (selected === part) return part;
      clearSelection();
      selected = part;
      const originals = Array.isArray(part.object.material) ? part.object.material : [part.object.material];
      selectedOriginalMaterials = originals;
      selectedHighlightMaterials = originals.map(highlightMaterial);
      part.object.material = Array.isArray(part.object.material) ? selectedHighlightMaterials : selectedHighlightMaterials[0];
      runtime.selectedPartId = part.id;
      return part;
    },
    clearSelection,
    dispose: () => {
      clearSelection();
      runtime.setExploded(0);
    },
  };

  root.userData.pavilionAssemblyRuntime = runtime;
  root.userData.partCount = parts.length;
  return runtime;
}

export function getPavilionAssemblyRuntime(root: THREE.Object3D | null): PavilionAssemblyRuntime | null {
  return (root?.userData.pavilionAssemblyRuntime as PavilionAssemblyRuntime | undefined) ?? null;
}
