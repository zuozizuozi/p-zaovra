@echo off
setlocal
title Zaovra Website - Local Preview
cd /d "%~dp0..\.."
if errorlevel 1 goto failed
set "PATH=%USERPROFILE%\.bun\bin;C:\ProgramData\chocolatey\bin;%PATH%"
where bun >nul 2>nul
if errorlevel 1 goto missing_bun
if not exist "node_modules" goto install
if not exist "packages\website\app\node_modules" goto install
goto launch

:install
echo Installing repository dependencies...
call bun install --frozen-lockfile
if errorlevel 1 goto failed

:launch
echo Starting the real website source with the Vercel resource adapter.
echo Local URL: http://127.0.0.1:3001
echo This previews this checkout; it does not deploy to the public site.
echo Account and payment features require their service environment variables.
echo Keep this window open while testing. Press Ctrl+C to stop.
set "VERCEL=1"
cd /d "%~dp0app"
call bun run dev --host 127.0.0.1 --port 3001 --strictPort --open /
if errorlevel 1 goto failed
exit /b 0

:missing_bun
echo Bun was not found. Install Bun 1.3.14, then run this launcher again.
echo https://bun.sh
pause
exit /b 1

:failed
echo.
echo Website startup failed. See the error above.
echo If port 3001 is occupied, close the previous preview before trying again.
pause
exit /b 1
