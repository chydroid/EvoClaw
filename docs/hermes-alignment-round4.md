# Hermes 对齐第四轮（2026-11-11）

## 方法

三路只读勘察 hermes（`/home/chy/projects/hermes-agent-main`）:

1. 记忆 / RAG / 用户建模 / 技能学习 / curator / cron / 后台评审 / MoA
2. 网关 / 渠道送达 / webhook / 审批 / 插件护栏 / self-repo guard / execute_code / MCP / 租户隔离
3. 评测 / 可观测性 / 成本 / 模型路由 / 故障转移 / 凭证轮换 / 配置 / CLI / 状态迁移 / 进程管理

对每条「不变式」在 EvoClaw 侧做源码级复核：实现文件 → import → 运行时调用点 → 测试。
延续前几轮原则：**原语存在 ≠ 已接线**；不把文档/类型声明当作落地证据。

## 已验证对齐（本轮不重复实施）

| Hermes 机制 | EvoClaw 落点 |
|---|---|
| 凭证池模型级冷却 / exhausted TTL | `packages/agent/src/credential-pool.ts` + `credential-persistence.ts`；`apps/server/src/index.ts:261` 实例化 |
| DM 配对码 TTL / 尝试锁定 / 待审上限 | `packages/security/src/dm-pairing-manager.ts` |
| MCP 工具 include/exclude + 投毒扫描 | `packages/gateway/src/mcp-client-manager.ts:128` `filterToolsForAgent` + `shouldRejectByPoisoning` |
| 命令注入无条件硬拦 / 不可逆操作任何等级硬拦 | `shell-command-risk.ts` + `security-level.ts:171` `decideShellCommand`（`security-level.test.ts` 三档断言） |
| 技能归档不删除 / 内容寻址 ledger | Step7 已落地（见 `MEMORY.md`） |
| 工具输出脱敏 / 头尾截断 / 远程技能扫描 | 第三轮 3 项（见 `docs/hermes-alignment-round3.md`） |
| 破坏性命令 progress 警告 | `llm-caller.ts:6516` `isDestructiveCommand` |
| 会话搜索 / 语义记忆 / FTS5 / 向量索引 | `packages/memory/src/*` |
| `/review` 后台评审 fork（不落父会话） | `agent-model-executor.ts:3534` |
| 成本记账 / 缓存命中成本 / 分级价目 | `token-usage-tracker.ts` + `cache-trace` |
| 流式消息按渠道长度切块 | `gateway/src/streaming-manager.ts:227` |

## 真缺口 3 项

### G1 硬线命令护栏是死代码，且分级器不做归一化

Hermes `tools/approval_floors.py` 的不变式：**用户 deny 规则与 hardline 地板在 yolo /
mode=off 之前生效，且对归一化/去混淆后的命令变体匹配**。

EvoClaw 现状：

- `packages/security/src/command-guard.ts` 有完整实现（`normalizeCommand` 防 ANSI/null /
  NFKC fullwidth / `r\m` / `r''m` 混淆；`checkHardline`；`HARDLINE_PATTERNS`），
  `index.ts` 也导出了 `checkHardline` / `checkAllCommandGuards`，但
  `grep -rn checkHardline|checkAllCommandGuards apps packages --include=*.ts`
  除定义与导出外**零调用点**。
- 活路径 `apps/server/src/tools/shell-media-tools.ts:480` 只对**原始命令**跑
  `assessShellCommand`；`shell-command-risk.ts` 的注入/危险规则不做归一化。
  因此 `r\m -rf /`、`ｒｍ -rf /` 这类混淆命令在该路径可绕过 critical/blocked 判定。
- 更重要的是：`decideShellCommand` 的 `IRREVERSIBLE_RULES` 白名单只覆盖
  7 条规则 ID，`fork bomb` / `kill -1` / `dd > /dev` 等 hardline 模式在 `risky`
  档并不必然硬拦；`command-guard.ts` 里更完整的 hardline 集合没有接入。

**方案**：在 `assessShellCommand` 内先调用 `normalizeCommand`，且把
`checkHardline` 的结果作为「不可放宽地板」并入风险分级：hardline 命中 →
返回 `critical` 且 `rule = "hardline:<…>"`；同时在 `decideShellCommand` 里把
`hardline_*` 视为任何等级都硬拦（与既有 `IRREVERSIBLE_RULES` 并列）。
归一化后的命令参与规则匹配，原文仍用于返回消息；不改变既有 `safe/caution`
语义。所有既有测试保持不变，新增混淆/地板测试。

### G2 记忆全文检索对 CJK 与多词查询会静默返回空

Hermes `hermes_state_search.py:_quote_fts_tokens` 的不变式：每个非操作符 token
单独引号化（保留 `AND/OR/NOT`），CJK 走 bigram/trigram 或 LIKE 回退，避免
「原始 FTS 语法 / CJK 文本静默零结果」。

