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
  <img src="https://img.shields.io/badge/license-MIT-green?style=flat-square" alt="License" />
</p>

## 快速开始

### 环境要求

- **Node.js** >= 20
- **pnpm** >= 9

### 安装

```bash
# 1. 克隆仓库
git clone https://github.com/chydroid/EvoClaw.git
cd EvoClaw

# 2. 安装依赖
pnpm install

# 3. 配置环境变量
cp .env.example .env
# 编辑 .env 填入你的 API Key 等配置

# 4. 构建项目
pnpm build

# 5. 启动服务
pnpm start
```

服务默认运行在 **http://localhost:27788**。

### 验证安装

```bash
pnpm typecheck    # 类型检查
pnpm test         # 运行测试
```

## 核心能力

| 类别 | 能力 |
|------|------|
| 智能对话 | 多模型、多提供商、流式响应、上下文压缩 |
| 技能系统 | 本地技能 + 远程注册表、自动安装、安全扫描 |
| 工具生态 | 文件操作、浏览器自动化、网络搜索、Office 文档生成 |
| 多渠道 | 微信、飞书、钉钉、Telegram、WhatsApp、REST API、WebSocket |
| 记忆系统 | 长短期记忆、RAG 检索、语义搜索 |
| 自进化 | 经验学习、强化反馈、自动优化 |
| 安全 | 命令审批、路径防护、SSRF 防护、密钥管理、审计日志 |
| 插件 | Plugin SDK 扩展、MCP 协议支持 |

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

## 贡献

欢迎提交 Issue 和 PR。详见 [CONTRIBUTING.md](CONTRIBUTING.md)。

## 安全

发现漏洞请参考 [SECURITY.md](SECURITY.md)。

## 许可证

[MIT](LICENSE)

---

详细的版本更新记录请参阅 [History.md](History.md)。