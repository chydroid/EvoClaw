# Hermes 对齐第 11 轮 — 全仓缺陷台账（死码审计 × 能力差距清查）

> **状态（2026-11-20）：已闭环。** 建议顺序 1-6 全部执行完毕：三件套/usage anchor/
> todo 重注入/lsp-verdicts/P0 死码四项/GAP-11/GAP-2/GAP-4 落地；GAP-9 缓做（前提
> 架构不存在）；GAP-3 误报（前提不成立，见执行结果补记 2）。运维面/隔离
> GAP-12~24 已逐项判定：GAP-20 落地、GAP-22 已有等价物、其余 11 项缓做
> （见执行结果补记 3）。

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

## 执行结果补记（2026-11-20）

- 第 5 项已落地：ModelFailoverManager 记账镜像（status/reset 路由激活 + reset 同步清
  活熔断 ProviderHealthTracker）、DispatchDedupeStore（ChannelManager.messageHandler
  单点接线，成功后记账、失败留白允许重投）、BotLoopProtection（per-group block/alert）、
  ExecutionCheckpoint resume 下线（真实续跑 = DurableTaskRunner；快照为请求形状与
  持久 history 形状错位，直接回填会产生重复 user 轮）。7847 tests 绿。
- GAP-11 已落地：压缩摘要输入 role 定界（`<real_user_turn>`/`<assistant_turn>`）+
  指针声明，对齐 hermes context_compressor_typed_input.py。EvoClaw 持久 history 只含
  user/assistant 对、工具流量不入 history → 伪造面更窄，故选定界而非数组重构。
- **GAP-9 缓做（实证后不可移植）**：hermes 侧消费点在 gateway/session_kanban.py:358/402
  （`worker_claim_is_live` + `recover_failed_kanban_turns`），保护的是 gateway kanban
  session 循环中失败 turn 的原地重试；`HERMES_KANBAN_TASK` 是 dispatcher 进程模式标志
  （toolsets.py:155）。EvoClaw KanbanBoard 是服务器内 SQLite 队列，无 dispatcher/worker
  进程拆分、无失败 turn 重试循环可挂——recovery 原语的前提架构不存在。kanban-stop
  （终止门）是 EvoClaw 实际需要的 kanban 集成且已接线。若未来引入 kanban worker
  循环再立项。

## 执行结果补记 2（2026-11-20 续）：GAP-2/3/4

- **GAP-3 = 台账误报（GAP-10/17 同族第三例）**：hermes 的问题是压缩换代铸造新物理
  session_id + provider 按 prompt_cache_key 路由。EvoClaw 实证：① 压缩不改请求
  sessionId——compactConversationHistory 是 conversationHistory.set(sessionId, compacted)
  同键原地重写，successorId 纯元数据（markCompacted 零调用者、无任何代码把 -succ-
  变成请求 id）；② 全仓 prompt_cache_key 零发送。前提两侧都不成立，不立项。
- **GAP-4 落地（fail-closed 压缩门，最小对位）**：hermes 是压缩前 checkpoint API v2
  门；EvoClaw 的 JSONL append-only 持久层天然就是预压缩 checkpoint，但三个 persist
  函数失败静默吞掉。落地：persistSessionTurn/persistToolExecutionCheckpoint 失败按会话
  记账（persistFailureCounts）、成功即清；compactConversationHistory 入口发现未恢复的
  失败记录 → 拒绝压缩（stderr 带修复提示，对齐 hermes _CHECKPOINT_REQUIRED_REMEDIATION
  语义）。宁可不压缩，不丢未归档上下文。
- **GAP-2 落地（prepared compaction，最小移植）**：新文件 prepared-compaction.ts。
  回合末钩子（llm-caller turn 收尾，persistSessionTurn 之后）：上下文进入触发频带
  （锚优先探针 needsCompactionProbe ∈ (threshold×0.88, threshold]）→ 后台 pass 用
  deps.llmSummarizer 生成摘要（prompt 与内联同源 buildLLMSummaryPrompt；无
  CompactionManager 时本地定界 prompt，GAP-11 同款）。压缩取用点在
  compactConversationHistory：窗口校验（同会话/纯追加偶数增量/尾边界≥准备时
  sliceIndex/前缀指纹逐字节一致）命中 → 跳过同步 LLM 摘要（首 token 延迟来源）；
  任一失配 → 丢弃候选内联照旧（fail-closed）。单飞 per-session、pass 失败 60s 退避、
  压缩成功清状态。hermes 的等待运行中 pass/全局槽位/宿主 deadline 集成未移植（无
  流式进度钩子，等待语义留给内联 = 现状）。
- 测试：prepared-compaction.test.ts 12 个（频带判定/pass 生命周期/splice hit/三种
  miss fail-closed/退避/GAP-4 门三态/探针同口径/常量对齐）。教训两则：
  ① 后台 pass 与内联路径共用 deps.llmSummarizer —— 测试断言「内联未被调用」不能数
  调用次数为 0，要数「无额外调用」（hit=1，miss=2）；② 测试 makeDeps 的
  conversationHistory map 键必须与被测 sid 一致（默认键 test-session 的隐藏耦合）。
