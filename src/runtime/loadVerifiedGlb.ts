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
  if (!url.startsWith('/assets/') || !url.endsWith('.glb')) throw new Error(`Rejected runtime asset URL: ${url}`);
  if (options.signal?.aborted) throw abortError();
  console.log('[loadVerifiedGlb] Starting fetch for', url);
  const response = await fetch(url, { signal: options.signal, cache: 'force-cache', credentials: 'same-origin' });
  console.log('[loadVerifiedGlb] Fetch response status:', response.status, 'for', url);
  if (!response.ok) throw new Error(`Failed to load ${url}: HTTP ${response.status}`);
  console.log('[loadVerifiedGlb] Reading buffer for', url);
  const buffer = await response.arrayBuffer();
  console.log('[loadVerifiedGlb] Buffer read complete, size:', buffer.byteLength, 'for', url);
  if (options.signal?.aborted) throw abortError();
  const loader = new GLTFLoader();
  loader.setMeshoptDecoder(MeshoptDecoder);
  const baseUrl = new URL('.', new URL(url, window.location.href)).href;
  console.log('[loadVerifiedGlb] Parsing GLB for', url);
  const gltf = await loader.parseAsync(buffer, baseUrl);
  console.log('[loadVerifiedGlb] GLB parsed successfully for', url);
  if (options.signal?.aborted) {
    disposeScene(gltf.scene);
    throw abortError();
  }

  let meshCount = 0;
  let materialSummary: string[] = [];
  gltf.scene.traverse((object) => {
    if (!(object instanceof THREE.Mesh)) return;
    meshCount += 1;
    const materials = Array.isArray(object.material) ? object.material : [object.material];
    for (const material of materials) {
      const name = typeof material.name === 'string' ? material.name : 'unknown';
      const hasMap = Boolean((material as THREE.MeshStandardMaterial).map);
      materialSummary.push(`${name}${hasMap ? '+map' : ''}`);
    }
  });

  console.log('[loadVerifiedGlb]', url, 'meshes=', meshCount, 'materials=', materialSummary.slice(0, 20));

  return gltf;
}

