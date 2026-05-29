# EvoClaw 版本历史记录 (History)

> 本项目遵循语义化版本，记录每次代码修改、功能调整及系统变更的详细内容。
> 每次成功构建后更新此文件，按时间倒序排列。

---

## v0.8.0 (2026-05-29)

### 功能审计补齐 + 安全修复 + CI/CD 修复

- **文件**: `packages/core/src/config-lkg.ts`、`packages/infrastructure/src/ssh-sandbox.ts`、`packages/infrastructure/src/sandbox-manager.ts`、`packages/plugin-sdk/src/plugin-host.ts`、`packages/gateway/src/ws-server-transport.ts`、`packages/gateway/src/gateway-server.ts`、`packages/security/src/device-pairing-manager.ts`、`packages/core/src/config-schema.ts`、`packages/skills/src/skill-curator.ts`、`packages/gateway/src/protocol-adapter.ts`、`packages/gateway/src/webhook-manager.ts`、`packages/agent/src/model-failover.ts`

- **改动**:

  **Webhook 系统**
  - 新增 `IncomingWebhookManager`：支持 GitHub/Discord/Slack/Custom 四种 Webhook 来源
  - 签名验证：HMAC-SHA256 签名校验，防止伪造请求
  - 事件路由：基于 Webhook 事件类型自动路由到对应处理器
  - 重试机制：失败自动重试，指数退避，最多 3 次

  **模型故障转移增强**
  - `ModelFailover` 新增 Fallback Chain：主模型失败时自动切换到备选模型
  - Auth Rotation：API Key 轮换机制，避免单一 Key 限流
  - Health Scoring：基于成功率和响应时间的健康评分，智能选择最优 Provider

  **技能策展器 YAML 修复**
  - `SkillCurator` 生成 YAML frontmatter 时，`name` 和 `description` 值强制双引号包裹
  - 修复未引用值含冒号导致 YAML 解析失败的问题（如 `从任务解决方案中提取的技能: 版本历史测试`）

  **WebSocket Server Transport**
  - 新增 `WSServerTransport`：将 `ws` 库 WebSocket 连接桥接到 `ProtocolHandler` 的 `WSClient` 接口
  - 支持消息收发、心跳 ping/pong、连接关闭处理
  - 14 个单元测试全部通过

  **Gateway Server WebSocket 集成**
  - `GatewayServer` 新增 `enableWS` 配置选项
  - `registerWSMethodHandlers()`：注册 10 个 WebSocket 方法处理器（health、status、channels.list、channels.status、config.get、sessions.list、plugins.list、cron.list、agent、message.send）
  - 服务器启动时自动附加 WebSocket，停止时分离
  - 修复 `protocolHandler` 重复服务注册导致的启动致命错误

  **设备配对管理器**
  - 新增 `DevicePairingManager`：RSA 公钥 + 挑战签名验证的设备认证系统
  - 配对流程：请求配对 → 生成挑战 → 签名验证 → 颁发设备令牌
  - 设备信任列表管理、令牌刷新、吊销
  - 安全事件发布：`security.alert` 事件通知
  - 18 个单元测试全部通过

  **配置热重载增强**
  - `ConfigWatcher` 新增变更差异计算：`diffConfigs()` 递归深度对比
  - 新增 `SchemaConfigChange` / `SchemaConfigChangeHandler` 类型
  - `onConfigChange()` 注册变更处理器，`removeConfigChangeHandler()` 移除
  - `getCurrentConfig()`、`getStats()`、`forceReload()` 方法
  - 重命名为 `SchemaConfigChange` 以避免与 `config-rpc.ts` 中的 `ConfigChange` 冲突

  **SSH Sandbox**
  - 新增 `SSHSandbox`：SSH 远程命令执行沙箱
  - 支持公钥认证（临时密钥文件 0600 权限）和密码认证
  - 超时控制、输出截断（maxOutputBytes）、工作目录、环境变量传递
  - `runScript()` 支持多行脚本执行

  **SandboxManager 统一沙箱管理**
  - 新增 `SandboxManager`：统一管理 Docker/SSH/Process 三种沙箱后端
  - 会话生命周期：`createSession()` → `execute()` / `executeScript()` → `destroySession()`
  - `listBackends()` 查询可用后端
  - 5 个 REST API 端点：`GET /api/sandbox/backends`、`POST /api/sandbox/sessions`、`GET /api/sandbox/sessions`、`POST /api/sandbox/sessions/:id/exec`、`DELETE /api/sandbox/sessions/:id`

  **PluginHost 插件宿主**
  - 新增 `PluginHost`：插件生命周期管理（registerPlugin → activate → deactivate → unregister）
  - ServiceLocator 模式：`register(name, service)` / `resolve<T>(name)` 服务注册与查找
  - Hook 事件系统：`emitHook(hookName, data)` 支持超时保护（5s）
  - `healthCheck()` 健康检查、`getStats()` 统计信息、`shutdown()` 优雅关闭
  - 21 个单元测试全部通过

  **CI/CD 测试修复**
  - `LastKnownGoodConfig.pruneSnapshots(0)` 修复：当 `maxAgeDays <= 0` 时直接删除所有快照，而非计算截止时间戳（避免 `Date.now() - 0 = Date.now()` 导致 `>=` 比较失败）
  - GitHub Actions Node 22/24 矩阵测试全部通过

  **测试统计**
  - 78 个测试文件，1795 个测试用例全部通过

---

## v0.7.0 (2026-05-28)

### 全面系统测试 + Claude Code Tools 插件集成 + 技能系统增强

