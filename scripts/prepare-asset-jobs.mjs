import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { mkdir, readdir, readFile, stat, writeFile } from 'node:fs/promises';
import { extname, relative, resolve, sep } from 'node:path';

const workspace = resolve(import.meta.dirname, '..');
const intakePath = resolve(workspace, 'evidence/3d-assets/asset-intake.json');
const jobsRoot = resolve(workspace, 'evidence/3d-assets/jobs');
const generatedAt = new Date().toISOString();

const intake = JSON.parse(await readFile(intakePath, 'utf8'));

function toWorkspacePath(path) {
  return relative(workspace, path).split(sep).join('/');
}

function classifyCompanion(path) {
  const extension = extname(path).toLowerCase();
  if (extension === '.hdr') return 'environment';
  if (['.jpg', '.jpeg', '.png', '.tga', '.bmp', '.tif', '.tiff'].includes(extension)) return 'texture';
  if (['.txt', '.rps'].includes(extension)) return 'metadata';
  return 'unknown';
}

async function sha256(path) {
  const digest = createHash('sha256');
  const stream = createReadStream(path);
  for await (const chunk of stream) digest.update(chunk);
  return digest.digest('hex');
}

async function fileRecord(path, role) {
  const info = await stat(path);
  return {
    workspaceRelativePath: toWorkspacePath(path),
    bytes: info.size,
    sha256: await sha256(path),
    ...(role ? { role } : {}),
  };
}

function conversionJob(asset, sourceSha256) {
  const profileVersion = 1;
  const jobId = `${asset.id}-${sourceSha256.slice(0, 12)}-v${profileVersion}`;
  const exportBase = {
    format: 'FBX',
    unit: 'meter',
    preserveHierarchy: true,
    preserveInstances: true,
    includeExecutableContent: false,
  };
  return {
    schemaVersion: 1,
    jobId,
    assetId: asset.id,
    sourceSha256,
    profileVersion,
    state: 'awaiting-isolated-conversion',
    blockedReasons: [
      'No approved isolated 3ds Max conversion host is connected.',
      'Script execution and custom-attribute sanitization have not been independently verified.'
    ],
    safety: {
      sourceReadOnly: null,
      networkDisabled: null,
      scriptExecutionDisabled: null,
      customAttributesSanitized: null,
      verifiedBy: null
    },
    exports: {
      analysisProxy: {
        ...exportBase,
        output: 'outputs/analysis-proxy.fbx',
        geometryPolicy: 'per-object proxy geometry; retain names, hierarchy, material slots and transforms'
      },
      fullScene: {
        ...exportBase,
        output: 'outputs/full-scene.fbx',
        geometryPolicy: 'full geometry and UVs; split according to asset-specific partition plan'
      }
    },
    requiredOutputs: [
      'outputs/sanitized-scene.max',
      'outputs/analysis-proxy.fbx',
      'outputs/full-scene.fbx',
      'outputs/object-map.json',
      'outputs/conversion-report.json'
    ],
    steps: [
      { id: 'verify-source-hash', status: 'pending', evidence: [] },
      { id: 'verify-isolated-host', status: 'pending', evidence: [] },
      { id: 'disable-script-execution', status: 'pending', evidence: [] },
      { id: 'sanitize-scripted-custom-attributes', status: 'pending', evidence: [] },
      { id: 'save-sanitized-copy', status: 'pending', evidence: [] },
      { id: 'export-analysis-proxy', status: 'pending', evidence: [] },
      { id: 'export-full-scene', status: 'pending', evidence: [] },
      { id: 'scan-and-approve-outputs', status: 'pending', evidence: [] }
    ]
  };
}

await mkdir(jobsRoot, { recursive: true });

for (const asset of intake.assets) {
  const sourcePath = resolve(workspace, asset.source);
  const sourceDir = resolve(sourcePath, '..');
  const entries = await readdir(sourceDir, { withFileTypes: true });
  const companionPaths = entries
    .filter((entry) => entry.isFile())
    .map((entry) => resolve(sourceDir, entry.name))
    .filter((path) => path !== sourcePath)
    .sort((left, right) => left.localeCompare(right, 'zh-CN'));

  const source = await fileRecord(sourcePath);
  const companions = [];
  for (const path of companionPaths) companions.push(await fileRecord(path, classifyCompanion(path)));

  const manifest = {
    schemaVersion: 1,
    assetId: asset.id,
    nameCN: asset.nameCN,
    generatedAt,
    source,
    companions,
    sceneMetadata: {
      maxVersion: asset.maxVersion,
      savedAsVersion: asset.savedAsVersion,
      renderer: asset.renderer,
      vertices: asset.vertices,
      faces: asset.faces,
      objects: asset.objects,
      cameras: asset.cameras
    },
    security: {
      classification: 'untrusted-active-content',
      embeddedScriptedCustomAttributesDetected: true,
      allowScriptExecution: false,
      requiresIsolatedHost: true,
      evidence: [
        'Compound stream ScriptedCustAttribDefs is present.',
        'Read-only string inspection found security-setting and Base64-payload indicators.',
        'No embedded script has been executed during intake.'
      ]
    }
  };

  const jobDir = resolve(jobsRoot, asset.id);
  await mkdir(resolve(jobDir, 'outputs'), { recursive: true });
  await writeFile(resolve(jobDir, 'source-manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
  await writeFile(resolve(jobDir, 'conversion-job.json'), `${JSON.stringify(conversionJob(asset, source.sha256), null, 2)}\n`, 'utf8');
  console.log(`${asset.id}: ${source.sha256} (${companions.length} companions)`);
}
