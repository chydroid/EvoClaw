/**
 * Delegate Tools — delegate_task 子代理派发工具（对标 hermes-agent tools/delegate_tool.py）
 *
 * 注册 `delegate_task` 工具，让主代理把工作委派给隔离上下文中的子代理：
 *   - spawn（默认）：单 goal 或 tasks[] 批量并行派发；background=true 仅顶层生效
 *   - list：列出运行中的/已完成的子代理（id/goal/role/status）
 *   - steer：向运行中的子代理软注入实时指令（turn 间生效，不中止）
 *   - stop：提前结束一个子代理（部分输出仍返回）
 *
 * 契约对齐 Hermes DELEGATE_TASK_SCHEMA：tasks[] 每项 {goal(必填), context,
 * output_schema}；action/subagent_id/message 为控制面参数。
 * 遗留参数（顶层 goal/context/output_schema/role/max_iterations/background）
 * 照 Hermes 语义接受但不宣传：goal 形态包装成单条 batch；role 由深度派生被忽略；
 * max_iterations 由子会话预算（300）替代；background 对顶层生效。
 */

import type { AgentModelExecutor } from "@evoclaw/agent";
import type { DelegateEngine, DelegateTaskItem, DelegateDispatchResult } from "@evoclaw/agent";

export interface DelegateToolDeps {
  executor: AgentModelExecutor;
  delegateEngine: DelegateEngine;
  /** 获取当前 sessionId 的回调（ALS 未接线时的回退，与 todo-tools 同模式） */
  getSessionId: () => string;
}

/** 读取字符串参数（容错：非字符串视为未提供） */
function strParam(v: unknown): string | undefined {
  return typeof v === "string" && v.trim() ? v : undefined;
}

/** 把模型传入的 tasks[] 规范化为引擎输入（未知字段忽略） */
function normalizeTasks(raw: unknown): { items: DelegateTaskItem[]; error?: string } {
  if (!Array.isArray(raw)) {
    return { items: [], error: "tasks must be an array of {goal, context?, output_schema?}" };
  }
  const items: DelegateTaskItem[] = [];
  for (let i = 0; i < raw.length; i++) {
    const t = raw[i];
    if (!t || typeof t !== "object") {
      return { items: [], error: `tasks[${i}] must be an object with a "goal"` };
    }
    const goal = (t as Record<string, unknown>)["goal"];
    if (typeof goal !== "string" || !goal.trim()) {
      return { items: [], error: `tasks[${i}].goal is required and must be a non-empty string` };
    }
    const context = (t as Record<string, unknown>)["context"];
    const outputSchema = (t as Record<string, unknown>)["output_schema"];
    items.push({
      goal,
      context: typeof context === "string" ? context : undefined,
      output_schema:
        outputSchema && typeof outputSchema === "object" && !Array.isArray(outputSchema)
          ? (outputSchema as Record<string, unknown>)
          : undefined,
    });
  }
  if (items.length === 0) {
    return { items: [], error: "tasks must contain at least one task" };
  }
  return { items };
}

/** 构建工具描述（USE FOR / DO NOT USE FOR / RULES，对齐 Hermes 文案结构） */
function buildDescription(maxSpawnDepth: number, orchestratorEnabled: boolean, maxConcurrent: number): string {
  const orchestrationAvailable = maxSpawnDepth >= 2 && orchestratorEnabled;
  const restrictions = orchestrationAvailable
    ? `- Children cannot call clarify, memory, or cronjob.
- Children can themselves delegate while depth remains (max_spawn_depth=${maxSpawnDepth}); the runtime derives this from depth automatically.`
    : "- Children cannot call delegate_task, clarify, memory, or cronjob.";
  return [
    "Spawn subagents in isolated contexts; each gets its own conversation and toolset, and only its final summary returns to you. Pass every task in `tasks` — one entry spawns one subagent, several run in parallel (limit in the tasks description).",
    "",
    "USE FOR: reasoning-heavy subtasks, work that would flood your context, or independent parallel workstreams.",
    "DO NOT USE FOR (use these instead):",
    "- Mechanical multi-step work with no reasoning needed -> execute_code",
    "- A single tool call -> call the tool directly",
    "- Tasks needing user interaction -> subagents cannot ask questions",
    "- Durable work that must survive this session -> cronjob or terminal(background=True, notify=True); /stop, /new, or process exit halts running subagents (whole tree); each returns an 'interrupted' completion with partial output.",
    "",
    "RULES:",
    "- Children know nothing of this conversation: pass everything needed via each task's 'context', including any required output language, tone, or style (e.g. \"respond in Chinese\").",
    "- Child summaries are SELF-REPORTS, not verified facts: a child claiming \"uploaded successfully\" or \"file written\" may be wrong. For external side effects (uploads, remote writes, publishing), require a verifiable handle (URL, ID, absolute path) and verify it yourself before telling the user the operation succeeded.",
    "- Children cannot close tracked work: a child asked to close it returns findings instead; the parent applies the transition.",
    "- Children inherit the parent model unless pinned via delegation.provider / delegation.model in config.yaml.",
    restrictions,
    `Background mode: pass background=true to dispatch without waiting; results re-enter as a new message when children finish. Use action=list to check status, action=steer/stop to control them live.`,
  ].join("\n");
}

