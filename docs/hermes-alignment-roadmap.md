# EvoClaw 对标 Hermes Agent 提升方案（项目基线）

> 制定日期：2026-10-12。本文件是 v0.93+ 迭代的主线参考；完成一项后更新状态列。
> 对标对象：Hermes Agent v0.21.6（Nous Research，Python）。
> EvoClaw 当前基线：v0.92.1，21.3 万行 TS，1131 源文件，239 测试文件 / 6077 用例。

## 一、项目定位

EvoClaw 是 Hermes Agent 的 TypeScript 移植 + 增强演进版（证据：`packages/agent/src/llm-caller.ts` 20+ 处「借鉴 hermes-agent」注释、`skill-curator.ts` 引用 curator.py「永不删除仅归档」不变量、技能市场走 ClawHub 兼容协议）。

EvoClaw 借鉴基线停留在 Hermes v0.11~v0.12 时期，而 Hermes 主干已演进到 v0.21.6——中间隔着 v0.13→v0.21 约 9 个版本的产品化浪潮（Bot Mode 产品化、语音、出站 webhook、用户辩证建模、grounded research、serverless 后端、subagent mid-flight steering）。EvoClaw 的工程内核质量（类型安全、测试完备、原子写、跨进程锁）优于 Hermes 早期版本，但产品化能力落后。

## 二、差距速查

| 能力域 | Hermes v0.21.6 | EvoClaw 现状 |
|---|---|---|
| 迭代预算/凭证池/Curator 归档 | 产品化 | ✅ 已移植 |
| 迭代退款 execute_code | 已有 | ✅ 已移植 |
| A2A 智能体互通 | v1.0 | ✅ server/client + card |
| 多智能体群聊 | Bot Mode（命名社会/头像/@mention/常驻会话） | ⚠️ 仅底层 GroupChat 引擎 |
| FTS5 会话检索 | 有 | ✅ session-fts-search |
| RL 训练/轨迹导出 | Atropos 集成 | ⚠️ 仅 trajectory export |
| 语音（流式 TTS/barge-in/唤醒词） | v0.20 旗舰 | ❌ 无 |
| 签名出站 Webhook | v0.20 新增 | ❌ 无 |
| Honcho dialectic 用户建模 | 学习闭环核心 | ❌ 无 |
| grounded research（可验证引用+事实核查） | v0.20 新增 | ❌ 无 |
| Bot Mode 产品化 | 默认捆绑 | ❌ 无 |
| Cron 运行间学习 | v0.21 新增 | ⚠️ 有 cron 无学习闭环 |
| Subagent mid-flight steering | v0.21 新增 | ❌ 无 |
| MCP 指挥中心 | v0.21 强化 | ⚠️ 被动接入 + 投毒扫描 |
| 7 终端后端（SSH/Daytona/Modal/Serverless） | 支持 | ⚠️ 仅 DockerSandbox |
| agentskills.io 公开标准 | 官方标准 | ❌ 仅 OpenClaw 私标 |

## 三、优先级路线图

### P0 — 稳定与信任（✅ 已落地 2026-10-12）

- [x] **files 恒空欠账**：`file_create`/`file_modify` 工具成功结果提取 path/size/workspaceRelative 写入 `createdFiles`，前端下载链接恢复出现。
- [x] **token 事件体积欠账**：token/status-generating 事件默认只带 delta 增量，不再塞全量累积 reply（`includeAccumulatedReplyInTokenEvents` 开关保留旧客户端语义）；WebChatPage 按字段存在与否自动分流全量/增量渲染。
- [x] **类型契约防回归测试**：`packages/gateway/src/protocol-adapter-contract.test.ts`（6 用例）守住 `done` 事件 `contextLimit`/`contextLimitSource`/`contextTokensEstimated`/`thinkingSteps` 四字段可达 + `files` 非空回归；`resolveContextLimit` 已导出供测试直接断言。
- [x] **成功/失败计数单一事实源**：v0.92.1 已把判定收敛到 `executeSingleToolCall` 单点（语义失败只记一条 `ok:false` 且不累加成功数；硬失败进 `failedTools` 且 `ok:false`）；`packages/agent/src/completion-truthfulness.test.ts` 新增「一次调用至多一个终态」回归守护（3 用例），锁定互斥不变量。

