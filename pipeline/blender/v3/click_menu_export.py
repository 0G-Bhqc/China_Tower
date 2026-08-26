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
    
    # Find the File menu and click it
    file_menu = None
    for w in app.windows():
        if '文件(F)' in str(w.texts()):
            file_menu = w
            break
    
    if file_menu:
        print(f"Found File menu: {file_menu.texts()}")
        file_menu.click_input()
        time.sleep(0.5)
        
        # Now find the Export submenu
        export_menu = None
        for w in app.windows():
            if '导出(E)' in str(w.texts()):
                export_menu = w
                break
        
        if export_menu:
            print(f"Found Export menu: {export_menu.texts()}")
            export_menu.click_input()
            time.sleep(2)
        else:
            print("Export menu not found")
    else:
        print("File menu not found")
    
except Exception as e:
    print(f"ERROR: {e}")
    import traceback
    traceback.print_exc()
