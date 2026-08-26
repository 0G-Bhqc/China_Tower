import win32com.client
import os
import time

try:
    print("Connecting to 3ds Max...")
    app = win32com.client.Dispatch("3dsMax.Application")
    print("Connected to 3ds Max version:", app.Version)
    
    max_file = r"E:\Station\China_Tower\3D资产\滕王阁（1）\3d66.com_22753718.max"
    export_path = r"E:\Station\China_Tower\evidence\3d-assets\jobs\tengwang\outputs\full-scene-22753718.fbx"
    
    # Ensure output directory exists
    os.makedirs(os.path.dirname(export_path), exist_ok=True)
    
    print("Loading max file...")
    app.LoadMaxFile(max_file, quiet=True)
    print("File loaded successfully")
    
    # Wait a bit for the scene to fully load
    time.sleep(3)
    
    # Set up FBX export
    print("Setting up FBX export...")
    fbx_export = win32com.client.Dispatch("FBXExport")
    
    # Set FBX export options
    fbx_export.Copy = True
    fbx_export.UpAxis = "Z"
    fbx_export.FrontAxis = "Y"
    fbx_export.ScaleFactor = 1.0
    fbx_export.FileType = "binary"
    fbx_export.Triangulate = True
    
    print("Exporting to FBX...")
    fbx_export.ExportAll(export_path)
    
    # Verify the file was created
    if os.path.exists(export_path):
        size = os.path.getsize(export_path)
        print(f"EXPORT_SUCCESS: {export_path} ({size:,} bytes)")
    else:
        print("EXPORT_FAILED: File not created")
        
except Exception as e:
    print(f"EXPORT_FAILED: {str(e)}")
    import traceback
    traceback.print_exc()
