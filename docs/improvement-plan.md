# EvoClaw 6 轮迭代改进计划

> 基于对 hermes-agent (D:\\abc\\hermes\\hermes-agent) 的系统性对比分析，结合 EvoClaw 当前代码现状，制定本改进计划。
> 每轮改进保持 EvoClaw 的核心特色与技术风格，不直接照搬 hermes 代码，仅借鉴其工程实践与产品思路。

---

## 一、分析结论

### 1.1 hermes 的关键借鉴点

| 维度 | hermes 实践 | EvoClaw 现状 |
|------|-------------|--------------|
| 可靠性工程 | 统一超时、重试、熔断；provider 健康评估 | 已实现基础 failover 与安全拒绝检测，但超时覆盖不完整、熔断策略较简单 |
| 资源治理 | Agent 生命周期管理、优雅关闭、健康检查 | AgentPool 缺少清理、健康评估、优雅释放 |
| 网关运维 | `/healthz` 多子系统健康、优雅关闭 | Gateway 有基础接口，但缺少深度健康聚合 |
| 配置管理 | 配置驱动、热加载 | 配置更新后无法广播到订阅服务 |
| 会话管理 | 持久化、压缩、跨会话搜索 | 已支持 FTS5，但会话写操作非并发安全、缺少压缩/用量洞察 |
| 前端体验 | TUI、错误边界、全局状态 | Web UI 状态分散、错误边界有限 |

### 1.2 优先改进的 6 大问题

1. **LLM Caller 超时与熔断不完善** — 高负载或网络抖动时可能永久挂起或频繁 failover。
2. **Agent Pool 资源管理缺失** — 无健康检查、无优雅清理、重复释放可能引发状态冲突。
3. **Gateway Server 健康检查深度不足** — 无法反映子系统真实状态，优雅关闭可能残留句柄。
4. **配置变更无法热加载广播** — 修改配置后必须重启服务才能生效。
5. **会话持久化并发写风险** — `appendFileSync` 在高并发下可能阻塞或丢失数据。
6. **Web UI 全局状态与错误处理薄弱** — 状态分散、删除无回滚、API 错误无统一处理。

---

## 二、6 轮迭代计划

### Round 1：LLM Caller 超时、重试与熔断健壮性提升

**改进目标**
- 为所有 LLM HTTP 请求增加统一、可配置的超时保护。
- 完善 provider 健康度评估（失败率、平均响应时间、连续错误数）。
- 增强安全拒绝/内容过滤检测后的降级策略。

**实施步骤**
1. 在 `llm-caller.ts` 的 `nativeFetch` 中增加 `timeout` 参数与超时计时器，确保请求阶段、连接阶段均有保护。
2. 扩展 provider 故障追踪器，记录每次调用的耗时、结果、错误类型。
3. 实现基于错误率/连续失败的熔断升级策略。
4. 为 `callLLMOnce` 增加调用时长指标，并暴露给后续路由决策。

**预期成果**
- LLM 调用在配置超时内必定返回或抛出可控错误。
- Provider 选择更加智能，避免反复踩到已熔断的 provider。
- 新增/更新的单元测试覆盖超时、熔断、失败率阈值。

**验收标准**
- `pnpm test` 中 `llm-caller` 相关测试全部通过。
- 新增至少 3 个测试：超时触发、熔断触发、安全拒绝后降级。

---

### Round 2：Agent Pool 生命周期与资源治理

**改进目标**
- 为 Agent 增加健康心跳、状态机、优雅清理能力。
- 防止重复释放/重用已终止的 Agent。
- 提供池级指标（空闲数、忙碌数、健康数）。

**实施步骤**
1. 在 `agent-pool.ts` 中引入 `AgentState` 状态机：`idle | busy | terminating | terminated`。
2. `release()` 增加状态校验，拒绝释放非 busy 或已 terminated 的 Agent。
3. 增加 `cleanup()` 定期扫描并移除长期无心跳或错误数过高的 Agent。
4. 暴露 `getMetrics()` 返回池级实时指标。

