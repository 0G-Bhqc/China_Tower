import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { spawn, spawnSync } from 'node:child_process';

const workspace = resolve(import.meta.dirname, '..');
const args = process.argv.slice(2);
const option = (name) => {
  const index = args.indexOf(name);
  return index < 0 ? null : args[index + 1] ?? null;
};
const assetId = option('--asset');
const dryRun = args.includes('--dry-run');

function discoverBlender() {
  if (process.platform !== 'win32') return null;
  const command = [
    "$items = Get-ItemProperty 'HKLM:\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\*','HKLM:\\SOFTWARE\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\*' -ErrorAction SilentlyContinue | Where-Object { $_.DisplayName -eq 'Blender' -and $_.InstallLocation };",
    '$items | Select-Object DisplayVersion,InstallLocation | ConvertTo-Json -Compress',
  ].join(' ');
  const result = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', command], { encoding: 'utf8' });
  if (result.status !== 0 || !result.stdout.trim()) return null;
  try {
    const records = JSON.parse(result.stdout);
    const list = Array.isArray(records) ? records : [records];
    return list
      .map((record) => ({ ...record, executable: resolve(record.InstallLocation, 'blender.exe') }))
      .filter((record) => existsSync(record.executable))
      .sort((left, right) => right.DisplayVersion.localeCompare(left.DisplayVersion, undefined, { numeric: true }))
      .at(0)?.executable ?? null;
  } catch {
    return null;
  }
}

const blender = option('--blender') ?? process.env.BLENDER_EXECUTABLE ?? discoverBlender();

function fail(message) {
  console.error(`Blender analysis preflight failed: ${message}`);
  process.exitCode = 1;
}

if (!assetId || !/^(yueyang|huanghe|tengwang|feiyun|penglai)$/.test(assetId)) {
  fail('Use --asset yueyang|huanghe|tengwang|feiyun|penglai.');
} else {
  const jobRoot = resolve(workspace, 'evidence/3d-assets/jobs', assetId);
  const jobPath = resolve(jobRoot, 'conversion-job.json');
  const fbxPath = resolve(jobRoot, 'outputs/full-scene.fbx');
  const outputPath = resolve(jobRoot, 'blender-analysis');
  const runnerPath = resolve(workspace, 'pipeline/blender/analyze_fbx.py');
  const job = JSON.parse(await readFile(jobPath, 'utf8'));
  const safetyKeys = ['sourceReadOnly', 'networkDisabled', 'scriptExecutionDisabled', 'customAttributesSanitized'];
  const approved = job.state === 'converted' && safetyKeys.every((key) => job.safety?.[key] === true);
  const command = [
    '--background', '--factory-startup', '--python', runnerPath, '--',
    '--job', jobPath, '--input', fbxPath, '--output', outputPath,
  ];

  console.log(`Asset: ${assetId}`);
  console.log(`Job state: ${job.state}`);
  console.log(`FBX: ${fbxPath}`);
  console.log(`Blender: ${blender ?? '<not detected>'}`);
  if (!approved) {
    fail('The conversion job has not passed the isolated-host safety gate. No Blender process was started.');
  } else if (!existsSync(fbxPath)) {
    fail('Approved job is missing outputs/full-scene.fbx. No Blender process was started.');
  } else if (dryRun) {
    console.log(`Dry run command: ${blender ?? '<blender-executable>'} ${command.map((item) => JSON.stringify(item)).join(' ')}`);
  } else if (!blender) {
    fail('No Blender executable was detected. Set BLENDER_EXECUTABLE or use --blender <absolute-path>.');
  } else if (!existsSync(blender)) {
    fail(`Blender executable not found: ${blender}`);
  } else {
    const child = spawn(blender, command, { cwd: workspace, stdio: 'inherit', shell: false });
    child.once('error', (error) => fail(error.message));
    child.once('exit', (code) => { process.exitCode = code ?? 1; });
  }
}
