# Hermes 对齐第五轮计划 —— 未实施项重新立项

日期：2026-11-12
范围：`docs/hermes-alignment-round4.md`「明确不实施」中的 7 个方向，重新勘察后拆成 9 个可独立交付的项目。
方法：三路源码级勘察（EvoClaw + `/home/chy/projects/hermes-agent-main`），每项先验证现状再设计。
说明：本文所有 `file:line` 为 2026-11-12 快照；实施前必须重新定位（行号会漂移）。

---

## 0. 立项原则

1. **只移植不变量，不搬架构**。Hermes 的 Python/RPC/profile 体系与 EvoClaw 不同；照抄会引入大工程。每项先回答「这个不变量在当前架构里值不值得、能不能小改落地」。
2. **默认关闭、可回滚**。所有新增护栏（staging、sampling、quota、breaker）默认不改变既有行为，配置开启后才生效。
3. **不碰 prompt 缓存前缀**。所有提示只能进 tool-result / 事件文本，不改系统提示、工具 schema 顺序或历史。
4. **每项独立可交付**。一个项目 = 一组文件 + 一组测试 + 一次全绿提交；不把 9 项捆成一次大提交。
5. **勘察发现的真实缺陷优先**。本轮勘察发现一个阻塞性缺陷（P0），它不是 round4 列出的「未实施」，但会让 P3 失去意义，必须先修。

---

## 1. 总览

| ID | 项目 | 来源 | 价值 | 工作量 | 依赖 | 批次 |
|---|---|---|---|---|---|---|
| **P0** | HITL 审批请求可解析化 | 本轮新发现 | 高（真实缺陷：高危审批无法批准/拒绝） | M | — | A |
| **P1** | execute_code 程序化 RPC 加固 | round4 未实施 | 高（安全边界） | S–M | — | A |
| **P3** | 审批连续拒绝熔断 | round4 未实施 | 中（阻止无限重试） | M | P0 | A |
| **P4** | 记忆写入闸门（唯一匹配 + 原地更新） | round4 未实施 | 中高（数据正确性） | S–M | — | A |
| **P2** | 插件准入护栏（工具名冲突 + before_install + 声明校验） | round4 未实施 | 中高（供应链） | S–M | — | B |
| **P8** | 配置降级标记（替代 profile/secret scope） | round4 未实施 | 中（可观测性） | M | — | B |
| **P5** | MCP OAuth 接线 + 跨进程刷新栅栏 | round4 未实施 | 中高（远程 MCP 可用性） | M–L | — | C1 |
| **P6** | MCP sampling 能力 + 限流护栏 | round4 未实施 | 中（能力，默认关闭） | M | P5（推荐） | C2 |
| **P7** | cron 持久化 pending_slot + occurrence 账本 | round4 未实施 | 高（可靠性） | M（JSON）/ L（SQLite） | — | D |

**明确降级/放弃**：`profile` 多路复用与 secret scope 在 EvoClaw 不存在对应架构（`ProfileManager` 零实例化、`SecretManager` 未注册、无 profile 路由）。照搬是「给不存在的暴露做防护」，**放弃字面项**，只保留可迁移的「配置读写降级标记」为 P8。

---

## 2. 详细方案

### P0 — HITL 审批请求可解析化（前置缺陷）

**不变量**：任何发给用户的审批请求，其 ID 必须能被恰好一个 API 批准/拒绝；决定必须能落状态并让下一次重试放行。

**现状（已复核）**

- `packages/agent/src/llm-caller.ts:6508-6583` 为 high/critical 工具生成 `hitl-<ts>-<hex>` 请求，推入本轮 `pendingPermissions`，但**从不注册**到 `HumanApprovalManager.pendingApprovals`。
- `HumanApprovalManager.requestApproval()`（`packages/agent/src/human-approval.ts:270`）是**阻塞式**的，生产代码零调用；llm-caller 走的是「返回 pendingApproval，下一轮重试」的非阻塞模型。
- 因此 `/api/approvals/:id/approve|reject`（`packages/gateway/src/gateway-server.ts:1574/1611`）对 `hitl-*` 一律返回 404；`agent-model-executor.approveOperation/rejectOperation`（`:589-599`）返回 false。
- `deps.pendingOperations` 只在工具级 `requiresPermission` 路径写入（`llm-caller.ts:6812-6823`），HITL ID 没有 session 映射。
- `hitlRejectCount`（`:4302`）无自增点；`pendingApprovalCommands` 无 `.set` 调用点，复位分支不可达。
- WebUI 批准后盲目重发消息且不检查 `res.ok`（`packages/web-ui/src/WebChatPage.tsx:1985-2045`），形成「反复弹同一个孤儿请求」。

