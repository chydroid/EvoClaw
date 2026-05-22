<p align="center">
    <img src="https://github.com/chydroid/EvoClaw/raw/main/assets/images/evoclaw-400-100.png" alt="EvoClaw" width="400">
</p>
<h1 align="center">EvoClaw</h1>

<p align="center">
  <strong>具备增强式自我进化能力的下一代自主智能体操作系统</strong>
</p>

<p align="center">
  <img src="https://img.shields.io/badge/version-0.4.0-7c3aed?style=flat-square" alt="Version" />
  <img src="https://img.shields.io/badge/node-%3E%3D20.0.0-22c55e?style=flat-square" alt="Node.js" />
  <img src="https://img.shields.io/badge/pnpm-%3E%3D9.0.0-f69220?style=flat-square" alt="pnpm" />
  <img src="https://img.shields.io/badge/typescript-5.x-3178c6?style=flat-square" alt="TypeScript" />
  <img src="https://img.shields.io/badge/license-MIT-8b5cf6?style=flat-square" alt="License" />
</p>

***

## 目录

- [项目简介](#项目简介)
- [核心特性](#核心特性)
- [系统架构](#系统架构)
- [项目结构](#项目结构)
- [环境要求](#环境要求)
- [快速开始](#快速开始)
- [配置说明](#配置说明)
- [使用指南](#使用指南)
  - [命令行界面 (CLI)](#命令行界面-cli)
  - [Web 仪表盘](#web-仪表盘)
  - [REST API](#rest-api)
- [核心系统详解](#核心系统详解)
  - [智能体系统 (Agent)](#智能体系统-agent)
  - [技能系统 (Skills)](#技能系统-skills)
  - [进化引擎 (Evolution)](#进化引擎-evolution)
  - [记忆系统 (Memory)](#记忆系统-memory)
  - [安全治理 (Security)](#安全治理-security)
- [开发指南](#开发指南)
- [测试](#测试)
- [部署](#部署)
- [贡献指南](#贡献指南)
- [许可证](#许可证)

***

## 项目简介

**EvoClaw**（进化龙虾）是一个具备增强式自我进化能力的下一代自主智能体系统。它不仅仅是一个 AI Agent 框架，更是一个能够**自我观察、自我诊断、自我优化、自我进化**的完整智能体运行时环境。

EvoClaw 的核心设计理念源于龙虾的生物学特性——龙虾终其一生都在不断蜕皮生长，不会被环境所束缚。EvoClaw 同样具备这种**持续进化**的能力：通过内置的进化引擎，系统能够从任务执行失败、用户反馈、使用模式等多个维度收集经验，并自动生成改进方案，实现智能体的自主迭代升级。

### 名字由来

> **Evo** = Evolution（进化） + **Claw** = 龙虾之钳

龙虾的钳子既是它捕食的工具，也是它防御的武器。EvoClaw 以此为名，寓意系统既具备强大的**任务执行能力（钳子）**，又拥有持续的**自我进化能力（蜕皮）**。

***

## 核心特性

### 🦞 自主进化

- **进化引擎**: 从失败中学习，自动改进 Skill 和能力
- **遗传算法**: 通过基因引擎产生和筛选最优解决方案
- **强化反馈**: 持续收集运行时反馈，优化智能体表现
- **需求挖掘**: 从使用模式中自动发现新的能力需求
- **热重载**: 支持 Skill 和配置的无停机热更新

### 🧠 多智能体协作

- **Actor 并发模型**: 基于 Actor 模式的高并发智能体通信
- **Agent 池管理**: 动态扩缩容的智能体池
- **DAG 任务编排**: 自动将复杂任务拆解为有向无环图并行执行
- **动态 DAG 构建**: 运行时自适应调整任务执行计划

### 📦 技能生态系统

- **SKILL.md 标准**: 基于 Markdown 的统一技能描述格式
- **技能市场**: 接入 ClawHub 全球技能注册中心
- **沙箱执行**: 安全的技能隔离运行环境
- **声明式触发器**: 基于关键词、意图、定时、事件、Webhook 的多模式触发

### 🔐 企业级安全

- **RBAC 权限管理**: 基于角色的访问控制
- **多租户隔离**: 完善的租户数据和工作区隔离
- **安全审计**: 全链路操作审计和异常检测
- **自愈系统**: 运行时故障自动检测与恢复
- **速率限制**: API 级别的流量控制和保护

### 🧩 可扩展架构

- **IoC 依赖注入**: 基于服务注册中心的松耦合设计
- **事件驱动**: 基于 EventBus 的发布-订阅模式
- **插件系统**: 支持动态加载和卸载功能插件
- **MCP 协议**: 集成 Model Context Protocol 协议支持
- **多协议网关**: 统一接入 REST / WebSocket / MCP 多种协议

### 💾 多维记忆

- **短期记忆**: 会话级上下文保持
- **长期记忆**: 跨会话的知识积累
- **知识图谱**: 结构化关系网络
- **向量记忆**: 基于语义相似度的检索

### 🔄 智能 Agent Loop

- **错误分类与恢复**: 自动识别 context_overflow / rate_limit / auth / billing 等 7 种错误类型，触发不同恢复路径
- **自动 Compaction**: 接近上下文限制时自动压缩对话历史，保留关键摘要
- **会话持久化**: JSONL 格式的会话记录，支持跨重启恢复
- **Provider 故障转移**: LLM 提供商出错时自动轮换到下一个配置

### 🖥️ 增强式 Web 控制台

- **系统仪表盘**: 实时 Health / Sessions / Providers / Skills Overview 总览，30s 自动刷新
- **Bootstrap 编辑器**: 在线编辑 AGENTS.md / SOUL.md / TOOLS.md / IDENTITY.md
- **对话增强**: 打字指示器、Token 消耗统计、错误类型可视化
- **Web 仪表盘**: 9 个功能标签页的完整可视化管理界面
- **CLI 命令行**: 涵盖 30+ 子命令的完整终端工具
- **斜杠命令**: Web Chat 内置的快捷指令系统

***

## 系统架构

```
┌─────────────────────────────────────────────────────────────┐
│                        EvoClaw Server                        │
├─────────────────────────────────────────────────────────────┤
│  ┌─────────┐  ┌──────────┐  ┌───────────┐  ┌────────────┐  │
│  │ Gateway │  │   Web UI  │  │    CLI    │  │  IDE Bridge │  │
│  │ (REST/  │  │  (React)  │  │ (Node.js) │  │   (ACP)     │  │
│  │  WS/MCP)│  │           │  │           │  │             │  │
│  └────┬────┘  └─────┬─────┘  └─────┬─────┘  └──────┬──────┘  │
│       └──────────────┴─────────────┴───────────────┘         │
│                          │                                    │
│                   ┌──────▼──────┐                            │
│                   │  EventBus   │  事件总线                   │
│                   └──────┬──────┘                            │
│                          │                                    │
│         ┌────────────────┼────────────────┐                  │
│         │                │                │                  │
│  ┌──────▼──────┐ ┌──────▼──────┐ ┌──────▼──────┐           │
│  │   Agent     │ │  Evolution  │ │   Memory    │           │
│  │  ┌────────┐ │ │  ┌────────┐ │ │  ┌────────┐ │           │
│  │  │Actor   │ │ │  │Genetic │ │ │  │Short   │ │           │
│  │  │System  │ │ │  │Engine  │ │ │  │Term    │ │           │
│  │  │Pool    │ │ │  │Eval    │ │ │  │Long    │ │           │
│  │  │DAG Exec│ │ │  │Proposer│ │ │  │Vector  │ │           │
│  │  │Orch.   │ │ │  │Feedback│ │ │  │KG      │ │           │
│  │  └────────┘ │ │  └────────┘ │ │  └────────┘ │           │
│  └──────┬──────┘ └──────┬──────┘ └──────┬──────┘           │
│         │                │                │                  │
│  ┌──────▼──────┐ ┌──────▼──────┐ ┌──────▼──────┐           │
│  │   Skills    │ │  Security   │ │Infrastruct. │           │
│  │  ┌────────┐ │ │  ┌────────┐ │ │  ┌────────┐ │           │
│  │  │Manager │ │ │  │Governor│ │ │  │Logger  │ │           │
│  │  │Registry│ │ │  │RBAC    │ │ │  │DB      │ │           │
│  │  │Sandbox │ │ │  │Audit   │ │ │  │MQ      │ │           │
│  │  │Parser  │ │ │  │Healing │ │ │  │FS      │ │           │
│  │  └────────┘ │ │  │Tenant  │ │ │  │Process │ │           │
│  └─────────────┘ │  └────────┘ │ │  └────────┘ │           │
│                  └─────────────┘ └─────────────┘           │
│                                                             │
│  ┌──────────────────────────────────────────────────────┐  │
│  │                ServiceRegistry (IoC)                  │  │
│  └──────────────────────────────────────────────────────┘  │
└─────────────────────────────────────────────────────────────┘
```

### 核心设计模式

| 模式                    | 应用               | 说明                     |
| --------------------- | ---------------- | ---------------------- |
| **IoC / DI**          | ServiceRegistry  | 所有服务通过注册中心进行依赖注入，实现松耦合 |
| **Event-Driven**      | EventBus         | 服务间通过发布-订阅模式异步通信       |
| **Actor Model**       | ActorSystem      | 智能体间通过消息传递进行并发协作       |
| **DAG Orchestration** | DAGExecutor      | 复杂任务自动拆解为有向无环图并行调度     |
| **Observer**          | EvolutionEngine  | 进化引擎通过观察系统行为触发改进       |
| **Strategy**          | Gateway          | 网关支持多协议策略切换            |
| **Pool**              | AgentPoolManager | 智能体实例池化管理，动态扩缩容        |

***

## 项目结构

```
EvoClaw/
├── apps/                          # 应用程序
│   ├── cli/                       # CLI 命令行工具
│   │   └── src/index.ts           # 30+ 子命令的完整 CLI 实现
│   └── server/                    # 主服务器入口
│       └── src/index.ts           # EvoClawServer 启动与编排
│
├── packages/                      # 核心包 (Monorepo)
│   ├── core/                      # 核心类型与基础设施
│   │   └── src/
│   │       ├── types/             # 类型定义
│   │       │   ├── agent.ts       # 智能体类型
│   │       │   ├── task.ts        # 任务与 DAG 类型
│   │       │   ├── skill.ts       # 技能声明与清单
│   │       │   ├── evolution.ts   # 进化周期与候选方案
│   │       │   ├── memory.ts      # 记忆系统类型
│   │       │   ├── security.ts    # 安全治理类型
│   │       │   ├── event.ts       # 事件系统类型
│   │       │   ├── plugin.ts      # 插件系统类型
│   │       │   └── mcp.ts         # MCP 协议类型
│   │       ├── config.ts          # 配置管理器
│   │       ├── event-bus.ts       # 事件总线
│   │       └── service-registry.ts # IoC 服务注册中心
│   │
│   ├── agent/                     # 智能体引擎
│   │   └── src/
│   │       ├── actor-system.ts    # Actor 并发模型
│   │       ├── agent-pool.ts      # 智能体资源池
│   │       ├── dag-executor.ts    # DAG 执行器
│   │       ├── dynamic-dag-builder.ts # 动态 DAG 构建
│   │       ├── task-orchestrator.ts   # 任务编排器
│   │       ├── task-planner.ts        # 任务规划器 (6 种项目模板)
│   │       ├── agent-model-executor.ts # 模型执行器 (Agent Loop)
│   │       ├── system-prompt.ts       # 模块化 System Prompt 构建器
│   │       └── error-classifier.ts    # LLM 错误分类与恢复路径
│   │
│   ├── intelligence/              # 智能决策系统
│   │   └── src/
│   │       ├── task-classifier.ts     # 10 类意图分类器
│   │       └── skill-orchestrator.ts  # DAG 多技能编排器
│   │
│   ├── evolution/                 # 进化引擎
│   │   └── src/
│   │       ├── evolution-engine.ts    # 进化引擎核心
│   │       ├── genetic-engine.ts      # 遗传算法引擎
│   │       ├── evolution-evaluator.ts # 进化评估器
│   │       ├── evolution-proposer.ts  # 进化提案生成
│   │       ├── reinforcement-feedback.ts # 强化反馈
│   │       ├── experience-analyzer.ts # 经验分析器
│   │       ├── requirement-miner.ts   # 需求挖掘
│   │       └── hot-reload-manager.ts  # 热重载管理
│   │
│   ├── memory/                    # 记忆系统
│   │   └── src/
│   │       ├── memory-hub.ts      # 记忆中心
│   │       ├── short-term-memory.ts   # 短期记忆
│   │       ├── long-term-memory.ts    # 长期记忆
│   │       ├── vector-memory.ts       # 向量记忆
│   │       └── knowledge-graph.ts     # 知识图谱
│   │
│   ├── skills/                    # 技能系统
│   │   └── src/
│   │       ├── skill-manager.ts   # 技能管理器
│   │       ├── skill-registry.ts  # 技能注册表
│   │       ├── skill-lifecycle.ts # 技能生命周期
│   │       ├── skill-md-parser.ts # SKILL.md 解析器
│   │       ├── skill-resolver.ts  # 技能依赖解析
│   │       └── skill-sandbox.ts   # 技能沙箱
│   │
│   ├── security/                  # 安全治理
│   │   └── src/
│   │       ├── security-governor.ts   # 安全总督
│   │       ├── rbac-manager.ts        # 角色权限管理
│   │       ├── audit-center.ts        # 审计中心
│   │       ├── anomaly-detector.ts    # 异常检测
│   │       ├── rate-limiter.ts        # 速率限制
│   │       ├── tenant-manager.ts      # 多租户管理
│   │       └── self-healing.ts        # 自愈系统
│   │
│   ├── gateway/                   # 网关服务
│   │   └── src/
│   │       ├── gateway-server.ts  # 网关服务器
│   │       ├── mcp-gateway.ts     # MCP 协议网关
│   │       ├── mcp-transport.ts   # MCP 传输层
│   │       ├── protocol-adapter.ts # 协议适配器
│   │       └── auth-provider.ts   # 认证提供者
│   │
│   ├── infrastructure/            # 基础设施
│   │   └── src/
│   │       ├── logger.ts          # 日志系统
│   │       ├── database-manager.ts # 数据库管理
│   │       ├── message-queue.ts   # 消息队列
│   │       ├── filesystem-manager.ts # 文件系统管理
│   │       └── process-manager.ts # 进程管理
│   │
├── packages/                      # 智能功能包
│   ├── email/                     # 邮件服务
│   │   └── src/email-client.ts    # NodeMailer 邮件客户端
│   ├── scheduler/                 # 定时调度
│   │   └── src/schedule-manager.ts # Cron 定时任务管理
│   └── reporting/                 # 报告生成
│       └── src/report-generator.ts # HTML 报告生成

│   └── web-ui/                    # Web 仪表盘
│       └── src/
│           ├── App.tsx            # 主应用 (9 标签页)
│           ├── Dashboard.tsx      # 系统仪表盘
│           ├── BootstrapEditor.tsx # Bootstrap 文件编辑器
│           ├── main.tsx           # React 入口
│           ├── CLITerminal.tsx    # 内嵌 CLI 终端
│           ├── ChannelConfig.tsx  # 频道配置
│           ├── EvolutionDashboard.tsx # 进化仪表盘
│           ├── LLMConfig.tsx      # LLM 配置界面
│           ├── SkillsConfig.tsx   # 技能配置界面
│           ├── theme.ts           # 主题系统 (深色/浅色)
│           └── highlight.ts       # 代码高亮
│
├── examples/                      # 示例 Skill
│   └── weather-reporter.SKILL.md  # 天气查询 Skill 示例
│
├── assets/                        # 静态资源
│   ├── images/                    # 项目图标与 Logo
│   │   ├── favicon.ico            # 网站图标 (ICO)
│   │   ├── favicon-16x16.png      # 16x16 网站图标
│   │   ├── favicon-32x32.png      # 32x32 网站图标
│   │   ├── favicon-48x48.png      # 48x48 网站图标
│   │   ├── apple-touch-icon.png   # iOS Home Screen 图标
│   │   ├── android-chrome-192x192.png # Android/PWA 图标 (192x192)
│   │   └── android-chrome-512x512.png # Android/PWA 图标 (512x512)
│   └── html-head-tags.txt         # HTML 头部标签模板
│
├── .github/workflows/ci.yml      # CI/CD 配置
├── package.json                   # 根包配置 (pnpm workspace)
├── pnpm-workspace.yaml            # pnpm 工作区配置
├── tsconfig.base.json             # 共享 TypeScript 配置
├── vitest.config.ts               # 测试配置
├── DEPLOYMENT_GUIDE.md            # 部署指南
└── .env.example                   # 环境变量模板
```

***

## 环境要求

| 依赖             | 最低版本      | 说明                    |
| -------------- | --------- | --------------------- |
| **Node.js**    | >= 22.0.0 | JavaScript 运行时        |
| **pnpm**       | >= 9.0.0  | 包管理器 (Monorepo 工作区支持) |
| **TypeScript** | 5.x       | 类型安全开发语言              |

可选依赖:

- **Git** — 版本控制与 Skill 仓库克隆
- **LLM API Key** — OpenAI / Anthropic / DeepSeek 等任意兼容 API

***

## 快速开始

### 1. 克隆项目

```bash
git clone https://github.com/chydroid/EvoClaw.git
cd EvoClaw
```

### 2. 安装依赖

```bash
pnpm install
```

### 3. 配置环境变量

```bash
cp .env.example .env
```

编辑 `.env` 文件，填入必要的配置:

```env
# 服务器配置
EvoClaw_PORT=17788
EvoClaw_HOST=0.0.0.0

# JWT 密钥 (生产环境务必改为至少16位随机字符串!)
JWT_SECRET=change-me-to-a-random-secret-min-16-chars

# 进化引擎
EvoClaw_EVOLUTION_ENABLED=true

# MCP 协议
EvoClaw_MCP_ENABLED=true

# REST API
EvoClaw_REST_ENABLED=true
```

### 4. 构建项目

```bash
pnpm build
```

### 5. 启动服务器

```bash
# 方式一：通过 pnpm script（推荐，自动设置 UTF-8 编码）
pnpm start

# 方式二：直接运行（Windows 用户需先执行 chcp 65001 避免中文乱码）
node --env-file=.env apps/server/dist/index.js

# 方式三：Windows 批处理脚本
start.bat
```

> **Windows 用户注意**：如果终端中文显示乱码，是因为 Windows 默认代码页为 GBK (936)，而项目使用 UTF-8 编码。使用 `pnpm start` 或 `start.bat` 会自动设置代码页为 UTF-8 (65001)。

启动成功后将看到:

```
============================================
  EvoClaw v0.2.0 - Self-Evolving Agent OS
============================================

[EvoClaw] Starting all services...
[EvoClaw] Gateway server starting...
[EvoClaw] Agent pool initialized
[EvoClaw] Skill manager ready
[EvoClaw] Evolution engine online
[EvoClaw] Memory hub active
[EvoClaw] Security governor engaged
[EvoClaw] Audit center online
[EvoClaw] Tenant manager ready
[EvoClaw] Self-healing monitor starting...

[EvoClaw] All systems ready!
============================================
```

### 6. 打开 Web 仪表盘

在浏览器中访问 `http://localhost:17788 `即可进入 EvoClaw Web 管理界面。

### 7. 使用 CLI

```bash
# 方式一：通过 pnpm script
pnpm cli --help

# 方式二：全局安装后直接使用
EvoClaw --help
EvoClaw setup
EvoClaw health
```

***

## 配置说明

EvoClaw采用**环境变量 + Web UI 双层配置**体系：

| 配置层       | 存储位置      | 管理方式                   | 适用场景                  |
| --------- | --------- | ---------------------- | --------------------- |
| **环境变量**  | `.env` 文件 | 手动编辑 / `EvoClaw setup` | 服务器端口、密钥、功能开关         |
| **运行时配置** | 服务器内存     | Web UI → LLM 标签        | LLM API Key、模型选择、频道配置 |

### 关键环境变量

| 变量                          | 默认值       | 说明                  |
| --------------------------- | --------- | ------------------- |
| `EvoClaw_PORT`              | `3000`    | 服务器监听端口             |
| `EvoClaw_HOST`              | `0.0.0.0` | 绑定地址                |
| `JWT_SECRET`                | -         | JWT 签名密钥 (生产环境必须修改) |
| `EvoClaw_EVOLUTION_ENABLED` | `true`    | 是否启用进化引擎            |
| `EvoClaw_MCP_ENABLED`       | `true`    | 是否启用 MCP 协议         |
| `EvoClaw_REST_ENABLED`      | `true`    | 是否启用 REST API       |

### LLM 配置

通过 Web 仪表盘的 **LLM 标签页**配置 AI 模型连接。支持的模型提供商:

- **OpenAI**: gpt-4o, gpt-4o-mini, gpt5.5
- **Anthropic**: claude-4-opus等
- **DeepSeek**: deepseek-v4-flash, deepseek-v4-pro
- **本地模型**: llama3, mistral, qwen3, gramma等

***

## 使用指南

### 命令行界面 (CLI)

EvoClaw 提供了丰富的 CLI 命令，涵盖系统管理的各个方面。

#### 安装与入门

```bash
EvoClaw setup              # 创建基础配置和工作区
EvoClaw onboard            # 完整引导式入门流程
EvoClaw dashboard          # 打开 Web 仪表盘
EvoClaw doctor [--fix]     # 系统诊断与自检
```

#### 健康与状态

```bash
EvoClaw health [--json]    # 健康检查
EvoClaw status [--all]     # 运行状态
EvoClaw sessions           # 会话管理
```

#### 智能体与消息

```bash
EvoClaw agent -m <msg>     # 运行 Agent
EvoClaw agents list        # 管理 Agent 列表
EvoClaw message send       # 发送消息
```

#### 技能管理

```bash
EvoClaw skills search <q>  # 搜索 Skill
EvoClaw skills install <s> # 安装 Skill
EvoClaw skills list        # 列出已安装 Skill
EvoClaw skills update      # 更新 Skill
```

#### 模型管理

```bash
EvoClaw models list        # 列出可用模型
EvoClaw models set <id>    # 切换默认模型
EvoClaw models scan        # 扫描可用模型
EvoClaw models auth        # API Key 认证管理
```

#### 网关与系统

```bash
EvoClaw gateway start      # 启动网关
EvoClaw gateway status     # 网关状态
EvoClaw logs [--follow]    # 查看日志
EvoClaw system events      # 系统事件
```

#### 频道与安全

```bash
EvoClaw channels list      # 频道管理
EvoClaw security audit     # 安全审计
EvoClaw secrets list       # 密钥管理
EvoClaw approvals get      # 执行审批
```

#### 定时任务与自动化

```bash
EvoClaw cron list          # 定时任务列表
EvoClaw cron add           # 添加定时任务
EvoClaw webhooks gmail     # Webhook 管理
```

#### 插件与 MCP

```bash
EvoClaw plugins list       # 插件列表
EvoClaw plugins install    # 安装插件
EvoClaw mcp list           # MCP 服务器列表
```

### Web 仪表盘

Web 仪表盘提供了直观的可视化管理界面，包含以下功能标签:

| 标签            | 功能                                |
| ------------- | --------------------------------- |
| **Chat**      | 对话式 AI 交互，支持打字指示器、Token 统计、错误类型显示 |
| **Dashboard** | 系统仪表盘：Health / Sessions / Providers / Skills / Bootstrap |
| **Skills**    | 已安装技能列表，包含成功率统计与技能市场入口            |
| **Bootstrap** | 在线编辑 AGENTS.md / SOUL.md / TOOLS.md / IDENTITY.md |
| **Services**  | 所有已注册服务运行状态实时监控                   |
| **Evolution** | 进化引擎仪表盘，查看进化周期与任务                 |
| **LLM**       | LLM 模型配置、API Key 管理               |
| **Channels**  | 频道配置与连接管理                         |
| **CLI**       | 内嵌命令行终端                           |

#### 斜杠命令 (在 Chat 中使用)

```
/help         显示所有可用命令
/clear        清空当前会话
/new [模型]   开始新会话
/compact      压缩会话上下文
/status       系统状态查看
/health       健康检查
/model [名称] 查看或切换模型
/skills       列出已安装 Skill
/memory <查询> 语义记忆搜索
/cron list    查看定时任务
/plugin list  查看插件
```

### REST API

EvoClaw 通过统一的 RESTful API 暴露所有功能:

| 端点                         | 方法   | 说明        |
| -------------------------- | ---- | --------- |
| `/api/health`              | GET  | 健康检查      |
| `/api/chat`                | POST | 发送对话消息    |
| `/api/skills`              | GET  | 获取已安装技能列表 |
| `/api/system/services`     | GET  | 获取服务运行状态  |
| `/api/config/llm`          | GET  | 获取 LLM 配置 |
| `/api/config/channels`     | GET  | 获取频道配置    |
| `/api/memory/search?q=`    | GET  | 语义记忆搜索    |
| `/api/evolution/dashboard` | GET  | 进化引擎仪表盘数据 |
| `/api/system/audit`        | GET  | 安全审计日志    |
| `/api/persona/greeting`    | GET  | 获取个性欢迎语   |

***

## 核心系统详解

### 智能体系统 (Agent)

智能体系统是 EvoClaw 的任务执行核心，负责接收、拆解、调度和执行各类任务。

#### Actor 并发模型

每个智能体作为独立的 Actor 运行，通过异步消息传递进行通信，天然支持高并发场景:

```typescript
// Actor 消息结构
interface ActorMessage {
  type: string;         // 消息类型
  sender: string;       // 发送者 ID
  recipient: string;    // 接收者 ID
  payload: unknown;     // 消息负载
  correlationId: string; // 关联 ID
  timestamp: Date;      // 时间戳
}
```

#### DAG 任务编排

复杂任务自动拆解为有向无环图 (DAG)，并行执行无依赖节点:

```
Task: "分析财报并生成报告"
  │
  ├─→ [读取财报数据] ──→ [提取关键指标] ──┐
  │                                        ├─→ [生成报告]
  └─→ [查询行业基准] ──→ [对比分析]   ────┘
```

#### Agent 角色体系

| 角色             | 职责      |
| -------------- | ------- |
| `orchestrator` | 任务编排与调度 |
| `executor`     | 具体任务执行  |
| `analyst`      | 数据分析与报告 |
| `observer`     | 系统状态监控  |
| `custom`       | 自定义角色   |

### 技能系统 (Skills)

技能系统基于 **SKILL.md** 标准，是一种声明式的 AI 能力描述格式。

#### SKILL.md 格式

````markdown
---
name: weather-reporter
version: 1.2.0
description: Fetch and report weather information
author: EvoClaw Team
triggers:
  - type: keyword
    pattern: "weather|temperature|forecast"
  - type: intent
    pattern: "check_weather"
requires:
  - name: weather-api
    version: ">=2.0.0"
config:
  apiEndpoint: "https://api.weather.com"
  units: "metric"
---

## Instructions
To fetch weather data...

## Scripts
```typescript
export async function fetchWeather(location: string) { ... }
````

## Examples

User: "What's the weather in Tokyo?"
...

```

#### 技能生命周期

```

Install → Activate → Execute → Deactivate → Update → Uninstall
│                                              │
└──────────── Error → Recovery ────────────────┘

````

#### 触发器类型

| 类型 | 说明 | 示例 |
|------|------|------|
| `keyword` | 关键词匹配 | "weather", "calculate" |
| `intent` | 意图识别 | "check_weather" |
| `schedule` | 定时触发 | "0 9 * * *" |
| `event` | 系统事件 | "system.starting" |
| `webhook` | Webhook 回调 | GitHub push events |

#### 技能市场

通过 ClawHub 发现和安装社区技能:

- 🌐 **国际站**: [clawhub.ai](https://clawhub.ai)
- 🇨🇳 **国内镜像**: [cn.clawhub-mirror.com](https://cn.clawhub-mirror.com)

```bash
EvoClaw skills search "weather"
EvoClaw skills install weather-reporter
EvoClaw skills list
````

### 进化引擎 (Evolution)

进化引擎是 EvoClaw 最核心的差异化能力，实现了 AI 系统的自主进化。

#### 进化循环流水线

```
触发源                          进化流程                          产出
───────                        ─────────                        ────
Task Failure  ──┐
User Feedback ──┤              ┌──────────┐
Usage Pattern ──┼──→ RequirementMiner     │
Performance   ──┘              └────┬─────┘
                                     │
                              ┌──────▼──────┐
                              │ GeneticEngine│ ← 生成候选方案
                              └──────┬──────┘
                                     │
                              ┌──────▼──────┐
                              │  Evaluator   │ ← 评估与筛选
                              └──────┬──────┘
                                     │
                              ┌──────▼──────┐
                              │  Publisher   │ ← 发布改进
                              └──────┬──────┘
                                     │
                    ┌────────────────┼────────────────┐
                    │                │                │
              New Skill       Skill Update      Config Change
```

#### 进化评估维度

| 维度        | 评估内容                           |
| --------- | ------------------------------ |
| **测试通过率** | 单元测试 / 集成测试覆盖率                 |
| **安全审计**  | 漏洞扫描、代码注入检测                    |
| **性能影响**  | CPU / 内存 / 延迟增量                |
| **风险等级**  | low → medium → high → critical |

#### 候选方案类型

- `new_skill` — 生成全新的技能
- `skill_update` — 改进现有技能
- `code_patch` — 代码补丁修正
- `config_change` — 配置参数优化

#### 热重载策略

| 策略          | 说明          |
| ----------- | ----------- |
| `immediate` | 立即切换        |
| `graceful`  | 等待当前任务完成后切换 |
| `ab_test`   | A/B 分流测试    |
| `canary`    | 金丝雀灰度发布     |

### 记忆系统 (Memory)

| 记忆层      | 存储    | 生命周期 | 检索方式     |
| -------- | ----- | ---- | -------- |
| **短期记忆** | 会话上下文 | 单次会话 | 时间顺序     |
| **长期记忆** | 持久化存储 | 跨会话  | 关键词 / 语义 |
| **向量记忆** | 向量数据库 | 持久化  | 语义相似度    |
| **知识图谱** | 图数据库  | 持久化  | 关系遍历     |

```bash
EvoClaw memory status        # 记忆状态
EvoClaw memory search <q>    # 语义搜索
EvoClaw memory index --force # 重建索引
```

### 安全治理 (Security)

| 组件                     | 功能        |
| ---------------------- | --------- |
| **SecurityGovernor**   | 安全策略集成与协调 |
| **RBACManager**        | 基于角色的访问控制 |
| **AuditCenter**        | 全链路操作审计   |
| **AnomalyDetector**    | 异常行为检测    |
| **RateLimiter**        | API 速率限制  |
| **TenantManager**      | 多租户数据隔离   |
| **SelfHealingManager** | 运行时故障自愈   |

```bash
EvoClaw security audit --deep   # 深度安全审计
EvoClaw security audit --fix    # 自动修复安全问题
```

***

## 开发指南

### 项目脚本

```bash
# 构建所有包
pnpm build

# 启动服务器
pnpm start

# 开发模式 (各包独立构建)
pnpm dev

# 类型检查
pnpm typecheck

# 运行测试
pnpm test

# 代码检查
pnpm lint

# 启动 CLI
pnpm cli --help
```

### Monorepo 工作流

本项目使用 pnpm workspace 管理多包:

```yaml
# pnpm-workspace.yaml
packages:
  - "packages/*"
  - "apps/*"
```

| 包名                        | npm 名称                    | 说明        |
| ------------------------- | ------------------------- | --------- |
| `packages/core`           | `@evoclaw/core`           | 核心类型与基础设施 |
| `packages/agent`          | `@evoclaw/agent`          | 智能体引擎 + System Prompt + 错误分类 |
| `packages/intelligence`   | `@evoclaw/intelligence`   | 意图分类 + 多技能编排 |
| `packages/evolution`      | `@evoclaw/evolution`      | 进化引擎      |
| `packages/memory`         | `@evoclaw/memory`         | 记忆系统      |
| `packages/skills`         | `@evoclaw/skills`         | 技能系统      |
| `packages/security`       | `@evoclaw/security`       | 安全治理      |
| `packages/gateway`        | `@evoclaw/gateway`        | 网关服务      |
| `packages/infrastructure` | `@evoclaw/infrastructure` | 基础设施      |
| `packages/email`          | `@evoclaw/email`          | 邮件客户端     |
| `packages/scheduler`      | `@evoclaw/scheduler`      | 定时调度      |
| `packages/reporting`      | `@evoclaw/reporting`      | 报告生成      |
| `packages/web-ui`         | `@evoclaw/web-ui`         | Web 仪表盘    |
| `apps/cli`                | `@evoclaw/cli`            | CLI 工具     |
| `apps/server`             | `@evoclaw/server`         | 服务器入口     |

### 添加新 Skill

在 `skills/` 目录下创建一个以技能名命名的文件夹，包含 `SKILL.md` 文件:

```bash
mkdir -p skills/my-skill
```

```markdown
<!-- skills/my-skill/SKILL.md -->
---
name: my-skill
version: 1.0.0
description: 我的自定义技能
author: 开发者
triggers:
  - type: keyword
    pattern: "my-skill"
---

## Instructions
技能执行指令...

## Examples
示例对话...
```

### Web UI 开发

```bash
cd packages/web-ui
pnpm dev        # 启动 Vite 开发服务器
```

Web UI 使用 React + Vite 构建，支持热模块替换 (HMR)。

***

## 测试

```bash
# 运行所有测试
pnpm test

# 运行特定包的测试
pnpm --filter @evoclaw/core test
pnpm --filter @evoclaw/evolution test
```

测试框架: **Vitest**

测试文件遵循 `*.test.ts` 命名约定，与被测代码放在同一目录下:

- `packages/core/src/event-bus.test.ts`
- `packages/core/src/service-registry.test.ts`
- `packages/core/src/config.test.ts`
- `packages/agent/src/error-classifier.test.ts`
- `packages/evolution/src/evolution-engine.test.ts`
- `packages/evolution/src/genetic-engine.test.ts`
- `packages/memory/src/short-term-memory.test.ts`
- `packages/memory/src/knowledge-graph.test.ts`
- `packages/memory/src/vector-memory.test.ts`
- `packages/security/src/rbac-manager.test.ts`
- `packages/skills/src/skill-md-parser.test.ts`
- `packages/skills/src/integration.test.ts`

***

## 部署

完整的部署文档请参见 [DEPLOYMENT\_GUIDE.md](DEPLOYMENT_GUIDE.md)。

### 支持的平台

| 平台                   | 状态     |
| -------------------- | ------ |
| Ubuntu Server 22.04+ | ✅ 完整支持 |
| Debian 12+           | ✅ 完整支持 |
| macOS                | ✅ 完整支持 |
| Windows Server       | ✅ 支持   |

### CI/CD

项目使用 GitHub Actions 进行持续集成，配置文件位于 `.github/workflows/ci.yml`:

- **触发条件**: `main` / `develop` 分支的 push 和 PR
- **Node 版本**: 20.x, 22.x 矩阵测试
- **步骤**: Install → TypeCheck → Build → Test → Lint

***

## 贡献指南

我们欢迎任何形式的贡献！以下是一些参与方式:

### 贡献方式

1. **报告 Bug**: 通过 Issue 提交详细的 Bug 报告
2. **功能建议**: 分享你对新功能的想法
3. **代码贡献**: Fork 项目，创建分支，提交 PR
4. **文档改进**: 完善文档、修复拼写、添加示例
5. **Skill 贡献**: 开发并分享你的自定义 Skill 到 ClawHub

### 开发流程

```bash
# 1. Fork 项目
# 2. 创建特性分支
git checkout -b feature/my-feature

# 3. 开发与测试
pnpm install
pnpm typecheck
pnpm test

# 4. 提交代码
git commit -m "feat: add my feature"

# 5. 推送并创建 PR
git push origin feature/my-feature
```

### 代码风格

- 使用 TypeScript 严格模式
- 遵循现有代码风格和命名约定
- 为新功能编写测试
- 确保 `pnpm typecheck` 和 `pnpm test` 通过

***

## 许可证

本项目基于 [MIT License](LICENSE) 开源。

***

<p align="center">
  <sub>Made with 🦞 by the EvoClaw Team</sub>
</p>

<p align="center">
  <sub>龙虾蜕壳，终成大器。EvoClaw 永不止步于进化之路。</sub>
</p>