### P1 — 架构对齐 Hermes 最新（把"有引擎"变成"有产品"）

- [x] **Bot Mode 产品化**：命名智能体社会——agent profile 绑定独立 model/memory/skills/头像/常驻会话 + 群聊房间 + `@mention` 编排（底层 GroupChat 已有）。
- [x] **Subagent mid-flight steering**：运行中下发指令重定向（对标 v0.21）。
- [x] **Cron 运行间学习闭环**：激活闲置的 `RunLogStore`（每次 cron 运行落 SQLite 持久 runId）；`MemoryHub.rememberCronRun`/`recallCronRuns` 把运行结果按 procedural 层入长期记忆（失败 importance 更高、TTL 30 天对齐归档不变量），下次 task 前拉最近 N 次注入 context；`job:error` 另发 `TASK_FAILED`（source: "cron"）复用 EvolutionEngine 既有 LearningJournal 通道。
- [x] **MCP 指挥中心**：工具过滤/动态挂载/路由仪表盘。

### P2 — 新特性拓展（补齐 v0.20+ 新战场）

- [x] **语音模式**：流式 TTS + barge-in 打断 + 本地唤醒词。
- [x] **签名出站 Webhook**：任务完成/审批/告警事件推送到外部系统。
- [ ] **Honcho dialectic 用户建模**：跨会话辩证用户建模层（叠加在现有分层记忆上）。
- [ ] **grounded research**：web 检索 + 可验证引用 + 事实核查。
- [ ] **agentskills.io 公开标准兼容**：OpenClaw 私标之外增加公开标准支持。
- [ ] **Programmatic Tool Calling / execute_code 产品化**：多步工具流水线折叠为单次推理调用。

### P3 — 可观测与分发

- [ ] **Curator 完整报告链路**：后台 cron 代理 + `logs/curator/run.json` + `REPORT.md` + consolidated-vs-pruned 分类。
- [ ] **7 终端后端 / serverless**：SSH/Daytona/Modal/Vercel Sandbox 之外补闲置近零成本。
- [ ] **发布流水线**：stable release pipeline（one attempt ref + 测试镜像 + receipt tag）。

## 四、代码级设计方案（P1 四项 + P2 语音/Webhook）

> 基于 2026-10-12 代码勘察（GroupChat/AgentRouter/SubagentRegistry/CronScheduler/MCPClientManager）。
> 每项给出：改动文件、新增/扩展的类型与 API、关键接线点、风险与回退。

### P1-1 Bot Mode 产品化（命名智能体社会 + 房间 + @mention）

**现状**：`GroupChat`（`multi-agent-patterns.ts:177`）是无状态一次性 `run()`，零生产调用方；
`AgentRouter.AgentConfig`（`agent-router.ts:41`）已有 persona/model/provider/toolPolicy/workspace 隔离，
但缺 skills 绑定/avatar/memory store 字段，且 server 只注册 1 个 default agent、路由未接消息流；
`ChannelMessage`（`channel-manager.ts:49`）已有 `isGroup`/`groupId`/`replyTo`，但 server handler（`index.ts:888`）
把群消息静默丢弃。

**改动**：

1. **扩展 `AgentConfig`**（`packages/agent/src/agent-router.ts:41`）加 3 个字段：
   ```ts
   avatar?: string;               // 头像 URL 或 data URI
   memoryStoreId?: string;        // 绑定 MemoryHub 的命名空间（L0-L3 分层记忆隔离）
   allowedSkills?: string[];      // 该 agent 可见的 skill slug 白名单
   ```
   `AgentRouter` 构造 `SystemPrompt` 时把 `allowedSkills` 传给 `buildSkillsPromptForRun`（已存在该钩子）。

