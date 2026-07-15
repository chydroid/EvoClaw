[English](README.md) | [中文](README.zh-CN.md)

---

<p align="center">
  <img src="https://github.com/chydroid/EvoClaw/raw/main/assets/images/evoclaw-400-100.png" alt="EvoClaw" width="420">
</p>

<h1 align="center">🧬 EvoClaw</h1>

<p align="center">
  <strong>具备增强式自我进化能力的下一代自主智能体操作系统</strong><br>
  <sub>通过技能学习、任务编排与多渠道接入提供个性化智能体验</sub>
</p>

<p align="center">
  <img src="https://img.shields.io/badge/node-%3E%3D20-brightgreen?style=flat-square" alt="Node.js" />
  <img src="https://img.shields.io/badge/pnpm-10.33.2-blue?style=flat-square" alt="pnpm" />
  <img src="https://img.shields.io/badge/typescript-5.x-3178c6?style=flat-square" alt="TypeScript" />
  <img src="https://img.shields.io/badge/version-0.84.0-orange?style=flat-square" alt="Version" />
  <img src="https://img.shields.io/badge/tests-5527-brightgreen?style=flat-square" alt="Tests" />
  <img src="https://img.shields.io/badge/license-MIT-green?style=flat-square" alt="License" />
</p>

---

## 快速开始

### 环境要求

- **Node.js** >= 20（推荐 Node 24，与 pnpm 10 兼容性更好）
- **pnpm** >= 9

> **pnpm 版本兼容说明**：pnpm 10+ 需要 Node >= 22.13。如果你使用 Node 20，请使用 `npm install -g pnpm@9` 替代 `npm install -g pnpm`。

### 安装

```bash
# 1. 克隆仓库
git clone https://github.com/chydroid/EvoClaw.git
cd EvoClaw

# 2. 安装依赖
pnpm install
# 如果 pnpm 不可用，可使用 npm：
# npm install

# 3. 配置环境变量
cp .env.example .env
# 编辑 .env 填入 API Key 等配置

# 4. 构建项目
pnpm build
# OR 使用 npm：
# npm run build

# 5. 启动服务
pnpm start
# OR 使用 npm：
# npm start
```

浏览器打开 **http://localhost:27788**。

### 配置首个 LLM

1. 打开 Web 界面 → **LLM** 选项卡
2. 选择提供商（如 OpenAI）
3. 开启 **Enable Provider**
4. 填入 **API Key**
5. 选择 **Model**（如 gpt-4o）
6. 点击 **Save All**

