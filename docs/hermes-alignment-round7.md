# Hermes 对齐第七轮：空闲压缩 + 网页截断回读 + 结果缓存

日期：2026-11-15
参照：`/home/chy/projects/hermes-latest`（origin/main `fd8a6c41ac`，2026-11-15）
验证：`pnpm build → pnpm typecheck → pnpm test` 全绿。

本轮在第五/六轮（MCP、cron、审批、记忆闸门等）之后，对照最新 Hermes 主干，补齐三个
**只移植不变量、不搬架构** 的独立能力。全部默认关闭或安全默认，可回滚。

---

## 1. 空闲触发压缩（Idle-Triggered Compaction）

**对标**：`agent/turn_context.py:519 _should_idle_compact` +
`agent/turn_context_compaction.py:144 _idle_compaction`。

**动机**：EvoClaw 原先只在 token 触及 `compactionTokenThreshold` 时于 turn 起点压缩
（`session-persistence.ts needsCompaction`）。从长时间空闲恢复的长会话，若未触及阈值，
首轮会把大段历史重新灌回上下文，token 压力与首 token 延迟都高。

**落地**：
- `packages/agent/src/idle-compaction.ts`：纯谓词 `shouldIdleCompact` + `idleFloorTokens`
  + 会话级 `IdleCompactionTracker`（LRU 上限 256，**不按空闲 TTL 淘汰**——长空闲正是检测对象）。
- `session-persistence.ts`：`maybeIdleCompact()` —— 读 gap、算 floor、查冷却、执行压缩、
  用**实际产出** token 抬高下次 floor、刷新活动时间。
- `llm-caller.ts`：在 `doTryCall` 顶部、provider 循环之前调用一次；turn 结束在 `finally`
  统一 `touch()` 记录活动时间（否则本轮开始会把 gap 清零）。
- 配置：`AgentModelExecutor.setIdleCompactAfterSeconds()` + env
  `EVOCLAW_IDLE_COMPACT_AFTER_SECONDS` + config-schema `idleCompactAfterSeconds`（默认 0 关闭）。

**关键不变量**：
- **opt-in**：阈值 ≤0 → 零成本降级，行为不变。
- **floor 防反复压缩（#97239）**：`effectiveFloor = max(threshold×ratio, lastProduced + threshold×ratio)`。
  真实压缩达不到理论 target（系统提示/工具 schema/受保护头尾不可压缩），只用理论值会导致
  每次空闲恢复都重跑一遍无进展的全量摘要、慢路由上静默阻塞。用上次**实际产出**抬高 floor，
  必须先新增「一个 floor 的量」才再次压缩。
- **冷却**：`CompactionManager.shouldSkipCompaction()`（此前是死代码，本轮经空闲路径接线后生效）。
- **不改缓存前缀**：仅在 turn 起点压缩会话历史（AGENTS.md 允许的压缩例外）。

**测试**：`idle-compaction.test.ts`（23）+ `idle-compaction-integration.test.ts`（10）。

---

## 2. web_fetch 大页「截断 + 落盘 + 可回读」

**对标**：`tools/web_tools_truncate.py`。

**动机**：EvoClaw `web_fetch`/`fetch_node_page` 超预算时只 `plainText.slice(0, 5000)`
直接丢中段，模型无法取回被省略的内容。

**落地**：`apps/server/src/tools/web-fetch-truncate.ts`
- `stripInlineImages`：内联 base64 图片 → `[IMAGE]`（base64 字母表不含空白，不吞正文）。
- `truncateWebText`：未超预算原样；超出则 head(60%)+tail+marker，计算省略中段的行号。
- `wrapForPaging` + `storeWebText`：全文按 2000 字符折行、`atomicWriteFileSync` 落盘
  `data/cache/web/extract/<sha16>.txt`（0600，上限 2M 字符）。
- `buildTruncationFooter`：告知总量、落盘路径、**可直接使用的** `file_read offset=… limit=…`。

`web-tools.ts` 新增 `renderFetchedText()` 统一渲染，替换两处 slice。**默认预算不变（5000）**，
仅在超预算时才追加 footer 与落盘，不放大注入模型的 token。

