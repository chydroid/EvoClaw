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
  <img src="https://img.shields.io/badge/version-0.61.0-7c3aed?style=flat-square" alt="Version" />
  <img src="https://img.shields.io/badge/node-%3E%3D20.0.0-22c55e?style=flat-square" alt="Node.js" />
  <img src="https://img.shields.io/badge/pnpm-%3E%3D9.0.0-f69220?style=flat-square" alt="pnpm" />
  <img src="https://img.shields.io/badge/typescript-5.x-3178c6?style=flat-square" alt="TypeScript" />
  <img src="https://img.shields.io/badge/license-MIT-8b5cf6?style=flat-square" alt="License" />
  <img src="https://img.shields.io/badge/tests-3967%20passed-brightgreen?style=flat-square" alt="Tests" />
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
- **Operator Install Policy** — 多维策略驱动的插件安装（来源 / 风险 / 权限 / 操作者） **[v0.35.0]**
- **审批超时（fail-closed）** — 限时审批 + 安全默认拒绝 **[v0.35.0]**
- **敏感信息遮蔽** — 自动遮蔽 API Key、JWT、邮箱等 12 类敏感信息 **[v0.35.0]**
- **MCP 投毒扫描器** — 检测 MCP 工具描述中隐藏的提示词注入 **[v0.35.0]**

### 🆕 v0.61.0 更新亮点

对照 `D:\abc\openclaw-main` 与 GitHub 上 openclaw 最新更新，对 EvoClaw 进行 **10 轮深度系统性短板补齐**，覆盖技能生态、命令执行审批、审计矩阵、密钥管理、定时调度、机器人循环防护、诊断体系、prompt cache 稳定性、SQLite 精细化管理、gateway 重启协调体系。本版本属于重大里程碑，递增 minor 位。

| 轮次 | 模块 | 对标 openclaw-main | 收益 |
|---|---|---|---|
| **第 1 轮** | SKILL.md frontmatter 安装规范 + 5 个 bundled skills | skill install frontmatter | `bins`/`anyBins`/`requires.env`/`requires.os` 解析 + 预检查与后置校验 + 5 个新 bundled 技能 |
| **第 2 轮** | exec-approvals 命令执行审批链路 | exec-approvals registry | 4 类规则匹配（commandPrefix/argPattern/workingDirScope/envScope）+ allow/deny/prompt 三级决策 + 持久化 |
| **第 3 轮** | audit-* 审计矩阵扩展 | audit-center events | 6 类新事件（exec.approval/secret.detected/cron.stagger.violation/gateway.restart）+ 4 级 severity + 查询/统计/清理接口 |
| **第 4 轮** | secrets 子系统 | secret-equal + safe-regex + dangerous-config-flags + secret-scan | 4 模块：常量时间比较 / ReDoS 检测 / 12 类危险配置扫描 / 25+ 条正则密钥扫描 |
| **第 5 轮** | cron stagger + session-reaper + run-log 持久化 | cron stagger + session reaper + run-log | stagger 抖动避免多实例同时触发 + idle 30min/lifetime 24h 自动清理 + jsonl 持久化 + 查询接口 |
| **第 6 轮** | bot-loop-protection + message-turn-guardrails + history-window | loop protection + turn guardrails + history window | 3 模块：滑动窗口 + Levenshtein 相似度 + 冷却 / 每消息 turn/token/timeout 三重限制 / FIFO/Token-aware/Priority 三策略 |
| **第 7 轮** | diagnostic 体系基础 | diagnostic phase + payload + stability + support-bundle | 4 模块：8 类 phase 追踪 / 结构化 payload + 脱敏 / 4 级稳定性评估 + 自动回调 / 支持包导出 JSON/Tar |
| **第 8 轮** | prompt-cache-stability 显式管理 | prompt cache stability | `stableStringify` 稳定序列化 + `CacheTrace` 命中率统计 + `detectPrefixDrift` 漂移告警 + `detectCacheBustingFields` 识别破坏字段 |
| **第 9 轮** | sqlite 精细化管理 | sqlite pragma + transaction + wal | 3 模块：PRAGMA 配置 + 生产/开发默认值 + 校验 / withTransaction + withSavepoint + batchExec + 统计 / checkpointWal + WalAutoCheckpoint + 状态查询 |
| **第 10 轮** | gateway restart 协调体系 | restart coordinator + sentinel + intent + stale-pids + handoff | 5 模块架构：intent 持久化 + 原子写入 + TTL 60s / authorize + consume + 30s 冷却 / 跨平台陈旧进程清理 + self+ancestor 排除 / Supervisor 交接（systemd/launchctl/schtasks）/ 顶层编排 + schedule 合并 + 跨会话保护 |

