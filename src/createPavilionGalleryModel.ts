import * as THREE from 'three';

export type PavilionId = 'yueyang' | 'huanghe' | 'tengwang';

export type PavilionSpec = {
  id: PavilionId;
  nameCN: string;
  nameEN: string;
  location: string;
  era: string;
  description: string;
  accent: string;
  levels: number[];
  plan: 'square' | 'octagon';
  roof: 'hip' | 'spire' | 'pavilion';
  platform: number;
  roofColor: number;
  timberColor: number;
};

export const PAVILION_SPECS: PavilionSpec[] = [
  { id: 'yueyang', nameCN: '岳阳楼', nameEN: 'YUEYANG TOWER', location: '湖南 · 岳阳', era: '三层盔顶 · 临洞庭湖', description: '飞檐层叠、暗红梁柱与开阔回廊构成的临水楼阁。', accent: '#d58b42', levels: [1.0, 0.86, 0.7], plan: 'square', roof: 'hip', platform: 1.25, roofColor: 0xc88738, timberColor: 0x4b231d },
  { id: 'huanghe', nameCN: '黄鹤楼', nameEN: 'YELLOW CRANE TOWER', location: '湖北 · 武汉', era: '五层重檐 · 高模拆解', description: '保留高模中的密集瓦片、层层翼角、朱红木构、石台栏杆与四向踏道。', accent: '#dfae43', levels: [1.0, 0.9, 0.8, 0.69, 0.57], plan: 'octagon', roof: 'spire', platform: 1.6, roofColor: 0xd19a2c, timberColor: 0x632622 },
  { id: 'tengwang', nameCN: '滕王阁', nameEN: 'TENGWANG PAVILION', location: '江西 · 南昌', era: '高台三重檐 · 宋式序列', description: '高台、回廊与三重屋檐共同强调文阁的横向展开。', accent: '#ca7552', levels: [1.12, 0.96, 0.78], plan: 'square', roof: 'pavilion', platform: 2.05, roofColor: 0xa9472f, timberColor: 0x54221b },
];

type Palette = Record<'stone' | 'stoneDark' | 'timber' | 'timberDark' | 'roof' | 'roofDark' | 'brass' | 'paper', THREE.Material>;

function material(color: number, roughness: number, metalness = 0): THREE.MeshStandardMaterial {
  return new THREE.MeshStandardMaterial({ color, roughness, metalness, envMapIntensity: 0.55 });
}

function palette(spec: PavilionSpec): Palette {
  return {
    stone: material(0x82776a, 0.92), stoneDark: material(0x5e554c, 0.98),
    timber: material(spec.timberColor, 0.62), timberDark: material(0x25130f, 0.75),
    roof: material(spec.roofColor, 0.5), roofDark: material(0x352119, 0.7),
    brass: material(0xc99b48, 0.28, 0.72), paper: material(0xd8c69d, 0.88),
  };
}

function addBox(parent: THREE.Object3D, name: string, size: [number, number, number], position: [number, number, number], mat: THREE.Material, bevel = 0.03): THREE.Mesh {
  const mesh = new THREE.Mesh(new THREE.BoxGeometry(size[0], size[1], size[2], 1, 1, 1), mat);
  mesh.name = name;
  mesh.position.set(...position);
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  mesh.userData.explodeWithParent = true;
  mesh.userData.explodeOrigin = mesh.position.clone();
  parent.add(mesh);
  return mesh;
}

function addColumn(parent: THREE.Object3D, name: string, x: number, y: number, z: number, height: number, radius: number, mat: THREE.Material, sides: number): void {
  const mesh = new THREE.Mesh(new THREE.CylinderGeometry(radius * 0.9, radius, height, sides), mat);
  mesh.name = name;
  mesh.position.set(x, y + height / 2, z);
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  mesh.userData.explodeWithParent = true;
  mesh.userData.explodeOrigin = mesh.position.clone();
  parent.add(mesh);
}

