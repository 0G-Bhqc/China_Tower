import { createHash } from 'node:crypto';
import { readdir, readFile, stat, writeFile } from 'node:fs/promises';
import { relative, resolve } from 'node:path';

const workspace = resolve(import.meta.dirname, '..');
const dist = resolve(workspace, 'dist');
const indexPath = resolve(dist, 'index.html');
const entryPath = resolve(dist, 'china-towers.html');
const manifestPath = resolve(dist, 'china-towers.release.json');

async function walk(dir) {
  const entries = await readdir(dir, { withFileTypes: true });
  const nested = await Promise.all(entries.map(async (entry) => {
    const full = resolve(dir, entry.name);
    return entry.isDirectory() ? walk(full) : [full];
  }));
  return nested.flat();
}

const html = await readFile(indexPath, 'utf8');
const scriptMatch = html.match(/<script type="module" crossorigin src="([^"]+)"><\/script>/);
const styleMatch = html.match(/<link rel="stylesheet" crossorigin href="([^"]+)">/);
if (!scriptMatch || !styleMatch) throw new Error('Expected Vite JavaScript and stylesheet references in the deployment entry.');

// This is a directory-deployment alias, not a false claim of an offline one-file
// package. The app intentionally keeps code and verified GLBs on demand.
await writeFile(entryPath, html, 'utf8');
const files = (await walk(dist)).filter((file) => file !== manifestPath);
const inventory = await Promise.all(files.map(async (file) => {
  const [contents, info] = await Promise.all([readFile(file), stat(file)]);
  return {
    path: relative(dist, file).replaceAll('\\', '/'),
    bytes: info.size,
    sha256: createHash('sha256').update(contents).digest('hex'),
  };
}));
const glbFiles = inventory.filter((file) => file.path.endsWith('.glb'));
if (glbFiles.length < 15) throw new Error(`Expected at least 15 runtime GLBs, found ${glbFiles.length}.`);

const release = {
  schemaVersion: 1,
  generatedAt: new Date().toISOString(),
  deployment: {
    entry: 'china-towers.html',
    basePath: '/',
    mode: 'directory-deployment',
    runtimeAssetPolicy: 'Verified GLBs are fetched on demand from /assets; this package is not an offline single HTML file.',
  },
  entryAssets: { script: scriptMatch[1], stylesheet: styleMatch[1] },
  files: inventory,
};
await writeFile(manifestPath, `${JSON.stringify(release, null, 2)}\n`, 'utf8');
console.log(`Deployment entry written: ${entryPath}`);
console.log(`Release manifest: ${manifestPath} (${inventory.length} files, ${glbFiles.length} GLBs)`);
