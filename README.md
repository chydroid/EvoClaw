# EvoClaw - 自进化智能助理平台

## 项目简介
EvoClaw（进化之爪）是一个自进化智能助理平台，通过自我改进、技能学习和智能编排为您提供强大、个性化的智能助理体验。

## 主要特性
- 智能对话系统（支持本地快速回复日期、计算器、日出日落等常见问题）
- 文件操作工具
- 网络搜索功能
- 浏览器自动化
- 技能学习系统（含 `skill_create` / `skill_uninstall` 生命周期管理）
- 自进化能力
- 智能任务路由（CopilotRouter，支持缓存与 provider 健康感知）
- 多渠道支持（微信、飞书、钉钉、Telegram、WhatsApp、REST API、WebSocket）
- 安全治理与审计
- 插件SDK扩展
- 高质量技能创建门控（反模式检测、模糊匹配、长度限制）
- 全通道 Python 脚本生成与执行（计算、数据处理、模拟等任务）
- LLM 调用统一超时、重试与熔断保护
- Agent 池生命周期治理与健康检查
- Gateway 聚合健康检查与优雅关闭
- 配置热加载与变更广播
- 会话持久化并发安全与用量洞察
- Web UI 全局状态管理与错误边界
- 运行时数据与自带技能目录分离（`data/skills/` vs `packages/skills/bundled/`）
- 全仓库敏感信息扫描与 Git 防泄漏策略

### v0.60.0 亮点
- **对照 openclaw-main 的 10 轮基础设施与安全提升**：以 openclaw-main 为参照系，对网关/安全/基础设施/技能子系统进行 10 轮短板补齐，对齐行业最佳实践
  - **第 1 轮（技能安装 download 种类完整实现）**：`SkillManager.executeStructuredInstall` 改为 async，新增 `executeDownloadInstall` 私有方法实现完整的 download 安装（HTTPS-only + SSRF 防护 + 100MB 上限 + zip/tar.gz/tar.bz2 解压 + stripComponents）；新增 anyBins 预检查与 bins 后置校验
  - **第 2 轮（Hooks 4 源策略系统）**：新增 `hook-policy.ts`（约 220 行），定义 bundled/plugin/managed/workspace 4 源策略矩阵，支持 `canOverride` / `canBeOverriddenBy` 双向校验、`resolveHookEnableState` 显式禁用优先、`resolveHookEntries` 按优先级合并与碰撞回调
  - **第 3 轮（插件 hardlink 策略与起源索引）**：新增 `plugin-hardlink-policy.ts`（约 325 行），`shouldRejectHardlinkedPluginFiles` 检测 inode nlink>1（Nix store 例外）；`PluginProvenanceIndex` 类记录每个插件文件的 inode + sha256，`verifyPlugin` 检测文件缺失/inode 变化/hash 不匹配
  - **第 4 轮（工作台符号链接逃逸检测）**：新增 `workspace-audit.ts`（约 340 行），BFS 遍历 skills/ 目录，对每个 SKILL.md 调用 `realpathWithTimeout`（Promise.race + unref 计时器）；`collectWorkspaceSkillSymlinkEscapeFindings` 检测 symlink 目标逃逸出工作台根
  - **第 5 轮（结构化日志与脱敏轮转）**：新增 `rotating-file-appender.ts`（约 275 行），`RotatingFileAppender` 类按大小滚动（默认 100MB × 5 文件），`pruneOldRollingLogs` 启动时清理孤儿文件与 .tmp 残留
  - **第 6 轮（W3C 跟踪上下文传播）**：新增 `trace-context.ts`（约 295 行），实现 `formatTraceparent` / `parseTraceparent`（严格正则校验 + 全零检测），通过 `AsyncLocalStorage` 传播 trace 上下文，`startSpan` / `emitDiagnosticEvent` 支持 W3C Trace Context 标准
  - **第 7 轮（net-policy 包）**：新增 `net-policy.ts`（约 348 行），`NetPolicy.checkUrl` 三层校验（协议 → 主机名单 → DNS 钉制 → IP 名单），`resolveAndPinIp` 实现 DNS 重绑定防护（缓存 + TTL + 解析前后比对），`matchHostList` 支持 `*.example.com` 通配符
  - **第 8 轮（配置 schema 合并管线）**：新增 `config-schema-merge.ts`（约 298 行），`ConfigSchemaMerger` 类支持多源 JSON Schema 合并（256KB / 2MB / 256 项 / 深度 10 上限），同名冲突保留 base + 记录冲突 + SHA256 cacheKey；`generateUiHints` 支持 `channels.*.token` 通配符路径提示
  - **第 9 轮（MCP channel-bridge 与 cancel 支持）**：`MCPGateway` 扩展 `callTool` 方法（AbortController + 超时 + 并发上限 100），`cancelToolCall` 按 callId 取消、`cancelCallsByCaller` 按 callerId 批量取消（渠道断连时清理），`bridgeChannelMessage` 解析 `/mcp call <tool> [arg=value]` 指令并桥接到 MCP 工具调用
  - **第 10 轮（消息持久接收与 stall-watchdog）**：新增 `durable-receive-journal.ts`（约 300 行）与 `stall-watchdog.ts`（约 190 行）；`InMemoryDurableReceiveJournal` 通过 pending + completed 双 Map 检测重复事件，支持 TTL 与僵尸事件清理；`createArmableStallWatchdog` 实现可武装的传输空闲看门狗（arm/touch/disarm/stop + AbortSignal 联动 + 计时器 unref + 超时自动 disarm 防二次触发）
  - **新增测试**：`durable-receive-stall-watchdog.test.ts`（20 个测试，覆盖 accept/pending/complete/release/deletePending + arm/touch/disarm/stop/AbortSignal）
  - **验证**：`pnpm -r build` + `pnpm typecheck` + 20/20 测试通过

