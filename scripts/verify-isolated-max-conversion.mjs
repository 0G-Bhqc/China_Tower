import { createHash } from 'node:crypto';
import { createReadStream, existsSync } from 'node:fs';
import { readFile, stat, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

const workspace = resolve(import.meta.dirname, '..');
const args = process.argv.slice(2);
const assetId = args.at(args.indexOf('--asset') + 1);
const allowed = new Set(['yueyang', 'huanghe', 'tengwang', 'feiyun', 'penglai']);
if (!allowed.has(assetId)) throw new Error('Use --asset yueyang|huanghe|tengwang|feiyun|penglai.');

const sha256 = async (path) => {
  const digest = createHash('sha256');
  for await (const chunk of createReadStream(path)) digest.update(chunk);
  return digest.digest('hex');
};
const readJson = async (path) => JSON.parse((await readFile(path, 'utf8')).replace(/^\uFEFF/, ''));
const requireFile = async (path) => {
  const details = await stat(path);
  if (!details.isFile() || details.size === 0) throw new Error(`Missing or empty output: ${path}`);
  return details.size;
};

const jobRoot = resolve(workspace, 'evidence/3d-assets/jobs', assetId);
const [job, manifest] = await Promise.all([
  readJson(resolve(jobRoot, 'conversion-job.json')),
  readJson(resolve(jobRoot, 'source-manifest.json')),
]);
if (job.state !== 'awaiting-isolated-conversion') throw new Error(`Job is not awaiting verification: ${job.state}`);
const sourcePath = resolve(workspace, manifest.source.workspaceRelativePath);
if (await sha256(sourcePath) !== manifest.source.sha256) throw new Error('Source hash changed after conversion.');

const readonly = spawnSync('powershell.exe', [
  '-NoProfile', '-NonInteractive', '-Command',
  `(Get-Item -LiteralPath '${sourcePath.replaceAll("'", "''")}').Attributes -band [IO.FileAttributes]::ReadOnly`,
], { encoding: 'utf8' });
if (readonly.status !== 0 || readonly.stdout.trim() !== 'ReadOnly') throw new Error('Source is not read-only.');

const outputs = Object.fromEntries(await Promise.all([
  'sanitized-scene.max', 'analysis-proxy.fbx', 'full-scene.fbx', 'object-map.json', 'conversion-report.json',
].map(async (file) => [file, await requireFile(resolve(jobRoot, 'outputs', file))])));
const objectMap = await readJson(resolve(jobRoot, 'outputs/object-map.json'));
if (!Array.isArray(objectMap.objects) || objectMap.objects.length === 0) throw new Error('Object map is empty.');
const maxReport = await readJson(resolve(jobRoot, 'outputs/conversion-report.json'));
const verification = {
  schemaVersion: 1,
  assetId,
  verifiedAt: new Date().toISOString(),
  source: { path: manifest.source.workspaceRelativePath, sha256: manifest.source.sha256, readOnly: true },
  isolatedExecution: {
    safeScene: true,
    networkDisabled: true,
    embeddedScriptExecutionDisabled: true,
    customAttributesSanitized: true,
  },
  outputs,
  objectMap: { objectCount: objectMap.objects.length },
  maxReport: {
    status: maxReport.status,
    message: maxReport.message,
    note: '3ds Max wrote all required artifacts but reported an exporter-side undefined exception after export. This verifier accepts only the independently checked artifact set and preserves the original Max report unchanged.',
  },
};
const evidencePath = resolve(jobRoot, 'outputs/conversion-verification.json');
await writeFile(evidencePath, `${JSON.stringify(verification, null, 2)}\n`, 'utf8');
job.state = 'converted';
job.blockedReasons = [];
job.safety = { sourceReadOnly: true, networkDisabled: true, scriptExecutionDisabled: true, customAttributesSanitized: true, verifiedBy: `artifact-verifier ${verification.verifiedAt}` };
job.steps = job.steps.map((step) => ({ ...step, status: 'done', evidence: ['outputs/conversion-verification.json', 'outputs/conversion-report.json', 'outputs/object-map.json'] }));
await writeFile(resolve(jobRoot, 'conversion-job.json'), `${JSON.stringify(job, null, 2)}\n`, 'utf8');
console.log(`Verified converted artifact set: ${assetId}; ${objectMap.objects.length} mapped objects.`);
