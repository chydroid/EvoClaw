# EvoClaw LLM 调用性能优化路线图（按优先级）

> 本文件是 `performance-analysis.md`（分析基线）的执行视图：只做优先级裁决、执行序、验收与风险控制。
> 瓶颈证据与分析全文见 `performance-analysis.md` 第 2、3 章，此处不再重复。

## 优先级裁决原则

1. **热路径优先**：P0 只针对「每个 LLM 工具循环轮次（≤30 轮）都跑」的重复计算与同步 I/O，单位收益 × 轮次放大，ROI 最高。
2. **串行化其次**：P1 消除「可并行却串行 await」的固定等待（SkillDispatcher / 归档），单次收益固定（~200ms）但只发生一次。
3. **序列化去重最后**：P2 是 GC 层面的边际优化，需 LRU+TTL 缓存策略，实现与测试成本最高，故排最后。
4. **不变量（红线）**：P0-7 消息前序布局 `[sys_frozen, sys_ephemeral, skills?, tail?, ...history, user]` 全程不动；前缀改写仍只走 CompactionManager（AGENTS.md「prompt cache is sacred」）。任何优化若触碰该布局，直接拒绝合并。

## 三阶段路线图

### Phase 1（P0，1–2 天）—— 热路径去重 + 同步 I/O 消除

| 序 | 项 | 动作 | 落点 | 单轮收益 | 放大收益（30 轮） |
|---|----|------|------|----------|-------------------|
| 1 | P0-1 | `getLLMCallerDeps` 会话级缓存：`depsVersion` 计数器 + `Map<sessionId,{version,deps}>`，`cleanToolCache` 挪出热构建路径 | agent-model-executor.ts:1057 | 2–5 ms | 60–150 ms/turn + GC↓~30% |
| 2 | P0-2 | 把 `asyncLog`（16 ms 批量+unref）提升为独立共享模块；executor 主体全部 `process.stdout/stderr.write` 替换 | agent-model-executor.ts:2050 ↔ llm-caller.ts:33 | 5–15 ms（事件循环不阻塞） | 高并发（>5 会话）在飞延迟↓~40% |
| 3 | P0-3 | `computeDynamicToolLimit` 结果按 sessionId + 消息指纹缓存（16 条正则 + `hasActionIntentFn` 不再每轮重跑） | llm-caller.ts:1552–1602 | ~1 ms | ~30 ms/turn |

**为什么 P0 先做**：三者全是工具循环每轮必跑、改动局部（函数内/模块内）、零语义变化（缓存命中即原值），是纯机械替换，风险最低、可独立验证、可回滚。P0-1 与 P0-3 共享同一套「会话级指纹缓存」脚手架，应同批实现共享工具函数。

### Phase 2（P1，3–5 天）—— GC 压力 + 串行化消除

| 序 | 项 | 动作 | 落点 | 收益 |
|----|----|------|------|------|
| 4 | P1-1 | `expandedProviders` 按 providers 引用哈希缓存，引用不变直接复用（不再每轮 `{...p, model}` 展开） | llm-caller.ts:4046–4056 | ~0.5 ms/轮，对象分配↓~10% |
| 5 | P1-2 | `SkillDispatcher.dispatch()` 改后台预热：不 await，仅 LLM 全 provider 熔断后 `await` 兜底 | chatInner dispatch 调用处 | 90%（LLM 可用）场景省 ~200 ms 串行等待 |
| 6 | P1-3 | `sessionLoadFn` 内 `archiveOlderTurns` 与 `conversationHistory.set` 并行（fire-and-forget，归档失败不阻塞加载） | agent-model-executor.ts:2043–2055 | 会话加载关键路径减 1 次串行 I/O |

**为什么 P1 排第二**：P1-2 需要改动控制流（预热 + 兜底 await 时序），涉及 LLM 全挂这条罕见分支的正确性验证（需专门测试），成本高于 P0；P1-1 是 P0-1 脚手架的复用扩展；P1-3 改变并发时序需确认归档失败语义。三者都不在每轮热路径上（P1-1 除外，但它只是 P0 的延展），故让位于 P0。

### Phase 3（P2，1–2 周）—— 序列化去重

| 序 | 项 | 动作 | 收益 |
|----|----|------|------|
| 7 | P2-1 | `recordToolTrace` 入参 `JSON.stringify(result).slice(0,500)` 按 `(toolName+params)` LRU+TTL（100 条 / 5 min）缓存 | 热循环重复序列化消除 |
| 8 | P2-2 | `guardrailedReply` 的 pretty-print（`JSON.stringify(parsed.data, null, 2)`）改惰性生成，仅展示处需要时才跑 | agent-model-executor.ts:3008，省去每次全量 pretty |

**为什么 P2 最后**：引入 LRU+TTL 缓存 = 新内存子系统 + 失效策略，测试面最大（缓存正确性、内存上界、参数指纹稳定性），ROI 最低（非阻塞、非固定延迟），故排在 P0/P1 验证稳定后做。

## 执行序与依赖

```
P0-1 ─┐
P0-3 ─┴─> 共享「会话级指纹缓存」脚手架 ─> P1-1
P0-2 ───────────────────────────────> （独立模块，无依赖）
P1-2 / P1-3 ─> （独立控制流改动，互不依赖）
P2-1 / P2-2 ─> （独立，放最后）
```

- P0 三项可在 1 个 PR 内完成（共享脚手架 + 独立模块 + 独立缓存），先合并、先验证。
- P1 三项建议 2 个 PR：P1-1 跟 P0 脚手架一个 PR；P1-2 + P1-3 各自独立 PR（控制流改动需独立评审）。
- P2 两项独立 PR，互不依赖。

## 验收标准（全绿才合并）

1. `pnpm build` → `pnpm typecheck` → `pnpm test` 全绿（AGENTS.md 强制顺序）。
2. 30 轮工具循环：deps 构建 30 次 → 1 次（depsVersion 命中，单测断言）。
3. 热路径零同步写：`grep -n "process.stdout.write" packages/agent/src/agent-model-executor.ts` 工具循环内为 0。
4. 首响延迟（LLM 可用场景）较优化前降 ≥ 200 ms（P1-2 预热命中即达成）。
5. **不变量**：P0-7 消息前序布局 `[sys_frozen, sys_ephemeral, skills?, tail?, ...history, user]` 顺序与内容逐字节不变（前缀缓存快照测试守护）。

## 风险与回滚

| 风险 | 项 | 缓解 |
|------|----|------|
| depsVersion 漏递增导致返回过期 deps | P0-1 | 每次 `configure()`/`configureProviders()`/工具注册变更都递增；单测覆盖「变更后必重建」 |
| 预热结果被过早丢弃 / LLM 全挂时 await 时序错 | P1-2 | 仅 `Promise` 持有、LLM 主路径不读；全挂兜底路径加专门分支测试 |
| LRU 参数指纹对大对象不稳定（key 本身比 value 还贵） | P2-1 | 指纹用 toolName + 浅层 JSON 键，超阈值直接跳过缓存（不强制入 cache） |
| 布局意外漂移击穿前缀缓存 | 全部 | 前缀快照测试作为 merge gate（验收 #5） |

> 本路线图仅规划执行序；按 P0 → P1 → P2 实际改代码、重跑 `pnpm build && ppm typecheck && pnpm test` 是后续独立任务。
