@echo off
chcp 65001 >nul
setlocal
cd /d "%~dp0"

title Alysia Docs

where node >nul 2>nul
if errorlevel 1 (
  echo.
  echo  [docs] Node.js not found in PATH.
  echo         Install Node 20+ first, then run this again.
  echo.
  pause
  exit /b 1
)

echo  [docs] starting local docs server on http://127.0.0.1:7801/ ...
start "Alysia Docs Server" cmd /k node "docs\site\serve.mjs"

timeout /t 2 >nul
start "" "http://127.0.0.1:7801/"

exit /b 0
