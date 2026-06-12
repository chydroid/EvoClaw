[English](README.md) | [中文](README.zh-CN.md)

---

<p align="center">
  <img src="https://github.com/chydroid/EvoClaw/raw/main/assets/images/evoclaw-400-100.png" alt="EvoClaw" width="420">
</p>

<h1 align="center">EvoClaw</h1>

<p align="center">
  <strong>The Self-Evolving Agent Operating System</strong><br>
  具备增强式自我进化能力的下一代自主智能体操作系统
</p>

<p align="center">
  <img src="https://img.shields.io/badge/version-0.27.0-7c3aed?style=flat-square" alt="Version" />
  <img src="https://img.shields.io/badge/node-%3E%3D20.0.0-22c55e?style=flat-square" alt="Node.js" />
  <img src="https://img.shields.io/badge/pnpm-%3E%3D9.0.0-f69220?style=flat-square" alt="pnpm" />
  <img src="https://img.shields.io/badge/typescript-5.x-3178c6?style=flat-square" alt="TypeScript" />
  <img src="https://img.shields.io/badge/license-MIT-8b5cf6?style=flat-square" alt="License" />
  <img src="https://img.shields.io/badge/tests-2739%20passed-brightgreen?style=flat-square" alt="Tests" />
</p>

<p align="center">
  <a href="#quick-start">Quick Start</a> · <a href="#documentation">Documentation</a> · <a href="#architecture">Architecture</a> · <a href="#contributing">Contributing</a>
</p>

---

## What is EvoClaw?

EvoClaw is not just another AI Agent framework — it's a **self-evolving agent operating system** that can observe, diagnose, optimize, and evolve itself autonomously.

Inspired by the biological principle of molting (lobsters shed their shells to grow indefinitely), EvoClaw embodies **continuous evolution**: its built-in Evolution Engine collects experience from task failures, user feedback, and usage patterns, then automatically generates improvement proposals — enabling your agents to iterate and upgrade without human intervention.

### Why EvoClaw?

| | Traditional Agent Frameworks | EvoClaw |
|---|---|---|
| **Evolution** | Manual updates only | Self-observing, self-diagnosing, self-optimizing |
| **Architecture** | Single agent or static pipeline | Actor Model + DAG orchestration + dynamic scaling |
| **Skills** | Hardcoded capabilities | SKILL.md standard + ClawHub marketplace + auto-discovery |
| **Security** | Basic auth | RBAC + multi-tenant isolation + self-healing + audit |
| **Memory** | Session-only | Multi-layer: short-term / long-term / vector / knowledge graph |
| **Observability** | Logs only | Prometheus metrics + distributed tracing + health aggregation |

### By the Numbers

| | |
|---|---|
| **17** | Monorepo packages (core, agent, evolution, memory, skills, security, gateway, ...) |
| **16** | Built-in feature flags with runtime toggle |
| **30+** | CLI sub-commands |
| **20+** | Web UI management pages |
| **50+** | REST API endpoints |
| **2696** | Test cases passing → **2740** in v0.22.0 |
| **4** | LLM provider types (OpenAI / Anthropic / DeepSeek / Local) |
| **5** | Constraint gates for evolution quality assurance |

---

## Core Features

### 🧬 Self-Evolution Engine

The crown jewel of EvoClaw. The Evolution Engine closes the loop from failure → analysis → proposal → validation → deployment:

- **Requirement Miner** — Discovers new capability needs from usage patterns
- **Genetic Engine** — Generates and selects optimal solution candidates
- **Evaluator** — Multi-dimensional assessment (tests, security, performance, risk)
- **Constraint Gates** — 5-gate validation: size / description / semantics / compatibility / transient fault
- **Hot Reload** — Zero-downtime skill and config updates (immediate / graceful / canary / A/B)

### 🧠 Multi-Agent Collaboration

- **Actor Concurrency Model** — Each agent runs as an independent Actor with async message passing
- **Agent Pool** — Dynamic scaling agent pool with health scoring
- **DAG Orchestration** — Automatic task decomposition into directed acyclic graphs for parallel execution
- **Fallback Chain** — Provider failover + auth rotation + health-based routing

### 📦 Skill Ecosystem