> **本地模型？** 安装 [Ollama](https://ollama.com)，运行 `ollama pull llama3`，然后在 Base URL 填入 `http://localhost:11434/v1`。

### 验证

```bash
pnpm typecheck    # 类型检查
pnpm test         # 运行测试
```

## 核心能力

| 类别 | 能力 |
|------|------|
| 智能对话 | 多模型、多提供商、流式响应、上下文压缩、MoA 多模型混合推理 |
| 技能系统 | 本地 + 远程注册表、自动安装、安全扫描、Skill Curator 生命周期管理、optional-skills 分离、37 个内置 + 可选技能（开发工具、生产力、写作、分析、设计、生成），TF-IDF 语义匹配支持中英文双语关键词 |
| 工具生态 | 文件操作、浏览器自动化、网络搜索、Office 文档生成、Computer Use 桌面控制、Tool Search 工具搜索 |
| 多渠道 | 微信、飞书、钉钉、Telegram、WhatsApp、Discord、Slack、Matrix、QQ、REST API、WebSocket、A2A、ACP IDE |
| 记忆系统 | 长短期记忆、RAG 检索、语义搜索、L0-L3 分层记忆、Memory Provider 插件系统 |
| 自进化 | 经验学习、强化反馈、自动优化、遗传算法、A/B 测试 |
| 安全 | 命令审批、路径防护、SSRF 防护、密钥管理、审计日志、启动安全审计、OSV 供应链安全、advisory catalog |
| 插件 | Plugin SDK 扩展、MCP 协议支持、Profile 多实例隔离 |
| 协作 | Kanban 多 Agent 工作队列、Actor 模型、Swarm 群体编排、DAG 任务编排 |
| 可靠性 | 进程监督、关闭取证、排空控制、日志轮转、凭证池持久化 |

## 架构

EvoClaw 采用模块化事件驱动架构：

- **网关层** — REST/WS/MCP 网关、Web UI（React 19）、CLI 命令行，所有外部接口
- **EventBus** — 集中式发布订阅事件总线，解耦所有内部服务
- **核心服务** — Agent（Actor 模型 + DAG 编排）、Evolution（自进化引擎）、Memory（多层：短期/长期/向量/FTS5）
- **支撑层** — Skills（注册表、沙箱、安全扫描）、Security（RBAC、审计、租户隔离）、Infrastructure（日志、消息队列、文件系统）
- **横切关注** — Copilot Router（智能模型路由）、Credential Pool（API Key 轮转）、Prompt Cache

关键设计模式：ServiceRegistry 实现 IoC/DI、Actor 模型并发、DAG 任务分解、Observer 模式驱动进化。

## CLI 命令参考

提供 30+ 子命令：

```bash
# 初始化与引导
evoclaw setup                    # 创建基础配置和工作区
evoclaw onboard                  # 交互式引导配置

# 健康与状态
evoclaw health [--json]          # 健康检查
evoclaw status [--all]           # 运行时状态
evoclaw doctor [--fix]           # 系统诊断

# Agent 与消息
evoclaw agent -m <msg>           # 运行 Agent 并发送消息
evoclaw message send             # 向 Agent 发送消息

# 技能
evoclaw skills search <q>        # 搜索技能
evoclaw skills install <s>       # 安装技能
evoclaw skills list              # 列出已安装技能

# 模型
evoclaw models list              # 列出可用模型
evoclaw models set <id>          # 切换默认模型
evoclaw models scan              # 扫描可用模型

# 配置
evoclaw config get <key>         # 获取配置值
evoclaw config set <key> <val>   # 设置配置值

# 安全
evoclaw security audit           # 运行安全审计
evoclaw secrets list             # 查看密钥

# 集成
evoclaw mcp list                 # 列出 MCP 服务器
evoclaw plugins list             # 列出插件
evoclaw channels list            # 渠道管理
```

## REST API

主要端点（共 50+）：

| 端点 | 方法 | 说明 |
|---|---|---|
| `/api/health` | GET | 健康检查 |
| `/api/chat` | POST | 发送对话消息 |
| `/api/skills` | GET | 列出已安装技能 |
| `/api/system/services` | GET | 服务运行时状态 |
| `/api/config/llm` | GET/PUT | LLM 配置 |
| `/api/config/channels` | GET/PUT | 渠道配置 |
| `/api/feature-flags` | GET | 列出功能开关 |
| `/api/evolution/dashboard` | GET | 进化引擎仪表盘 |
| `/api/memory/search?q=` | GET | 语义记忆搜索 |
| `/metrics` | GET | Prometheus 指标 |

## 配置

`.env` 中的关键环境变量：

| 变量 | 默认值 | 说明 |
|---|---|---|
| `EvoClaw_PORT` | `27788` | 服务端口 |
| `EvoClaw_HOST` | `0.0.0.0` | 绑定地址 |
| `JWT_SECRET` | — | JWT 签名密钥（**生产环境务必修改**） |
| `EvoClaw_EVOLUTION_ENABLED` | `true` | 启用自进化引擎 |
| `EvoClaw_MCP_ENABLED` | `true` | 启用 MCP 协议 |
| `CORS_ORIGINS` | — | 允许的跨域来源 |
| `RATE_LIMIT_MAX` | — | 最大请求速率限制 |

## 项目结构

```
EvoClaw/
├── apps/
│   ├── server/              # 主服务入口
│   └── cli/                 # 命令行工具
├── packages/
│   ├── core/                # 基础类型、事件总线、配置管理
│   ├── agent/               # 任务编排、模型执行、Agent 池
│   ├── gateway/             # 渠道管理、协议处理、Webhook
│   ├── skills/              # 技能注册、安装、验证、安全扫描
│   ├── memory/              # 记忆存储、RAG 管道、语义搜索
│   ├── security/            # 安全治理、权限管理、审计
│   ├── evolution/           # 自进化引擎
│   ├── infrastructure/      # 消息队列、文件系统、日志
│   ├── scheduler/           # 定时任务调度
│   ├── reporting/           # 报告生成
│   ├── intelligence/        # 任务分类与技能编排
│   ├── plugin-sdk/          # 插件开发 SDK
│   ├── email/               # 邮件客户端
│   ├── web-ui/              # React 19 前端界面
│   └── claude-code-tools/   # Claude Code 集成
└── docs/                    # 文档
```

## 技术栈

- **运行时**: Node.js 20+
- **语言**: TypeScript (strict)
- **包管理**: pnpm monorepo
- **测试**: Vitest
- **前端**: React 19 + Vite
- **数据库**: SQLite (better-sqlite3)
- **浏览器自动化**: Playwright

## 开发

```bash
pnpm dev          # 开发模式
pnpm build        # 构建
pnpm typecheck    # 类型检查
pnpm test         # 运行测试
pnpm test:watch   # 监听模式
```

## Docker

```bash
docker build -t evoclaw .
docker run -p 27788:27788 --env-file .env evoclaw
```

## 常见问题

| 问题 | 解决方案 |
|---|---|
| `pnpm: command not found` | 安装 pnpm：`npm install -g pnpm@10` |
| `port 27788 already in use` | 修改 `.env` 中的 `EvoClaw_PORT` 或终止占用进程 |
| 构建失败 | 清理后重试：`pnpm clean && pnpm install && pnpm build` |
| Web UI 白屏 | 确认 `pnpm build` 已完成，检查浏览器控制台 |
| LLM 连接失败 | 检查 API Key 和 Base URL，确认网络连通性 |
| 渠道连接失败 | 确认回调 URL 可公网访问，验证 Token |

### 端口冲突

```bash
# Linux/macOS
lsof -i :27788
kill -9 <PID>

# Windows
netstat -ano | findstr :27788
taskkill /PID <PID> /F
```

### 完全重置

```bash
pnpm clean
rm -rf node_modules pnpm-lock.yaml
pnpm install
pnpm build
pnpm test
```

## 贡献

欢迎提交 Issue 和 PR。详见 [CONTRIBUTING.md](CONTRIBUTING.md)。

## 安全

发现漏洞请参考 [SECURITY.md](SECURITY.md)。

## 许可证

[MIT](LICENSE)

---

详细的版本更新记录请参阅 [History.md](History.md)。