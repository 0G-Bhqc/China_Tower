import * as THREE from 'three';
import { GLTFLoader, type GLTF } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { MeshoptDecoder } from 'three/examples/jsm/libs/meshopt_decoder.module.js';

export type PavilionLoadProgress = {
  loaded: number;
  total: number;
  ratio: number;
};

export type PavilionModelLoadOptions = {
  signal?: AbortSignal;
  onProgress?: (progress: PavilionLoadProgress) => void;
};

function abortError(): DOMException {
  return new DOMException('Pavilion asset load aborted', 'AbortError');
}

export function isAbortError(error: unknown): boolean {
  return error instanceof DOMException && error.name === 'AbortError';
}

// 子路径部署：运行时资产 URL 统一经这里拼装。Vite 按构建时的 base
//（`DEPLOY_BASE`，默认 `/`）注入 import.meta.env.BASE_URL；dev 下恒为 `/`，
// 与原来的根绝对路径行为一致。调用方一律传 `/assets/...` 形式。
export function assetUrl(path: string): string {
  const base = import.meta.env.BASE_URL || '/';
  return `${base.replace(/\/?$/, '/')}${path.replace(/^\//, '')}`;
}

function disposeScene(scene: THREE.Object3D): void {
  scene.traverse((object) => {
    if (!(object instanceof THREE.Mesh)) return;
    object.geometry.dispose();
    const materials = Array.isArray(object.material) ? object.material : [object.material];
    for (const material of materials) material.dispose();
  });
}

async function responseBuffer(response: Response, options: PavilionModelLoadOptions): Promise<ArrayBuffer> {
  const total = Number(response.headers.get('content-length')) || 0;
  if (!response.body || !options.onProgress) return response.arrayBuffer();
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let loaded = 0;
  while (true) {
    if (options.signal?.aborted) {
      await reader.cancel();
      throw abortError();
    }
    const result = await reader.read();
    if (result.done) break;
    chunks.push(result.value);
    loaded += result.value.byteLength;
    options.onProgress({ loaded, total, ratio: total > 0 ? loaded / total : 0 });
  }
  const joined = new Uint8Array(loaded);
  let offset = 0;
  for (const chunk of chunks) {
    joined.set(chunk, offset);
    offset += chunk.byteLength;
  }
  options.onProgress({ loaded, total: total || loaded, ratio: 1 });
  return joined.buffer;
}

export async function loadVerifiedGlb(url: string, options: PavilionModelLoadOptions = {}): Promise<GLTF> {
  // 白名单看路径段而非前缀：子路径部署下 URL 形如 /towers/assets/x.glb。
  if (!url.includes('/assets/') || !url.endsWith('.glb')) throw new Error(`Rejected runtime asset URL: ${url}`);
  if (options.signal?.aborted) throw abortError();
  const response = await fetch(url, { signal: options.signal, cache: 'force-cache', credentials: 'same-origin' });
  if (!response.ok) throw new Error(`Failed to load ${url}: HTTP ${response.status}`);
  // Stream through responseBuffer so onProgress fires per chunk — the loader
  // otherwise sits at "…" for the whole multi-megabyte GLB fetch.
  const buffer = await responseBuffer(response, options);
  if (options.signal?.aborted) throw abortError();
  const loader = new GLTFLoader();
  loader.setMeshoptDecoder(MeshoptDecoder);
  const baseUrl = new URL('.', new URL(url, window.location.href)).href;
  const gltf = await loader.parseAsync(buffer, baseUrl);
  if (options.signal?.aborted) {
    disposeScene(gltf.scene);
    throw abortError();
  }
  // GLB atlases default to anisotropy 1, so dense high-contrast patterns
  // (the gold-tile grout dots) shimmer into glitter at grazing angles and
  // distance. Request anisotropic sampling; the renderer clamps this to the
  // hardware maximum at upload.
  gltf.scene.traverse((object) => {
    if (!(object instanceof THREE.Mesh)) return;
    const materials = Array.isArray(object.material) ? object.material : [object.material];
    for (const material of materials) {
      if (!(material instanceof THREE.MeshStandardMaterial || material instanceof THREE.MeshPhysicalMaterial)) continue;
      const maps = [
        material.map, material.normalMap, material.roughnessMap,
        material.metalnessMap, material.aoMap, material.emissiveMap,
      ];
      for (const texture of maps) {
        if (!texture) continue;
        texture.anisotropy = 8;
        texture.needsUpdate = true;
      }
    }
  });

  return gltf;
}

