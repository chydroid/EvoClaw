# Changelog

All notable changes to this project will be documented in this file.

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
