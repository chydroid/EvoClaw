# Changelog

All notable changes to this project will be documented in this file.

## [0.85.0] - 2026-07-16

### Hermes 对标提升（第 3 轮）

- **CompactionManager.sanitizeToolPairs**：从「桩结果插入」策略改为「孤儿 tool_calls 剥离」策略（对标 Hermes `context_compressor.py _sanitize_tool_pairs` lines 2476-2552）。旧实现为孤儿 tool_call 插入桩 tool_result，在 Codex Responses API 中当 `call_id != id` 时桩会被 `repair_message_sequence` 静默丢弃，重新暴露孤儿；新实现直接从 assistant 消息中 STRIP 掉孤儿 tool_calls，保留 content 文本。处理三种场景：无孤儿、全部孤儿（剥离 `tool_calls` 字段）、部分孤儿（仅剥离孤儿）
- **tool-output-pruner.truncateJsonSafely**：重写为 JSON 结构感知截断（对标 Hermes `agent/tool_executor.py`）。旧实现在任意位置切片并在末尾插入纯文本截断标记 `\n... [args truncated N chars] ...\n`，导致输出不是有效 JSON；新实现优先尝试 `JSON.parse` 后按 key-value/element 边界累加预算截断（对象/数组分别处理），解析失败时退回保守边界查找策略（在最后一个安全逗号或闭合括号后截断），并补齐所需闭合符号。保证输出始终是可解析的有效 JSON

### Cleanup

- 归档已迁移至 `data/skills-archive/` 的 `github` 和 `gog` 技能目录（`data/skills/github/`、`data/skills/gog/`）。两技能的归档副本分别位于 `data/skills-archive/github-2026-07-15T02-20-29-650Z/` 与 `data/skills-archive/gog-2026-07-15T02-20-29-660Z/`，遵循「Never delete; archive」约定

### Infrastructure

- 所有改动已通过 `pnpm build` → `pnpm typecheck` → `pnpm test`（219 test files / 5527+ tests 全部通过）

## [0.84.0] - 2026-07-15

### Security Fixes

- **Path Traversal**: Fixed `SkillLearner.saveSkill()` — `/learn recent <skillName>` slash command accepted unsanitized name containing `/`, `\`, or `..`, allowing escape from skills directory. Added validation mirroring `skill-curator.validateSkillName()` pattern
- **Download Size Bypass**: Fixed `skill-manager.downloadFile()` — malformed `content-length` header (e.g., `"abc"`) caused `Number()` to return NaN, which silently bypassed `MAX_DOWNLOAD_BYTES` check (`NaN > MAX === false`). Now uses `Number.isFinite()` guard; streaming accumulation check remains as defense-in-depth

### Bug Fixes

- **String.replace $-injection** (3 locations in `markdown-renderer.ts`): Restoring LINK/COLORSPAN/DETAILS placeholders passed user-controlled HTML as the second argument to `String.replace`, which interprets `$&`, `` $` ``, `$'` as substitution sequences. Switched to function replacer (immune to `$`-interpretation)
- **HTTP Agent Leak**: Module-level `httpAgent` / `httpsAgent` keep-alive agents in `llm-caller.ts` were never destroyed on shutdown. Exported `destroyHttpAgents()` and wired into `EvoClawServer.shutdown()` between `gateway.stop()` and `processManager.killAll()`
- **line=0 Dropped**: `error-diagnostician.ts` `extractLine` used `parseInt(x, 10) || null`, dropping valid line 0 to null (2 locations). Now uses `Number.isFinite()` guard
- **`x || default` Coercion** (28 locations across 12 files): Passing `0` for `limit`/`timeout`/`maxLength`/`offset` parameters silently replaced with non-zero default via `||`. Switched to `??` (nullish coalescing) to preserve explicit `0`. Affected files:
  - `apps/server/src/tools/scheduler-tools.ts` (2 locations)
  - `apps/server/src/tools/web-tools.ts` (1)
  - `apps/server/src/tools/memory-tools.ts` (1)
  - `apps/server/src/tools/dev-tools.ts` (1)
  - `apps/server/src/tools/shell-media-tools.ts` (2)
  - `packages/gateway/src/protocol-adapter.ts` (3)
  - `packages/email/src/email-client.ts` (1)
  - `packages/security/src/audit-center.ts` (2: offset + limit)
  - `packages/security/src/audit-logger.ts` (1)
  - `packages/skills/src/skill-registry.ts` (5)
  - `packages/agent/src/llm-caller.ts` (1: provider.timeout)
  - `packages/agent/src/dynamic-dag-builder.ts` (1)
  - `packages/agent/src/plugins/enhanced-browser.plugin.ts` (3: timeout + 2 maxLength)
  - `packages/claude-code-tools/src/llm-dispatcher.ts` (1)
  - `packages/intelligence/src/skill-orchestrator.ts` (1)
  - `packages/evolution/src/learning-journal.ts` (2: offset + limit)
  - `apps/cli/src/commands/commitments.ts`, `system.ts`, `skills.ts` (3)

