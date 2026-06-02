[English](README.md) | [中文](README.zh-CN.md)

---

<p align="center">
  <img src="https://github.com/chydroid/EvoClaw/raw/main/assets/images/evoclaw-400-100.png" alt="EvoClaw" width="420">
</p>

<h1 align="center">EvoClaw</h1>

<p align="center">
  <strong>具备增强式自我进化能力的下一代自主智能体操作系统</strong><br>
  The Self-Evolving Agent Operating System
</p>

<p align="center">
  <img src="https://img.shields.io/badge/version-0.9.6-7c3aed?style=flat-square" alt="Version" />
  <img src="https://img.shields.io/badge/node-%3E%3D20.0.0-22c55e?style=flat-square" alt="Node.js" />
  <img src="https://img.shields.io/badge/pnpm-%3E%3D9.0.0-f69220?style=flat-square" alt="pnpm" />
  <img src="https://img.shields.io/badge/typescript-5.x-3178c6?style=flat-square" alt="TypeScript" />
  <img src="https://img.shields.io/badge/license-MIT-8b5cf6?style=flat-square" alt="License" />
  <img src="https://img.shields.io/badge/tests-1795%20passed-brightgreen?style=flat-square" alt="Tests" />
</p>

<p align="center">
  <a href="#快速开始">快速开始</a> · <a href="#文档">文档</a> · <a href="#架构">架构</a> · <a href="#贡献指南">贡献指南</a>
</p>

---

## EvoClaw 是什么？

EvoClaw 不仅仅是又一个 AI Agent 框架——它是一个**自我进化的智能体操作系统**，能够自主观察、诊断、优化和进化自身。

灵感源于生物蜕壳原理（龙虾通过蜕壳实现无限生长），EvoClaw 践行**持续进化**理念：内置进化引擎从任务失败、用户反馈和使用模式中收集经验，自动生成改进提案——让你的 Agent 无需人工干预即可迭代升级。

### 为什么选择 EvoClaw？

| | 传统 Agent 框架 | EvoClaw |
|---|---|---|
| **进化能力** | 仅支持手动更新 | 自观察、自诊断、自优化 |
| **架构** | 单 Agent 或静态流水线 | Actor 模型 + DAG 编排 + 动态扩缩 |
| **技能** | 硬编码能力 | SKILL.md 标准 + ClawHub 市场 + 自动发现 |
| **安全** | 基础认证 | RBAC + 多租户隔离 + 自愈 + 审计 |
| **记忆** | 仅会话级 | 多层：短期 / 长期 / 向量 / 知识图谱 |
| **可观测性** | 仅日志 | Prometheus 指标 + 分布式追踪 + 健康聚合 |

### 核心数据

| | |
|---|---|
| **17** | Monorepo 包（core、agent、evolution、memory、skills、security、gateway...） |
| **16** | 内置功能开关，支持运行时切换 |
| **30+** | CLI 子命令 |
| **20+** | Web UI 管理页面 |
| **50+** | REST API 端点 |
| **1795** | 测试用例通过 |
| **4** | LLM 提供商类型（OpenAI / Anthropic / DeepSeek / 本地） |
| **5** | 进化质量保障约束门 |

---

## 核心特性

### 🧬 自进化引擎

EvoClaw 的皇冠明珠。进化引擎闭环：失败 → 分析 → 提案 → 验证 → 部署：

- **需求挖掘器** — 从使用模式中发现新能力需求
- **遗传引擎** — 生成并选择最优方案候选
- **评估器** — 多维度评估（测试、安全、性能、风险）
- **约束门** — 5 门验证：大小 / 描述 / 语义 / 兼容性 / 瞬态故障
- **热重载** — 零停机技能和配置更新（即时 / 优雅 / 金丝雀 / A/B）

### 🧠 多 Agent 协作

- **Actor 并发模型** — 每个 Agent 作为独立 Actor 运行，异步消息传递
- **Agent 池** — 动态扩缩 Agent 池，带健康评分
- **DAG 编排** — 自动任务分解为有向无环图，并行执行
- **降级链** — 提供商故障转移 + 认证轮换 + 基于健康的路由

### 📦 技能生态

