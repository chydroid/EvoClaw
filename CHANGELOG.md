# Changelog

All notable changes to EvoClaw will be documented in this file.

## [0.36.0] - 2026-06-19

### Added

- **retry-utils**: Dual-jitter retry system with symmetric/positive modes, crypto-secure random, AbortSignal-interruptible sleep, and Retry-After contract support
- **failover-policy**: Transient vs non-transient failover classification (15 reason types), cooldown probing with probe budget, and smart circuit-breaker integration
- **error-classifier**: Enhanced with jitter-randomized backoff, reason/isTransient/hasRetryAfterContract fields
- **copilot-router**: LRU+TTL route cache with hit/miss statistics, provider health awareness (skip circuit-open providers)
- **queue-manager**: 5 named lanes (main/cron/subagent/nested/background) with independent concurrency limits, generation field for stale task detection, draining mode with QueueDrainingError
- **skill-sandbox**: `buildCliArgs()` for proper Python CLI argument mapping, `selectBestCommand()` for intent-based command template selection, `injectParamsToCommand()` for parameter injection into command templates
- **62 new test cases** covering retry-utils, failover-policy, copilot-router, queue-manager, and error-classifier

### Fixed

- **Critical: Python skill parameter passing** — `executePython()` was only passing `{query: "..."}` to Python scripts, discarding `--code`, `--market`, `--limit` and other CLI arguments. Now properly maps params to argparse CLI arguments
- **Critical: Default result command selection** — `createDefaultResult()` always executed the first command template regardless of user intent. Now selects the correct template based on action and query intent keywords
- **limit parameter type mismatch** — `web_search` and `scheduler_history` tools declared `limit` as `type: "string"` but semantically it's an integer. Changed to `type: "number"` to prevent LLM confusion
- **shell_exec approval blocking** — Python script execution via `shell_exec` was marked as `critical` risk requiring approval. Changed to `low` risk for auto-approval, with additional HITL bypass for Python commands
- **skill_execute approval** — Added `skill_execute: "low"` to risk levels so skill execution is auto-approved

### Changed

- `human-approval.ts`: `shell_exec` risk level from `"critical"` to `"low"`, added `skill_execute: "low"`
- `llm-caller.ts`: Added `isPythonScriptExecution` check to bypass HITL approval for Python commands
- `skill-sandbox.ts`: `executePython()` now uses `buildCliArgs()` instead of JSON-wrapping params; `createDefaultResult()` uses `selectBestCommand()` + `injectParamsToCommand()` instead of always using first template
- `web-tools.ts`: `limit` parameter type from `"string"` to `"number"`
- `scheduler-tools.ts`: `limit` parameter type from `"string"` to `"number"`