**新增文件**：`exec-approvals.ts`、`secret-equal.ts`、`safe-regex.ts`、`dangerous-config-flags.ts`、`secret-scan.ts`、`session-reaper.ts`、`bot-loop-protection.ts`、`message-turn-guardrails.ts`、`history-window.ts`、`diagnostic-phase.ts`、`diagnostic-payload.ts`、`diagnostic-stability.ts`、`diagnostic-support-bundle.ts`、`prompt-cache-stability.ts`、`sqlite-pragma.ts`、`sqlite-transaction.ts`、`sqlite-wal.ts`、`restart-intent.ts`、`restart-sentinel.ts`、`restart-stale-pids.ts`、`restart-handoff.ts`、`restart-coordinator.ts` 及配套 18 个测试文件

**验证**：`pnpm -r build` + `pnpm typecheck` + `pnpm test`（3967 passed / 73 skipped / 0 failed，新增约 860+ 测试用例），88/88 服务健康

> **版本号升级规则（自 v0.60.1 起）**：正常迭代只递增最后一位 patch 号（如 `0.60.0 → 0.60.1 → 0.60.2`）；仅在发生破坏性变更或重大里程碑时才递增 minor / major 位。v0.61.0 因 10 轮深度提升属于重大里程碑，递增 minor 位。

### 🆕 v0.60.1 更新亮点

清理 `data/skills/` 下 20 个 evoclaw-curator 自动生成的低质量技能，并从源头切断自动创建路径，确保无用技能不再被自动生成。

| 改动 | 模块 | 收益 |
|---|---|---|
| **修改技能创建逻辑** | `llm-caller.ts` + `skill-curator.ts` | 移除每 15 次工具调用触发的 `considerExtraction` 入口；`enableAutoExtraction` / `considerExtraction` / `extractSkillFromSolution` 全部改为永久 no-op，自动提取不可再被启用 |
| **取消 5 分钟自动扫描安装** | `apps/server/src/index.ts` + `skill-manager.ts` | 移除 `startAutoScan` 周期扫描，改为启动时一次性 `scanAndInstall` 加载已有技能；移除 `tryGenerateCuratedSkill` 自动生成逻辑，缺少 `SKILL.md` 的目录直接跳过 |
| **改为 WebUI 手动刷新触发** | `protocol-adapter.ts` | 扩展 `/api/skills/refresh` 端点，同时扫描 `data/skills` 与 `packages/skills/bundled`，返回安装/跳过详情 |
| **附带修复** | `skill-manager.ts` | `validateSkillQuality` 路径不匹配 bug（传入文件路径而非目录导致所有技能被拒），修复后 41 个技能正常加载 |

**验证**：`pnpm -r build` + `pnpm typecheck` + 3174/3175 测试通过，88/88 服务健康，0 个 evoclaw-curator 自动生成的技能

> **版本号升级规则（自 v0.60.1 起）**：正常迭代只递增最后一位 patch 号（如 `0.60.0 → 0.60.1 → 0.60.2`）；仅在发生破坏性变更或重大里程碑时才递增 minor / major 位。

### 🆕 v0.60.0 更新亮点

对照 `openclaw-main` 项目，对网关 / 安全 / 基础设施 / 技能子系统进行 **10 轮短板补齐**，全面对齐行业最佳实践。每轮修改后通过 `pnpm build` + `typecheck` + `test` 三重验证。

