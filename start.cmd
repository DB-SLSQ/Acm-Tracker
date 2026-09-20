@echo off
cd /d "%~dp0"
echo Starting ACM Trainer...
start "" cmd /c "timeout /t 2 >nul & start "" http://127.0.0.1:5173"
node --no-warnings server.js
pause