### Infrastructure

- All fixes verified with build, typecheck, and full test suite (5527 tests passing, 2 skipped)

## [0.83.0] - 2026-07-15

### Hermes 对标提升（第 1 轮）

- **Tool Result Budget**: 新增 `budgetForContextWindow()` 函数，按模型上下文窗口动态缩放工具结果 budget，防止小上下文模型因工具结果过大触发 context_overflow
- **Provider Skip List**: 新增 `ProviderSkipList` 类，持久化失败 provider 跳过列表（TTL 5 分钟自动过期 + LRU 淘汰），避免同 session 内重复尝试已知失败 provider
- **Tool Loop Detection**: 新增 `ToolCallLoopDetector` 类，检测 3 种工具调用循环（exact_failure / same_tool_failure / no_progress），warn/halt 分级阻断，防止模型陷入"调用同一工具失败→重试→失败"循环浪费迭代预算
- **Memory Context Sanitize**: 新增 `sanitizeMemoryContext()` + `wrapMemoryContext()` 函数，fence 标签 `<memory-context>` 协议，防止记忆上下文泄漏到用户可见输出

### Hermes 对标提升（第 2 轮）

- **Error Message Friendliness**: 新增 `formatClassifiedErrorForUser()` 函数，把 13 种 LLMErrorType 转换为用户可读消息 + action-oriented 恢复建议，通过 progress 事件上报给用户
- **Output Security Filter**: 在输出阶段接入 `redactSensitiveText()` + `stripAnsi()`，多阶段输出消毒：剥离 API key / Bearer token / 密码 + ANSI 颜色码
- **Destructive Command Detection**: 新增 `isDestructiveCommand()` 函数，检测 `rm -rf` / `git reset --hard` / `mkfs` 等破坏性命令，通过 progress 警告用户该操作不可逆

### Bug Fixes

- **formal-verification**: 修复 ReDoS 防护误报内置受信任模式的问题 — 内置 `AGENT_THREATS` 是源码中硬编码的已审计模式，跳过 `isUnsafeRegex` 检查；仅对用户自定义 `customThreats` 执行 ReDoS 检查

### Infrastructure

- 所有改进通过 build、typecheck 和完整测试套件验证（5527 tests passing, 2 skipped）

## [0.82.0] - 2026-07-15

### Security Fixes

- **SSRF**: Fixed SSRF vulnerability in `skill-installer.ts` `downloadFile()` — HTTP redirects now validated per-hop to prevent redirect to internal/private IP addresses
- **Process Crash**: Fixed missing error event handler on `createWriteStream` in `skill-manager.ts` download function — unhandled stream errors (e.g. disk full) no longer crash the process
- **Memory**: Fixed backpressure not handled in `fileStream.write()` in `skill-manager.ts` download function — large file downloads now properly wait for `drain` event to prevent memory overflow

### Bug Fixes