**实施步骤**

1. `human-approval.ts` 新增 `registerPendingApproval(pending)`：同步落 `pendingApprovals`，不建 resolver、不设超时（由调用方负责 TTL），遵守 `maxPendingPerSession`。
2. `llm-caller.ts:6555-6563` 构建 `PendingApproval`（含 sessionId）后调用注册；同时 `deps.pendingOperations.set(hitlId, { sessionId, toolName })`。
3. 批准路径：`approve` 成功时追加一条**单次/短时**信任规则（tool + 精确 args，TTL 5 分钟），保证重试真正放行；否则会无限重复弹窗。`trustFuture` 仍走永久规则。
4. 拒绝路径：`/api/permission/deny`、`/api/approvals/:id/reject`、`/api/permission-relay/:id/deny` 统一发布 `permission.denied` 事件；`agent-model-executor` 增加 `permission.denied` 订阅，清理 `pendingOperations` 并触发 P3 计数。
5. WebUI 三处检查 `res.ok`，404/已过期给出明确提示，不再盲重发。

**契约/API**：无新增公共 API；`PendingApproval.status` 流转复用既有枚举。

**测试**：注册→批准→重试放行的单测；拒绝→`pendingOperations` 清理；三路由各一条集成测试；WebUI 不做单测（手测）。

**风险/回滚**：两套审批系统（HITL 非阻塞 vs Manager 阻塞）并存；本方案只补注册，不合并。风险点是 approval 后信任规则的范围——先按「精确 tool+args、5 分钟」实现，误放行面最小。回滚即删注册调用。

**验收**：高危工具（`file_delete`、`email.send`、`git.push`）的审批请求可在 `/api/approvals/pending` 看到；批准后重试执行，拒绝后不再重复弹出。

---

### P1 — execute_code 程序化 RPC 加固

**不变量**（Hermes `code_execution_rpc.py`）：工具调用必须经过 **allowlist ∩ 本会话启用工具**、**per-run token 常量时间校验**、**总调用预算**、**子进程 env 清洗**，并且审计可归属到 run/session。

**现状（已复核）**

- 程序化模式已有 stdio 行协议 RPC（`apps/server/src/tools/shell-media-tools.ts:1129-1157` 脚本侧、`:1295-1394` 宿主侧），宿主用 `executeToolByName` 派发（`:1327`）。
- 但安全模型是**黑名单**（`PROGRAMMATIC_FORBIDDEN_RULES` `:1009-1030`），不是 allowlist；没有 token。
- 工具清单来自 `executor.getRegisteredTools()`，**不评估 `checkFn`**（`:1068-1083`），会把当前不可用工具也暴露给脚本。
- 无总调用预算，仅并发 4 / 待处理 64（`:1278-1281`）。
- 子进程继承完整 `process.env`（`:1268`），脚本可直接读 API key；宿主侧只捕获协议行，不做来源认证。
- 审计 JSONL 无 session/run 身份（`:1415-1427`）。
- `executeToolByName` 明确绕过 HITL（`packages/agent/src/agent-model-executor.ts:1270-1298`），所以 allowlist 必须保守。

**实施步骤**

1. **硬 allowlist**：新增常量集合（建议与 Hermes 对齐的只读/低危子集：搜索、读取、写入、列表、补丁类），运行时取 `allowlist ∩ enabledTools(评估 checkFn) ∩ !forbidden`；文档/advertisement 同源。
2. **per-run token**：`crypto.randomBytes(32).toString("base64url")` 生成，经 env `EVOCLAW_RPC_TOKEN` 传入；脚本每条 `__evoclaw_call` 带 token；宿主 `processStdoutLine` 用 `crypto.timingSafeEqual` 校验；服务端 token 为空即 fail-closed。token 只防其他本地进程注入，不是对脚本本身的隔离（脚本持有 token）。
3. **总预算**：`MAX_TOOL_CALLS` 默认 50（配置可调），只对成功派发的调用计数；超限返回错误并结束。
4. **env 清洗**：只传 `PATH/HOME/LANG/LC_*/TMPDIR/SystemRoot/...` + RPC token；丢弃 `.env` 注入的 provider key。文档写明「programmatic 是软沙箱：无隔离 jail」。
5. **run 身份**：用 `AsyncLocalStorage`（仓库已有先例 `delegate-engine.ts:302`）或注入 `_sessionId/_runId`；审计记录与 token 绑定。
6. **保持黑名单作纵深防御**，但 allowlist 是主门。

