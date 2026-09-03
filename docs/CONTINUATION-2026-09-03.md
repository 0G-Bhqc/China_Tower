# 频闪根治会话记录（09-03）

生成时间：2026-09-03 晚 (Asia/Shanghai)
工作区：`E:/Station/China_Tower`
分支：`master`（无 remote，本地单点）
结果提交：`7cf1542 fix: 频闪双根因根除——岸礁穿模推离 + 地平线辉光 pow(NaN) 钳制`

---

## 一、任务与结论

用户指令只有三个字：**修复频闪**。上午会话留下的隔离开关（`?nowater` / `?nopost`）
与 dip 取证数据表明：关水面、关后期，dip 依旧——频闪源还没找到。

结论：频闪是**两个独立缺陷**，与水面反射、神光通道、HDRI、GPU 负载全都无关。
两个都已修掉并量测归零。

## 二、取证路径（为什么相信这个结论）

全部结论来自 `evidence/` 下的量测，不来自推理默认。关键仪器：

1. **CDP screencast 全帧率抓帧 + dip 检测**（`scripts/probe-flash-bisect.cjs`）：
   合成器每帧都收，亮度低于滚动中位 45% 记一次 dip，存 dip 邻域 PNG。
2. **dip 帧直接看图**：黑闪帧 = 全屏灰噪声 + DOM 覆盖层完好 → 相机进了某个网格。
3. **包围球包含采样**（`scripts/probe-flicker-dips.cjs`）：页面内每帧遍历场景，
   报告"哪些网格的包围球包含相机"。dip 帧上永远是 `scene-shore-rock-N`，dist≈2，r≈4.3。
4. **开关二分**：`nopost`（32→2 dip）、`nobloom`（→1）、`norays`（不变）、
   `nobg`（不变）→ 滕王阁深黑归 bloom。
5. **双采样器交叉验证**（`scripts/probe-flicker-ground-truth.cjs`）：页内
   drawImage 采样与 CDP 合成帧 144/144 同步 dip → 黑是真实渲染内容，不是截屏伪影。
6. **帧边界采样**：包 `renderer.render`，帧前帧后各测亮度——pre 0.6+ → post 0.000，
   渲染调用同步产出全黑，且无 pageerror。
7. **逐 pass 像素追踪**：包 EffectComposer 每个 pass，半浮点读回 5 个采样点——
   RenderPass 输出完好，`_UnrealBloomPass` 输出后 3/5 采样点变 NaN。
8. **毒源逐对象隔离**（`scripts/probe-bloom-nan-isolate.cjs`）：相机停到毒发位姿，
   逐个隐藏嫌疑对象——只有隐藏 `poetic-horizon-glow` 时高通 RT 的 NaN 行清零。

被排除的假设（都有数据）：GPU 负载截断（rAF p50=8.3ms）、HDRI 超范围亮度
（三张 HDR 逐像素解析，最大 5.04e4 < 65504）、JS 异常中断（pageerror 为空）、
水面镜面（nowater 不变）、神光遮罩（norays 不变）。

## 三、两个根因与修复

### 根因一：贴地环绕走廊穿过岸礁（三楼通用）

`scene-shore-rock-0..21` 环岛半径 34–37（`PLAZA_RADIUS+0.4..3`），而拖拽把
极角压到底后相机被地面钳制在 y≈0.25——默认环绕距离正好撞进岩石包围球
（r≈4.3）。镜头在岩石内部时，近把岩石纹理放大成满屏噪声，持续数帧。

修复（`src/main.ts`）：环境创建时一次性收集岸礁世界包围球；`constrainInspectionCamera`
里逐帧把相机推到 `radius + 0.6` 之外。**教训：软推（lerp 0.3）实测跑不过连续
拖拽**——渗透速度超过回推速度，相机在球内形成"平衡深度"（实测停在 dist 2.95）。
推离必须逐帧绝对归位；球面光滑，解算轨迹读起来是"相机绕过障碍"，不是弹跳。

### 根因二：地平线辉光 pow(NaN)，bloom 扩散成整帧黑（滕王阁）

