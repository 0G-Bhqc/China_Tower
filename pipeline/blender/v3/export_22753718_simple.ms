try
(
    maxFilePath = @"E:\Station\China_Tower\3D资产\滕王阁（1）\3d66.com_22753718.max"
    exportPath = @"E:\Station\China_Tower\evidence\3d-assets\jobs\tengwang\outputs\full-scene-22753718.fbx"
    
    -- Load the max file
    loadMaxFile maxFilePath quiet:true
    
    -- Set FBX export options
    fbxOptions = FBXExportOptions()
    fbxOptions.fileType = #binary
    fbxOptions.axisConversionMethod = #none
    fbxOptions.upAxis = #Z
    fbxOptions.frontAxis = #Y
    fbxOptions.scaleFactor = 1.0
    
    -- Export FBX
    exportFile exportPath fbxOptions
    
    print "EXPORT_SUCCESS"
    print ("Exported to: " + exportPath)
)
catch
(
    print "EXPORT_FAILED"
    print (getErrTxt())
)