### v0.59.0 亮点
- **对照 openclaw-main 的 10 轮技能系统提升**：以 openclaw-main 为参照系，对技能子系统进行 10 轮短板补齐，全面对齐行业最佳实践
  - **第 1 轮（SKILL.md 规范对齐）**：扩展 `SkillMetadata` 与 `SkillManifest`，新增 `metadata.openclaw` 扩展字段（emoji/requires.env/bins/anyBins/primaryEnv/os/homepage），`SkillLoader` 与 `SkillValidator` 完整识别 openclaw 风格的 SKILL.md frontmatter，运行时与 UI 双向兼容
  - **第 2 轮（技能安装流水线加固）**：`SkillInstaller` 新增 6 阶段流水线（策略 → 解析 → 验证 → 质量 → 沙箱策略 → 安全扫描），与 openclaw `skill install --dry-run` 行为对齐；`InstallPolicy` 引擎支持 allowlist/blocklist/路径白名单/依赖校验
  - **第 3 轮（技能沙箱执行环境）**：新增 `SkillSandbox` 类（Node.js `vm` 模块），禁用 `process/require/eval/Function/child_process`，提供受限 `console`/`setTimeout`/`setInterval`（带 unref），防止技能脚本逃逸
  - **第 4 轮（安全表达式求值）**：新增递归下降 `SafeExpressionEvaluator`，替代 `new Function`/`eval`，支持算术/逻辑/三元/比较/字符串/数组/对象字面量，从根上杜绝代码注入
  - **第 5 轮（SkillWorkshop API 暴露）**：在 `protocol-adapter.ts` 暴露 9 个工作台端点（stats/today/proposals CRUD/submit/review/revise/install/rollback），提案创建与修订内建路径穿越防护、文件数量（≤20）与单文件大小（≤512KB）限制
  - **第 6 轮（安全扫描增强）**：`SkillValidator` 新增 5 个扫描方法（obfuscation/concatenatedExec/sandboxEscape/promptInjection/description injection），识别 13 种 prompt injection 模式、长 base64 混淆、`String.fromCharCode` 拼接、`constructor.constructor` 链逃逸、`__proto__` 污染、`process.mainModule` 访问
  - **第 7 轮（技能签名与信任链）**：新增 `skill-integrity.ts` 模块（约 420 行），`origin.json` 记录每个技能文件级 sha256，`evoclaw-skill-lock.json` 汇总所有技能指纹，`SkillManager` 在安装/卸载时自动写入/校验，5 个 integrity API 端点（verify/refresh-lock/verify-lock）暴露给 UI
  - **第 8 轮（UI 安全 verdict chip + 详情弹窗）**：`SkillsConfig.tsx` 在技能详情头部展示 4 色风险等级 chip（绿/黄/橙/红），点击打开 findings 详情弹窗，包含 severity/type/location/description/recommendation 五元组与重新扫描按钮
  - **第 9 轮（UI stale-aware 请求防护）**：详情/市场搜索/安全扫描三类请求引入 `AbortController`，切换技能时取消上一个请求，避免竞态导致旧数据覆盖新数据；AbortError 静默处理
  - **第 10 轮（端到端验证 + 高可用性）**：`/api/skills/install` 与 `/api/marketplace/install` 新增 2 次重试（仅对瞬时错误 ECONN/ETIMEDOUT/lock 等，安全扫描失败不重试）；新增 `/api/skills/system/health` 健康检查端点；`SkillRegistry` 远程注册表健康指数退避（5min × 2^failures，上限 2^5）
  - **新增 5 个 bundled 技能**：`scrapling-fetch`（反爬虫抓取）、`link-understanding`（链接理解）、`task-decomposer`（任务分解）、`meeting-summarizer`（会议纪要）、`code-explainer`（代码解释）
  - **验证**：`pnpm -r build` + `pnpm typecheck` + `pnpm test` 全部退出码 0

