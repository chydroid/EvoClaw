[English](README.md) | [中文](README.zh-CN.md)

---

<p align="center">
  <img src="https://github.com/chydroid/EvoClaw/raw/main/assets/images/evoclaw-400-100.png" alt="EvoClaw" width="420">
</p>

<h1 align="center">🧬 EvoClaw</h1>

<p align="center">
  <strong>A self-evolving AI assistant platform</strong><br>
  <sub>Personalized intelligent experiences through skill learning, task orchestration, and multi-channel integration</sub>
</p>

<p align="center">
  <img src="https://img.shields.io/badge/node-%3E%3D20-brightgreen?style=flat-square" alt="Node.js" />
  <img src="https://img.shields.io/badge/pnpm-10.33.2-blue?style=flat-square" alt="pnpm" />
  <img src="https://img.shields.io/badge/typescript-5.x-3178c6?style=flat-square" alt="TypeScript" />
  <img src="https://img.shields.io/badge/version-0.81.0-orange?style=flat-square" alt="Version" />
  <img src="https://img.shields.io/badge/tests-5492-brightgreen?style=flat-square" alt="Tests" />
  <img src="https://img.shields.io/badge/license-MIT-green?style=flat-square" alt="License" />
</p>

---

## Quick Start

### Prerequisites

- **Node.js** >= 20 (Node 24 recommended for better compatibility with pnpm 10)
- **pnpm** >= 9

> **pnpm Version Compatibility Note**: pnpm 10+ requires Node >= 22.13. If you have Node 20, use `npm install -g pnpm@9` instead of `npm install -g pnpm`.

### Installation

```bash
# 1. Clone
git clone https://github.com/chydroid/EvoClaw.git
cd EvoClaw

# 2. Install dependencies
pnpm install
# OR use npm if pnpm is not available:
# npm install

# 3. Configure environment
cp .env.example .env
# Edit .env to add your API keys and configuration

# 4. Build
pnpm build
# OR use npm:
# npm run build

# 5. Start
pnpm start
# OR use npm:
# npm start
```

Open **http://localhost:27788** in your browser.

### Configure Your First LLM

1. Open Web UI → **LLM** tab
2. Select a provider (e.g. OpenAI)
3. Toggle **Enable Provider**
4. Enter your **API Key**
5. Select a **Model** (e.g. gpt-4o)
6. Click **Save All**

