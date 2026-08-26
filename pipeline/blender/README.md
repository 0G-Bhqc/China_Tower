# Blender 后台分析入口

此目录只接受经隔离转换、已获批准的 `full-scene.fbx`。它不是 `.max` 打开器，也不会把导入网格或其拓扑带进 Three.js 成品。

## 运行门禁

`scripts/run-blender-analysis.mjs` 在启动 Blender 前必须确认：

- `conversion-job.json` 的状态为 `converted`；
- 四项安全断言均为 `true`：源文件只读、网络隔离、脚本执行禁用、脚本化自定义属性已清理；
- `outputs/full-scene.fbx` 已存在。

未通过时，脚本以失败结果退出，且不会启动 Blender。当前五个任务均仍处于 `awaiting-isolated-conversion`，这是预期的安全阻断。

## 执行方式

在隔离转换输出被复核并回传后：

```powershell
node scripts/run-blender-analysis.mjs --asset yueyang
```

启动器会从 Windows 安装记录中选择最高版本 Blender；也可用 `BLENDER_EXECUTABLE` 或 `--blender` 指定版本。

分析器采用 `--background --factory-startup`，导入 FBX 后输出到对应任务的 `blender-analysis/`：

- `blender-inventory.json`：对象、网格、材质、实例、面数和世界包围盒；
- `hierarchy.json`：对象级层级、变换、材质槽、网格统计和包围盒；
- `cluster-hypotheses.json`：按材质槽生成的低置信度候选分组，不能直接当作建筑语义；
- `measurement-candidates.json`：整体宽、深、高及对象数量；
- `render-plan.json`：前、右、后、左、顶、三分之四视角及六种证据通道的输出计划；
- `analysis-run.json`：运行溯源、阻断项和下一门禁。

本阶段只生成清单与渲染计划，绝不把“计划中的图像”伪装成证据。下一阶段必须实际产出 beauty、alpha-silhouette、semantic-id、depth、normal、material-id 六类视图，人工复核候选分组后，才可生成符合 `schemas/blender-analysis.schema.json` 的完整分析记录并进入程序化 Three.js 规格编写。
