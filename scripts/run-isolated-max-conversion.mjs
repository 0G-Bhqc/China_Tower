import { createHash } from 'node:crypto';
import { createReadStream, existsSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { spawn, spawnSync } from 'node:child_process';

const workspace = resolve(import.meta.dirname, '..');
const args = process.argv.slice(2);
const option = (name) => {
  const index = args.indexOf(name);
  return index < 0 ? null : args[index + 1] ?? null;
};
const assetId = option('--asset');
const acknowledge = args.includes('--acknowledge-isolated-host');
const dryRun = args.includes('--dry-run');
const allowed = new Set(['yueyang', 'huanghe', 'tengwang', 'feiyun', 'penglai']);
const fail = (message) => { throw new Error(message); };

async function sha256(path) {
  const digest = createHash('sha256');
  for await (const chunk of createReadStream(path)) digest.update(chunk);
  return digest.digest('hex');
}

function discover3dsMax() {
  const command = [
    "$record = Get-ItemProperty 'HKLM:\\SOFTWARE\\Autodesk\\3dsMax\\*' -ErrorAction SilentlyContinue | Where-Object { $_.InstallDir } | Sort-Object PSChildName -Descending | Select-Object -First 1;",
    'if ($record) { Join-Path $record.InstallDir "3dsmax.exe" }',
  ].join(' ');
  const result = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', command], { encoding: 'utf8' });
  const executable = result.stdout.trim();
  return executable && existsSync(executable) ? executable : null;
}

if (!assetId || !allowed.has(assetId)) fail('Use --asset yueyang|huanghe|tengwang|feiyun|penglai.');
if (!acknowledge) fail('Pass --acknowledge-isolated-host only after the offline isolation checks are complete.');

const jobRoot = resolve(workspace, 'evidence/3d-assets/jobs', assetId);
const [job, manifest] = await Promise.all([
  readFile(resolve(jobRoot, 'conversion-job.json'), 'utf8').then(JSON.parse),
  readFile(resolve(jobRoot, 'source-manifest.json'), 'utf8').then(JSON.parse),
]);
if (job.state !== 'awaiting-isolated-conversion') fail(`Job is not ready: ${job.state}`);
const sourcePath = resolve(workspace, manifest.source.workspaceRelativePath);
if (await sha256(sourcePath) !== manifest.source.sha256) fail('Source SHA-256 differs from the approved intake manifest.');
const readonlyCommand = [
  `$item = Get-Item -LiteralPath '${sourcePath.replaceAll("'", "''")}';`,
  '$item.Attributes = $item.Attributes -bor [IO.FileAttributes]::ReadOnly;',
  'if (-not ($item.Attributes -band [IO.FileAttributes]::ReadOnly)) { exit 1 }',
].join(' ');
const readonlyResult = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', readonlyCommand], { encoding: 'utf8' });
if (readonlyResult.status !== 0) fail('Could not enforce the source file read-only attribute.');
const outputPath = resolve(jobRoot, 'outputs');
const scriptPath = resolve(workspace, 'pipeline/max-conversion/export_sanitized_scene.ms');
const executable = discover3dsMax();
if (!executable) fail('3ds Max executable could not be discovered from the local installation registry.');
const maxArgs = [
  '-n',
  '-i', resolve(workspace, 'pipeline/max-conversion/isolated-session'),
  '-safescene', 'ON',
  '-secure', 'ON',
  '-silent',
  '-q',
  '-mi',
  '-log', resolve(outputPath, 'max-session.log'),
  '-U', 'MAXScript', scriptPath,
];
console.log(`Asset: ${assetId}`);
console.log(`3ds Max: ${executable}`);
console.log(`Source: ${sourcePath}`);
console.log(`Output: ${outputPath}`);
if (dryRun) {
  console.log(`Dry run command: ${executable} ${maxArgs.map((item) => JSON.stringify(item)).join(' ')}`);
  process.exit(0);
}

await mkdir(outputPath, { recursive: true });
const environment = {
  ...process.env,
  ADSK_3DSMAX_APPDATA_DIR: resolve(jobRoot, 'isolated-max-profile'),
  ADSK_3DSMAX_USERSETTINGS_DIR: resolve(jobRoot, 'isolated-max-profile/user-settings'),
  ADSK_3DSMAX_PROJECT_FOLDER_DIR: resolve(jobRoot, 'isolated-max-profile/project'),
  ADSK_APPLICATION_PLUGINS: '',
  CT_SOURCE_PATH: sourcePath,
  CT_OUTPUT_DIR: outputPath,
  CT_JOB_ID: job.jobId,
  CT_SOURCE_SHA256: manifest.source.sha256,
};
const child = spawn(executable, maxArgs, { cwd: dirname(executable), env: environment, stdio: 'inherit', shell: false });
const code = await new Promise((resolveCode, reject) => {
  child.once('error', reject);
  child.once('exit', (exitCode) => resolveCode(exitCode ?? 1));
});
if (code !== 0) fail(`3ds Max exited with code ${code}.`);
const reportPath = resolve(outputPath, 'conversion-report.json');
if (!existsSync(reportPath)) fail('3ds Max completed without conversion-report.json.');
const report = JSON.parse((await readFile(reportPath, 'utf8')).replace(/^\uFEFF/, ''));
const outputs = ['sanitized-scene.max', 'analysis-proxy.fbx', 'full-scene.fbx', 'object-map.json', 'conversion-report.json'];
if (report.status !== 'success' || !outputs.every((file) => existsSync(resolve(outputPath, file)))) fail(`Conversion report is not approved: ${report.message ?? report.status}`);
if (!Object.values(report.safety ?? {}).every((value) => value === true)) fail('Conversion report contains an unmet safety assertion.');
job.state = 'converted';
job.blockedReasons = [];
job.safety = { ...report.safety, verifiedBy: `isolated-max-runner ${new Date().toISOString()}` };
job.steps = job.steps.map((step) => ({ ...step, status: 'done', evidence: [`outputs/conversion-report.json`] }));
await writeFile(resolve(jobRoot, 'conversion-job.json'), `${JSON.stringify(job, null, 2)}\n`, 'utf8');
console.log(`Conversion approved: ${assetId}`);