### v0.58.0 亮点
- **6 轮全量 Bug 扫描与修复（60+ 个修复）**：延续前 9 轮审查，连续进行 6 轮全量扫描，覆盖 14 个内部包 + 2 个应用
  - **第 3 轮收尾（SSRF/注入/认证旁路）**：`shell-media-tools.ts` 的 `scrapling_fetch`/`video_download`/`music_download` 全部接入 SSRF 防护，与 `web-tools.ts` 保持一致
  - **第 4 轮（数值精度/off-by-one/边界条件，20+ 个）**：`dingtalk.ts` NaN 时间戳崩溃、`context-engine/task-scheduler/constraint-gate` 除零、`media-processor.ts` ID3v2 帧解析越界读、7 处时间戳运算符优先级 Bug（`Number(x) * 1000 || Date.now()`）、`cost-tracker/commitments/task-analyzer` NaN 进度、`model-failover` 重试风暴、`security-governor` Number fail-open、`guardrails` switch 无 default、`compaction-manager` JSON.parse 缺类型校验
  - **第 5 轮（内存泄漏/闭包/stale 引用，7 个）**：`llm-dispatcher.callHistory` 与 `task-orchestrator.executionHistory` 无上限无界增长、`skill-registry.cache` 永久累积过期项、`protocol-adapter` createReadStream 缺 `res.on("close")` 兜底、`memory-hub` 新增 `close()` 方法释放 SQLite 句柄、`learning-journal` schedulePersist 定时器未清理
  - **第 6 轮（错误处理完整性/防御性编码，10+ 个）**：关闭序列 5 个 await 无 try/catch、`feishu` 消息循环 await 未隔离丢消息、`finally` 中 closeSync 覆盖原始异常、`/api/config/avatars` 原型污染、Cookie 缺少 `secure: true`、`image-tools/video-tools` model 名 URL 注入、多处 setInterval 回调无 try/catch 导致 Map 无限增长
  - **验证**：`pnpm -r build` + `pnpm typecheck` 全部退出码 0

