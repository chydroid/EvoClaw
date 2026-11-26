#!/usr/bin/env bash
# ═══════════════════════════════════════════════════════════
# verify15.sh — 15 任务 e2e 压测交付物复核 harness（2026-11-24 重建入库）
#
# 背景：2026-11-07 e2e 15 任务轮性能分析 §7（分析稿已归档不入库）的复核脚本
# 当时放在 /tmp 一次性目录，清理后丢失。本脚本按 §7.3 / §8.3 的教训重建：
#   1. cd 子 shell（§7.3）：chk 条件在 ( ) 子 shell 中 eval——条件里的
#      cd 只污染子 shell，harness 自身 cwd 不变，后续相对路径检查不被带偏；
#   2. 整串条件入单个引号参数（§8.3 verify16b 教训）：chk 的第 2 参数是
#      完整条件串，多词条件不会像旧版 chk 那样被位置参数拆开只吃第一个词；
#   3. 复核脚本自身要有自检（§8.3）：--self-test 模式用一组合成检查证明
#      cd 隔离 / 多词条件 / 失败计数三条行为都成立，自检不过直接非 0 退出。
#
# 用法：
#   bash scripts/verify15.sh --self-test   # 自检 harness 自身（不依赖任何交付物）
#   bash scripts/verify15.sh              # 跑下方注册的任务检查（每轮压测填写）
#
# 每轮 e2e 在「任务检查注册区」按任务各登记一行 chk：
#   cond 约定为 "cd <任务产物目录> && <独立复核命令>"，
#   交付物一律独立复跑/校验，不采信模型自报（§6.3 方法论）。
# ═══════════════════════════════════════════════════════════
set -u

PASS=0
FAIL=0
CHECK_COUNT=0
FAILED_IDS=()

# chk <id> <cond> <desc>
#   id   ：检查编号（任务号或合成检查号）
#   cond ：完整条件串（多词条件入**单个**引号参数，§8.3 verify16b 教训）。
#          在 ( ) 子 shell 中 eval——cd 只作用于子 shell，harness cwd 不被
#          污染（§7.3 教训）。条件输出重定向丢弃，只看退出码。
#   desc ：人类可读说明（可省略）
chk() {
  local id="$1" cond="$2" desc="${3:-}"
  CHECK_COUNT=$((CHECK_COUNT + 1))
  if ( eval "$cond" ) >/dev/null 2>&1; then
    PASS=$((PASS + 1))
    printf 'PASS  %-6s %s\n' "$id" "$desc"
  else
    FAIL=$((FAIL + 1))
    FAILED_IDS+=("$id")
    printf 'FAIL  %-6s %s | cond: %s\n' "$id" "$desc" "$cond"
  fi
}

# ── 自检（§8.3：复核脚本自身要有自检）──────────────────────
# 在子 shell 中运行：合成检查对 PASS/FAIL/FAILED_IDS 的污染自然隔离，
# 不会串进任务检查的汇总。断言三条行为：
#   s1 多词条件（test && test && echo 全词生效）→ 应 PASS
#   s2 cd 条件在子 shell 内生效               → 应 PASS
#   s3 cd 隔离：s2 之后 harness 自身 pwd 不变  → 应 PASS
#   s4 失败路径：故意失败的条件计入 FAILED_IDS → 应 FAIL
self_test() {
  local tmp pre verdict=0
  tmp="$(mktemp -d)"

  chk "s1" "test -d '$tmp' && test -w '$tmp' && echo ok" "多词条件全词生效（期望 PASS）"
  pre="$(pwd)"
  chk "s2" "cd '$tmp' && test -d ." "cd 条件在子 shell 内生效（期望 PASS）"
  if [ "$(pwd)" = "$pre" ]; then
    chk "s3" "true" "cd 隔离：harness cwd 未被污染（期望 PASS）"
  else
    chk "s3" "false" "cd 隔离失败：harness cwd 被污染（不可发生）"
  fi
  chk "s4" "test -f '$tmp/nope-does-not-exist'" "失败路径（期望 FAIL 且计入 FAILED_IDS）"
  rm -rf "$tmp"

  # 断言：s1/s2/s3 PASS、s4 FAIL、计数与记录一致
  if [ "$PASS" -ne 3 ]; then
    echo "[self-test] 计数不符：PASS=$PASS（期望 3）"; verdict=1
  fi
  if [ "$FAIL" -ne 1 ]; then
    echo "[self-test] 计数不符：FAIL=$FAIL（期望 1）"; verdict=1
  fi
  case " ${FAILED_IDS[*]:-} " in
    *" s4 "*) : ;;
    *) echo "[self-test] s4 未计入 FAILED_IDS"; verdict=1 ;;
  esac
  if [ "$verdict" -eq 0 ]; then
    echo "[self-test] OK：cd 子 shell + 整串条件 + 失败计数均正常"
  fi
  return "$verdict"
}