| 轮次 | 模块 | 对标 openclaw-main | 收益 |
|---|---|---|---|
| **第 1 轮** | 技能安装 download 种类 | skill install 完整实现 | HTTPS-only + SSRF 防护 + 100MB 上限 + zip/tar.gz/tar.bz2 解压 + anyBins/bins 校验 |
| **第 2 轮** | Hooks 4 源策略系统 | hooks/policy.ts | bundled/plugin/managed/workspace 策略矩阵 + canOverride 双向校验 + 碰撞合并 |
| **第 3 轮** | 插件 hardlink 策略与起源索引 | plugins/hardlink-policy.ts | inode nlink>1 检测（Nix 例外）+ PluginProvenanceIndex（inode + sha256 双重校验） |
| **第 4 轮** | 工作台符号链接逃逸检测 | skills/security/workspace-audit | BFS + realpathWithTimeout + 路径边界检查 |
| **第 5 轮** | 结构化日志与脱敏轮转 | logging/rotating-file-appender | 100MB × 5 文件滚动 + pruneOldRollingLogs 清理孤儿 |
| **第 6 轮** | W3C 跟踪上下文传播 | infra/trace-context | traceparent 严格校验 + AsyncLocalStorage 传播 + startSpan/endSpan |
| **第 7 轮** | net-policy 包 | infra/net-policy | 协议 + 主机名单 + DNS 钉制防重绑定 + IP CIDR 匹配 |
| **第 8 轮** | 配置 schema 合并管线 | config/schema-merge | 256KB/2MB/256 项/深度 10 上限 + SHA256 cacheKey + UI hints 通配符 |
| **第 9 轮** | MCP channel-bridge 与 cancel | mcp/channel-bridge + plugin-tools cancel | callTool + AbortSignal + 超时 + 并发上限 + callerId 批量取消 |
| **第 10 轮** | 消息持久接收与 stall-watchdog | durable-receive + stall-watchdog | pending+completed 双 Map 重复检测 + arm/touch/disarm/stop + AbortSignal 联动 |

**新增文件**：`hook-policy.ts`、`plugin-hardlink-policy.ts`、`workspace-audit.ts`、`rotating-file-appender.ts`、`trace-context.ts`、`net-policy.ts`、`config-schema-merge.ts`、`durable-receive-journal.ts`、`stall-watchdog.ts`、`durable-receive-stall-watchdog.test.ts`

**验证**：`pnpm -r build` + `pnpm typecheck` + 20/20 测试通过

### 🆕 v0.35.0 更新亮点

参考 OpenClaw v2026.6.6 与 Hermes v0.16 的核心改进，进行 12 项高价值提升：

| 模块 | 对标 | 收益 |
|---|---|---|
| **安装策略** | OpenClaw Operator Policy | 用多维约束替代传统代码扫描 |
| **审批超时** | OpenClaw 审批安全 | 默认 fail-closed，可配置升级链 |
| **敏感信息遮蔽** | OpenClaw transcripts | 12 种内置模式，防止密钥泄露 |
| **MCP 投毒扫描** | OpenClaw MCP stdio 安全 | 检测工具描述中的隐藏注入 |
| **技能懒加载** | OpenClaw 控制 UI 启动 | 冷启动提速 ~40%，降低内存占用 |
| **元数据缓存** | OpenClaw 模型缓存 | 5 分钟 TTL，1000 条 LRU，成本索引 |
| **Token 使用追踪** | Hermes token 追踪 | 按模型 / 用户 / 会话聚合 |
| **会话 FTS5 搜索** | Hermes FTS5 搜索 | 中英混合分词，BM25 排序，高亮片段 |
| **会话撤销** | Hermes `/undo` 命令 | 多级快照栈，选择性回滚 |
| **反应式审批** | OpenClaw reaction approvals | 移动端 emoji 一键批准 / 拒绝 |

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

EvoClaw 采用模块化、事件驱动的架构，以 IoC（控制反转）容器为核心：

