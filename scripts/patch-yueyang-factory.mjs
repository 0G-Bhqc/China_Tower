import fs from 'node:fs';
import path from 'node:path';

const workspace = path.resolve(import.meta.dirname, '..');
const factoryPath = path.join(workspace, 'src', 'createYueyangTowerModel.ts');
let source = fs.readFileSync(factoryPath, 'utf8');

const helmetRoofHelper = `
function buildHelmetRoofGeometry(segments = 40): THREE.BufferGeometry {
  const stride = segments + 1;
  const positions = [];
  const uvs = [];
  const indices = [];
  const shellThickness = 0.07;

  const heightAt = (u: number, v: number): number => {
    const nx = Math.abs(u * 2 - 1);
    const nz = Math.abs(v * 2 - 1);
    const ring = Math.max(nx, nz);
    const eased = ring * ring * (3 - 2 * ring);
    const crownToEave = THREE.MathUtils.lerp(0.36, -0.23, eased);
    const cornerLift = 0.22 * Math.pow(nx * nz, 2.4);
    return crownToEave + cornerLift;
  };

  for (let layer = 0; layer < 2; layer += 1) {
    for (let z = 0; z <= segments; z += 1) {
      const v = z / segments;
      for (let x = 0; x <= segments; x += 1) {
        const u = x / segments;
        const y = heightAt(u, v) - layer * shellThickness;
        positions.push(u - 0.5, y, v);
        uvs.push(u, v);
      }
    }
  }

  const layerOffset = stride * stride;
  for (let z = 0; z < segments; z += 1) {
    for (let x = 0; x < segments; x += 1) {
      const a = z * stride + x;
      const b = a + 1;
      const c = a + stride;
      const d = c + 1;
      indices.push(a, c, b, b, c, d);
      const aa = a + layerOffset;
      const bb = b + layerOffset;
      const cc = c + layerOffset;
      const dd = d + layerOffset;
      indices.push(aa, bb, cc, bb, dd, cc);
    }
  }

  const perimeter = [];
  for (let x = 0; x <= segments; x += 1) perimeter.push(x);
  for (let z = 1; z <= segments; z += 1) perimeter.push(z * stride + segments);
  for (let x = segments - 1; x >= 0; x -= 1) perimeter.push(segments * stride + x);
  for (let z = segments - 1; z > 0; z -= 1) perimeter.push(z * stride);
  for (let i = 0; i < perimeter.length; i += 1) {
    const a = perimeter[i];
    const b = perimeter[(i + 1) % perimeter.length];
    indices.push(a, b + layerOffset, a + layerOffset, a, b, b + layerOffset);
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
  "const textures = makeReferenceTextureSet(spec, options) ?? makeProceduralTextureSet(id, spec, options);",
  `// Reference-derived maps remain audit evidence until clean crops are admitted.\n  const textures = makeProceduralTextureSet(id, spec, options);`,
);

const componentScales = {
  root: [0.01, 0.01, 0.01],
  granite_base: [17.8, 1.6934288384, 15.1],
  storey_one: [15.0, 4.5964497041, 12.4],
  lower_eave: [18.6, 1.8143880411, 15.5],
  storey_two: [12.8, 3.6287760822, 10.3],
  middle_eave: [15.6, 1.6329492370, 12.9],
  storey_three: [9.9, 3.2054188726, 7.9],
  helmet_roof: [12.5, 3.8706944877, 10.4],
  roof_finial: [0.65, 1.6329492370, 0.65],
};

for (const [token, scale] of Object.entries(componentScales)) {
  const expression = new RegExp(`(mesh_${token}_[0-9]+Geometry\\.scale\\()[^;]+(\\);)`);
  if (!expression.test(source)) throw new Error(`Missing geometry scale for ${token}`);
  source = source.replace(expression, `$1${scale.join(', ')}$2`);
}

fs.writeFileSync(factoryPath, source, 'utf8');
console.log(`Patched ${Object.keys(componentScales).length} component scales and blockout material routing.`);
