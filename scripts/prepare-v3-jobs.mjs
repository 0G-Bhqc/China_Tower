import { createHash } from 'node:crypto';
import { copyFile, mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const evidenceRoot = path.join(projectRoot, 'evidence', 'v3');
const runtimeManifestPath = path.join(projectRoot, 'public', 'assets', 'pavilion-assets.manifest.json');
const frozenRuntimeManifestPath = path.join(evidenceRoot, 'baseline', 'pavilion-assets.manifest.json');

const assetOrder = ['feiyun', 'penglai', 'huanghe', 'tengwang', 'yueyang'];
const diagnoses = {
  feiyun: {
    severity: 'critical',
    summary: '31 source meshes were flattened into 3 runtime material meshes; 2.54M triangles carry almost no usable semantic separation.',
    nextAction: 'Recover loose components and height/shape hypotheses from all 31 source chunks before any new runtime export.',
  },
  penglai: {
    severity: 'critical',
    summary: '9,066 source meshes were filtered into 30 runtime meshes; enclosure, wall, door and window coverage is incomplete.',
    nextAction: 'Rebuild spatial building clusters and explicitly audit facade enclosure before admitting the main pavilion.',
  },
  huanghe: {
    severity: 'high',
    summary: '243 source meshes were flattened into 11 runtime meshes; roof/tile semantics are lost and Standard is 44.74 MiB / 1.71M triangles.',
    nextAction: 'Recover per-storey roof, tile, ridge, finial and facade candidates, then export progressive packs.',
  },
  tengwang: {
    severity: 'high',
    summary: 'The source scene has a 4.6 km outlier span while current LOD0 is only 137k triangles; main-tower admission and simplification are over-aggressive.',
    nextAction: 'Resolve outliers, lock the main-tower collection and protect podium/eave/roof identity features during LOD generation.',
  },
  yueyang: {
    severity: 'medium',
    summary: 'Geometry is the strongest baseline, but Standard uses 713 draw calls and plaque/tile/dougong close-up fidelity remains uneven.',
    nextAction: 'Separate render batching from semantic picking, then refine roof, bracket and plaque close-ups without resuming the stopped procedural state.',
  },
};

const requiredSemanticNodes = [
  'building',
  'foundation',
  'podium',
  'structural-frame',
  'structural-frame/columns',
  'structural-frame/beams',
  'structural-frame/brackets-dougong',
  'facade',
  'facade/walls',
  'facade/doors-windows',
  'facade/railings',
  'roof-system',
  'roof-system/rafters',
  'roof-system/sheathing',
  'roof-system/tiles',
  'roof-system/eaves',
  'roof-system/ridges',
  'roof-system/ornaments-finial',
  'plaques',
  'secondary-details',
];

const reviewViews = ['front', 'three-quarter', 'right', 'rear', 'left', 'elevated', 'low-angle'];
const reviewPasses = ['beauty', 'alpha-silhouette', 'semantic-id', 'depth', 'normal', 'roughness-material-id'];

async function json(filePath) {
  return JSON.parse(await readFile(filePath, 'utf8'));
}

async function sha256(filePath) {
  const data = await readFile(filePath);
  return createHash('sha256').update(data).digest('hex');
}

async function writeOnce(filePath, value) {
  try {
    const existing = JSON.parse(await readFile(filePath, 'utf8'));
    if (JSON.stringify(existing) === JSON.stringify(value)) return;
    throw new Error(`Refusing to overwrite different frozen V3 evidence: ${path.relative(projectRoot, filePath)}`);
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

const runtimeManifest = await json(runtimeManifestPath);
const runtimeById = new Map(runtimeManifest.assets.map((asset) => [asset.id, asset]));
const exactIds = [...runtimeById.keys()].sort();
const expectedIds = ['feiyun', 'huanghe', 'penglai', 'tengwang', 'yueyang'];
if (JSON.stringify(exactIds) !== JSON.stringify(expectedIds)) {
  throw new Error(`V3 requires exactly five assets; found: ${exactIds.join(', ')}`);
}

await mkdir(path.dirname(frozenRuntimeManifestPath), { recursive: true });
try {
  await stat(frozenRuntimeManifestPath);
  const existingHash = await sha256(frozenRuntimeManifestPath);
  const liveHash = await sha256(runtimeManifestPath);
  if (existingHash !== liveHash) {
    throw new Error('Existing frozen runtime manifest differs from the live pre-V3 manifest.');
  }
} catch (error) {
  if (error.code === 'ENOENT') await copyFile(runtimeManifestPath, frozenRuntimeManifestPath);
  else if (!String(error.message).includes('Existing frozen runtime manifest differs')) throw error;
  else throw error;
}

const oldState = await json(path.join(projectRoot, '.img2threejs', 'state.json'));
const frozenRuntimeSha256 = await sha256(frozenRuntimeManifestPath);
const jobs = [];

for (const [priorityIndex, assetId] of assetOrder.entries()) {
  const asset = runtimeById.get(assetId);
  const legacyJobRoot = path.join(projectRoot, 'evidence', '3d-assets', 'jobs', assetId);
  const inventoryPath = path.join(legacyJobRoot, 'blender-analysis', 'blender-inventory.json');
  const hierarchyPath = path.join(legacyJobRoot, 'blender-analysis', 'hierarchy.json');
  const fullScenePath = path.join(legacyJobRoot, 'outputs', 'full-scene.fbx');
  const inventory = await json(inventoryPath);
  await stat(hierarchyPath);
  await stat(fullScenePath);

  const job = {
    schemaVersion: 1,
    track: 'dcc-highmodel-v3',
    assetId,
    nameCN: asset.nameCN,
    priority: priorityIndex + 1,
    status: 'planned',
    source: {
      maxPath: asset.source.path,
      maxSha256: asset.source.sha256,
      sourceFaces: asset.source.faces,
      fullSceneFbx: path.relative(projectRoot, fullScenePath).replaceAll('\\', '/'),
      legacyInventory: path.relative(projectRoot, inventoryPath).replaceAll('\\', '/'),
      legacyHierarchy: path.relative(projectRoot, hierarchyPath).replaceAll('\\', '/'),
      blenderVersion: inventory.provenance.blenderVersion,
      inventory: inventory.inventory,
    },
    baseline: {
      frozenRuntimeManifest: 'evidence/v3/baseline/pavilion-assets.manifest.json',
      frozenRuntimeManifestSha256: frozenRuntimeSha256,
      runtime: asset.runtime,
    },
    diagnosis: diagnoses[assetId],
    semanticContract: {
      requiredNodes: requiredSemanticNodes,
      allowedStatuses: ['hypothesis', 'approved', 'rejected', 'not-present'],
      mappingChain: ['sourceObject', 'blenderObject', 'semanticNode', 'glbNode', 'runtimeStableId'],
      forbidMaterialOnlySemanticMerge: true,
    },
    reviewContract: {
      views: reviewViews,
      passes: reviewPasses,
      closeups: ['podium', 'roof', 'tiles', 'brackets-dougong', 'plaque'],
      deterministicGatesBeforeVisualReview: true,
    },
    correctionPolicy: {
      maximumPerPass: 3,
      maximumTotal: 6,
      oneProblemGroupPerLoop: true,
      actions: ['continue', 'refine-spec', 'refine-code', 'request-input', 'stop'],
    },
    deliverables: {
      dissectionRoot: `evidence/v3/${assetId}/dissection`,
      reviewRoot: `evidence/v3/${assetId}/renders`,
      runtimeAssetRoot: `public/assets/pavilions/${assetId}`,
      packs: ['preview', 'core', 'roof', 'detail', 'plaque', 'hero'],
    },
    nextAction: diagnoses[assetId].nextAction,
  };
  await writeOnce(path.join(evidenceRoot, assetId, 'job.json'), job);
  jobs.push(job);
}

const baseline = {
  schemaVersion: 1,
  track: 'dcc-highmodel-v3',
  frozenAt: new Date().toISOString(),
  scope: {
    assetIds: expectedIds,
    removedProductIds: ['guanque'],
    fallbackPolicy: 'generic procedural study is degraded-only and is not a product exhibit',
  },
  frozenRuntimeManifest: {
    path: 'evidence/v3/baseline/pavilion-assets.manifest.json',
    sha256: frozenRuntimeSha256,
    bytes: (await stat(frozenRuntimeManifestPath)).size,
    totals: runtimeManifest.totals,
  },
  stoppedLegacyState: {
    path: '.img2threejs/state.json',
    status: oldState.status,
    currentStep: oldState.currentStep,
    currentPass: oldState.currentPass,
    stopReason: oldState.stopReason,
    policy: 'preserve; never resume or bypass for V3 DCC jobs',
  },
  jobs: jobs.map((job) => ({
    assetId: job.assetId,
    priority: job.priority,
    jobPath: `evidence/v3/${job.assetId}/job.json`,
    diagnosisSeverity: job.diagnosis.severity,
  })),
};
await writeOnce(path.join(evidenceRoot, 'baseline-manifest.json'), baseline);
console.log(JSON.stringify({ status: 'prepared', assets: jobs.length, frozenRuntimeSha256 }, null, 2));
