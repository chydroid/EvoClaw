# EvoClaw vs Hermes 第二轮细粒度对标（2026-11-07）

> 对标对象：`/home/chy/projects/hermes-agent-main`（NousResearch/hermes-agent，Hermes v0.21.6+ 主干）。
> 调研方法：三路子代理并行（工具层 282 文件 / agent 内核 / 基础设施）+ AST 扫描 + EvoClaw 侧源码核验。
> 结论更新：此前 `docs/hermes-alignment-roadmap.md` 记录的"已落地"项经本轮重验多数属实；本轮新增的差距是"深度细节与体系完善"级，不是"能力缺失"级。

## 一、对齐度现状（本轮先验证防误判）

以下 Hermes 能力经源码核验**已存在且接线**（此前文档未更新，避免误判为缺失）：

| Hermes 能力 | EvoClaw 对应实现 |
|---|---|
| delegate_task 子代理（9 兄弟模块） | `delegate-engine.ts` + `delegate-tools.ts`（含 steer/list/stop 控制面） |
| browser 8 补全工具（back/press/get_images/vision/cdp/dialog/vault/exec） | `browser-completion-tools.ts`（570 行，明确记录了架构取舍） |
| tool_search 渐进工具披露（BM25 延迟目录） | `tool-search.ts` + `tool-search.test.ts` |
| tool_result_storage / spill / truncate | `tool-output-spill.ts` + pruner/limits |
| auxiliary client 统一回退链 | `auxiliary-client.ts`（compression/session_search/web_extract/vision/title_generation/background_review 枚举） |
| credits_tracker（x-nous-credits-* 头） | `credits-tracker.ts`（TypeScript port，micros 整数精度） |
| usage_pricing（美元计价 + billing route） | `usage-pricing.ts`（TypeScript port） |
| think_scrubber / reasoning-timeout / reasoning-toggle | `think-scrubber.ts`、`reasoning-timeouts.ts`、`reasoning-toggle.ts` |
| micro/native compaction 相关 | `compaction-manager` + `trajectory-compressor` + `context-pruning` + pruner |
| guardrails identical_cycle 周期检测 | `guardrails.ts` ToolCallLoopDetector（周期 2..4 重叠 / 3 告警 / 5 阻断，已对齐） |
| grounded research（证据 ledger） | `intelligence/grounded-research.ts` |
| cron 学习建议（4 来源 + consent-first） | `scheduler/cron-suggestions.ts` + `blueprint-*` |
| 签名出站 webhook（HMAC-SHA256） | `gateway/webhook-manager.ts`（1271 行） |
| TTS barge-in | `infrastructure/tts-stream.ts` 会话注册表 + cancel |
| 会话持久设施（checkpoint/undo/archive/fts5/lineage） | `session-checkpoint/undo/archive/fts5/persistence` |
| file_state / working_diff / self_repo_guard | `file-state-registry.ts` 等（部分） |
| skills hub（clawhub/agentskills） | skills 包 + agentskills 标准校验器 |
| MoA 运行时 | `moa-engine.ts` + `moa-committee.ts` |
| 凭证池 + credential_persistence | `credential-pool.ts`（433 行，per-entry cooldown）+ `credential-persistence.ts` |
| slash 命令核心集 | `chat-commands.ts`（12 个：status/new/reset/compact/thinking/verbose/usage/restart/help 等） |
| skill_manage / skills_list / skill_view | `skill-tools.ts` 等 |
| send_message / session_search / todo / kanban / clarify / tts 工具 | 对应工具束均已接线 |

## 二、确证的细粒度差距（本轮新增）

### G1 凭证池：缺**模型级冷却**（高价值/低风险）
- Hermes `credential_pool_model_cooldowns.py`：Anthropic 对每个模型独立限流，某模型 429 不牵连同凭证兄弟模型（`model_cooldown_until` / `merge_model_cooldowns`）。
- EvoClaw `credential-pool.ts`：只有 per-entry（凭证）级 `cooldownUntil`；llm-caller 429 冷却是 provider 级（llm-caller.ts:521 `COOLDOWN_MS=60s`）→ 一个模型 429 会让同凭证所有兄弟模型连带冷却 60s。
- 接入点：credential-pool 增加 per-model 冷却键；llm-caller 过载恢复阶梯按 (provider, model) 键标记。