`poetic-horizon-glow` 片元：`pow(1.0 - vUv.y, 1.6)` 未钳底数。贴地视角下
1600m 外的告示板（2470×608）被近平面裁剪，透视校正插值在裁剪扫描线上把
`vUv.y` 推出 [0,1] → `pow(负数, 1.6) = NaN` 写进场景缓冲一整行
（高通 RT 实测 y=260 整行 NaN，行位置随相机变）→ bloom 高通拾取 → 5 级 mip
模糊+合成把 NaN 涂满全帧 → ACES 映射 `Inf/Inf = NaN` → 合成帧 100% 黑。
单次拖拽会话 ~130 dip，修前滕王阁独有（它的贴地走廊正对辉光方位）。

修复（`src/runtime/sceneEnvironment.ts`）：`clamp(1.0 - vUv.y, 0.0, 1.0)`。
域内 [0,1] 输出逐位不变——judge 目检确认落霞辉光带无变化、无硬截断边。
顺手排查全项目其余 `pow(`：唯一同类隐患只有 distantRanges 的 `frontLit`，已有
`max(0.0, …)` 保护。

## 四、验证

| 检查 | 修前 | 修后 |
| --- | --- | --- |
| flicker-dips（岳阳/黄鹤/滕王） | 8 / 0 / 131 | **0 / 0 / 0** |
| 双采样器交叉（滕王） | 144/144 同步 | 0 / 0 |
| frame-stability | run-001 PASS | run-003 PASS（diffCv ≤ 0.131） |
| godrays-stability | run-001 PASS | run-003 PASS |
| distant-ranges | run-006 PASS | run-007 PASS |
| 目检（judge 4 图） | — | 4/4 pass |
| `npm run build` | — | PASS（chunk 警告为已知遗留项） |

## 五、刻意不做的

