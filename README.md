[English](README.md) | [中文](README.zh-CN.md)

---

# 🧬 EvoClaw

> A self-evolving AI assistant platform — personalized intelligent experiences through skill learning, task orchestration, and multi-channel integration

[![Node.js](https://img.shields.io/badge/node-%3E%3D20-brightgreen)](https://nodejs.org)
[![pnpm](https://img.shields.io/badge/pnpm-10.33.2-blue)](https://pnpm.io)
[![License](https://img.shields.io/badge/license-MIT-green)](LICENSE)

## Quick Start

### Prerequisites

- **Node.js** >= 20
- **pnpm** >= 9

### Installation

```bash
# 1. Clone the repository
git clone https://github.com/chydroid/EvoClaw.git
cd EvoClaw

# 2. Install dependencies
pnpm install

# 3. Configure environment
cp .env.example .env
# Edit .env to add your API keys and configuration

# 4. Build the project
pnpm build

# 5. Start the server
pnpm start
```

The server runs at **http://localhost:27788** by default.

### Verify

```bash
pnpm typecheck    # Type checking
pnpm test         # Run tests
```

## Core Capabilities

| Category | Capabilities |
|----------|-------------|
| Conversation | Multi-model, multi-provider, streaming, context compression |
| Skills | Local + remote registry, auto-install, security scanning |
| Tools | File ops, browser automation, web search, Office docs |
| Channels | WeChat, Feishu, DingTalk, Telegram, WhatsApp, REST API, WebSocket |
| Memory | Short/long-term, RAG retrieval, semantic search |
| Evolution | Experience learning, reinforcement feedback, auto-optimization |
| Security | Command approval, path protection, SSRF guard, secrets, audit |
| Plugins | Plugin SDK, MCP protocol support |

## Project Structure

```
EvoClaw/
├── apps/
│   ├── server/              # Main server entry
│   └── cli/                 # CLI tool
├── packages/
│   ├── core/                # Types, event bus, config management
│   ├── agent/               # Task orchestration, model execution, agent pool
│   ├── gateway/             # Channel management, protocol handling, webhooks
│   ├── skills/              # Skill registry, installation, validation, security
│   ├── memory/              # Memory storage, RAG pipeline, semantic search
│   ├── security/            # Security governance, permissions, audit
│   ├── evolution/           # Self-evolution engine
│   ├── infrastructure/      # Message queue, filesystem, logging
│   ├── scheduler/           # Cron job scheduling
│   ├── reporting/           # Report generation
│   ├── intelligence/        # Task classification & skill orchestration
│   ├── plugin-sdk/          # Plugin development SDK
│   ├── email/               # Email client
│   ├── web-ui/              # React 19 frontend
│   └── claude-code-tools/   # Claude Code integration
└── docs/                    # Documentation
```

## Tech Stack

- **Runtime**: Node.js 20+
- **Language**: TypeScript (strict)
- **Package Manager**: pnpm monorepo
- **Testing**: Vitest
- **Frontend**: React 19 + Vite
- **Database**: SQLite (better-sqlite3)
- **Browser Automation**: Playwright

## Development

```bash
pnpm dev          # Dev mode
pnpm build        # Build
pnpm typecheck    # Type check
pnpm test         # Run tests
pnpm test:watch   # Watch mode
```

## Docker

```bash
docker build -t evoclaw .
docker run -p 27788:27788 --env-file .env evoclaw
```

## Contributing

Issues and PRs are welcome. See [CONTRIBUTING.md](CONTRIBUTING.md).

## Security

To report a vulnerability, see [SECURITY.md](SECURITY.md).

## License

[MIT](LICENSE)

---

For detailed version history, see [History.md](History.md).