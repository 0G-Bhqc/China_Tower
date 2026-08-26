import { spawnSync } from 'node:child_process';
import { access, mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const [assetId, sourceRun = 'run-003', reviewId = 'review-001'] = process.argv.slice(2);
const allowedAssets = new Set(['feiyun', 'penglai', 'huanghe', 'tengwang', 'yueyang']);
if (!allowedAssets.has(assetId) || !/^run-\d{3}$/.test(sourceRun) || !/^review-\d{3}$/.test(reviewId)) {
  throw new Error('Usage: npm run v3:semantic -- <asset-id> <run-NNN> <review-NNN>');
}

const jobPath = path.join(projectRoot, 'evidence', 'v3', assetId, 'job.json');
const job = JSON.parse(await readFile(jobPath, 'utf8'));
if (job.track !== 'dcc-highmodel-v3' || job.assetId !== assetId) throw new Error('V3 job identity mismatch');

const inputFbx = path.join(projectRoot, job.source.fullSceneFbx);
const catalogPath = path.join(projectRoot, 'evidence', 'v3', assetId, 'dissection', sourceRun, 'component-catalog.json');
const outputDir = path.join(projectRoot, 'evidence', 'v3', assetId, 'semantic-partition', reviewId);
await access(inputFbx);
await access(catalogPath);
try {
  await stat(outputDir);
  throw new Error(`Refusing to overwrite an existing semantic review: ${path.relative(projectRoot, outputDir)}`);
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
    // Try the next pinned candidate.
  }
}
if (!blender) throw new Error('Blender 5.2 executable not found. Set BLENDER_EXE to the verified executable.');

const scriptPath = path.join(projectRoot, 'pipeline', 'blender', 'v3', 'semantic_partition.py');
const args = [
  '--background',
  '--factory-startup',
  '--python', scriptPath,
  '--',
  assetId,
  inputFbx,
  catalogPath,
  outputDir,
  jobPath,
];
console.log(JSON.stringify({ assetId, sourceRun, reviewId, blender, inputFbx, catalogPath, outputDir }, null, 2));
const startedAt = new Date().toISOString();
const result = spawnSync(blender, args, {
  cwd: projectRoot,
  stdio: 'inherit',
  timeout: 60 * 60 * 1000,
  windowsHide: true,
});
let failureReason = result.error?.message ?? null;
if (!failureReason && result.status !== 0) failureReason = `Blender exited with code ${result.status}`;
const manifestPath = path.join(outputDir, 'run-manifest.json');
let manifest = null;
if (!failureReason) {
  try {
    manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
    if (manifest.assetId !== assetId || manifest.track !== 'dcc-highmodel-v3-semantic-partition') {
      failureReason = 'run-manifest identity mismatch';
    } else if (!manifest.integrity?.passed) {
      failureReason = 'semantic partition integrity failed';
    }
  } catch (error) {
    failureReason = `run-manifest missing or unreadable: ${error.message}`;
  }
}
if (failureReason) {
  await mkdir(outputDir, { recursive: true });
  await writeFile(path.join(outputDir, 'failure.json'), `${JSON.stringify({
    schemaVersion: 1,
    assetId,
    sourceRun,
    reviewId,
    startedAt,
    failedAt: new Date().toISOString(),
    blender,
    inputFbx,
    catalogPath,
    reason: failureReason,
  }, null, 2)}\n`, 'utf8');
  throw new Error(`Blender V3 semantic partition failed: ${failureReason}`);
}
console.log(JSON.stringify({ status: 'completed', assetId, sourceRun, reviewId }, null, 2));

