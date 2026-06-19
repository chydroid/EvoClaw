# Contributing to EvoClaw

Thank you for your interest in contributing to EvoClaw!

## Quick Links

- **GitHub:** https://github.com/chydroid/EvoClaw
- **Vision:** [`VISION.md`](VISION.md)
- **Security:** [`SECURITY.md`](SECURITY.md)

## How to Contribute

1. **Bugs & small fixes** → Open a PR directly
2. **New features / architecture** → Open a [GitHub Issue](https://github.com/chydroid/EvoClaw/issues/new) first to discuss
3. **Refactor-only PRs** → Only if explicitly requested by maintainers
4. **Questions** → Open a GitHub Issue

## Development Setup

### Prerequisites

- Node.js >= 20
- pnpm >= 10

### Getting Started

```bash
# Clone the repository
git clone https://github.com/chydroid/EvoClaw.git
cd EvoClaw

# Install dependencies
pnpm install

# Build all packages (required before typecheck/test)
pnpm build

# Run type checking
pnpm typecheck

# Run tests
pnpm test
```

**Important:** Always run `pnpm build` before `pnpm typecheck` or `pnpm test`. Packages reference each other's built output.

### Running a Single Package

```bash
# Typecheck a specific package
pnpm --filter @evoclaw/core typecheck

# Run tests for a specific package
pnpm --filter @evoclaw/agent test
```

## Code Style

- **TypeScript**: Strict mode, ES2022 target, NodeNext module resolution
- **Formatter**: No enforced formatter (follow existing style)
- **Linting**: No ESLint in main packages
- **Language**: Code comments and documentation in Chinese (zh-CN)

## Testing

- **Framework**: Vitest
- **Test locations**: `packages/*/src/**/*.test.ts`, `packages/*/tests/**/*.test.ts`, `apps/*/tests/**/*.test.ts`
- **Timeout**: 30s test timeout, 10s hook timeout
- **Run all tests**: `pnpm test`
- **Watch mode**: `pnpm test:watch`

## Project Structure

```
EvoClaw/
├── apps/
│   ├── server/          # Main server entrypoint
│   └── cli/             # CLI tool
├── packages/
│   ├── core/            # Foundation types and services
│   ├── agent/           # Agent system and task orchestration
│   ├── gateway/         # Channel and protocol handling
│   ├── skills/          # Skill management
│   ├── memory/          # Memory and RAG
│   ├── security/        # Security governance
│   ├── evolution/       # Self-improvement engine
│   ├── infrastructure/  # Core infrastructure services
│   ├── scheduler/       # Task scheduling
│   ├── reporting/       # Report generation
│   ├── intelligence/    # Task classification
│   ├── plugin-sdk/      # Plugin development SDK
│   ├── email/           # Email client
│   ├── web-ui/          # React frontend
│   └── claude-code-tools/ # Claude Code integration
├── api-gateway/         # Separate API gateway (standalone)
└── go-bookstore/        # Standalone Go demo (not part of workspace)
```

## Commit Messages

Use clear, descriptive commit messages. Examples:

- `feat: add email notification support`
- `fix: resolve memory leak in session manager`
- `docs: update API documentation`
- `refactor: simplify task orchestrator logic`

## Pull Request Process

1. Create a feature branch from `main`
2. Make your changes
3. Ensure all checks pass:
   ```bash
   pnpm build
   pnpm typecheck
   pnpm test
   ```
4. Open a PR with a clear description of changes
5. Wait for CI to pass and review

## CI/CD

GitHub Actions runs on push to `main` and `develop`, and on PRs:

- **Lint & TypeCheck**: `pnpm build && pnpm typecheck`
- **Tests**: `pnpm test` (Node 22 and 24)
- **Build**: Full build verification
- **Docker**: Build and push on main/tags

## Reporting Issues

When reporting bugs, please include:

- Steps to reproduce
- Expected behavior
- Actual behavior
- Environment (Node version, OS, etc.)
- Relevant logs or error messages

## License

By contributing, you agree that your contributions will be licensed under the MIT License.
