import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { relative, resolve, sep } from 'node:path';

const workspace = resolve(import.meta.dirname, '..');
const publicRoot = resolve(workspace, 'public');
const intakePath = resolve(workspace, 'evidence/3d-assets/asset-intake.json');
const outputPath = resolve(publicRoot, 'assets/pavilion-assets.manifest.json');
const evidencePath = resolve(workspace, 'evidence/3d-assets/runtime-asset-baseline.json');

const runtimeAssets = {
  yueyang: {
    label: '岳阳楼',
    loader: 'createYueyangTowerFormModel',
    files: ['assets/yueyang-architectural-lod.glb'],
    lod1Files: ['assets/yueyang-architectural-lod1.glb'],
    lod2Files: ['assets/yueyang-architectural-lod2.glb'],
  },
  huanghe: {
    label: '黄鹤楼',
    loader: 'createHuangheTowerHighModel',
    files: ['assets/huanghe-main-tower-highmodel.glb'],
    lod1Files: ['assets/huanghe-main-tower-lod1.glb'],
    lod2Files: ['assets/huanghe-main-tower-lod2.glb'],
  },
  tengwang: {
    label: '滕王阁',
    loader: 'createTengwangTowerHighModel',
    // Hermes整理后的最新主体 GLB；仅作为 Hero/LOD0，普通设备使用下面的压缩 LOD。
    files: ['assets/tengwang-high-precision/tengwang-22753718.glb'],
    lod1Files: ['assets/tengwang-main-tower-lod1.glb'],
    lod2Files: ['assets/tengwang-main-tower-lod2.glb'],
  },
  penglai: {
    label: '蓬莱阁',
    loader: 'createPenglaiPavilionHighModel',
    files: ['assets/penglai-main-pavilion-highmodel.glb'],
    lod1Files: ['assets/penglai-main-pavilion-lod1.glb'],
    lod2Files: ['assets/penglai-main-pavilion-lod2.glb'],
  },
};

function sha256(buffer) {
  return createHash('sha256').update(buffer).digest('hex');
}

function parseGlb(buffer, file) {
  if (buffer.length < 20 || buffer.toString('ascii', 0, 4) !== 'glTF') {
    throw new Error(`Not a binary glTF file: ${file}`);
  }
  const version = buffer.readUInt32LE(4);
  const declaredLength = buffer.readUInt32LE(8);
  const jsonLength = buffer.readUInt32LE(12);
  const jsonType = buffer.toString('ascii', 16, 20);
  if (version !== 2 || declaredLength !== buffer.length || jsonType !== 'JSON') {
    throw new Error(`Invalid GLB header: ${file}`);
  }
  const gltf = JSON.parse(buffer.subarray(20, 20 + jsonLength).toString('utf8').trimEnd());
  let primitiveCount = 0;
  let triangles = 0;
  for (const mesh of gltf.meshes ?? []) {
    for (const primitive of mesh.primitives ?? []) {
      primitiveCount += 1;
      const accessor = gltf.accessors?.[primitive.indices];
      if (accessor?.count) triangles += Math.floor(accessor.count / 3);
    }
  }
  return {
    gltfVersion: version,
    bytes: buffer.length,
    sha256: sha256(buffer),
    meshCount: gltf.meshes?.length ?? 0,
    primitiveCount,
    triangles,
    materialCount: gltf.materials?.length ?? 0,
    compression: {
      meshopt: (gltf.extensionsUsed ?? []).includes('EXT_meshopt_compression'),
    },
    extensionsUsed: [...(gltf.extensionsUsed ?? [])].sort(),
    extensionsRequired: [...(gltf.extensionsRequired ?? [])].sort(),
  };
}

function publicUrl(path) {
  return `/${path.split(sep).join('/')}`;
}

function summarize(files) {
  return files.reduce(
    (sum, file) => ({
      bytes: sum.bytes + file.bytes,
      meshes: sum.meshes + file.meshCount,
      primitives: sum.primitives + file.primitiveCount,
      triangles: sum.triangles + file.triangles,
      materials: sum.materials + file.materialCount,
    }),
    { bytes: 0, meshes: 0, primitives: 0, triangles: 0, materials: 0 },
  );
}

const intake = JSON.parse(await readFile(intakePath, 'utf8'));
const assets = [];

for (const source of intake.assets) {
  const runtime = runtimeAssets[source.id];
  if (!runtime) {
    console.warn(`Skipping ${source.id}: no runtime asset mapping (intake record retained but not published).`);
    continue;
  }
  const sourceManifestPath = resolve(workspace, `evidence/3d-assets/jobs/${source.id}/source-manifest.json`);
  const sourceManifest = JSON.parse((await readFile(sourceManifestPath, 'utf8')).replace(/^\uFEFF/, ''));
  const files = [];
  for (const file of runtime.files) {
    const absolutePath = resolve(publicRoot, file);
    const buffer = await readFile(absolutePath);
    files.push({ url: publicUrl(file), ...parseGlb(buffer, file) });
  }
  const totals = summarize(files);
  const optionalTier = async (paths, purpose) => {
    if (!paths?.length) return { purpose, status: 'planned', files: [] };
    const tierFiles = [];
    for (const file of paths) {
      const buffer = await readFile(resolve(publicRoot, file));
      tierFiles.push({ url: publicUrl(file), ...parseGlb(buffer, file) });
    }
    return { purpose, status: 'ready', files: tierFiles, totals: summarize(tierFiles) };
  };
  const lod1 = await optionalTier(runtime.lod1Files, 'desktop/default');
  const lod2 = await optionalTier(runtime.lod2Files, 'mobile/far');
  assets.push({
    id: source.id,
    nameCN: runtime.label,
    source: {
      path: source.source,
      sha256: sourceManifest.source.sha256,
      faces: source.faces,
    },
    runtime: {
      loader: runtime.loader,
      defaultTier: lod1.status === 'ready' ? 'lod1' : 'lod0',
      tiers: {
        lod0: {
          purpose: 'hero/master',
          status: 'ready',
          files,
          totals,
        },
        lod1,
        lod2,
      },
    },
  });
}

const totals = assets.reduce(
  (sum, asset) => ({
    bytes: sum.bytes + asset.runtime.tiers.lod0.totals.bytes,
    triangles: sum.triangles + asset.runtime.tiers.lod0.totals.triangles,
  }),
  { bytes: 0, triangles: 0 },
);

const manifest = {
  schemaVersion: 1,
  generatedAt: new Date().toISOString(),
  policy: {
    sourceMaxAtRuntime: false,
    verifiedInterchangeOnly: true,
    lod0Role: 'immutable high-fidelity master',
    defaultRuntimeTarget: 'lod1',
    mobileRuntimeTarget: 'lod2',
    maxUncompressedGlbBytes: 41943040,
  },
  assets,
  totals: { ...totals, assetCount: assets.length },
};

const serialized = `${JSON.stringify(manifest, null, 2)}\n`;
await writeFile(outputPath, serialized, 'utf8');
await writeFile(evidencePath, serialized, 'utf8');
console.log(`Runtime manifest generated: ${relative(workspace, outputPath)} (${assets.length} assets, ${totals.triangles.toLocaleString()} triangles).`);
