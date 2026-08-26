Add-Type -AssemblyName System.Windows.Forms

$targetTitle = "3d66.com_22753718.max - Autodesk 3ds Max 2026"

# Find and activate 3ds Max window
$wshell = New-Object -ComObject WScript.Shell
$wshell.AppActivate($targetTitle)
Start-Sleep -m 500

# Send Alt+F, then E for Export
[System.Windows.Forms.SendKeys]::SendWait("%F")
Start-Sleep -m 500
[System.Windows.Forms.SendKeys]::SendWait("E")
Start-Sleep -m 2000

Write-Host "Menu sequence sent"
