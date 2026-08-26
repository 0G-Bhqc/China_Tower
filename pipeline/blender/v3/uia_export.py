import uiautomation as auto
import time

TARGET_HWND = 136030
EXPORT_PATH = r"E:\Station\China_Tower\evidence\3d-assets\jobs\tengwang\outputs\full-scene-22753718.fbx"

try:
    print(f"Connecting to window {TARGET_HWND}...")
    
    # Find the main window
    main_window = auto.Control(searchDepth=1, Handle=TARGET_HWND, Name="3d66.com_22753718.max - Autodesk 3ds Max 2026")
    print(f"Found window: {main_window.Name}")
    
    # Restore and focus
    main_window.SetFocus()
    time.sleep(0.5)
    
    # Try to find File menu
    print("Looking for File menu...")
    file_menu = main_window.MenuItemControl(Name="文件(F)")
    if file_menu.Exists():
        print(f"Found File menu: {file_menu.Name}")
        file_menu.Click()
        time.sleep(0.5)
        
        # Try to find Export submenu
        export_item = file_menu.MenuItemControl(Name="导出(E)")
        if export_item.Exists():
            print(f"Found Export menu: {export_item.Name}")
            export_item.Click()
            time.sleep(2)
            
            # Look for export dialog
            export_dlg = auto.WindowControl(Name="Export", ClassName="#32770")
            if export_dlg.Exists():
                print(f"Found export dialog: {export_dlg.Name}")
            else:
                print("No export dialog found")
        else:
            print("Export menu item not found")
    else:
        print("File menu not found")
    
except Exception as e:
    print(f"ERROR: {e}")
    import traceback
    traceback.print_exc()
