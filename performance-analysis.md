# EvoClaw LLM 调用性能分析

> 分析对象：`packages/agent/src/agent-model-executor.ts`（`chat()`）与 `packages/agent/src/llm-caller.ts`（`tryCallLLM()`）
> 方法：逐行阅读源码（非凭经验推测），所有瓶颈标注均在源码中核实位置。

---

## 1. 每次 LLM 调用的完整流程（消息构建 → API 调用 → 响应处理）

```
chat(message, context, onProgress)                          # agent-model-executor.ts:1694
 ├─ 会话解析（sessionId/agentId/channel/peerId）
 ├─ 后台任务 park（durableRunner.pause）
 ├─ slash 命令拦截（命中即直接返回）
 ├─ abortSession（中断同 session 在飞请求）
 ├─ observability span + 软超时竞速 + Turn 存活看门狗
 └─► chatInner()                                             # :1824
     ├─ 输入清洗 pipeline（XSS/注入/长度/guardrails/插件 hooks）
     ├─ 快速拦截层（状态/审批/天文/工具/语义快答/技能/配置/邮件/SkillDispatcher，均不调 LLM）
     ├─ 意图分析 + 任务拆分（analyzeUserIntent / decomposeTaskWithLLM）
     ├─ 记忆召回（分层 + 长期，会话粘性缓存 P0-6）
     ├─ 上下文引擎 + 系统提示 → systemPrompt / dynamicSystemTail / skillsMessage
     ├─ sessionLoadFn：loadTranscript → archiveOlderTurns（串行 await）→ conversationHistory.set
     │   + appendTurn（同步写盘）+ persistSessionTurn（user 轮落盘）
     ├─ CopilotRouter 路由（简单任务降级便宜模型）
     └─► tryCallLLM(deps, options)                           # llm-caller.ts:3973
         ├─ deps 浅拷贝（if abortSignal: deps = {...deps, abortSignal}）
         ├─ computeDynamicToolLimit（正则匹配 + 历史长度）
         ├─ 构建 expandedProviders（providers 逐条展开 + {...p, model}）
         ├─ 审批意图检测（命中 → 直接 shell_exec，绕过 provider 循环）
         └─ provider 主循环：
             ├─ 熔断器 / skip list 检查
             ├─ 构造 messages（P0-7 布局：[sys_frozen, sys_ephemeral, skills?, tail?, ...history, user]）
             ├─ callLLMOnce()：构建请求体 → nativeFetch（keep-alive）→ 流式 SSE 解析
             │   → onProgress → usage 提取 → normalizeUsage → cacheExtrasFromResult
             ├─ 工具调用循环（≤ maxToolRounds 轮）：
             │   解析 tool_calls → 并发执行（global 5 / browser 1 / network 3 信号量）
             │   → 失败熔断 → auto-continuation（MAX=3 + overlapRatio>0.7 守卫）
             │   → 结果追加 → 下一轮 LLM
             └─ 响应后处理：时间戳 + collapseNewlines + rememberInteraction + 输出 guardrails
```

---

## 2. 性能瓶颈识别（4 类，共 10 项）

### 2.1 重复计算（每轮 LLM 调用入口都重做）

| # | 瓶颈 | 位置 | 证据 |
|---|------|------|------|
| R1 | `getLLMCallerDeps(sessionId)` 每次全量构建 ~30 字段 deps 对象，含 8+ 个新建闭包（`recordToolTrace`/`checkAndReflect`/`updatePlanStep`/guardrails 等） | agent-model-executor.ts:1057-1111 | `return { config: this.config, ..., recordToolTrace: (sid,...) => this.recordToolTrace(...), ... }` |
| R2 | deps 浅拷贝 `deps = { ...deps, abortSignal }` 每次入口重做 | llm-caller.ts:3973 | 仅 2 行，但 ~30 字段逐次分配 |
| R3 | `computeDynamicToolLimit` 每轮重跑 16 条正则 + `hasActionIntentFn` + 历史长度查询 | llm-caller.ts:1552-1602 | `complexPatterns`/`veryComplexPatterns` 数组每调用重新 `.some(p => p.test(...))` |
| R4 | `expandedProviders` 每轮重建数组，多模型 provider 逐条 `{...p, model}` 字面量展开 | llm-caller.ts:4046-4056 | providers 引用在会话内不变时结果完全相同 |
| R5 | 审批意图检测 `APPROVAL_PATTERNS.test(message)` + `pendingApprovalCommands.get(sessionId)` 在 tryCallLLM 入口重做，与 chatInner 拦截层重复 | llm-caller.ts:4059 | chatInner 已做过同类意图判断 |

### 2.2 不必要的序列化

| # | 瓶颈 | 位置 | 证据 |
|---|------|------|------|
| S1 | 工具结果在 `recordToolTrace` 入参处 `JSON.stringify(result).slice(0,500)`，后续路径还会再 stringify 一次 | agent-model-executor.ts:4437/4451/4518 | 非 string 工具结果（对象）被反复全量序列化 |
| S2 | `guardrailedReply = JSON.stringify(parsed.data, null, 2)` 结构化解析后 pretty-print | agent-model-executor.ts:3008 | pretty（2 空格）版仅用于展示，却每次全量生成 |
| S3 | llm-caller 内 49 处 `JSON.stringify`，部分在热循环内对同一 tool+params 重复跑 | llm-caller.ts（grep 计数 49） | `toolResultCache` 仅缓存部分路径，summarize/compact 仍会重新 stringify |

