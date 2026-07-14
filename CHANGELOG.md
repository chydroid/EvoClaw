# Changelog

All notable changes to this project will be documented in this file.

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