### v0.57.6 亮点
- **全面代码审查与 BUG 修复（5 轮）**：从实用角度对全项目进行 5 轮深度审查，共修复 **120+ 个真实 BUG**
  - **超时静默失败修复**：渠道消息处理添加 5 分钟超时包装，超时/错误/空回复均向用户发送提示与解决建议；并行工具失败结果注入对话防止 LLM 永久等待
  - **严重安全修复**：SQL 注入（api-toolkit 标识符未校验）、命令注入（daemon-manager/update-manager/ssh-sandbox 的 execSync 拼接）、SSRF（link-understanding 重定向未校验域名）、allowlist 绕过（content-guard 任意允许词跳过全部屏蔽词）、设备配对密钥覆盖、配对码暴力破解（6 位→8 位 hex+锁定）、签名算法错误（飞书 SHA256 vs HMAC-SHA256）、多渠道 webhook 签名验证缺失
  - **资源泄漏**：AsyncSemaphore 死锁、ActorSystem 消息丢失、process-manager Map 无限增长、observability otelSpans 泄漏、多包定时器未 unref、claude-code-tools 多处无界 Map/数组
  - **数据正确性**：evolution-engine Date 字段反序列化（JSON.parse 后为字符串导致 .getTime() 崩溃）、memory-hub 压缩结果未持久化、tfidf-matcher tokenize 去重破坏 TF、report-generator SVG 双重 base64、video-tools 1:1 宽高比错误、marketplace 版本标记污染
  - **原子写入**：全面贯彻 atomicWriteFile 规则——event-ledger、filesystem-checkpoint、playwright-browser cookies、email accounts、install-policy audit、bootstrap 文件、CLI accounts/PID/.env 等 15+ 处非原子写入修复
  - **CLI 修复**：gateway restart 不重启、update 不构建、secrets set 不写入、QR 假二维码、backup 不复制文件、命令别名冲突（config/configure、tui/chat）、硬编码端口
  - **服务端修复**：SIGINT/SIGTERM 强制退出超时（10s）、第二次信号立即退出、bootstrap 原子写入、skill 翻译定时器 unref
  - **测试修复**：evolution-engine UUID 断言（预存在 flaky）、scheduler run-log prune 测试逻辑错误、permission-manager 跨目标断言错误、genetic-engine 弱断言增强
  - **跨包集成**：claude-code-tools Anthropic 响应解析错误、并行结果顺序错乱、subagent 超时无效、session-state-manager 返回引用非克隆

### v0.57.5 亮点
- **全面代码审查与 BUG 修复（2 轮）**：对全项目进行 2 轮深度审查，共修复 **44 个真实 BUG**
  - 严重修复：pre-commit secret 检测正则损坏导致安全防线失效、recordEvolution 清除所有 skill 失败计数、processQueue 任务饥饿、ActorSystem send 阻塞
  - 数据正确性：commitments 状态转换 from 字段错误、memory-curator 哈希不匹配、swarm 投票分母错误、LIKE 通配符未转义、getStatus 误导性 "failed"
  - 资源安全：queue-manager 非原子写入违反项目规则、process-manager 缺 error 事件处理
  - 测试质量：3 处零断言测试（误报）、7 处固定 50ms 等待竞态条件（flaky test）
  - 构建/部署：start.bat 品牌名错误、跨平台脚本缺失、CLI tsconfig 与基配置不一致

### v0.57.4 亮点
- **全面代码审查与 BUG 修复（2 轮）**：对全项目进行 2 轮深度审查，共修复 **49 个真实 BUG**
  - 严重修复：Telegram 消息丢失、QQ 双重连接、Feishu 去重失效、授权时序攻击、并发控制失效、重试逻辑失效
  - 资源泄漏：Chromium 进程未关闭、IMAP 连接泄漏、idempotencyCache/pairingCodes/activeTasks Map 从不清理
  - 数据正确性：截图写入 base64 文本而非 PNG、邮件获取最旧而非最新、成功率只降不升、上下文压缩全丢
  - 安全修复：XSS（三重花括号）、非常量时间签名比较、禁用插件钩子仍执行、path-scoped 工具并发违规
  - 集成修复：跨包 API 契约不匹配、配置锁竞态、服务重复启动、消息队列重复处理