- **文件**: `packages/agent/src/agent-model-executor.ts`、`packages/agent/src/plugins/claude-code.plugin.ts`、`packages/agent/src/plugins/index.ts`、`packages/agent/package.json`、`packages/claude-code-tools/src/llm-dispatcher.ts`、`packages/claude-code-tools/src/task-decomposer.ts`、`packages/claude-code-tools/src/claude-code-plugin.ts`、`packages/core/src/plugin-system.ts`、`packages/gateway/src/protocol-adapter.ts`、`packages/skills/src/auto-skill-manager.ts`、`packages/skills/src/skill-manager.ts`、`apps/server/src/index.ts`、`package.json`

- **改动**:

  **Claude Code Tools 插件集成到 WebUI**
  - 新建 `claude-code.plugin.ts` 适配器，将 `ClaudeCodePlugin` 类包装为 EvoClaw `Plugin` 接口（含 manifest、hooks、init、shutdown、healthCheck）
  - 将 `createClaudeCodeToolsPlugin` 添加到 `BUILTIN_PLUGIN_FACTORIES`，服务器启动时自动注册
  - 添加 `@evoclaw/claude-code-tools` 工作区依赖到 `@evoclaw/agent`
  - 修复 `PluginManager.resolveService()` 空壳问题（之前始终返回 undefined），新增 `setRegistry()` 方法
  - 服务器启动时调用 `pluginManager.setRegistry(this.registry)` 使插件能访问服务注册表

  **LLM 调用架构重构**
  - `LLMDispatcher.callLLM` 从 `executor.execute()` 改为直接 HTTP 调用 LLM API，避免嵌套 chat() 工具循环
  - `TaskDecomposer.tryLlmDecomposition` 同样改为直接 HTTP 调用 LLM API
  - 新增 `callLLMDirect()` 方法：支持 OpenAI/Anthropic 兼容 API，含超时控制和错误处理

  **execute_programming_task 异步化**
  - 从同步阻塞改为异步提交模式：立即返回任务 ID，后台执行
  - 新增 `get_task_result` 工具：支持查询异步任务进度和结果
  - 新增 `executeTaskInBackground()` 方法：后台执行任务并通过 EventBus 发布进度
  - 轮询优化：`get_task_result` 在任务运行中时返回等待提示，避免 LLM 频繁轮询

  **SkillDispatcher 智能路由增强**
  - 技能输出错误检测：当技能返回包含 API_KEY/authentication/forbidden 等错误标记时，自动 fall through 到 LLM
  - claude-code-tools 工具名绕过：当消息包含 `execute_programming_task` 等工具名时跳过 SkillDispatcher

  **超时限制优化**
  - 工具执行超时分级：长运行工具（execute_programming_task 等）5分钟，普通工具30秒
  - Chat API 超时从110秒增加到5分钟

  **parseMultipleTasks 修复**
  - 移除问号 `？` 作为任务分隔符，避免普通对话被过度拆分
  - 新增 `isQuestionOnly()` 检测，过滤纯问题片段

  **Curated 技能内容增强**
  - `generateSkillMdFromCurated` 生成标准 `## Instructions`、`## Examples`、`## Scripts` 节
  - 新增 `generateInstructions()` 方法：为11种技能生成详细中文指令说明
  - 新增 `generateScripts()` 方法：为 calculator/http-client 生成脚本示例
  - `scanAndInstall` 新增 `tryGenerateCuratedSkill()`：当目录缺少 SKILL.md 时自动从 curated 注册表生成

  **essentialTools 扩展**
  - 将 `execute_programming_task`、`decompose_programming_task`、`assess_coding_capability`、`get_task_result` 加入 LLM 核心工具集

---

## v0.6.0 (2026-05-27)

### Claude Code Tools 编程任务调度插件 + Skill 系统审计修复

- **文件**: `packages/claude-code-tools/src/*`、`packages/skills/src/*`、`packages/core/src/plugin-system.ts`、`pnpm-workspace.yaml`、`package.json`

- **改动**:

  **Claude Code Tools 插件核心模块**
  - `task-decomposer.ts`：任务分解引擎，支持 Sequential/Parallel/Hybrid 三种策略，10种任务类型，LLM辅助分解
  - `llm-dispatcher.ts`：统一LLM调用接口，10种中文系统提示模板，指数退避重试，并发调度
  - `task-orchestrator.ts`：四阶段执行管线（分解→调度→验证→整合），依赖图调度，错误恢复（重试+再分解+死锁检测）
  - `capability-upgrade.ts`：能力评估与自动升级机制，6种升级策略，能力趋势检测
  - `claude-code-plugin.ts`：EvoClaw 插件集成层，注册4个服务和4个工具
  - 107个测试用例全部通过

  **Skill 系统审计修复（22+项）**
  - `skill-sandbox.ts`：修复 allowSubprocess 绕过、allowedHosts 通配符、execSync→spawn、createControlledFS 实现、Python 命令注入
  - `skill-resolver.ts`：修复 autoInstall 未调用 installFn、installPath 缺失、versionMatches 严格性、invalidateCache 精度
  - `skill-lifecycle.ts`：修复 getAllHealthReports 返回空数组
  - `skill-manager.ts`：修复 extractZip 命令注入、uninstallSkill 工具清理、processedItems 内存泄漏
  - `marketplace.ts`：修复 install() 未写入磁盘、SHA-256 校验和、递归依赖深度限制
  - `skill-dispatcher.ts`：修复 listSkills() 4处缺少 await、新增中文关键词模式
  - `skill-registry.ts`：修复串行→并行远程查询、mergeResults total、curated skills 分类/评分
  - `auto-skill-manager.ts`：修复评分归一化、文件内容缓存、generateFromCurated YAML frontmatter
  - `tfidf-matcher.ts`：新增 trigrams、停用词过滤、提升 minScore 至 0.1

  **pnpm-workspace.yaml**
  - 移除 `- "!packages/claude-code-tools"` 排除行，使包参与工作区构建

