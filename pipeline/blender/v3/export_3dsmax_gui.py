import win32gui
import win32con
import win32api
import time
import subprocess
import os

TARGET_HWND = 136030
EXPORT_PATH = r"E:\Station\China_Tower\evidence\3d-assets\jobs\tengwang\outputs\full-scene-22753718.fbx"

def bring_to_front(hwnd):
    win32gui.ShowWindow(hwnd, win32con.SW_RESTORE)
    win32gui.SetForegroundWindow(hwnd)
    time.sleep(0.5)

def click_menu_via_alt_keys():
    # Alt+F (File menu), then E (Export)
    win32api.SendMessage(TARGET_HWND, win32con.WM_SYSCOMMAND, win32con.SC_KEYMENU, 0)
    time.sleep(0.3)
    
    # Press Alt
    win32api.SendMessage(TARGET_HWND, win32con.WM_SYSCOMMAND, win32con.SC_KEYMENU, 0)
    time.sleep(0.2)
    
    # Press F for File menu
    win32api.SendMessage(TARGET_HWND, win32con.WM_KEYDOWN, ord('F'), 0)
    time.sleep(0.1)
    win32api.SendMessage(TARGET_HWND, win32con.WM_KEYUP, ord('F'), 0)
    time.sleep(0.3)
    
    # Press E for Export
    win32api.SendMessage(TARGET_HWND, win32con.WM_KEYDOWN, ord('E'), 0)
    time.sleep(0.1)
    win32api.SendMessage(TARGET_HWND, win32con.WM_KEYUP, ord('E'), 0)
    time.sleep(1)

def main():
    print(f"Target window: {win32gui.GetWindowText(TARGET_HWND)}")
    bring_to_front(TARGET_HWND)
    time.sleep(1)
    
    # Try Alt+F, E menu path
    click_menu_via_alt_keys()
    
    time.sleep(2)
    print("Menu sent, waiting for export dialog...")

if __name__ == '__main__':
    main()
