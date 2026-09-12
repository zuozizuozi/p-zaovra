@echo off
chcp 65001 >nul
setlocal
title 造物 - 本地测试
call "%~dp0packages\desktop-app\启动器.bat"
exit /b %errorlevel%