**非目标**：Docker/远程沙箱的文件式 RPC（容器 `--network=none` 且无宿主挂载，需改 `SandboxManager.executeScript` 契约，L 级）；persistent kernel 的工具通道（内核协议只传 code cell，且 `owner:"default"` 有跨会话串味，另立项）。

**测试**：token 缺失/错误/正确；allowlist 外调用被拒；预算耗尽；env 清洗（脚本读不到 key）；审计含 sessionId；`checkFn=false` 的工具不出现在 `tools.list()`。

**风险**：收紧 allowlist 可能破坏既有脚本；先按当前黑名单反推「肯定安全」集合，并提供配置扩展，但默认不开。所有拒绝都要给出可读原因与 `tools.list()`。

---

### P3 — 审批连续拒绝熔断

**不变量**（Hermes `approval.py:62-116`）：按会话统计连续拒绝；阈值默认 3，0 关闭；批准即清零；只改 tool-result 文本，不动历史/系统提示；超时不算拒绝。

**现状**：`hitlRejectCount` 声明（`llm-caller.ts:4302`）、复位（`:4359`，不可达）、读取（`:6545`）但**无自增点**；拒绝只发布事件（`packages/security/src/permission-manager.ts:377-391`），executor 只订阅 `permission.approved`（`agent-model-executor.ts:929-935`）；`PermissionRequest` 没有 `sessionId` 字段（`permission-manager.ts:6-18`）。

**实施步骤**

1. 新增会话级 `DenialBreaker`（建议 `packages/agent/src/approval-denial-breaker.ts`）：`Map<sessionId,{consecutive,trippedAt,lastDeniedAt}>`，上限 256、LRU 淘汰、30 分钟空闲 TTL；阈值来自配置，默认 3，`<=0` 关闭。
2. P0 完成后接线：三条 deny 路由 → `executor.recordApprovalDenial(id|sessionId)`；session 清除与空闲 TTL 重置。
3. 复位：`PermissionManager.approveRequest`、`PermissionRelay.approve`、`HumanApprovalManager.approve`、信任规则新增、用户 chat 批准（修复后的 `llm-caller.ts:4359` 分支）。
4. 熔断动作：HITL 预检与工具级 `requiresPermission` 分支先查 breaker；已熔断则不新建审批，若工具已创建 `PermissionManager` 请求则先 `denyRequest` 关闭，再返回 `{success:false, blockedByBreaker:true, error:"CIRCUIT BREAKER: ..."}`。
5. 可观测：`GET /api/approvals/breaker`、`POST /api/approvals/breaker/reset`；WebUI 权限页展示计数与重置按钮。

**测试**：2 次不触发、第 3 次触发；批准复位；阈值 0 关闭；会话隔离；TTL/LRU；超时不计数；熔断后不再产生 `pendingPermissions`；前缀不变（只改 tool-result）。

**风险**：P0 未修则高危拒绝根本到不了计数器——所以 P0 必须先行。UX 上需要让用户知道「审批被暂停、如何恢复」。

---

### P4 — 记忆写入闸门

**不变量**（Hermes `memory_tool_store.py:96-165`）：删除/替换必须命中唯一目标；整条精确匹配优先于子串；子串跨条目歧义必须报候选；patch 的 `old_string` 在条目内必须恰好出现一次；无匹配返回最近条目；可选 staging 时以完整 `matched_entry` 固定重放目标。

**现状（已复核）**

- `apps/server/src/tools/memory-tools.ts:136` patch、`:184` remove 都用 `all.find(e => e.content.includes(oldString))`，**静默命中第一条**。
- patch 先 `longTerm.update(match.id)`（`:142`），再 `memoryHub.forgetMemory(match.id)` + `remember({...})`（`:144-152`），**新建了一个 id**，响应却返回旧 id；旧条目仍在 longTerm，形成重复；`remember` 重新写入时 ttl 处理也不一致。
- remove 传 id 时 `longTerm.delete` 对不存在 id 静默成功（`:191`，`long-term-memory.ts:385-396`）。
- `packages/security/src/write-approval.ts` 有完整 staging 原语，但**零接线**；`memory` 工具动作风险等级只有 search/stats 为 low，patch/remove 实际不受审批。

