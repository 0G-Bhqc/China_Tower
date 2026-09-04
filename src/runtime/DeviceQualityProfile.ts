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

// --- 运行时自适应降载 ------------------------------------------------------
// 加载定档只看静态信号（视口/内存/核数），进场景后的真实帧率无人看管：
// 高端机白白跑满、低端机一路卡顿。自适应 governor 看帧时间 EMA 的 2.5s
// 窗口均值，慢了逐级降载、快了带迟滞回升（连续 3 个快窗口才升一级）。
// 降载阶梯（只走可用项拼出的有效阶梯，无 bloom 的档自动跳过 bloom 级）：
//   DPR x0.85 → 关 bloom → 关 godrays → DPR x0.7
// 前两个窗口是着色器编译期，不参与判决；`?noadapt=1` 整段旁路（探针确定性）。
export type AdaptiveState = {
  level: number;
  pixelRatioScale: number;
  bloomOn: boolean;
  godRaysOn: boolean;
};

export function createAdaptiveGovernor(options: {
  bloomAvailable: boolean;
  godRaysAvailable: boolean;
  onLevel?: (state: AdaptiveState) => void;
}): { update: (frameMs: number) => void; level: number; disabled: boolean } {
  const disabled = new URLSearchParams(window.location.search).get('noadapt') === '1';
  const ladder: AdaptiveState[] = [
    { level: 0, pixelRatioScale: 1, bloomOn: options.bloomAvailable, godRaysOn: options.godRaysAvailable },
    { level: 1, pixelRatioScale: 0.85, bloomOn: options.bloomAvailable, godRaysOn: options.godRaysAvailable },
    { level: 2, pixelRatioScale: 0.85, bloomOn: false, godRaysOn: options.godRaysAvailable },
    { level: 3, pixelRatioScale: 0.85, bloomOn: false, godRaysOn: false },
    { level: 4, pixelRatioScale: 0.7, bloomOn: false, godRaysOn: false },
  ].filter((rung, index, all) => {
    if (index === 0) return true;
    const prev = all[index - 1];
    return rung.pixelRatioScale !== prev.pixelRatioScale
      || rung.bloomOn !== prev.bloomOn
      || rung.godRaysOn !== prev.godRaysOn;
  }).map((rung, index) => ({ ...rung, level: index }));
  let level = 0;
  let windowSum = 0;
  let windowCount = 0;
  let windowStart = performance.now();
  let windowsSeen = 0;
  let fastWindows = 0;
  const SLOW_MS = 26;
  const FAST_MS = 14;
  const WINDOW_MS = 2500;
  const WARMUP_WINDOWS = 2;
  return {
    get level() { return level; },
    disabled,
    update(frameMs: number): void {
      if (disabled) return;
      windowSum += frameMs;
      windowCount += 1;
      if (performance.now() - windowStart < WINDOW_MS) return;
      const average = windowSum / Math.max(1, windowCount);
      windowSum = 0;
      windowCount = 0;
      windowStart = performance.now();
      windowsSeen += 1;
      if (windowsSeen <= WARMUP_WINDOWS) return;
      if (average > SLOW_MS && level < ladder.length - 1) {
        level += 1;
        fastWindows = 0;
        options.onLevel?.(ladder[level]);
      } else if (average < FAST_MS && level > 0) {
        fastWindows += 1;
        if (fastWindows >= 3) {
          level -= 1;
          fastWindows = 0;
          options.onLevel?.(ladder[level]);
        }
      } else {
        fastWindows = 0;
      }
    },
  };
}
