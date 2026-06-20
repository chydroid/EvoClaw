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