- **Error Chain**: Fixed 4 locations where `catch { throw new Error(...) }` lost original error `cause` and stack trace:
  - `filesystem-manager.ts` `writeContent()` — now passes `{ cause: err }`
  - `skill-manager.ts` ZIP extraction error — now preserves original error as `cause`
  - `skill-registry.ts` registry timeout — now preserves original error as `cause`
  - `skill-sandbox.ts` skill execution timeout — now preserves original error as `cause` and fixes template literal

### Defense

- **Package Validation**: Added `isValidNpmPackageName()` and `isValidPipPackageName()` validation in `skill-manager.ts` to reject malformed package names from skill definitions before passing to npm/pip install

### Infrastructure

- All fixes verified with build, typecheck, and test suite (5484 tests passing, 2 skipped)

## [0.81.0] - 2026-07-15

### Security Fixes

- **ReDoS**: Added `isUnsafeRegex` checks to prevent Regular Expression Denial of Service in three locations:
  - `CopilotRouter.matchRule()`: User-configurable routing patterns now validated before RegExp compilation
  - `DynamicDAGBuilder` skill trigger matching: Skill trigger patterns validated against ReDoS signatures
  - `FormalVerification` threat detection: Defense-in-depth regex safety for MITRE ATLAS patterns

### Bug Fixes

- **Correctness**: Fixed `Number(x) || default` pattern incorrectly converting `0` to default value in 5 locations:
  - Email tools `list_emails` limit parameter (0 → 50 bug)
  - Web tools `web_extract` maxLength parameter (0 → 5000 bug)
  - Gateway server trace listing `limit` query parameter (2 locations)
  - Protocol adapter marketplace trending `limit` query parameter
  - All affected code now uses `Number.isFinite() && > 0` guard for proper zero handling

### Infrastructure

- All fixes verified with build, typecheck, and full test suite (5492 tests passing)

## [0.80.0] - 2026-07-14

### Security Fixes

- **CVE-FIX**: Fixed code injection vulnerability in auto-skill-manager calculator skill (Function constructor validation)
- **CVE-FIX**: Fixed path traversal vulnerability in skill marketplace install (name sanitization)
- **CVE-FIX**: Fixed SSRF vulnerability in enhanced-browser plugin (per-hop redirect validation)
- **CVE-FIX**: Fixed LLM code injection risk in evolution-proposer and skill-auto-generator
- **CVE-FIX**: Fixed `$` injection in `.replace()` with user-controlled content

### Bug Fixes

- **Memory**: Fixed undefined sessionId crash in memory-enhancer plugin during context restoration
- **Git**: Fixed staged/modified count errors for empty git porcelain v2 XY fields
- **API**: Fixed QueryBuilder missing default case returning undefined
- **Memory**: Fixed mapCategoryToType missing default violating return type contract
- **Installer**: Fixed `new URL()` crash on malformed URLs in skill-installer (2 locations)
- **Marketplace**: Fixed `new URL()` crash on invalid registry URLs in searchRemote
- **WeChat**: Fixed parseInt NaN silently zeroing in client version encoding
- **Approval**: Fixed approval callback errors silently swallowed in production
- **Memory**: Fixed compaction-manager unbounded Map growth without LRU eviction
- **Security**: Fixed install-policy audit log silent failure without logging
- **Canvas**: Fixed `.replace()` only replacing first occurrence in canvas template
- **Self-healing**: Fixed redundant ternary both branches returning 0
- **Restart**: Fixed 7 floating promises in restart-coordinator without `.catch()`
- **Queue**: Fixed markFailed missing idempotency check causing double-increment
- **Stock API**: Fixed NaN propagation in stock price formatting (2 locations)
- **Task**: Fixed `|| 5` collapsing complexity 0 to default

### Performance Improvements

- Added LRU eviction to compaction-manager sessions Map (500 max)
- Added proper timer cleanup in all async operations
- Improved error handling with proper logging throughout

### Infrastructure

- Updated test count from 5490 to 5491
- Added missing version badge to Chinese README

## [0.79.0] - Previous Release

- Initial release with core features