---

## v0.5.9 (2026-05-26)

### 定时任务修复 + 全面多语言 i18n + 微信扫码通道建立

- **文件**: `packages/web-ui/src/i18n.ts`、`packages/web-ui/src/CronPage.tsx`、`packages/web-ui/src/ChannelConfig.tsx`、`packages/web-ui/src/App.tsx`、`packages/web-ui/src/BootstrapConfig.tsx`、`packages/web-ui/src/CanvasPage.tsx`、`package.json`
- **改动**:

  **问题 1 — 定时任务创建功能修复**
  - 排查定时任务创建流程：API 端点 (`POST /api/scheduler/tasks`) 正常返回 201，根因是前端错误提示不清晰
  - 修复 `CronPage.tsx` 错误处理逻辑：当 `res.ok === false` 时读取响应体 error 信息，不再显示通用 "创建失败"
  - 多场景测试通过：创建 heartbeat (每30分钟)、技能刷新、内存清理等任务，全部 CRUD 操作 (创建/列表/启用禁用/手动执行/删除) 验证正常
  - handlerType 自动映射：前端 "system" → 后端 "system_cleanup"，"skills/memory/chat" → "custom"

  **问题 2 — 全面多语言界面 i18n 修复**
  - 扩展 `i18n.ts` 字典：新增 200+ 翻译键，覆盖全部 13 个页面类别
  - 通道配置 (ChannelConfig.tsx)：42 个翻译键，飞书/企业微信/个人微信的 18 条 setup guide 全部双语化
  - 定时任务 (CronPage.tsx)：40+ 翻译键，6 个模板名称/描述、表单标签、状态提示、错误信息全部双语化
  - 对话页 (App.tsx)：删除确认弹窗从三元表达式 `lang === "zh" ? ... : ...` 转为标准 `t()` 调用
  - 引导配置 (BootstrapConfig.tsx)：完整 i18n 集成，标题/提示/按钮/消息全部双语化
  - 全局画布 (CanvasPage.tsx)：完整 i18n 集成，进化统计/学习统计/压缩链/页脚全部双语化
  - 插件/仪表盘/状态/事件/技能/权限/LLM配置/进化/日志/运维页面字典全部就绪

  **问题 3 — 个人微信通道二维码建立流程**
  - 重构 `ChannelConfig.tsx` 个人微信通道：用 SVG 二维码替代纯表单填写
  - QR 码生成：`generateQRDataUri()` 基于配对码 `evoclaw-pair:wechat:{timestamp}:{token}` 生成 240x240 SVG 二维码
  - 3 种状态视觉反馈：waiting (旋转加载) / connected (绿色对勾) / expired (红色警告)
  - 自动过期：5 分钟后 QR 码自动标记为过期
  - 刷新按钮：允许用户重新生成 QR 码
  - 表单回退：提供切换开关，支持用户手动填写通道信息
  - 飞书和企业微信通道保持不变（表单模式）

---

## v0.5.8 (2026-05-26)

### 全面功能测试 + WebUI API 端点修复

- **文件**: `packages/gateway/src/protocol-adapter.ts`、`package.json`、`apps/cli/package.json`
- **改动**:

  **全量功能测试验证**
  - 启动服务并对 WebUI 全部 7 组菜单（MAIN/SYSTEM/CONFIG/SECURITY/ADMIN/HEALTH/OPS）下 27 个页面进行 API 端点测试
  - 发现 5 个缺失的后端 API 端点 + 1 个路径错误 + 1 个方法签名不匹配问题
  - 最终验证：22 个关键 API 端点全部通过（22/22 PASS）

  **新增 5 个系统 API 端点**
  - `GET /api/system/sessions` — 返回所有会话信息（含 token 用量、压缩次数），对接 SessionManager + LifecycleManager（修正 `listSessions("default")` 必须传入 agentId 的签名不匹配问题）
  - `GET /api/system/providers` — 返回 LLM 提供商状态列表（名称/provider/model/状态/成功失败计数）
  - `GET /api/system/bootstrap-files` — 返回 4 个启动文件的存在状态和大小
  - `GET /api/system/bootstrap-file/:file` — 读取单个启动文件内容（安全校验：仅允许 AGENTS.md/SOUL.md/TOOLS.md/IDENTITY.md）
  - `PUT /api/system/bootstrap-file/:file` — 写入/更新启动文件内容

  **路径修正**
  - bootstrap 文件路径从 `data/bootstrap/` 修正为 `data/workspace/`（与 AgentModelExecutor.loadBootstrapFiles() 保持一致）

  **安全加固**
  - bootstrap-file 端点加入文件名白名单校验，防止路径遍历攻击
  - 所有新端点使用 try/catch 统一错误处理，返回结构化 JSON 错误

---

## v0.5.7 (2026-05-26)

### 插件系统清理与增强 + Cron 定时任务修复

