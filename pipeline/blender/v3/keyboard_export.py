import keyboard
import time
import win32gui

TARGET_TITLE = "3d66.com_22753718.max - Autodesk 3ds Max 2026"

try:
    print(f"Looking for window: {TARGET_TITLE}")
    hwnd = win32gui.FindWindow(None, TARGET_TITLE)
    
    if hwnd == 0:
        print("Window not found by title, trying partial match...")
        def find_window_partial(title_part):
            result = []
            def callback(h, _):
                if title_part in win32gui.GetWindowText(h):
                    result.append(h)
                return True
            win32gui.EnumWindows(callback, None)
            return result
        
        windows = find_window_partial("3ds Max 2026")
        if windows:
            hwnd = windows[0]
            print(f"Found window: {win32gui.GetWindowText(hwnd)}")
        else:
            raise Exception("3ds Max window not found")
    
    # Bring window to front
    win32gui.ShowWindow(hwnd, win32gui.SW_RESTORE)
    win32gui.SetForegroundWindow(hwnd)
    time.sleep(0.5)
    
    print("Sending Alt+F...")
    keyboard.send('alt+f')
    time.sleep(0.5)
    
    print("Sending E for Export...")
    keyboard.send('e')
    time.sleep(2)
    
    print("Menu sequence sent")
    
except Exception as e:
    print(f"ERROR: {e}")
    import traceback
    traceback.print_exc()
