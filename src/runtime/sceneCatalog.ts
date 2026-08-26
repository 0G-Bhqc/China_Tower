import * as THREE from 'three';
import type { PavilionId } from '../createPavilionGalleryModel';

export type SceneLayerId = 'near' | 'mid' | 'far';

export type SceneMood = {
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
  camera: { position: [number, number, number]; target: [number, number, number] };
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
  skyTop: '#9eafb0', skyBottom: '#e6ded0', fogColor: '#a9b8b5', fogDensity: 0.018,
  sunColor: '#f2d19a', sunIntensity: 2.1, waterColor: '#466d73', waterOpacity: 0.82,
  ambientColor: '#b8c7c1', ambientIntensity: 1.2,
};
const clearDay: SceneMood = {
  skyTop: '#7295a1', skyBottom: '#d9d7c8', fogColor: '#9aa9aa', fogDensity: 0.012,
  sunColor: '#f8d9a1', sunIntensity: 2.45, waterColor: '#3f6879', waterOpacity: 0.78,
  ambientColor: '#a9bfca', ambientIntensity: 1.24,
};
const autumnDusk: SceneMood = {
  skyTop: '#765f5d', skyBottom: '#d6a27a', fogColor: '#987e76', fogDensity: 0.016,
  sunColor: '#ffd096', sunIntensity: 2.35, waterColor: '#4b6067', waterOpacity: 0.8,
  ambientColor: '#b18c80', ambientIntensity: 1.05,
};

export const SCENE_CATALOG: Record<PavilionId, ScenePackageSpec> = {
  yueyang: {
    id: 'yueyang', sourceLabel: '审计 FBX · 未发现可独立分离的环境网格', packageUrl: '', packageReport: '/evidence/scene-packs/yueyang-environment.json', packageStatus: 'no-independent-environment-mesh', availableLayers: [], sceneCenter: [0, 0, 0], defaultWater: { position: [0, -0.08, -25], size: [110, 42], rotation: [-Math.PI / 2, 0, 0] },
    cues: [
      { id: 'dongting-dawn', title: '洞庭初晴', line: '衔远山，吞长江，浩浩汤汤', observation: '从城台石作看向湖面，楼阁的台基成为开阔水势的近景边界。', sceneAnchor: 'lake-horizon', anchor: [0, -0.02, -22], focus: 'water', camera: { position: [23, 7.5, 27], target: [0, 8.5, -12] }, mood: dawn },
      { id: 'worry-and-joy', title: '凭轩忧乐', line: '先天下之忧而忧，后天下之乐而乐', observation: '将镜头压到檐下高度，先读栏杆、台阶与楼身，再把视线抬向天际。', sceneAnchor: 'stone-steps', anchor: [0, 0.5, 14], focus: 'steps', camera: { position: [16, 4.1, 19], target: [0, 7.8, 1] }, mood: clearDay },
      { id: 'heaven-and-earth', title: '乾坤日夜浮', line: '吴楚东南坼，乾坤日夜浮', observation: '让建筑退入画面一侧，湖天比例扩大，体会楼与天地的尺度转换。', sceneAnchor: 'lake-horizon', anchor: [0, 3, -42], focus: 'horizon', camera: { position: [-27, 12, 21], target: [0, 8, -17] }, mood: clearDay },
    ],
  },
  huanghe: {
    id: 'huanghe', sourceLabel: '审计 FBX · 主楼外缘场地构件', packageUrl: '/assets/scene-pack/huanghe-environment.glb', packageReport: '/evidence/scene-packs/huanghe-environment.json', packageStatus: 'source-backed', availableLayers: ['near', 'mid'], sceneCenter: [0, 0, 0], defaultWater: { position: [0, -0.08, -27], size: [110, 45], rotation: [-Math.PI / 2, 0, 0] },
    cues: [
      { id: 'white-clouds', title: '白云千载', line: '白云千载空悠悠', observation: '沿五层檐口向上读楼，背景保持低对比，让时间感停留在楼顶与云间。', sceneAnchor: 'tower-roofline', anchor: [0, 18, 0], focus: 'tower', camera: { position: [24, 23, 30], target: [0, 17, 0] }, mood: clearDay },
      { id: 'clear-river', title: '晴川远望', line: '晴川历历汉阳树，芳草萋萋鹦鹉洲', observation: '把长江方向留在楼身侧后方，檐口的垂直节奏因此通向远景。', sceneAnchor: 'river-horizon', anchor: [0, 4, -40], focus: 'horizon', camera: { position: [30, 12, 19], target: [0, 14, -15] }, mood: dawn },
      { id: 'river-at-dusk', title: '日暮乡关', line: '日暮乡关何处是？烟波江上使人愁', observation: '降低太阳与镜头，保留朱红木构的轮廓，让乡愁落在烟波方向。', sceneAnchor: 'river-water', anchor: [0, -0.02, -28], focus: 'water', camera: { position: [-25, 8, 24], target: [0, 13, -18] }, mood: autumnDusk },
    ],
  },
  tengwang: {
    id: 'tengwang', sourceLabel: '审计 FBX · 临江组团环境构件', packageUrl: '/assets/scene-pack/tengwang-environment.glb', packageReport: '/evidence/scene-packs/tengwang-environment.json', packageStatus: 'source-backed', availableLayers: ['mid', 'far'], sceneCenter: [0, 0, 0], defaultWater: { position: [0, -0.08, -24], size: [110, 42], rotation: [-Math.PI / 2, 0, 0] },
    cues: [
      { id: 'third-autumn', title: '序属三秋', line: '潦水尽而寒潭清，烟光凝而暮山紫', observation: '以高台边缘作为入场线，台阶、平台和檐廊依次进入视野。', sceneAnchor: 'high-terrace', anchor: [0, 2.2, 8], focus: 'platform', camera: { position: [25, 8.5, 27], target: [0, 12, 0] }, mood: autumnDusk },
      { id: 'south-bank-cloud', title: '南浦朝云', line: '画栋朝飞南浦云，珠帘暮卷西山雨', observation: '镜头横向掠过高台，观看楼阁的翼部如何把江景切成朝暮两面。', sceneAnchor: 'river-bank', anchor: [0, 3, -12], focus: 'platform', camera: { position: [-27, 14, 21], target: [0, 13, -8] }, mood: dawn },
      { id: 'river-endless', title: '长江自流', line: '槛外长江空自流', observation: '从栏杆一侧望向水面，人的位置被压低，流水成为时间的主角。', sceneAnchor: 'river-water', anchor: [0, -0.02, -25], focus: 'water', camera: { position: [17, 6.5, 22], target: [0, 10, -20] }, mood: autumnDusk },
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
