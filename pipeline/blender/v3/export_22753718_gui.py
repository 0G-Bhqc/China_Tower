import win32com.client
import os
import time

try:
    print("Connecting to running 3ds Max...")
    app = win32com.client.GetActiveObject("3dsMax.Application")
    print("Connected to 3ds Max version:", app.Version)
    
    max_file = r"E:\Station\China_Tower\3D资产\滕王阁（1）\3d66.com_22753718.max"
    export_path = r"E:\Station\China_Tower\evidence\3d-assets\jobs\tengwang\outputs\full-scene-22753718.fbx"
    
    print(f"Loading: {max_file}")
    app.ExecuteMaxCommand(f'loadMaxFile "{max_file}" quiet:true')
    time.sleep(5)
    print("File loaded")
    
    print(f"Exporting to: {export_path}")
    export_script = f'''
    exportFile "{export_path}" #noPrompt
    print "EXPORT_DONE"
    '''
    app.ExecuteMaxCommand(export_script)
    time.sleep(10)
    
    if os.path.exists(export_path):
        print(f"SUCCESS: FBX exported to {export_path}")
        print(f"Size: {os.path.getsize(export_path)} bytes")
    else:
        print("FAILED: FBX file not created")
        
except Exception as e:
    print(f"ERROR: {e}")
    import traceback
    traceback.print_exc()
