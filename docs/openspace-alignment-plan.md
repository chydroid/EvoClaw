# OpenSpace 对齐计划（自进化能力对等 + 任务完成能力领先）

> 目标：吸收 OpenSpace `skill_engine` 的完整自进化闭环，同时保留并强化已有 Hermes 能力。
> 原则：prompt cache 神圣；不中途改 history / 工具集 / system prompt；进化只写技能库，不污染主链路。

## 1. 对比结论（2026-11-22）

| 能力 | OpenSpace | EvoClaw 接入前 | 判定 |
|---|---|---|---|
| 执行录制（三件套） | `recording/*` conversations+traj+metadata | `RecordingManager` 已在每个 chat run 录制 | ✅ 已有 |
| 录制消费（后置分析） | `ExecutionAnalyzer` LLM 分析每次执行 | **无任何 evolution 代码读取 `data/recordings`** | ❌ 缺口 |
| 任务完成独立判定 | 分析器依据证据独立判断 `task_completed` | 无（只有 Hermes 的完成真实性门禁） | ❌ 缺口 |
| 技能质量四计数器 | SQLite `total_selections/applied/completions/fallbacks` | 类型 `SkillMetricsRecord` 已有，但无存储、无消费者 | ❌ 缺口 |
| 技能维度判定 | `skill_judgments` → 计数 | 无 | ❌ 缺口 |
| FIX/DERIVED/CAPTURED | `SkillEvolver` + apply-retry 3 次 + 校验 + 血缘 | 类型/`PatchApplier`/`LineageStore` 已有，但无执行器 | ❌ 缺口 |
| post-analysis 触发器 | 分析建议直接演化 | `EvolutionTriggers.processAnalysis` 仅测试调用 | ❌ 死代码 |
| tool-degradation 触发器 | 工具质量 + LLM 语义问题 | 触发器已接线，但 `recordLlmToolIssues` 无调用者 | ⚠️ 半接线 |
| metric-monitor 触发器 | 技能指标驱动 | 已接线，但指标来自易失内存 stats，`fallbacks` 语义错 | ⚠️ 半接线 |
| 质量感知选择 | BM25+embedding 预筛 + 质量过滤 + LLM plan-then-select | TF-IDF + 成功率重排，无质量过滤 | ⚠️ 部分 |
| 中途技能检索 | `retrieve_skill` 工具 | 只有 `skill_view`（需已知名称）/`skill_list search` | ⚠️ 部分 |
| LLM 二次确认 | 有 | `LLMReflector.confirmSuggestion` 存在，但 executor 契约错配导致生产恒降级 | ❌ 缺口 |
| 成功后反思 | 每次执行后分析 | `TASK_COMPLETED` 零订阅者 | ❌ 缺口 |
| 轨迹蒸馏 | 经验策略可检索 | 蒸馏器只吃沙箱轨迹，且策略无读取 | ⚠️ 部分 |

## 2. 实施项（本次）

### A. 新模块（`packages/evolution/src/`）

1. `execution-analyzer.ts` — `ExecutionAnalyzer`
   - 读 `RecordingManager.readRecording(taskId)`：setup/iteration/traj/metadata。
   - 生成紧凑 digest（工具时间线 + 末段对话 + 最终回复 + 注入技能）。
   - 经统一 aux LLM 通道输出严格 JSON：`task_completed / execution_note / tool_issues / skill_judgments / evolution_suggestions`。
   - skill_id 纠错（精确 → 名称 → Levenshtein），输出 `ExecutionAnalysis`。
2. `skill-quality-store.ts` — `SkillQualityStore`
   - `data/skill-curator/quality.json`，`atomicWriteFile + CrossProcessLock`。
   - 复用 `SkillMetricsRecord` 四计数器；每条分析原子累加：
     selections+1 / applied+1 / completions+1（applied && completed）/ fallbacks+1（!applied && !completed）。
   - 提供 `toTriggerMetrics()`、`qualityScore()`、`isLowQuality()`、最近判定（≤50）。