**预期成果**
- Agent 资源不再泄露或进入不一致状态。
- 系统可观测性提升，便于后续扩缩容。

**验收标准**
- `agent-pool.test.ts` 新增/更新测试通过。
- 重复释放、心跳过期清理、指标读取均有测试覆盖。

---

### Round 3：Gateway Server 健康检查与优雅关闭

**改进目标**
- 提供聚合多子系统状态的健康检查端点。
- 确保 Gateway 关闭时释放所有连接、定时器、监听器。

**实施步骤**
1. 在 `gateway-server.ts` 中定义 `HealthStatus` 聚合结构，包含 HTTP server、WebSocket、channel adapters、plugin adapter 状态。
2. `/health` 端点返回结构化健康报告，区分 `healthy/degraded/unhealthy`。
3. `stop()` 方法按依赖顺序关闭：adapters → WebSocket → HTTP server → 清理定时器/句柄。
4. 增加关闭超时保护，避免子系统 hang 住导致整体无法退出。

**预期成果**
- 运维可通过 `/health` 快速定位故障子系统。
- 服务重启/升级时资源完全释放。

**验收标准**
- `gateway-server.test.ts` 通过健康检查与优雅关闭测试。
- 无资源句柄泄漏警告。

---

### Round 4：配置热加载与变更广播机制

**改进目标**
- 配置 `update()` 后能够通知所有订阅者。
- 新增配置字段校验，避免非法值写入。

**实施步骤**
1. 在 `packages/core/src/config.ts` 的 `ConfigManager` 中增加事件总线/订阅者列表。
2. `update()` 成功后按配置段（provider、gateway、agent 等）触发变更事件。
3. 对关键数值/枚举字段增加类型与范围校验。
4. 在 `agent-model-executor.ts` 和 `gateway-server.ts` 中监听并响应相关配置变更。

**预期成果**
- 修改 provider、timeout 等配置后无需重启即可生效。
- 非法配置会被拒绝并返回明确错误。

**验收标准**
- `config.test.ts` 新增订阅、热加载、非法值拒绝测试并全部通过。

---

### Round 5：会话持久化并发安全与压缩洞察

**改进目标**
- 将会话追加写改为原子写，避免并发冲突与数据丢失。
- 提供基于 token 数/消息数的会话压缩与用量洞察。

**实施步骤**
1. 在 `session-persistence.ts` 中用 `writeFileSync` + 临时文件 + `rename` 替换 `appendFileSync`。
2. 增加文件锁或基于内存队列的串行化写入。
3. 新增 `getSessionInsights(sessionId)`，返回消息数、token 估算、最后活跃时间。
4. 当会话超过阈值时，触发摘要压缩，保留关键上下文。

**预期成果**
- 高并发会话写操作安全。
- 用户/运维可查看会话用量与压缩状态。

**验收标准**
- `session-persistence.test.ts` 通过并发写、压缩、洞察测试。

---

### Round 6：Web UI 全局状态与错误边界

**改进目标**
- 引入轻量级全局状态管理，减少组件间 prop drilling。
- 统一 API 错误处理与加载状态。
- 为会话删除等操作提供乐观更新与回滚。

**实施步骤**
1. 在 `web-ui/src` 新增 `AppContext` / `AppProvider`，集中管理 session、theme、notification。
2. 在 `App.tsx` 中接入全局错误处理与加载遮罩。
3. 会话删除改为乐观更新：先更新 UI，失败则回滚并提示。
4. 为网络/API 错误增加统一 toast/notification。

**预期成果**
- 前端代码更可维护，用户体验更稳定。
- 误删操作可恢复，网络错误有明确反馈。

**验收标准**
- `web-ui` 构建通过 (`pnpm --filter @evoclaw/web-ui build`)。
- 新增/更新的前端测试（若有）通过。

---

## 三、测试与验收策略

每轮完成后必须执行：

```bash
pnpm build
pnpm typecheck
pnpm test
pnpm --filter @evoclaw/web-ui build   # Round 6 及涉及前端时
```

