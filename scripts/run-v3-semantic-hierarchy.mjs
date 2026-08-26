import { spawnSync } from 'node:child_process';
import { access, mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const [assetId, partitionReview = 'review-020', decisionReview = 'review-010', hierarchyReview = 'review-001'] = process.argv.slice(2);
if (
  !/^[a-z0-9-]+$/.test(assetId)
  || !/^review-\d{3}$/.test(partitionReview)
  || !/^review-\d{3}$/.test(decisionReview)
  || !/^review-\d{3}$/.test(hierarchyReview)
) {
  throw new Error('Usage: npm run v3:hierarchy -- <asset-id> <partition-review> <decision-review> <hierarchy-review>');
}

const jobPath = path.join(projectRoot, 'evidence', 'v3', assetId, 'job.json');
const catalogPath = path.join(projectRoot, 'evidence', 'v3', assetId, 'dissection', 'run-003', 'component-catalog.json');
const partitionDir = path.join(projectRoot, 'evidence', 'v3', assetId, 'semantic-partition', partitionReview);
const partitionPath = path.join(partitionDir, 'semantic-partition.json');
const partitionManifestPath = path.join(partitionDir, 'run-manifest.json');
const decisionsPath = path.join(projectRoot, 'evidence', 'v3', assetId, 'semantic-review', decisionReview, 'g2-decisions.json');
const outputDir = path.join(projectRoot, 'evidence', 'v3', assetId, 'semantic-hierarchy', hierarchyReview);

const job = JSON.parse(await readFile(jobPath, 'utf8'));
const decisions = JSON.parse(await readFile(decisionsPath, 'utf8'));
if (job.assetId !== assetId || job.track !== 'dcc-highmodel-v3') throw new Error('V3 job identity mismatch');
if (decisions.assetId !== assetId || decisions.gate !== 'G2' || decisions.result !== 'passed') throw new Error('Passed G2 decision required');
const expectedManifest = path.relative(projectRoot, partitionManifestPath).replaceAll('\\', '/');
if (decisions.partition?.manifest !== expectedManifest) throw new Error('G2 decision does not bind the selected partition review');

const inputFbx = path.join(projectRoot, job.source.fullSceneFbx);
for (const pathname of [inputFbx, catalogPath, partitionPath, partitionManifestPath, decisionsPath]) await access(pathname);
try {
  await stat(outputDir);
  throw new Error(`Refusing to overwrite existing hierarchy review: ${path.relative(projectRoot, outputDir)}`);
} catch (error) {
  if (error.code !== 'ENOENT') throw error;
}
await mkdir(path.dirname(outputDir), { recursive: true });

const blenderCandidates = [
  process.env.BLENDER_EXE,
  'D:\\Program Files\\Blender Foundation\\Blender 5.2\\blender.exe',
  'C:\\Program Files\\Blender Foundation\\Blender 5.2\\blender.exe',
].filter(Boolean);
let blender = null;
for (const candidate of blenderCandidates) {
  try {
    await access(candidate);
    blender = candidate;
    break;
  } catch {
    // Try next pinned Blender executable.
  }
}
if (!blender) throw new Error('Blender 5.2 executable not found. Set BLENDER_EXE.');

const scriptPath = path.join(projectRoot, 'pipeline', 'blender', 'v3', 'build_semantic_hierarchy.py');
const args = [
  '--background',
  '--factory-startup',
  '--python', scriptPath,
  '--',
  assetId,
  inputFbx,
  catalogPath,
  partitionPath,
  decisionsPath,
  outputDir,
  jobPath,
];
console.log(JSON.stringify({ assetId, partitionReview, decisionReview, hierarchyReview, blender, inputFbx, outputDir }, null, 2));
const startedAt = new Date().toISOString();
const result = spawnSync(blender, args, {
  cwd: projectRoot,
  stdio: 'inherit',
  timeout: 60 * 60 * 1000,
  windowsHide: true,
});
let failureReason = result.error?.message ?? null;
if (!failureReason && result.status !== 0) failureReason = `Blender exited with code ${result.status}`;
if (!failureReason) {
  try {
    const manifest = JSON.parse(await readFile(path.join(outputDir, 'run-manifest.json'), 'utf8'));
    if (manifest.track !== 'dcc-highmodel-v3-semantic-hierarchy' || manifest.assetId !== assetId || !manifest.integrity?.passed) {
      failureReason = 'Hierarchy manifest identity/integrity mismatch';
    }
  } catch (error) {
    failureReason = `Hierarchy manifest missing or unreadable: ${error.message}`;
  }
}
if (failureReason) {
  await mkdir(outputDir, { recursive: true });
  await writeFile(path.join(outputDir, 'failure.json'), `${JSON.stringify({
    schemaVersion: 1,
    assetId,
    partitionReview,
    decisionReview,
    hierarchyReview,
    startedAt,
    failedAt: new Date().toISOString(),
    blender,
    reason: failureReason,
  }, null, 2)}\n`, 'utf8');
  throw new Error(`Blender V3 semantic hierarchy failed: ${failureReason}`);
}
console.log(JSON.stringify({ status: 'completed', assetId, hierarchyReview }, null, 2));