- **文件**: `packages/agent/src/plugins/index.ts`、`packages/agent/src/plugins/cost-tracker.plugin.ts`(新增)、`packages/agent/src/plugins/response-validator.plugin.ts`(新增)、`packages/agent/src/plugins/conversation-summarizer.plugin.ts`(新增)、`packages/agent/package.json`、`packages/gateway/src/protocol-adapter.ts`、`apps/cli/src/commands/cron.ts`
- **改动**:

  **插件系统清理**
  - 移除 5 个空壳占位插件（`AVAILABLE_PLUGINS`）：discord-connector、slack-connector、voice-synthesis、canvas-renderer、sentiment-analyzer——这些插件仅有 manifest 无任何实际 hook 实现
  - 保留 4 个完整功能插件：Memory Enhancer、Code Analyzer、Web Browser、System Logger
  - `agent/package.json` 新增 `./plugins` 子路径导出，支持外部动态导入内置插件

  **新增 3 个实用插件**
  - `Cost Tracker`: 监听 `agent_end` hook，追踪每次对话的 token 用量并估算成本（支持 13 种主流模型定价表：GPT-4/3.5/4o、Claude 3/3.5、Gemini 1.5、DeepSeek），提供每日/会话级成本统计
  - `Response Validator`: 监听 `before_agent_reply` 和 `agent_end` hook，检测 AI 回复的质量问题：空回复、未闭合代码块、错误 JSON 泄露、AI 自引用、占位符文本、重复内容、截断
  - `Conversation Summarizer`: 监听 `agent_end` 和 `before_prompt_build` hook，10+ 轮对话后自动生成摘要（提取主题关键词、关键决策、涉及文件），注入系统提示减少 token 浪费

  **Cron 定时任务系统修复**
  - `protocol-adapter.ts` 新增 6 个 `/api/scheduler/` 端点：
    - `GET /api/scheduler/tasks` — 列出所有任务 + 统计
    - `POST /api/scheduler/tasks` — 创建任务（含 handlerType 映射：system→system_cleanup, skills/memory/chat→custom）
    - `PUT /api/scheduler/tasks/:taskId` — 更新任务（名称/cron/启用状态）
    - `DELETE /api/scheduler/tasks/:taskId` — 删除任务
    - `POST /api/scheduler/tasks/:taskId/run` — 立即执行
    - `GET /api/scheduler/history` — 执行历史（支持 taskId 过滤）
  - `apps/cli/src/commands/cron.ts` 全部命令从 stub 重写为真实 API 调用：
    - `cron status` — 调度器状态概览（通过 `/api/scheduler/tasks`）
    - `cron list` — 所有任务详细列表
    - `cron add --name --cron [--desc] [--type] [--no-enable]` — 创建任务（POST API）
    - `cron edit <id> --name/--cron/--desc/--enable/--disable` — 编辑任务（PUT API）
    - `cron rm/enable/disable/run/runs <id>` — 全部对接真实 API

  **插件安装 API 增强**
  - `POST /api/plugins/install` 从占位 stub 升级为：尝试从 `@evoclaw/agent/plugins` 动态导入 `BUILTIN_PLUGIN_FACTORIES` 并注册匹配插件，失败则返回排队提示

## v0.5.6 (2026-05-25)

### 实时任务状态反馈 + 插件安装修复

- **文件**: `packages/agent/src/agent-model-executor.ts`、`packages/agent/src/index.ts`、`packages/gateway/src/protocol-adapter.ts`、`packages/gateway/package.json`、`packages/web-ui/src/WebChatPage.tsx`、`packages/web-ui/src/PluginsPage.tsx`
- **改动**:

  **TaskStatusTracker — 实时任务进度**
  - 新增 `TaskStatusTracker` 单例，跟踪 5 种状态：`thinking`, `tool_calling`, `generating`, `done`, `error`
  - 在 `chat()` 流程全程注入状态更新：分析请求 → 技能调度 → 调用模型 → 执行工具 → 整理回复 → 完成/错误
  - 工具执行时显示具体工具名："正在执行: web_search..."
  - 系统配置查询类请求直接标记 "done"，不经过 LLM
  - 所有 provider 失败时标记 "error" 并切换本地规则响应

  **API 端点**
  - 新增 `GET /api/chat/status?sessionId=X`（protocol-adapter.ts）
  - 网关新增 `@evoclaw/agent` workspace 依赖
  - agent index.ts 导出 `taskStatusTracker` 和 `TaskStatus`

  **前端轮询**
  - `handleSend` 添加 1.5s 间隔轮询 `/api/chat/status`
  - `statusMessage` 状态覆盖 loading 文案，显示真实阶段："思考中: 正在调用 model..."、"执行中: web_search..."
  - finally 块清理 `statusInterval` + `statusMessage`

  **插件安装修复**
  - `PluginsPage.tsx`：可用插件列表的 "Install" 按钮添加 `onClick` 处理
  - 新增 `installAvailablePlugin()` 函数
  - 已安装插件显示 "Installed" + 禁用样式

---

## v0.5.5 (2026-05-25)

### 系统配置查询直通：绕过 LLM 秒回

- **文件**: `packages/agent/src/agent-model-executor.ts`
- **改动**:
  - 新增 `handleSystemConfigQuery` 方法，在 skill install 检测之后、email 检测之前执行
  - 匹配关键词："查配置"、"系统配置"、"当前模型"、"check config"、"list skills" 等（中英文）
  - 直接返回格式化系统配置报告，包含：
    - 推理模型（名称/模型/类型/超时/端点）+ 主模型标识
    - 可用工具列表（最多 12 个截断）
    - 技能状态（已安装 vs 可安装分类）
    - 系统信息（Agent 名称、会话历史上限、压缩状态、长期记忆）
    - 查询时间戳 + 响应耗时
  - **不消耗 LLM token**，无需等待模型推理，查询 < 10ms 内返回
  - 非配置类查询不影响，仍走正常 LLM 流程

