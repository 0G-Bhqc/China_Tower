from pywinauto import Application
import time

TARGET_HWND = 136030
EXPORT_SCRIPT = r'''
loadMaxFile @"E:\Station\China_Tower\3D资产\滕王阁（1）\3d66.com_22753718.max" quiet:true
print "LOADED_OK"
exportFile @"E:\Station\China_Tower\evidence\3d-assets\jobs\tengwang\outputs\full-scene-22753718.fbx" #noPrompt
print "EXPORT_DONE"
'''

try:
    print(f"Connecting to 3ds Max...")
    app = Application(backend="win32").connect(handle=TARGET_HWND)
    
    # Find MAXScript listener window
    print("Looking for MAXScript listener...")
    maxscript_windows = [w for w in app.windows() if 'MAXScript' in str(w.class_name()) or 'MAXScript' in str(w.texts())]
    print(f"Found {len(maxscript_windows)} MAXScript windows:")
    for w in maxscript_windows:
        print(f"  [{w.class_name()}] {w.texts()}")
    
    if maxscript_windows:
        ms_window = maxscript_windows[0]
        print(f"Using MAXScript window: {ms_window.texts()}")
        
        # Try to focus and type into it
        ms_window.set_focus()
        time.sleep(0.5)
        
        # Clear any existing content and type the script
        # The MAXScript listener typically has an edit control
        try:
            edit_control = ms_window.Edit
            print("Found edit control")
            edit_control.set_text(EXPORT_SCRIPT)
            time.sleep(0.5)
            
            # Press Enter to execute
            ms_window.type_keys('{ENTER}')
            time.sleep(10)
            print("Script sent to MAXScript listener")
        except Exception as e:
            print(f"Edit control failed: {e}")
            # Try sending keys directly to the window
            ms_window.type_keys(EXPORT_SCRIPT, with_spaces=True)
            time.sleep(0.5)
            ms_window.type_keys('{ENTER}')
            time.sleep(10)
            print("Script sent via type_keys")
    
except Exception as e:
    print(f"ERROR: {e}")
    import traceback
    traceback.print_exc()