EvoClaw `packages/memory/src/fts5-search.ts:190` 用
`safeQuery = "\"" + query.replace(/"/g,'""') + "\""` 把**整条查询**包成一个短语。
实测（`better-sqlite3` + `unicode61`）：

- `"machine learning"` 恰为原文短语时命中；但 `memory` 工具的 `action=search`
  常传自然语言，如「项目进度 季度目标」或「quick dog」，整句短语无法命中。
- CJK 更严重：中文被 `unicode61` 切成整段（如 `项目进度报告已经完成`），
  查询 `"项目进度"` 或 `"项目"` 都返回 0；而 `LIKE '%项目%'` 可命中。

**方案**：FTS5 查询构造改为「逐 token 引号 + 前缀通配」；对含 CJK 的查询，
在 MATCH 无结果时执行一次 `LIKE` 回退（同一 SQLite 连接，带过滤/分页/排序，
不引入新依赖、不改 tokenizer、无需数据迁移）。保留注入安全（token 内双引号
转义）。fallback Map 路径同步改为「所有 term 都包含」的与语义，避免两种后端行为分叉。

### G3 辅助 LLM 调用（side-task / review / vision）未进入成本记账

Hermes `agent/aux_accounting.py` 的不变式：辅助调用的 usage 在响应校验单一
收口点记录，既不丢失也不重复计入主 turn。

EvoClaw 主循环 `llm-caller.ts` 在 4 处 `tokenUsageTracker.record(...)`；但：

- `agent-model-executor.ts:3482` `buildAuxChatFn()`（`/side` 侧问）直接 `callLLMOnce`
  且不记录；`callLLMOnce` 本身也不记账（记账在 caller 层）。
- `runReviewFork()`（`/review`）同样只累计 `tokensUsed` 返回给 slash 命令，不记账。
- `apps/server/src/index.ts:2804` `createVisionChatFn()` 直接 fetch OpenAI 兼容
  `/chat/completions`，连 usage 都不解析。

**方案**（最小闭环，不引入 ContextVar 大改造）：

- `buildAuxChatFn` / `runReviewFork` 在拿到 `callLLMOnce` 结果后调用
  `this.recordTokenUsage(sessionId, provider, model, promptTokens,
  max(0, tokensUsed - promptTokens), responseMs, channel)`；
  slash 命令把 `sessionId` 传入（已有），不改变返回值语义。
- `createVisionChatFn` 解析响应 `usage.prompt_tokens / completion_tokens`，
  通过 `this.recordTokenUsage` 记账（失败 best-effort，绝不影响视觉结果）。
  明确排除重复计数：主 turn 的 `callLLMOnce` 记账仍在 llm-caller，不动。

## 明确不实施（附理由）

- **execute_code 沙箱 RPC 工具白名单 + per-run token**：EvoClaw 的
  `execute_code` programmatic 模式已有「禁用工具」集合但走宿主直调，改造成
  Hermes 的 RPC 通道是架构级改动，需单独设计鉴权与超时，非一轮小修。
- **MCP sampling 限流 / OAuth 单令牌栅栏**：EvoClaw MCP 客户端目前不暴露
  `sampling/createMessage`，也没有 OAuth 刷新路径；先接线能力再加护栏才有意义。
- **plugin `before_install` 钩子 / core-override AST 校验**：`BeforeInstallHook`
  类型存在但 `PluginManager.registerPlugin` 是进程内加载，无安装流水线可挂；
  需要插件分发体系，属大工程。
- **cron durable pending_slot / 配额窗口**：EvoClaw `CronScheduler` 是进程内
  `setTimeout` 调度（无持久化 occurrence），要对齐需先引入 SQLite occurrence 表。
- **profile 复用 secret scope / 配置读写 fail-open 标记**：EvoClaw 没有 Hermes
  的 profile multiplexing 与 config migration 版本链，属不同架构。
- **审批连续拒绝熔断**：`llm-caller.ts:4302` 的 `hitlRejectCount` 只在**同一
  turn** 内存在（每次 `callChat` 重置），且没有任何 `++` 调用点；实现跨 turn
  计数需要把拒绝事件从 WebUI `/api/permission/deny` 回灌到 executor，涉及
  会话状态与 UX 决策，留待专项。
- **完整 memory write gate（staged destructive ops / 唯一匹配）**：EvoClaw
  `memory` 工具 `patch/remove` 用 `find(includes)` 取第一条，确实不拒歧义；
  但改成「歧义拒绝 + 精确 Entry 固定」会改变工具契约，本轮只做检索质量，
  写入门禁列入下一轮。

## 验证

`pnpm build -> pnpm typecheck -> pnpm test`（顺序不可换）。
新增回归测试：安全归一化/地板、FTS5 CJK/多词、辅助调用记账。
