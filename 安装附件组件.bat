@echo off
chcp 65001 >nul
setlocal
title 造物 - 附件组件
set "PATH=C:\ProgramData\chocolatey\bin;%PATH%"
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0packages\desktop-app\scripts\setup-attachments.ps1" -Advanced
if errorlevel 1 goto failed
echo 附件组件安装完成。
pause
exit /b 0
:failed
echo 安装未完成，请查看上方错误。重新运行可继续。
pause
exit /b 1
