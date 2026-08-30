import * as THREE from 'three';
import type { PavilionId } from '../createPavilionGalleryModel';
import { createPlaqueMesh } from './createPlaqueMesh';
import { createRockSurfaceTextures } from './proceduralSurfaces';

// 场景碑匾:程序化石碑立于临水广场前侧缘,铭刻各楼名句,点击打开诗文面板
// 对应篇目。碑身用 createRockSurfaceTextures 的程序化石纹,碑面铭文走
// createPlaqueMesh 的竖排(自右向左)画布。

export type StelePlacement = {
  position: [number, number];
  rotationY: number;
  faceWidth: number;
  faceHeight: number;
  lines: string[];
  caption: string;
  workIndex: number;
};

// Placement lives on the shared plaza (radius 34): all three steles sit at the
// same clear angle on the camera side so each tower gets the same foreground
// composition. Radius per tower clears its own podium footprint; fine-tuned
// against screenshots.
const STELE_SPECS: Record<PavilionId, StelePlacement> = {
  yueyang: {
    position: [24.5, 10.5],
    rotationY: 0.62,
    faceWidth: 2.0,
    faceHeight: 2.6,
    lines: ['先天下之忧而忧', '后天下之乐而乐'],
    caption: '宋 · 范仲淹《岳阳楼记》',
    workIndex: 0,
  },
  huanghe: {
    position: [24.5, 10.5],
    rotationY: 0.62,
    faceWidth: 3.4,
    faceHeight: 2.5,
    lines: [
      '昔人已乘黄鹤去',
      '此地空余黄鹤楼',
      '黄鹤一去不复返',
      '白云千载空悠悠',
      '晴川历历汉阳树',
      '芳草萋萋鹦鹉洲',
      '日暮乡关何处是',
      '烟波江上使人愁',
    ],
    caption: '唐 · 崔颢《黄鹤楼》',
    workIndex: 0,
  },
  tengwang: {
    position: [26.5, 11.5],
    rotationY: 0.62,
    faceWidth: 2.0,
    faceHeight: 2.6,
    lines: ['落霞与孤鹜齐飞', '秋水共长天一色'],
    caption: '唐 · 王勃《滕王阁序》',
    workIndex: 0,
  },
};

let cachedStone: { albedo: THREE.Texture; normal: THREE.Texture } | null = null;
function getStoneTextures(): { albedo: THREE.Texture; normal: THREE.Texture } {
  if (!cachedStone) cachedStone = createRockSurfaceTextures('#8f887a', 512);
  return cachedStone;
}

export function createPavilionStele(id: PavilionId): THREE.Group {
  const spec = STELE_SPECS[id];
  const group = new THREE.Group();
  group.name = `${id}-poetry-stele`;
  group.userData.steleWorkIndex = spec.workIndex;
  group.userData.stelePavilion = id;

  const stone = getStoneTextures();
  const bodyMaterial = new THREE.MeshStandardMaterial({
    color: 0xffffff,
    map: stone.albedo,
    normalMap: stone.normal,
    roughness: 0.94,
    metalness: 0,
  });
  bodyMaterial.name = `${id}-stele-stone`;

  const addBox = (
    name: string,
    size: [number, number, number],
    position: [number, number, number],
  ): THREE.Mesh => {
    const mesh = new THREE.Mesh(new THREE.BoxGeometry(...size), bodyMaterial);
    mesh.name = `${id}-stele-${name}`;
    mesh.position.set(...position);
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    group.add(mesh);
    return mesh;
  };

  // Total height ≈ 0.42 (base) + 0.3 (step) + faceHeight slab + 0.28 (cap).
  addBox('base', [spec.faceWidth * 1.55, 0.42, spec.faceWidth * 0.95], [0, 0.21, 0]);
  addBox('step', [spec.faceWidth * 1.3, 0.3, spec.faceWidth * 0.8], [0, 0.55, 0]);
  const slabDepth = spec.faceWidth * 0.22;
  addBox('slab', [spec.faceWidth * 1.06, spec.faceHeight + 0.62, slabDepth], [0, 0.7 + (spec.faceHeight + 0.62) / 2, 0]);
  addBox('cap', [spec.faceWidth * 1.24, 0.28, slabDepth * 1.35], [0, 0.7 + spec.faceHeight + 0.62 + 0.14, 0]);

  // Inscribed face slightly proud of the slab front to avoid z-fighting.
  const face = createPlaqueMesh({
    lines: spec.lines,
    caption: spec.caption,
    width: spec.faceWidth,
    height: spec.faceHeight,
    bgColor: '#a89f8c',
    textColor: '#332a20',
    position: [0, 0, 0],
  });
  face.name = `${id}-stele-inscription`;
  face.position.set(0, 0.7 + 0.31 + (spec.faceHeight + 0.62) / 2, slabDepth / 2 + 0.012);
  group.add(face);

  group.position.set(spec.position[0], 0, spec.position[1]);
  group.rotation.y = spec.rotationY;
  return group;
}

export function createPavilionSteles(): Record<PavilionId, THREE.Group> {
  const steles = {} as Record<PavilionId, THREE.Group>;
  for (const id of ['yueyang', 'huanghe', 'tengwang'] as PavilionId[]) {
    steles[id] = createPavilionStele(id);
  }
  return steles;
}

// Walk up from a picked child to the owning stele group (picking hit-tests the
// inscription plane and stone boxes, not the group itself).
export function findSteleRoot(object: THREE.Object3D): THREE.Group | null {
  let current: THREE.Object3D | null = object;
  while (current) {
    if (typeof current.userData.steleWorkIndex === 'number') return current as THREE.Group;
    current = current.parent;
  }
  return null;
}
