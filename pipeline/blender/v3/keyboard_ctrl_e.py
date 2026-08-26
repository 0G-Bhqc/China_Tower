import keyboard
import time
import win32gui
import win32con

TARGET_HWND = 136030

try:
    print(f"Using known hwnd: {TARGET_HWND}")
    
    # Bring window to front
    win32gui.ShowWindow(TARGET_HWND, win32con.SW_RESTORE)
    time.sleep(0.5)
    win32gui.SetForegroundWindow(TARGET_HWND)
    time.sleep(0.5)
    
    # First press F11 or Ctrl+E to open export dialog
    # Let's try Ctrl+E which is often the export shortcut
    print("Trying Ctrl+E...")
    keyboard.send('ctrl+e')
    time.sleep(2)
    
    # Check if export dialog opened
    from pywinauto import Application
    app = Application(backend="win32").connect(handle=TARGET_HWND)
    all_windows = app.windows()
    export_dialogs = [w for w in all_windows if 'FBX' in str(w.texts()) or 'Export Options' in str(w.texts())]
    print(f"Export dialogs after Ctrl+E: {len(export_dialogs)}")
    for w in export_dialogs:
        print(f"  [{w.class_name()}] {w.texts()}")
    
except Exception as e:
    print(f"ERROR: {e}")
    import traceback
    traceback.print_exc()