### v0.57.3 亮点
- **全面代码审查与 BUG 修复（2 轮）**：对全项目进行 2 轮深度审查，共修复 **41 个真实 BUG**
  - 严重修复：memory-dreaming 正则无限循环（进程挂起）、permission-manager 授权绕过、concurrency 并发度超限
  - 资源泄漏：concurrent-tool-executor 定时器泄漏+信号量等待者丢失、agent-model-executor 缓存内存泄漏、ssrf DNS 定时器泄漏
  - 数据正确性：JSON.stringify(undefined) 破坏 LLM API 契约、model-failover 重试延迟记录污染熔断器、sandbox-executor 异步 handler 测试失效
  - WebUI：12 处内存泄漏/竞态条件（模块级状态泄漏、闭包过期、setTimeout 未清理、fetch 缺少 AbortController）
  - CLI：13 处 API 响应形状不匹配（skills/models/approvals/logs/pairing/mcp 命令）
  - 基础设施：message-queue 全局标志跨 topic 串扰、mcp-poisoning-scanner 正则 50 倍重复

### v0.57.2 亮点
- **全面代码审查与 BUG 修复**：对全项目 17 个包进行 3 轮全面审查，共修复 **56 个真实 BUG**
  - 安全修复：PowerShell 命令注入、空 token 认证后门、数据库 DELETE/UPDATE 空实现
  - 数据完整性：去重 key 时间戳问题、经验蒸馏器只处理第一个聚类、正则空匹配
  - 资源泄漏：14 处定时器泄漏（RegExp lastIndex、Promise.race setTimeout、未 unref）
  - WebUI：同标签页语言切换、fetch 不检查 res.ok、LLMConfig 掩码保存、Tab 补全错误
  - CLI：API 响应类型不匹配、硬编码路径

### v0.57.1 亮点
- **WebUI 增强能力中心**：新增 `EnhancementHubPage` 页面，集中展示 v0.56/v0.57 补齐的 12 大核心能力，含能力卡片、汇总面板、实时指标
- **CLI 全面提升**：命令行工具全面重写，可替代大多数 GUI 操作
  - 新增 `chat` 命令（交互式 REPL + 单次模式，支持 `/model`、`/clear` 等斜杠命令）
  - 新增 `enhancements` 命令（CLI 版增强能力中心）
  - 重写 `tasks` 命令（list/show/create/status/delete/evolution/trigger）
  - 重写 `skills` 命令（list/search/install/uninstall/info/upgrade/health/trending，全部使用真实 API）
  - 重写 `config` 命令（get/set/list/validate/fix/schema，支持点号嵌套配置）
  - 增强 `status` 命令（内存、Agent、服务全面状态）

### v0.57.0 亮点
- **任务完成能力深度对齐 hermes-agent（第二轮）**：从工具执行可靠性、上下文管理、多后端兼容性三个维度补齐 6 大核心能力
- **工具结果持久化（三层防御）**：`ToolResultPersistenceManager` 实现 per-tool cap → per-result persistence（沙箱临时文件 + `<persisted-output>` 预览块）→ per-turn aggregate budget，PINNED_THRESHOLDS 防止 persist→read→persist 死循环
- **JSON Schema 多后端清洗**：`sanitizeToolSchemas` 支持 Anthropic/OpenAI Codex/Fireworks/xAI/llama.cpp 五类后端的 schema 兼容性清洗，`reactiveSanitize` 根据错误文本响应式选择清洗策略
- **工具参数类型强制转换**：`coerceToolArguments` 在工具调用前校正 LLM 返回的参数类型（string→int/number/boolean、JSON string→object/array、bare value→[value]），避免运行时类型错误
- **跨会话速率限制守卫**：`CrossSessionRateGuard` 基于文件共享状态实现 CLI/gateway/cron/auxiliary 跨会话速率限制同步，防止 retry amplification（9 次 API 调用/429），`isGenuineRateLimit` 区分配额耗尽与瞬时容量不足
- **流式响应中断恢复**：`StreamingRecoveryManager` 实现 6 种恢复策略（partial_stream_recovery / truncated_tool_call_retries / length_continue_retries / thinking_prefill_retries / post_tool_empty_retried / housekeeping_fallback），覆盖流式传输中断的各种场景
- **工具结果中间件**：`ToolResultMiddleware` 提供 3 类中间件（ToolRequestMiddleware 修改参数 / ToolExecutionMiddleware 包装执行 / ToolResultTransform 后处理结果），内置 createRedactionTransform / createSizeLimitTransform / createJsonFormatTransform

