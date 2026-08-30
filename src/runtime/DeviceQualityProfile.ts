export type RuntimeLod = 'lod0' | 'lod1' | 'lod2';

type NavigatorWithDeviceMemory = Navigator & { deviceMemory?: number };

export type DeviceQualityProfile = {
  id: 'hero' | 'standard' | 'mobile';
  preferredLod: RuntimeLod;
  pixelRatioCap: number;
  shadowMapSize: number;
  shadowTechnique: 'pcf-soft' | 'pcf';
  shadowRadius: number;
  shadowBlurSamples: number;
  toneMappingExposure: number;
  environmentIntensity: number;
};

const PROFILES: Record<DeviceQualityProfile['id'], DeviceQualityProfile> = {
  hero: {
    id: 'hero', preferredLod: 'lod0', pixelRatioCap: 1.75, shadowMapSize: 4096,
    shadowTechnique: 'pcf-soft', shadowRadius: 3.5, shadowBlurSamples: 16,
    toneMappingExposure: 1.05, environmentIntensity: 1.12,
  },
  standard: {
    id: 'standard', preferredLod: 'lod1', pixelRatioCap: 1.35, shadowMapSize: 2048,
    shadowTechnique: 'pcf-soft', shadowRadius: 2.5, shadowBlurSamples: 8,
    toneMappingExposure: 1.02, environmentIntensity: 1,
  },
  mobile: {
    id: 'mobile', preferredLod: 'lod2', pixelRatioCap: 1, shadowMapSize: 768,
    shadowTechnique: 'pcf', shadowRadius: 1, shadowBlurSamples: 4,
    toneMappingExposure: 0.98, environmentIntensity: 0.9,
  },
};

export function detectDeviceQualityProfile(): DeviceQualityProfile {
  const params = new URLSearchParams(window.location.search);
  const forced = params.get('quality');
  if (forced === 'hero' || forced === 'standard' || forced === 'mobile') return PROFILES[forced];
  // Evidence capture remains tied to the immutable LOD0 master unless the URL
  // explicitly requests another tier for an LOD comparison pass.
  if (params.get('review') === '1') return PROFILES.hero;
  const navigatorInfo = navigator as NavigatorWithDeviceMemory;
  const narrowViewport = Math.min(window.innerWidth, window.innerHeight) < 720;
  // deviceMemory 是最可靠的低配信号; CPU 核数只在极少 (≤2) 时才视为受限,
  // 否则四核桌面会被误降档 (无 bloom、最小阴影图)。
  const constrainedMemory = typeof navigatorInfo.deviceMemory === 'number' && navigatorInfo.deviceMemory <= 4;
  const constrainedCpu = typeof navigatorInfo.hardwareConcurrency === 'number' && navigatorInfo.hardwareConcurrency <= 2;
  if (narrowViewport || constrainedMemory || constrainedCpu) return PROFILES.mobile;
  return PROFILES.standard;
}

export function selectAvailableLod(available: Partial<Record<RuntimeLod, string>>): RuntimeLod {
  const forcedLod = new URLSearchParams(window.location.search).get('lod') as RuntimeLod | null;
  if (forcedLod && available[forcedLod]) return forcedLod;
  const preferred = detectDeviceQualityProfile().preferredLod;
  if (available[preferred]) return preferred;
  if (preferred === 'lod2' && available.lod1) return 'lod1';
  if (available.lod0) return 'lod0';
  if (available.lod1) return 'lod1';
  if (available.lod2) return 'lod2';
  throw new Error('No runtime LOD URL is available');
}
