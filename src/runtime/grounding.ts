import * as THREE from 'three';

const FOUNDATION_PATTERN = /(foundation|platform|podium|base|step|stair|granite|stone|plinth|台基|底座|踏步|台阶|石作)/i;

function materialList(mesh: THREE.Mesh): THREE.Material[] {
  return Array.isArray(mesh.material) ? mesh.material : [mesh.material];
}

function visibleWorldBounds(root: THREE.Object3D): THREE.Box3 {
  root.updateMatrixWorld(true);
  const bounds = new THREE.Box3();
  root.traverse((object) => {
    if (object instanceof THREE.Mesh && object.visible) {
      bounds.union(new THREE.Box3().setFromObject(object));
    }
  });
  return bounds;
}

export function stabilizeFoundationDepth(root: THREE.Object3D): void {
  root.updateMatrixWorld(true);
  const rootBounds = visibleWorldBounds(root);
  const rootHeight = Math.max(rootBounds.max.y - rootBounds.min.y, 0.001);
  const foundationMeshes: Array<{ mesh: THREE.Mesh; minY: number; centerY: number }> = [];

  root.traverse((object) => {
    if (!(object instanceof THREE.Mesh) || !object.visible) return;
    const bounds = new THREE.Box3().setFromObject(object);
    if (bounds.isEmpty()) return;
    const size = bounds.getSize(new THREE.Vector3());
    const signature = `${object.name} ${materialList(object).map((material) => material.name).join(' ')}`;
    const normalizedCenter = (bounds.getCenter(new THREE.Vector3()).y - rootBounds.min.y) / rootHeight;
    const lowBroadSurface = normalizedCenter < 0.2 && size.y < Math.max(size.x, size.z) * 0.5;
    if (FOUNDATION_PATTERN.test(signature) || lowBroadSurface) {
      foundationMeshes.push({
        mesh: object,
        minY: bounds.min.y,
        centerY: bounds.getCenter(new THREE.Vector3()).y,
      });
    }
  });

  foundationMeshes.sort((a, b) => a.minY - b.minY || a.centerY - b.centerY);
  foundationMeshes.forEach(({ mesh }, index) => {
    for (const material of materialList(mesh)) {
      material.depthTest = true;
      material.depthWrite = true;
      material.transparent = false;
      material.opacity = 1;
      material.needsUpdate = true;
    }
    mesh.userData.foundationDepthStabilized = true;
  });
}

export function groundAssembly(assembly: THREE.Object3D, groundY = 0): THREE.Box3 {
  assembly.updateMatrixWorld(true);
  const bounds = visibleWorldBounds(assembly);
  if (bounds.isEmpty()) return bounds;
  assembly.position.y += groundY - bounds.min.y;
  assembly.updateMatrixWorld(true);
  return new THREE.Box3().setFromObject(assembly);
}

// Native site exports often carry below-grade extensions — retaining walls or
// plinth masses sunk beneath the source-scene floor — that hang far beneath
// the walkable base plane. Grounding on the raw minimum would hoist the whole
// building into the air by that buried depth. Instead, ground on the
// structural base: the first mesh band above a large vertical gap in the
// per-mesh minimum-Y distribution, so isolated below-grade extensions stay
// buried under the app ground while the architecture itself meets it.
export function computeStructuralBaseY(root: THREE.Object3D): number {
  root.updateMatrixWorld(true);
  const minYs: number[] = [];
  let maxY = -Infinity;
  root.traverse((object) => {
    if (!(object instanceof THREE.Mesh) || !object.visible) return;
    const bounds = new THREE.Box3().setFromObject(object);
    if (bounds.isEmpty()) return;
    minYs.push(bounds.min.y);
    maxY = Math.max(maxY, bounds.max.y);
  });
  if (minYs.length === 0) return 0;
  minYs.sort((a, b) => a - b);
  const height = Math.max(maxY - minYs[0], 0.001);
  // A band counts as "buried outlier" only when the whole cluster below the
  // gap is a small minority of meshes; a broad bottom cluster is the real
  // base even if a gap follows it.
  const clusterRatioThreshold = 0.05;
  const gapThreshold = height * 0.05;
  for (let i = 1; i < minYs.length; i++) {
    if (minYs[i] - minYs[i - 1] > gapThreshold) {
      if (i / minYs.length >= clusterRatioThreshold) break;
      return minYs[i];
    }
  }
  return minYs[0];
}
