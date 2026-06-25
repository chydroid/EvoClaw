@echo off
REM Setup git hooks for EvoClaw
REM Run this script after cloning the repository

echo Setting up git hooks...

REM Configure git to use .githooks directory
git config core.hooksPath .githooks

REM Make hooks executable (Git Bash on Windows)
if exist ".githooks\pre-commit" (
    git update-index --chmod=+x .githooks/pre-commit 2>nul
)

echo Git hooks configured successfully!
echo.
echo Available hooks:
echo   - pre-commit: Checks for secrets and console.log
