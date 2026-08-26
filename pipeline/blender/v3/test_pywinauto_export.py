from pywinauto import Application
import time

TARGET_HWND = 136030
EXPORT_PATH = r"E:\Station\China_Tower\evidence\3d-assets\jobs\tengwang\outputs\full-scene-22753718.fbx"

try:
    print(f"Connecting to window {TARGET_HWND}...")
    app = Application(backend="win32").connect(handle=TARGET_HWND)
    main_window = app.window(handle=TARGET_HWND)
    
    print(f"Window title: {main_window.texts()}")
    print(f"Window class: {main_window.class_name()}")
    
    # Maximize/restore window
    main_window.restore()
    time.sleep(0.5)
    main_window.set_focus()
    time.sleep(1)
    
    # Send Alt+F (File menu)
    print("Sending Alt+F...")
    main_window.type_keys('%F', with_spaces=True)
    time.sleep(0.5)
    
    # Send E for Export
    print("Sending E...")
    main_window.type_keys('E', with_spaces=True)
    time.sleep(2)
    
    print("Menu sequence sent")
    
except Exception as e:
    print(f"ERROR: {e}")
    import traceback
    traceback.print_exc()
