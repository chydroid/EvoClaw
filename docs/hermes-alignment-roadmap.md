# EvoClaw 对标 Hermes Agent 提升方案（项目基线）

> 制定日期：2026-10-12。本文件是 v0.93+ 迭代的主线参考；完成一项后更新状态列。
> 对标对象：Hermes Agent v0.21.6（Nous Research，Python）。
> EvoClaw 当前基线：v0.92.1，21.3 万行 TS，1131 源文件，239 测试文件 / 6077 用例。

## 一、项目定位

EvoClaw 是 Hermes Agent 的 TypeScript 移植 + 增强演进版（证据：`packages/agent/src/llm-caller.ts` 20+ 处「借鉴 hermes-agent」注释、`skill-curator.ts` 引用 curator.py「永不删除仅归档」不变量、技能市场走 ClawHub 兼容协议）。

EvoClaw 借鉴基线停留在 Hermes v0.11~v0.12 时期，而 Hermes 主干已演进到 v0.21.6——中间隔着 v0.13→v0.21 约 9 个版本的产品化浪潮（Bot Mode 产品化、语音、出站 webhook、用户辩证建模、grounded research、serverless 后端、subagent mid-flight steering）。EvoClaw 的工程内核质量（类型安全、测试完备、原子写、跨进程锁）优于 Hermes 早期版本，但产品化能力落后。

## 二、差距速查

| 能力域 | Hermes v0.21.6 | EvoClaw 现状 |
|---|---|---|
| 迭代预算/凭证池/Curator 归档 | 产品化 | ✅ 已移植 |
| 迭代退款 execute_code | 已有 | ✅ 已移植 |
| A2A 智能体互通 | v1.0 | ✅ server/client + card |
| 多智能体群聊 | Bot Mode（命名社会/头像/@mention/常驻会话） | ⚠️ 仅底层 GroupChat 引擎 |
| FTS5 会话检索 | 有 | ✅ session-fts-search |
| RL 训练/轨迹导出 | Atropos 集成 | ⚠️ 仅 trajectory export |
| 语音（流式 TTS/barge-in/唤醒词） | v0.20 旗舰 | ❌ 无 |
| 签名出站 Webhook | v0.20 新增 | ❌ 无 |
| Honcho dialectic 用户建模 | 学习闭环核心 | ❌ 无 |
| grounded research（可验证引用+事实核查） | v0.20 新增 | ❌ 无 |
| Bot Mode 产品化 | 默认捆绑 | ❌ 无 |
| Cron 运行间学习 | v0.21 新增 | ⚠️ 有 cron 无学习闭环 |
| Subagent mid-flight steering | v0.21 新增 | ❌ 无 |
| MCP 指挥中心 | v0.21 强化 | ⚠️ 被动接入 + 投毒扫描 |
| 7 终端后端（SSH/Daytona/Modal/Serverless） | 支持 | ⚠️ 仅 DockerSandbox |
| agentskills.io 公开标准 | 官方标准 | ❌ 仅 OpenClaw 私标 |

## 三、优先级路线图

### P0 — 稳定与信任（✅ 已落地 2026-10-12）

- [x] **files 恒空欠账**：`file_create`/`file_modify` 工具成功结果提取 path/size/workspaceRelative 写入 `createdFiles`，前端下载链接恢复出现。
- [x] **token 事件体积欠账**：token/status-generating 事件默认只带 delta 增量，不再塞全量累积 reply（`includeAccumulatedReplyInTokenEvents` 开关保留旧客户端语义）；WebChatPage 按字段存在与否自动分流全量/增量渲染。
- [ ] **类型契约防回归测试**：SSE `done` 事件字段（`contextLimitSource`/`thinkingSteps`/`contextTokensEstimated`）加 schema 级断言。
- [ ] **成功/失败计数单一事实源**：工具结果判定统一到一处，消除"同一次调用既失败又成功"。

### P1 — 架构对齐 Hermes 最新（把"有引擎"变成"有产品"）

- [ ] **Bot Mode 产品化**：命名智能体社会——agent profile 绑定独立 model/memory/skills/头像/常驻会话 + 群聊房间 + `@mention` 编排（底层 GroupChat 已有）。
- [ ] **Subagent mid-flight steering**：运行中下发指令重定向（对标 v0.21）。
- [ ] **Cron 运行间学习闭环**：定时任务把每次运行结果沉淀进记忆/进化引擎，下次运行继承经验。
- [ ] **MCP 指挥中心**：工具过滤/动态挂载/路由仪表盘。

### P2 — 新特性拓展（补齐 v0.20+ 新战场）

- [ ] **语音模式**：流式 TTS + barge-in 打断 + 本地唤醒词。
- [ ] **签名出站 Webhook**：任务完成/审批/告警事件推送到外部系统。
- [ ] **Honcho dialectic 用户建模**：跨会话辩证用户建模层（叠加在现有分层记忆上）。
- [ ] **grounded research**：web 检索 + 可验证引用 + 事实核查。
- [ ] **agentskills.io 公开标准兼容**：OpenClaw 私标之外增加公开标准支持。
- [ ] **Programmatic Tool Calling / execute_code 产品化**：多步工具流水线折叠为单次推理调用。

### P3 — 可观测与分发

- [ ] **Curator 完整报告链路**：后台 cron 代理 + `logs/curator/run.json` + `REPORT.md` + consolidated-vs-pruned 分类。
- [ ] **7 终端后端 / serverless**：SSH/Daytona/Modal/Vercel Sandbox 之外补闲置近零成本。
- [ ] **发布流水线**：stable release pipeline（one attempt ref + 测试镜像 + receipt tag）。

## 四、设计原则约束（继承 AGENTS.md）

- Prompt cache 神圣：任何改动系统提示/工具集的方案须走「延迟失效」或 compaction 例外。
- 窄腰 + 边缘能力：新能力优先落为「扩展已有代码 → CLI+skill → service-gated tool → plugin → MCP → 新核心工具」顺序。
- 原子写 + CrossProcessLock：任何新增持久化状态必须用 `atomicWriteFile`。
- Never delete; archive：Curator 相关改动不得破坏归档不变量。
- 中文注释/文档。

## 五、关键代码索引

| 模块 | 位置 |
|---|---|
| 任务主链路 | `/api/chat` → `protocol-adapter.ts` → `agent-model-executor.ts` → `llm-caller.ts` → 工具执行 → 会话落盘 → SSE → WebChatPage |
| 文件下载路由 | `protocol-adapter.ts` `GET /api/files/download/*`（workspace-relative，`..` 拦截 + 边界校验） |
| 文件工具 | `apps/server/src/tools/file-tools.ts`（file_create/file_modify 结果含 path/size/workspaceRelative，经 errRecovery 剥掉 success 透传） |
| 群聊引擎 | `packages/agent/src` GroupChat（Bot Mode 产品化的地基） |
| 思考轨迹 | `llm-caller.ts` `ThinkingTrace` + `traceSnapshot`（按 trace 隔离的 WeakMap 节流，2026-10-11 修过并发串扰） |
| 前端渲染 | `packages/web-ui/src/WebChatPage.tsx`（全量/增量双路径，`message-bubbles.ts` applyRoundContent） |