- **入口层** — 网关（REST/WS/MCP）、Web UI（React）、CLI（Node.js）和 IDE 桥接（ACP）作为外部接口。所有请求通过网关流入内部 EventBus。
- **EventBus** — 集中式发布-订阅事件总线，解耦所有内部服务。每个组件通过类型化事件进行异步通信。
- **核心服务** — 三大主要领域位于 EventBus 之上：
  - **Agent** — 基于 Actor 的并发模型，包含动态 Agent 池、DAG 编排用于并行任务分解，以及降级链。
  - **Evolution** — 遗传引擎、评估器、提案器和反思器构成自我进化流水线。
  - **Memory** — 多层记忆，包括短期、长期、向量（TF-IDF）、知识图谱、FTS5 全文搜索和记忆策展器。
- **支撑服务** — Skills（注册中心、沙箱、解析器、渐进索引）、Security（RBAC、审计、自愈、租户隔离、内容守卫）和 Infrastructure（日志、数据库、消息队列、文件系统、进程管理）。
- **横切模块** — Copilot Router（智能模型路由）、Credential Pool（API 密钥管理）、Prompt Cache 和 Constraint Gates（5 门进化质量保障）。
- **ServiceRegistry** — 底层的 IoC 容器通过依赖注入将所有服务连接在一起，实现松耦合和运行时服务替换。

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

在 `data/skills/` 下创建一个包含 `SKILL.md` 的文件夹（自带技能可放入 `packages/skills/bundled/`）：

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
| [History.md](History.md) | 版本历史和变更日志 |
| [deploy-checklist.md](deploy-checklist.md) | 多集群部署检查清单 |

---

## 故障排除

| 问题 | 解决方案 |
|---|---|
| `pnpm: command not found` | 重新安装 pnpm: `npm install -g pnpm@10` |
| `port 27788 already in use` | 修改 `.env` 中的 `EVOCLAW_PORT` 或终止占用进程 |
| 构建失败 | 清理并重试: `pnpm clean && pnpm install && pnpm build` |
| Web UI 空白页 | 确认已运行 `pnpm build`，检查浏览器控制台错误 |
| LLM 测试连接失败 | 检查 API Key 和 Base URL 是否正确，网络是否可达 |
| 渠道连接失败 | 检查回调 URL 是否可从公网访问，Token 是否匹配 |
| `JWT_SECRET` 警告 | 设置至少 16 位的 JWT 密钥 |

### 端口占用处理

**Ubuntu/macOS**:
```bash
lsof -i :27788
kill -9 <PID>
```

**Windows**:
```powershell
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

### 查看日志

**systemd (Ubuntu)**: `sudo journalctl -u evoclaw -f`

**launchd (macOS)**: `tail -f ~/Library/Logs/evoclaw.log`

**Windows (winsw)**: `Get-Content .\evoclaw-service.out.log -Tail 50 -Wait`

---

## 安全最佳实践

1. **生产环境务必修改 `JWT_SECRET`** 为至少 32 位随机字符串
2. 配置防火墙只开放必要端口（27788）
3. 使用 HTTPS 反向代理（Nginx/Caddy）
4. 保持依赖更新：`pnpm update`
5. 配置审计中心告警规则
6. 为每个租户设置合理的配额限制
7. 启用自愈机制自动修复故障
8. 限制 `CORS_ORIGINS` 为可信域名
9. 启用可观测性监控并设置告警规则
10. 使用 CredentialPool 管理 API Key 轮换

---

## 可观测性

在 `.env` 中设置 `EVOCLAW_OBSERVABILITY_ENABLED=true` 启用。EvoClaw 在 `/metrics` 端点暴露 Prometheus 兼容指标，并支持通过 OTLP 进行分布式追踪。

### 指标类型

| 类型 | 说明 | 示例 |
|---|---|---|
| **Counter** | 单调递增计数器，用于请求/错误总数 | `evoclaw_http_requests_total` |
| **Gauge** | 当前值，用于活跃连接数、队列深度 | `evoclaw_active_sessions` |
| **Histogram** | 分布直方图，用于请求延迟、响应大小 | `evoclaw_request_duration_seconds` |

### 追踪配置

```ini
EVOCLAW_OBSERVABILITY_ENABLED=true
EVOCLAW_TRACING_ENDPOINT=http://localhost:4318/v1/traces
EVOCLAW_TRACING_SAMPLE_RATE=0.1
```

### 健康报告

```bash
curl http://localhost:27788/health/report
```

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
