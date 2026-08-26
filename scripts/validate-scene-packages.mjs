import { readFile, stat } from 'node:fs/promises';
import { resolve } from 'node:path';

const workspace = resolve(import.meta.dirname, '..');
const packages = ['yueyang', 'huanghe', 'tengwang'];
const assert = (condition, message) => { if (!condition) throw new Error(message); };

for (const id of packages) {
  const report = JSON.parse(await readFile(resolve(workspace, `evidence/scene-packs/${id}-environment.json`), 'utf8'));
  assert(report.schemaVersion === 1 && report.assetId === id, `Invalid scene report: ${id}`);
  assert(report.admission?.method === 'reviewed source-object spatial envelope', `Admission method drift: ${id}`);
  if (id === 'yueyang') {
    assert(report.admission.admittedObjects === 0, 'Yueyang must remain explicitly marked as having no independent source environment mesh');
    assert(report.admission.status === 'source-scene-has-no-independent-environment-mesh', 'Yueyang no-environment status drift');
    continue;
  }
  assert(report.admission.admittedObjects > 0, `No admitted environment objects: ${id}`);
  assert(report.output?.meshCount > 0 && report.output?.triangles > 0, `Empty environment output: ${id}`);
  assert(Array.isArray(report.nodes) && report.nodes.length === report.output.meshCount, `Node report drift: ${id}`);
  assert(report.nodes.every((node) => node.sourceObject && node.sceneNode && ['near', 'mid', 'far'].includes(node.layer)), `Provenance/layer metadata missing: ${id}`);
  const file = resolve(workspace, `public/assets/scene-pack/${id}-environment.glb`);
  const info = await stat(file);
  assert(info.isFile() && info.size > 0, `Missing scene package: ${id}`);
}
console.log('Scene package validation OK: Huanghe and Tengwang source packages present; Yueyang explicitly source-backed empty.');