export function registerDelegateTools(deps: DelegateToolDeps): void {
  const { executor, delegateEngine, getSessionId } = deps;

  const description = buildDescription(
    delegateEngine.maxSpawnDepth,
    delegateEngine.orchestratorEnabled,
    delegateEngine.maxConcurrentChildren,
  );

  executor.registerTool(
    "delegate_task",
    {
      name: "delegate_task",
      description,
      parameters: {
        type: "object",
        properties: {
          tasks: {
            type: "array",
            minItems: 1,
            description:
              `The task(s), up to ${delegateEngine.maxConcurrentChildren} in parallel (delegation.max_concurrent_children). ` +
              "Each entry spawns one subagent with isolated context; a single task is a one-entry array. Required when spawning.",
            items: {
              type: "object",
              properties: {
                goal: {
                  type: "string",
                  description:
                    "What this subagent should accomplish. Be specific and self-contained — it knows " +
                    "nothing about your conversation history.",
                },
                context: {
                  type: "string",
                  description:
                    "Background THIS child needs: file paths, error messages, constraints. Each child " +
                    "sees only its own context — repeat shared background in every task that needs it.",
                },
                output_schema: {
                  type: "object",
                  description:
                    "Optional JSON Schema this child's final answer must validate against (told to the " +
                    "child up front; parent validates with one bounded correction retry; result gains " +
                    "schema_valid, plus schema_errors on failure — the child's raw text is still returned " +
                    "as summary, never discarded). Keep it forgiving — require only fields you will read.",
                },
              },
              required: ["goal"],
            },
          },
          action: {
            type: "string",
            enum: ["spawn", "list", "steer", "stop"],
            required: false,
            description:
              "Default 'spawn'. Live control of running children: 'list' = ids/goals/status; " +
              "'steer' = queue course-correction text into one child (subagent_id + message) without stopping it; " +
              "'stop' = end one child early (subagent_id; partial result still returns). " +
              "Control actions return immediately; goal/tasks are ignored unless spawning.",
          },
          subagent_id: {
            type: "string",
            required: false,
            description: "Target for action='steer'/'stop' (ids from the spawn response or action='list').",
          },
          message: {
            type: "string",
            required: false,
            description:
              "For action='steer': the course correction, appended to the child's next turn. Be directive and specific.",
          },
        },
        required: [],
      },
    },
    async (params: Record<string, unknown>) => {
      const action = strParam(params.action) ?? "spawn";

      // ── 控制面：list / steer / stop（立即返回，不触发派发）──
      if (action === "list") {
        return JSON.stringify({
          success: true,
          runs: delegateEngine.listRuns(),
        });
      }
      if (action === "steer") {
        const id = strParam(params.subagent_id);
        const message = strParam(params.message);
        if (!id) return JSON.stringify({ success: false, error: "action='steer' requires subagent_id" });
        if (!message) return JSON.stringify({ success: false, error: "action='steer' requires message" });
        const ok = delegateEngine.steerRun(id, message);
        return ok
          ? JSON.stringify({ success: true, steered: id, note: "Instruction queued; applies at the child's next turn." })
          : JSON.stringify({ success: false, error: `subagent_id "${id}" is not a running child (check action='list')` });
      }
      if (action === "stop") {
        const id = strParam(params.subagent_id);
        if (!id) return JSON.stringify({ success: false, error: "action='stop' requires subagent_id" });
        const ok = delegateEngine.stopRun(id);
        return ok
          ? JSON.stringify({ success: true, stopped: id, note: "Child will stop at the next turn boundary; partial output is returned." })
          : JSON.stringify({ success: false, error: `subagent_id "${id}" is not a running child (check action='list')` });
      }

      // ── spawn（默认）：规范化 tasks → 引擎派发 ──
      let items: DelegateTaskItem[];
      const tasks = params.tasks;
      if (tasks !== undefined) {
        const normalized = normalizeTasks(tasks);
        if (normalized.error) {
          return JSON.stringify({ success: false, error: normalized.error });
        }
        items = normalized.items;
      } else if (typeof params.goal === "string") {
        // 遗留单 goal 形态：包装成单条 batch（Hermes 语义）
        items = [
          {
            goal: params.goal,
            context: typeof params.context === "string" ? params.context : undefined,
            output_schema:
              params.output_schema && typeof params.output_schema === "object" && !Array.isArray(params.output_schema)
                ? (params.output_schema as Record<string, unknown>)
                : undefined,
          },
        ];
      } else {
        return JSON.stringify({
          success: false,
          error: "Provide tasks[] (preferred) or the legacy top-level goal/context/output_schema.",
        });
      }

      // 遗留参数告警（对齐 Hermes：接受但不宣传）
      const warnings: string[] = [];
      if (params.role !== undefined) {
        warnings.push("role is legacy and ignored: capability is derived from delegation depth.");
      }
      if (params.max_iterations !== undefined) {
        warnings.push("max_iterations is ignored: child sessions use the built-in child iteration budget.");
      }

      try {
        const result: DelegateDispatchResult = await delegateEngine.spawn(items, {
          background: params.background === true,
          parentSessionId: getSessionId(),
        });
        return JSON.stringify({
          success: true,
          ...result,
          ...(warnings.length > 0 ? { warnings } : {}),
        });
      } catch (err) {
        return JSON.stringify({
          success: false,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    },
  );
}