### v0.56.0 亮点
- **任务完成能力全面对齐 hermes-agent**：深度对比 hermes-agent 项目，补齐 6 大核心能力差距
- **文件系统检查点管理器**：基于 Git 影子存储的文件快照与回滚（`FileSystemCheckpointManager`），支持 per-project 隔离、每轮去重、三层清理、pre-rollback 快照
- **工具输出 3-pass 裁剪**：MD5 去重 → 工具特定摘要 → args JSON 安全截断（`ToolOutputPruner`），保持 JSON 有效性
- **错误恢复执行分支**：20+ FailoverReason 对应的实际恢复动作（`ErrorRecoveryExecutor`），含 TurnRetryState 一次性守卫防无限循环
- **Iteration Budget 退款机制**：execute_code/runtime_error/compaction 三种退款，让预算真正反映"决策次数"
- **跨平台进程树终止**：POSIX `/proc/children` + `ps --ppid` / Windows `taskkill /T /F`，受保护 PID + 两阶段终止
- **并发工具执行池**：8 worker + 3 类安全分类（never-parallel/path-scoped/safe-parallel）+ 心跳监控 + 中断扇出

### v0.55.0 亮点
- **对话大模型目录全面升级**：内置 27 家提供商、100+ 最新模型，含 OpenAI/Anthropic/Google/DeepSeek/通义千问/智谱/豆包/讯飞星火/商汤/零一万物/阶跃星辰/百川/腾讯混元/华为盘古等
- **官方价格直观显示**：新增 `model-catalog.ts` 集中管理 baseURL、模型 ID、上下文、官方价格、文档链接，UI 直接显示每 1M tokens 价格（USD/CNY）
- **免费/低价聚合平台**：集成 SiliconFlow、OpenRouter、Novita AI、Groq，提供大量免费或低价模型可选

### v0.54.0 亮点
- **图片生成能力**：新增 `image_generate` 工具，默认集成 Pollinations.ai（完全免费、无需 API Key、无限量），支持 Fal.ai/Replicate
- **配置管理 TAB 化**：大模型配置页面增加"图片生成"和"视频生成"TAB 页，可视化配置提供商
- **默认免费提供商**：图片生成预置 Pollinations.ai（免费），视频生成预置本地 FFmpeg（免费）

### v0.53.0 亮点
- **视频生成能力**：新增 `video_generate` 工具，支持文本生成短视频。多提供商支持（Fal.ai/Replicate/本地 FFmpeg），自动回退，异步轮询
- **Web UI 图片渲染**：Markdown 图片语法 `![alt](url)` 完整支持，相对路径自动补全，HTML `<img>` 标签保留

### v0.52.0 亮点
- **多凭证池管理**：CredentialPool 支持 4 种轮换策略（fill_first/round_robin/random/least_used）、三态管理（OK/EXHAUSTED/DEAD）、冷却 TTL、终端认证错误永久标记
- **速率限制追踪**：RateLimitTracker 解析 12 个 x-ratelimit-* 响应头，四维计数（requests/tokens × min/hour），提供 isNearLimit() 和 waitForResetMs() 决策
- **迭代预算**：IterationBudget 线程安全计数器，父 agent 90 次/子 agent 50 次，Grace Call 机制防止预算耗尽时无响应
- **工具护栏**：幂等/变异工具分类 + 重复调用检测 + allow/warn/block/halt 决策
- **路径安全**：集中式路径遍历防护（validateWithinDir/safeJoin/sanitizePath）
- **安全输出**：SafeWriter 防 broken pipe 崩溃，30+ API key 脱敏正则
- **AgentPool 排队**：池满时排队等待 + 基于利用率的自动扩容
- **IPv4 DNS 优先**：避免 IPv6 DNS 解析延迟

