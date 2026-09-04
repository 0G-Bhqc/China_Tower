import * as THREE from 'three';
import type { PavilionId } from '../createPavilionGalleryModel';

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
  yueyang: {
    id: 'yueyang', sourceLabel: '审计 FBX · 未发现可独立分离的环境网格', packageUrl: '', packageReport: '/evidence/scene-packs/yueyang-environment.json', packageStatus: 'no-independent-environment-mesh', availableLayers: [], sceneCenter: [0, 0, 0], defaultWater: { position: [0, -0.08, -25], size: [110, 42], rotation: [-Math.PI / 2, 0, 0] },
    cues: [
      { id: 'dongting-dawn', title: '洞庭初晴', line: '衔远山，吞长江，浩浩汤汤', observation: '贴着水面看出去——台基压住近景，湖雾托起远山，一句“浩浩汤汤”正在眼前铺开。', sceneAnchor: 'lake-horizon', anchor: [0, -0.02, -22], focus: 'water', camera: { position: [29, 5.5, 32], target: [-14, 10, -16] }, mood: dawn },
      { id: 'worry-and-joy', title: '凭轩忧乐', line: '先天下之忧而忧，后天下之乐而乐', observation: '站到檐下，栏杆台阶先入画，再抬眼——忧乐不在楼里，在楼外的天际线上。', sceneAnchor: 'stone-steps', anchor: [0, 0.5, 14], focus: 'steps', camera: { position: [13, 3.4, 17], target: [0, 8.5, -2] }, mood: clearDay },
      { id: 'heaven-and-earth', title: '乾坤日夜浮', line: '吴楚东南坼，乾坤日夜浮', observation: '退到高处回望：楼退成剪影，湖天各一半——日夜在此交替，乾坤为之浮动。', sceneAnchor: 'lake-horizon', anchor: [0, 3, -42], focus: 'horizon', camera: { position: [-30, 15, 25], target: [2, 6.5, -16] }, mood: autumnDusk },
    ],
  },
  huanghe: {
    id: 'huanghe', sourceLabel: '审计 FBX · 主楼外缘场地构件', packageUrl: '/assets/scene-pack/huanghe-environment.glb', packageReport: '/evidence/scene-packs/huanghe-environment.json', packageStatus: 'source-backed', availableLayers: ['near', 'mid'], sceneCenter: [0, 0, 0], defaultWater: { position: [0, -0.08, -27], size: [110, 45], rotation: [-Math.PI / 2, 0, 0] },
    cues: [
      { id: 'white-clouds', title: '白云千载', line: '白云千载空悠悠', observation: '仰起头沿檐口上行：五层飞檐刺破晨云，千年只在此一望。', sceneAnchor: 'tower-roofline', anchor: [0, 18, 0], focus: 'tower', camera: { position: [27, 16, 33], target: [0, 22, -4] }, mood: dawn },
      { id: 'clear-river', title: '晴川远望', line: '晴川历历汉阳树，芳草萋萋鹦鹉洲', observation: '日光正好，江雾散尽——把视线交给远岸，历历汉阳树，萋萋鹦鹉洲。', sceneAnchor: 'river-horizon', anchor: [0, 4, -40], focus: 'horizon', camera: { position: [31, 11, 20], target: [-2, 9, -18] }, mood: clearDay },
      { id: 'river-at-dusk', title: '日暮乡关', line: '日暮乡关何处是？烟波江上使人愁', observation: '太阳低下去，楼只剩轮廓——乡关在烟波那头，愁也落在水面上。', sceneAnchor: 'river-water', anchor: [0, -0.02, -28], focus: 'water', camera: { position: [-26, 7, 25], target: [4, 11, -16] }, mood: autumnDusk },
    ],
  },
  tengwang: {
    id: 'tengwang', sourceLabel: '审计 FBX · 临江组团来源存疑，运行时不采用', packageUrl: '', packageReport: '/evidence/scene-packs/tengwang-environment.json', packageStatus: 'no-independent-environment-mesh', availableLayers: ['mid', 'far'], sceneCenter: [0, 0, 0], defaultWater: { position: [0, -0.08, -24], size: [110, 42], rotation: [-Math.PI / 2, 0, 0] },
    cues: [
      { id: 'third-autumn', title: '序属三秋', line: '潦水尽而寒潭清，烟光凝而暮山紫', observation: '从高台边缘入画：秋水澄澈在下，暮山紫气在上，一序三秋尽收。', sceneAnchor: 'high-terrace', anchor: [0, 2.2, 8], focus: 'platform', camera: { position: [26, 8, 28], target: [0, 11.5, -2] }, mood: autumnDusk },
      { id: 'south-bank-cloud', title: '南浦朝云', line: '画栋朝飞南浦云，珠帘暮卷西山雨', observation: '横着掠过高台：画栋这边朝云初飞，珠帘那边暮雨将卷。', sceneAnchor: 'river-bank', anchor: [0, 3, -12], focus: 'platform', camera: { position: [-28, 13, 22], target: [2, 12, -8] }, mood: dawn },
      { id: 'sunset-glow', title: '落霞孤鹜', line: '落霞与孤鹜齐飞，秋水共长天一色', observation: '面向落日站定：霞光铺江，孤鹜一点——秋水与长天在此缝合。', sceneAnchor: 'sunset-glow', anchor: [-24, 0.5, -12], focus: 'horizon', camera: { position: [30, 9, 33], target: [-8, 12, -10] }, mood: deepDusk },
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
