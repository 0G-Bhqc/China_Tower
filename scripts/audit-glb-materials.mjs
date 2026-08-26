// Quick GLB material audit: how many materials carry baseColorTexture vs plain factors.
import { readFile } from 'node:fs/promises';

function parseGlbJson(buffer) {
  const jsonLength = buffer.readUInt32LE(12);
  return JSON.parse(buffer.subarray(20, 20 + jsonLength).toString('utf8').trimEnd());
}

const files = process.argv.slice(2);
for (const file of files) {
  const buffer = await readFile(file);
  const gltf = parseGlbJson(buffer);
  const images = gltf.images ?? [];
  let textured = 0;
  let plain = 0;
  const plainFactors = new Map();
  for (const mat of gltf.materials ?? []) {
    const tex = mat.pbrMetallicRoughness?.baseColorTexture;
    if (tex) {
      textured += 1;
      continue;
    }
    plain += 1;
    const f = mat.pbrMetallicRoughness?.baseColorFactor ?? [1, 1, 1, 1];
    const key = f.slice(0, 3).map((v) => v.toFixed(2)).join(',');
    plainFactors.set(key, (plainFactors.get(key) ?? 0) + 1);
  }
  const topPlain = [...plainFactors.entries()].sort((a, b) => b[1] - a[1]).slice(0, 4);
  const metallic = new Map();
  for (const mat of gltf.materials ?? []) {
    const m = mat.pbrMetallicRoughness?.metallicFactor ?? 1;
    const key = m.toFixed(2);
    metallic.set(key, (metallic.get(key) ?? 0) + 1);
  }
  const topMetallic = [...metallic.entries()].sort((a, b) => b[1] - a[1]);
  const name = file.split(/[\\/]/).pop();
  console.log(
    `${name}: images=${images.length} materials=${gltf.materials?.length ?? 0} textured=${textured} plain=${plain}`,
  );
  for (const [factor, count] of topPlain) console.log(`    plain factor ${factor} x${count}`);
  for (const [factor, count] of topMetallic) console.log(`    metallicFactor ${factor} x${count}`);
}
