@echo off
setlocal enabledelayedexpansion
chcp 65001 > nul

echo.
echo ====================================
echo   EvoClaw Server Launcher
echo ====================================
echo.

for /f "tokens=5" %%a in ('netstat -ano ^| findstr ":27788" ^| findstr "LISTENING"') do (
    set PID=%%a
    echo [INFO] Found existing EvoClaw server on port 27788 (PID: !PID!)
    echo [INFO] Stopping existing process...
    taskkill /PID !PID! /F > nul 2>&1
    timeout /t 2 /nobreak > nul
    echo [INFO] Previous instance stopped.
    echo.
)

echo [INFO] Starting EvoClaw Server...
echo [INFO] Port: 27788
echo [INFO] Press Ctrl+C to stop
echo.
node --env-file=.env apps/server/dist/index.js