function perimeterPoints(radius: number, sides: number): THREE.Vector3[] {
  const points: THREE.Vector3[] = [];
  for (let index = 0; index < sides; index += 1) {
    const angle = (index / sides) * Math.PI * 2 + (sides === 4 ? Math.PI / 4 : Math.PI / 8);
    points.push(new THREE.Vector3(Math.cos(angle) * radius, 0, Math.sin(angle) * radius));
  }
  return points;
}

function addRailing(parent: THREE.Object3D, name: string, radius: number, y: number, sides: number, mat: THREE.Material): void {
  const points = perimeterPoints(radius, sides);
  for (let side = 0; side < points.length; side += 1) {
    const start = points[side];
    const end = points[(side + 1) % points.length];
    const middle = start.clone().add(end).multiplyScalar(0.5);
    const length = start.distanceTo(end);
    const beam = addBox(parent, `${name}-rail-${side}`, [length, 0.1, 0.12], [middle.x, y, middle.z], mat);
    beam.rotation.y = -Math.atan2(end.z - start.z, end.x - start.x);
    for (let post = 0; post < 4; post += 1) {
      const point = start.clone().lerp(end, (post + 0.5) / 4);
      addColumn(parent, `${name}-baluster-${side}-${post}`, point.x, y - 0.42, point.z, 0.78, 0.035, mat, 6);
    }
  }
}

function addRoof(parent: THREE.Object3D, name: string, radius: number, y: number, sides: number, roofType: PavilionSpec['roof'], p: Palette): void {
  const height = roofType === 'spire' ? radius * 0.86 : radius * 0.47;
  const roof = new THREE.Mesh(new THREE.ConeGeometry(radius * 1.16, height, sides, 2), p.roof);
  roof.name = `${name}-main`;
  roof.position.y = y + height / 2;
  roof.rotation.y = sides === 4 ? Math.PI / 4 : Math.PI / 8;
  roof.castShadow = true;
  roof.receiveShadow = true;
  roof.userData.explodeWithParent = true;
  roof.userData.explodeOrigin = roof.position.clone();
  parent.add(roof);
  const eave = new THREE.Mesh(new THREE.CylinderGeometry(radius * 1.24, radius * 1.17, 0.16, sides), p.roofDark);
  eave.name = `${name}-eave-ring`;
  eave.position.y = y + 0.05;
  eave.castShadow = true;
  eave.receiveShadow = true;
  eave.userData.explodeWithParent = true;
  eave.userData.explodeOrigin = eave.position.clone();
  parent.add(eave);
  if (roofType !== 'spire') {
    const corners = perimeterPoints(radius * 1.19, sides);
    for (let index = 0; index < corners.length; index += 1) {
      const tip = new THREE.Mesh(new THREE.ConeGeometry(0.1, radius * 0.36, 6), p.roof);
      tip.name = `${name}-upturned-eave-${index}`;
      tip.rotation.z = Math.PI / 2.5;
      tip.position.copy(corners[index]);
      tip.position.y = y + 0.16;
      tip.castShadow = true;
      tip.userData.explodeWithParent = true;
      tip.userData.explodeOrigin = tip.position.clone();
      parent.add(tip);
    }
  }
}

function addDougong(parent: THREE.Object3D, name: string, radius: number, y: number, sides: number, p: Palette): void {
  for (const [index, point] of perimeterPoints(radius, sides).entries()) {
    const group = new THREE.Group();
    group.name = `${name}-${index}`;
    group.position.set(point.x, y, point.z);
    group.rotation.y = Math.atan2(point.z, point.x);
    group.userData.explodeWithParent = true;
    group.userData.explodeOrigin = group.position.clone();
    addBox(group, `${name}-${index}-arm-a`, [0.52, 0.14, 0.18], [0.17, 0, 0], p.timberDark);
    addBox(group, `${name}-${index}-arm-b`, [0.28, 0.14, 0.42], [0.07, 0.15, 0], p.timber);
    parent.add(group);
  }
}

