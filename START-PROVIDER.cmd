@echo off
setlocal
cd /d "%~dp0"
if not exist "%~dp0provider\update_launcher.py" (
  echo Relay setup files are missing.
  echo Extract ALL files from the ZIP, then run START-PROVIDER.cmd from that folder.
  echo Do not run this file from inside the ZIP preview.
  pause
  exit /b 1
)
py -3 -c "import sys, tkinter; sys.exit(0 if sys.version_info >= (3,10) else 1)" >nul 2>&1
if not errorlevel 1 (
  echo Checking for Relay updates before opening setup...
  py -3 "%~dp0provider\update_launcher.py" %*
  if errorlevel 1 goto setup_failed
  exit /b 0
)
python -c "import sys, tkinter; sys.exit(0 if sys.version_info >= (3,10) else 1)" >nul 2>&1
if not errorlevel 1 (
  echo Checking for Relay updates before opening setup...
  python "%~dp0provider\update_launcher.py" %*
  if errorlevel 1 goto setup_failed
  exit /b 0
)
echo Relay GPU setup needs Python 3.10 or newer with Tcl/Tk.
echo Install Python from the page opening now, then double-click this file again.
start "" "https://www.python.org/downloads/"
pause
exit /b 1

:setup_failed
echo.
echo Relay PC setup could not start. The error is shown above.
echo Check the update message above. Your existing model and connection settings are preserved.
echo Keep this window open when reporting the error.
pause
exit /b 1
