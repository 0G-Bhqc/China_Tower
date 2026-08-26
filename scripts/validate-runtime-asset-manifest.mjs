import { createHash } from 'node:crypto';
import { readFile, stat } from 'node:fs/promises';
import { resolve } from 'node:path';

const workspace = resolve(import.meta.dirname, '..');
const manifestPath = resolve(workspace, 'public/assets/pavilion-assets.manifest.json');
const verifyHashes = process.argv.includes('--verify-hashes');
const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
const HERO_OVERSIZE_ALLOWLIST = ['/assets/tengwang-high-precision/tengwang-22753718.glb'];

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

assert(manifest.schemaVersion === 1, 'Unsupported runtime asset manifest schema');
assert(manifest.policy.sourceMaxAtRuntime === false, 'Source MAX files may not enter runtime');
assert(manifest.policy.verifiedInterchangeOnly === true, 'Runtime must remain isolated from raw source scenes');
// Feiyun was pulled from the published set (photogrammetry source was unusable);
// the gallery ships four verified high models until a replacement source lands.
const EXPECTED_ASSETS = ['yueyang', 'huanghe', 'tengwang', 'penglai'];
assert(Array.isArray(manifest.assets) && manifest.assets.length === EXPECTED_ASSETS.length, `Exactly ${EXPECTED_ASSETS.length} high-model assets are required`);
assert(JSON.stringify(manifest.assets.map((asset) => asset.id)) === JSON.stringify(EXPECTED_ASSETS), 'Published asset set must be yueyang, huanghe, tengwang, penglai');

let totalBytes = 0;
let totalTriangles = 0;
for (const asset of manifest.assets) {
  assert(/^[a-f0-9]{64}$/.test(asset.source.sha256), `Invalid source hash: ${asset.id}`);
  const lod0 = asset.runtime?.tiers?.lod0;
  assert(lod0?.status === 'ready' && lod0.files.length > 0, `LOD0 is not ready: ${asset.id}`);
  assert(asset.runtime.tiers.lod1 && asset.runtime.tiers.lod2, `Missing LOD contract: ${asset.id}`);
  for (const tierId of ['lod1', 'lod2']) {
    const tier = asset.runtime.tiers[tierId];
    assert(['ready', 'planned'].includes(tier.status), `Invalid ${tierId} state: ${asset.id}`);
    if (tier.status === 'ready') {
      assert(tier.files.length > 0 && tier.totals.triangles > 0, `Empty ready tier: ${asset.id}/${tierId}`);
      assert(tier.totals.triangles < lod0.totals.triangles, `${tierId} does not reduce geometry: ${asset.id}`);
      const tierCalculated = { bytes: 0, meshes: 0, primitives: 0, triangles: 0, materials: 0 };
      for (const file of tier.files) {
        assert(file.url.startsWith('/assets/') && file.url.endsWith('.glb'), `Unsafe runtime URL: ${file.url}`);
        assert(/^[a-f0-9]{64}$/.test(file.sha256), `Invalid runtime hash: ${file.url}`);
        assert(typeof file.compression?.meshopt === 'boolean', `Missing compression record: ${file.url}`);
        if (file.bytes > manifest.policy.maxUncompressedGlbBytes) {
          const approvedHeroAsset = HERO_OVERSIZE_ALLOWLIST.includes(file.url);
          assert(file.compression.meshopt || approvedHeroAsset, `GLB exceeds the uncompressed size budget: ${file.url}`);
          if (file.compression.meshopt) assert(file.extensionsRequired.includes('EXT_meshopt_compression'), `Meshopt must be required for ${file.url}`);
        }
        const absolutePath = resolve(workspace, 'public', file.url.replace(/^\/+/, ''));
        const info = await stat(absolutePath);
        assert(info.isFile() && info.size === file.bytes, `Runtime file size drift: ${file.url}`);
        if (verifyHashes) {
          const buffer = await readFile(absolutePath);
          assert(createHash('sha256').update(buffer).digest('hex') === file.sha256, `Runtime SHA-256 drift: ${file.url}`);
        }
        tierCalculated.bytes += file.bytes;
        tierCalculated.meshes += file.meshCount;
        tierCalculated.primitives += file.primitiveCount;
        tierCalculated.triangles += file.triangles;
        tierCalculated.materials += file.materialCount;
      }
      assert(JSON.stringify(tierCalculated) === JSON.stringify(tier.totals), `${tierId} totals drift: ${asset.id}`);
    }
  }
  const calculated = { bytes: 0, meshes: 0, primitives: 0, triangles: 0, materials: 0 };
  for (const file of lod0.files) {
    assert(file.url.startsWith('/assets/') && file.url.endsWith('.glb'), `Unsafe runtime URL: ${file.url}`);
    assert(/^[a-f0-9]{64}$/.test(file.sha256), `Invalid runtime hash: ${file.url}`);
    assert(typeof file.compression?.meshopt === 'boolean', `Missing compression record: ${file.url}`);
    if (file.bytes > manifest.policy.maxUncompressedGlbBytes) {
      const approvedHeroAsset = HERO_OVERSIZE_ALLOWLIST.includes(file.url);
      assert(file.compression.meshopt || approvedHeroAsset, `GLB exceeds the uncompressed size budget: ${file.url}`);
      if (file.compression.meshopt) assert(file.extensionsRequired.includes('EXT_meshopt_compression'), `Meshopt must be required for ${file.url}`);
    }
    const absolutePath = resolve(workspace, 'public', file.url.replace(/^\/+/, ''));
    const info = await stat(absolutePath);
    assert(info.isFile() && info.size === file.bytes, `Runtime file size drift: ${file.url}`);
    if (verifyHashes) {
      const buffer = await readFile(absolutePath);
      assert(createHash('sha256').update(buffer).digest('hex') === file.sha256, `Runtime SHA-256 drift: ${file.url}`);
    }
    calculated.bytes += file.bytes;
    calculated.meshes += file.meshCount;
    calculated.primitives += file.primitiveCount;
    calculated.triangles += file.triangles;
    calculated.materials += file.materialCount;
  }
  assert(JSON.stringify(calculated) === JSON.stringify(lod0.totals), `LOD0 totals drift: ${asset.id}`);
  totalBytes += calculated.bytes;
  totalTriangles += calculated.triangles;
}

assert(manifest.totals.assetCount === EXPECTED_ASSETS.length, 'Manifest total asset count drift');
assert(manifest.totals.bytes === totalBytes, 'Manifest total byte count drift');
assert(manifest.totals.triangles === totalTriangles, 'Manifest total triangle count drift');
console.log(`Runtime manifest OK: ${EXPECTED_ASSETS.length} assets, ${(totalBytes / 1048576).toFixed(2)} MiB, ${totalTriangles.toLocaleString()} triangles, hashes ${verifyHashes ? 'verified' : 'skipped'}.`);