---

## v0.5.4 (2026-05-25)

### 核心原则：始终给用户反馈 — 全链路超时与兜底

- **文件**: `packages/web-ui/src/WebChatPage.tsx`、`packages/gateway/src/protocol-adapter.ts`、`packages/agent/src/agent-model-executor.ts`
- **改动**:

  **前端 — fetch 超时 + cleanup**
  - `handleSend` 的 `fetch("/api/chat")` 添加 120s AbortController 超时
  - 超时后显示友好提示："请求超时（超过 2 分钟），服务器可能繁忙..."
  - `setIsStreaming(false)` 移到 `finally` 块，确保任何退出路径（包括权限弹窗 return）都释放 loading 状态
  - 移除重复的 cleanup 代码，消除死代码

  **网关 — 全局超时包装**
  - `/api/chat` 用 `Promise.race` 包装 110s 超时
  - 超时后返回 JSON {"reply": "处理超时，请稍后重试..."} 而非挂起
  - 确保 Express res.json() 始终被调用

  **Agent Executor — 兜底消息 + 工具超时**
  - `tryCallLLM`：所有 provider 均失败后不再返回 null，返回兜底中文提示
    - "抱歉，所有已启用的模型提供商均未能响应。请检查：API Key / 服务在线 / 网络连接"
  - 工具执行添加 30s 超时 (`Promise.race`)，防止单一工具挂起整个响应链
  - 超时工具返回明确错误信息，LLM 可在下一轮继续

---

## v0.5.3 (2026-05-25)

### 多模态 Vision 支持：图片识别打通

- **文件**: `packages/agent/src/agent-model-executor.ts`
- **改动**:
  - 导入 `ChatContent` 类型，消息类型注释从 `string | null` 扩展为 `string | null | ChatContent[]`
  - `tryCallLLM` 新增 `attachments` 参数，传递图片数据
  - 消息构建时检测图片 attachment：自动构建多模态 `ChatContent[]` 格式
    - 文本部分：`{ type: "text", text: message }`
    - 图片部分：`{ type: "image_url", image_url: { url: "data:image/...", detail: "auto" } }`
  - `callLLMOnce` 方法签名同步更新以支持数组 content
  - `handleMultipleTasks` 同步传递 attachments
  - 上下文压缩路径的消息重建也支持多模态格式
  - 图片元数据注入文案更新：从"文本模型无法分析"改为"上传为 vision 输入，请直接分析图片内容"
  - OpenAI provider（`openai.ts`）原生支持 `convertMessage` 处理 image_url 无需修改

---

## v0.5.2 (2026-05-24)

### 文件上传端到端打通：API 携带附件数据 + LLM 感知文件

- **文件**: `packages/web-ui/src/WebChatPage.tsx`、`packages/gateway/src/protocol-adapter.ts`、`packages/agent/src/agent-model-executor.ts`
- **改动**:
  - `AttachedFileInfo` 新增 `data?: string` 字段，存储 base64 数据（图片）或文本内容
  - `handleFileAttach` 使用 FileReader 预读文件内容：图片 `readAsDataURL`，文本/JSON `readAsText`
  - `handleSend` 构建 `attachmentPayload` 并在 API POST body 中携带 `attachments` 数组
  - `protocol-adapter.ts`：提取 `req.body.attachments` 并传入 `agentModelExecutor.chat` 的 context
  - `agent-model-executor.ts`：注入附件内容到 `effectiveMessage`：
    - 图片：元数据（名称/类型/大小）+ 说明当前使用文本模型
    - 文本文件：内联内容（最多 8000 字符）
    - 其他二进制文件：仅元数据标注
    - 纯文件发送（无文字）：显示"用户未附带文字说明"

---

## v0.5.1 (2026-05-24)

### Bugfix: 消息发送功能修复

- **文件**: `packages/web-ui/src/WebChatPage.tsx`
- **改动**:
  - `handleSend` 移除 `useCallback` 包裹，改为普通 async 函数，彻底消除 stale closure 问题
  - 移除 textarea 的 `disabled={isStreaming}` 属性，避免阻塞键盘事件
  - 移除未使用的 `fileSummary` 变量和 `clearReadyFiles` 函数

---

## v0.5.0 (2026-05-24)

### 文件上传功能完整实现

- **文件**: `packages/web-ui/src/WebChatPage.tsx`
- **改动**:
  - 新增 `AttachedFileInfo` 接口：id、name、size、type、previewUrl、status、progress、error、cancelToken
  - `WebChatMessage` 新增 `attachments` 字段，用户消息气泡中显示已上传文件引用
  - 文件选择对话框，支持多文件、类型过滤（图像/文档/文本/压缩包）
  - 文件验证：10MB 大小限制、允许类型白名单、重复文件检测
  - 上传进度模拟（条纹动画进度条 + 网络抖动模拟），支持取消上传
  - 图片文件生成缩略图 Object URL 预览，非图片文件显示类型 SVG 图标
  - 文件名超长截断（前 20 字 + ... + 扩展名）
  - 错误处理：格式不支持、超大文件、重复添加等提示
  - 上传完成后点击发送自动带入消息，支持纯文件发送（无文本）
  - 文件预览栏在输入框与工具栏之间（flex wrap 布局）
  - 取消/移除按钮 hover 变红色，进度条条纹动画
  - 新增 CSS 动画：uploadProgressStripe、slideDown

---

## v0.4.10 (2026-05-24)

### 复制按钮交互优化

