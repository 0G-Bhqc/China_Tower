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