### v0.51.0 亮点
- **Office 文档生成**：内置 Word/Excel/PPT 创建工具（`docx_create` / `xlsx_create` / `pptx_create`），支持图形、表格与复杂排版
- **长任务状态可见**：复杂文档生成等长任务通过 SSE 持续推送 `正在进行生成，请耐心等待...` 状态，避免用户看到中间失败提示
- **错误体验优化**：工具/技能失败但存在替代方案时自动回退并静默继续，仅在确实无法完成时报告失败并给出建议
- **技能生态治理**：清理无用/重复技能，增加技能质量门控与 `skill-creator` 校验，防止低质量技能自动生成
- **WebUI 主题**：默认主题设为青蓝暗夜，深红暗夜用户聊天气泡背景与会话列表选中项统一

### v0.50.0 工程硬化亮点
- **Anthropic prompt cache**：自动在 system + 最后 3 条消息注入 `cache_control`，约 75% 输入 token 成本降低
- **工具执行并发控制**：全局信号量(5) + 浏览器互斥(1) + 网络限流(3)，防止并行 tool_call 资源耗尽
- **原子写入统一**：所有配置/状态文件使用 temp + fsync + rename 原子写入，崩溃时不截断
- **安全加固**：Webhook 签名 fail-closed + `crypto.timingSafeEqual` 常量时间比较，防止时序攻击
- **30+ P1 BUG 修复**：RegExp lastIndex、子域名 endsWith 攻击、路径遍历、循环依赖栈溢出等

## 快速开始
### 环境要求
- Node.js 20+ 
- pnpm 10+

### 安装步骤
1. 克隆仓库
```bash
git clone https://github.com/chydroid/EvoClaw.git
cd EvoClaw
```

2. 安装依赖
```bash
pnpm install
```

3. 配置环境变量
```bash
cp .env.example .env
# 编辑 .env 配置API密钥等
```

4. 构建项目
```bash
pnpm build
```

5. 启动服务
```bash
pnpm start
```

服务默认运行在 `http://localhost:27788`

### 开发模式
```bash
pnpm dev
```

### 运行测试
```bash
pnpm test
```

### Docker 部署
```bash
docker build -t evoclaw .
docker run -p 27788:27788 --env-file .env evoclaw
```

或使用 docker-compose:
```bash
docker-compose up -d
```

## 项目结构
```
EvoClaw/
├── apps/
│   ├── server/          # 主服务入口
│   └── cli/             # 命令行工具
├── packages/
│   ├── core/            # 基础类型和服务
│   ├── agent/           # 代理系统和任务编排
│   ├── gateway/         # 网关和协议处理
│   ├── skills/          # 技能管理
│   ├── memory/          # 记忆和RAG
│   ├── security/        # 安全治理
│   ├── evolution/       # 自进化引擎
│   ├── infrastructure/  # 基础设施服务
│   ├── scheduler/       # 任务调度
│   ├── reporting/       # 报告生成
│   ├── intelligence/    # 任务分类
│   ├── plugin-sdk/      # 插件开发SDK
│   ├── email/           # 邮件客户端
│   ├── web-ui/          # React前端
│   └── claude-code-tools/ # Claude Code集成
├── api-gateway/         # 独立API网关
└── go-bookstore/        # 独立Go演示项目
```

## 技术栈
- 运行时：Node.js 20+
- 编程语言：TypeScript (strict mode)
- 包管理：pnpm 10.33.2
- 测试框架：Vitest
- 数据库：SQLite/PostgreSQL
- 浏览器自动化：Playwright

## 贡献指南
欢迎贡献代码、报告问题或提出建议。请参阅 [CONTRIBUTING.md](CONTRIBUTING.md) 了解详细信息。

## 安全
如果发现安全漏洞，请参阅 [SECURITY.md](SECURITY.md) 了解报告方式。

## 许可证
MIT License