**实施步骤（Phase 1，默认行为）**

1. 新增匹配助手（建议 `packages/memory/src/memory-match.ts`）：先整条 `content === oldString`；否则收集所有 `includes`；0 条 → `not_found` + 最近条目；>1 条 → `ambiguous` + `[{id, content: 前 200 字}]`；恰好 1 条才继续。
2. patch：优先接受 `id`；`old_string` 在目标条目内出现次数必须为 1；改为原地更新——新增 `MemoryHub.update(id,{content})` 同步 longTerm + FTS5 + 向量，**不新建 id、不丢 ttl**；no-op 拒绝。
3. remove：传 id 先校验存在；传 old_string 走唯一匹配；不存在返回 `not_found`，不再假成功。
4. 保持 `add` 不变。

**实施步骤（Phase 2，可选，默认关闭）**

5. 配置 `memory.writeApproval`（默认 false）；开启后 patch/remove 返回 `{staged:true,pending_id}`，写入 `data/memory/pending/<id>.json`，payload 固定 `matched_entry`；重放时条目已变化则拒绝。复用 `write-approval.ts` 的语义但**不要**复用其路径文件模型。

**测试**：新建 `apps/server/tests/memory-tools.test.ts`（当前零覆盖）：唯一匹配、无匹配、歧义候选、id 精确、span 出现两次拒绝、删除不存在 id、patch 保持 id/ttl/不重复、索引只更新一次、staging 默认关闭。

**风险**：对「随便传一段子串」的旧调用方是契约收紧，但此前行为本身是数据损坏；错误信息给出候选即可让模型自我纠正。Phase 2 涉及 API/UI，默认关闭，单独提交。

---

### P2 — 插件准入护栏

**不变量**（Hermes `plugin_validate.py` / `plugin_validate_core_override.py` / `plugin_guard.py`）：插件不得静默覆盖内置工具；安装期扫描分级（safe/caution/dangerous）；声明的能力必须与实际注册一致。**注意**：Hermes 并没有 `before_install` 钩子，真实机制是安装流水线里的扫描与准入检查。

**现状（已复核）**

- `AgentModelExecutor.registerTool`（`packages/agent/src/agent-model-executor.ts:1253-1268`）遇到同名工具**仅告警并覆盖**；插件/扩展可覆盖 `execute_code`、`shell_exec`、`file_write`。
- `BeforeInstallHook` 类型存在（`packages/core/src/plugin-system.ts:294-309`）但**零调用点**。
- `/api/plugins/install`（`packages/gateway/src/protocol-adapter.ts:5299-5377`）只注册内置工厂，否则注册一个**无钩子的惰性 stub**；没有下载/解压/扫描/持久化。
- 无真实 AST 解析器；`skill-scanner.astScanContent` 是逐行正则。

**实施步骤**

1. **运行时冲突护栏（S，最高价值）**：服务启动完成内置工具注册后快照「核心工具名集合」；`registerTool` 增加来源参数（`core|plugin|extension|mcp`），非 core 来源撞名默认拒绝（可配置 `allowCoreOverride`，默认 false）。内置插件/扩展在快照前注册则天然豁免。
2. **before_install 接线（S）**：新增 `PluginManager.installPlugin(meta)`（或路由内）调用 `runHooks({type:"before_install", packageName, version, source, scanFindings})`，`block` 则拒绝注册；放在 `/api/plugins/install` 注册之前。
3. **声明-实际校验（S–M）**：`PluginContext` 包一层 registerTool，记录实际注册名；与 manifest `providesTools` 比对，未声明即拒绝或告警。
4. **静态扫描（M，可选）**：对插件入口做启发式扫描（复用 `scanSkill` 的 AST-lite + 不可见 Unicode + 危险模式），命中 dangerous 阻断、caution 告警。真正 TS AST 校验需要引入解析器依赖，等插件分发体系落地再做，不在本轮强上。

**非目标**：完整插件分发（下载/解压/版本/更新/卸载/签名）——新子系统，L 级；`plugin-hardlink-policy.ts` 原语可复用，另立项。

**测试**：插件撞核心名被拒；内置插件不受影响；before_install block 阻止注册；未声明工具注册被拒；stub 安装路径不执行钩子异常。

