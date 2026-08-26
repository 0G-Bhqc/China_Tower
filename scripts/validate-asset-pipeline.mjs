import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { readFile, stat } from 'node:fs/promises';
import { resolve } from 'node:path';

const workspace = resolve(import.meta.dirname, '..');
const intakePath = resolve(workspace, 'evidence/3d-assets/asset-intake.json');
const configPath = resolve(workspace, 'evidence/3d-assets/pipeline-config.json');
const schemaPath = resolve(workspace, 'schemas/blender-analysis.schema.json');
const sourceSchemaPath = resolve(workspace, 'schemas/source-asset-manifest.schema.json');
const conversionSchemaPath = resolve(workspace, 'schemas/conversion-job.schema.json');
const verifyHashes = process.argv.includes('--verify-hashes');

const loadJson = async (path) => JSON.parse(await readFile(path, 'utf8'));
const assert = (condition, message) => {
  if (!condition) throw new Error(message);
};

const [intake, config, schema, sourceSchema, conversionSchema] = await Promise.all([
  loadJson(intakePath),
  loadJson(configPath),
  loadJson(schemaPath),
  loadJson(sourceSchemaPath),
  loadJson(conversionSchemaPath),
]);

assert(intake.schemaVersion === 1, 'Unsupported asset intake schema');
assert(config.schemaVersion === 1, 'Unsupported pipeline config schema');
assert(schema.title === 'BlenderAnalysis', 'Unexpected Blender analysis schema');
assert(sourceSchema.title === 'SourceAssetManifest', 'Unexpected source manifest schema');
assert(conversionSchema.title === 'IsolatedMaxConversionJob', 'Unexpected conversion job schema');
assert(intake.assets.length === 5, 'Expected exactly five source assets');

const ids = intake.assets.map((asset) => asset.id);
assert(new Set(ids).size === ids.length, 'Asset IDs must be unique');
assert(config.analysisOrder.length === ids.length, 'Analysis order must include every asset');
assert(config.analysisOrder.every((id) => ids.includes(id)), 'Analysis order contains an unknown asset');
assert(config.renderPasses.length === 6, 'Six render evidence passes are required');
assert(config.reviewViews.length >= 6, 'At least six review views are required');
assert(config.productPolicy.sourceMeshesAtRuntime === false, 'Source meshes must not enter runtime');
assert(config.productPolicy.sourceTopologyCopied === false, 'Source topology copying must remain disabled');
assert(config.productPolicy.singleSharedAssembler === true, 'The scalable architecture requires one shared assembler');
assert(config.budgets.desktop.pavilionTriangleSoft < config.budgets.desktop.pavilionTriangleHard, 'Desktop soft budget must be below hard budget');
assert(config.budgets.mobile.pavilionTriangleSoft < config.budgets.mobile.pavilionTriangleHard, 'Mobile soft budget must be below hard budget');

async function sha256(path) {
  const digest = createHash('sha256');
  for await (const chunk of createReadStream(path)) digest.update(chunk);
  return digest.digest('hex');
}

