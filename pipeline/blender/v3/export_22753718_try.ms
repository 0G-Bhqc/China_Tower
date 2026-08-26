try
(
    loadMaxFile @"E:\Station\China_Tower\3D资产\滕王阁（1）\3d66.com_22753718.max"
    exportFile @"E:\Station\China_Tower\evidence\3d-assets\jobs\tengwang\outputs\full-scene-22753718.fbx" #noPrompt
    print "EXPORT_DONE"
)
catch
(
    print "EXPORT_FAILED: " + (getCurrentException())
)