**风险**：现有扩展可能依赖覆盖语义（需要先搜注册顺序）；默认拒绝会改变行为，可在配置中临时放开，但必须记录告警。

---

### P8 — 配置降级标记（替代 profile / secret scope）

**不变量**（Hermes `config_read_errors.py`）：读失败 fail-open 但**必须响亮**（告警 + 可查询状态 + 不覆盖用户文件）；写失败 fail-closed；降级状态可被健康检查与 UI 读取。

**现状（已复核）**

- 冷启动解析失败：`apps/server/src/index.ts:1355-1368` 捕获后继续用默认值，只写日志；安全等级回落 normal。无程序化状态。
- 热重载：`packages/core/src/config-schema.ts:491-511` 对非法配置静默保留上一份。
- `persistPath` 已拒绝覆盖不可解析文件（`packages/core/src/config.ts:379-408`），但 `saveToFile` 不检查此前读失败。
- `ConfigMigrationManager` / `LastKnownGoodConfig` / `ConfigDoctor` 均存在但零接线（`config-migration.ts:76`、`config-lkg.ts:76`、`config-doctor.ts:149`）。
- `ProfileManager` 零实例化；`SecretManager` 未注册且 scope 是分类枚举；`TenantManager` 无 secret。→ **放弃字面 profile/secret scope 项**。

**实施步骤**

1. `ConfigManager` 增加 `status = {loaded,degraded,reason,sourcePath,fileSignature,lastError,lastLoadedAt}`；冷读失败、热重载非法时置 degraded 并保留上一份；新增 `getStatus()`。
2. 读失败后 `saveToFile` 拒绝写回（避免把默认值覆盖用户文件）；`persistPath` 逻辑保持一致。
3. 成功加载时快照 `LastKnownGoodConfig`；启动时跑 `ConfigDoctor`，把报告并入状态（可选恢复接口）。
4. `GET /api/config/status` + 健康检查暴露 `degraded`；WebUI 设置页显示横幅。
5. `schemaVersion` 与迁移链接线列为后续可选项；当前深度合并默认值，不紧急。

**测试**：损坏 `config.json` → 服务启动、`degraded=true`；非法热重载保留上一份并标记；degraded 时写回被拒；健康端点字段。

**风险**：低。不要因为降级状态改变安全等级的既有回落策略（本轮只观测）。

---

### P5 — MCP OAuth 接线 + 跨进程刷新栅栏

**不变量**（Hermes `mcp_oauth.py` / `mcp_oauth_provider.py`）：刷新临界区 = 读 token → POST → 持久化；整段持锁且**跨进程**；获取不到锁 fail-closed；锁内重读，磁盘已轮换则直接采用；等待有上限。

**现状（已复核）**

- `packages/gateway/src/mcp-oauth.ts` 实现完整（PKCE/设备码/发现/刷新/原子 0600 存储）；`mcp-oauth-manager.ts` 实现状态机与刷新。
- 但 `McpOAuthManager` **零实例化**；`MCPClientTransport` 只传静态 `headers`（`mcp-client-transport.ts:33-37,115-119`），从不取 token。
- 刷新「栅栏」`_fenceMap` 是**进程内 Map**（`mcp-oauth-manager.ts:91-114`），5 秒盲等；文件头注释声称跨进程，实际不能排除第二个进程。
- 无 OAuth HTTP 路由；`ExternalMCPServerConfig` 无 OAuth 字段。

**实施步骤**

1. gateway 启动时实例化 `McpOAuthManager`（dataDir 复用现有目录），把 token getter 注入 `MCPClientManager`/`MCPClientTransport`。
2. transport 为 `sse`/`streamable-http` 增加 async auth：连接前取 token 写 `Authorization`；收到 401 时 `refresh` 一次并重试；`stdio` 按配置注入 env。
3. 跨进程栅栏：用 `CrossProcessLock`（`packages/infrastructure/src/filesystem-manager.ts:46-166`，`wx` + PID + stale 检测）包住 read→POST→persist；锁内重读 token；等待上限（60s）后 fail-closed。若未来需要严格 advisory 语义，可把 token 存储改为 SQLite `BEGIN IMMEDIATE`。
4. 配置面：`ExternalMCPServerConfig` 增加 `oauth?: {enabled, scopes?, clientId?}`，纳入 `validateMCPServerConfig`。
5. 路由/CLI：`GET /api/mcp-oauth/:server/status`、`POST .../authenticate`（PKCE 回调）、`.../logout`；CLI 可后置。