### G2 slash 命令产品化入口缺失（中价值/低风险）
- Hermes（tools/agent 层）：`/review`（fork 后台评审）、`/learn`（技能培育）、`/btw`（侧问，aux client 一次快速回答）、`/plan`（规划拆解）、`/diff`（working_diff）。
- EvoClaw chat-commands 只有 12 个基础命令；background-review.ts、skill_manage 存在但无命令入口。

### G3 execute_code 无**会话持久 kernel**（中价值/中风险）
- Hermes `code_kernel.py` + `code_kernel_remote.py`：会话持久化解释器（one child per owner+cwd），消除每次 Python 调用的冷启动与 import 重迎代价。
- EvoClaw shell-media-tools 的 execute_code 每次调用 spawn 新进程（实测 Python 冷启 + numpy 等 import 每调用 ~1-2s）。
- 风险：解释器生命周期/残留/并发上限。建议 opt-in `persistent:true` LRU 池，默认不变。

### G4 thinking 生命周期细节（中价值/中风险）
- 4a `reasoning_promotion.py`（answer_in_reasoning_capability 白名单）：模型把答案藏在 thinking、文本回复为空时晋升可见——EvoClaw 无。
- 4b `anthropic_thinking_policy.py`（model_preserves_prior_thinking/route_replays_prior_thinking）：历史轮 thinking 保留/丢弃策略，避免 provider 切换/多轮签名不一致 400——EvoClaw llm-caller 历史装配无此策略。
- 4c `reasoning_carriers.py`（Gemini thought_signature 等原生 reasoning 载体）——EvoClaw 无（provider 兼容层决策相关）。

### G5 TTS/STT provider 族（中价值/中成本）
- Hermes：TTS 12+ provider（Edge 免费默认 / ElevenLabs / OpenAI / DeepInfra / MiniMax / Mistral / Gemini / xAI / 本地 NeuTTS/KittenTTS/Piper / command / plugin）+ STT 8 provider（本地 faster-whisper 默认免费 / groq/openai/mistral 等）+ wake_word（Hey Hermes 本地引擎）+ audio_container 嗅探。
- EvoClaw：`tts-stream.ts` 已有 TTSProvider 抽象 + OpenAI 兼容 + Nous Portal + 本地引擎抽象点，但仅实际实现 OpenAI 兼容一条路；**STT（语音输入）完全缺失**；无 wake_word。

### G6 process registry 深度（P2）
- Hermes `process_registry*.py`（13 文件）：checkpoint 跨重启、wait policy（静默任务不再高频 poll）、kill tree + 幸存者验证。
- EvoClaw ProcessManager 存在，深度待核（建议下一轮对齐增量：wait policy + 进程树终止验证）。

### G7 skill ledger 内容寻址回滚（P2）
- Hermes `skill_ledger.py`：per-mutation JSONL + sha256 blob + 单编辑回滚（rollback fail-closed）。
- EvoClaw SkillCurator 有 evolutions.json + restoreSkill（归档恢复），但缺"单次编辑粒度回滚 + 内容寻址"。

### G8 cron 运维闭包（P2，可选）
- Hermes cron/（~40 文件）：incidents / quota_hold / unreachable_retry / monitor / lifecycle_guard 等运维面。
- EvoClaw CronScheduler 为执行引擎 + cron-suggestions，运维面深度未核。

### G9 战略差异声明（本轮判定不实施）
| 项 | 理由 |
|---|---|
| native_compaction（OpenAI 服务端 compaction） | EvoClaw 走 OpenAI 兼容网关，服务端能力由网关提供 |
| provider 原生适配器矩阵（anthropic/codex/bedrock/gemini/vertex/azure） | EvoClaw 已选型兼容网关 + 3 provider 适配器（anthropic/google/openai） |
| desktop GUI 工具族（preview/tour/tip/react/set_theme） | EvoClaw 无桌面产品（WebUI 路线） |
| Honcho / Pets / Skins / Goals / Credential Vault 外部后端 | 产品线装饰/生态，非核心引擎 |
| bot 社会层 roster/relay/hosted rooms | Bot Mode 产品化后置，现有 GroupChat 已可运行 |
| memory 双文件冻结快照（MEMORY.md/USER.md） | EvoClaw MemoryHub 分层架构为战略选择 |
| skills/hub 11 源适配器补全 | 已有 clawhub + agentskills.io + github 源码能力 |