2. **新增 `Room` 实体**（新文件 `packages/agent/src/room-manager.ts`）：
   ```ts
   interface Room {
     id: string;
     channel: string;         // 挂在哪条 channel
     groupId: string;         // ChannelMessage.groupId
     agentIds: string[];      // 成员（引用 AgentConfig.id）
     history: ChatTurn[];     // 复用 GroupChat.ChatResult.turns 的 shape
     selectorFn?: SelectorFn; // @mention 命中者优先，否则轮询
   }
   class RoomManager {
     createRoom(room: Omit<Room,"id"|"history">): Room;
     resolveSpeaker(roomId: string, message: { text: string; from: string }): string | null;
       // 先解析 @agentName → 命中成员 agentId；未命中走 selectorFn
     appendTurn(roomId: string, turn: ChatTurn): void;
     // 持久化：atomicWriteFile → data/rooms/{id}.json（遵守 AGENTS.md 原子写约束）
   }
   ```

3. **接线 server handler**（`apps/server/src/index.ts:888`）：
   - 现在：`msg.isGroup` 直接丢弃。改为：`msg.isGroup` → `roomManager.getRoomByGroup(msg.channel, msg.groupId)`；
     命中 → `roomManager.resolveSpeaker()` 取目标 agent → 用该 agent 的 `AgentConfig`（model/persona/sessionsDir/
     allowedSkills）调 `agentModelExecutor.chat()`，回复经 `channelManager.sendMessage(channel, groupId, text)` 回群
     （该 API 已存在 `channel-manager.ts:312`）。
   - 未命中房间 → 维持现有 default agent 行为（向后兼容）。

4. **@mention 解析**：`reply-reference.ts:354` 的 `detectMention` 只做 quote 检测，新增
   `parseAgentMentions(text, room.agentIds): string[]`（正则 `@(\w+)` 匹配成员名/ id），
   结果喂给 `resolveSpeaker` 作 selectorFn 输入。

5. **头像**：`GatewayServer.avatarConfig`（`gateway-server.ts:73`）现为 `{user, bot}` 两张，
   扩展为 `botByAgent: Record<agentId, string>`，`GET /api/config/avatars` 端点加 agentId 参数。

**风险**：双 schema（core `Agent` vs `AgentRouter.AgentConfig`）不合并，Bot Mode 只用后者，
池 worker 维持匿名——避免牵动 6.8 万行的 agent 包核心。
回退：`msg.isGroup` 路由开关用 feature flag（`FeatureFlagStore`），关掉即恢复群消息丢弃。

### P1-2 Subagent 实时操控（mid-flight steering）

**现状**：`SubagentRegistry.kill()`（`subagent-registry.ts:233`）只删 Map entry，无 abort 信号；
真正的取消在 `BackgroundDelegator`（`background-delegator.ts:237` `cancel` → `abortController.abort()`）。
二者未打通。

**改动**：

1. **`SubagentInfo` 加引用**（`subagent-registry.ts:38`）：
   ```ts
   steerChannel?: { push(instruction: string): void; abort(): void };
   ```
   spawn 时由调用方（`TaskOrchestrator`/`BackgroundDelegator`）注入。

2. **新增 `steer(id, instruction)`**：
   - 语义 = 不杀任务，把 instruction 追加进该 subagent 的 prompt 队列（下一轮 LLM 调用可见）。
   - 若需硬转向，暴露 `steer(id, instruction, {hard:true})` → 触发 `abortChannel.abort()` + 携带 instruction
     重新 spawn（复用 `SubagentConfig` 的 metadata 把 instruction 带回去）。

3. **接线 `BackgroundDelegator`**（`background-delegator.ts`）：`BackgroundTask` 已有
   `abortController`（L241），在其 prompt 组装点（L284 `fn(task.description, signal)`）
   增加 `task.pendingInstructions: string[]` 队列，`steer` 写入，下一轮取出拼进 user message。

4. **EventBus**：新增 `subagent.steer` 事件（对齐现有 `subagent.{spawn|complete|error|kill|cleanup}`），
   前端/SSE 可实时看到"操控了子代理"。

**风险**：prompt 队列若跨轮拼接需遵守"不改历史"的 prompt-cache 约束——instruction 只进**下一轮新增**
的 user message，不重写已缓存前缀。