export function createPavilionStudyModel(spec: PavilionSpec): THREE.Group {
  const root = new THREE.Group();
  root.name = `${spec.id}-procedural-study`;
  const p = palette(spec);
  const sides = spec.plan === 'octagon' ? 8 : 4;
  const baseRadius = 5.3;
  const platformHeight = spec.platform;
  const base = new THREE.Mesh(new THREE.CylinderGeometry(baseRadius + 1.1, baseRadius + 1.35, platformHeight, sides), p.stone);
  base.name = `${spec.id}-platform`;
  base.position.y = platformHeight / 2;
  base.castShadow = true;
  base.receiveShadow = true;
  base.userData.explodeOrigin = base.position.clone();
  root.add(base);
  const steps = new THREE.Mesh(new THREE.CylinderGeometry(baseRadius + 1.45, baseRadius + 1.7, 0.22, sides), p.stoneDark);
  steps.name = `${spec.id}-platform-step`;
  steps.position.y = 0.11;
  steps.receiveShadow = true;
  steps.userData.explodeOrigin = steps.position.clone();
  root.add(steps);

  let y = platformHeight;
  for (let level = 0; level < spec.levels.length; level += 1) {
    const scale = spec.levels[level];
    const radius = baseRadius * scale;
    const storeyHeight = 2.25 - level * 0.1;
    const floor = new THREE.Mesh(new THREE.CylinderGeometry(radius * 1.01, radius * 1.06, 0.22, sides), p.timberDark);
    floor.name = `${spec.id}-storey-${level + 1}-floor`;
    floor.position.y = y + 0.11;
    floor.castShadow = true;
    floor.receiveShadow = true;
    floor.userData.explodeWithParent = true;
    floor.userData.explodeOrigin = floor.position.clone();
    root.add(floor);
    for (const [index, point] of perimeterPoints(radius * 0.82, sides).entries()) {
      addColumn(root, `${spec.id}-storey-${level + 1}-column-${index}`, point.x, y + 0.22, point.z, storeyHeight, 0.17, p.timber, sides);
    }
    addRailing(root, `${spec.id}-storey-${level + 1}`, radius * 0.97, y + 0.76, sides, p.timber);
    const beamY = y + storeyHeight + 0.14;
    for (const [index, point] of perimeterPoints(radius * 0.95, sides).entries()) {
      const beam = addBox(root, `${spec.id}-storey-${level + 1}-beam-${index}`, [radius * 1.4, 0.22, 0.22], [point.x * 0.5, beamY, point.z * 0.5], p.timberDark);
      beam.rotation.y = Math.atan2(point.z, point.x) + Math.PI / 2;
    }
    addDougong(root, `${spec.id}-storey-${level + 1}-dougong`, radius * 0.9, beamY - 0.06, sides, p);
    addRoof(root, `${spec.id}-storey-${level + 1}-roof`, radius, beamY + 0.16, sides, level === spec.levels.length - 1 ? spec.roof : 'hip', p);
    y = beamY + (level === spec.levels.length - 1 ? radius * 0.55 : radius * 0.42);
  }
  const finial = new THREE.Mesh(new THREE.SphereGeometry(0.25, 12, 8), p.brass);
  finial.name = `${spec.id}-finial`;
  finial.position.y = y + 0.45;
  finial.castShadow = true;
  finial.userData.explodeWithParent = true;
  finial.userData.explodeOrigin = finial.position.clone();
  root.add(finial);
  root.userData.sculptRuntime = { nodes: { root }, meshes: {}, sockets: {}, colliders: {}, destructionGroups: { pavilion: root.children } };
  return root;
}

export function disposePavilionModel(root: THREE.Object3D): void {
  root.traverse((object) => {
    if (!(object instanceof THREE.Mesh)) return;
    object.geometry.dispose();
    const materials = Array.isArray(object.material) ? object.material : [object.material];
    for (const materialItem of materials) materialItem.dispose();
  });
}
