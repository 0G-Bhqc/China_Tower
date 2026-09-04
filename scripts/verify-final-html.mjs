import { createHash } from 'node:crypto';
import { access, readFile, stat } from 'node:fs/promises';
import { resolve } from 'node:path';

const workspace = resolve(import.meta.dirname, '..');
const dist = resolve(workspace, 'dist');
const entryPath = resolve(dist, 'china-towers.html');
const releasePath = resolve(dist, 'china-towers.release.json');
const assert = (condition, message) => { if (!condition) throw new Error(message); };

const [html, releaseText, entryInfo] = await Promise.all([readFile(entryPath, 'utf8'), readFile(releasePath, 'utf8'), stat(entryPath)]);
const release = JSON.parse(releaseText);
const scriptMatch = html.match(/<script type="module" crossorigin src="([^"]+)"><\/script>/);
const styleMatch = html.match(/<link rel="stylesheet" crossorigin href="([^"]+)">/);
assert(entryInfo.size > 1_000, 'Deployment HTML is unexpectedly small.');
assert(scriptMatch && styleMatch, 'Deployment entry must retain Vite JS and CSS references.');
assert(release?.deployment?.mode === 'directory-deployment', 'Release manifest must describe directory deployment.');
assert(release?.deployment?.entry === 'china-towers.html', 'Release manifest entry mismatch.');
// The product is frozen at three towers (飞云/蓬莱 are archive-only and no
// longer in the nav). Assert the exact ids rather than a bare count, so a
// duplicate or a stray selector cannot satisfy the check either.
const pavilionIds = [...html.matchAll(/data-pavilion="([a-z]+)"/g)].map((match) => match[1]);
assert(
  pavilionIds.length === 3 && ['yueyang', 'huanghe', 'tengwang'].every((id) => pavilionIds.includes(id)),
  `Expected exactly the three frozen pavilion selectors (yueyang, huanghe, tengwang), found: ${pavilionIds.join(', ') || 'none'}.`,
);
assert(/id="scene"/.test(html) && /id="explode"/.test(html) && /id="reset-view"/.test(html), 'Deployment HTML is missing a required interaction control.');
assert(Array.isArray(release.files) && release.files.length > 15, 'Release manifest file inventory is incomplete.');
const glbs = release.files.filter((file) => file.path.endsWith('.glb'));
// 子路径部署下入口引用带基座前缀（/towers/assets/x.js），
// 剥掉 basePath 再落到 dist 相对路径上校验。
const basePath = release?.deployment?.basePath ?? '/';
const stripBase = (url) => url.replace(/^\//, '').replace(new RegExp(`^${basePath.replace(/^\//, '').replace(/\/$/, '')}/`), '');
// 归档裁剪后：三楼成品 + 备用 LOD + 环境包 + 孤鹜 ≈ 14 个；
// 飞云/蓬莱/review GLB 不得出现（超 1.5GB，白白进部署包）。
assert(glbs.length >= 10, `Expected at least 10 GLB entries, found ${glbs.length}.`);
assert(!glbs.some((file) => /feiyun-|penglai-|-semantic-hierarchy\.review\.glb$/.test(file.path)), 'Archived/review GLBs must not ship in dist.');
for (const resource of [scriptMatch[1], styleMatch[1], `${basePath.replace(/\/?$/, '/')}assets/pavilion-assets.manifest.json`]) {
  await access(resolve(dist, stripBase(resource)));
}
for (const file of release.files) {
  const fullPath = resolve(dist, file.path);
  const contents = await readFile(fullPath);
  const hash = createHash('sha256').update(contents).digest('hex');
  assert(hash === file.sha256, `Release hash mismatch: ${file.path}`);
}
console.log(`Directory deployment contract OK: ${release.files.length} hashed files, ${glbs.length} GLBs, verified entry assets.`);
