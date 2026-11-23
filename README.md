[English](README.md) | [中文](README.zh-CN.md)

---

<p align="center">
  <img src="https://github.com/chydroid/EvoClaw/raw/main/assets/images/evoclaw-400-100.png" alt="EvoClaw" width="420">
</p>

<h1 align="center">🧬 EvoClaw</h1>

<p align="center">
  <strong>A self-evolving AI assistant platform</strong><br>
  <sub>Skill learning, task orchestration and multi-channel access — with a deterministic delivery gate that checks what the task actually asked for</sub>
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

## What it is

EvoClaw runs an agent loop against any OpenAI-compatible LLM, gives it a toolbelt
(file, shell, browser, web, documents, media, memory, scheduler), and connects it to
chat channels, a REST/WebSocket gateway, an MCP bridge and a React Web UI.

Two design decisions shape the rest of the codebase:

- **Prompt cache is sacred.** Conversation history is append-only. Nudges, warnings
  and reminders are injected as *transient* messages that never enter history, so the
  cached prefix survives turn boundaries.
- **Completion is verified, not asserted.** Required artifacts named in the task text
  (including `≥300 bytes`, `at least 8 assertions`, `frozen fixture — do not modify`)
  are checked deterministically at the end of the turn. A model saying "done" is not
  evidence.

## Quick Start

### Prerequisites

- **Node.js** >= 20 — CI runs Node 22 and 24; Node 24 is recommended
- **pnpm** 10.33.2 (pinned via `packageManager`; pnpm >= 9 also works)

### Install and run

```bash
git clone https://github.com/chydroid/EvoClaw.git
cd EvoClaw

pnpm install                 # install workspace dependencies
cp .env.example .env         # then edit .env: JWT_SECRET, WEB_UI_TOKEN, provider keys
pnpm build                   # tsc for every package + vite build for the Web UI
pnpm start                   # cross-platform launcher (Windows gets chcp 65001 automatically)
```

Open **http://localhost:27788** (or `EvoClaw_PORT` from your `.env`).

> `pnpm start` and `pnpm cli` go through `scripts/launch.mjs`, so the same command works
> on Windows, Linux and macOS. `start:unix` / `start:win` are kept as aliases.

### Verify the install

```bash
pnpm build       # must run first — packages reference each other's built output
pnpm typecheck   # tsc --noEmit across all packages
pnpm test        # vitest via scripts/vitest-runner.mjs
```

### Configure your first LLM

1. Open the Web UI → **LLM** tab
2. Enable a provider, paste the **API key**, pick a **model**
3. Click **Save All**