- **文件**: `packages/web-ui/src/WebChatPage.tsx`
- **改动**:
  - EvoClaw 气泡 `paddingTop` 从 26px 增加到 32px，内容起始位置再下移半行
  - 复制按钮改用原生 `title="复制为 Markdown"` 属性，hover 显示浏览器标准 tooltip
  - 移除内联文字展开样式，按钮更简洁
  - 点击后图标闪烁 accent 色 500ms 作为反馈

---

## v0.4.9 (2026-05-24)

### 复制图标与布局优化

- **文件**: `packages/web-ui/src/WebChatPage.tsx`
- **改动**:
  - EvoClaw 气泡固定 `paddingTop: 26px`，为复制图标预留空间，消除内容重叠
  - 复制图标从 emoji 📋 换为纯色 SVG（与主菜单图标风格一致）：双矩形叠加的 copy 图标
  - 上下文用量条从输入框上方独立行移到下方工具栏同行居中显示

---

## v0.4.8 (2026-05-24)

### 输入框布局重构

- **文件**: `packages/web-ui/src/WebChatPage.tsx`
- **改动**:
  - 输入框布局重构：textarea 单独占一行，所有工具按钮（附件、语音、设置、导出、发送）放在输入框下方独立一行
  - 新增 `textAreaExpanded` + `isTextareaHovered` 状态变量
  - 鼠标悬停输入框区域时，右上角显示展开/折叠图标（⤓/⤒）
  - 点击展开图标可将输入框临时变为 5 行文字高度（130px），再次点击恢复原始两行高度（60px）
  - 移除已废弃的 `.textarea-expand-toggle` className

---

## v0.4.7 (2026-05-24)

### 聊天输入框优化

- **文件**: `packages/web-ui/src/WebChatPage.tsx`
- **改动**:
  - 移除右侧"新会话"文字按钮（左侧菜单已有此功能）
  - 输入框最小高度从 40px 调整为 60px（约两行高度）

### 消息气泡复制按钮优化

- **文件**: `packages/web-ui/src/WebChatPage.tsx`
- **改动**:
  - 气泡悬停时仅显示复制图标 📋，不再显示文字
  - 鼠标悬停在复制图标上时才显示"复制为 Markdown"提示文字
  - 优化按钮样式：透明背景、无边框、更小 padding

---

## v0.4.6 (2026-05-24)

### 输入框工具栏功能完善

- **文件**: `packages/web-ui/src/WebChatPage.tsx`
- **新增功能**:
  - **附加文件 📎**: 点击打开文件选择器，支持多选，文件附加到消息发送
  - **设置 ⚙**: 点击发送 `evoclaw-open-settings` 自定义事件，打开右上角设置弹窗
  - **导出 📥**: 导出整个对话记录为 Markdown 文件下载
  - **新会话 +**: 点击清空对话，显示欢迎消息，同时清空附件列表
  - **语音输入 🎤**: 已禁用（显示半透明），提示"暂未支持"
- **上下文使用进度条**: 变量已预留（`contextUsed`/`contextLimit`），可接入真实 token 统计
- **输入框提示**: 改为 `给 {机器人昵称} 发消息 · Shift+Enter 换行 · Enter 发送`

### 消息气泡交互增强

- **文件**: `packages/web-ui/src/WebChatPage.tsx`
- **功能**:
  - EvoClaw 消息气泡鼠标悬停时边框高亮（主题蓝色）+ 阴影效果
  - 悬停时气泡右上角显示"📋 复制为 Markdown"按钮
  - 点击按钮将消息复制为格式化的 Markdown 文本（包含昵称、时间戳、内容）
  - 用户消息气泡不受影响
- **影响**: 用户可方便地将 EvoClaw 的回答复制为 Markdown 格式

---

## v0.4.5 (2026-05-24)

### 聊天输入框功能增强

- **文件**: `packages/web-ui/src/WebChatPage.tsx`
- **新增功能**:
  - **上下文使用进度条**: 显示当前对话占用的 token 比例 (45% context used, 89.1k/200k)，颜色随比例变化（绿色→黄色→红色）
  - **左侧工具栏**: 附加文件 📎、语音输入 🎤、设置 ⚙（hover 交互反馈）
  - **右侧工具栏**: 新会话按钮、导出按钮 📥、发送按钮
  - **输入框优化**: 圆角改为 12px，占位符动态显示机器人昵称
- **设计特点**:
  - 所有按钮支持 hover 状态（背景色变化）
  - 主题色与当前主题一致
  - 布局紧凑，信息层次清晰
- **影响**: 聊天界面功能更完善，用户体验提升

---

## v0.4.4 (2026-05-23)

### 聊天消息头像与时间戳位置定制

- **文件**: `packages/web-ui/src/WebChatPage.tsx`
- **功能**:
  - 用户消息：时间戳居左，昵称居中偏右，28px圆形头像最右侧
  - EvoClaw消息：28px圆形头像最左侧，昵称居中，时间戳居右
  - 头像从 `avatars.user`/`avatars.bot` 读取（来自右上角设置），支持自定义上传头像
  - 时间戳使用等宽字体 (monospace) 增强可读性
- **影响**: 聊天界面信息层次更清晰，用户可个性化头像和昵称

---

## v0.4.3 (2026-05-23)

### Evolution/Compactions API 认证白名单修复

- **文件**: `packages/gateway/src/auth-provider.ts`
- **问题**: `/api/evolution/*` 和 `/api/compactions` 路径不在认证白名单中，前端请求被 401 拦截
- **修复**: 将 `/api/evolution/` 和 `/api/compactions` 添加到公开 API 前缀白名单
- **影响**: Evolution Dashboard 和 Canvas 页面现在可以正常获取数据

