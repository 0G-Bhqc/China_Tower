# 项目现状诊断与续作计划

生成时间：2026-09-02 13:55 (Asia/Shanghai)
工作区：`E:/Station/China_Tower`
分支：`master`（**无 remote**，本地单点）

---

## 一、当前在进行什么

主线已从「资产管线 / 语义分割」切换到**运行时视觉打磨 + 闪烁根治**。三座成品楼阁（岳阳 / 黄鹤 / 滕王）的高模资产早已冻结可用，当前工作全部集中在 `src/` 的表现层。

未提交改动（5 个文件，+127 / −66）：

| 文件 | 改了什么 | 意图 |
| --- | --- | --- |
| `src/runtime/distantRanges.ts` | **新增**，17.5 KB | 三道远景山脊（约 0.6–1.7 km），给地平线加层次，支撑「衔远山，吞长江」的意境 |
| `src/main.ts` | 相机高度、near 平面、诊断字段 | 黄鹤楼 `camHeight` 0.6→0.46；near 加 20% 迟滞 + `updateProjectionMatrix()`；暴露 `cameraPosition/Target/Fov`；新增 `?noranges=1` |
| `src/runtime/godRays.ts` | 移除运动门控 | 删掉 `setActive()`，光轴常驻每帧渲染 |
| `src/runtime/postProcessing.ts` | bloom 阈值软化 | `highPassUniforms.smoothWidth` 0.01→0.5；移除 `setGodRaysActive` |
| `src/runtime/sceneEnvironment.ts` | 接入远景、去反射节流 | 移除水面镜面反射的「移动即跳过」节流，改为降分辨率（768→640）；太阳光带 `renderOrder` 1/2 固定 + 抬高 0.06→0.22 |

### 这批改动的技术判断（已在代码注释中固化，勿回退）

1. **GodRays 不能随相机运动开关。** 拖动不是连续运动，是「推一下、停一下」，门控会在用户手指底下反复翻转 → 天空明暗泵动，这正是被投诉的闪烁。缓动只把频闪变慢，没切断耦合。
2. **水面镜面反射不能节流。** 平面反射是「所有运动内容的镜子」——落花、船、树冠、孤鹜。丢帧就失同步，省下的时间全付给了水面抖动。成本只能从**分辨率**出，分辨率是时间稳定的。
3. **bloom 硬阈值是错的信号。** three.js 硬编码 `smoothWidth=0.01`，让 `smoothstep` 退化成阶跃；水面高光每帧被法线贴图和相机运动重打光，成千像素在阈值两侧 0↔1 翻转 → 泛光光晕眨眼。
4. **near 平面必须迟滞。** `near` 决定对数深度缓冲的精度分布，持续微调会让共面（台基石板）每帧重排深度 → 频闪。

---

## 二、检测到的问题

### P0 — 阻塞：改动全部处于「未验证」状态

证据链断在最关键的一环：**量测 → 发现问题 → 改了参数 → 没有复测**。

时间线（今天）：

| 时间 | 事件 |
| --- | --- |
| 08-31 22:11 | `godRays.ts` 去运动权重 |
| 09-01 20:54 | `postProcessing.ts` bloom 软化 |
| 09-01 21:10 | godrays 证据：仅 tengwang 2 张 PNG，**无度量数据** |
| 09-01 21:36 | `sceneEnvironment.ts` 接入远景 |
| 09-02 10:54–10:56 | distant-ranges 证据：3 楼 × 3 帧 = 9 张 PNG，**无 JSON** |
| 09-02 11:31 | `distantRanges.ts` 又改了 ← **证据之后** |
| 09-02 11:32 | `main.ts` 相机高度 0.6→0.46 ← **证据之后** |
| 09-02 11:34 | `verify-distant-ranges.cjs` 又改了 |

`main.ts` 里那段注释直接留下了证据：

> huanghe's camera sat at 0.6 of the framing distance — 44 m above the water, pitched 18.7° down, which put the horizon 6% from the top of the frame. With 42° of fov that leaves roughly 48 px of sky, and a distant range needs somewhere to stand: **huanghe's ridges measured the weakest footprint of the three** purely because there was no sky left to show them in.

即：上午的量测发现黄鹤楼远景最弱 → 据此下调相机高度 → **下调之后一次都没重新量过**。当前磁盘上 9 张 PNG 反映的是旧取景，不能作为任何结论的依据。

### P1 — 验证脚本本身有缺陷

