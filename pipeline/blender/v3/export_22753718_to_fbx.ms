try
(
    loadMaxFile @"E:\Station\China_Tower\3D资产\滕王阁（1）\3d66.com_22753718.max" type:#merge quiet:#true
    exportFile @"E:\Station\China_Tower\evidence\3d-assets\jobs\tengwang\outputs\full-scene-22753718.fbx" using:FBXEXP quiet:#true
    print "EXPORT_OK"
)
catch
(
    print "EXPORT_FAILED"
    print (getErrTxt())
)
