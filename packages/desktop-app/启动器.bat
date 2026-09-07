@echo off
setlocal
title Zaovra Desktop - Local Test
cd /d "%~dp0..\.."
if errorlevel 1 goto failed
set "PATH=%USERPROFILE%\.bun\bin;C:\ProgramData\chocolatey\bin;%PATH%"
where bun >nul 2>nul
if errorlevel 1 goto missing_bun
if not exist "node_modules" goto install
if not exist "packages\desktop-app\node_modules" goto install
goto launch

:install
echo Installing repository dependencies...
call bun install --frozen-lockfile
if errorlevel 1 goto failed

:launch
cd /d "%~dp0"
if not exist "node_modules\electron\dist\electron.exe" goto install_electron
if not exist "node_modules\electron\path.txt" goto install_electron
goto start_desktop

:install_electron
echo Downloading the Electron runtime for this project...
call bun node_modules/electron/install.js
if errorlevel 1 goto failed

:start_desktop
echo Starting the real Zaovra desktop app from this checkout.
echo Local desktop development opens the workbench without website sign-in.
echo The first launch builds the embedded server and may take a moment.
echo Keep this window open while testing. Press Ctrl+C to stop.
cd /d "%~dp0"
call bun run dev
if errorlevel 1 goto failed
exit /b 0

:missing_bun
echo Bun was not found. Install Bun 1.3.14, then run this launcher again.
echo https://bun.sh
pause
exit /b 1

:failed
echo.
echo Desktop startup failed. See the error above.
pause
exit /b 1
