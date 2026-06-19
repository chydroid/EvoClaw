# AGENTS.md — EvoClaw

Telegraph style. Root rules only. Read scoped `AGENTS.md` before subtree work.
Skills own workflows; root owns hard policy and routing.

## Project overview

EvoClaw is a self-evolving AI assistant platform. TypeScript pnpm monorepo, 14 internal packages + 2 apps.

## Quick commands

```bash
pnpm install          # install all deps
pnpm build            # tsc for every package (build before typecheck)
pnpm typecheck        # tsc --noEmit across all packages
pnpm test             # vitest run (requires build first)
pnpm test:watch       # vitest in watch mode
pnpm lint             # pnpm -r lint (only api-gateway has eslint; main packages have none)
```

**Required order for verification: `pnpm build -> pnpm typecheck -> pnpm test`**

Run a single package:
```bash
pnpm --filter @evoclaw/core typecheck
pnpm --filter @evoclaw/agent typecheck
```

## Map

- Core TS: `packages/`, `apps/`; plugins: `packages/plugin-sdk/`; channels: `packages/gateway/`; docs: `docs/`.
- Scoped guides: `packages/`, `apps/`, `docs/`, `scripts/`.

## Architecture

- **`apps/server`** — Main server entrypoint. `EvoClawServer` class wires all layers together. Runs on port 27788.
- **`apps/cli`** — CLI tool (`evoclaw` / `openclaw` command). Ships `commander`-based CLI.
- **`packages/core`** — Foundation: types, ServiceRegistry, EventBus, ConfigManager, PluginManager, ConfigValidator, FeatureFlagStore.
- **`packages/agent`** — Brain: TaskOrchestrator, ActorSystem, CopilotRouter, SessionManager, AgentPoolManager, AgentModelExecutor, ContextEngine, SubagentRegistry, AutoReplyEngine, CommitmentManager.
- **`packages/gateway`** — GatewayServer, ChannelManager, ProtocolHandler, WeixinPluginAdapter, DeadLetterQueue, ReplyReferenceManager.
- **`packages/skills`** — SkillManager, AutoSkillManager, SkillDispatcher, SkillIndex.
- **`packages/memory`** — MemoryHub, SemanticMemoryStore, MemoryHost. RAG pipeline support.
- **`packages/security`** — SecurityGovernor, AuditCenter, TenantManager, PermissionManager, SecurityMiddleware, ToolPolicyManager, DMPairingManager, MCPToolPoisoningScanner.
- **`packages/evolution`** — EvolutionEngine (self-improvement loop).
- **`packages/infrastructure`** — MessageQueue, ProcessManager, FileSystemManager, BrowserController, PlaywrightBrowser, Logger, Crestodian, Observability.
- **`packages/scheduler`** — ScheduleManager, CronScheduler.
- **`packages/reporting`** — ReportGenerator.
- **`packages/intelligence`** — TaskClassifier, SkillOrchestrator.
- **`packages/plugin-sdk`** — Plugin development SDK. See `docs/plugin-development.md`.
- **`packages/email`** — EmailClient.
- **`packages/web-ui`** — React 19 + Vite frontend. **Uses vite build, not just tsc.** Dev: `pnpm dev` in web-ui.
- **`packages/claude-code-tools`** — Claude Code tools integration.

Tool registration lives in `apps/server/src/tools/` (file-tools, browser-tools, web-tools, email-tools, scheduler-tools, shell-media-tools, skill-tools, skill-index-tools).

## Conventions

- **TypeScript**: strict mode, ES2022 target, NodeNext module resolution. See `tsconfig.base.json`.
- **Package manager**: pnpm 10.33.2 (enforced via `packageManager` field). Only `better-sqlite3` and `esbuild` are allowed to run build scripts.
- **Workspace protocol**: Internal deps use `"workspace:*"`.
- **Test framework**: Vitest. Tests at `packages/*/src/**/*.test.ts`, `packages/*/tests/**/*.test.ts`, `apps/*/tests/**/*.test.ts`. 30s test timeout, 10s hook timeout.
- **No ESLint in main packages**. `api-gateway/` is a separate sub-project with its own eslint and jest — don't mix it with the main workspace.
- **`.env` loading**: Server reads `dotenv` from root `.env` at runtime. Start uses `chcp 65001` on Windows for UTF-8.
- **Language**: Code comments and docs are in Chinese (zh-CN).
- **Docker**: `docker build -t evoclaw . && docker run -p 27788:27788 --env-file .env evoclaw`. Health check on `/health`.
- **Git hooks**: Run `setup-hooks.bat` (Windows) or `bash setup-hooks.sh` (Linux/Mac) after cloning.

## Code Review

- Reviews need source, tests, current/shipped behavior, and dependency contract proof.
- High confidence required. Default to exhaustive codebase search before verdict.
- Read the whole changed function/module plus callers, callees, sibling implementations, adjacent tests, and dependency contracts before saying `good` or `bad`.
- Dependency-touching work: inspect dependency source/docs/types directly. No assumptions.
- Live-verify when feasible. Never print secrets.

## Code Style

- TS ESM, strict. Avoid `any`; prefer real types, `unknown`, narrow adapters.
- No `@ts-nocheck`. Lint suppressions only intentional + explained.
- External boundaries: prefer `zod` or existing schema helpers.
- Runtime branching: discriminated unions over freeform strings.
- Prefer early returns over nested condition pyramids.
- Code size matters. Prefer small clear code.
- Refactors should delete about as much complexity as they add.
- Keep APIs narrow: export only what callers need.
- Tests prove behavior/regressions, not every internal branch.

## Tests

- Vitest. Colocated `*.test.ts`.
- Clean timers/env/globals/mocks/temp dirs.
- Prefer injection and narrow mocks over broad barrels.
- Do not edit baseline/snapshot files to silence checks without approval.

## Gotchas

- `pnpm build` must complete before `pnpm typecheck` or `pnpm test` — packages reference each other's built output.
- CI runs on Node 22 and 24. `engines` field requires Node >= 20.
- `pnpm -r lint` only succeeds if api-gateway is excluded or has no lint errors. Main packages have no lint scripts.
- Vitest config maps `@evoclaw/*` aliases to `packages/*/src` — tests run against source, not dist.
- The `go-bookstore/` directory is a standalone Go microservices demo, not part of the pnpm workspace.
- `coding-tasks/` directory (if present) also has tests picked up by vitest config.
- Port is 27788 (README.md). `.env.example` and Dockerfile show 17788 — those are outdated or wrong.
