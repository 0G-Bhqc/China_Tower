import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';

const GLB_URL = '/evidence/v3/feiyun/semantic-hierarchy/review-001/feiyun-semantic-hierarchy.review.glb';

const scene = new THREE.Scene();
scene.background = new THREE.Color(0x071018);
scene.fog = new THREE.FogExp2(0x071018, 0.0022);

const camera = new THREE.PerspectiveCamera(42, innerWidth / innerHeight, 0.05, 4000);
const renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: 'high-performance' });
renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
renderer.setSize(innerWidth, innerHeight);
renderer.outputColorSpace = THREE.SRGBColorSpace;
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.15;
document.body.append(renderer.domElement);

const controls = new OrbitControls(camera, renderer.domElement);
controls.enableDamping = true;
controls.dampingFactor = 0.06;
controls.screenSpacePanning = true;

scene.add(new THREE.HemisphereLight(0xcce9ff, 0x26313a, 2.1));
const keyLight = new THREE.DirectionalLight(0xfff1d7, 3.2);
keyLight.position.set(22, 28, 18);
scene.add(keyLight);
const rimLight = new THREE.DirectionalLight(0x76cfff, 2.0);
rimLight.position.set(-20, 15, -24);
scene.add(rimLight);

const grid = new THREE.GridHelper(120, 60, 0x31556b, 0x173040);
grid.material.opacity = 0.35;
grid.material.transparent = true;
scene.add(grid);

const statusElement = document.querySelector<HTMLDivElement>('#status')!;
const selectionElement = document.querySelector<HTMLDivElement>('#selection')!;
const semanticSelect = document.querySelector<HTMLSelectElement>('#semantic')!;
const explodeInput = document.querySelector<HTMLInputElement>('#explode')!;
const resetButton = document.querySelector<HTMLButtonElement>('#reset')!;
const wireframeButton = document.querySelector<HTMLButtonElement>('#wireframe')!;

type PreviewPart = {
  mesh: THREE.Mesh;
  semanticNode: string;
  stableId: string;
  origin: THREE.Vector3;
  explodeOffset: THREE.Vector3;
};

const parts: PreviewPart[] = [];
let model: THREE.Object3D | null = null;
let modelBounds = new THREE.Box3();
let wireframe = false;
let selected: THREE.Mesh | null = null;
let selectedMaterials: THREE.Material[] = [];

function fitCamera(): void {
  if (!model) return;
  model.updateMatrixWorld(true);
  modelBounds.setFromObject(model);
  const center = modelBounds.getCenter(new THREE.Vector3());
  const size = modelBounds.getSize(new THREE.Vector3());
  const span = Math.max(size.x, size.y, size.z, 1);
  camera.near = Math.max(span / 2000, 0.02);
  camera.far = span * 30;
  camera.position.copy(center).add(new THREE.Vector3(0.95, 0.72, 1.15).normalize().multiplyScalar(span * 1.65));
  controls.target.copy(center).add(new THREE.Vector3(0, size.y * 0.08, 0));
  camera.updateProjectionMatrix();
  controls.update();
  grid.position.y = modelBounds.min.y;
}

function clearSelection(): void {
  if (!selected) return;
  const active = Array.isArray(selected.material) ? selected.material : [selected.material];
  active.forEach((material) => material.dispose());
  selected.material = selectedMaterials.length === 1 ? selectedMaterials[0] : selectedMaterials;
  selected = null;
  selectedMaterials = [];
}

function selectMesh(mesh: THREE.Mesh): void {
  clearSelection();
  selected = mesh;
  selectedMaterials = (Array.isArray(mesh.material) ? mesh.material : [mesh.material]).slice();
  const highlighted = selectedMaterials.map((source) => {
    const material = source.clone();
    if (material instanceof THREE.MeshStandardMaterial) {
      material.emissive.set(0x42d9ff);
      material.emissiveIntensity = 0.75;
    }
    return material;
  });
  mesh.material = highlighted.length === 1 ? highlighted[0] : highlighted;
  selectionElement.textContent = `${mesh.userData.semanticNode ?? 'unknown'} · ${mesh.userData.runtimeStableId ?? mesh.name}`;
}

