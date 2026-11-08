#!/usr/bin/env bash
cd /home/chy/EvoClaw/data/workspace
LOG=/home/chy/EvoClaw/data/workspace/v9-ci/verify-output.log
: > "$LOG"
{
  echo "########## 1) 运行 lint-check.sh ##########"
  echo "命令: ./v9-ci/lint-check.sh ."
  ./v9-ci/lint-check.sh .
  echo "lint-check.sh 退出码: $?"
  echo
  echo "########## 2) 运行 build-artifact.sh ##########"
  echo "命令: ./v9-ci/build-artifact.sh"
  ./v9-ci/build-artifact.sh
  echo "build-artifact.sh 退出码: $?"
} >> "$LOG" 2>&1
echo "log written to $LOG"
wc -l "$LOG"