全部通过后方可进入下一轮。

---

## 四、执行记录

### Round 1：LLM Caller 超时、重试与熔断健壮性提升 ✅

**执行时间**：2026-06-20

**实际修改文件**：
- `packages/agent/src/llm-caller.ts`
  - `nativeFetch` 新增 `timeout` 选项，内部使用 AbortController 强制超时，错误信息统一为 `Request timeout after ${ms}ms`
  - 新增并导出 `ProviderHealthTracker` 类，支持连续失败计数、总成功/失败数、平均响应时间、熔断冷却、快照查询
  - 移除旧版基于简单计数器的 provider 熔断器，统一使用 `ProviderHealthTracker`
  - `CallLLMOnceResult` 与 `ParseStreamingResponseResult` 新增 `responseMs` 字段
  - `callLLMOnce` / `parseStreamingResponse` 记录调用耗时并透传给健康追踪器
- `packages/agent/src/llm-caller.test.ts`
  - 新增 `nativeFetch` 超时测试（慢请求被中断、快请求正常通过）
  - 新增 `ProviderHealthTracker` 单元测试（连续成功重置、冷却恢复、统计、reset）

**测试结果**：
```bash
pnpm build && pnpm typecheck && pnpm test
```
全部通过：106 个测试文件 / 2903 通过 / 1 跳过。

**遇到的问题与解决方案**：
- 问题：旧版 provider 熔断器与新 `ProviderHealthTracker` 并存导致重复函数定义。
  解决：删除旧版 `providerFailureTracker` 及配套函数。
- 问题：`callStart` 变量在 `try` 块内声明，`catch` 块无法访问。
  解决：将 `callStart` 提前到 `try` 之前声明。
- 问题：`nativeFetch` 超时测试触发 `socket hang up` 而非预期超时错误。
  解决：在 `req.on("error")` 中根据 `timedOut` 标志统一抛出 `Request timeout after ${ms}ms`。

**经验总结**：
- 连接阶段超时（TCP/TLS 握手）需要独立于 AbortSignal 实现，不能仅依赖调用方的 controller。
- 熔断器应暴露结构化健康快照，便于后续 provider 排序和运维监控。

### Round 2：Agent Pool 生命周期与资源治理 ✅

**执行时间**：2026-06-20

**实际修改文件**：
- `packages/agent/src/agent-pool.ts`
  - 增加 `heartbeatTimeoutMs` 与 `maxErrorCount` 配置
  - `acquire()` 跳过 `error` / `terminated` / `awaiting_input` 状态的 Agent
  - `release()` 增加状态校验，非 `busy` 状态释放会被忽略并记录警告
  - 新增 `reportError()`，错误数超阈值后将 Agent 标记为 `error` 并发布事件
  - 新增 `cleanup()`，清理过期空闲 Agent 和不可用 Agent，同时保留最小运行基数
  - `healthCheck()` 增加心跳过期与错误数检测
- `packages/agent/src/agent-pool.test.ts`
  - 新增释放校验、错误状态跳过、cleanup、最小基数保护、健康检查增强等 6 个测试

**测试结果**：
```bash
pnpm build && pnpm typecheck && pnpm test
```
全部通过：106 个测试文件 / 2908 通过 / 1 跳过。

**遇到的问题与解决方案**：
- 无。实现与现有 `AgentStatus` 类型完全兼容。

**经验总结**：
- Agent 池的状态机校验应放在边界操作（acquire/release）上，而不是依赖调用方自觉遵守。
- cleanup 必须保留最小运行基数，避免在空闲时把 orchestrator/observer 也清理掉。

---

### Round 3：Gateway Server 健康检查与优雅关闭 ✅

**执行时间**：2026-06-20