- **SKILL.md 标准** — 基于 Markdown 的声明式技能描述格式，兼容 OpenClaw/ClawHub
- **ClawHub 市场** — 全球技能注册中心 [clawhub.ai](https://clawhub.ai) / [cn.clawhub-mirror.com](https://cn.clawhub-mirror.com)
- **沙箱执行** — 隔离技能运行时（Docker / SSH / 进程后端）
- **多模式触发** — 关键词 / 意图 / 定时 / 事件 / Webhook
- **渐进索引** — 三级加载：L0(~20t) / L1(~200t) / L2(~1000+t)

### 🔐 企业级安全

- **RBAC** — 基于角色的细粒度访问控制
- **多租户隔离** — 完整的数据和工作空间隔离
- **安全审计** — 全链路操作审计和异常检测
- **自愈机制** — 运行时故障自动检测和恢复
- **速率限制** — API 级别流量控制和防护
- **设备配对** — RSA 公钥 + 挑战签名认证
- **Webhook 验证** — HMAC-SHA256 签名校验
- **内容守卫** — SSRF 防护 + 内容安全过滤

### 💾 多维记忆

| 层级 | 存储 | 生命周期 | 检索方式 |
|---|---|---|---|
| **短期** | 会话上下文 | 单次会话 | 时间顺序 |
| **长期** | 持久化存储 | 跨会话 | 关键词 / 语义 |
| **向量** | 向量数据库 | 持久化 | 语义相似度（TF-IDF） |
| **知识图谱** | 图数据库 | 持久化 | 关系遍历 |
| **FTS5 全文** | SQLite FTS5 | 持久化 | BM25 排序 |

### 🖥️ Web 控制台

包含 20+ 页面的综合管理仪表盘：

| 页面 | 功能 |
|---|---|
| **Chat** | 对话式 AI，带打字指示器、Token 统计、错误可视化 |
| **Dashboard** | 系统概览：健康 / 会话 / 提供商 / 技能 / 启动 |
| **Canvas** | Agent 驱动的可视化工作区，支持 A2UI 协议 |
| **Skills** | 已安装技能及成功率统计 + 市场入口 |
| **Evolution** | 进化引擎仪表盘：周期、候选、约束 |
| **LLM** | 多提供商模型配置，支持优先级排序 |
| **Channels** | 飞书 / 企业微信 / 微信渠道管理 |
| **Feature Flags** | 16 个运行时开关，带 Owner 标签、灰度百分比、评估 |
| **Services** | 实时服务健康监控 |
| **Ops** | 系统状态：运行时间、CPU、内存、进程 |
| **Health Aggregator** | 聚合健康状态和告警 |
| **CLI Terminal** | 内嵌命令行终端 |

### 🧭 Copilot 路由器

智能任务路由，平衡成本与质量：

- **自动降级** — 低价值任务（闲聊、简单问答）→ 轻量模型
- **保护机制** — 高价值任务（代码、数学）始终使用高级模型
- **动态调整** — 基于模型可用性和负载进行路由

---

## 快速开始

### 前置条件

| 依赖 | 版本 | 说明 |
|---|---|---|
| **Node.js** | >= 20.0.0 | 推荐 22.x LTS |
| **pnpm** | >= 9.0.0 | Monorepo 工作区管理器 |
| **Git** | 任意 | 版本控制 & 技能仓库克隆 |
| **LLM API Key** | — | OpenAI / Anthropic / DeepSeek / Ollama |

### 60 秒安装

```bash
# 1. 克隆
git clone https://github.com/chydroid/EvoClaw.git
cd EvoClaw

# 2. 安装依赖
pnpm install

# 3. 配置
cp .env.example .env
# 编辑 .env — 设置 JWT_SECRET（生产环境必须修改！）

# 4. 构建
pnpm -r build

# 5. 启动
pnpm start
```

在浏览器中打开 **http://localhost:27788** — 一切就绪。

### 配置你的第一个 LLM

1. 打开 Web UI → **LLM** 标签页
2. 选择一个提供商（如 OpenAI）
3. 打开 **Enable Provider** 开关
4. 输入你的 **API Key**
5. 选择一个 **Model**（如 gpt-4o）
6. 点击 **Save All**

> **本地模型？** 安装 [Ollama](https://ollama.com)，运行 `ollama pull llama3`，然后将 Base URL 设为 `http://localhost:11434/v1`。

---

## 架构

```
┌──────────────────────────────────────────────────────────────────┐
│                         EvoClaw 服务器                            │
├──────────────────────────────────────────────────────────────────┤
│                                                                  │
│  ┌──────────┐  ┌──────────┐  ┌──────────┐  ┌──────────────────┐ │
│  │  网关    │  │  Web UI  │  │   CLI    │  │   IDE 桥接      │ │
│  │REST/WS/  │  │ (React)  │  │(Node.js) │  │    (ACP)         │ │
│  │  MCP     │  │          │  │          │  │                  │ │
│  └────┬─────┘  └────┬─────┘  └────┬─────┘  └────────┬─────────┘ │
│       └──────────────┴─────────────┴─────────────────┘           │
│                            │                                     │
│                    ┌───────▼───────┐                              │
│                    │   事件总线    │  EventBus                     │
│                    └───────┬───────┘                              │
│                            │                                     │
│       ┌────────────────────┼────────────────────┐                │
│       │                    │                    │                │
│  ┌────▼─────┐  ┌──────────▼───┐  ┌────────────▼───┐            │
│  │  Agent   │  │   进化引擎   │  │     记忆       │            │
│  │ ┌──────┐ │  │ ┌──────────┐ │  │ ┌────────────┐ │            │
│  │ │Actor │ │  │ │ 遗传引擎 │ │  │ │   短期     │ │            │
│  │ │ 池   │ │  │ │  评估器  │ │  │ │   长期     │ │            │
│  │ │DAG   │ │  │ │  提案器  │ │  │ │   向量     │ │            │
│  │ │编排  │ │  │ │ 反思器   │ │  │ │ KG + FTS5  │ │            │
│  │ └──────┘ │  │ └──────────┘ │  │ │  策展器    │ │            │
│  └────┬─────┘  └──────┬───────┘  │ └────────────┘ │            │
│       │               │          └───────┬────────┘            │
│  ┌────▼─────┐  ┌──────▼───────┐  ┌───────▼────────┐            │
│  │   技能   │  │    安全      │  │   基础设施     │            │
│  │ ┌──────┐ │  │ ┌──────────┐ │  │ ┌────────────┐ │            │
│  │ │注册  │ │  │ │  RBAC    │ │  │ │ 日志/数据库│ │            │
│  │ │沙箱  │ │  │ │  审计    │ │  │ │ 消息队列/  │ │            │
│  │ │解析  │ │  │ │  自愈    │ │  │ │ 文件系统   │ │            │
│  │ │索引  │ │  │ │  租户    │ │  │ │  进程      │ │            │
│  │ └──────┘ │  │ │  守卫    │ │  │ └────────────┘ │            │
│  └──────────┘  │ └──────────┘ │  └────────────────┘            │
│                └──────────────┘                                 │
│                                                                  │
│  ┌────────────┐ ┌────────────┐ ┌────────────┐ ┌──────────────┐  │
│  │  Copilot   │ │  凭据池    │ │  提示词    │ │   约束门     │  │
│  │   路由器   │ │ Credential │ │   缓存     │ │   Constraint │  │
│  └────────────┘ └────────────┘ └────────────┘ └──────────────┘  │
│                                                                  │
│  ┌────────────────────────────────────────────────────────────┐  │
│  │              服务注册表 (IoC 容器)                          │  │
│  └────────────────────────────────────────────────────────────┘  │
└──────────────────────────────────────────────────────────────────┘
```

### 设计模式

| 模式 | 实现 | 用途 |
|---|---|---|
| **IoC / DI** | ServiceRegistry | 依赖注入实现松耦合 |
| **事件驱动** | EventBus | 异步发布-订阅服务间通信 |
| **Actor 模型** | ActorSystem | 消息传递实现并发 Agent 协作 |
| **DAG 编排** | DAGExecutor | 自动任务分解和并行调度 |
| **观察者** | EvolutionEngine | 行为触发的改进循环 |
| **策略** | Gateway | 多协议策略切换 |
| **对象池** | AgentPoolManager | 动态 Agent 实例池与扩缩 |

---

## 项目结构

```
EvoClaw/
├── packages/
│   ├── core/              # @evoclaw/core — 类型、配置、服务注册、事件总线
│   ├── agent/             # @evoclaw/agent — Agent 引擎、系统提示、错误分类
│   ├── intelligence/      # @evoclaw/intelligence — 意图分类、多技能编排
│   ├── evolution/         # @evoclaw/evolution — 进化引擎、遗传引擎、约束门
│   ├── memory/            # @evoclaw/memory — 短期/长期/向量/知识图谱/FTS5 记忆
│   ├── skills/            # @evoclaw/skills — 技能管理、注册、沙箱、解析
│   ├── security/          # @evoclaw/security — RBAC、审计、自愈、租户、设备配对
│   ├── gateway/           # @evoclaw/gateway — REST/WS/MCP 网关、协议适配
│   ├── infrastructure/    # @evoclaw/infrastructure — 日志、数据库、消息队列、文件系统、SSH 沙箱
│   ├── plugin-sdk/        # @evoclaw/plugin-sdk — 插件开发 SDK、PluginHost
│   ├── scheduler/         # @evoclaw/scheduler — Cron 定时调度
│   ├── email/             # @evoclaw/email — 邮件客户端
│   ├── reporting/         # @evoclaw/reporting — 报告生成
│   ├── claude-code-tools/ # @evoclaw/claude-code-tools — Claude Code 编程工具
│   └── web-ui/            # @evoclaw/web-ui — React + Vite 管理控制台
├── apps/
│   ├── server/            # @evoclaw/server — 服务器入口
│   └── cli/               # @evoclaw/cli — CLI 工具（30+ 命令）
├── data/                  # 运行时数据（工作区、技能、记忆、插件）
└── pnpm-workspace.yaml    # Monorepo 工作区配置
```

---

## CLI 参考

EvoClaw 提供 30+ 子命令的完整 CLI：

```bash
# 安装与引导
evoclaw setup                    # 创建基础配置和工作区
evoclaw onboard                  # 引导式上手流程
evoclaw dashboard                # 打开 Web 仪表盘

# 健康与状态
evoclaw health [--json]          # 健康检查
evoclaw status [--all]           # 运行时状态
evoclaw doctor [--fix]           # 系统诊断与自动修复

# Agent 与消息
evoclaw agent -m <msg>           # 使用消息运行 Agent
evoclaw message send             # 向 Agent 发送消息

# 技能
evoclaw skills search <q>        # 搜索技能
evoclaw skills install <s>       # 安装技能
evoclaw skills list              # 列出已安装技能

# 模型
evoclaw models list              # 列出可用模型
evoclaw models set <id>          # 切换默认模型
evoclaw models scan              # 扫描可用模型

# 系统
evoclaw logs [--follow]          # 查看日志
evoclaw config get <key>         # 获取配置值
evoclaw config set <key> <val>   # 设置配置值

# 安全
evoclaw security audit           # 安全审计
evoclaw secrets list             # 列出密钥

# 集成
evoclaw mcp list                 # MCP 服务器列表
evoclaw plugins list             # 插件列表
evoclaw channels list            # 渠道管理
```

### 斜杠命令（Web 聊天中）

```
/help           显示所有可用命令
/clear          清空当前会话
/new [model]    新建会话
/compact        压缩会话上下文
/status         系统状态
/health         健康检查
/model [name]   查看或切换模型
/skills         列出已安装技能
/memory <query> 语义记忆搜索
```

---

## REST API

主要端点（50+ 总计）：

| 端点 | 方法 | 说明 |
|---|---|---|
| `/api/health` | GET | 健康检查 |
| `/api/chat` | POST | 发送聊天消息 |
| `/api/skills` | GET | 列出已安装技能 |
| `/api/system/services` | GET | 服务运行时状态 |
| `/api/config/llm` | GET/PUT | LLM 配置 |
| `/api/config/channels` | GET/PUT | 渠道配置 |
| `/api/feature-flags` | GET | 列出功能开关 |
| `/api/feature-flags/:key` | GET/POST | 获取/设置功能开关 |
| `/api/feature-flags/:key/evaluate` | POST | 评估功能开关 |
| `/api/evolution/dashboard` | GET | 进化引擎数据 |
| `/api/canvas/projects` | GET/POST | Canvas 项目管理 |
| `/api/memory/search?q=` | GET | 语义记忆搜索 |
| `/api/sandbox/backends` | GET | 可用沙箱后端 |
| `/metrics` | GET | Prometheus 指标 |

完整 API 文档可在 Web UI 中查看。

---

## 配置

EvoClaw 使用**双层配置**系统：

| 层级 | 存储 | 管理方式 | 用途 |
|---|---|---|---|
| **环境变量** | `.env` 文件 | 手动 / `evoclaw setup` | 服务器端口、密钥、功能开关 |
| **运行时配置** | 服务器内存 | Web UI → LLM / 渠道标签页 | API 密钥、模型选择、渠道配置 |

### 关键环境变量

| 变量 | 默认值 | 说明 |
|---|---|---|
| `EVOCLAW_PORT` | `27788` | 服务器监听端口 |
| `EVOCLAW_HOST` | `0.0.0.0` | 绑定地址 |
| `JWT_SECRET` | — | JWT 签名密钥（**生产环境必须修改**） |
| `EVOCLAW_EVOLUTION_ENABLED` | `true` | 启用进化引擎 |
| `EVOCLAW_MCP_ENABLED` | `true` | 启用 MCP 协议 |
| `CORS_ORIGINS` | — | 允许的 CORS 来源 |
| `RATE_LIMIT_MAX` | — | 速率限制最大请求数 |

---

## 功能开关

EvoClaw 内置 16 个功能开关，可通过 Web UI 管理：

| 开关 | 默认 | 负责方 | 说明 |
|---|---|---|---|
| `evolution` | ✅ | core | 自进化引擎 |
| `compaction` | ✅ | core | 长对话上下文压缩 |
| `sandbox` | ✅ | security | 沙箱技能执行 |
| `mcp` | ✅ | integration | Model Context Protocol 支持 |
| `a2ui` | ✅ | canvas | Agent-to-UI 协议（Canvas） |
| `autoSkill` | ✅ | skills | 自动技能发现与安装 |
| `permissionFastTrack` | ✅ | security | 自动批准白名单目录操作 |
| `copilotRouter` | ✅ | optimization | 任务感知模型路由 |
| `hotReload` | ✅ | devops | 热配置重载（无需重启） |
| `semanticMemory` | ✅ | memory | TF-IDF 语义搜索记忆 |
| `selfHealing` | ✅ | devops | 自动故障检测与恢复 |
| `playwrightBrowser` | ✅ | browser | Playwright 浏览器自动化 |
| `scheduledTasks` | ✅ | scheduler | Cron 定时任务执行 |
| `weixinIntegration` | ❌ | integration | 微信集成 |
| `emailIntegration` | ❌ | integration | 邮件集成 |
| `rolloutCanary` | ❌ | devops | 金丝雀发布（10% 灰度） |

---

## 开发

### 脚本

```bash
pnpm -r build       # 构建所有包
pnpm start          # 启动服务器（UTF-8 编码）
pnpm test           # 运行所有测试
pnpm typecheck      # 类型检查所有包
pnpm lint           # 代码检查所有包
pnpm cli --help     # CLI 帮助
```

### 添加新技能

在 `data/workspace/skills/` 下创建一个包含 `SKILL.md` 的文件夹：

```markdown
---
name: my-skill
version: 1.0.0
description: 我的自定义技能
triggers:
  - type: keyword
    pattern: "my-skill"
---

## Instructions
技能执行指令...

## Examples
用户: my-skill
EvoClaw: 正在执行 my-skill...
```

EvoClaw 启动时自动发现技能。启用热重载后无需重启。

### Web UI 开发

```bash
cd packages/web-ui
pnpm dev        # 启动 Vite 开发服务器（HMR）
```

---

## 测试

```bash
pnpm test                           # 运行所有测试
pnpm --filter @evoclaw/core test    # 运行指定包测试
```

框架：**Vitest** | 约定：`*.test.ts` | 覆盖：**78 个测试文件，1795 个测试用例**

---

## 文档

| 文档 | 说明 |
|---|---|
| [DEPLOYMENT_GUIDE.md](DEPLOYMENT_GUIDE.md) | 完整部署指南（Ubuntu / macOS / Windows） |
| [History.md](History.md) | 版本历史和变更日志 |
| [deploy-checklist.md](deploy-checklist.md) | 多集群部署检查清单 |

---

## 支持平台

| 平台 | 状态 |
|---|---|
| Ubuntu Server 22.04+ | ✅ 完全支持 |
| Debian 12+ | ✅ 完全支持 |
| macOS 13+ | ✅ 完全支持 |
| Windows 10+ | ✅ 支持 |
| Docker | ✅ 支持 |

---

## 贡献指南

我们欢迎各种形式的贡献！

1. **Bug 报告** — 通过 GitHub 提交详细问题
2. **功能请求** — 分享你的新能力想法
3. **代码贡献** — Fork → 分支 → PR
4. **技能贡献** — 发布到 [ClawHub](https://clawhub.ai)
5. **文档改进** — 完善文档、修复错别字、添加示例

### 开发流程

```bash
git checkout -b feature/my-feature
pnpm install && pnpm -r build
pnpm test
git commit -m "feat: add my feature"
git push origin feature/my-feature
# 创建 Pull Request
```

### 代码风格

- TypeScript 严格模式
- 遵循现有命名约定
- 为新功能编写测试
- 确保 `pnpm typecheck` 和 `pnpm test` 通过

---

## 许可证

本项目基于 [MIT 许可证](LICENSE) 开源。

---

<p align="center">
  <sub>Made with 🧬 by the EvoClaw Team</sub>
</p>

<p align="center">
  <sub>龙虾蜕壳，终成大器。EvoClaw 永不止步于进化之路。</sub>
</p>
