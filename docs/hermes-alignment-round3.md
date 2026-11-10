# Hermes 对照第三轮 —— 复核结论与实施方案

日期：2026-11-10
参照：`/home/chy/projects/hermes-agent-main`（只读勘察）
原则：**先验证接线状态，不轻信「已实现」**。每项先读 hermes 源码定位，再在本仓库 grep 调用点；只有「原语存在但无调用点」或「语义确有缺口」才立项。

## 一、复核：hermes 机制 → EvoClaw 现状

### 已对齐（本轮不动）

| hermes 机制 | EvoClaw 对应 | 状态 |
|---|---|---|
| `turn_liveness.py` 存活看门狗 | `packages/agent/src/turn-liveness.ts` + llm-caller 接线 | ✅ |
| `repetition_guard.py` 重复流中断 | `packages/agent/src/repetition-guard.ts` + llm-caller 流式接线 | ✅ |
| `error_classifier.py` 错误分类 | `packages/agent/src/error-classifier.ts` / `failover-policy.ts` | ✅ |
| `tool_guardrails.py` 循环检测 | `ToolCallLoopDetector`（exact/same/no-progress/identical-cycle/web 硬顶） | ✅ |
| `verification_evidence.py` 证据账本 | `packages/agent/src/verification-evidence.ts` + llm-caller 两处接线 | ✅ |
| `empty_response_guard.py` 确定性空响应短路 | llm-caller 5408 附近连续空响应计数 | ✅ |
| `context_compressor.py` 反抖动熔断 | `compaction-manager.ts` ineffectiveCompressionCount + summary 冷却 | ✅ |
| `url_safety.py` SSRF | `packages/infrastructure` SSRFProtection（browser/link/api-toolkit 均接线） | ✅ |
| `file_safety.py` 敏感路径拒绝 | `packages/security/src/file-safety.ts` | ✅ |
| `tool_output_truncate.py` 头 40/尾 60 + spill | `tool-output-spill.ts`（`truncateHeadTail` / `writeToolSpill`） | ✅ |
| `_prune_old_tool_results` 3-pass | `tool-output-pruner.ts`（去重/摘要/args 截断） | ✅ |
| `turn_tool_validation.py` 参数校验 | llm-caller `validateToolParams` | ✅ |
| `delegate_tool_config.py` 深度门 | DelegateEngine ALS 深度门禁 | ✅ |
| `async_delegation.py` 后台投递 | durable tasks + `/api/durable-tasks` | ✅ |
| `prompt_caching.py` 断点规划 | P0-6/P0-7 缓存断点布局 | ✅ |
| Skills 威胁正则/AST/结构原语 | `packages/security/src/skill-scanner.ts` + `SkillValidator.securityScan` | 原语 ✅（见 G3） |

### 真实缺口（本轮实施）

**G1. spill 文件未脱敏（安全）**
hermes `terminal_tool_result.py` 先把中间段落到 spill 文件前用同一套 secret pass 脱敏，防止「被截断的密钥在磁盘上以明文长期留存」。EvoClaw `writeToolSpill` 直接 `writeFileSync(text)`，`@evoclaw/security` 的 `redactSensitiveText` 无调用点。→ 落盘前脱敏，保留 `[REDACTED:<kind>]` 占位。

**G2. 工具名别名表是死代码（可靠性）**
`packages/core/src/compat-layer.ts` 的 `TOOL_ALIASES` / `resolveToolName` 无任何生产调用点；llm-caller 在 `registeredTools.get(toolName)` 未命中时直接回 `Tool "x" is not registered`。hermes `turn_tool_validation.py` 会在校验前修复幻觉工具名。→ 增加「别名仅在原名未注册且目标已注册时生效」的解析器，接入 llm-caller 主循环（三条 tool_call 来源汇合处）与 `executeToolByName`。

**G3. 远程技能安装无内容级扫描（供应链安全）**
`SkillValidator.securityScan` 只扫 SKILL.md 内嵌的 scripts/hooks；技能包里的**支撑文件**（.js/.py/.sh/.json）、不可见 Unicode、AST 危险模式从未被检查，且扫描器异常不 fail-closed。hermes `skills_guard.py` 对 community 信任级（远程安装）拦截 dangerous。→ 在 `SkillMarketplace.install` 解压后、注册前调用 `scanSkill`；命中阻断类威胁或扫描器异常 → 拒绝安装并把解压目录**归档**到 `cacheDir/quarantine/`（不删除）。

### 评估后不实施（附理由）

- **全量 installSkill 阻断式扫描**：实测 `data/skills` 现有 10 个技能有 4 个被威胁正则命中（`curl -fsSL https://composio.dev/install | bash` 的 supply_chain、参考文档注释里的 prompt_injection、脚本 AST 发现）。hermes 靠信任分级（builtin 全放行 / community 拦截）规避误杀，EvoClaw 尚无技能信任等级字段与「询问用户」通道；直接阻断会误杀本地/内置技能。故本轮只覆盖**远程 marketplace 安装**这一真实供应链入口。
- **progressive tool disclosure 接线**：`ToolSearchEngine` 只注册了 `/api/tool-search/*` 查询端点，未接入工具装配。核心工具集固定随请求发送是缓存前提（AGENTS.md），中途改工具载荷会破坏前缀缓存；hermes 也只延迟 MCP/插件工具。留待「MCP 工具数量成为实际问题」时只对动态工具接线。
- **MCP sampling 限流**：EvoClaw 未实现 sampling 回调（server→client 推理），无可限流对象。
- **审批拒绝熔断**：`hitlRejectCount`（llm-caller 4302/6531）当前无自增点（拒绝发生在 `rejectPermission`/gateway 通道，跨 turn 无计数载体）。补齐需要权限 UX 决策（拒绝一次是否永久锁死同类操作），不在本轮擅自改动审批语义。
- **per-turn 工具结果总预算**：pruner 已按单条阈值 + 最近 N 条保护裁剪；再加聚合预算会重写更多历史前缀（缓存成本），收益不明确。

## 二、验收

- 新增单测覆盖 G1/G2/G3（含 fail-closed、误报不误伤、归档保留内容）。
- `pnpm build -> pnpm typecheck -> pnpm test` 全绿后提交。