- 台账最终状态：1-6 项全闭环（GAP-3 误报、GAP-9 缓做，其余落地）。

## 执行结果补记 3（2026-11-20 续）：GAP-12~24 运维面/隔离逐项判定

逐项实证（hermes-first 原则：先查 hermes 怎么做，再看本项目前提是否成立）：

- **GAP-20 落地（错误体有界读）**：hermes 的 bounded_capture 语义（head/tail 窗口防
  OOM）。EvoClaw 实证无界读有两层：① nativeFetch 的 `res.on("data")` 无条件全量缓冲
  `chunks`（!ok 也一样）——真正的内存面在 fetch 层；② callLLMOnce 的
  `!response.ok` 分支 `await response.text()` 再放大一次拷贝。落地：nativeFetch 对
  !ok 错误体缓冲上限 64KB（超限 `req.destroy()`，error 处理器以截断前缀正常收尾
  而非 reject——destroy 不是真错误）+ consumer 侧 `readBoundedBodyText` 流式读取
  64KB 截断（超限 reader.cancel）。测试 3 条：fetch 层截断/小于上限完整保留/
  callLLMOnce 记账收到截断文本。教训：cap 判定按 chunk 粒度，断言上限要留单
  chunk 超冲余量（loopback chunk 可达 64KB）。
- **GAP-19 缓做（shell_exec 子进程 full-env）**：实证 shell-media-tools.ts:695
  确实传全量 `process.env`。但 hermes 的终端子进程**也**以 os.environ 为底
  （local.py `build_subprocess_env` base=None 快照 os.environ），其 scrub 层
  （_scrub_credentials/_plugin_terminal_env_strip_keys/secret-scope/vault）深度
  耦合多 profile 架构；EvoClaw 是单用户本地信任域，模型本可用 file_read 读 .env
  （同域信息），强行剥凭据会回归真实任务（git push GITHUB_PAT / gh 工作流直接
  失效）。前提架构（secret-scope 分级、inherit_credentials 白名单）不存在，
  不立项；若未来引入多 profile/远程沙箱再对标 env_passthrough 白名单。
- **GAP-17 estop 缓做（前提不存在）**：grep 全仓零接线确认（round8「已接线」
  记录与证据不符，本次以 grep 证据定案）。hermes 的 estop 是多进程 gateway/
  dispatcher 架构下的跨进程哨兵文件；EvoClaw 单进程事件循环内已有 AbortController
  链路，无跨进程停止需求。
- **GAP-12 OSV malware 检查 缓做**：接线点存在（mcp-client-manager connectServer）
  但 hermes 实现本身 fail-open ~300ms 超时查 OSV API——对单用户本地 MCP 网关
  收益边际，痛感出现再立项。
- **GAP-13 MCP schema 磁盘缓存 缓做**：reconnectServer/listTools 已有会话级
  工具缓存；磁盘缓存的前提（高频重连、工具 schema 大到重建痛）未出现。
- **GAP-14 cron 四件（incidents/quota_hold/missed_runs/lifecycle_guard）缓做**：
  R4 已落 cron pendingSlot/时区/配额（hermes round 对齐批次 D）；剩余四件是
  hermes 多租户 gateway 的运维面，EvoClaw 单用户 cron 无对应事故面。
- **GAP-15 子代理 worktree 隔离 缓做**：DelegateEngine 无 worktree 架构；与
  GAP-5 叠加场景（并行子代理互踩）在现有 file-state-registry per-session 锁下
  未观测到实际事故。
- **GAP-16 批量子代理 cache 预热门 缓做**：hermes leader-first stagger 是
  delegate 工具族批量并发场景；EvoClaw DelegateEngine 无批量并发入口。
- **GAP-18 env_probe 缓做**：hermes 用于远程/容器环境的工具链探测行；EvoClaw
  本地执行环境已知且稳定。
- **GAP-21 periodic_scheduler 缓做**：前提（每子代理 timer 线程数量爆炸）在
  EvoClaw 无对应面（无 per-child timer 架构）；ScheduleManager/CronScheduler
  已是单点合并。
- **GAP-22 message_sanitization 已有等价物**：stripWebNoise（白名单 + 头尾
  截断 + spill 文件 + 幂等守卫，代码输出腐蚀修复轮）覆盖同一事故面。
- **GAP-24 fast_mode 缓做**：hermes service tiers 是 Bedrock/Anthropic 特有
  计费面；EvoClaw provider 层无对应配置需求。
- 运维面/隔离层最终判定：**1 落地（GAP-20）、11 缓做、1 已有等价（GAP-22）**。
  全部缓做项均附前提缺失理由，痛感出现再立项。
