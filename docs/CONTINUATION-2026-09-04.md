# 七项优化会话记录（09-04）

工作区：`E:/Station/China_Tower`，分支 `master`（无 remote）。
G 盘本会话未挂载——备份改为本地双盘：`E:\Station\China_Tower_backups\` + `D:\China_Tower_backups\`，
每提交一个 git bundle 双写；全量 zip 在 B0 / P1 / FINAL 各打一次。G 盘恢复后补全量包。

## P0 九意象镜头重做（提交 `353b9a5`）

- 每楼三镜按 **晨/日/暮** 时间弧排布：岳阳（晨湖—凭轩—暮天）、黄鹤（晨云—晴川—乡关）、
  滕王（三秋—朝云—落霞）；T3 由 `长江自流` 改为 **`落霞孤鹜`**（落霞与孤鹜齐飞，
  秋水共长天一色），机位朝向日轮方位。
- 新增第四档 mood `deepDusk`（天顶泛紫、江面收灰），只给落霞一镜；
  `main.ts` grade 偏色分支同步纳入暮色档。
- 导语九组重写：标题出意象、诗句点题、导语讲看什么怎么看。
- 量测：九镜逐镜投影验收（楼体 NDC/入画角/日轮入画，零 pageerror），
  截图进 `evidence/review-0904-cues/`（9 PNG + report.json）供目检。

## P1 滕王落日 + 水面远景（提交 `24e00d1`）

- 落日：盘径 380→460、椭圆 1.18×0.8、强度 6.8→7.5；霞带铺展 8.0×1.15、强度 1.0；
  霞云 4→6 幅、展宽 ±1.5rad；江面光路加宽拉长；Sky mie 滕王 0.006→0.004 给盘面让位。
- 晴川雾限：黄鹤 `fogDensity` 0.0014→0.0011，三层脊 haze .30/.52/.74→.24/.45/.68
  （mood 改动，独立量测；天带对比度 38.03→38.32，+0.8% 弱阳性，云相位pola）。
- 水面法线贴图 repeat 36→48。
- 量测：distant-ranges run-010 PASS；frame run-008 PASS；tengwang flicker 0 dips。

## P2 平台 + 布局（提交 `aec38df`）

- 铺装烘焙：缝隙 AO 加深、磨边高光带、roughness 二级细颗粒（纯烘焙，不动几何不动深度）。
- 裙墙 1×64 纵向水渍渐变（上干下湿底微绿）。
- 补回缺失的 `#model-meta` 信息层（样式与 setter 早有、独缺 DOM）；
  footer 补 D 键提示；删 `#high-model-debug` 死查询；新增 1100px 横屏平板断点。
- 量测：tsc；无头 LAYOUT PASS。

## P3 性能自适应（提交 `ed6aaaa`）

- governor（`DeviceQualityProfile.ts`）：2.5s 帧时间窗口，>26ms 逐级降载
  （DPR×0.85 → 关 bloom → 关 godrays → DPR×0.7），<14ms 连 3 窗回升；
  编译期前两窗不判；`?noadapt=1` 旁路；档位进 `diagnostics.adaptiveLevel`。
- `postStack` 新增 `setBloomEnabled/setGodRaysEnabled`（整 pass 跳过）；
  DPR 切换强制重设绘制尺寸（逐帧 resize 早退看不到 pixelRatio 变化）。
- 滕王默认 LOD1（395k 面，原 lod0hp 17M 面）；426MB master 只在 `?quality=hero`。
- mobile 廉价水面 + 铺装烘焙 1536→768；换楼跟水色。
- 构建裁剪：dist 剔除飞云/蓬莱/review（~1.5GB 不进包，成品 14GLB/0.7GB）；
  verify 加禁带断言；smoke 档位期望对齐代码真值 4096/2048；RELEASE 同步。
- 量测：governor 0→4 联动 / `?noadapt` 锁 0 / mobile 水 / 滕王 lod1，零报错。

## P4 子路径部署（提交 `4c5b8ee`）

- `assetUrl()`（`loadVerifiedGlb.ts`）收敛全部运行时 `/assets` 拉取；
  `DEPLOY_BASE` 进 `vite.config.ts`；manifest `basePath` 跟随；verify 剥基座校验；
  `scripts/deploy-static.mjs` + `npm run deploy`（构建+裁剪+校验+缓存/nginx 输出）。
- 量测：`DEPLOY_BASE=/towers/` 端到端冒烟 PASS（/towers 下启动、GLB 200、lod1、零报错）。

## FINAL（本轮）

- frame-stability run-009 PASS；godrays run-006 PASS；distant-ranges run-013 PASS
  （run-011/012 死于截图偶发超时，软渲染环境毛刺，重跑即过）；
  flicker-dips 三楼 0/0/0（`culprit-report-*.json`）。
- `npm run deploy`（根基座）：31 文件 / 14 GLB / 0.70GB，契约校验通过。
- 探针教训（已三次踩中）：软渲染下按墙钟等待会采到飞行中途/首帧前，
  且 `project()` 会读到旧帧矩阵——必须按位置收敛 + 渲染帧号双守卫。
  正式探针默认走硬件 GL，无此问题；手写无头脚本一律加帧守卫。

## 仍 open（需指示）

滕王日轮与 Sky 太阳晕叠加后的最终目检（用户看 contact sheet 定）；
bundle 分包（948kB 警告仍在）；无 remote 单点（G 盘包待补）。
