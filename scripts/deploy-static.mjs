// 一键部署：build:final-html（构建 + 归档裁剪 + 契约校验）跑完后，
// 输出部署清单与缓存/反代配置片段。用法：
//
//   node scripts/deploy-static.mjs                 # 根部署 /
//   DEPLOY_BASE=/towers/ node scripts/deploy-static.mjs   # 子路径部署
//
// DEPLOY_BASE 必须以 / 开头和结尾。dist/ 整体搬到站点 <basePath> 下即可。
import { spawnSync } from 'node:child_process';
import { readFile, stat } from 'node:fs/promises';
import { resolve } from 'node:path';

const workspace = resolve(import.meta.dirname, '..');
const rawBase = process.env.DEPLOY_BASE ?? '/';
const base = `/${rawBase.replace(/^\/+|\/+$/g, '')}/`.replace(/^\/\//, '/');
if (rawBase !== '/' && !rawBase.endsWith('/')) {
  console.warn(`DEPLOY_BASE normalized to ${base} (must start and end with /).`);
}

const build = spawnSync('node', ['node_modules/typescript/bin/tsc', '--noEmit'], { cwd: workspace, stdio: 'inherit' });
if (build.status !== 0) throw new Error('tsc failed.');
const vite = spawnSync('node', ['node_modules/vite/bin/vite.js', 'build'], { cwd: workspace, stdio: 'inherit', env: { ...process.env, DEPLOY_BASE: base } });
if (vite.status !== 0) throw new Error('vite build failed.');
const steps = ['scripts/build-final-html.mjs', 'scripts/verify-final-html.mjs'];
for (const step of steps) {
  const run = spawnSync('node', [step], { cwd: workspace, stdio: 'inherit', env: { ...process.env, DEPLOY_BASE: base } });
  if (run.status !== 0) throw new Error(`${step} failed.`);
}

const dist = resolve(workspace, 'dist');
const release = JSON.parse(await readFile(resolve(dist, 'china-towers.release.json'), 'utf8'));
const glbs = release.files.filter((file) => file.path.endsWith('.glb'));
const totalBytes = release.files.reduce((sum, file) => sum + file.bytes, 0);
const glbBytes = glbs.reduce((sum, file) => sum + file.bytes, 0);
const gb = (bytes) => `${(bytes / 1024 ** 3).toFixed(2)} GB`;
console.log('');
console.log(`DEPLOY OK  base=${release.deployment.basePath}  files=${release.files.length}  total=${gb(totalBytes)}  glb=${glbs.length} (${gb(glbBytes)})`);
console.log(`把 dist/ 整个目录搬到站点 ${release.deployment.basePath} 下，入口 ${release.deployment.entry}。`);
console.log('');
console.log('--- 缓存头建议 ---');
console.log('china-towers.html / index.html：Cache-Control: no-cache');
console.log('assets/*（哈希文件名）：Cache-Control: public, max-age=31536000, immutable');
console.log('*.glb（固定文件名）：Cache-Control: no-cache（带版本目录才可用 immutable），Content-Type: model/gltf-binary');
console.log('');
console.log('--- nginx 片段 ---');
console.log(`location ${release.deployment.basePath} { alias <站点根>${release.deployment.basePath}; }`);
console.log(`location = ${release.deployment.basePath}china-towers.html { add_header Cache-Control "no-cache"; }`);
console.log(`location ~ \\.glb$ { add_header Content-Type "model/gltf-binary"; }`);
try { await stat(resolve(dist, 'china-towers.html')); } catch { throw new Error('Deployment entry missing after build.'); }