if [ "${1:-}" = "--self-test" ]; then
  ( self_test )
  exit $?
fi

# ═══════ 任务检查注册区（每轮 e2e 填写，每个压测任务一行）═══════
# cond 约定："cd <任务产物目录> && <独立复核命令>"
#   - cd 只存在于 chk 子 shell 内（§7.3），harness 不全局 cd
#   - 条件整串入单个引号参数（§8.3），不要拆成多个位置参数
#   - 复核 = 独立复跑/校验交付物，不采信模型自报（§6.3）
# 示例（当前轮次请替换为实际 15 个任务检查，示例保持注释不执行）：
#
# chk "t01" "cd data/workspace/t15-01 && node --check app.js && test -s out/report.json" "任务1：语法 + 产物非空"
# chk "t02" "cd data/workspace/t15-02 && node test.js" "任务2：自测脚本退出码 0"
# chk "t03" "cd data/workspace/t15-03 && python3 aggregate_log.py" "任务3：聚合脚本可独立复跑"
# ...

# ── v30 轮（2026-11-24，6 任务）：独立复核 = 交付 CLI 复跑 + 产物 JSON 可解析 ──
# 深度口径（参考实现逐字段复算）由 scripts/test-sim-tasks-v30.mjs 承担；
# 此处只做轻量独立验证，避免 verify15.sh 与 harness 双份维护参考实现。
chk "v30-t1" "cd /home/chy/EvoClaw/data/workspace/v30-t1 && python3 sqleng.py run cases.json && python3 -c 'import json;json.load(open(\"report.json\"))'" "T1 SQL引擎 CLI 复跑 + report 可解析"
chk "v30-t2" "cd /home/chy/EvoClaw/data/workspace/v30-t2 && python3 walstore.py run wal.json && python3 -c 'import json;json.load(open(\"report.json\"))'" "T2 WAL CLI 复跑 + report 可解析"
chk "v30-t3" "cd /home/chy/EvoClaw/data/workspace/v30-t3 && python3 align.py run cases.json && python3 -c 'import json;json.load(open(\"report.json\"))'" "T3 对齐 CLI 复跑 + report 可解析"
chk "v30-t4" "cd /home/chy/EvoClaw/data/workspace/v30-t4 && node jsonops.js run ops.json && node -e 'JSON.parse(require(\"fs\").readFileSync(\"report.json\"))'" "T4 JSON重放 CLI 复跑 + report 可解析"
chk "v30-t5" "cd /home/chy/EvoClaw/data/workspace/v30-t5 && node fsm.js run machines.json && node -e 'JSON.parse(require(\"fs\").readFileSync(\"report.json\"))'" "T5 状态机 CLI 复跑 + report 可解析"
chk "v30-t6" "cd /home/chy/EvoClaw/data/workspace/v30-t6 && node frames.js run frames.json && node -e 'JSON.parse(require(\"fs\").readFileSync(\"report.json\"))'" "T6 帧协议 CLI 复跑 + report 可解析"

# ═══════ 汇总（退出码：有 FAIL → 1；全 PASS 或模板模式 → 0）═══════
echo
if [ "$CHECK_COUNT" -eq 0 ]; then
  echo "=== 模板模式：未注册任务检查（当前轮次请在「任务检查注册区」填写 chk 行）==="
  exit 0
fi
if [ "$FAIL" -gt 0 ]; then
  printf '=== %s passed | %s failed: %s ===\n' "$PASS" "$FAIL" "${FAILED_IDS[*]}"
  exit 1
fi
printf '=== %s passed | 0 failed ===\n' "$PASS"
exit 0