**实际修改文件**：
- `packages/gateway/src/gateway-server.ts`
  - `GatewayConfig` 新增 `shutdownTimeoutMs` 配置项
  - 新增 `getAggregatedHealth()`，聚合 HTTP server、WebSocket、protocol handler、channel manager、MCP gateway、auth provider 子系统状态
  - `/health` 端点返回结构化健康报告，区分 `healthy/degraded/unhealthy`
  - `stop()` 按依赖顺序关闭：channel adapters → MCP gateway → WebSocket transport → protocol handler → HTTP server → 清理运行时状态
  - 新增 JWT secret 为空时自动生成临时随机 secret，避免测试/开发环境因未配置 JWT_SECRET 而崩溃
- `packages/gateway/src/mcp-gateway.ts`
  - 新增 `dispose()` 方法，清理已注册的 transports 与 capabilities
- `packages/gateway/src/ws-protocol.ts`
  - 新增 `stop()` 方法，关闭所有已连接客户端并清空内部状态
- `packages/gateway/src/gateway-server.test.ts`
  - 新增 `/health` 聚合健康检查测试、优雅启动/停止测试

**测试结果**：
```bash
pnpm build && pnpm typecheck && pnpm test
```
全部通过。

**遇到的问题与解决方案**：
- 问题：`gateway-server.ts` 的 `stop()` 调用 `this.mcpGateway?.dispose?.()` 与 `this.protocolHandler?.stop?.()`，但 `MCPGateway` 与 `ProtocolHandler` 未实现对应方法，导致 TypeScript 编译失败。
  解决：为 `MCPGateway` 添加 `dispose()`，为 `ProtocolHandler` 添加 `stop()`，完成优雅关闭链路。
- 问题：`gateway-server.test.ts` 中 `AuthProvider` 因 JWT secret 为空而抛错。
  解决：在 `GatewayServer` 构造函数中检测空 secret 并生成临时随机 secret，同时输出警告提示用户配置环境变量。

**经验总结**：
- 优雅关闭必须按依赖反序执行，并给每个阶段设置超时保护，防止子系统 hang 住导致进程无法退出。
- 健康检查应区分 `degraded` 与 `unhealthy`，便于负载均衡和运维做差异化处理。

---

### Round 4：配置热加载与变更广播机制 ✅

**执行时间**：2026-06-20

**实际修改文件**：
- `packages/core/src/config.ts`
  - `AppConfig.gateway` 补齐 `port`、`host`、`jwtSecret` 字段，与 `CONFIG_SCHEMA` 保持一致
  - 新增 `ConfigChange`、`ConfigChangeHandler`、`ConfigManagerStats` 类型
  - `ConfigManager` 内部引入 `EventEmitter`，支持 `onChange()` 订阅与 `emit("change:${section}")` 分段广播
  - `update()` / `updateSection()` / `set()` / `loadFromFile()` 均触发细粒度 `diffLeaves` 变更事件
  - 新增 `saveToFile()`，使用临时文件 + `renameSync` 实现原子写
  - 新增 `startWatching()` / `stopWatching()`，支持配置文件热加载
- `packages/core/src/config-schema.ts`
  - `ConfigWatcher` 支持 `forceReload()` 主动触发重载并回调变更
- `packages/core/src/config.test.ts`
  - 新增订阅回调、热加载、`set` 单值更新、非法值拒绝、统计信息测试

**测试结果**：
```bash
pnpm build && pnpm typecheck && pnpm test
```
全部通过。

**遇到的问题与解决方案**：
- 问题：`config.test.ts` 中 `manager.get("gateway").port` 编译报错，因为 `AppConfig.gateway` 接口缺少 `port`。
  解决：在 `AppConfig` 与 `defaultConfig` 中为 `gateway` 补齐 `port`、`host`、`jwtSecret`。
- 问题：`ConfigWatcher.forceReload()` 未触发变更回调，导致热加载测试失败。
  解决：调整 `forceReload()` 实现，确保读取文件后触发 `onConfigChange` 回调；`startWatching()` 启动时先执行一次 `forceReload()` 完成初始加载。

