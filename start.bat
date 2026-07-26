@echo off
cd /d "%~dp0"
where node >nul 2>nul
if errorlevel 1 (
  echo Node.js 18 or newer is required.
  echo Install Node.js, then run this file again.
  pause
  exit /b 1
)
start "" "http://127.0.0.1:3210"
node server.js
pause
