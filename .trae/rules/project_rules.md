# EvoClaw Project Development Rules

## Build & Runtime

- Always use `pnpm` for all package management operations (install, build, test, start)
- Build command: `pnpm -r build`
- Start command: `pnpm start`
- Test command: `pnpm test`
- Server default port: `27788`

## File Editing Rules

- **NEVER use PowerShell (`Set-Content`, `Out-File`, etc.) for batch file content replacement operations**
  - PowerShell's `Set-Content` and `Out-File` can corrupt UTF-8 encoded files containing CJK characters
  - Use the `SearchReplace` tool or `Write` tool instead for all file content modifications
  - If bulk replacement is needed, use `SearchReplace` with multiple calls or use `git sed` via bash

## Version Control

- Version number is defined in root `package.json` and read dynamically by all sub-packages
- After any major change, update: version number, History.md, then commit and push to GitHub
- Commit messages should follow conventional commits format: `feat:`, `fix:`, `docs:`, `refactor:`, etc.

## Code Style

- TypeScript strict mode
- Follow existing naming conventions
- Write tests for new features
- Ensure `pnpm typecheck` and `pnpm test` pass before committing

## Brand

- Project icon: 🧬 (DNA double helix, representing "evolution")
- NOT 🦞 (lobster emoji) — that belongs to OpenClaw
- Title styling: "Evo" in near-white (#f0f0f0), "Claw" in accent color
