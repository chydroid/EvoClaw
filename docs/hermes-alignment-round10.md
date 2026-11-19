# Hermes 对齐第 10 轮 — 复杂任务完成可靠性

> 调研来源：只读对比 `/home/chy/projects/hermes-latest/`（386 agent/*.py），
> 聚焦「复杂编码任务完成可靠性」：截断恢复 / 错误分类 / checkpoint / delegate
> 死亡取证 / 参数拒绝 / fallback 语义。v20 压测同期实施。

## 本轮落地（3 项）

### 1. length 截断恢复链路接线（hermes `agent/turn_truncation.py`）

**差距（调研确认）**：
- `streaming-recovery.ts` 的 `needsContinuation` 判决全仓零消费者——llm-caller 恢复调用只消费 `usedPartialContent` 分支，`needsContinuation: true` 直接落到 "Discarding N chars"。
- 更关键：恢复调用在 `if (streamReadError)` 分支内。**正常结束但 finish_reason==="length" 的流完全不进恢复路径**。
- `turn-truncation.ts`（282 行，已移植 thinking 耗尽/重复主导/窗口填满/4 次上限全套策略）导出的 `checkTruncation` 只有 barrel 导出与测试引用——死码。

**落地**：
- `CallLLMOnceResult` / `ParseStreamingResponseResult` 新增 `truncatedByLength`（流式：`finishReason === "length"`；非流式：`choices[0].finish_reason === "length"`）与 `runawayDetected`（流内看门狗中断标志，此前 OpenAI 路径 break 后未记录）。
- 主循环在 `assistantMsg` 处统一消费：调 `checkTruncation`，`continue` → 回灌 `buildContinuationNudge()`（transient，不写 history，缓存安全；`lengthContinueRetries` 上限 4 与 hermes 同值）；`abort_*` → 用户文案收尾（软中止，partial 内容合并返回）。
- 工具轮截断（有 tool_calls）不回灌 nudge，先执行工具在下一轮自然续写（hermes 同语义）。

### 2. output-cap 400 独立分类 + clamp 接线（hermes `agent/model_metadata.py is_output_cap_error` + `turn_overflow._clamp_output_cap`）

**差距**：OpenAI 式 "max_tokens is too large... reduce the length" 会命中 `CONTEXT_OVERFLOW_PATTERNS` 的 `/reduce.the.length/i`、`/token.limit/i` → 误判 context_overflow → 触发压缩，但压缩改不了 max_tokens，同一错误反复进压缩器形成死循环（hermes 注释明言的陷阱）。`turn-overflow.ts` 的 `clampOutputCap` 已实现但零接线。

**落地**：
- `failover-policy.ts` 新增 `output_cap` reason（transient：`isTransientReason` / `shouldAllowCooldownProbeForReason` / `shouldUseTransientCooldownProbeSlot` 三表齐加）。
- `error-classifier.ts` 新增 `LLMErrorType.OUTPUT_CAP` + `isOutputCapError()`（cap 信号词表 + input overflow 反信号，400/422 限定）+ `parseAvailableOutputTokens()`（9 种 provider 措辞解析上限数字，64..10M 合理性过滤）。**output-cap 门必须先于 CONTEXT_OVERFLOW 判定**。
- `llm-caller.ts` 主循环消费：解析上限 → `clampOutputCap(providerCap, inputEstimate, contextLength)` → 同 provider 原地重试；`TurnRetryState.checkAndMark` 一次性守卫（每错误文本最多 clamp 一次），clamp 后仍 cap → failover。

### 3. delegate 子代理异常死亡取证 hints（hermes `tools/async_delegation_recovery_hints.py`）

**差距**：`delegate-engine.ts` 后台子代理异常只 `process.stderr.write`，无取证附加——父代理需开文件侦查才能决定续跑还是重派。

**落地**：`DelegateRunResult` 新增 `failureHints { transcriptTail, gitStatus }`；`executeChild` catch 内 best-effort 采集：
- `transcriptTail`：子会话 `data/sessions/<agent>/<sid>/transcript.jsonl` 尾部 20 行 / 2000 字符（hermes bounded 同值）；
- `gitStatus`：`branch@sha (N uncommitted)` 一行（hermes 同语义）。
- 依赖新增 `DelegateEngineDeps.sessionsDir`（apps/server 接线 `data/sessions`）。

## 本轮确认已对齐（无需动作）

- 工具输出体积（48K spill + 40/60 头尾 + 分级 MAX_RESULT_LEN + 16K 二次落盘）≈ hermes tool_output_limits.py。
- 413 字节打分压缩（recoverPayloadTooLarge 已接线）、maxTokensBoost（2^n 上限 32×）已接线。
- overload ladder（原地等待重试）实质等价 hermes `switch_deferred_by_reset`；provider skip list（TTL 5min）覆盖失败记忆。
- turn-failure-copy 人话文案（第 7 轮成果）在位。

## 缓做项（痛感未证实，按 hermes 对齐惯例记录）

| 项 | hermes 机制 | 现状 | 建议 |
|---|---|---|---|
| 文件级 checkpoint/rollback | `tools/checkpoint_manager.py` shadow-git store + restore | `file-checkpointer.ts` 死码；execution checkpoint 只存对话消息且 resume 无消费方 | 先暴露 `/rollback` 最小面，shadow-git 缓做 |
| delegate auto_resume | `delegate_tool_auto_resume.py`（限流 reset 到点/崩溃后自动续跑） | 无 | 涉及跨进程 tick/持久化，缓做 |
| 参数拒绝 ladder | `auxiliary_client.py _parameter_rungs`（temperature/structured/reasoning 逐 rung 剥离 + 记忆） | aux 回退链只对 402/rate-limit continue | 严格 provider 上 aux 链（压缩/标题）整链死亡时再做 |
| restore primary | `agent_runtime_helpers.restore_primary_runtime` | failover 后永久留在 fallback（skip list TTL 过后自然回到循环，无主动探测） | 先确认实际痛感 |
| 流解析错误词表 | `api_error_summary.py` PROVIDER_STREAM_PARSE_MARKERS | 落 unknown/transient（默认可重试，行为安全） | 缓做 |
| 402 affordable-clamp | `turn_recovery._clamp_to_affordable_budget` | 402 → BILLING 直接弃 provider | 有 provider 信用额度场景再做 |

## v20 压测关联

本轮调研同期跑 v20 十任务压测，Task 6（正则引擎 1506s 超时 + 4/16 用例挂）正是
length 截断链路断裂的受害形态：任务收尾时模型被 max_tokens 截断、无续写 nudge、
部分交付后 ⏳ checkpoint 后台续跑仍未补齐 README。落地项 1 直接对症。
