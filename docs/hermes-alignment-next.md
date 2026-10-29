# Hermes 对齐落地 — 新会话提示词

## 任务

继续 EvoClaw 与 Hermes Agent 的对齐工作。核心原则：**先从源码验证接线状态，再声称完成**。原路线图不可信——它把"原语存在"计为"完成"，导致 14 处 VERIFY-FAIL。

## 已完成（14 项，全部通过 build+typecheck+test 6839）

Tier 1 死代码接线：budget refunds / memory tools / session search / sandbox routing / ErrorRecoveryExecutor / recallCronRuns / runBackgroundReview

Tier 2 工具注册：clarify / text_to_speech

Tier 3 渠道接线：telegram/discord/slack/whatsapp/wechat 适配器

Tier 5 死代码接线：MCP Streamable HTTP / ToolOutputPruner / buildLLMSummaryPrompt

基础设施修复：memoryHub 服务注册

## 未实施（真·缺失能力，需新建基础设施）

1. **delegate_task spawn tool** — SubagentRegistry 只登记元数据不执行；BackgroundDelegator 已删除。需新建子 agent 执行引擎 + 批量并行 + 后台派发 + 深度限制 + output_schema 校验。对标 Hermes `tools/delegate_tool.py`（891 行 + 9 个兄弟模块）。

2. **browser completion** — 8 个缺失工具：browser_back / browser_press / browser_get_images / browser_vision / browser_cdp / browser_dialog / browser_vault / browser_exec。需新建 Playwright/CDP 原语。对标 Hermes `tools/browser_tool.py` + `browser_cdp_tool.py` + `browser_dialog_tool.py`。

3. **trajectory compression 完整版** — 已接线 ToolOutputPruner + buildLLMSummaryPrompt 两个死代码原语，但完整对齐 Hermes ContextCompressor（5744 行）需：head/tail 边界保护（token-aware + tool-group alignment + decaying head）+ iterative/rolling summary + focus-topic guided compression + native server-side compaction。

## 关键文件

- Hermes 参考：`/tmp/hermes-latest/`
- EvoClaw：`/home/chy/EvoClaw/`
- 记忆文件：`/home/chy/.claude/projects/-home-chy-EvoClaw/memory/evoclaw-hermes-alignment-wiring.md`
- 验证顺序：`pnpm build → pnpm typecheck → pnpm test`（全部通过才算完成）

## 工作原则

- 先验证接线状态（grep import → grep 调用点 → grep 注册），不轻信"已实现"
- 新工具注册需同时检查：schema → registerTool → server 注册 → channel handler 集成
- 死代码接线需同时检查：实现 → 导入 → 运行时调用点 → 回写持久化状态（P0-5 缓存幂等）
- 代码注释中文，TypeScript strict，原子写入（atomicWriteFile）
