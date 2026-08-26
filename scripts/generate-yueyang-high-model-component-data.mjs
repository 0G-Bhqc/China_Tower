import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';

const root = process.cwd();
const catalogPath = resolve(root, 'evidence/3d-assets/jobs/yueyang/blender-analysis/high-model-component-catalog.json');
const outputPath = resolve(root, 'src/yueyangHighModelComponentData.ts');

// Labels are assigned only after reviewing the isolated Blender renders.  They
// describe procedural proxy systems, not a claim that raw high-poly geometry is
// shipped to the browser.
// Do not key this mapping on source object names: legacy Max names are mojibake
// in the sanitized FBX.  Count + triangle count + measured envelope is stable
// across those names and is recorded in the catalog for auditability.
const systems = new Map([
  ['50|1238|0.700001,0.050003,3.000001', 'facade-lattice-panel'],
  ['38|1148|0.700001,0.050002,2.4', 'facade-lattice-panel'],
  ['32|1600|0.698825,0.698825,0.179697', 'eave-cap-or-corbel'],
  ['24|804|0.62,0.050001,0.91', 'gallery-infill'],
  ['20|14280|1.517343,1.7238,2.370864', 'dense-dougong-cluster'],
  ['20|60|0.4,0.400001,4.586237', 'timber-post'],
  ['12|36691|1.031441,1.031438,0.923227', 'dense-dougong-cluster'],
  ['12|2092|0.41571,0.415711,0.688486', 'eave-cap-or-corbel'],
  ['12|60|0.4,0.400001,9.474671', 'timber-post'],
  ['12|60|0.4,0.400001,1.709145', 'timber-post'],
  ['12|28|0.15,0.15,1', 'small-post'],
  ['12|28|0.25,0.25,3.216003', 'small-post'],
  ['5|44|0.200001,14.099999,0.400002', 'structural-rail'],
  ['5|44|16.200001,0.200001,0.400004', 'structural-rail'],
]);

const signature = (family) => `${family.instanceCount}|${family.trianglesPerInstance}|${family.medianDimensionsMeters.join(',')}`;

const catalog = JSON.parse(await readFile(catalogPath, 'utf8'));
const families = catalog.families
  .filter((family) => systems.has(signature(family)))
  .map((family) => ({
    id: family.familyId,
    system: systems.get(signature(family)),
    sourceRole: family.inferredRole,
    trianglesPerInstance: family.trianglesPerInstance,
    instances: family.instances.map((instance) => [
      ...instance.center,
      ...instance.dimensions,
    ].map((value) => Number(value.toFixed(6)))),
  }));

const content = `// Generated from the sanitized Yueyang FBX component catalog. Do not hand-edit.\n\n`
  + `export type YueyangHighModelFamily = {\n`
  + `  id: string;\n  system: 'facade-lattice-panel' | 'eave-cap-or-corbel' | 'gallery-infill' | 'dense-dougong-cluster' | 'timber-post' | 'small-post' | 'structural-rail';\n`
  + `  sourceRole: string;\n  trianglesPerInstance: number;\n  instances: readonly (readonly [number, number, number, number, number, number])[];\n};\n\n`
  + `export const yueyangHighModelAxes = { centerX: 13.196891, centerDepth: 9.179454, xScale: 0.9925, heightScale: 0.92, depthScale: 0.79 } as const;\n\n`
  + `export const yueyangHighModelFamilies: readonly YueyangHighModelFamily[] = ${JSON.stringify(families, null, 2)} as const;\n`;

await writeFile(outputPath, content, 'utf8');
console.log(JSON.stringify({ output: outputPath, families: families.length, instances: families.reduce((sum, family) => sum + family.instances.length, 0) }));
