from pywinauto import Application
import time

TARGET_HWND = 136030
EXPORT_PATH = r"E:\Station\China_Tower\evidence\3d-assets\jobs\tengwang\outputs\full-scene-22753718.fbx"

try:
    print(f"Connecting to window {TARGET_HWND}...")
    app = Application(backend="win32").connect(handle=TARGET_HWND)
    main_window = app.window(handle=TARGET_HWND)
    
    # Wait for export dialog
    print("Waiting for export dialog...")
    time.sleep(2)
    
    # Look for export dialog
    try:
        export_dlg = app.window(title_re=".*Export.*", class_name="#32770")
        print(f"Found export dialog: {export_dlg.texts()}")
    except:
        print("No export dialog found with #32770")
    
    # Look for any dialog
    try:
        any_dlg = app.window(class_name="#32770")
        print(f"Found dialog: {any_dlg.texts()}")
    except:
        print("No dialog found")
    
    # Check all windows
    all_windows = app.windows()
    print(f"Total windows: {len(all_windows)}")
    for w in all_windows:
        print(f"  [{w.class_name()}] {w.texts()}")
    
except Exception as e:
    print(f"ERROR: {e}")
    import traceback
    traceback.print_exc()