### P1-3 Cron 运行间学习闭环

**现状**：`CronScheduler.executeJob`（`cron-scheduler.ts:492`）产出 `CronExecutionRecord`
（jobId/sessionId/result/duration/error），history 仅内存 1000 条；
`RunLogStore`（`run-log-store.ts:208` SQLite）已存在但**无人调用**（只有测试接线）；
server 侧（`index.ts:348-356`）对 `job:*` 只打日志。`MemoryHub.remember()`（`memory-hub.ts:590`）
与 `EvolutionEngine.subscribeToEvents()`（`evolution-engine.ts:174`）都是现成消费面。

**改动**：

1. **激活 `RunLogStore`**：在 `executeJob` 的 complete/error 处调 `runLogStore.startRun` / `completeRun`
   （现在只有测试调它），让每次 cron 运行有持久化 runId。

2. **学习闭环**（`apps/server/src/index.ts:348`）：
   ```ts
   // job:complete / job:error 处理处
   memoryHub.remember({ type: "cron_result", metadata: { jobId, runId, result, duration } });
   if (failed) eventBus.publish(SystemEvents.TASK_FAILED, { source: "cron", jobId, error });
   ```
   `EvolutionEngine` 已订阅 `TASK_FAILED`，会自动走 `LearningJournal.recordLearning`。

3. **注入下一轮**：`job.tasks` 已带 `agentId`；在 cron 触发下一次 `task` 前，
   从 `memoryHub` 拉该 jobId 的最近 N 条 `cron_result`，拼进 task 的 context（"上次运行结果…"），
   实现 run-to-run 继承。

4. **新增事件常量**（`packages/core/src/types/event.ts`）：`CRON_RUN_COMPLETED`，
   供未来更细粒度订阅（当前先用 `TASK_FAILED` 兜底）。

**风险**：`cron_result` 进记忆库可能膨胀，需给 memory 条目加 TTL/淘汰（与 SkillCurator 归档不变量对齐，
只 archive 不 delete）。

### P1-4 MCP 指挥中心

**现状**：`MCPClientManager.registerServerTools`（`mcp-client-manager.ts:206`）连接后**无条件注册全部**
discovered tools（前缀 `mcp__<server>__<tool>`），无 allow/deny、无 per-agent scope；
`unregisterServerTools` 只按整 server 粗粒度卸载。`MCPToolPoisoningScanner.scan()`
（`mcp-poisoning-scanner.ts:232`）的结果**没有**反馈进注册门。executor 侧
`registerTool`/`unregisterTool`（`agent-model-executor.ts:1065`）已有 `checkFn?: () => boolean`
（AGENTS.md 的 service-gated 模式）可作动态挂载钩子。

**改动**：

1. **`ExternalMCPServerConfig` 加工具级过滤**（`mcp-client-transport.ts`）：
   ```ts
   toolFilter?: { mode: "allowlist" | "denylist"; tools: string[] };
   perAgent?: Record<agentId, { allow?: string[]; deny?: string[] }>;
   ```
   `registerServerTools` 注册前先过 `toolFilter` + 该 agent 的 `perAgent` 规则。

2. **投毒门**：注册前对每个 tool 调 `MCPToolPoisoningScanner.scan()`，高分（恶意描述）的 tool
   默认拒绝，写进 audit。

3. **动态挂载**：用 `checkFn` 实现 `toggleTool(server, tool, enabled)`（对齐 `addServer`/`removeServer`
   `mcp-client-manager.ts:316/332`），toggle 只改 checkFn 的判定，不重新注册（避免破坏 toolset 缓存）。

4. **仪表盘**：读 `listServers()`（`mcp-client-manager.ts:283`）+ 新 tool-level toggle 状态，
   加 `/api/mcp/dashboard` 端点。

**风险**：toolFilter 改动注册集合会触发 prompt-cache 失效——按 AGENTS.md 走"延迟失效"
（下一会话生效，`--now` 立即），不中途改当前会话的工具集。

### P2-1 语音模式（流式 TTS + barge-in + 唤醒词）

