import keyboard
import time
import win32gui
import win32con

TARGET_TITLE_PART = "3ds Max 2026"
TARGET_HWND = 136030

try:
    print(f"Using known hwnd: {TARGET_HWND}")
    hwnd = TARGET_HWND
    
    print(f"Window title: {win32gui.GetWindowText(hwnd)}")
    
    # Bring window to front
    win32gui.ShowWindow(hwnd, win32con.SW_RESTORE)
    time.sleep(0.5)
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
