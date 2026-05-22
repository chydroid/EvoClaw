@echo off
chcp 65001 >nul
title 🦞 EvoClaw LLM 通用测试工具
echo ============================================
echo  🦞 EvoClaw LLM 通用测试工具
echo ============================================
echo.
echo 正在检查依赖...
python -c "import requests" 2>nul
if %errorlevel% neq 0 (
    echo 正在安装 requests 库...
    pip install requests -q
    echo 安装完成！
)
echo.
echo 正在启动测试工具...
echo.
python llm_tester.py
if %errorlevel% neq 0 (
    echo.
    echo 启动失败！请确保已安装 Python 3.8+
    echo.
    pause
)
