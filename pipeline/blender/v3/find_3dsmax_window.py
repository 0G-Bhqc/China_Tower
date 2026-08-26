import win32gui
import win32con

def find_3dsmax_window():
    result = []
    def callback(hwnd, extra):
        title = win32gui.GetWindowText(hwnd)
        cls = win32gui.GetClassName(hwnd)
        if '3ds' in title.lower() or 'max' in title.lower() or '3ds' in cls.lower():
            result.append((hwnd, cls, title))
        return True
    
    win32gui.EnumWindows(callback, None)
    return result

if __name__ == '__main__':
    windows = find_3dsmax_window()
    print(f"Found {len(windows)} 3ds Max windows:")
    for hwnd, cls, title in windows:
        print(f"  {hwnd}: [{cls}] {title}")
