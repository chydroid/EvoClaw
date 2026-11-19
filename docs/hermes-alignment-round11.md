# Hermes 对齐第 11 轮 — 全仓缺陷台账（死码审计 × 能力差距清查）

> 调研来源：2026-11-19，用户问「本项目到底还有多少缺陷要修复」。两个只读审计并行：
> ① 全仓 1903 个顶层 export 零消费者扫描（死码/未接线）；② hermes 全模块面
> （386 agent/*.py + 206 tools/*.py）能力差距盘点。判定原则：**原语存在 ≠ 已接线**。
> 已排除 round10 末尾 6 个缓做项与 round2-10 已落地项。

## 一、确认死码（模块级，零生产消费者）

### P0 接线（能力面已建成但从未启用）

| 模块 | 位置 | 行数 | 现状 |
|---|---|---|---|
| ModelFailoverManager | packages/agent/src/model-failover.ts | 707 | 无 `new`、无 `registerService("failoverManager")` → `/api/system/failover/status|reset` 两路由恒 503，熔断/健康统计整套不存在 |
| DispatchDedupeStore | packages/gateway/src/dispatch-dedupe-store.ts | 275 | channel 分发无持久化去重 |
| BotLoopProtection | packages/gateway/src/bot-loop-protection.ts | 466 | 群聊环路防护未接 |
| ExecutionCheckpointStore.resume | packages/agent/src/agent-model-executor.ts | — | `resumeExecution`/`listResumableExecutions` 0 调用者；store.resume() 只回快照不重启 LLM 循环 → 「断点续跑」实质不存在（查询面已接） |
| FileCheckpointer/DependencyAnalyzer/ErrorDiagnostician | packages/claude-code-tools/src/ | 283+310+309 | ClaudeCodePlugin 只装 orchestrator/upgrader，三者 0 new |

### P1 接线或删除

TUIManager(479行) / DaemonManager(674) / PluginHost(473,弃用旧实现) / OnboardingWizard(406,弃用) /
StreamingManager(387,弃用) / OutboundRouter(340) / RetryPolicy(351) / MediaRuntime(412) /
RAGPipeline(210) / ExecAutoReviewer(206) / coding-context.ts(602,编码上下文从未进 system-prompt) /
credits-tracker.ts(540) / kanban-turn-recovery.ts(157) / tool-result-classification.ts(94) /
EnhancedAgentExecutor+tool-protocol+tool-planner 链(680) / reflection-contract.ts(311) /
message-utils.ts(184) / clarify-tool.ts(560,与 tools/clarify-tools.ts 重复实现)

### P2 半接线（注册但无人解析 / barrel 过度导出）

- `memoryHost`：server 注册但全仓 0 resolveService → MemoryHost(469行) 寄生
- `toolPolicyManager`：server 注册但 0 resolveService → ToolPolicyManager(334行) 策略从不生效
- barrel 过度导出：turn-truncation 7 个文案常量、llm-caller 17/26 导出死、turn-overflow 6 常量、
  failover-policy shouldAllowCooldownProbeForReason 0 消费等
- 复制实现二选一：clarify-tool vs clarify-tools、response-validator vs 其 plugin 版

## 二、Hermes 能力差距（GAP 清单，前 10 轮未覆盖）

### 编码任务成功率直接相关（优先级最高）

| # | 能力 | hermes 位置 | EvoClaw 现状 |
|---|---|---|---|
| GAP-5 | file_write modify 无 stale-overwrite 阻断 | tools/file_tools_write_guards.py `_stale_overwrite_blocker` | handleFileWriteModify 直接覆盖无 mtime/读过校验；**file-state-registry.ts 对标实现存在但 apps/server 零调用**——多轮任务基于旧快照整文件覆盖是静默丢工作的最直接路径 |
| GAP-7 | 无 old_string/new_string 精确编辑工具 | tools/fuzzy_match.py + escape_drift_autocorrect.py | fuzzy-match.ts、patch-parser.ts 存在但 file-tools 只发全文；apply_patch 仅 code-intelligence 一处可用。改大文件必须整文件重发或绕过护栏走 shell |
| GAP-6 | 无 per-task read tracking | tools/file_tools_read_tracking.py | file_read 无去重/循环检测/覆盖账；与 GAP-5 共享基线 |

### 压缩/上下文管理

| # | 能力 | hermes 位置 | EvoClaw 现状 |
|---|---|---|---|
| GAP-1 | usage anchor | agent/usage_anchor.py | 压缩门纯 chars/4 估算；流式 `chunk.usage.prompt_tokens` 拿到了只进记账不进判定。CJK 会话误差可达 2× |
| GAP-2 | prepared compaction | agent/prepared_compaction.py | 无；压缩在 turn 起点同步等全量摘要 |
| GAP-3 | 压缩后 prompt_cache_key 桶分裂 | agent/prompt_cache_scope.py | successor sessionId 换代后 cache key 不解析到 ROOT → 压缩后全量前缀重写 |
| GAP-4 | 预压缩 fail-closed checkpoint 门 | agent/conversation_compression_checkpoint.py | 无联动门 |
| GAP-11 | 压缩摘要输入可被工具输出伪造注入（安全） | agent/context_compressor_typed_input.py | buildLLMSummaryPrompt 平面 `[role]:` 拼接，工具打印的 `[USER]:` 会进摘要长期携带 |

### 轮次停止门 / 会话恢复

| # | 能力 | hermes 位置 | EvoClaw 现状 |
|---|---|---|---|
| GAP-8 | lsp-verdicts 死码 | agent/turn_stop_gates.py `_late_lsp_verdicts` | lsp-verdicts.ts 完整实现仅 barrel 导出零调用；verification-stop 是现成挂点 |
| GAP-9 | kanban-turn-recovery 死码 | agent/kanban_turn_recovery.py | 文件存在零消费者（kanban-stop 已接线，recovery 未接） |
| GAP-10 | transcript 重载无 dangling tool_call 清理 | agent/replay_cleanup.py | closeInterruptedToolSequence 只覆盖 in-memory 路径；session-manager.loadTranscript 直载路径无清理 |
| GAP-23 | todo 压缩后重注入 | tools/todo_tool.py | **todo-tools.ts 头注释声称已实现但三处 grep 零调用——注释与实现不符**（v20 Task 6 同型事故源头） |

### 运维面 / 隔离（痛感出现再立项）

- GAP-12 MCP OSV malware 检查（tools/osv_check.py）— 低-中/小
- GAP-13 MCP 会话健康/schema 磁盘缓存 — 低/中
- GAP-14 cron incidents/quota_hold/missed_runs/lifecycle_guard（cron/*.py 四件）— 中/中-大
- GAP-15 子代理 git worktree 隔离（tools/subagent_worktree.py）— 中/中；与 GAP-5 叠加时并行子代理互踩文件
- GAP-16 批量子代理 cache 预热门（tools/delegate_tool_prefix_gate.py）— 低-中/小-中
- GAP-17 estop 全局紧急暂停哨兵（agent/estop.py）— **round8 记录「已接线」与 grep 证据不符，需复核**
- GAP-18/19/20/21/22/24 env_probe / env_passthrough / bounded_response(流式 error body 无界读 llm-caller:4172) /
  periodic_scheduler / message_sanitization / fast_mode — 均低/小

## 三、建议执行顺序（按编码任务成功率加权）

1. **GAP-7+5+6 文件编辑三件套**：old_string 编辑工具 + fuzzy 接线 + stale 阻断 + FileStateRegistry
   接到 file-tools。「改错文件/丢工作/token 爆炸」三类事故共同根因。收益最高。
2. **GAP-1 usage anchor**：一处小改，压缩触发时机准确性服务所有长会话。
3. **GAP-23 todo 重注入**：注释声称实则无代码，压测事故同型。
4. **GAP-8 + GAP-10**：都是「已写好就差一个调用点」。
5. **P0 死码接线**：ModelFailoverManager（API 面已建好但 503）、DispatchDedupeStore、
   BotLoopProtection、ExecutionCheckpoint resume 语义补全或下线 Resume API。
6. GAP-11（安全向）+ 其余 GAP 按痛感立项，沿用缓做记录惯例。
