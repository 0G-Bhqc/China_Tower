@echo off
setlocal
cd /d "%~dp0"
start "Yueyang Tower Preview" /min cmd /c "node .\node_modules\vite\bin\vite.js --host 127.0.0.1"
timeout /t 2 /nobreak >nul
start "" "http://127.0.0.1:5173/?interactive=1"
endlocal
