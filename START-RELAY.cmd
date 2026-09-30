@echo off
cd /d "%~dp0"
node -e "const [a,b]=process.versions.node.split('.').map(Number);if(a<22||(a===22&&b<13))process.exit(1)" >nul 2>&1
if errorlevel 1 (
  echo Relay needs Node.js 22.13 or newer.
  echo Install Node.js LTS, then double-click START-RELAY.cmd again.
  powershell.exe -NoProfile -Command "Add-Type -AssemblyName PresentationFramework; if ([System.Windows.MessageBox]::Show('Relay needs Node.js LTS. Open the official download page? After installing, double-click START-RELAY.cmd again.', 'Relay Setup', 'YesNo', 'Information') -eq 'Yes') { Start-Process 'https://nodejs.org/en/download' }"
  pause
  exit /b 1
)
echo Relay will prepare and open your browser automatically.
node scripts/launch.mjs
if errorlevel 1 (
  echo.
  echo Relay could not start. Read the message above and try again.
)
pause
