import { createHash } from 'node:crypto';
import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const expectedIds = ['feiyun', 'huanghe', 'penglai', 'tengwang', 'yueyang'];
const requiredViews = ['front', 'three-quarter', 'right', 'rear', 'left', 'elevated', 'low-angle'];
const requiredPasses = ['beauty', 'alpha-silhouette', 'semantic-id', 'depth', 'normal', 'roughness-material-id'];
const requiredNodes = ['foundation', 'podium', 'structural-frame/columns', 'structural-frame/beams', 'structural-frame/brackets-dougong', 'facade/walls', 'facade/doors-windows', 'facade/railings', 'roof-system/tiles', 'roof-system/eaves', 'roof-system/ridges', 'roof-system/ornaments-finial', 'plaques'];

async function json(relativePath) {
  return JSON.parse(await readFile(path.join(projectRoot, relativePath), 'utf8'));
}

async function sha256(filePath) {
  return createHash('sha256').update(await readFile(filePath)).digest('hex');
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

const baseline = await json('evidence/v3/baseline-manifest.json');
const ids = [...baseline.scope.assetIds].sort();
assert(JSON.stringify(ids) === JSON.stringify(expectedIds), `V3 scope must be exactly five assets: ${ids.join(', ')}`);
assert(!ids.includes('guanque'), 'guanque must not be a V3 product asset');
assert(baseline.stoppedLegacyState.status === 'stopped', 'legacy img2threejs state must remain stopped');
assert(baseline.stoppedLegacyState.policy.includes('never'), 'legacy stop policy must be explicit');

const frozenManifestPath = path.join(projectRoot, baseline.frozenRuntimeManifest.path);
await stat(frozenManifestPath);
assert(await sha256(frozenManifestPath) === baseline.frozenRuntimeManifest.sha256, 'frozen runtime manifest hash mismatch');
const frozenManifest = JSON.parse(await readFile(frozenManifestPath, 'utf8'));
assert(JSON.stringify(frozenManifest.assets.map((asset) => asset.id).sort()) === JSON.stringify(expectedIds), 'frozen runtime manifest product IDs mismatch');

for (const assetId of expectedIds) {
  const job = await json(`evidence/v3/${assetId}/job.json`);
  assert(job.assetId === assetId, `${assetId}: job asset ID mismatch`);
  assert(job.track === 'dcc-highmodel-v3', `${assetId}: wrong track`);
  assert(job.source.inventory.meshes > 0 && job.source.inventory.triangles > 0, `${assetId}: missing source inventory`);
  await stat(path.join(projectRoot, job.source.fullSceneFbx));
  await stat(path.join(projectRoot, job.source.legacyHierarchy));
  assert(job.baseline.frozenRuntimeManifestSha256 === baseline.frozenRuntimeManifest.sha256, `${assetId}: baseline hash mismatch`);
  assert(requiredViews.every((view) => job.reviewContract.views.includes(view)), `${assetId}: incomplete seven-view contract`);
  assert(requiredPasses.every((pass) => job.reviewContract.passes.includes(pass)), `${assetId}: incomplete review pass contract`);
  assert(requiredNodes.every((node) => job.semanticContract.requiredNodes.includes(node)), `${assetId}: missing mandatory semantic nodes`);
  assert(job.semanticContract.mappingChain.join('>') === 'sourceObject>blenderObject>semanticNode>glbNode>runtimeStableId', `${assetId}: invalid mapping chain`);
  assert(job.correctionPolicy.maximumPerPass === 3 && job.correctionPolicy.maximumTotal === 6, `${assetId}: unbounded correction policy`);
}

console.log(JSON.stringify({ status: 'passed', assetCount: expectedIds.length, frozenRuntimeSha256: baseline.frozenRuntimeManifest.sha256 }, null, 2));