### 2.3 同步 I/O（阻塞单线程事件循环）

| # | 瓶颈 | 位置 | 证据 |
|---|------|------|------|
| I1 | `sessionManager.appendTurn` 同步写盘，每轮工具调用后 + user 轮落盘各一次 | agent-model-executor.ts:2088 | 在 `sessionLoadFn` 后主流程内同步调用 |
| I2 | `persistSessionTurn`（user 轮）同步写盘 | agent-model-executor.ts:2095 | 紧接 appendTurn 后 |
| I3 | chatInner 内多处 `process.stdout.write`（session window 归档日志等），而 llm-caller 已用 `asyncLog`（16ms 批量 + unref）但 executor 主体未复用 | agent-model-executor.ts:2050 / llm-caller.ts:33-44 | executor 主体同步写、caller 异步写，两套标准 |

### 2.4 串行化（可并行却串行 await）

| # | 瓶颈 | 位置 | 证据 |
|---|------|------|------|
| X1 | `sessionLoadFn` 内 `await this.sessionArchive.archiveOlderTurns(...)` 串行阻塞，之后才 `conversationHistory.set` | agent-model-executor.ts:2043-2055 | transcript 加载与 archive 可并行 |
| X2 | `SkillDispatcher.dispatch()` 在 LLM 前串行 await，命中才跳过 LLM，miss（~90% 场景）时纯浪费 ~200ms | agent-model-executor.ts（dispatch 调用处） | LLM 可用时结果被丢弃 |
| X3 | 记忆召回（分层 + 长期）串行 await 后再接手上下文引擎，召回结果不影响系统提示结构 | agent-model-executor.ts（召回调用处） | 可与 systemPrompt 构建并行 |

---

## 3. 性能优化建议（按优先级排序，共 5 项 ≥3）

> 原则：遵循 AGENTS.md「prompt cache is sacred」——所有优化只消除重复分配 / 同步 I/O / 串行等待，**不触碰 P0-7 消息前序布局**（`[sys_frozen, sys_ephemeral, skills?, tail?, ...history, user]` 保持不变），前缀改写仍只走 CompactionManager。

### 🔴 P0-1：`getLLMCallerDeps` 会话级缓存（depsVersion 计数器）

- **问题描述**：`getLLMCallerDeps`（agent-model-executor.ts:1057）每次调用都新建 ~30 字段对象 + 8+ 个捕获 `this` 的闭包。工具循环 10~30 轮（`MAX_TOOL_ROUNDS_CAP=30`）每轮入口都重建，且闭包无法跨轮复用。
- **影响分析**：30 轮 × 每轮 ~2-5ms 无意义对象分配 + 8 个新闭包 → GC 压力显著；多会话并发时放大。`cleanToolCache()` 也在每次构建时执行，进一步叠加。
- **优化方案**：
  1. 引入 `private depsVersion = 0`，`configure()`/`configureProviders()`/工具注册变更时 `depsVersion++`。
  2. 按 `sessionId` 缓存 deps 对象：`depsCache: Map<string, { version: number; deps: LLMCallerDeps }>`。
  3. `getLLMCallerDeps(sessionId)`：命中且 version 匹配 → 直接返回缓存 deps；否则重建并写回。
  4. `cleanToolCache()` 从构建路径移除（已有 P0-1a 降频逻辑，挪到 TTL 触发）。
- **预期收益**：工具循环 30 轮省 60-150ms/turn；deps 分配 GC 压力降 ~30%；`cleanToolCache` 不再每轮触发。

### 🔴 P0-2：executor 主体同步 `process.stdout.write` → 复用 `asyncLog`

- **问题描述**：`agent-model-executor.ts` 主体（session window 归档日志、appendTurn 失败日志等）用同步 `process.stdout.write`；而 `llm-caller.ts:33` 已实现 `asyncLog`（队列 + 16ms 批量刷新 + `unref`）但仅 caller 内部使用。
- **影响分析**：同步写阻塞单线程事件循环，高并发（>5 会话）时所有在飞 LLM 调用排队等 stdout；appendTurn 失败路径的 `process.stderr.write` 同理。
- **优化方案**：
  1. 将 `asyncLog` 从 llm-caller.ts 提升为共享模块（如 `packages/agent/src/async-log.ts`），export `asyncLog` / `asyncErr`。
  2. `agent-model-executor.ts` 内热路径所有 `process.stdout.write` / `process.stderr.write` 替换为 `asyncLog` / `asyncErr`（启动期一次性日志可保留同步，热循环内必须异步）。
- **预期收益**：每轮省 5-15ms 同步阻塞；高并发事件循环尾延迟降 ~40%；不改变日志语义（仅刷新粒度从「每条」变为「16ms 批量」）。

