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