**测试**：`apps/server/tests/web-fetch-truncate.test.ts`（13）。

---

## 3. web 结果缓存（搜索单飞 + 抓取缓存）

**对标**：`tools/web_result_cache.py`。

**落地**：`apps/server/src/tools/web-result-cache.ts`
- **SearchMemo**：进程内、单飞、TTL（默认 20 分钟）、上限 200。并发相同查询共享一次
  真实搜索；`limit` 归入 10/20/50/100 桶；**仅成功结果入缓存**。默认启用（安全无副作用）。
  接线在 `handleWebSearch` 外层（`web_search` action=search），grounded_research 经
  `runTool("web_search")` 复用同一条目。
- **ExtractCache**：磁盘跨进程、JSON sidecar 索引、TTL、上限 500 条按最旧淘汰。
  **默认关闭**（`EVOCLAW_WEB_CACHE_ENABLED=true` 开启，`EVOCLAW_WEB_CACHE_TTL_MINUTES`
  默认 20）。命中在 SSRF 校验之后，仅跳过网络抓取，**仍重跑截断/落盘管道**（安全不变式）。

**测试**：`apps/server/tests/web-result-cache.test.ts`（17）。

---

## 4. web 搜索后端注册表（本轮执行）

**对标**：`agent/web_search_registry.py`。

**动机**：上一轮把「provider 注册表化」列为单独立项。复核后确认它是**真正的、可做的不变量**
（配置键优先 + 能力过滤 + legacy 兜底），且 EvoClaw 的 `handleWebSearchUncached` 硬编码级联
（skill-first + Baidu→Tavily→Bing→Google→DDG）缺这个抽象。

**落地**：`apps/server/src/tools/web-search-registry.ts`
- `WebSearchBackend` 契约：`supportsSearch/supportsExtract/isAvailable`（cheap，无网络）。
- `resolveWebBackend`：显式配置键优先（`EVOCLAW_WEB_SEARCH_BACKEND`，对标 `web.search_backend`）→
  能力合格且可用的唯一 provider → legacy 偏好（`LEGACY_WEB_PREFERENCE`）→ null。
- `WebSearchRegistry` 轻量注册集合（归一化解重）。

`web-tools.ts` 接线：
- 注册 5 个引擎 adapter（tavily 键控、其余 always-available）。
- `handleWebSearchUncached` 顶部：当 `EVOCLAW_WEB_SEARCH_BACKEND` 显式指定某引擎**且可用**时
  只走该引擎（短接）；未配置 / 不可用 / 不识别则回落既有级联，**默认行为不变**。
- 原内联 `trySearchTavilyAPI` 闭包复用新模块级 `trySearchTavilyOnce`（消除重复）。

**安全偏差（有意为之）**：Hermes 显式配置后端即使不可用也返回以报精确错误；EvoClaw 改为
「可用才短接，否则回落级联」——宁可继续出结果也不让一次过期 key 拒掉搜索。

**测试**：`apps/server/tests/web-search-registry.test.ts`（15，含配置优先/能力过滤/legacy/归一化/去重）。
全量 7495 passed → 7521 passed（+15 注册表 +11 已在上轮计入）。

---

## 明确不做 / 已归档（本轮复核）

- **vault / OS 钥匙串**（`agent/vault_keychain.py` + `vault_backends/local.py`）：复核确认
  `packages/agent/src/browser-vault.ts` 已在前几轮完整实现 local 后端（AES-256-GCM 静态加密、
  `vault.key`/`vault.json` 0600、origin 绑定、TOTP、list 仅元数据）。真正缺失只有
  `vault_keychain.py`（把 `.key` 交给 OS 钥匙串持有，密钥不落盘）——Node 无标准等价实现
  （需 `keytar` 原生绑定或原生插件），**不符合本项目「只移植不变量、不搬架构」契约，归档跳过**。
  `packages/security` 的 `SecretManager.vault` provider 仅声明未接线（纯内存、不落盘），
  是独立改进项，非本轮范围。
