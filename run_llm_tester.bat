@echo off
chcp 65001 >nul
title 🦞 EvoClaw LLM 通用测试工具

echo ============================================
echo  🦞 EvoClaw LLM 通用测试工具
echo ============================================
echo.

:: 检查 Python 是否安装
where python >nul 2>&1
if %errorlevel% neq 0 (
    echo ❌ 未检测到 Python，请先安装 Python 3.8+
    echo    下载地址: https://www.python.org/downloads/
    pause
    exit /b 1
)

:: 检查并安装依赖
echo 📦 检查依赖...
python -c "import requests" 2>nul
if %errorlevel% neq 0 (
    echo 📥 正在安装 requests...
    pip install requests -q
)

python -c "import PyQt5" 2>nul
if %errorlevel% neq 0 (
    echo 📥 正在安装 PyQt5...
    pip install PyQt5 -q
)

echo.
echo 🚀 启动 LLM 测试工具...
echo.
echo 支持的服务商:
echo   - OpenAI / DeepSeek / 通义千问
echo   - 月之暗面 / 智谱GLM / 零一万物
echo   - 百度千帆 / 自定义
echo.
echo 测试指标: 总耗时 | 首Token时间(TTFT) | 生成速度(tok/s)
echo.

:: 启动主程序
python llm_tester.py

:: 如果程序退出，暂停显示
echo.
echo 程序已退出，按任意键关闭...
pause >nul
