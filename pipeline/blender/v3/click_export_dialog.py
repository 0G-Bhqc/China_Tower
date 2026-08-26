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
    
    # Find and click the export submenu item
    print("Looking for export submenu...")
    export_menu = None
    for w in app.windows():
        texts = str(w.texts())
        if '导出(E)' in texts and 'Qt653QWindowPopupDropShadowSaveBits' in w.class_name():
            export_menu = w
            print(f"Found export menu: {w.class_name()} {w.texts()}")
            break
    
    if export_menu:
        # Click on the export menu item
        export_menu.click_input()
        time.sleep(2)
        
        # Look for the export dialog
        print("Looking for export dialog...")
        for w in app.windows():
            if 'FBX' in str(w.texts()) or '导出' in str(w.texts()) or 'Export' in str(w.texts()):
                print(f"Found dialog: [{w.class_name()}] {w.texts()}")
    else:
        print("Export menu not found")
    
except Exception as e:
    print(f"ERROR: {e}")
    import traceback
    traceback.print_exc()