| 问题 | 位置 | 影响 |
| --- | --- | --- |
| 度量结果不落盘 | `verify-distant-ranges.cjs` 只有 3 处 `writeFileSync`（全是 PNG），`metrics` 仅 console 输出 | 数值丢失，无法追溯、无法做前后回归对比 |
| Playwright 路径硬编码到外部缓存 | 两脚本均 `require('C:/Users/admin/.cache/codex-runtimes/.../playwright')` | 项目本地 `node_modules/playwright` 已存在却不用；清缓存或换机器立刻挂 |
| 端口硬编码 | `BASE = 'http://127.0.0.1:5173/'` | 无端口回退 |
| godrays 脚本只测 tengwang | 脚本设计如此，非中断 | 覆盖不全，岳阳/黄鹤无数据 |

### P2 — 交付产物残缺

- `dist/` 只剩 8/26 的 `index.html`，`dist/assets/` **空目录**（mtime 08-31 14:01）。说明最近一次 `vite build` 失败或被中断，或产物被清理。
- `npm run build:final-html`（tsc + vite build + 打包 + 校验）从未在当前代码上跑通过。

### P3 — 环境与工程卫生

| 问题 | 说明 |
| --- | --- |
| Dev server 未运行 | 5173 无监听，所有浏览器验证当前跑不了 |
| `pnpm` 不在 PATH | README / RELEASE / package.json scripts 全按 pnpm 写，实际只能用 `npm` |
| 无 git remote | 5 个文件改动 + 大量未跟踪资源（GLB 约 2.5 GB，已 gitignore）无异地备份 |
| `public/assets` 臃肿 | 含飞云/蓬莱归档资产 + 5 个 `*semantic-hierarchy.review.glb`（每个 170–320 MB），仅证据用途却占着运行时目录 |
| 文档滞后 | `docs/CURRENT-STATUS.md` 更新于 2026-08-23，仍以飞云楼 G3/B4/B5 语义管线为主线，与当前「视觉打磨」主线已严重脱节 |

---

## 三、下一步计划

### 阶段 0：恢复验证能力（阻塞项，必须先做）

1. 起 dev server：`npx vite --host 127.0.0.1`（无 pnpm，用 npx / `node node_modules/vite/bin/vite.js`）。
2. 修脚本硬编码：改用 `require('playwright')`（本地 `node_modules` 已有），端口做成环境变量可覆盖。
3. 给 `verify-distant-ranges.cjs` 增加 `results.json` 落盘（含 `id / quality / callDelta / ridgePixels / rowTop% / rowBottom% / band%`），让度量可追溯、可回归。
4. 复跑远景量测，重点看**黄鹤楼**在 `camHeight=0.46` 后的山脊占屏比是否较上午改善。

### 阶段 1：确认远景真的入画

- 用 `--analyze` 和 `--camera` 两个模式交叉核对（几何投影 vs 像素差）。
- 三座楼各自的山脊带应落在画面上部 1/3 且**高于地平线**，否则等于白画。
- 存证：截图 + JSON 一并进 `evidence/distant-ranges/`。

### 阶段 2：确认闪烁真的消失

这是本轮改动的原始诉求，目前**零证据**：

- 跑 `verify-godrays-stability.cjs`（补齐 yueyang / huanghe）。
- 补一个**水面帧间稳定性**探针：连续 N 帧采样水面区域亮度方差，对比 `smoothWidth=0.5` 前后的改善量。bloom 软化目前只有推理，没有数字。
- 补一个**台基共面闪烁**探针：轨道环绕时采样台基区域，验证 near 迟滞是否真的消除频闪。

### 阶段 3：打通交付

- 跑通 `npm run build:final-html`（tsc 当前**已通过**，风险在 vite build 与打包脚本）。
- 校验 `dist/china-towers.release.json` 的 SHA-256 清单。
- 确认 dist 可独立部署。

### 阶段 4：收口

- 提交当前 5 个文件改动（拆成两个 commit：远景 / 反闪烁）。
- 更新 `docs/CURRENT-STATUS.md`——它现在描述的是 8 月的语义管线，已经误导续作。
- 建议加 git remote（至少本地裸仓库镜像），当前是单点。
- 清理 `public/assets` 下的 review-only GLB（移入 `evidence/`），约 1 GB。

---

## 四、质量边界（沿用既有约定，勿破）

- 无自动语义标签可凭计数/哈希/脚本输出自行获批；批准权在人工评审记录。
- 任何半成品评审目录不得提升为运行时资产。
- 未通过量测的改动不得进入生产清单。
- 本轮成品固定三座楼；飞云、蓬莱不进导航。

---

## 五、一句话结论

代码改完了，也改得有道理，但**从上午 10:56 之后就再没有一次有效验证**——证据比代码老，交付目录是空的，最关键的反闪烁改动至今没有任何数字支撑。下一步不是继续加效果，是先把 dev server 拉起来、把脚本修好、把三座楼的量测重跑一遍。
