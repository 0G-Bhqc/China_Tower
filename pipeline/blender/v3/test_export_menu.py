import win32gui
import win32con
import win32api
import time
import os

TARGET_HWND = 136030
EXPORT_PATH = r"E:\Station\China_Tower\evidence\3d-assets\jobs\tengwang\outputs\full-scene-22753718.fbx"

def bring_to_front(hwnd):
    win32gui.ShowWindow(hwnd, win32con.SW_RESTORE)
    win32gui.SetForegroundWindow(hwnd)
    time.sleep(0.5)

def find_export_dialog():
    dialogs = []
    def callback(hwnd, extra):
        title = win32gui.GetWindowText(hwnd)
        cls = win32gui.GetClassName(hwnd)
        if 'export' in title.lower() or 'fbx' in title.lower():
            dialogs.append((hwnd, cls, title))
        return True
    win32gui.EnumWindows(callback, None)
    return dialogs

def send_keystroke(hwnd, vk, delay=0.05):
    win32api.SendMessage(hwnd, win32con.WM_KEYDOWN, vk, 0)
    time.sleep(delay)
    win32api.SendMessage(hwnd, win32con.WM_KEYUP, vk, 0)
    time.sleep(0.1)

def main():
    print(f"Target: {win32gui.GetWindowText(TARGET_HWND)}")
    bring_to_front(TARGET_HWND)
    time.sleep(1)
    
    # Check initial dialogs
    initial = find_export_dialog()
    print(f"Initial export dialogs: {initial}")
    
    # Send Alt+F (File menu)
    print("Sending Alt+F...")
    send_keystroke(TARGET_HWND, win32con.VK_MENU)  # Alt
    time.sleep(0.2)
    send_keystroke(TARGET_HWND, ord('F'))  # F
    time.sleep(0.5)
    
    # Send E (Export)
    print("Sending E...")
    send_keystroke(TARGET_HWND, ord('E'))
    time.sleep(2)
    
    # Check for export dialog
    dialogs = find_export_dialog()
    print(f"Export dialogs after menu: {dialogs}")
    
    if dialogs:
        print("SUCCESS: Export dialog opened!")
    else:
        print("No export dialog found")

if __name__ == '__main__':
    main()