## 三、建议实施步骤（按优先级）

> 每步完成即跑 `pnpm build -> pnpm typecheck -> pnpm test`（AGENTS.md 验证顺序）。

**Step 1 — 凭证池模型级冷却（价值高/风险低）**
1. `credential-pool.ts`：条目增 `modelCooldownUntil: Record<model, number>`；`markModelCooldown(provider, model)`；`isModelCoolingDown(provider, model)` 查询。
2. llm-caller 429/529 过载路径：按 `(provider, model)` 键记冷却（复用 overload-recovery 阶梯）；同凭证其他模型不受影响；Retry-After 容忍。
3. 测试：同凭证双模型场景 A 429 → A 冷却 B 可用；冷却到期恢复。

**Step 2 — slash 命令产品化入口（/review /learn /btw /plan）（低风险）**
1. `chat-commands.ts`：注册 4 命令 + handler 路由。
2. `/review` → background-review fork 评审（现有原语接线）。
3. `/learn` → skill_manage 引导/skill-creator 流程（已有原语接线）。
4. `/btw` → aux-client `generic` 一次性回答（不进历史，不占主会话预算）。
5. `/plan` → 规划模板（plan_prompt 语义：拆解模板 + todo seed）。
6. 测试：命令分发、不消耗主 turn、与背包预算隔离。

**Step 3 — execute_code 会话持久 kernel opt-in（中风险，需基准测试）**
1. 先做基准：当前 execute_code 冷启动开销（spawn + import）实测。
2. `code-kernel` LRU 池（owner+cwd 键，N=2-4）；`persistent:true` 启用；变量跨调用保留（对齐 Hermes code_kernel）。
3. 进程生命周期：超时回收、进程残留清理、并发上限、启动失败降级回 spawn。
4. 测试：跨调用变量、并发上限、kill 清理、降级。

**Step 4 — thinking 细节（4a 4b）**
1. reasoning promotion：llm-caller 收尾处检测"final reply 为空但 reasoning 含完整答案"→ 晋升提示/引导（白名单模型配置）。
2. anthropic thinking policy：历史装配处按 provider/model 决定 thinking 块保留策略（防多轮签名不一致 400）。
3. 测试：空回复+thinking 场景、多轮跨 provider 切换场景。

**Step 5 — TTS provider 注册表化 + Edge 免费默认**
1. `tts-providers.ts`：注册表（env 探测 + 可用性 checkFn）。
2. 补 Edge TTS（免费默认）、OpenAI/DeepInfra/ElevenLabs/Mistral/Gemini/MiniMax/xAI 兼容适配。
3. STT 最小面：本地 faster-whisper（默认免费）+ cloud provider 两三个（先纯文本/音频文件转写）。
4. 测试：各 provider mock 单测 + 缺 key 降级。

**Step 6 — process registry 增量（P2）**
1. wait policy（静默任务不高频 poll）。
2. kill tree + 幸存者验证。
（跨重启 checkpoint 可选。）

**Step 7 — skill ledger 编辑级回滚（P2）**
1. skill mutation 前快照单条（原子写）。
2. `skill_restore_latest_edit` 语义 + rollback fail-closed。

## 四、验证计划

- 每步：build → typecheck → test；新增/修改测试对齐已有测试数量增长。
- 涉及用户可见行为：Playwright/SSE 冒烟（如 slash 命令、TTS 端点）。
- 缓存语义变化：任何改动系统提示/工具集的步骤按 AGENTS.md 延迟失效策略执行。

## 五、附：本轮调研工时

- Hermes 工具层：282 文件 AST 扫描 + 逐文件 docstring 摘要。
- Hermes agent 内核：316 文件结构 + 九大主题深度调研（子代理 #2 报告）。
- Hermes 基础设施：10 大能力域（子代理 #3 报告，62 tool calls）。
- EvoClaw 侧：~40 次源码核验（对应物存在性、接入点、语义对齐）。
