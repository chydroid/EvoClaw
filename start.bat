@echo off
setlocal enabledelayedexpansion
chcp 65001 > nul

echo.
echo ====================================
echo   EcoClaw Server Launcher v0.3.4
echo ====================================
echo.

for /f "tokens=5" %%a in ('netstat -ano ^| findstr ":17788" ^| findstr "LISTENING"') do (
    set PID=%%a
    echo [INFO] Found existing EcoClaw server on port 17788 (PID: !PID!)
    echo [INFO] Stopping existing process...
    taskkill /PID !PID! /F > nul 2>&1
    timeout /t 2 /nobreak > nul
    echo [INFO] Previous instance stopped.
    echo.
)

echo [INFO] Starting EcoClaw Server...
echo [INFO] Port: 17788
echo [INFO] Press Ctrl+C to stop
echo.
node --env-file=.env apps/server/dist/index.js