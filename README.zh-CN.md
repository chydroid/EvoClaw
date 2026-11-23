[English](README.md) | [中文](README.zh-CN.md)

---

<p align="center">
  <img src="https://github.com/chydroid/EvoClaw/raw/main/assets/images/evoclaw-400-100.png" alt="EvoClaw" width="420">
</p>

<h1 align="center">🧬 EvoClaw</h1>

<p align="center">
  <strong>具备自我进化能力的 AI 助手平台</strong><br>
  <sub>技能学习、任务编排、多渠道接入 —— 外加一层「按任务原文核验交付」的确定性验收闸门</sub>
</p>

<p align="center">
  <img src="https://img.shields.io/badge/node-%3E%3D20-brightgreen?style=flat-square" alt="Node.js" />
  <img src="https://img.shields.io/badge/pnpm-10.33.2-blue?style=flat-square" alt="pnpm" />
  <img src="https://img.shields.io/badge/typescript-5.x-3178c6?style=flat-square" alt="TypeScript" />
  <img src="https://img.shields.io/badge/version-0.93.1-orange?style=flat-square" alt="Version" />
  <img src="https://img.shields.io/badge/tests-8036-brightgreen?style=flat-square" alt="Tests" />
  <img src="https://img.shields.io/badge/license-MIT-green?style=flat-square" alt="License" />
</p>

---

## 这是什么

EvoClaw 让任意 OpenAI 兼容的 LLM 跑在一个完整的 Agent 循环里，配上一套工具带
（文件、Shell、浏览器、网络、文档、媒体、记忆、定时任务），并接入聊天渠道、
REST/WebSocket 网关、MCP 桥和 React Web UI。

有两个设计决定贯穿整个代码库：

- **提示词缓存神圣不可侵犯。** 对话历史只追加、不改写。提醒、警告、纠偏一律以
  *transient*（瞬态）消息注入，不进入历史 —— 于是缓存的公共前缀能跨轮存活。
- **完成状态靠核验，不靠措辞。** 任务原文里写明的必交产物（包括「≥300 字节」
  「至少 8 个断言」「冻结夹具禁止修改」）会在回合结束前被确定性检查。模型说
  「已完成」不构成证据。

## 快速开始

### 环境要求

- **Node.js** >= 20 —— CI 覆盖 Node 22 与 24，推荐 24
- **pnpm** 10.33.2（由 `packageManager` 字段固定；pnpm >= 9 亦可）

### 安装与启动

```bash
git clone https://github.com/chydroid/EvoClaw.git
cd EvoClaw

pnpm install                 # 安装工作区依赖
cp .env.example .env         # 编辑 .env：JWT_SECRET、WEB_UI_TOKEN、各家 API Key
pnpm build                   # 每个包 tsc + Web UI 的 vite build
pnpm start                   # 跨平台启动器（Windows 会自动 chcp 65001）
```

浏览器打开 **http://localhost:27788**（或 `.env` 里的 `EvoClaw_PORT`）。

> `pnpm start` 与 `pnpm cli` 都走 `scripts/launch.mjs`，因此 Windows / Linux / macOS
> 用同一条命令即可。`start:unix` / `start:win` 作为别名保留。

### 验证安装

```bash
pnpm build       # 必须先跑 —— 包之间引用彼此的构建产物
pnpm typecheck   # 全包 tsc --noEmit
pnpm test        # 经 scripts/vitest-runner.mjs 跑 vitest
```

### 配置第一个 LLM

1. 打开 Web UI → **LLM** 选项卡
2. 启用一个提供商，填入 **API Key**，选择 **Model**
3. 点击 **Save All**

