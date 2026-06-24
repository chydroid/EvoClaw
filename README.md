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