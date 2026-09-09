// 打包运行时资产: node scripts/package-asset-pack.mjs [--out asset-pack]
// 只收录三座楼阁运行时真正会 fetch 的 GLB (见 docs/ASSETS.md 分级)。
// review 中间产物 (*.review.glb)、feiyun/penglai、evidence/ 一律不进包。
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';

const ROOT = resolve(import.meta.dirname, '..');
const ASSETS = join(ROOT, 'public', 'assets');

// 运行时必需 (src + pavilion-assets.manifest.json 实际引用的 URL 去掉 /assets/ 前缀)
export const PACK_FILES = [
  'yueyang-architectural-lod.glb',
  'yueyang-architectural-lod1.glb',
  'yueyang-architectural-lod2.glb',
  'huanghe-main-tower-highmodel.glb',
  'huanghe-main-tower-lod1.glb',
  'huanghe-main-tower-lod2.glb',
  'tengwang-main-tower-highmodel.glb',
  'tengwang-main-tower-lod1.glb',
  'tengwang-main-tower-lod2.glb',
  'tengwang-high-precision/tengwang-master-web.glb',
  'scene-pack/huanghe-environment.glb',
  'bird/stork.glb',
];

const outIdx = process.argv.indexOf('--out');
const OUT = resolve(ROOT, outIdx > 0 ? process.argv[outIdx + 1] : 'asset-pack');
mkdirSync(OUT, { recursive: true });

let total = 0;
for (const f of PACK_FILES) {
  const p = join(ASSETS, f);
  if (!existsSync(p)) throw new Error(`缺资产无法打包: ${p}`);
  total += statSync(p).size;
}
console.log(`文件 ${PACK_FILES.length} 个, 合计 ${(total / 1048576).toFixed(1)} MB`);

const zip = join(OUT, 'asset-pack-v1.zip');
try {
  // 注意: Windows bsdtar 会把绝对路径里的盘符冒号当远程地址, 必须相对路径 + cwd
  const publicDir = join(ROOT, 'public');
  const zipRel = relative(publicDir, zip);
  execFileSync('tar', ['-a', '-c', '-f', zipRel, ...PACK_FILES.map((f) => `assets/${f}`)], { cwd: publicDir });
} catch {
  throw new Error('打包需要系统 tar(Win10 自带), 请检查 PATH');
}

const hash = createHash('sha256').update(readFileSync(zip)).digest('hex');
writeFileSync(zip + '.sha256', `${hash}  asset-pack-v1.zip\n`);
console.log(`已生成 ${zip} (${(statSync(zip).size / 1048576).toFixed(1)} MB)`);
console.log(`sha256: ${hash}`);