**测试**：两实例同目录并发刷新只消费一次 refresh token；磁盘已轮换时不重复 POST；401 重试一次；锁超时 fail-closed；token 文件权限与损坏处理。

**风险**：交互式 OAuth 需要本地回调/浏览器；先做 API 路由，UI 后置。不要打印 token；错误信息脱敏。

---

### P6 — MCP sampling 能力 + 限流护栏

**不变量**（Hermes `mcp_tool_sampling.py`）：sampling 默认关闭、按服务器独立限流（60s 窗口，默认 10/min）；模型 allowlist；`max_tokens` 客户端硬上限（默认 4096）；30s 超时；工具轮次上限（默认 5）；失败返回明确 MCP 错误（不静默空回复）；LLM 调用不阻塞事件循环；usage 在单一收口点记账。

**现状（已复核）**

- SDK Client 以 `capabilities: {}` 构造（`mcp-client-transport.ts:125-128`），无 `setRequestHandler(CreateMessageRequestSchema, ...)`；服务端 sampling 请求得到 `-32601`。
- `MCPClientManager` 注入面只有工具注册（`mcp-client-manager.ts:87-97`），没有 LLM 回调。
- 辅助调用入口 `callAuxLLM`（`packages/agent/src/auxiliary-client.ts:321-362`）与 `buildAuxChatFn`（`agent-model-executor.ts:3484-3535`）已记账，可复用。

**实施步骤**

1. 新建 `packages/gateway/src/mcp-sampling.ts`：每服务器一个 handler，实现窗口限流、模型 allowlist、`maxTokens` 钳制、超时、消息块转换、指标、fail-closed。
2. transport 声明 `sampling: {}` 并注册 handler；配置默认关闭。
3. `MCPClientManager` 注入 LLM 回调（在 gateway 初始化、executor 就绪后解析）；避免启动循环依赖。
4. `auxiliary-client.ts` 增加 `mcp_sampling` 任务类型；单点 `recordTokenUsage`。
5. 默认 `expose_client_tools=false`、`max_tool_rounds=5`；开启时工具集同样走 allowlist。
6. 日志/指标：请求数、错误、token、工具轮次。

**测试**：超限拒绝；模型不在 allowlist；maxTokens 被钳；超时 fail-closed；工具轮次上限；usage 记录一次；并发请求不阻塞。

**风险**：这是新的信任边界（远端服务器可指定 prompt/model）；默认关闭 + 显式 opt-in 是硬要求。协议版本字段缺失（`mcp-protocol-handler.ts:97-125` 不返回 `protocolVersion`）可顺手补齐。

---

### P7 — cron 持久化 pending_slot + occurrence 账本

**不变量**（Hermes `cron/occurrences.py`）：周期任务先推进 `next_run` 再派发（at-most-once）；推进后、claim 前崩溃会静默丢一次，因此用 `pending_slot` 持久记录该窗口；owner 已死或租约过期时**只恢复一次**，随后走正常 late/catch-up；绝不重放 N 次。**注意**：Hermes 的 `quota_hold` 是 provider 限流窗口，不是按任务的运行配额；若要按任务配额，需明确标注为 EvoClaw 扩展。

**现状（已复核）**

- 活跃调度器 `ScheduleManager`（`packages/scheduler/src/schedule-manager.ts`）：任务定义持久化到 `data/scheduler/tasks.json`（原子写），occurrence **完全不落盘**；`runHistory` 仅内存。
- 重启时 `start()` 直接从当前墙钟重挂 node-cron（`:230-245`），不读 `nextRun`；停机期间错过的运行静默丢失；崩溃中途没有 in-progress 标记。
- 并发只有进程内 `runningTasks`；无全局上限；时区全局硬编码 `EVOCLAW_TIMEZONE || Asia/Shanghai`（`:278`）。
- 已有可复用：`RunLogStore`（`packages/scheduler/src/run-log-store.ts`，SQLite `cron_run_logs`）、`apps/server/src/index.ts:393-407` 的 `probeSqlitePersistence` 接线、`CrossProcessLock`。

**实施步骤（Phase 1：JSON，M）**