任何 OpenAI 兼容端点都能用：填好该提供商的 **Base URL** 与模型名即可。
本地模型可装 [Ollama](https://ollama.com)，Base URL 用 `http://localhost:11434/v1`。

### 鉴权

除 `/health`、`/api/health`、公开的技能目录和静态 UI 资源外，网关一律要求鉴权。两种方式：

| 方式 | 做法 |
|---|---|
| Web UI 令牌 | 在 `.env` 设置 `WEB_UI_TOKEN`。SPA 首次加载时会以 httpOnly cookie 拿到它；API 客户端用 `Authorization: Bearer <token>` 或 `web_ui_token` cookie。 |
| 管理员登录 | `POST /api/auth/login {username,password}` 返回 JWT。凭证来自 `EVOCLAW_ADMIN_USER` / `EVOCLAW_ADMIN_PASSWORD`；非 `NODE_ENV=production` 时默认 `admin` / `admin`。 |

## 核心能力

| 领域 | 内容 |
|---|---|
| 对话 | 多提供商、流式、上下文压缩、MoA 多模型委员会、模型故障转移 + 凭证池轮转 |
| 任务执行 | 可跨重启的后台持久任务、检查点、预算感知收尾、循环/重复调用检测、子 Agent 委派 |
| 交付核验 | 从任务原文抽取必交产物契约、字节数/断言数门槛、冻结输入快照→归档→还原、如实收尾 footer |
| 技能 | 11 个内置 + 26 个可选技能、市场安装/搜索、安全扫描、SkillCurator 生命周期（内容寻址账本 + 回滚） |
| 工具 | 60 个核心工具，多数以 action 复用；可选 Playwright 浏览器、Office 文档、媒体（TTS/STT/图像/视频）、桌面控制、工具搜索 |
| 渠道 | 微信、微博、飞书、钉钉、QQ、Telegram、WhatsApp、Discord、Slack、Matrix，外加 REST、WebSocket、MCP、A2A、ACP/IDE |
| 记忆 | L0–L3 分层记忆、长短期存储、FTS5 全文（支持 CJK）、向量/语义检索、RAG 管道、用户建模 |
| 自进化 | 经验蒸馏、强化反馈、遗传搜索、A/B 测试、技能自动生成（沙箱内评估） |
| 安全 | 命令审批与白名单、路径/SSRF 防护、密钥脱敏、审计轨迹、启动安全审计、MCP 工具投毒扫描、OSV 供应链检查 |
| 运维 | 进程监督、关闭取证、队列排空控制、轮转日志、Prometheus `/metrics`、OTLP 追踪导出 |

## 架构

```
浏览器 / CLI / 聊天渠道 / IDE(MCP) / A2A
                 │
        网关层  (Express + WS + MCP + 渠道适配器)
                 │
             EventBus  (解耦的发布订阅)
                 │
   ┌─────────────┼──────────────┬─────────────┐
 Agent          Memory        Evolution     Security
 (编排、执行器、  (L0–L3、RAG、 (蒸馏、遗传、  (治理、审计、
  DAG、MoA)      FTS5、向量)     A/B)          RBAC、策略)
   └─────────────┴──────────────┴─────────────┘
                 │
        基础设施 (消息队列、进程管理、文件系统、日志、浏览器)
```

关键模式：`ServiceRegistry` 做 IoC/DI、Actor 模型做并发、DAG 做任务分解，
以及夹在「模型最后一条消息」和「用户」之间的确定性核验层。

### 包结构

| 包 | 职责 |
|---|---|
| `packages/core` | 类型、`ServiceRegistry`、`EventBus`、`ConfigManager`、插件管理、功能开关 |
| `packages/agent` | 任务编排、Agent/模型执行器、会话、上下文引擎、压缩、委派引擎、DAG/MoA |
| `packages/gateway` | 网关服务、渠道管理与适配器、协议处理、MCP、鉴权、流式 |
| `packages/skills` | 技能管理、市场注册表、Curator、调度器、索引 |
| `packages/memory` | 记忆中枢、语义/向量存储、FTS5、RAG、记忆 Provider |
| `packages/security` | 安全治理、审计中心、RBAC、租户隔离、工具策略、各类扫描器 |
| `packages/evolution` | 进化引擎、经验蒸馏、遗传引擎、A/B 测试 |
| `packages/infrastructure` | 消息队列、进程管理、文件系统、日志、浏览器控制、可观测性 |
| `packages/scheduler` | Cron 调度与计划管理 |
| `packages/reporting` | 报告生成 |
| `packages/intelligence` | 任务分类与技能编排 |
| `packages/plugin-sdk` | 插件/工具开发 SDK |
| `packages/email` | 邮件客户端 |
| `packages/web-ui` | React 19 + Vite 前端（59 个页面） |
| `packages/claude-code-tools` | Claude Code 工具集成 |

应用：`apps/server`（主入口，端口 27788）、`apps/cli`（`evoclaw`/`openclaw` CLI）、
`apps/mcp-server`（stdio MCP 桥，让 IDE 使用 EvoClaw 的工具）。

## 工具

启动时注册 60 个工具（MCP 的 `tools/list` 实测返回同样是 60 个）。多数是
**action 复用型** —— 一个工具多种行为 —— 这样工具载荷能保持精简、对缓存友好：

```text
file_write(action=create|modify|edit)   shell_exec      execute_code
browser_*(navigate|act|screenshot|…)    web_search(action=search|research|browser)
web_fetch   document(action=docx|xlsx|pptx)   memory   todo_list   scheduler
skill_manage|skill_list|skill_view      delegate_task  kanban   verify_project
text_to_speech  audio_to_text  image_generate  video  vision_analyze
```

`computer_use` 只在有桌面后端（native / nut.js / robotjs）时出现 —— 它由 `checkFn`
门控，无头服务器永远不会暴露它。
走 MCP 桥时，`shell_exec`、`execute_code`、`file_write`、`file_delete`、`video`
会被额外屏蔽；这些请走 Web UI 或 CLI 的 Agent 通道。

可选能力由依赖决定：浏览器工具需要 Playwright，本地嵌入需要 `@huggingface/transformers`，
FTS5 需要 `better-sqlite3`。缺依赖时该工具被禁用，而不是让请求整体失败。

## CLI

共 53 个命令。以下均为实测可用的命令面（`pnpm cli <command>`）：

```bash
# 初始化与诊断
pnpm cli setup                       # 创建基础配置与工作区目录
pnpm cli onboard                     # 交互式引导
pnpm cli health [--json]             # 网关健康检查
pnpm cli status [--all]              # 服务与系统状态
pnpm cli doctor [--fix] [--deep]     # 诊断与自动修复

# Agent
pnpm cli agent -m "总结 ./README.md"
pnpm cli chat                        # 交互式 REPL
pnpm cli sessions                    # 列出会话

# 模型与配置
pnpm cli models list [provider]
pnpm cli models set openai/gpt-4o
pnpm cli config list
pnpm cli config get llm
pnpm cli config set llm.defaultProvider openai

# 技能
pnpm cli skills search <query>
pnpm cli skills install <slug>
pnpm cli skills list
pnpm cli skills list-optional        # 26 个可选技能
pnpm cli skills install-optional <name>

# MCP（既能当客户端，也能当服务端）
pnpm cli mcp list
pnpm cli mcp external list           # EvoClaw 消费的外部 MCP server
pnpm cli mcp external add firecrawl '{"type":"stdio","command":"npx","args":["-y","firecrawl-mcp"]}'
pnpm cli mcp oauth login <server>    # OAuth（PKCE / device code）
pnpm cli mcp serve                   # 把 EvoClaw 工具以 stdio 暴露给 IDE

# 渠道与安全
pnpm cli channels list
pnpm cli channels capabilities
pnpm cli security audit
pnpm cli secrets list                # 值始终打码
```

完整清单见 `pnpm cli --help`。`--json`、`--profile <name>`、`--dev`、`--log-level`
是全局参数。

## REST API

约 360 条 `/api/*` 路由。代表性的一部分：

| 端点 | 方法 | 用途 |
|---|---|---|
| `/health`、`/api/health` | GET | 存活/就绪检查，含各子系统明细 |
| `/api/auth/login` | POST | 管理员凭证换取 JWT |
| `/api/chat` | POST | 发送消息（软超时会把长任务转后台持久执行） |
| `/api/chat/resume` | POST | 恢复会话 |
| `/api/durable-tasks`、`/api/durable-tasks/:id` | GET | 后台任务状态 |
| `/api/workspace` | GET/POST | 读取或切换运行时工作区 |
| `/api/system/services` | GET | 服务注册表状态 |
| `/api/config/llm`、`/api/config/channels` | GET/PUT | 提供商与渠道配置 |
| `/api/skills` | GET | 已安装技能（公开） |
| `/api/marketplace/search` | GET | 技能市场（公开，只读） |
| `/api/memory/search?q=` | GET | 语义记忆搜索 |
| `/api/evolution/dashboard` | GET | 进化指标 |
| `/api/feature-flags` | GET | 功能开关状态 |
| `/api/kanban/*` | GET/POST | 多 Agent 工作队列 |
| `/metrics` | GET | Prometheus 指标（需鉴权） |

## 配置

`.env` 中的关键变量（完整带注释的清单见 `.env.example`）：

| 变量 | 默认值 | 说明 |
|---|---|---|
| `EvoClaw_PORT` | `27788` | HTTP 端口（注意大小写混写 —— 全大写 `EVOCLAW_PORT` **不会**被读取） |
| `EvoClaw_HOST` | `0.0.0.0` | 绑定地址；仅本机可设 `127.0.0.1` |
| `JWT_SECRET` | — | JWT 签名密钥，**务必修改**；短于 16 字符会打印告警 |
| `WEB_UI_TOKEN` | — | Web UI/API 令牌；留空则关闭令牌鉴权（管理员登录仍然生效） |
| `EVOCLAW_ADMIN_USER` / `EVOCLAW_ADMIN_PASSWORD` | 非生产环境 `admin`/`admin` | `/api/auth/login` 凭证 |
| `CHAT_TIMEOUT_MS` | `360000` | 软超时：存检查点 + 转后台续跑并先返回 `⏳` 回复；`0` 关闭 |
| `EvoClaw_EVOLUTION_ENABLED` | `true` | 进化引擎 |
| `EvoClaw_MCP_ENABLED` | `true` | MCP 协议 |
| `EvoClaw_REST_ENABLED` | `true` | REST API |
| `CORS_ORIGINS` | — | 允许的来源 |
| `RATE_LIMIT_MAX` | `100` | 每个窗口的请求上限 |
| `EVOCLAW_OTLP_ENDPOINT` | — | OTLP/HTTP 追踪导出 |
| `EVOCLAW_MARKETPLACE_REGISTRY_URL` | 镜像站 | 技能市场注册表 |

## 项目结构

```
EvoClaw/
├── apps/
│   ├── server/          # 主入口（EvoClawServer，端口 27788）
│   ├── cli/             # evoclaw / openclaw CLI（53 个命令）
│   └── mcp-server/      # 给 IDE 用的 stdio MCP 桥
├── packages/            # 15 个工作区包（见上表）
├── scripts/             # launch.mjs、vitest 运行器、发布/OSV 工具
├── docs/                # 插件开发指南 + Hermes/OpenSpace 对齐记录
└── data/                # 运行时状态：工作区、技能、会话、检查点
```

## 开发

```bash
pnpm build        # typecheck/test 之前必须先跑
pnpm typecheck
pnpm test         # 396 个文件 / 8036 个测试
pnpm test:watch
pnpm lint         # eslint flat config（仓库存在既有的历史告警）
```

`pnpm dev` 会在每个包里跑 `tsc --watch`，并为 Web UI 启动 Vite。Vite 开发服务器把
`/api` 代理到 `EvoClaw_PORT`（从环境变量或根 `.env` 读取）。

约定：TypeScript strict ESM（NodeNext）、Vitest、禁用 `any`、持久状态一律原子写
（`atomicWriteFileSync`）、cron/会话状态用跨进程锁、注释与文档用中文、提示历史只追加。

## Docker

```bash
docker build -t evoclaw .
docker run -p 27788:27788 --env-file .env evoclaw
```

或用 Compose（默认拉 `ghcr.io/chydroid/evoclaw:latest`）：

```bash
docker compose up -d
```

镜像基于 `node:24-alpine`，暴露 `27788`，对 `/health` 做健康检查。

## 常见问题

| 现象 | 处理 |
|---|---|
| `pnpm: command not found` | `npm install -g pnpm@10`（或 `corepack enable`） |
| `pnpm start` 报 `chcp: not found` | 这是旧版本检出 —— 现在由 `scripts/launch.mjs` 跨平台启动 |
| 端口被占用 | 改 `EvoClaw_PORT`，或 `lsof -i :27788` / `netstat -ano \| findstr :27788` 后结束进程 |
| Web UI 401 或白屏 | 设置 `WEB_UI_TOKEN`（或走 `/api/auth/login` 登录）；看浏览器控制台 |
| `pnpm dev` 时界面接口全失败 | 确认后端跑在 `EvoClaw_PORT` 上；代理目标取自环境变量/`.env` |
| 拉取后构建失败 | `pnpm clean && pnpm install && pnpm build` |
| 浏览器工具不可用 | `pnpm add playwright -F @evoclaw/infrastructure && pnpm exec playwright install chromium` |
| 测试出现 ENOENT 风暴 | 测试清理时不要递归删除临时目录根；详见 `docs/` 中的相关记录 |

## 贡献

欢迎 Issue 与 PR —— 见 [CONTRIBUTING.md](CONTRIBUTING.md)。
提交前请跑 `pnpm build && pnpm typecheck && pnpm test`。

## 安全

漏洞请按 [SECURITY.md](SECURITY.md) 报告。切勿提交 `.env`。

## 许可证

[MIT](LICENSE)

---

详细版本历史见 [CHANGELOG.md](CHANGELOG.md)。