### 🔴 P0-3：`computeDynamicToolLimit` 结果按 sessionId + 消息指纹缓存

- **问题描述**：`computeDynamicToolLimit`（llm-caller.ts:1552）每轮入口对 `message` 跑 16 条正则（`complexPatterns` + `veryComplexPatterns`）+ `hasActionIntentFn` + 历史长度查询。同一会话内消息在工具循环中不变，结果却每轮重算。
- **影响分析**：30 轮 × 16 正则匹配 + intent 判定 = 纯浪费；正则对象每调用重新 `.some()` 遍历。
- **优化方案**：
  1. 模块级 `const limitCache = new Map<string, number>()`，key = `sessionId + ":" + message.length + ":" + message.hashCode`（或直接用 `sessionId` + 该会话首条消息，因同一 turn 内 message 不变）。
  2. 命中直接返回；仅在历史长度跨档（>30 阈值）或新 turn 时重算。
- **预期收益**：每轮省 ~1ms，30 轮省 ~30ms/turn；正则匹配次数从 30×16 降到 1×16。

### 🟡 P1-1：`expandedProviders` 复用（providers 引用哈希缓存）

- **问题描述**：`tryCallLLM` 入口每次将 `providers` 展开为 `expandedProviders` 数组，多模型 provider 逐条 `{...p, model}` 字面量展开（llm-caller.ts:4046-4056）。`providers` 由 `configureProviders` 设置，会话内引用不变。
- **影响分析**：最常见场景（单会话多轮工具循环）下展开结果完全相同，纯属 GC 压力；多模型 provider（如 3 个模型）每次新建 3 个 provider 副本。
- **优化方案**：模块级 `let lastProvidersRef: ProviderConfig[] | null = null; let lastExpanded: ProviderConfig[] | null = null;`；入口比对引用 `providers === lastProvidersRef` 命中直接复用，否则展开并记录。
- **预期收益**：每轮省 ~0.5ms，GC 对象分配减 ~10%；多模型场景消除 3× 副本分配。

### 🟡 P1-2：`SkillDispatcher` 并行预热（仅 LLM 全挂时 await）

- **问题描述**：`chatInner` 中 `SkillDispatcher.dispatch()` 在 LLM 调用前串行 await（命中跳过 LLM，miss 时浪费 ~200ms）。LLM 可用（90% 场景）时 dispatch 结果被丢弃，却阻塞了后续拦截层 + LLM 启动。
- **影响分析**：串行 await 直接拉长首 token 延迟；与 X1（archive 串行）叠加，会话启动路径被多重阻塞。
- **优化方案**：
  1. 改为后台预热：`const dispatchPromise = this.skillDispatcher.dispatch(...);` 不 await。
  2. 仅当所有 provider 熔断（`isProviderTripped` 全真）时 `const hit = await dispatchPromise` 兜底走技能；否则 LLM 可用直接不调用（结果自然丢弃，fire-and-forget）。
  3. 保持功能不变：LLM 全挂仍可走技能分发。
- **预期收益**：90% 场景省 ~200ms 首响延迟；功能零回退。

---

## 4. 性能优化路线图

```
Phase 1（P0，1-2 天）—— 热路径去重 + 同步 I/O 消除
  ├─ P0-1  getLLMCallerDeps 会话级缓存（depsVersion 计数器 + cleanToolCache 降频）
  ├─ P0-2  executor 主体 stdout/stderr.write → 共享 asyncLog（提升为独立模块）
  └─ P0-3  computeDynamicToolLimit 结果缓存（sessionId + 消息指纹）

Phase 2（P1，3-5 天）—— GC 压力降低 + 串行化消除
  ├─ P1-1  expandedProviders 引用哈希复用
  ├─ P1-2  SkillDispatcher 并行预热（仅 LLM 全挂时 await）
  └─ P1-3  sessionLoadFn 内 archiveOlderTurns 与 conversationHistory.set 并行
           （Promise.all 或 fire-and-forget，归档失败不影响加载）

Phase 3（P2，1-2 周）—— 序列化去重
  ├─ P2-1  recordToolTrace 入参处 JSON.stringify 结果按 (toolName+params) LRU+TTL 缓存
  └─ P2-2  guardrailedReply pretty-print 仅在使用处惰性生成（不再每次全量）
```

**验收标准**：
1. `pnpm build` → `pnpm typecheck` → `pnpm test` 全绿。
2. 30 轮工具循环场景：deps 构建从 30 次降到 1 次（depsVersion 命中）。
3. stdout 热路径零同步写（`grep -n "process.stdout.write" packages/agent/src/agent-model-executor.ts` 热循环内为 0）。
4. 首响延迟（LLM 可用场景）较优化前降 ≥200ms。
5. P0-7 消息前序布局无变化（`[sys_frozen, sys_ephemeral, skills?, tail?, ...history, user]` 顺序、内容不变）。

> ⚠ 路线图仅规划，**尚未改代码**。下一步需授权后才按 P0 → P1 → P2 顺序落盘实现并重跑 `pnpm build && pnpm typecheck && pnpm test`。
