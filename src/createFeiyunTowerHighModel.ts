import * as THREE from 'three';
import { selectAvailableLod, type RuntimeLod } from './runtime/DeviceQualityProfile';
import { isAbortError, loadVerifiedGlb, type PavilionModelLoadOptions } from './runtime/loadVerifiedGlb';

export type FeiyunPavilionModelLoadOptions = PavilionModelLoadOptions;

export function createFeiyunTowerHighModel(_loadOptions: PavilionModelLoadOptions = {}): THREE.Group {
  const root = new THREE.Group();
  root.name = 'feiyun-placeholder-root';
  root.userData.runtimeLod = 'disabled';
  root.userData.highModelReady = false;
  root.userData.highModelLoadError = true;
  root.userData.highModelLoadErrorReason = 'removed-from-gallery';
  window.dispatchEvent(new CustomEvent('china-towers-model-ready', { detail: 'feiyun' }));
  return root;
}
