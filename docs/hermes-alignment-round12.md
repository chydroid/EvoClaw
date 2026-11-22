# Hermes 对齐第 12 轮 — 任务完成可靠性（输出保真 × 超时/目录契约 × 裁剪可恢复）

> **状态（2026-11-22）：已落地并全量验证。** 本轮不改架构、不加核心工具，
> 只修「压测中反复出现、但根因在输出/参数契约层」的静默失败路径。
> 对照基线：hermes `88a1c1f4b1`（2026-11-22，较上一轮基线 `18e659dfc9`
> 新增 2609 commits）。

## 一、动机与取证

用户反馈：每轮压测通过率都不高，总有新问题。复查近几轮失败的共同形态后发现，
模型并非「不会做」，而是**看不到自己命令的真实结果**：

1. `shell_exec` 返回 `JSON.stringify({success, exitCode, output, stderr, error, ...})`
   ——单行 JSON（`\n` 全被转义）。`summarizeToolResult → summarizeShellOutput`
   按 `\n` 切行时只有 **1 行**，于是 8K 以上的输出被压成
   `line.slice(0, 500) + "...[truncated]"`。实测复现：**18052 → 514 字符**，
   `exitCode`、`error`、测试失败摘要全部消失。
2. 即使跳过摘要，最终进入上下文前还有 `truncateToolResult(toolResult, 4000)`：
   非 `file_read/code_search` 统一 4K，且 exec JSON 没有大数组字段 →
   JSON 结构化截断分支返回 null → 落到「只保留头部、尾部丢弃」兜底。
   48K 输出进模型只剩前 4K，`TAIL_ERROR` 再次丢失。
3. `sanitizeExecResult` 只处理 `output` 字段，`execute_code` 用 `stdout/stderr`
   → 脚本长输出从不 spill；且工具层先 `slice(0, 50000)` 只留头部，
   spill 出来的是「已被截断的副本」。
4. 持久化/裁剪预览是纯头部截断；exec 的 `exitCode/error` 位于 JSON 尾部，
   预览里永远看不到失败原因（hermes 同款修复：commit `5b397ead`）。
5. 其余契约型小缺口：外层固定 300s 超时截断工具声明的 1200s；显式
   `cwd` 不存在时静默回退 workspace；`workdir/file_path` 等别名被静默忽略；
   裸 `cd` 不持久化但无提示；裁剪摘要销毁原文、无法回读。

## 二、落地项

### GAP-R12-1 exec 输出保真（P0）

- `text-processor.summarizeToolResult`：`shell_exec/execute_code` **一律不摘要**
  （不再依赖「带标记才跳过」——8K-48K 的普通输出正是旧逻辑的重灾区）。
- `llm-caller`：exec 结果最终上限由 4K 提到 **60K**，与 `MAX_RESULT_LEN` 对齐；
  超过上限时优先 `truncateExecJson`（只压缩 `output` 字段，保留头 40%/尾 60%，
  `exitCode/stderr/error/command/cwd` 原样），非结构化时头尾截断 + spill。
- `shell-media-tools`：命令输出捕获上限 50K → **200K**（`MAX_CAPTURE_CHARS`），
  让下游 spill 拿到真实全文；`execute_code` 同额。
- `sanitizeExecResult` 扩展到 `output/stdout/stderr` 三字段，逐个 spill +
  头尾截断，`truncation_note` 列出每个字段与路径。

### GAP-R12-2 落盘/预览可读可回读（P0）

- `writeToolSpill`：落盘前 `wrapLongLines(…, 1800)`（hermes
  `pageable_archive_text`）。单行文件原本永远读不到第 16K 之后——
  `file_read` 只能按行走 offset/limit 且单页 16K。
- `ToolResultPersistenceManager`：落盘文件渲染为可分行文本
  （`success: false / exitCode: 1` 元数据行 + `--- output/stderr/error ---` 区块），
  再按 1800 字符切行；预览改为头+`... [N chars elided] ...`+尾。
- exec 预览专用 `buildExecPreview`（hermes `_head_tail_preview`）：
  元数据/error 摘要放头部 lead，**尾部窗口取 output 的最后几行**，
  不取元数据块尾部——失败构建的报错行通常在 output 末尾。
- 预览的 elision 只存在于消息里，落盘文件保持全文。

### GAP-R12-3 工具声明 deadline 地板（P1）

- 新增 `resolveToolTimeoutMs(toolName, args)`：exec 类取
  `max(300s, 声明 timeout + 5s)`，上限 1260s；浏览器 300s，其它 30s。
  此前外层固定 300s，`timeout: 600` 的长任务会在 300s 被误杀，
  模型得到误导性的 "timed out after 300s"。
- 并行批次 `ConcurrentToolExecutor` 兜底超时 600s → **1260s**
  （单工具的精确超时仍由内层 timer 负责）。

### GAP-R12-4 cwd / 参数契约（P1）

- 显式 `cwd` 不存在 → `exitCode: 126` + "Command did not run"（不静默回退）。
  未显式指定（默认/脚本推断）才允许回退 workspace。