new GLTFLoader().load(
  GLB_URL,
  (gltf) => {
    model = gltf.scene;
    scene.add(model);
    model.updateMatrixWorld(true);
    const initialBounds = new THREE.Box3().setFromObject(model);
    const buildingCenter = initialBounds.getCenter(new THREE.Vector3());
    const semanticNodes = new Set<string>();
    model.traverse((object) => {
      if (!(object instanceof THREE.Mesh)) return;
      const semanticNode = String(object.userData.semanticNode ?? 'unmapped');
      const stableId = String(object.userData.runtimeStableId ?? object.name);
      semanticNodes.add(semanticNode);
      object.geometry.computeBoundingBox();
      const center = new THREE.Box3().setFromObject(object).getCenter(new THREE.Vector3());
      const direction = center.sub(buildingCenter);
      direction.y *= 0.55;
      if (direction.lengthSq() < 0.001) direction.set(0, 1, 0);
      direction.normalize();
      parts.push({
        mesh: object,
        semanticNode,
        stableId,
        origin: object.position.clone(),
        explodeOffset: direction.multiplyScalar(initialBounds.getSize(new THREE.Vector3()).length() * 0.055),
      });
    });
    [...semanticNodes].sort().forEach((semanticNode) => {
      const option = document.createElement('option');
      option.value = semanticNode;
      option.textContent = semanticNode;
      semanticSelect.append(option);
    });
    statusElement.textContent = `已加载：${parts.length} 个 GLB Mesh 节点，拖动旋转，滚轮缩放。`;
    fitCamera();
  },
  (event) => {
    if (!event.total) return;
    statusElement.textContent = `正在加载高模：${Math.round((event.loaded / event.total) * 100)}%`;
  },
  (error) => {
    statusElement.textContent = `加载失败：${error instanceof Error ? error.message : String(error)}`;
  },
);

semanticSelect.addEventListener('change', () => {
  clearSelection();
  const target = semanticSelect.value;
  parts.forEach((part) => { part.mesh.visible = target === 'all' || part.semanticNode === target; });
});

explodeInput.addEventListener('input', () => {
  const amount = Number(explodeInput.value);
  parts.forEach((part) => part.mesh.position.copy(part.origin).addScaledVector(part.explodeOffset, amount));
});

resetButton.addEventListener('click', () => {
  explodeInput.value = '0';
  parts.forEach((part) => { part.mesh.position.copy(part.origin); part.mesh.visible = true; });
  semanticSelect.value = 'all';
  clearSelection();
  fitCamera();
});

wireframeButton.addEventListener('click', () => {
  wireframe = !wireframe;
  parts.forEach((part) => {
    const materials = Array.isArray(part.mesh.material) ? part.mesh.material : [part.mesh.material];
    materials.forEach((material) => {
      if (material instanceof THREE.MeshStandardMaterial) material.wireframe = wireframe;
    });
  });
  wireframeButton.textContent = `线框：${wireframe ? '开' : '关'}`;
});

const raycaster = new THREE.Raycaster();
const pointer = new THREE.Vector2();
renderer.domElement.addEventListener('pointerdown', (event) => {
  pointer.x = (event.clientX / innerWidth) * 2 - 1;
  pointer.y = -(event.clientY / innerHeight) * 2 + 1;
  raycaster.setFromCamera(pointer, camera);
  const hits = raycaster.intersectObjects(parts.map((part) => part.mesh), false);
  if (hits[0]?.object instanceof THREE.Mesh) selectMesh(hits[0].object);
});

addEventListener('resize', () => {
  camera.aspect = innerWidth / innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(innerWidth, innerHeight);
});

renderer.setAnimationLoop(() => {
  controls.update();
  renderer.render(scene, camera);
});
