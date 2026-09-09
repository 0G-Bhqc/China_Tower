import * as THREE from 'three';
import type { PavilionId } from '../createPavilionGalleryModel';
import { assetUrl } from './loadVerifiedGlb';

export type SceneLayerId = 'near' | 'mid' | 'far';

export type SceneMoodName = 'dawn' | 'clearDay' | 'autumnDusk' | 'deepDusk';

export type SceneMood = {
  name: SceneMoodName;
  skyTop: string;
  skyBottom: string;
  fogColor: string;
  fogDensity: number;
  sunColor: string;
  sunIntensity: number;
  waterColor: string;
  waterOpacity: number;
  ambientColor: string;
  ambientIntensity: number;
};

export type SceneCue = {
  id: string;
  title: string;
  line: string;
  observation: string;
  sceneAnchor: string;
  anchor: [number, number, number];
  focus: 'tower' | 'steps' | 'water' | 'horizon' | 'platform';
  camera: { position: [number, number, number]; target: [number, number, number]; fov?: number };
  /** 落幅后的缓慢运镜(世界单位/秒): 推/横移/ rising, 替代破坏构图的 autoRotate 环绕。 */
  drift?: [number, number, number];
  /** 镜头设计一句话, 供 UI 悬停与无障碍标签使用。 */
  shot?: string;
  mood: SceneMood;
};

export type ScenePackageSpec = {
  id: PavilionId;
  sourceLabel: string;
  packageUrl: string;
  packageReport: string;
  packageStatus: 'source-backed' | 'no-independent-environment-mesh';
  availableLayers: SceneLayerId[];
  sceneCenter: [number, number, number];
  defaultWater: { position: [number, number, number]; size: [number, number]; rotation: [number, number, number] };
  cues: [SceneCue, SceneCue, SceneCue];
};

const dawn: SceneMood = {
  name: 'dawn',
  skyTop: '#9eafb0', skyBottom: '#e6ded0', fogColor: '#a9b8b5', fogDensity: 0.018,
  sunColor: '#f2d19a', sunIntensity: 2.1, waterColor: '#466d73', waterOpacity: 0.82,
  ambientColor: '#b8c7c1', ambientIntensity: 1.2,
};
const clearDay: SceneMood = {
  name: 'clearDay',
  skyTop: '#7295a1', skyBottom: '#d9d7c8', fogColor: '#9aa9aa', fogDensity: 0.012,
  sunColor: '#f8d9a1', sunIntensity: 2.45, waterColor: '#3f6879', waterOpacity: 0.78,
  ambientColor: '#a9bfca', ambientIntensity: 1.24,
};
const autumnDusk: SceneMood = {
  name: 'autumnDusk',
  skyTop: '#765f5d', skyBottom: '#d6a27a', fogColor: '#987e76', fogDensity: 0.016,
  sunColor: '#ffd096', sunIntensity: 2.35, waterColor: '#4b6067', waterOpacity: 0.8,
  ambientColor: '#b18c80', ambientIntensity: 1.05,
};
// 落霞专属暮色：比 autumnDusk 再沉一度，天顶泛紫、江面收灰，
// 只给滕王阁「落霞孤鹜」一镜——长天落日需要比秋暮更低的底子。
const deepDusk: SceneMood = {
  name: 'deepDusk',
  skyTop: '#5c4a56', skyBottom: '#e08a52', fogColor: '#8a6a60', fogDensity: 0.017,
  sunColor: '#ff9a50', sunIntensity: 2.5, waterColor: '#4a4a5e', waterOpacity: 0.84,
  ambientColor: '#a07068', ambientIntensity: 1.0,
};