- **黄鹤楼远景雾限**（「晴川历历汉阳树」）：属 mood 改动，按文档要求独立立项量测。
- **bundle 分包**：947 kB 警告为已知外观项。
- **本地备份 zip**：文档指定的目的地 `G:\我的云端硬盘\China_Tower\` 当前未挂载
  （G: 盘不存在），不擅自换备份位置。盘恢复后需补 09-03 全量包
  （上次全量包为 2026-09-02，早于本次修复）。

## 六、追加轮次：去照片远景（同日晚）

用户反馈：场景现在自带一圈 3D 中远景（岸礁/树/岛/船/三道远山），HDRI 照片背景
（岳阳晨雾远岸、黄鹤楼外的上海大桥天际线、滕王的摄影暮空）反而突兀。

改动（`src/runtime/sceneEnvironment.ts`）：

- 可见远景默认改为**每楼调参的物理程序化天空**（`fallbackSky` 的
  turbidity/rayleigh + 太阳方位，原本只是 HDRI 加载失败的兜底），远山脊照旧。
- HDRI 保留其承重职责不变：**PMREM IBL 光照**——楼的暖金瓦色、水面色调不回归。
- `?photobg=1` 一键切回照片背景（A/B 与回滚用），`backgroundRotation/Blurriness/
  Intensity` 仅在该模式生效。
- Sky 盒从兜底版的 scale 1000 放大到 **4600**：小于水面半径时天墙在 ~500m 处
  切断水面，会出现一条雾only 30% 的硬地平缝；4600 让水天相交落在 ~2300m、
  雾 ~100% 处，无缝。相机 far=2600 仍罩得住。

验证：frame-stability run-004 / godrays-stability / distant-ranges 全 PASS；
judge 目检 4 图（三楼新天空 + photobg 对照）4/4 pass——无照片泄漏、无水天硬缝、
无冷色/黑天回归。

已知注记（judge 提出，未调）：滕王阁朱红日轮是加色混合，叠在程序化天空自己的
太阳亮晕上后可读性下降（对比照片时代的粉底）。若要恢复「正赤如丹」的强读，
候选手段是提高 disc 强度或压低 tengwang 的 Sky mie 贡献——属 mood 微调，待指示。

## 七、功能组件与诗文打磨（第一小轮）

无头点击实测全交互链后落地的五项：

1. **滕王阁《滕王阁诗》赏析重写**——原赏析混入了开发工程叙事（"圆形闪烁""底座
   必须先稳定"），改为真正的诗文赏析（画栋珠帘→闲云潭影→槛外长江的时间结构，
   与横向移动镜头的观看方式对应）。
2. **《岳阳楼记》节选补全**——原节选止于背景交代，补入「巴陵胜状」段与
   「先天下之忧而忧，后天下之乐而乐」名句，节选现在能独立成读（渲染 16 行）。
3. **键盘快捷键防误触**——`Ctrl/Cmd/Alt` 组合键不再误触发页面快捷键
   （此前 Ctrl+R 会顺带重置视角、Cmd+P 会顺带开诗文面板）。
4. **诊断截图按钮**——补齐按钮已声明却未实现的 `D` 快捷键；文件名从硬编码
   `tengwang-debug-*` 改为 `<当前楼>-diagnostic-*`；打断式英文 alert 改为
   status 行内提示（aria-live 播报）。
5. **favicon**——新增 `/favicon.svg`（楼字印章风），消除每次加载的
   `favicon.ico` 404。

## 八、功能组件与诗文打磨（第二轮）

1. **状态行中文为主**——`ORBIT · DRAG TO INSPECT`、`HIGH MODEL READY` 等十余处
   英文大写状态统一为中文（`高模就绪 · 拖拽检视` / `仰视模式 · …` /
   `诗境机位 · …` 等），idle 文案收敛为 `STATUS_IDLE` 常量。
2. **诗句卡可收起**——右上加 × 关闭钮；悬停卡片时暂停 10 秒自动隐藏，
   移开后 4 秒宽限再收。
3. **诗文面板竖排阅读**——面板头部新增「竖」切换钮（localStorage 记忆偏好），
   仅翻转诗文引文块为右起竖列。实现坑：vertical-rl 的列向**左**溢出而 LTR
   容器不计入可滚动区，直接立文本块会把开头几列静默裁掉——解法是滚动容器
   保持横排、内层 `.quote-body` 立文字并 `width: max-content`，溢出变成真实
   右向滚动量，切换/换页时 `scrollLeft` 归位到文本开头。

## 九、留给下一会话的（09-03 夜已收口部分）

- 上会话遗留的 8 个 `scripts/tmp-*.cjs` 已删除；其结论固化在本文件与
  CURRENT-STATUS，能力由 4 个正式探针（`probe-flicker-dips` /
  `probe-flash-bisect` / `probe-flicker-ground-truth` / `probe-bloom-nan-isolate`）继承。
- `?nobloom` / `?nobg` 隔离开关与上会话的 `?nowater` / `?nopost` 一样属审查
  基础设施，保留在代码里（都有注释说明）。

## 十、夜收口轮次（备份优先，依次执行）

用户指令：「向 Google Drive 备份后依次执行」。按 P0→P5 落子，全部有证据：

1. **P0 — G 盘全量包**：`G:\我的云端硬盘\China_Tower\China_Tower-backup-20260903.zip`
   （1.85 GB，Optimal；与 09-02 包逐文件比对：零丢失，+7 新文件——4 个正式探针、
   `public/favicon.svg`、本文件、references 调研包；`src/main.ts` 为含 reset 修复的工作区版本，
   已解包抽查 `resetInspection` 在包内）。
2. **P1 — R 键统一 reset**（提交 `8bb2a6f`）：`resetInspection()` 只接了 `#reset-view`
   按钮，`keydown r` 仍是旧内联四行——相机回位而诗境 mood/缓转/诗句卡残留。
   改为 R 键直接调 `resetInspection()`。无头回归 PASS（诗境机位→R/按钮均清卡、
   状态回 `高模就绪 · 拖拽检视`、零 pageerror）；`tsc --noEmit` 通过。
3. **P2 — polish 补正式证据**（此前两轮 polish 只有 commit 口述）：
   frame-stability `run-007` PASS（worst diffCv 0.138，tengwang orbit sky）、
   godrays `run-005` PASS（worst push→pause ≤2 vs half-gate 338-499）、
   distant-ranges `run-009` PASS（sky strong 4.18/5.79/3.66%）、
   flicker-dips 三楼 0/0/0（yueyang 1507+1492 帧 / huanghe 1371 / tengwang 1490，
   落盘 `culprit-report-{yueyang,huanghe,tengwang}.json`）。
4. **P3 — 重打 dist**：`npm run build:final-html` 全链 PASS
   （52 hashed files / 35 GLBs / entry verified）；chunk 警告仍在
   （948.91 kB / gzip 262.16 kB），已知外观项未动。
5. **P5 — 文档收口**：CURRENT-STATUS 基线表换到 run-009/005/007、备份段更新、
   新增「night close-out」节；本文件追加本节。提交后工作区干净。

仍 open（未动，需指示）：黄鹤楼远岸雾限（mood 改动，独立立项）、
滕王阁朱红日轮叠 Sky 太阳晕可读性（提高 disc 或压 mie）、bundle 分包、无 remote 单点。