> **Local models?** Install [Ollama](https://ollama.com), run `ollama pull llama3`, then set Base URL to `http://localhost:11434/v1`.

### Verify

```bash
pnpm typecheck    # Type checking
pnpm test         # Run tests
```

## Core Capabilities

| Category | Capabilities |
|----------|-------------|
| Conversation | Multi-model, multi-provider, streaming, context compression, MoA (Mixture of Agents) |
| Skills | Local + remote registry, auto-install, security scanning, Skill Curator lifecycle, optional-skills separation, 37 built-in + optional skills (dev tools, productivity, writing, analysis, design, generation), TF-IDF semantic matching with Chinese-English bilingual keywords |
| Tools | File ops, browser automation, web search, Office docs, Computer Use desktop control, Tool Search |
| Channels | WeChat, Feishu, DingTalk, Telegram, WhatsApp, Discord, Slack, Matrix, QQ, REST API, WebSocket, A2A, ACP IDE |
| Memory | Short/long-term, RAG retrieval, semantic search, L0-L3 layered memory, Memory Provider plugins |
| Evolution | Experience learning, reinforcement feedback, auto-optimization, genetic algorithm, A/B testing |
| Security | Command approval, path protection, SSRF guard, secrets, audit, startup security audit, OSV supply-chain, advisory catalog |
| Plugins | Plugin SDK, MCP protocol support, Profile multi-instance |
| Collaboration | Kanban multi-agent work queue, Actor model, Swarm orchestrator, DAG task orchestration |
| Reliability | Process supervisor, shutdown forensics, drain control, log rotation, credential pool persistence |

## Architecture

EvoClaw is built on a modular, event-driven architecture:

- **Gateway Layer** — REST/WS/MCP gateways, Web UI (React 19), CLI — all external interfaces
- **EventBus** — Centralized pub-sub event bus decoupling all internal services
- **Core Services** — Agent (Actor model + DAG orchestration), Evolution (self-evolution engine), Memory (multi-layer: short/long/vector/FTS5)
- **Supporting** — Skills (registry, sandbox, security scanning), Security (RBAC, audit, tenant isolation), Infrastructure (logging, message queue, filesystem)
- **Cross-cutting** — Copilot Router (intelligent model routing), Credential Pool (API key rotation), Prompt Cache

Key design patterns: IoC/DI via ServiceRegistry, Actor model concurrency, DAG-based task decomposition, Observer pattern for evolution.

## CLI Reference

30+ subcommands available:

```bash
# Setup & onboarding
evoclaw setup                    # Create base config and workspace
evoclaw onboard                  # Interactive onboarding

# Health & status
evoclaw health [--json]          # Health check
evoclaw status [--all]           # Runtime status
evoclaw doctor [--fix]           # System diagnostics

# Agent & messaging
evoclaw agent -m <msg>           # Run agent with message
evoclaw message send             # Send message to agent

# Skills
evoclaw skills search <q>        # Search skills
evoclaw skills install <s>       # Install a skill
evoclaw skills list              # List installed skills

# Models
evoclaw models list              # List available models
evoclaw models set <id>          # Switch default model
evoclaw models scan              # Scan available models

# Configuration
evoclaw config get <key>         # Get config value
evoclaw config set <key> <val>   # Set config value

# Security
evoclaw security audit           # Run security audit
evoclaw secrets list             # List secrets

# Integration
evoclaw mcp list                 # List MCP servers
evoclaw plugins list             # List plugins
evoclaw channels list            # Channel management
```

## REST API

Key endpoints (50+ total):

| Endpoint | Method | Description |
|---|---|---|
| `/api/health` | GET | Health check |
| `/api/chat` | POST | Send chat message |
| `/api/skills` | GET | List installed skills |
| `/api/system/services` | GET | Service runtime status |
| `/api/config/llm` | GET/PUT | LLM configuration |
| `/api/config/channels` | GET/PUT | Channel configuration |
| `/api/feature-flags` | GET | List feature flags |
| `/api/evolution/dashboard` | GET | Evolution engine dashboard |
| `/api/memory/search?q=` | GET | Semantic memory search |
| `/metrics` | GET | Prometheus metrics |

## Configuration

Key environment variables in `.env`:

| Variable | Default | Description |
|---|---|---|
| `EvoClaw_PORT` | `27788` | Server port |
| `EvoClaw_HOST` | `0.0.0.0` | Bind address |
| `JWT_SECRET` | — | JWT signing key (**must change in production**) |
| `EvoClaw_EVOLUTION_ENABLED` | `true` | Enable evolution engine |
| `EvoClaw_MCP_ENABLED` | `true` | Enable MCP protocol |
| `CORS_ORIGINS` | — | Allowed CORS origins |
| `RATE_LIMIT_MAX` | — | Max rate limit requests |

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

## Troubleshooting

| Problem | Solution |
|---|---|
| `pnpm: command not found` | Install pnpm: `npm install -g pnpm@10` |
| `port 27788 already in use` | Change `EvoClaw_PORT` in `.env` or kill the process |
| Build fails | Clean and retry: `pnpm clean && pnpm install && pnpm build` |
| Web UI blank page | Ensure `pnpm build` completed, check browser console |
| LLM connection fails | Verify API key and Base URL, check network connectivity |
| Channel connection fails | Ensure callback URL is publicly accessible, verify token |

### Port conflict

```bash
# Linux/macOS
lsof -i :27788
kill -9 <PID>

# Windows
netstat -ano | findstr :27788
taskkill /PID <PID> /F
```

### Full reset

```bash
pnpm clean
rm -rf node_modules pnpm-lock.yaml
pnpm install
pnpm build
pnpm test
```

## Contributing

Issues and PRs are welcome. See [CONTRIBUTING.md](CONTRIBUTING.md).

## Security

To report a vulnerability, see [SECURITY.md](SECURITY.md).

## License

[MIT](LICENSE)

---

For detailed version history, see [History.md](History.md).