export const SCENE_CATALOG: Record<PavilionId, ScenePackageSpec> = {
  // 九镜重构(2026-09): 每镜 = 前景 + 主体 + 背景 三层; 机位一律压低、贴近前景,
  // 让栏杆/石阶/湖水/霞光真正入画; fov 按“辽阔用广、层叠用长”分配; drift 只做
  // 推近/横移/上升, 不再环绕(环绕会把落日与远山转出画外)。
  yueyang: {
    id: 'yueyang', sourceLabel: '审计 FBX · 未发现可独立分离的环境网格', packageUrl: '', packageReport: '/evidence/scene-packs/yueyang-environment.json', packageStatus: 'no-independent-environment-mesh', availableLayers: [], sceneCenter: [0, 0, 0], defaultWater: { position: [0, -0.08, -25], size: [110, 42], rotation: [-Math.PI / 2, 0, 0] },
    cues: [
      {
        id: 'dongting-dawn', title: '洞庭初晴', line: '衔远山，吞长江，浩浩汤汤',
        observation: '机位几乎贴住湖面——近景是碎浪与石阶倒影, 中景楼立水中, 远景雾中山; 水占六成, “浩浩汤汤”由水面自己说出来。',
        sceneAnchor: 'lake-horizon', anchor: [0, -0.02, -22], focus: 'water',
        camera: { position: [7.5, 1.6, 37], target: [-5, 8.5, -20], fov: 52 },
        drift: [0, 0.12, -0.55], shot: '贴水低机位 · 广角铺水 · 缓推近楼',
        mood: dawn,
      },
      {
        id: 'worry-and-joy', title: '凭轩忧乐', line: '先天下之忧而忧，后天下之乐而乐',
        observation: '站到石阶后三步仰首: 栏板与望柱压住画面下沿, 檐口层层收进天心; 人先被建筑托起, 再被天际线接走——忧乐在此交接。',
        sceneAnchor: 'stone-steps', anchor: [0, 0.5, 14], focus: 'steps',
        camera: { position: [31, 4.5, 45], target: [-1, 10, -3], fov: 32 },
        drift: [0, 0.22, -0.1], shot: '檐下仰视 · 长焦压缩重檐 · 缓升',
        mood: clearDay,
      },
      {
        id: 'heaven-and-earth', title: '乾坤日夜浮', line: '吴楚东南坼，乾坤日夜浮',
        observation: '退至高处侧逆光: 楼偏居一侧剪影, 湖天各一半, 远山横卧正中; 日夜交替的“浮”字, 落在水天交界的一线雾上。',
        sceneAnchor: 'lake-horizon', anchor: [0, 3, -42], focus: 'horizon',
        camera: { position: [-33, 16.5, 27], target: [5, 4.5, -20], fov: 44 },
        drift: [0.7, 0, 0], shot: '高处侧逆光 · 湖天对半 · 缓横移',
        mood: autumnDusk,
      },
    ],
  },
  huanghe: {
    id: 'huanghe', sourceLabel: '审计 FBX · 主楼外缘场地构件', packageUrl: assetUrl('/assets/scene-pack/huanghe-environment.glb'), packageReport: '/evidence/scene-packs/huanghe-environment.json', packageStatus: 'source-backed', availableLayers: ['near', 'mid'], sceneCenter: [0, 0, 0], defaultWater: { position: [0, -0.08, -27], size: [110, 45], rotation: [-Math.PI / 2, 0, 0] },
    cues: [
      {
        id: 'white-clouds', title: '白云千载', line: '白云千载空悠悠',
        observation: '退后仰观: 塔身完整居中, 五层翼角自下而上刺破晨雾, 云只留顶上一线——千年之感来自完整的向上的形。',
        sceneAnchor: 'tower-roofline', anchor: [0, 18, 0], focus: 'tower',
        camera: { position: [34, 10, 38], target: [0, 15, -2], fov: 40 },
        drift: [0, 0.25, -0.1], shot: '退后仰观 · 塔身完整 · 刺云',
        mood: dawn,
      },
      {
        id: 'clear-river', title: '晴川远望', line: '晴川历历汉阳树，芳草萋萋鹦鹉洲',
        observation: '楼居右三分作框, 江面与远岸向左横展, 对岸城郭历历在目; 晴川之“历历”, 靠塔与岸的相互位置交代。',
        sceneAnchor: 'river-horizon', anchor: [0, 4, -40], focus: 'horizon',
        camera: { position: [44, 20, 32], target: [-8, 8, -16], fov: 38 },
        drift: [-0.4, 0, -0.2], shot: '楼为画框 · 右三分割 · 江岸左展',
        mood: clearDay,
      },
      {
        id: 'river-at-dusk', title: '日暮乡关', line: '日暮乡关何处是？烟波江上使人愁',
        observation: '迎着暮色站定: 塔身完整, 轮廓压住暖天, 烟波横在楼脚; 愁不在楼上, 在楼外的水面上。',
        sceneAnchor: 'river-water', anchor: [0, -0.02, -28], focus: 'water',
        camera: { position: [-33, 6, 30], target: [8, 10, -12], fov: 44 },
        drift: [0, 0.08, -0.35], shot: '迎暮而立 · 塔身完整 · 烟波横前',
        mood: autumnDusk,
      },
    ],
  },
  tengwang: {
    id: 'tengwang', sourceLabel: '审计 FBX · 临江组团来源存疑，运行时不采用', packageUrl: '', packageReport: '/evidence/scene-packs/tengwang-environment.json', packageStatus: 'no-independent-environment-mesh', availableLayers: ['mid', 'far'], sceneCenter: [0, 0, 0], defaultWater: { position: [0, -0.08, -24], size: [110, 42], rotation: [-Math.PI / 2, 0, 0] },
    cues: [
      {
        id: 'third-autumn', title: '序属三秋', line: '潦水尽而寒潭清，烟光凝而暮山紫',
        observation: '沿高台边缘平视推进: 台面与栏杆作前景引导线, 高阁居中、秋水在下、暮山紫气在上, 三秋之序由近及远铺陈。',
        sceneAnchor: 'high-terrace', anchor: [0, 2.2, 8], focus: 'platform',
        camera: { position: [27, 8, 33], target: [0, 8, -6], fov: 42 },
        drift: [0, 0.08, -0.45], shot: '台缘平视 · 退后收全台 · 缓推入序',
        mood: autumnDusk,
      },
      {
        id: 'south-bank-cloud', title: '南浦朝云', line: '画栋朝飞南浦云，珠帘暮卷西山雨',
        observation: '横向掠过檐前: 高阁压住框心、画栋自右入、朝云自左出, 珠帘半卷处暮雨将至; 横移的运镜本身就是“飞”与“卷”。',
        sceneAnchor: 'river-bank', anchor: [0, 3, -12], focus: 'platform',
        camera: { position: [-38, 15, 25], target: [2, 6, -2], fov: 38 },
        drift: [0.8, 0, -0.1], shot: '侧向横掠 · 退后叠檐 · 云随栋走',
        mood: dawn,
      },
      {
        id: 'sunset-glow', title: '落霞孤鹜', line: '落霞与孤鹜齐飞，秋水共长天一色',
        observation: '正对落日贴水站定: 日轮悬于上三分点, 霞光光路自脚下铺向天际, 孤鹜恰过霞心; 楼偏左作秤砣, 江天占七成。',
        sceneAnchor: 'sunset-glow', anchor: [-24, 0.5, -12], focus: 'horizon',
        camera: { position: [21, 2.6, 27], target: [-19, 7.5, -17], fov: 48 },
        drift: [0, 0.06, -0.4], shot: '迎日贴水 · 日悬三分 · 光路铺江',
        mood: deepDusk,
      },
    ],
  },
};

export function getSceneSpec(id: PavilionId): ScenePackageSpec {
  return SCENE_CATALOG[id];
}

export function getSceneCue(id: PavilionId, cueId: string | undefined): SceneCue {
  const spec = getSceneSpec(id);
  return spec.cues.find((cue) => cue.id === cueId) ?? spec.cues[0];
}

export function sceneCueVector(values: [number, number, number]): THREE.Vector3 {
  return new THREE.Vector3(values[0], values[1], values[2]);
}
