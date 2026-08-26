import fs from 'node:fs';
import path from 'node:path';

const workspace = path.resolve(import.meta.dirname, '..');
const spec = JSON.parse(fs.readFileSync(path.join(workspace, 'object-sculpt-spec.json'), 'utf8'));
const requestedFactory = process.argv[2] ?? 'createYueyangTowerStructuralModel.ts';
const allowedFactories = new Set(['createYueyangTowerStructuralModel.ts', 'createYueyangTowerFormModel.ts']);
if (!allowedFactories.has(requestedFactory)) throw new Error(`Unsupported factory target: ${requestedFactory}`);
const factoryPath = path.join(workspace, 'src', requestedFactory);
const isFormRefinement = requestedFactory === 'createYueyangTowerFormModel.ts';
let source = fs.readFileSync(factoryPath, 'utf8');

const helmetRoofHelper = `
function buildHelmetRoofGeometry(segments = 40): THREE.BufferGeometry {
  const stride = segments + 1;
  const positions: number[] = [];
  const uvs: number[] = [];
  const indices: number[] = [];
  const shellThickness = 0.07;
  const heightAt = (u: number, v: number): number => {
    const nx = Math.abs(u * 2 - 1);
    const nz = Math.abs(v * 2 - 1);
    const ring = Math.max(nx, nz);
    const eased = ring * ring * (3 - 2 * ring);
    return THREE.MathUtils.lerp(0.36, -0.23, eased) + 0.22 * Math.pow(nx * nz, 2.4);
  };
  for (let layer = 0; layer < 2; layer += 1) {
    for (let z = 0; z <= segments; z += 1) {
      const v = z / segments;
      for (let x = 0; x <= segments; x += 1) {
        const u = x / segments;
        positions.push(u - 0.5, heightAt(u, v) - layer * shellThickness, v);
        uvs.push(u, v);
      }
    }
  }
  const offset = stride * stride;
  for (let z = 0; z < segments; z += 1) {
    for (let x = 0; x < segments; x += 1) {
      const a = z * stride + x, b = a + 1, c = a + stride, d = c + 1;
      indices.push(a, c, b, b, c, d, a + offset, b + offset, c + offset, b + offset, d + offset, c + offset);
    }
  }
  const perimeter: number[] = [];
  for (let x = 0; x <= segments; x += 1) perimeter.push(x);
  for (let z = 1; z <= segments; z += 1) perimeter.push(z * stride + segments);
  for (let x = segments - 1; x >= 0; x -= 1) perimeter.push(segments * stride + x);
  for (let z = segments - 1; z > 0; z -= 1) perimeter.push(z * stride);
  for (let i = 0; i < perimeter.length; i += 1) {
    const a = perimeter[i], b = perimeter[(i + 1) % perimeter.length];
    indices.push(a, b + offset, a + offset, a, b, b + offset);
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geometry.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
  geometry.setIndex(indices);
  geometry.computeVertexNormals();
  geometry.computeBoundingBox();
  geometry.computeBoundingSphere();
  return geometry;
}
`;

if (!source.includes('function buildHelmetRoofGeometry(')) {
  const marker = 'function hashString(value: string): number {';
  if (!source.includes(marker)) throw new Error('Missing helper insertion marker');
  source = source.replace(marker, `${helmetRoofHelper}\n${marker}`);
}

