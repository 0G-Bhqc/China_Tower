from pywinauto import Application
import time

TARGET_HWND = 136030
EXPORT_PATH = r"E:\Station\China_Tower\evidence\3d-assets\jobs\tengwang\outputs\full-scene-22753718.fbx"

try:
    print(f"Connecting to window {TARGET_HWND}...")
    app = Application(backend="win32").connect(handle=TARGET_HWND)
    main_window = app.window(handle=TARGET_HWND)
    
    # Ensure window is focused
    main_window.restore()
    time.sleep(0.5)
    main_window.set_focus()
    time.sleep(0.5)
    
    # Try using menu_select method
    print("Using menu_select('File->Export...')...")
    try:
        main_window.menu_select("File->Export...")
        time.sleep(2)
        print("Menu select sent")
    except Exception as e:
        print(f"Menu select failed: {e}")
        # Try alternative menu path
        print("Trying alternative: '文件->导出'...")
        try:
            main_window.menu_select("文件->导出")
            time.sleep(2)
            print("Alternative menu select sent")
        except Exception as e2:
            print(f"Alternative menu select failed: {e2}")
    
except Exception as e:
    print(f"ERROR: {e}")
    import traceback
    traceback.print_exc()
