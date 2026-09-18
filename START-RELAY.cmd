@echo off
cd /d "%~dp0"
node -e "const [a,b]=process.versions.node.split('.').map(Number);if(a<22||(a===22&&b<13))process.exit(1)" >nul 2>&1
if errorlevel 1 (
  echo Relay requires Node.js 22.13 or newer. Install Node.js, then run this file again.
  pause
  exit /b 1
)
if not exist "standalone-dist\index.html" (
  echo Built files are missing. Run npm ci and npm run build first.
  pause
  exit /b 1
)
echo Relay runs on this computer. Open the URL printed below.
echo The administrator key is stored in .relay\admin-key.txt unless RELAY_ADMIN_TOKEN is configured.
node standalone/server.mjs
pause