for (const asset of intake.assets) {
  const sourcePath = resolve(workspace, asset.source);
  const source = await stat(sourcePath);
  assert(source.isFile(), `Missing source for ${asset.id}`);
  assert(source.size === asset.bytes, `Source size drift for ${asset.id}`);
  assert(asset.vertices > 0 && asset.faces > 0 && asset.objects > 0, `Invalid scene inventory for ${asset.id}`);

  const jobRoot = resolve(workspace, `evidence/3d-assets/jobs/${asset.id}`);
  const [manifest, job] = await Promise.all([
    loadJson(resolve(jobRoot, 'source-manifest.json')),
    loadJson(resolve(jobRoot, 'conversion-job.json')),
  ]);
  assert(manifest.schemaVersion === 1 && manifest.assetId === asset.id, `Invalid source manifest identity for ${asset.id}`);
  assert(manifest.source.workspaceRelativePath === asset.source, `Source manifest path drift for ${asset.id}`);
  assert(manifest.source.bytes === asset.bytes, `Source manifest size drift for ${asset.id}`);
  assert(/^[a-f0-9]{64}$/.test(manifest.source.sha256), `Invalid source hash for ${asset.id}`);
  assert(manifest.security.classification === 'untrusted-active-content', `Unsafe source classification for ${asset.id}`);
  assert(manifest.security.allowScriptExecution === false, `Script execution must be disabled for ${asset.id}`);
  assert(job.assetId === asset.id && job.sourceSha256 === manifest.source.sha256, `Conversion job provenance mismatch for ${asset.id}`);
  assert(job.jobId === `${asset.id}-${manifest.source.sha256.slice(0, 12)}-v${job.profileVersion}`, `Unstable job ID for ${asset.id}`);
  assert(['awaiting-isolated-conversion', 'converting', 'converted', 'rejected', 'blocked'].includes(job.state), `Unexpected conversion state for ${asset.id}`);
  assert(job.exports.analysisProxy.includeExecutableContent === false, `Executable proxy content enabled for ${asset.id}`);
  assert(job.exports.fullScene.includeExecutableContent === false, `Executable full-scene content enabled for ${asset.id}`);
  const safetyKeys = ['sourceReadOnly', 'networkDisabled', 'scriptExecutionDisabled', 'customAttributesSanitized'];
  if (job.state === 'awaiting-isolated-conversion') {
    assert(safetyKeys.every((key) => job.safety[key] === null), `Awaiting job has an unverified safety assertion for ${asset.id}`);
    assert(job.steps.every((step) => step.status === 'pending'), `Awaiting job has a completed step for ${asset.id}`);
  }
  if (job.state === 'converted') {
    assert(safetyKeys.every((key) => job.safety[key] === true), `Converted job failed a safety assertion for ${asset.id}`);
    assert(typeof job.safety.verifiedBy === 'string' && job.safety.verifiedBy.length > 0, `Converted job has no verifier for ${asset.id}`);
    assert(job.steps.every((step) => ['done', 'skipped'].includes(step.status)), `Converted job has unfinished steps for ${asset.id}`);
    for (const requiredOutput of job.requiredOutputs) {
      const outputInfo = await stat(resolve(jobRoot, requiredOutput));
      assert(outputInfo.isFile(), `Converted job output is not a file for ${asset.id}: ${requiredOutput}`);
    }
  }
  if (['rejected', 'blocked'].includes(job.state)) {
    assert(Array.isArray(job.blockedReasons) && job.blockedReasons.length > 0, `Terminal job has no reason for ${asset.id}`);
  }
  if (verifyHashes) {
    const actualSourceHash = await sha256(sourcePath);
    assert(actualSourceHash === manifest.source.sha256, `Source SHA-256 drift for ${asset.id}`);
    for (const companion of manifest.companions) {
      const companionPath = resolve(workspace, companion.workspaceRelativePath);
      const companionInfo = await stat(companionPath);
      assert(companionInfo.size === companion.bytes, `Companion size drift: ${companion.workspaceRelativePath}`);
      assert(await sha256(companionPath) === companion.sha256, `Companion SHA-256 drift: ${companion.workspaceRelativePath}`);
    }
  }
}

const totals = intake.assets.reduce(
  (sum, asset) => ({
    vertices: sum.vertices + asset.vertices,
    faces: sum.faces + asset.faces,
    objects: sum.objects + asset.objects,
  }),
  { vertices: 0, faces: 0, objects: 0 },
);
assert(JSON.stringify(totals) === JSON.stringify(intake.totals), 'Asset totals do not match source rows');

console.log(`Asset pipeline contract OK: ${intake.assets.length} assets, ${totals.faces.toLocaleString()} source faces.`);
console.log(`Readiness: ${intake.status}; Blender MCP connected=${intake.environment.blenderMcpConnected}.`);
console.log(`Source hash verification: ${verifyHashes ? 'complete' : 'skipped (use --verify-hashes)'}.`);