### SkillDispatcher 搜索技能匹配增强

- **文件**: `packages/skills/src/auto-skill-manager.ts`, `packages/skills/src/skill-dispatcher.ts`
- **问题**:
  - 中文搜索意图（"搜索新闻"、"查找资讯"等）无法匹配到 `baidu-search` 技能
  - SkillDispatcher 回退搜索仅查找 `web-search`，不包含 `baidu-search`
- **修复**:
  - `computeKeywordRelevance()` 添加语义关键词映射：搜索意图词（搜索/查找/查询/新闻/search/find 等）自动提升搜索类技能的相关度分数
  - SkillDispatcher 回退搜索增加 `baidu-search` 匹配
- **影响**: 中文搜索请求现在能正确匹配到 baidu-search 技能

### SkillDispatcher 执行失败回退 LLM

- **文件**: `packages/agent/src/agent-model-executor.ts`
- **问题**: 当 SkillDispatcher 匹配到技能但执行失败时（如缺少 API Key），不会回退到 LLM 处理
- **修复**: 添加 else 分支，当技能匹配但执行失败时打印日志并回退到 LLM 流程
- **影响**: 搜索类请求即使技能执行失败，也能通过 LLM 的 web_fetch 工具获取结果

---

## v0.4.2 (2026-05-23)

### 删除会话确认弹窗定制化

- **文件**: `packages/web-ui/src/WebChatPage.tsx`
- **问题**: 删除聊天会话使用浏览器原生 `confirm()` 弹窗，体验简陋
- **修复**:
  - 替换为自定义精美弹窗：圆角卡片 + 毛玻璃遮罩 + 缩放动画
  - 弹窗主题色与当前主题一致（使用 CSS 变量 `--bg-card`, `--border`, `--text-primary` 等）
  - 新增"以后删除不再提示"复选框，勾选后存储到 localStorage，后续删除直接执行
  - 按钮交互优化：hover 状态变色，删除按钮红色高亮
  - 点击遮罩层可关闭弹窗
- **影响**: 删除会话体验大幅提升，用户可自主选择是否跳过确认

### 安全修复：移除诊断接口中的环境变量泄露

- **文件**: `packages/infrastructure/src/crestodian.ts`
- **问题**: `collectDiagnostics()` 返回完整 `process.env`，包含 API 密钥等敏感信息
- **修复**: 移除 `env: process.env` 字段，仅保留 `config.NODE_ENV`
- **影响**: 防止通过 Ops 诊断接口泄露 API 密钥等敏感信息

---

## v0.4.1 (2026-05-23)

### 系统核心功能连接与数据流修复

本次更新重点解决了 WebUI 多个 Tab 页面数据为空的问题，打通了从后端服务到前端展示的完整数据链路。

#### EventLedger 事件账本数据记录
- **文件**: `packages/agent/src/agent-model-executor.ts`
- **问题**: EventLedger.append() 从未被调用，导致事件账本 Tab 始终为空
- **修复**:
  - 在 chat() 方法中挂载 `session_start` 事件记录（会话开始时触发）
  - 在工具执行循环中添加工具调用成功/失败的事件记录
  - 在会话结束时挂载 `session_end` 事件记录
- **影响**: 每次用户对话和工具调用都会被记录到事件账本，支持按时间/类型/代理/会话查询

#### Canvas 进化统计与学习统计数据修复
- **文件**: `apps/server/src/index.ts`
- **问题**: EvolutionEngine 已创建但未注册到 ServiceRegistry，导致 `/api/evolution/dashboard` 和 `/api/evolution/learning/stats` 始终返回空数据
- **修复**: 添加 `registry.registerService("evolutionEngine", this.evolutionEngine)` 及 Crestodian 健康注册
- **影响**: Canvas 页面的进化统计和学习统计将从 evolutionEngine 获取运行时数据

#### Ops 服务健康状态修复
- **文件**: `apps/server/src/index.ts`, `packages/infrastructure/src/crestodian.ts`
- **问题**:
  - 无服务向 Crestodian 注册，导致"无服务数据"
  - `collectDiagnostics()` 返回的字段（health, overview, recentOperations, env）与前端 Diagnostics 接口（status, collectedAt, os, process, config）完全不匹配
- **修复**:
  - 注册 agentModelExecutor、gatewayServer、autoSkillManager、skillDispatcher、eventLedger、permissionManager、taskOrchestrator、evolutionEngine 等关键服务到 Crestodian
  - 重构 `collectDiagnostics()` 返回结构，增加 `status`、`collectedAt`、`os`、`process`、`config` 等前端期望字段，同时保留原有 health、overview、recentOperations、env 信息
- **影响**: Ops 页面正确显示各服务健康状态和诊断信息

#### Permissions 权限页面修复
- **文件**: `apps/server/src/index.ts`, `packages/web-ui/src/PermissionsPage.tsx`
- **问题**:
  - 刷新按钮无视觉反馈
  - `permRelay.request()` 缺少必填参数 `agentId` 和 `sessionId`，导致权限请求未被记录
  - 前端 PermissionsPage 查询 permissionRelay 但文件操作工具未向其写入数据
- **修复**:
  - 前端添加 `refreshing` 状态，刷新时按钮禁用并显示加载状态
  - 文件工具处理器（file_create/file_modify/file_delete）调用 `permRelay.request()` 时传入 `agentId: "system"` 和 `sessionId: "default"`
- **影响**: 文件操作时的权限请求现在会记录到 permissionRelay 并在 WebUI 中显示