**现状**：完全空白。但 web-ui 已有渲染管道，gateway 已有 SSE。
`packages/web-ui/src/useVoice.test.ts` 存在（说明语音 hook 有骨架但未接 TTS 流）。

**改动**（按"扩展已有代码优先"）：
1. 新 `packages/infrastructure/src/tts-stream.ts`：封装 TTS endpoint（自建 / Nous Portal），
   产出 Web Audio 可消费的 chunk 流。
2. gateway 加 `POST /api/voice/tts`（SSE 推 audio chunk）+ `POST /api/voice/barge-in`
   （前端检测到用户开口即调，abort 正在播的 TTS stream）。
3. 唤醒词：本地 web worker 跑轻量 VAD（不在核心包加模型，走 plugin）。
4. web-ui `useVoice` hook 接上面三个端点。

**风险**：TTS 模型/endpoint 是外部依赖，走 plugin/service-gated（`checkFn`），缺 key 时功能降级不报错。

### P2-2 签名出站 Webhook

**现状**：完全空白。`EventBus`（`packages/core/src/event-bus.ts:7`）已能 subscribe 全局事件。

**改动**：
1. 新 `packages/infrastructure/src/webhook-emitter.ts`：
   - 配置存 `data/webhooks.json`（atomicWriteFile）。
   - 订阅 `task.completed` / `approval.requested` / `system.alert` 等事件。
   - 出站用 `HMAC-SHA256` 签名（`x-evoclaw-signature` 头）+ 可选 Bearer token。
2. `apps/server/src/index.ts` 实例化并注册，配置端点 `POST /api/webhooks`。

**风险**：出站 = 把内部事件推给外部系统，须走 `SecurityGovernor` 的 URL 白名单（防 SSRF，
已有 SSRF 检测可复用），签名密钥存 .env 不入库。

## 五、设计原则约束（继承 AGENTS.md）

- Prompt cache 神圣：任何改动系统提示/工具集的方案须走「延迟失效」或 compaction 例外。
- 窄腰 + 边缘能力：新能力优先落为「扩展已有代码 → CLI+skill → service-gated tool → plugin → MCP → 新核心工具」顺序。
- 原子写 + CrossProcessLock：任何新增持久化状态必须用 `atomicWriteFile`。
- Never delete; archive：Curator 相关改动不得破坏归档不变量。
- 中文注释/文档。

## 六、关键代码索引

| 模块 | 位置 |
|---|---|
| 任务主链路 | `/api/chat` → `protocol-adapter.ts` → `agent-model-executor.ts` → `llm-caller.ts` → 工具执行 → 会话落盘 → SSE → WebChatPage |
| 文件下载路由 | `protocol-adapter.ts` `GET /api/files/download/*`（workspace-relative，`..` 拦截 + 边界校验） |
| 文件工具 | `apps/server/src/tools/file-tools.ts`（file_create/file_modify 结果含 path/size/workspaceRelative，经 errRecovery 剥掉 success 透传） |
| 群聊引擎 | `packages/agent/src` GroupChat（Bot Mode 产品化的地基） |
| 思考轨迹 | `llm-caller.ts` `ThinkingTrace` + `traceSnapshot`（按 trace 隔离的 WeakMap 节流，2026-10-11 修过并发串扰） |
| 前端渲染 | `packages/web-ui/src/WebChatPage.tsx`（全量/增量双路径，`message-bubbles.ts` applyRoundContent） |
| 命名智能体路由 | `packages/agent/src/agent-router.ts`（AgentConfig/AgentBinding/resolveRoute，Bot Mode 地基） |
| 子代理注册 | `packages/agent/src/subagent-registry.ts` + `background-delegator.ts`（真实 abortController，steer 插桩点） |
| Cron 学习闭环 | `packages/scheduler/src/cron-scheduler.ts` + `run-log-store.ts`（已存在未接线）+ `memory-hub.ts`/`evolution-engine.ts` 消费面 |
| MCP 指挥中心 | `packages/gateway/src/mcp-client-manager.ts` + `mcp-client-transport.ts`（工具级过滤插入点）+ `mcp-poisoning-scanner.ts` |