Any OpenAI-compatible endpoint works: set the provider's **Base URL** and model name.
For a local model, run [Ollama](https://ollama.com) and use `http://localhost:11434/v1`.

### Authentication

The gateway requires authentication for everything except `/health`, `/api/health`,
the public skill catalog and static UI assets. Two options:

| Mode | How |
|---|---|
| Web UI token | Set `WEB_UI_TOKEN` in `.env`. The SPA receives it as an httpOnly cookie on first page load; API clients send `Authorization: Bearer <token>` or the `web_ui_token` cookie. |
| Admin login | `POST /api/auth/login {username,password}` returns a JWT. Credentials come from `EVOCLAW_ADMIN_USER` / `EVOCLAW_ADMIN_PASSWORD`; outside `NODE_ENV=production` they default to `admin` / `admin`. |

## Core capabilities

| Area | What you get |
|---|---|
| Conversation | Multi-provider, streaming, context compaction, MoA (mixture-of-agents) committee, model failover with credential-pool rotation |
| Task execution | Durable background tasks that survive restarts, checkpoints, budget-aware wrap-up, loop/duplicate-call detection, delegation to sub-agents |
| Delivery verification | Required-artifact contract from the task text, byte-size and assertion-count thresholds, frozen-input snapshot → archive → restore, honest end-of-turn footer |
| Skills | 11 bundled + 26 optional skills, marketplace install/search, security scanning, SkillCurator lifecycle with content-addressed ledger and rollback |
| Tools | 60 core tools, most action-multiplexed; optional Playwright/browser, Office docs, media (TTS/STT/image/video), computer use, tool search |
| Channels | WeChat, Weibo, Feishu, DingTalk, QQ, Telegram, WhatsApp, Discord, Slack, Matrix, plus REST, WebSocket, MCP, A2A and ACP/IDE |
| Memory | L0–L3 layered memory, short/long-term stores, FTS5 full-text (CJK-aware), vector/semantic retrieval, RAG pipeline, user modeling |
| Evolution | Experience distillation, reinforcement feedback, genetic search, A/B testing, skill auto-generation with sandboxed evaluation |
| Security | Command approval and allowlists, path/SSRF protection, secret redaction, audit trail, startup security audit, MCP tool-poisoning scanner, OSV supply-chain check |
| Operations | Process supervisor, shutdown forensics, queue drain control, rotating log appender, Prometheus `/metrics`, OTLP tracing export |

## Architecture

```
Browser / CLI / Channels / IDE (MCP) / A2A
                 │
        Gateway layer  (Express + WS + MCP + channel adapters)
                 │
             EventBus  (decoupled pub/sub)
                 │
   ┌─────────────┼──────────────┬─────────────┐
 Agent          Memory        Evolution     Security
 (orchestrator, (L0–L3, RAG,  (distill,      (governor,
  executor,      FTS5, vector)  genetic,      audit, RBAC,
  DAG, MoA)                     A/B)          policy)
   └─────────────┴──────────────┴─────────────┘
                 │
        Infrastructure (queue, process mgr, FS, logger, browser)
```

Key patterns: `ServiceRegistry` for IoC/DI, an actor system for concurrency,
DAG-based task decomposition, and a deterministic verification layer that sits
between the model's last message and the user.

### Packages

| Package | Responsibility |
|---|---|
| `packages/core` | Types, `ServiceRegistry`, `EventBus`, `ConfigManager`, plugin manager, feature flags |
| `packages/agent` | Task orchestration, agent/model executor, sessions, context engine, compaction, delegate engine, DAG/MoA |
| `packages/gateway` | Gateway server, channel manager and adapters, protocol handling, MCP, auth, streaming |
| `packages/skills` | Skill manager, marketplace registry, curator, dispatcher, index |
| `packages/memory` | Memory hub, semantic/vector store, FTS5, RAG, memory providers |
| `packages/security` | Security governor, audit center, RBAC, tenant isolation, tool policy, scanners |
| `packages/evolution` | Evolution engine, experience distillation, genetic engine, A/B tests |
| `packages/infrastructure` | Message queue, process manager, filesystem, logger, browser controller, observability |
| `packages/scheduler` | Cron scheduler and schedule manager |
| `packages/reporting` | Report generation |
| `packages/intelligence` | Task classification and skill orchestration |
| `packages/plugin-sdk` | Plugin/tool development SDK |
| `packages/email` | Email client |
| `packages/web-ui` | React 19 + Vite frontend (59 pages) |
| `packages/claude-code-tools` | Claude Code tool integration |

Apps: `apps/server` (entrypoint, port 27788), `apps/cli` (the `evoclaw`/`openclaw` CLI),
`apps/mcp-server` (stdio MCP bridge so IDEs can use EvoClaw's tools).

## Tools

60 tools are registered at startup (the live MCP `tools/list` returns the same count).
Most are **action-multiplexed** — one tool, several behaviours — which keeps the tool
payload small enough to stay cache-friendly:

```text
file_write(action=create|modify|edit)   shell_exec      execute_code
browser_*(navigate|act|screenshot|…)    web_search(action=search|research|browser)
web_fetch   document(action=docx|xlsx|pptx)   memory   todo_list   scheduler
skill_manage|skill_list|skill_view      delegate_task  kanban   verify_project
text_to_speech  audio_to_text  image_generate  video  vision_analyze
```

`computer_use` only appears when a desktop backend (native / nut.js / robotjs) is
available — it is gated by `checkFn`, so a headless server never advertises it.
Over the MCP bridge, `shell_exec`, `execute_code`, `file_write`, `file_delete` and
`video` are additionally blocked; use the Web UI or CLI agent path for those.

Optional capabilities are gated by their dependency: browser tools need Playwright,
local embeddings need `@huggingface/transformers`, FTS5 needs `better-sqlite3`.
Missing dependencies disable the tool instead of failing the request.

## CLI

53 commands. The examples below are the verified surface (`pnpm cli <command>`):

```bash
# Setup & diagnostics
pnpm cli setup                       # create base config and workspace dirs
pnpm cli onboard                     # guided onboarding
pnpm cli health [--json]             # gateway health
pnpm cli status [--all]              # service and system status
pnpm cli doctor [--fix] [--deep]     # diagnostics and auto-repair

# Agent
pnpm cli agent -m "summarize ./README.md"
pnpm cli chat                        # interactive REPL
pnpm cli sessions                    # list chat sessions

# Models & config
pnpm cli models list [provider]
pnpm cli models set openai/gpt-4o
pnpm cli config list
pnpm cli config get llm
pnpm cli config set llm.defaultProvider openai

# Skills
pnpm cli skills search <query>
pnpm cli skills install <slug>
pnpm cli skills list
pnpm cli skills list-optional        # 26 optional skills
pnpm cli skills install-optional <name>

# MCP (as a client and as a server)
pnpm cli mcp list
pnpm cli mcp external list           # external MCP servers EvoClaw consumes
pnpm cli mcp external add firecrawl '{"type":"stdio","command":"npx","args":["-y","firecrawl-mcp"]}'
pnpm cli mcp oauth login <server>    # OAuth (PKCE / device code)
pnpm cli mcp serve                   # expose EvoClaw tools over stdio to an IDE

# Channels & security
pnpm cli channels list
pnpm cli channels capabilities
pnpm cli security audit
pnpm cli secrets list                # values are always masked
```

Run `pnpm cli --help` for the full list. `--json`, `--profile <name>`, `--dev` and
`--log-level` are global flags.

## REST API

~360 `/api/*` routes. A representative slice:

| Endpoint | Method | Purpose |
|---|---|---|
| `/health`, `/api/health` | GET | Liveness/readiness with per-subsystem detail |
| `/api/auth/login` | POST | Exchange admin credentials for a JWT |
| `/api/chat` | POST | Send a message (soft timeout hands long work to a durable task) |
| `/api/chat/resume` | POST | Resume a session |
| `/api/durable-tasks`, `/api/durable-tasks/:id` | GET | Background task status |
| `/api/workspace` | GET/POST | Read or switch the runtime workspace |
| `/api/system/services` | GET | Service registry status |
| `/api/config/llm`, `/api/config/channels` | GET/PUT | Provider and channel config |
| `/api/skills` | GET | Installed skills (public) |
| `/api/marketplace/search` | GET | Skill marketplace (public, read-only) |
| `/api/memory/search?q=` | GET | Semantic memory search |
| `/api/evolution/dashboard` | GET | Evolution metrics |
| `/api/feature-flags` | GET | Feature flag state |
| `/api/kanban/*` | GET/POST | Multi-agent work queue |
| `/metrics` | GET | Prometheus metrics (auth required) |

## Configuration

Key variables in `.env` (full list with comments in `.env.example`):

| Variable | Default | Purpose |
|---|---|---|
| `EvoClaw_PORT` | `27788` | HTTP port (note the mixed case — all-caps `EVOCLAW_PORT` is **not** read) |
| `EvoClaw_HOST` | `0.0.0.0` | Bind address; use `127.0.0.1` for loopback-only |
| `JWT_SECRET` | — | JWT signing key, **change it**; ≥16 chars or a warning is printed |
| `WEB_UI_TOKEN` | — | Web UI/API token; empty disables token auth (admin login still applies) |
| `EVOCLAW_ADMIN_USER` / `EVOCLAW_ADMIN_PASSWORD` | `admin`/`admin` outside production | `/api/auth/login` credentials |
| `CHAT_TIMEOUT_MS` | `360000` | Soft timeout: checkpoint + continue in background, return a `⏳` reply; `0` disables |
| `EvoClaw_EVOLUTION_ENABLED` | `true` | Evolution engine |
| `EvoClaw_MCP_ENABLED` | `true` | MCP protocol |
| `EvoClaw_REST_ENABLED` | `true` | REST API |
| `CORS_ORIGINS` | — | Allowed origins |
| `RATE_LIMIT_MAX` | `100` | Requests per window |
| `EVOCLAW_OTLP_ENDPOINT` | — | OTLP/HTTP trace export |
| `EVOCLAW_MARKETPLACE_REGISTRY_URL` | mirror | Skill marketplace registry |

## Project structure

```
EvoClaw/
├── apps/
│   ├── server/          # main entrypoint (EvoClawServer, port 27788)
│   ├── cli/             # evoclaw / openclaw CLI (53 commands)
│   └── mcp-server/      # stdio MCP bridge for IDEs
├── packages/            # 15 workspace packages (see table above)
├── scripts/             # launch.mjs, vitest runner, release/osv tooling
├── docs/                # plugin guide + Hermes/OpenSpace alignment notes
└── data/                # runtime state: workspace, skills, sessions, checkpoints
```

## Development

```bash
pnpm build        # required before typecheck/test
pnpm typecheck
pnpm test         # 396 files / 8036 tests
pnpm test:watch
pnpm lint         # eslint flat config (repo has pre-existing warnings)
```

`pnpm dev` runs `tsc --watch` in every package and Vite for the Web UI. The Vite dev
server proxies `/api` to `EvoClaw_PORT` (read from the environment or root `.env`).

Conventions: TypeScript strict ESM (NodeNext), Vitest, no `any`, atomic writes for
persistent state (`atomicWriteFileSync`), cross-process locks for cron/session state,
Chinese comments and docs, and append-only prompt history.

## Docker

```bash
docker build -t evoclaw .
docker run -p 27788:27788 --env-file .env evoclaw
```

Or with Compose (pulls `ghcr.io/chydroid/evoclaw:latest` by default):

```bash
docker compose up -d
```

The image is `node:24-alpine`, exposes `27788`, and health-checks `/health`.

## Troubleshooting

| Symptom | Fix |
|---|---|
| `pnpm: command not found` | `npm install -g pnpm@10` (or `corepack enable`) |
| `pnpm start` fails with `chcp: not found` | You are on an old checkout — `scripts/launch.mjs` is the cross-platform launcher |
| Port already in use | Change `EvoClaw_PORT`, or `lsof -i :27788` / `netstat -ano \| findstr :27788` then kill |
| Web UI shows 401 / blank | Set `WEB_UI_TOKEN` (or log in via `/api/auth/login`); check the browser console |
| `pnpm dev` UI calls fail | Ensure the backend is running on `EvoClaw_PORT`; the proxy target comes from env/`.env` |
| Build fails after pulling | `pnpm clean && pnpm install && pnpm build` |
| Browser tools unavailable | `pnpm add playwright -F @evoclaw/infrastructure && pnpm exec playwright install chromium` |
| Tests fail with ENOENT storms | Do not delete temp dirs recursively in test cleanup; see `docs/` notes |

## Contributing

Issues and PRs are welcome — see [CONTRIBUTING.md](CONTRIBUTING.md).
Run `pnpm build && pnpm typecheck && pnpm test` before opening a PR.

## Security

Report vulnerabilities per [SECURITY.md](SECURITY.md). Never commit `.env`.

## License

[MIT](LICENSE)

---

Detailed history lives in [CHANGELOG.md](CHANGELOG.md).
