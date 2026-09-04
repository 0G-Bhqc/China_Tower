# 中国楼阁 Three.js 发布说明

## 交付入口

运行 `npm run build:final-html`，部署整个 [`dist`](dist) 目录到站点根路径 `/`，入口为 `china-towers.html`（或 `index.html`）。发布清单 [`dist/china-towers.release.json`](dist/china-towers.release.json) 记录每个交付文件的 SHA-256 和字节数。

这是目录部署，不是离线单 HTML：本轮成品只启用岳阳楼、黄鹤楼与滕王阁，按选择的设备质量档从 `/assets` 按需获取对应高模。飞云楼与蓬莱阁的源 GLB、清单和研究文档仍保留在仓库中，但不进入成品导航。入口使用根绝对路径，若要部署到子目录，需先调整 Vite `base` 并重新构建。

建议的服务器策略：HTML 使用 `no-cache`；带哈希的 JS/CSS 可长期缓存；GLB 返回 `model/gltf-binary`。只有在部署目录带版本或能按发布清单清理旧缓存时，才为固定文件名的 GLB 使用 `immutable` 缓存策略。

## 质量与调试参数

- 默认：设备检测选择 Standard 或 Mobile。
- `?quality=hero`：LOD0、DPR 上限 1.75、4096 软阴影。
- `?quality=standard`：LOD1、DPR 上限 1.35、2048 软阴影。
- `?quality=mobile`：LOD2、DPR 上限 1、768 低成本阴影、无镜面水（廉价水面代替）。
- 运行时自适应：帧时间 2.5s 窗口均值超 26ms 逐级降载（DPR×0.85 → 关 bloom → 关 godrays → DPR×0.7），
  快窗口连续 3 个才回升；档位进 diagnostics `adaptiveLevel`；`?noadapt=1` 旁路保探针确定性。
- 滕王阁 426MB 高精 master 只在 `?quality=hero` 加载，默认 standard 走 LOD1（8.9MB）；`?lod=` 可强制任意档。
- `?pavilion=yueyang|huanghe|tengwang` 选择本轮成品楼阁；`feiyun` 与 `penglai` 旧参数会回退到岳阳楼；`?lod=lod0|lod1|lod2` 仅用于受控审查。
- `?view=front|three-quarter|right|rear|left|elevated|low-angle` 用于固定审查视角；界面“仰视建筑”或快捷键 V 可进入低机位。
- `?view=front|three-quarter|right|rear|left|elevated` 与 `?light=reference|neutral|grazing` 用于视觉证据捕获。

## 发布前已通过的命令

```powershell
npm run build:final-html
npm run validate:source-hashes
npm run validate:runtime-manifest
npm run validate:runtime-parts
npm run smoke:quality-tiers
npm run smoke:degraded-loading
npm run audit:runtime-performance
npm run smoke:runtime-loading
```

## 证据与边界

- 仓库仍保留历史高模资产的来源哈希、面数与运行时清单，参见 [`evidence/3d-assets`](evidence/3d-assets)；这些资料不等于本轮成品入口。
- 本轮成品固定为岳阳楼、黄鹤楼、滕王阁三座。蓬莱阁暂列待修复展品，已知围护结构缺失、场景合并过度和体量过大；飞云楼按范围要求剔除。
- 通用程序化楼阁仅用于三座高模加载失败时的明确降级视图，不作为独立展品。
- 页面内容以楼阁对应诗文为主叙事：每座楼包含主篇、关联篇、原文节选、释义、建筑关联赏析和来源字段。
- Vite 仍报告主入口压缩前约 950 kB，属于后续可优化项；当前通过按楼阁模块动态导入与 GLB LOD 降级控制首个所选资产的加载压力。
- 部署包已裁剪飞云/蓬莱归档与 review GLB（约 1.5GB 不进 dist），成品约 14 个 GLB（~0.7GB，以滕王高精 master 为主）。
- 若高模 GLB 失败，应用会明确显示降级视图并保留研究模型交互，不会将后备模型标为高模成功。
