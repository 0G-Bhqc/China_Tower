// 一键拉取运行时资产: pnpm assets
// 从 GitHub Release 下载 asset-pack-v1.zip, 校验 SHA-256 后解到 public/assets/。
// 用法: node scripts/fetch-assets.mjs [--force]
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative, resolve } from 'node:path';

const ROOT = resolve(import.meta.dirname, '..');
const REPO = '0G-Bhqc/China_Tower';
const TAG = 'assets-v1';
const ZIP = 'asset-pack-v1.zip';
const MARKER = join(ROOT, 'public', 'assets', '.asset-pack-v1.ok');

if (existsSync(MARKER) && !process.argv.includes('--force')) {
  console.log('资产已就绪 (public/assets/.asset-pack-v1.ok 存在), 加 --force 可重拉。');
  process.exit(0);
}

const base = `https://github.com/${REPO}/releases/download/${TAG}`;
const work = join(tmpdir(), 'china-tower-asset-pack');
mkdirSync(work, { recursive: true });
const zipPath = join(work, ZIP);

console.log(`下载 ${base}/${ZIP} ...`);
execFileSync('curl', ['-L', '--fail', '--retry', '3', '-o', zipPath, `${base}/${ZIP}`], { stdio: 'inherit' });

console.log('校验 SHA-256 ...');
const sumPath = join(work, ZIP + '.sha256');
execFileSync('curl', ['-L', '--fail', '-o', sumPath, `${base}/${ZIP}.sha256`], { stdio: 'inherit' });
const expected = readFileSync(sumPath, 'utf8').split(/\s+/)[0];
const actual = createHash('sha256').update(readFileSync(zipPath)).digest('hex');
if (expected !== actual) throw new Error(`校验失败: 期望 ${expected}, 实际 ${actual}`);
console.log('校验通过, 解压到 public/assets/ ...');

// 注意: Windows bsdtar 不认绝对路径盘符冒号, 用 cwd + 相对路径
const publicDir = join(ROOT, 'public');
execFileSync('tar', ['-xf', relative(publicDir, zipPath)], { cwd: publicDir });
writeFileSync(MARKER, `${TAG} ${actual}\n`);
rmSync(work, { recursive: true, force: true });
console.log('资产就绪, 可以 pnpm dev 了。');
