# Hermes 对齐第八轮：渐进式子目录上下文 + 会话自动标题

日期：2026-11-15
参照：`/home/chy/projects/hermes-latest`（origin/main `18e659dfc9`，2026-11-15）
验证：`pnpm build → pnpm typecheck → pnpm test` 全绿。

本轮在前七轮之后，对照最新 Hermes 主干，补齐两个**只移植不变量、不搬架构**的独立能力。
全部默认安全、可回滚。

---

## 1. 渐进式子目录上下文（Subdirectory Hints）

**对标**：`agent/subdirectory_hints.py`。

**动机**：EvoClaw 仅在 workspace 启动时加载一次 AGENTS.md（`bootstrap-manager`）。但本项目
的约定是「scoped AGENTS.md」——子目录各自带自己的 AGENTS.md。原实现下，agent 进入某个
子包（如 `packages/agent/`）时看不到该包的 AGENTS.md，只能靠模型自己再读一次。

**落地**：`packages/agent/src/subdirectory-hints.ts`（`SubdirectoryHintTracker`）

移植的不变量：
- **追加到工具结果，不改系统提示** → prompt cache 稳定（本轮最关键的设计约束）。
- 每目录**首个命中**的上下文文件生效（优先级 `AGENTS.override.md → AGENTS.md → CLAUDE.md → .cursorrules`）。
- **内容摘要去重**：同一文件经 symlink/硬链/副本再次出现时不重复注入。
- **祖先回溯**（≤5 层）：读 `pkg/src/deep/x.ts` 也能发现 `pkg/AGENTS.md`。
- **路径必须落在 working_dir 树内**（symlink 解析后仍在树内），否则绝不加载——
  防止把 `~/.claude/CLAUDE.md` 或 `.env` 类文件注入会话。
- **家目录样 working_dir 整体禁用**（#76902）：桌面端 cwd 落到 `~` 时，否则整棵 `~` 下的
  AGENTS.md 都会被注入。
- **排除依赖/构建/缓存树**（node_modules、vendor、dist…），其中的上下文文件是副本非权威源。
- 每文件上限 32K（头尾保留 + 路径标记）。
- **内容威胁扫描阻断**：复用 `scanForThreats(content, "context")`（同 Hermes `_scan_context_content`），
  命中 prompt-injection 模式时只回 `[BLOCKED: …]` 标记，原文不进会话。
- **symlink 目标名校验**：realpath 解析后的文件名仍须是上下文文件名，挡 `sub/AGENTS.md -> .env`
  这类树内 symlink 注入（Hermes 用 file_safety deny-list 达到同一目的）。

**接线**：`llm-caller.ts` 工具结果返回前（成功、非 sequential_thinking），append tracker 的
`checkToolCall(name, args)` 输出；**失败静默**，绝不影响工具结果本身。tracker 每会话一个
（Map 上限 256，FIFO 淘汰），惰性按 `deps.workspacePath` 创建。

**与 Hermes 差异**：不移植 hosted/沙箱（`host_feature_enabled`）/ `safe_worker` 管线。

**测试**：`subdirectory-hints.test.ts`（22）。

---

## 2. 会话自动标题（Session Title）

**对标**：`agent/title_generator.py`。

**动机**：EvoClaw 会话列表只有 `preview`（首 23 字符）与用户手输 `customName`，没有
自动派生的可用标题。

**落地**：`packages/agent/src/session-title.ts`

移植的不变量（**只做确定性即时标题，不搬 LLM 升级管线**）：
- **即时标题**：用户开场消息首个有意义行，按词边界裁到 ≤48 字符；**永不失败、永不调模型、
  不阻塞主路径**。
- **Provenance 权威序 `derived < llm < user`**：derived 只能被 llm/user 替换；
  **用户手输标题（customName，user 级）永不被覆盖**。
- **机器 opener 不派生**：压缩交接 / 恢复会话 / 模型切换标记（`[CONTEXT COMPACTION`、
  `[System: The active model...` 等）不标题化。
- **附件-only opener 不派生**（#92068）：只有 `@file:` 引用、无实质文本时不拿被截断的
  文件路径当标题。
- 剥控制标签包裹（`<task-notification>`、`<system-reminder>` 等）后再派生。

**接线**：`session-manager.ts appendTurn` —— 首条用户 turn 且会话尚无标题时，
`applyDerivedTitle()` 就地写入 `title` + `titleSource: "derived"`。`SessionInfo` 新增
`title?` + `titleSource?: "derived" | "llm" | "user"`。

**与 Hermes 差异**：
- 不做 CJK/占位符 answer-shaped guard（那针对 LLM 升级路径；确定性派生天然不会「回答问题」）。
- 不做 mojibake 修复（针对模型输出；确定性派生输入是用户原文）。
- **LLM 小模型升级路径（后台线程 + auxiliary client）未移植**——需要 auxiliary client 编排，
  可单独立项；本模块的 provenance 设计已为其留好接口（`shouldApplyTitle` 支持 `"llm"` 来源）。

**测试**：`session-title.test.ts`（20）。

---

## 候选评估（本轮已核验，未纳入）

对 hermes `agent/*.py`（386 模块）逐项核对 EvoClaw 现状后筛选。已覆盖/重复，不需做：

| 已覆盖 | 对应 EvoClaw |
|---|---|
| repetition-guard | `repetition-guard.ts` |
| iteration-budget | `iteration-budget.ts` |
| tool-guardrails | `packages/security/tool-guardrails.ts` |
| rate-limit-tracker | `rate-limit-tracker.ts` |
| verification-evidence | `verification-evidence.ts` |
| estop | 已接线 |
| empty-response | `packages/gateway/response-filters.ts` |

评估后跳过：

- **image_eviction_policy**：EvoClaw 图片仅来自用户附件，无截图累积进历史的路径 → 低相关。
- **micro_compaction**：默认关且每次重写 prompt 前缀破坏 cache（违背「cache is sacred」）。
- **search_policy prune**：EvoClaw 已有 `CODE_SCAN_SKIP_DIRS`，本轮 hints 复用等价排除名单。
- **side_question (/btw)**：需 detached fork 基础设施，复杂，单独立项。
- **context_pin**：仅标签/告警经验，范围太小，暂不做。
