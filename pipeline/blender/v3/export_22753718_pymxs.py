import pymxs
import os

try:
    max_file = r"E:\Station\China_Tower\3D资产\滕王阁（1）\3d66.com_22753718.max"
    export_path = r"E:\Station\China_Tower\evidence\3d-assets\jobs\tengwang\outputs\full-scene-22753718.fbx"
    
    pymxs.runtime.loadMaxFile(max_file, quiet=True)
    
    pymxs.runtime.exportFile(
        export_path,
        pymxs.runtime.FBXEXP,
        quiet=True
    )
    
    print("EXPORT_SUCCESS")
    print("Exported to: " + export_path)
except Exception as e:
    print("EXPORT_FAILED")
    print(str(e))