1. `ScheduledTask` 增加 `pendingSlot?: {scheduledAt,stampedAt,owner}`、`quota?: {windowMs,limit,windowStart,used}`、`timezone?`。
2. 派发前写入 `pendingSlot` 并**同步** `saveTasks()`；完成/失败在 `recordResult` 清除；`stop()` 仅对未运行任务清理。
3. `loadTasks()` 恢复：owner PID 不存活或超过 TTL（300s）→ 只恢复一次为 due，清 stamp，记录告警；活着的 owner 不动。
4. 每任务时区传给 `cron.schedule`；现有任务无 timezone 字段时保持全局值，避免静默平移。
5. 手动 `executeTask` 路径同样过 quota/pending，或显式标注为例外。
6. 多进程：`saveTasks` 全文重写不安全；要么用 `CrossProcessLock` 包住，要么文档声明单进程并留 Phase 2。

**实施步骤（Phase 2：SQLite，L，可选）**

7. 新建 `occurrence-store.ts`：`cron_occurrences(run_id PK, job_id, scheduled_at, state, stamped_at, owner, completed_at, error)`；`(job_id, scheduled_at) WHERE state='completed'` 部分唯一索引去重；claim 用 `BEGIN IMMEDIATE`。
8. 与 `RunLogStore` 同一 DB 初始化，`ScheduleManager` 构造注入；首次启动把 tasks.json 里的 `pendingSlot` 幂等导入。

**测试**：模拟「stamp 后进程退出」→ 重启只补一次；同一 occurrence 不重复执行；时区；quota 窗口；多进程锁；`stop()` 期间运行中任务不被二次恢复。

**风险**：at-most-once 与 side-effect 重复的取舍；全文 JSON 重写的写放大；DST 行为变化。Phase 1 先落地，Phase 2 视多进程部署需求再上。

---

## 3. 批次与执行顺序

| 批次 | 项目 | 目的 | 预估 |
|---|---|---|---|
| **A** | P0 → P3 → P4 → P1 | 修审批真实缺陷 + 拒绝熔断 + 记忆正确性 + 执行通道安全 | 1 个会话，可分 4 次提交 |
| **B** | P2 → P8 | 插件供应链准入 + 配置可观测 | 1 个会话，2 次提交 |
| **C1** | P5 | 远程 MCP 可用（OAuth 接通） | 1 个会话 |
| **C2** | P6 | sampling 能力（默认关闭） | 依赖 C1 的注入面 |
| **D** | P7 Phase 1（→ Phase 2） | 调度可靠性 | 1–2 个会话 |

**依赖**：P3 依赖 P0；P6 推荐在 P5 之后（共享 OAuth/transport 注入面）；P2、P4、P7 相互独立。

**每项完成定义**：源码复核 → 实现 → 新增测试 → `pnpm build` → `pnpm typecheck` → `pnpm test` 全绿 → 单独 commit → 更新本文件状态表。

---

## 4. 通用施工约束

- **验证顺序不可换**：`pnpm build -> pnpm typecheck -> pnpm test`。
- **缓存优先**：不改 system prompt、工具 schema 顺序、history；新增提示只进 tool-result/事件。
- **原子写**：持久状态用 `atomicWriteFile*`；跨进程用 `CrossProcessLock`；禁止裸 `fs.writeFileSync` 写状态。
- **永不删除，只归档**：`data/*-archive/`、`quarantine/`；回滚靠归档目录。
- **不静音测试**：不改 baseline/snapshot；不为过测试放宽断言。
- **中文注释/文档**；TS strict；避免 `any`；外部边界用现有 schema 校验。
- **不打印密钥**；下载/解压物按不可信数据处理（独立空目录、传路径、Python `-I`）。
- **计划可以修正**：实施中发现 line/机制与本文不符，先更新本文再写代码；原「未实施理由」仍成立的，记录并跳过。

---

## 5. 状态表（实施时更新）

| ID | 状态 | 提交 | 备注 |
|---|---|---|---|
| P0 | 未开始 | — | 批次 A，最高优先 |
| P1 | 未开始 | — | 批次 A |
| P3 | 未开始 | — | 依赖 P0 |
| P4 | 未开始 | — | 批次 A |
| P2 | 未开始 | — | 批次 B |
| P8 | 未开始 | — | 批次 B |
| P5 | 未开始 | — | 批次 C1 |
| P6 | 未开始 | — | 批次 C2 |
| P7 | 未开始 | — | 批次 D |
