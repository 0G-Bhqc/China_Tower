# 中国楼阁 Three.js 部署说明

## 一键部署

```bash
pnpm deploy
```

构建（tsc + vite）→ 归档裁剪（剔除非成品 GLB）→ 契约校验，随后输出部署清单与缓存/反代配置片段。把 `dist/` 整体搬到站点根路径 `/`，入口为 `china-towers.html`（或 `index.html`）。发布清单 `dist/china-towers.release.json` 记录每个交付文件的 SHA-256 和字节数。

## 子路径部署

```bash
DEPLOY_BASE=/towers/ pnpm deploy
```

`DEPLOY_BASE` 必须以 `/` 开头和结尾。把 `dist/` 搬到站点 `/towers/` 下即可；JS/CSS 引用与运行时 `/assets` 拉取自动收敛到同一基座（`assetUrl()`），无需改代码重写路径。根部署是 `DEPLOY_BASE=/` 的特例。

这是目录部署，不是离线单 HTML：成品包含岳阳楼、黄鹤楼与滕王阁，按设备质量档从 `/assets` 按需获取对应高模。

## 服务器缓存策略

- HTML 使用 `no-cache`；带哈希的 JS/CSS 可长期缓存；GLB 返回 `model/gltf-binary`。
- 只有在部署目录带版本或能按发布清单清理旧缓存时，才为固定文件名的 GLB 使用 `immutable` 缓存策略。

## 质量与调试参数

- 默认：设备检测选择 Standard 或 Mobile。
- `?quality=hero`：LOD0、DPR 上限 1.75、4096 软阴影；滕王阁大师版高精 GLB 仅此档加载。
- `?quality=standard`：LOD1、DPR 上限 1.35、2048 软阴影。
- `?quality=mobile`：LOD2、DPR 上限 1、768 低成本阴影、无镜面水（廉价水面代替）。
- 运行时自适应：帧时间 2.5s 窗口均值超 26ms 逐级降载（DPR×0.85 → 关 bloom → 关 godrays → DPR×0.7），快窗口连续 3 个才回升；`?noadapt=1` 旁路。
- `?pavilion=yueyang|huanghe|tengwang` 选择楼阁；`?lod=lod0|lod1|lod2` 仅用于受控审查。
- `?view=front|three-quarter|right|rear|left|elevated|low-angle` 固定审查视角；界面"仰视建筑"或快捷键 V 可进入低机位。
- `?light=reference|neutral|grazing` 切换光照模式。

## 行为边界

- 成品固定为岳阳楼、黄鹤楼、滕王阁三座楼阁。
- 若高模 GLB 加载失败，应用会明确显示降级视图并保留程序化研究模型交互，不会将后备模型标为高模成功。
- 部署包已裁剪非成品 GLB；交付 GLB 以 `dist/china-towers.release.json` 清单为准。