#### OpsPage/PermissionsPage 刷新交互优化
- **文件**: `packages/web-ui/src/OpsPage.tsx`, `packages/web-ui/src/PermissionsPage.tsx`
- **修复**: 添加 `refreshing` 状态变量，刷新按钮在加载时显示禁用+半透明状态，提升用户体验
- **影响**: 用户点击刷新后获得明确的加载反馈

#### 编译错误修复
- **`toolsExecuted` 属性**: 将 `chat()` 方法及 `detectAndConfigureEmailAccount`、`handleEmailOperation`、`handleSkillInstall` 等 12 个方法的返回类型统一添加 `toolsExecuted: boolean` 字段，修复约 40+ 处 TS2741 错误
- **`anyToolExecuted` 作用域**: 修复变量在不同函数作用域中未定义的问题
- **`toInstall` 作用域**: 修复 `handleBatchSkillInstall` 中 `toInstall` 变量在 `if` 块内部定义导致外部无法访问的问题
- **`handleSkillInstall` 语法结构**: 修复函数体中 `if` 块缺少闭合括号导致的 TS1128 错误

---

## v0.4.0 (2026-05-22 ~ 2026-05-23)

### 综合技能系统与工作流改进
- **提交**: `bc01e8b`
- **内容**: 全面升级技能系统，增加自动发现、安装、调度功能
- **文件**: `packages/skills/src/skill-dispatcher.ts`, `packages/skills/src/tfidf-matcher.ts`
- **新增**:
  - SkillDispatcher 技能调度器：基于 TF-IDF 匹配自动将用户任务路由到对应技能
  - TF-IDF 匹配器：本地语义匹配，支持中英文
  - 自动技能安装流程：检测技能安装请求并执行批量安装
  - 远端搜索回退：本地无匹配时自动执行网页搜索

### 邮件功能修复
- **提交**: `b8ccc4b`
- **内容**: 修复邮件工具在有现有账户时无法正常工作的问题
- **影响**: 邮件查询、整理功能恢复正常

### 技能安装流程修复
- **提交**: `226c921`
- **内容**: 添加 handleSkillInstall 方法，改进技能安装检测逻辑
- **影响**: 支持"安装 weather"等自然语言安装指令

---

## v0.3.x (2026-05-21 ~ 2026-05-22)

### 技能安装与搜索功能
- **提交**: `a9adb24`
- **内容**: 添加 skill_install、skill_search 工具，支持对话中安装和搜索技能
- **影响**: 用户可通过自然语言请求安装技能

### Session 管理修复
- **提交**: `011e286`
- **内容**: 修复删除最后一个会话时的 React 错误
- **影响**: Session 列表操作稳定性提升

### UI 体验改进
- **提交**: `5ec798c`, `e18ddae`, `5815ed3`, `c695062`, `8d58ce0`
- **内容**:
  - 会话预览优化：23 字预览，中英文智能计数
  - 加载动画：添加进度条、动画点、5 条轮换加载消息
  - 动画速度调优至 3 秒
- **影响**: 用户等待体验显著改善

### 权限弹窗响应式修复
- **提交**: `9e35204`
- **内容**: 修复权限弹窗在不同屏幕尺寸下的响应式布局
- **影响**: 移动端和窄屏用户体验改善

### 黑屏崩溃修复 + 亮色主题支持
- **提交**: `91b4e26`
- **内容**: 修复 SkillsConfig 页面黑屏崩溃，全局页面亮色主题适配
- **影响**: 主题切换稳定性提升

---

## v0.2.x (2026-05-20)

### 持久化内存与 Session 集成
- **提交**: `26ffebd`
- **内容**: 从 OpenClaw 设计移植持久化内存与会话集成
- **影响**: 跨会话记忆保持

### SkillsConfig UI 改进
- **提交**: `ee18534`
- **内容**: SkillsConfig 界面显示 OpenClaw 元数据中的必需环境变量
- **影响**: 技能配置界面更直观

### 技能执行引擎升级
- **提交**: `be961a0`
- **内容**: 支持 Python/bash 子进程、web_fetch/web_search 工具
- **影响**: 技能执行能力大幅增强

---

## v0.1.x (2026-05-18 ~ 2026-05-19)

### Skill-First 执行策略
- **提交**: `6d6f28d`
- **内容**:
  - 优先使用技能搜索而非浏览器工具处理网页搜索任务
  - 添加 skill_install/execute/create 工具
  - 输出换行优化、工具结果截断
- **影响**: 任务执行效率提升

### Agent 韧性提升
- **提交**: `7a36504`, `d7bc278`
- **内容**:
  - 修复输出多余空行和浏览器工具上下文溢出
  - Agent 韧性提升、新闻搜索自主化
  - LLM 错误日志增强
- **影响**: 系统稳定性和可调试性提升

---

## v0.1.0 (项目初始)

### 项目基础架构
- Monorepo 结构 (pnpm workspace)
- 15+ 核心包：agent、skills、evolution、security、infrastructure、gateway、web-ui 等
- WebUI 前端：React + TypeScript + Vite
- 后端服务：Express + TypeScript
- 插件系统：Hook 生命周期拦截器
- 权限系统：PermissionManager + PermissionRelay
- 运维系统：Crestodian 健康监控与诊断
- 进化引擎：EvolutionEngine 任务学习与改进
- 事件账本：EventLedger 全量事件记录
- 技能系统：SkillManager + AutoSkillManager + SkillDispatcher

---

*此文件由 EvoClaw 开发团队维护，每次成功构建后必须更新。*