- 相对 `cwd` 优先按 **workspace 根**解析，workspace 内不存在再退回进程 cwd。
  旧实现按进程 cwd 解析：`cwd: "v24-t5"` 想进 workspace 子目录，却解析到
  仓库根同名目录 → "cwd must be within workspace"。
- `normalizeToolArgumentAliases`：`shell_exec.workdir/working_dir/dir→cwd`、
  `cmd→command`、`timeout_seconds→timeout`；`file_read/write/delete.file_path
  →path`；`file_list.dir/directory/folder→path`。未声明的多余参数不会触发校验
  错误，不归一化就会**静默按默认值执行**（命令在 workspace 根跑）。
- shell_exec 描述明确「每次调用都是新 shell，裸 `cd` 不持久化」；
  裸 `cd` 结果附 hint（传 cwd 或 `cd dir && cmd`）。
- 工具参数 JSON 解析失败立即返回 `malformed_tool_arguments` + 重发建议，
  不再带着 `_parseError` 走参数校验、误报 "Missing required parameter"。

### GAP-R12-5 裁剪可恢复 + 幂等（P1）

- `ToolOutputPruner` 新增可选 `archive` 回调：摘要前把原文 `writeToolSpill`
  （脱敏+切行），stub 末尾附 `[Full output archived at: <path> — use file_read…]`。
  长任务后续需要早期测试输出时不必重跑命令。
- exec 摘要改为 JSON 结构感知：只压缩 `output`（头 40%/尾 60%），保留
  `exitCode/stderr/error`；加 `_pruned: true` / 归档路径幂等守卫，
  避免每轮对同一历史重复压缩造成**前缀缓存字节漂移**。
- 调用点（`llm-caller` 的 pruner 接线处）注入 `writeToolSpill` 归档回调。

## 三、测试

新增/更新用例（针对性 194 条全绿；全量套件 **384 files / 7902 passed,
14 skipped, 0 failed**，140s）：

| 文件 | 覆盖 |
|---|---|
| `packages/agent/src/tool-output-spill.test.ts` | wrapLongLines 分页；truncateExecJson 保留 exitCode/error/输出尾；stdout 字段 spill；spill 落盘仅插换行 |
| `packages/agent/src/tool-result-persistence.test.ts` | 头尾预览；JSON 落盘为可分行全文；exec 预览尾部取 output 而非 stderr 元数据 |
| `packages/agent/src/tool-output-pruner.test.ts`（新增） | exec 摘要保留 exitCode/tail + 归档路径；二次裁剪幂等；archive=null 降级 |
| `packages/agent/src/tool-arg-normalization.test.ts` | workdir/file_path/cmd/timeout 别名；显式值不覆盖；空值不生效 |
| `packages/agent/src/llm-caller.test.ts` | truncateToolResult exec JSON 尾部保护；resolveToolTimeoutMs 地板/上限 |
| `apps/server/tests/shell-cwd-inference.test.ts` | 显式 cwd 缺失 exit 126；相对 cwd 按 workspace 解析；逃逸拒绝；默认回退 |

验证顺序：`pnpm build → pnpm typecheck → pnpm test`。

## 四、与 hermes 的差异

- hermes `_pageable_text` 的 lead/trail 直接来自 JS 风格 envelope 的字段名；
  EvoClaw 的字段是 `output/stdout/stderr`，渲染时保持这三者都可读，
  但**不**引入 hermes 的 `_Pageable` 抽象（窄腰：只加一个渲染函数）。
- hermes 的归档文件放在 sandbox 可读路径；EvoClaw 无 sandbox 路径映射，
  spill 直接落在 `workspace/tool-spill/`，`file_read` 相对路径即可访问。
- 显式 cwd 缺失：hermes terminal 拒绝执行，hermes sandbox 后端则回退父目录
  并返回 `cwd_fallback` 标记。EvoClaw 选择**拒绝**（terminal 语义）；
  未显式指定 cwd 时仍保留回退，避免改变默认行为。

## 五、缓做（附理由）

| 项 | 理由 |
|---|---|
| `read_file` 字符级 offset（单行大文件分页） | 需要给 `ReadTracker` 的 key/coverage 增加维度；本轮已让 agent 自己产生的 spill/持久化文件可按行分页，先观察真实需求 |
| 压缩后归档的 sandbox 路径映射 | EvoClaw 无远程 sandbox 文件路径抽象，spill 已在 workspace 内可读 |
| 用户可见的 fallback 切换通知 | 与任务成功率无直接关系；缺 UI 契约（`fallback_notice` 需要前端呈现位） |
| 图片过大自动缩小的压缩恢复 | hermes 针对 provider 413 的专项路径；EvoClaw 当前图片入口未接该错误类 |
| 裸 `(?i)` grep 语法支持 | 属 `code_search` 语法扩展，不是失败闭环缺口；模型可用 `grep -i` |
| `char_offset` / 持久化目录清理策略 | 同上，先保留文件（Never delete；archive） |