source = source.replace(
  /: buildExtrudeGeometry\(\{"points": \[\[-0\.5, 0\.08\][^;]+;/,
  ': buildHelmetRoofGeometry();',
);
source = source.replace(
  'const textures = makeReferenceTextureSet(spec, options) ?? makeProceduralTextureSet(id, spec, options);',
  '// Reference maps remain audit evidence until clean crops are admitted.\n  const textures = makeProceduralTextureSet(id, spec, options);',
);

for (const component of spec.componentTree) {
  const token = component.id.replaceAll('-', '_');
  const { width, height, depth } = component.dimensions;
  const expression = new RegExp(`(mesh_${token}_[0-9]+Geometry\\.scale\\()[^;]+(\\);)`);
  if (!expression.test(source)) throw new Error(`Missing geometry scale for ${component.id}`);
  source = source.replace(expression, `$1${width}, ${height}, ${depth}$2`);
}

const structuralAssembly = `
  // Replace generic radial fallbacks with evidence-aligned rectangular architecture systems.
  for (const name of ['first-storey-columns', 'second-storey-columns', 'third-storey-columns', 'dougong-levels', 'balcony-lattice-bays', 'roof-tile-rows']) {
    const generated = root.getObjectByName(name);
    if (generated?.parent) generated.parent.remove(generated);
  }

  const perimeterSamples = (count: number, width: number, depth: number, y: number) => {
    const result: { position: THREE.Vector3; rotationY: number }[] = [];
    const perimeter = 2 * (width + depth);
    for (let index = 0; index < count; index += 1) {
      let distance = (index / count) * perimeter;
      let x = -width / 2, z = -depth / 2, rotationY = 0;
      if (distance < width) { x += distance; rotationY = 0; }
      else if ((distance -= width) < depth) { x = width / 2; z += distance; rotationY = Math.PI / 2; }
      else if ((distance -= depth) < width) { x = width / 2 - distance; z = depth / 2; rotationY = Math.PI; }
      else { distance -= width; z = depth / 2 - distance; rotationY = -Math.PI / 2; }
      result.push({ position: new THREE.Vector3(x, y, z), rotationY });
    }
    return result;
  };

  const addPerimeterCluster = (
    name: string,
    count: number,
    width: number,
    depth: number,
    y: number,
    scale: [number, number, number],
    geometry: THREE.BufferGeometry,
    material: THREE.Material,
  ) => {
    const cluster = new THREE.InstancedMesh(geometry, material, count);
    const matrix = new THREE.Matrix4();
    const quaternion = new THREE.Quaternion();
    const instanceScale = new THREE.Vector3(...scale);
    perimeterSamples(count, width, depth, y).forEach((sample, index) => {
      quaternion.setFromAxisAngle(new THREE.Vector3(0, 1, 0), sample.rotationY);
      matrix.compose(sample.position, quaternion, instanceScale);
      cluster.setMatrixAt(index, matrix);
    });
    cluster.instanceMatrix.needsUpdate = true;
    cluster.castShadow = options.castShadow ?? true;
    cluster.receiveShadow = options.receiveShadow ?? true;
    cluster.name = name;
    cluster.userData.sculptRepetitionSystem = name;
    root.add(cluster);
    return cluster;
  };

  const red = materialMap['red-lacquer'] ?? new THREE.MeshStandardMaterial({ color: '#641a18' });
  const timber = materialMap['dark-timber'] ?? new THREE.MeshStandardMaterial({ color: '#211817' });
  const postGeometry = new THREE.CylinderGeometry(0.5, 0.5, 1, 20, 1);
  addPerimeterCluster('first-storey-columns', 24, 14.5, 11.8, 3.99, [0.42, 4.29, 0.42], postGeometry, red);
  addPerimeterCluster('second-storey-columns', 20, 12.2, 9.7, 8.95, [0.34, 3.33, 0.34], postGeometry, red);
  addPerimeterCluster('third-storey-columns', 16, 9.3, 7.3, 13.49, [0.3, 2.84, 0.3], postGeometry, red);

  const bracketGeometry = new THREE.BoxGeometry(1, 1, 1);
  addPerimeterCluster('dougong-level-one', 16, 15.2, 12.5, 6.22, [0.55, 0.29, 0.36], bracketGeometry, timber);
  addPerimeterCluster('dougong-level-two', 16, 12.9, 10.4, 10.72, [0.48, 0.27, 0.32], bracketGeometry, timber);
  addPerimeterCluster('dougong-level-three', 12, 10.0, 7.9, 15.13, [0.42, 0.25, 0.3], bracketGeometry, timber);

  for (const id of ['railing-front', 'railing-back', 'railing-left', 'railing-right']) {
    const railingMesh = meshes[id];
    if (railingMesh) {
      railingMesh.visible = true;
      railingMesh.scale.y = 0.13;
      railingMesh.position.y = 0.46;
      railingMesh.userData.explodeWithParent = true;
    }
  }
  addPerimeterCluster('balcony-lattice-bays', 44, 13.6, 11.5, 8.09, [0.09, 1.02, 0.09], bracketGeometry, timber);

  // The authored storey masses become inner wall cores so the exterior timber skeleton remains visible.
  meshes['storey-one']?.scale.set(0.84, 0.95, 0.82);
  meshes['storey-two']?.scale.set(0.84, 0.95, 0.82);
  meshes['storey-three']?.scale.set(0.84, 0.95, 0.82);
`;

const runtimeMarker = '  root.userData.sculptRuntime = { nodes, meshes, sockets, colliders, destructionGroups } satisfies ProceduralModelRuntime;';
if (!source.includes('Replace generic radial fallbacks with evidence-aligned rectangular architecture systems.')) {
  if (!source.includes(runtimeMarker)) throw new Error('Missing structural assembly insertion marker');
  source = source.replace(runtimeMarker, `${structuralAssembly}\n${runtimeMarker}`);
}

const formRefinement = `
  // Form refinement: convert facade carriers into layered geometry without inventing exact glyphs.
  const detailGroup = new THREE.Group();
  detailGroup.name = 'facade-and-bracket-details';
  detailGroup.userData.explodeWithParent = true;
  root.add(detailGroup);

  const darkDetail = materialMap['dark-timber'] ?? new THREE.MeshStandardMaterial({ color: '#211817' });
  const goldDetail = materialMap['gold-accent'] ?? new THREE.MeshStandardMaterial({ color: '#b47d23' });
  const addDetailBox = (
    parent: THREE.Object3D,
    size: [number, number, number],
    position: [number, number, number],
    material: THREE.Material,
  ) => {
    const mesh = new THREE.Mesh(new THREE.BoxGeometry(...size), material);
    mesh.position.set(...position);
    mesh.castShadow = options.castShadow ?? true;
    mesh.receiveShadow = options.receiveShadow ?? true;
    mesh.userData.explodeWithParent = true;
    parent.add(mesh);
    return mesh;
  };

  const doorCarrier = meshes['door-lattice-carrier'];
  if (doorCarrier) doorCarrier.material = darkDetail;
  const doorNode = nodes['door-lattice-carrier'] ?? detailGroup;
  for (let index = -5; index <= 5; index += 1) {
    addDetailBox(doorNode, [0.045, 2.52, 0.055], [index * 0.78, 0, 0.045], goldDetail);
  }
  for (let index = -2; index <= 2; index += 1) {
    addDetailBox(doorNode, [8.7, 0.045, 0.055], [0, index * 0.48, 0.045], goldDetail);
  }

  const plaque = meshes['upper-plaque'];
  if (plaque) plaque.material = darkDetail;
  const plaqueNode = nodes['upper-plaque'] ?? detailGroup;
  addDetailBox(plaqueNode, [3.3, 0.78, 0.08], [0, 0, 0.05], darkDetail);
  for (let index = -1; index <= 1; index += 1) {
    addDetailBox(plaqueNode, [0.24, 0.48, 0.06], [index * 0.72, 0, 0.11], goldDetail).rotation.z = index * 0.12;
  }

  const bracketGeometryLong = new THREE.BoxGeometry(1, 1, 1);
  addPerimeterCluster('dougong-step-one', 16, 15.2, 12.5, 6.48, [0.36, 0.19, 0.64], bracketGeometryLong, timber);
  addPerimeterCluster('dougong-step-two', 16, 12.9, 10.4, 10.96, [0.32, 0.17, 0.56], bracketGeometryLong, timber);
  addPerimeterCluster('dougong-step-three', 12, 10.0, 7.9, 15.35, [0.29, 0.16, 0.5], bracketGeometryLong, timber);
`;

if (isFormRefinement && !source.includes('Form refinement: convert facade carriers into layered geometry')) {
  if (!source.includes(runtimeMarker)) throw new Error('Missing form refinement insertion marker');
  source = source.replace(runtimeMarker, `${formRefinement}\n${runtimeMarker}`);
}

fs.writeFileSync(factoryPath, source, 'utf8');
console.log(`Patched ${spec.componentTree.length} ${isFormRefinement ? 'form' : 'structural'} components and rectangular repetition systems.`);