3. `skill-evolver.ts` — `SkillEvolver`
   - FIX：原地补丁（V4A `parseV4APatch` + `applyHunks` + 路径安全 + 备份 + 原子写），失败重试 3 次（把错误与磁盘现状回灌给 LLM）。
   - DERIVED：新目录、新名称、父技能保留。
   - CAPTURED：无父技能，从执行亮点创建。
   - 校验：`validateSkillDir` + `checkSafety`；不删除文件；写 `.skill_id` + `LineageStore`；FIX 使父版本失活。
   - 安装/刷新：`skillManager.installSkill` 或新增 `reloadSkillFromDisk`；发 `SKILL_INSTALLED` 使 `SkillIndex` 重索引。
4. `evolution-coordinator.ts` — `EvolutionCoordinator`
   - `handleRun(input)`：fire-and-forget，串行队列（并发 1）、最短间隔 15s、日配额 300、队列上限 8。
   - 分析 → 质量计数 → 工具问题 `ToolQualityManager.recordLlmToolIssues` → 注入的 `confirmSuggestion`（LLM 二次确认）→ `SkillEvolver` 直接演化（每次 ≤3 条，建议键/目标技能 6h 冷却，先登记后执行 fail-closed）。
   - `getStats()` / `flush()` 供 API/WebUI 与关停。

### B. 接线（最小侵入）

- `AgentModelExecutor.setPostRunAnalysisHook()`：录制结束后回调，带 taskId/sessionId/status/message/reply/toolCount/skillNames。
- 录制补 `recordSkillSelection`（此前无调用者）：把本轮注入的技能名写入 `traj.jsonl`，供分析器判定。
- `AgentModelExecutor.runAuxiliaryPrompt()`：统一 `callAuxLLM` 回退链；`LLMReflector` 改用它，修复生产环境 LLM 确认/反思恒降级。
- `SkillManager.reloadSkillFromDisk()`：FIX 后刷新内存对象。
- 质量感知选择：`selectSkillsForSession` 过滤 OpenSpace 同款低质技能（applied≥3 且完成率<0.35；或 fallback 率>0.5），不向 prompt 注入动态统计（缓存安全）。
- `skill_list` 新增 `action=retrieve`：任务中途按 query 检索技能并返回指定层级内容 + 质量指标（对标 `retrieve_skill`）。
- 监控窗口：`EvolutionTriggers.startTask(id, { resetAddressed:false })`，反循环窗口跨 tick 生效；`processAnalysis` 拆出 `confirmAnalysisSuggestions`。
- 指标来源改为 `SkillQualityStore`（持久、语义正确），回退到内存 stats。
- 新增 API：`GET /api/evolution/quality`；`POST /api/evolution/analyze {taskId}`。

### C. 明确不做 / 保留

- 不动 prompt 布局、transient 注入、verification/receipt/交付物契约（Hermes 能力）。
- 分析/演化全部在后台，失败静默，不进入主对话历史或工具集。
- 不引入 embedding 服务依赖；预筛继续用现成 TF-IDF/SkillIndex。
- 不启用无审核的自动删除；只归档/备份。

## 3. 验收

- 单测：质量计数语义、分析 JSON/纠错、FIX/DERIVED/CAPTURED、重试与路径逃逸、协调器限流、监控反循环状态保留。
- 回归：`pnpm build -> pnpm typecheck -> pnpm test` 全绿（2026-11-22：390 文件通过 / 1 跳过，7942 测试通过 / 14 跳过）。
- 运行时（2026-11-22 实测，端口 27789）：
  - `/health`：120/120 服务健康（degraded 仅因渠道 0 连接）。
  - `GET /api/evolution/quality`：返回 stats/coordinator/skills 三段。
  - `POST /api/evolution/analyze`（无录制）：`{"success":true,"analysis":null}`；缺参校验返回 400。
  - `POST /api/evolution/analyze` 指向真实录制 `task_1794768873608_dcb5e09c`：3.3s 完成，LLM 独立判定 `taskCompleted=true`，建议/工具问题均为空（保守），`coordinator.analyzed` 递增。
  - 真实任务后的录制消费由 `setPostRunAnalysisHook` 自动触发；质量计数仅在出现技能判定时落盘 `data/skill-curator/quality.json`。