- **SKILL.md Standard** — Markdown-based declarative skill description format, compatible with OpenClaw/ClawHub
- **ClawHub Marketplace** — Global skill registry at [clawhub.ai](https://clawhub.ai) / [cn.clawhub-mirror.com](https://cn.clawhub-mirror.com)
- **Sandboxed Execution** — Isolated skill runtime (Docker / SSH / Process backends)
- **Multi-mode Triggers** — Keyword / intent / schedule / event / webhook
- **Progressive Index** — Three-tier loading: L0(~20t) / L1(~200t) / L2(~1000+t)

### 🔐 Enterprise Security

- **RBAC** — Role-based access control with fine-grained permissions
- **Multi-tenant Isolation** — Complete data and workspace isolation
- **Security Audit** — Full-chain operation audit and anomaly detection
- **Self-Healing** — Runtime fault auto-detection and recovery
- **Rate Limiting** — API-level traffic control and protection
- **Device Pairing** — RSA public key + challenge-signature authentication
- **Webhook Verification** — HMAC-SHA256 signature validation
- **Content Guard** — SSRF protection + content safety filtering

### 💾 Multi-Dimensional Memory

| Layer | Storage | Lifecycle | Retrieval |
|---|---|---|---|
| **Short-term** | Session context | Single session | Chronological |
| **Long-term** | Persistent store | Cross-session | Keyword / semantic |
| **Vector** | Vector database | Persistent | Semantic similarity (TF-IDF) |
| **Knowledge Graph** | Graph database | Persistent | Relationship traversal |
| **FTS5 Full-text** | SQLite FTS5 | Persistent | BM25 ranking |

### 🖥️ Web Console

A comprehensive management dashboard with 20+ pages:

| Page | Function |
|---|---|
| **Chat** | Conversational AI with typing indicator, token stats, error visualization |
| **Dashboard** | System overview: health / sessions / providers / skills / bootstrap |
| **Canvas** | Agent-driven visual workspace with A2UI protocol |
| **Skills** | Installed skills with success rate stats + market entry |
| **Evolution** | Evolution engine dashboard: cycles, candidates, constraints |
| **LLM** | Multi-provider model config with priority ordering |
| **Channels** | Feishu / WeCom / WeChat channel management |
| **Feature Flags** | 16 runtime toggles with owner tags, rollout %, evaluation |
| **Services** | Real-time service health monitoring |
| **Ops** | System status: uptime, CPU, memory, processes |
| **Health Aggregator** | Aggregated health status and alerts |
| **CLI Terminal** | Embedded command-line terminal |

### 🧭 Copilot Router

Intelligent task routing that balances cost and quality:

- **Auto-downgrade** — Low-value tasks (chitchat, simple Q&A) → lightweight models
- **Protection** — High-value tasks (code, math) always use premium models
- **Dynamic adjustment** — Route based on model availability and load

---

## Quick Start

### Prerequisites

| Dependency | Version | Notes |
|---|---|---|
| **Node.js** | >= 20.0.0 | 22.x LTS recommended |
| **pnpm** | >= 9.0.0 | Monorepo workspace manager |
| **Git** | any | Version control & skill repo cloning |
| **LLM API Key** | — | OpenAI / Anthropic / DeepSeek / Ollama |

### Install in 60 Seconds

```bash
# 1. Clone
git clone https://github.com/chydroid/EvoClaw.git
cd EvoClaw

# 2. Install dependencies
pnpm install

# 3. Configure
cp .env.example .env
# Edit .env — set JWT_SECRET (required for production!)

# 4. Build
pnpm -r build

# 5. Start
pnpm start
```

Open **http://localhost:27788** in your browser — you're ready to go.

### Configure Your First LLM

1. Open Web UI → **LLM** tab
2. Select a provider (e.g., OpenAI)
3. Toggle **Enable Provider** on
4. Enter your **API Key**
5. Select a **Model** (e.g., gpt-4o)
6. Click **Save All**

> **Local models?** Install [Ollama](https://ollama.com), run `ollama pull llama3`, then set Base URL to `http://localhost:11434/v1`.

---

## Architecture

EvoClaw follows a modular, event-driven architecture with an IoC (Inversion of Control) container at its core:

- **Entry Layer** — Gateway (REST/WS/MCP), Web UI (React), CLI (Node.js), and IDE Bridge (ACP) serve as the external interfaces. All requests flow through the Gateway into the internal EventBus.
- **EventBus** — A centralized pub-sub event bus that decouples all internal services. Every component communicates asynchronously through typed events.
- **Core Services** — Three primary domains sit on the EventBus:
  - **Agent** — Actor-based concurrency model with dynamic Agent Pool, DAG orchestration for parallel task decomposition, and fallback chains.
  - **Evolution** — Genetic Engine, Evaluator, Proposer, and Reflector form the self-evolution pipeline.
  - **Memory** — Multi-layer memory including Short-term, Long-term, Vector (TF-IDF), Knowledge Graph, FTS5 full-text search, and Memory Curator.
- **Supporting Services** — Skills (Registry, Sandbox, Parser, Progressive Index), Security (RBAC, Audit, Self-Healing, Tenant Isolation, Content Guard), and Infrastructure (Logger, Database, Message Queue, File System, Process Manager).
- **Cross-cutting Modules** — Copilot Router (intelligent model routing), Credential Pool (API key management), Prompt Cache, and Constraint Gates (5-gate evolution quality assurance).
- **ServiceRegistry** — The IoC container at the bottom layer wires all services together via dependency injection, enabling loose coupling and runtime service replacement.

### Design Patterns

| Pattern | Implementation | Purpose |
|---|---|---|
| **IoC / DI** | ServiceRegistry | Loose coupling via dependency injection |
| **Event-Driven** | EventBus | Async pub-sub inter-service communication |
| **Actor Model** | ActorSystem | Concurrent agent collaboration via message passing |
| **DAG Orchestration** | DAGExecutor | Automatic task decomposition and parallel scheduling |
| **Observer** | EvolutionEngine | Behavior-triggered improvement cycle |
| **Strategy** | Gateway | Multi-protocol strategy switching |
| **Pool** | AgentPoolManager | Dynamic agent instance pool with scaling |

---

## Project Structure

```
EvoClaw/
├── packages/
│   ├── core/              # @evoclaw/core — Types, config, service registry, event bus
│   ├── agent/             # @evoclaw/agent — Agent engine, system prompt, error classifier
│   ├── intelligence/      # @evoclaw/intelligence — Intent classification, multi-skill orchestration
│   ├── evolution/         # @evoclaw/evolution — Evolution engine, genetic engine, constraint gates
│   ├── memory/            # @evoclaw/memory — Short/long/vector/kg/FTS5 memory
│   ├── skills/            # @evoclaw/skills — Skill manager, registry, sandbox, parser
│   ├── security/          # @evoclaw/security — RBAC, audit, healing, tenant, device pairing
│   ├── gateway/           # @evoclaw/gateway — REST/WS/MCP gateway, protocol adapter
│   ├── infrastructure/    # @evoclaw/infrastructure — Logger, DB, MQ, filesystem, SSH sandbox
│   ├── plugin-sdk/        # @evoclaw/plugin-sdk — Plugin development SDK, PluginHost
│   ├── scheduler/         # @evoclaw/scheduler — Cron scheduling
│   ├── email/             # @evoclaw/email — Email client
│   ├── reporting/         # @evoclaw/reporting — Report generation
│   ├── claude-code-tools/ # @evoclaw/claude-code-tools — Claude Code programming tools
│   └── web-ui/            # @evoclaw/web-ui — React + Vite management console
├── apps/
│   ├── server/            # @evoclaw/server — Server entry point
│   └── cli/               # @evoclaw/cli — CLI tool (30+ commands)
├── data/                  # Runtime data (workspace, skills, memory, plugins)
└── pnpm-workspace.yaml    # Monorepo workspace config
```

---

## CLI Reference

EvoClaw provides a comprehensive CLI with 30+ sub-commands:

```bash
# Setup & Onboarding
evoclaw setup                    # Create base config and workspace
evoclaw onboard                  # Guided onboarding flow
evoclaw dashboard                # Open Web dashboard

# Health & Status
evoclaw health [--json]          # Health check
evoclaw status [--all]           # Runtime status
evoclaw doctor [--fix]           # System diagnostics & auto-fix

# Agent & Messages
evoclaw agent -m <msg>           # Run agent with message
evoclaw message send             # Send message to agent

# Skills
evoclaw skills search <q>        # Search skills
evoclaw skills install <s>       # Install skill
evoclaw skills list              # List installed skills

# Models
evoclaw models list              # List available models
evoclaw models set <id>          # Switch default model
evoclaw models scan              # Scan available models

# System
evoclaw logs [--follow]          # View logs
evoclaw config get <key>         # Get config value
evoclaw config set <key> <val>   # Set config value

# Security
evoclaw security audit           # Security audit
evoclaw secrets list             # List secrets

# Integrations
evoclaw mcp list                 # MCP server list
evoclaw plugins list             # Plugin list
evoclaw channels list            # Channel management
```

### Slash Commands (in Web Chat)

```
/help           Show all available commands
/clear          Clear current session
/new [model]    Start new session
/compact        Compress session context
/status         System status
/health         Health check
/model [name]   View or switch model
/skills         List installed skills
/memory <query> Semantic memory search
```

---

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
| `/api/feature-flags/:key` | GET/POST | Get/set feature flag |
| `/api/feature-flags/:key/evaluate` | POST | Evaluate feature flag |
| `/api/evolution/dashboard` | GET | Evolution engine data |
| `/api/canvas/projects` | GET/POST | Canvas project management |
| `/api/memory/search?q=` | GET | Semantic memory search |
| `/api/sandbox/backends` | GET | Available sandbox backends |
| `/metrics` | GET | Prometheus metrics |

Full API documentation is available in the Web UI.

---

## Configuration

EvoClaw uses a **dual-layer configuration** system:

| Layer | Storage | Management | Use Case |
|---|---|---|---|
| **Environment Variables** | `.env` file | Manual / `evoclaw setup` | Server port, secrets, feature flags |
| **Runtime Config** | Server memory | Web UI → LLM / Channels tabs | API keys, model selection, channel config |

### Key Environment Variables

| Variable | Default | Description |
|---|---|---|
| `EVOCLAW_PORT` | `27788` | Server listen port |
| `EVOCLAW_HOST` | `0.0.0.0` | Bind address |
| `JWT_SECRET` | — | JWT signing key (**must change for production**) |
| `EVOCLAW_EVOLUTION_ENABLED` | `true` | Enable evolution engine |
| `EVOCLAW_MCP_ENABLED` | `true` | Enable MCP protocol |
| `CORS_ORIGINS` | — | Allowed CORS origins |
| `RATE_LIMIT_MAX` | — | Rate limit max requests |

---

## Feature Flags

EvoClaw ships with 16 built-in feature flags, manageable from the Web UI:

| Flag | Default | Owner | Description |
|---|---|---|---|
| `evolution` | ✅ | core | Self-evolution engine |
| `compaction` | ✅ | core | Context compression for long conversations |
| `sandbox` | ✅ | security | Sandboxed skill execution |
| `mcp` | ✅ | integration | Model Context Protocol support |
| `a2ui` | ✅ | canvas | Agent-to-UI protocol for Canvas |
| `autoSkill` | ✅ | skills | Auto skill discovery & installation |
| `permissionFastTrack` | ✅ | security | Auto-approve whitelisted directory ops |
| `copilotRouter` | ✅ | optimization | Task-aware model routing |
| `hotReload` | ✅ | devops | Hot config reload without restart |
| `semanticMemory` | ✅ | memory | TF-IDF semantic search memory |
| `selfHealing` | ✅ | devops | Auto fault detection & recovery |
| `playwrightBrowser` | ✅ | browser | Playwright browser automation |
| `scheduledTasks` | ✅ | scheduler | Cron scheduled task execution |
| `weixinIntegration` | ❌ | integration | WeChat integration |
| `emailIntegration` | ❌ | integration | Email integration |
| `rolloutCanary` | ❌ | devops | Canary release (10% rollout) |

---

## Development

### Scripts

```bash
pnpm -r build       # Build all packages
pnpm start          # Start server (with UTF-8 encoding)
pnpm test           # Run all tests
pnpm typecheck      # Type check all packages
pnpm lint           # Lint all packages
pnpm cli --help     # CLI help
```

### Adding a New Skill

Create a folder under `data/workspace/skills/` with a `SKILL.md`:

```markdown
---
name: my-skill
version: 1.0.0
description: My custom skill
triggers:
  - type: keyword
    pattern: "my-skill"
---

## Instructions
Skill execution instructions...

## Examples
User: my-skill
EvoClaw: Executing my-skill...
```

EvoClaw auto-discovers skills on startup. No restart needed with hot-reload enabled.

### Web UI Development

```bash
cd packages/web-ui
pnpm dev        # Start Vite dev server with HMR
```

---

## Testing

```bash
pnpm test                           # Run all tests
pnpm --filter @evoclaw/core test    # Run specific package tests
```

Framework: **Vitest** | Convention: `*.test.ts` | Coverage: **78 test files, 1795 test cases**

---

## Documentation

| Document | Description |
|---|---|
| [History.md](History.md) | Version history and changelog |
| [deploy-checklist.md](deploy-checklist.md) | Multi-cluster deployment checklist |

---

## Troubleshooting

| Problem | Solution |
|---|---|
| `pnpm: command not found` | Reinstall pnpm: `npm install -g pnpm@10` |
| `port 27788 already in use` | Change `EVOCLAW_PORT` in `.env` or kill the occupying process |
| Build fails | Clean and retry: `pnpm clean && pnpm install && pnpm build` |
| Web UI blank page | Ensure `pnpm build` has been run, check browser console errors |
| LLM test connection fails | Check API Key and Base URL correctness, verify network reachability |
| Channel connection fails | Check if callback URL is publicly accessible, verify Token matches |
| `JWT_SECRET` warning | Set a JWT secret of at least 16 characters |

### Port Conflict

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

### Full Reset

```bash
pnpm clean
rm -rf node_modules pnpm-lock.yaml
pnpm install
pnpm build
pnpm test
```

### Viewing Logs

**systemd (Ubuntu)**: `sudo journalctl -u evoclaw -f`

**launchd (macOS)**: `tail -f ~/Library/Logs/evoclaw.log`

**Windows (winsw)**: `Get-Content .\evoclaw-service.out.log -Tail 50 -Wait`

---

## Security Best Practices

1. **Always change `JWT_SECRET`** in production to a random string of at least 32 characters
2. Configure firewall to only expose necessary ports (27788)
3. Use HTTPS reverse proxy (Nginx/Caddy) in production
4. Keep dependencies updated: `pnpm update`
5. Configure audit center alert rules
6. Set reasonable quota limits per tenant
7. Enable self-healing for automatic fault recovery
8. Restrict `CORS_ORIGINS` to trusted domains
9. Enable observability monitoring with alerting rules
10. Use CredentialPool for API key rotation

---

## Observability

Enable with `EVOCLAW_OBSERVABILITY_ENABLED=true` in `.env`. EvoClaw exposes Prometheus-compatible metrics at `/metrics` and supports distributed tracing via OTLP.

### Metrics Types

| Type | Description | Example |
|---|---|---|
| **Counter** | Monotonic counter for request/error totals | `evoclaw_http_requests_total` |
| **Gauge** | Current value for active connections, queue depth | `evoclaw_active_sessions` |
| **Histogram** | Distribution of request latency, response sizes | `evoclaw_request_duration_seconds` |

### Tracing

```ini
EVOCLAW_OBSERVABILITY_ENABLED=true
EVOCLAW_TRACING_ENDPOINT=http://localhost:4318/v1/traces
EVOCLAW_TRACING_SAMPLE_RATE=0.1
```

### Health Report

```bash
curl http://localhost:27788/health/report
```

---

## Supported Platforms

| Platform | Status |
|---|---|
| Ubuntu Server 22.04+ | ✅ Full support |
| Debian 12+ | ✅ Full support |
| macOS 13+ | ✅ Full support |
| Windows 10+ | ✅ Supported |
| Docker | ✅ Supported |

---

## Contributing

We welcome contributions of all kinds!

1. **Bug Reports** — Submit detailed issues via GitHub
2. **Feature Requests** — Share your ideas for new capabilities
3. **Code Contributions** — Fork → Branch → PR
4. **Skill Contributions** — Publish to [ClawHub](https://clawhub.ai)
5. **Documentation** — Improve docs, fix typos, add examples

### Development Flow

```bash
git checkout -b feature/my-feature
pnpm install && pnpm -r build
pnpm test
git commit -m "feat: add my feature"
git push origin feature/my-feature
# Open a Pull Request
```

### Code Style

- TypeScript strict mode
- Follow existing naming conventions
- Write tests for new features
- Ensure `pnpm typecheck` and `pnpm test` pass

---

## License

This project is licensed under the [MIT License](LICENSE).

---

<p align="center">
  <sub>Made with 🧬 by the EvoClaw Team</sub>
</p>

<p align="center">
  <sub>龙虾蜕壳，终成大器。EvoClaw 永不止步于进化之路。</sub>
</p>