**经验总结**：
- 配置变更广播应细化到叶子节点（`gateway.port`、`llm.timeout` 等），订阅者才能精准重载，避免全量刷新。
- 配置文件写入必须原子化（temp + rename），防止进程崩溃或并发读导致半写文件。

---

### Round 5：会话持久化并发安全与压缩洞察 ✅

**执行时间**：2026-06-20

**实际修改文件**：
- `packages/agent/src/session-manager.ts`
  - `SessionLock` 增加 `reentrant` 与 `reentrantCount` 字段
  - `acquireLock()` / `releaseLock()` 支持同进程可重入，记录重入次数，防止过早释放
  - 关键会话操作（创建、追加消息、压缩、归档）自动获取锁，无需调用方手动加锁
  - 新增 `getSessionInsights(sessionId)`，返回 transcript 大小、turn 数、token 估算、平均每轮 token、压缩率
  - 新增 `getGlobalSessionInsights()`，汇总全体会话用量
- `packages/agent/src/session-manager.test.ts`
  - 新增可重入锁、并发写安全、insights 计算、全局 insights 测试

**测试结果**：
```bash
pnpm build && pnpm typecheck && pnpm test
```
全部通过。

**遇到的问题与解决方案**：
- 问题：可重入锁仅记录布尔值，嵌套调用时第一次 `releaseLock()` 就把锁释放，导致后续并发写冲突。
  解决：引入 `reentrantCount` 计数器，`acquireLock()` 递增，`releaseLock()` 递减到 0 才真正删除锁文件。

**经验总结**：
- 文件锁在单进程内的可重入场景必须用计数器，否则异步/嵌套调用极易引发竞态。
- 会话用量洞察应基于实际 transcript 字节数与 token 估算，便于运维触发压缩策略。

---

### Round 6：Web UI 全局状态与错误边界 ✅

**执行时间**：2026-06-20

**实际修改文件**：
- `packages/web-ui/src/app-state.ts`（新增）
  - 定义 `TabId`、`ConnectionStatus`、`AppState`、`AppAction`、`initialAppState`、`appStateReducer`
  - 集中管理 active tab、active session、连接状态、认证状态、全局错误
- `packages/web-ui/src/AppStateContext.tsx`（新增）
  - 提供 `AppStateProvider` 与 `useAppState()` Hook，消除 prop drilling
- `packages/web-ui/src/AppErrorBoundary.tsx`（新增）
  - 顶层 React 错误边界，捕获渲染错误并展示全屏降级 UI，支持重试/刷新
- `packages/web-ui/src/main.tsx`
  - 使用 `<AppErrorBoundary>` 包裹 `<AppStateProvider>` 与 `<App />`
- `packages/web-ui/src/App.tsx`
  - 将 `activeTab`、`activeSessionId`、`connectionStatus`、`authenticated`、`authChecked` 迁移至全局 context
  - 新增 `GlobalBanner` 组件，统一展示离线/连接中/全局错误提示
- `packages/web-ui/src/app-state.test.ts`（新增）
  - 覆盖所有 reducer action 的单元测试

**测试结果**：
```bash
pnpm build && pnpm typecheck && pnpm test
pnpm --filter @evoclaw/web-ui build
```
全部通过。

**遇到的问题与解决方案**：
- 问题：`App.tsx` 原代码在状态更新时使用函数式更新 `setActiveTab(prev => ...)`，迁移到 dispatch 后部分类型推断为 `any`。
  解决：直接使用当前 context state 值构造 dispatch action，避免函数式更新的隐式类型问题。

**经验总结**：
- 轻量级 useReducer + Context 足以支撑 EvoClaw Web UI 的跨组件状态，无需引入重量级状态库。
- 全局错误边界应置于最外层，并配合全局错误横幅，形成“兜底 + 提示”的双重保障。

---

## 五、最终交付

6 轮全部完成后：
1. 运行 `pnpm build && pnpm typecheck && pnpm test`
2. 更新 `package.json` 版本号
3. 更新 `History.md` 与 `README.md`
4. 重启服务器 `pnpm start`
5. 提交并推送 GitHub
