# 岳阳楼参考图审计

## 结论

原调研资料包 `05_images_manifest/images_manifest.md` 中标为岳阳楼的 12 个远程 URL 均发生内容错配，实际内容包含公园入口、现代建筑、书籍封面、论文封面、交易图和广告。它们不得作为建模或视觉评审证据。

错误图片保留在本目录，仅用于复现审计；`verified/` 中是重新从政府及新华社页面归档的候选参考图。

## 已核实来源

| 文件 | 用途 | 来源 | 门禁结果 |
| --- | --- | --- | --- |
| `verified/xinhua-2025.jpg` | 主参考，三分之四外观 | 新华社 2025-06-01 | admitted |
| `verified/hunan-province.jpg` | 鸟瞰、总平面与城墙关系 | 湖南省人民政府 | admitted |
| `verified/official-aerial.jpg` | 接近正面的主楼与辅亭关系 | 岳阳市纪委页面 | admitted；低分辨率 |
| `verified/official-yueyang-02.jpg` | 远景和景区尺度 | 岳阳市政府 | admitted；低分辨率 |
| `verified/official-main.jpg` | 檐口、筒瓦、脊饰局部 | 岳阳市纪委页面 | 仅作局部证据；完整轮廓门禁拒绝 |
| `verified/official-yueyang-01.jpg` | 正立面辅助 | 岳阳市政府 | 解码门禁拒绝；不作评审基准 |

图片仅用于研究、建模比对和内部证据，不会被嵌入最终网页。正式发布前仍需逐项确认转载许可，或替换为明确开放许可的自有/公共领域素材。

## 建筑事实依据

- 岳阳市政府：<https://www.yueyang.gov.cn/mobile/23215/23793/content_311948.html>
- 湖南省人民政府：<https://www.hunan.gov.cn/hnszf/c101480/202108/t20210830_20411802.html>
- 岳阳市文旅广电局：<https://wlgd.yueyang.gov.cn/58628/58645/58666/content_1632756.html>
- 新华社图片页：<https://jp.news.cn/20250601/64ad39df5e114d4aa10439e38443f584/c.html>

