// Slash command handling for AgentModelExecutor
// Extracted from agent-model-executor.ts for modularity

import type { ServiceRegistry, MemoryEntry, MemorySearchResult } from "@evoclaw/core";
import type { PersonaConfig } from "@evoclaw/core";
import type { ModelConfig, ProviderConfig, ToolDefinition } from "./types";
import { taskStatusTracker } from "./task-status-tracker";
import type { CompactionManager } from "./compaction-manager";
import type { SessionManager } from "./session-manager";
import type { ExecutionCheckpointStore } from "./execution-checkpoint";
import type { HumanApprovalManager, PendingApproval, ApprovalConfig, TrustRule, RiskLevel } from "./human-approval";
import type { EvalRunner, EvalRunSummary } from "./evals";

/** Conversation history entry type */
export interface ConversationHistoryEntry {
  role: string;
  content: string | null;
  tool_calls?: Array<{ id: string; type: string; function: { name: string; arguments: string } }>;
  tool_call_id?: string;
  name?: string;
}

/** Sequential thinking history entry type */
export interface ThinkingHistoryEntry {
  thoughtNumber: number;
  thought: string;
  isRevision?: boolean;
  revisesThought?: number;
  branchFromThought?: number;
  branchId?: string;
}

/** Memory hub interface */
export interface MemoryHubLike {
  getLongTerm(): {
    store(entry: MemoryEntry): Promise<MemoryEntry>;
    search(query: { query: string; limit: number; tags?: string[] }): Promise<MemorySearchResult[]>;
  };
}

/** Dependencies needed by handleSlashCommand */
export interface SlashCommandDeps {
  persona: PersonaConfig;
  providers: ProviderConfig[];
  config: ModelConfig;
  registeredTools: Map<string, { definition: ToolDefinition; handler: (params: Record<string, unknown>) => Promise<unknown> }>;
  conversationHistory: Map<string, Array<ConversationHistoryEntry>>;
  sequentialThinkingHistory: Map<string, Array<ThinkingHistoryEntry>>;
  workspacePath: string;
  thinkingLevel: "off" | "low" | "medium" | "high";
  autoCompactionEnabled: boolean;
  registry: ServiceRegistry;
  memoryHub: MemoryHubLike | null;
  compactionManager: CompactionManager | null;
  sessionManager: SessionManager | null;
  executionCheckpointStore?: ExecutionCheckpointStore;
  humanApprovalManager?: HumanApprovalManager;
  evalRunner?: EvalRunner;
}

/** Result type for slash command handling */
export interface SlashCommandResult {
  reply: string;
  tokensUsed: number;
  duration: number;
  permissionRequests: Array<{ id: string; operation: string; description: string; target: string }>;
  toolsExecuted: boolean;
  files?: Array<{ path: string; size: number; downloadUrl: string }>;
  /** Side-effect actions the caller should apply */
  action?: "new_session" | "reset_session" | "compact";
  /** Updated thinking level if changed */
  thinkingLevel?: "off" | "low" | "medium" | "high";
}

/**
 * Handle slash commands (/help, /status, /model, etc.)
 * Returns null if the message is not a slash command.
 */
export async function handleSlashCommand(
  deps: SlashCommandDeps,
  message: string,
  sessionId: string,
  startTime: number,
): Promise<SlashCommandResult | null> {
  if (!message.startsWith("/")) return null;

  const spaceIdx = message.indexOf(" ");
  const cmdName = spaceIdx === -1
    ? message.slice(1).toLowerCase()
    : message.slice(1, spaceIdx).toLowerCase();
  const args = spaceIdx === -1 ? [] : message.slice(spaceIdx + 1).split(/\s+/);

  let reply: string;
  let action: "new_session" | "reset_session" | "compact" | null = null;
  let newThinkingLevel: "off" | "low" | "medium" | "high" | undefined;

  switch (cmdName) {
    case "help": {
      reply = [
        "**📋 可用命令**",
        "",
        "`/help` — 显示所有可用命令",
        "`/status` — 查看当前代理与会话状态",
        "`/model` — 查看当前模型信息",
        "`/model list` — 列出所有已配置模型",
        "`/model switch <名称>` — 切换模型",
        "`/health` — 系统健康检查",
        "`/skills` — 列出已安装技能",
        "`/new` — 开始新会话",
        "`/reset` — 完全重置当前会话",
        "`/compact` — 压缩会话上下文",
        "`/clear` — 清空当前对话显示",
        "`/thinking <off|low|medium|high>` — 设置思考级别",
        "`/verbose <on|off>` — 切换详细输出",
        "`/usage <off|tokens|full>` — 控制用量报告",
        "`/memory <查询>` — 语义记忆搜索",
        "`/cron list` — 查看定时任务",
        "`/plugin list` — 查看插件列表",
        "`/focus <type> <id>` — 聚焦上下文目标",
        "`/unfocus` — 取消上下文聚焦",
        "`/agents` — 列出可用上下文目标",
        "`/checkpoints` — 列出可恢复的执行检查点",
        "`/resume <sessionId>` — 从检查点恢复中断的执行",
        "`/checkpoint <sessionId> <index>` — 查看指定快照详情",
        "`/pending` — 列出等待审批的操作",
        "`/approve <approvalId> [trust]` — 批准待审批操作（加 trust 自动信任后续同类操作）",
        "`/reject <approvalId> [reason]` — 拒绝待审批操作",
        "`/trust <toolName>` — 添加工具信任规则（自动批准）",
        "`/untrust <toolName>` — 移除工具信任规则",
        "`/approval_config` — 查看审批配置",
        "`/eval list` — 列出可用评估用例",
        "`/eval run [category]` — 运行评估（可按类别筛选）",
        "`/eval results [runId]` — 查看评估结果",
        "",
        "**📡 A2A 协议命令**",
        "`/a2a discover <url>` — 发现远程代理",
        "`/a2a agents` — 列出已知远程代理",
        "`/a2a send <agent> <message>` — 向远程代理发送任务",
        "`/a2a card` — 显示本机代理卡片",
      ].join("\n");
      break;
    }

    case "status": {
      const enabledProviders = deps.providers.filter(p => p.enabled).sort((a, b) => a.order - b.order);
      const currentModel = enabledProviders.length > 0
        ? `${enabledProviders[0].name} (${enabledProviders[0].provider}/${enabledProviders[0].model})`
        : "无已启用模型";
      const history = deps.conversationHistory.get(sessionId) || [];
      const ts = new Date().toLocaleString("zh-CN", {
        year: "numeric", month: "2-digit", day: "2-digit",
        hour: "2-digit", minute: "2-digit", second: "2-digit",
      });
      reply = [
        `**🧬 代理状态**`,
        ``,
        `📅 ${ts}`,
        `Agent: \`${deps.persona.name}\``,
        `Session: \`${sessionId}\``,
        `当前模型: \`${currentModel}\``,
        `已启用模型数: ${enabledProviders.length}`,
        `对话轮次: ${history.length}`,
        `已注册工具: ${deps.registeredTools.size}`,
        `自动压缩: ${deps.autoCompactionEnabled ? "已启用" : "未启用"}`,
      ].join("\n");
      break;
    }

    case "model": {
      const enabledProviders = deps.providers.filter(p => p.enabled).sort((a, b) => a.order - b.order);
      const allProviders = deps.providers;

      if (args.length === 0 || args[0] === "list" || args[0] === "ls") {
        const lines: string[] = ["**🤖 模型配置**", ""];
        if (enabledProviders.length === 0) {
          lines.push("⚠ 无已启用模型");
        } else {
          for (let i = 0; i < enabledProviders.length; i++) {
            const p = enabledProviders[i];
            const tag = i === 0 ? " **[当前主模型]**" : "";
            lines.push(`${i + 1}. **${p.name}**${tag}`);
            lines.push(`   - 模型: \`${p.model}\` | 类型: \`${p.provider}\``);
            lines.push(`   - 超时: ${p.timeout / 1000}s | 最大 Token: ${p.maxTokens}`);
            if (p.baseURL) {
              lines.push(`   - 端点: \`${p.baseURL.replace(/\/+$/, "")}\``);
            }
          }
        }
        if (allProviders.length > enabledProviders.length) {
          lines.push(`\n⚠ 已禁用: ${allProviders.length - enabledProviders.length} 个模型`);
        }
        reply = lines.join("\n");
      } else if (args[0] === "current" || args[0] === "active") {
        if (enabledProviders.length > 0) {
          const p = enabledProviders[0];
          reply = `当前主模型: **${p.name}** (\`${p.provider}/${p.model}\`)`;
        } else {
          reply = "⚠ 无已启用模型";
        }
      } else if (args[0] === "switch" || args[0] === "use") {
        if (args.length < 2) {
          reply = "用法: `/model switch <模型名称>`\n使用 `/model list` 查看可用模型";
        } else {
          const targetName = args.slice(1).join(" ");
          const target = allProviders.find(p =>
            p.name.toLowerCase() === targetName.toLowerCase() ||
            p.id?.toLowerCase() === targetName.toLowerCase() ||
            p.model.toLowerCase() === targetName.toLowerCase()
          );
          if (target) {
            const oldOrder = target.order;
            target.order = 0;
            for (const p of allProviders) {
              if (p !== target && p.order <= oldOrder && p.enabled) {
                p.order += 1;
              }
            }
            allProviders.sort((a, b) => a.order - b.order);
            reply = `✅ 已切换到 **${target.name}** (\`${target.provider}/${target.model}\`)`;
          } else {
            reply = `⚠ 未找到模型 "${targetName}"。使用 \`/model list\` 查看可用模型`;
          }
        }
      } else {
        reply = `未知的 /model 子命令: "${args[0]}"\n可用: list, current, switch <名称>`;
      }
      break;
    }

    case "health": {
      const enabledProviders = deps.providers.filter(p => p.enabled);
      const toolCount = deps.registeredTools.size;
      const skillManager = deps.registry?.resolveService<{ listSkills(): Promise<Array<unknown>> }>("skillManager");
      let skillCount = 0;
      if (skillManager) {
        try { skillCount = (await skillManager.listSkills()).length; } catch { skillCount = 0; }
      }
      const obs = deps.registry?.resolveService<unknown>("observability");
      const ts = new Date().toLocaleString("zh-CN", {
        year: "numeric", month: "2-digit", day: "2-digit",
        hour: "2-digit", minute: "2-digit", second: "2-digit",
      });
      reply = [
        `**🏥 健康检查**`,
        ``,
        `📅 ${ts}`,
        `状态: ✅ 正常运行`,
        `已启用模型: ${enabledProviders.length}`,
        `已注册工具: ${toolCount}`,
        `已安装技能: ${skillCount}`,
        `Observability: ${obs ? "✅ 已集成" : "⚠ 未集成"}`,
        `Memory: ${deps.memoryHub ? "✅ 已集成" : "⚠ 未集成"}`,
        `Compaction: ${deps.compactionManager ? "✅ 已集成" : "⚠ 未集成"}`,
        `Session Manager: ${deps.sessionManager ? "✅ 已集成" : "⚠ 未集成"}`,
      ].join("\n");
      break;
    }

    case "skills": {
      const skillManager = deps.registry?.resolveService<{ listSkills(): Promise<Array<{ name: string; description?: string; installed?: boolean }>> }>("skillManager");
      if (!skillManager) {
        reply = "⚠ 技能管理器不可用";
        break;
      }
      let allSkills: Array<{ name: string; description?: string; installed?: boolean }>;
      try { allSkills = await skillManager.listSkills(); } catch { allSkills = []; }
      if (allSkills.length === 0) {
        reply = "📦 暂无已安装技能";
      } else {
        const lines = [`**📦 已安装技能** (${allSkills.length})`, ""];
        for (const s of allSkills.slice(0, 30)) {
          const desc = s.description ? ` — ${s.description}` : "";
          lines.push(`- \`${s.name}\`${desc}`);
        }
        if (allSkills.length > 30) {
          lines.push(`...及其他 ${allSkills.length - 30} 个技能`);
        }
        reply = lines.join("\n");
      }
      break;
    }

    case "new": {
      reply = "✅ 新会话已创建。之前的会话已归档。";
      action = "new_session";
      break;
    }

    case "reset": {
      deps.conversationHistory.delete(sessionId);
      deps.sequentialThinkingHistory.delete(sessionId);
      reply = "✅ 会话已完全重置。所有上下文已清除。";
      action = "reset_session";
      break;
    }

    case "compact": {
      if (deps.compactionManager) {
        const history = deps.conversationHistory.get(sessionId) || [];
        if (history.length > 4) {
          deps.compactionManager.buildSummary(sessionId, history.filter(t => t.role === "user" || t.role === "assistant").map(t => ({
            role: t.role,
            content: t.content || "",
          })));
          reply = "✅ 对话历史已压缩。旧消息已摘要，最近轮次已保留。";
        } else {
          reply = "ℹ 对话历史较短，无需压缩。";
        }
      } else {
        reply = "⚠ 压缩管理器不可用";
      }
      action = "compact";
      break;
    }

    case "clear": {
      deps.conversationHistory.delete(sessionId);
      deps.sequentialThinkingHistory.delete(sessionId);
      reply = "✅ 对话显示已清空。";
      break;
    }

    case "thinking": {
      const level = args[0]?.toLowerCase();
      const validLevels = ["off", "low", "medium", "high"];
      if (!level || !validLevels.includes(level)) {
        reply = `用法: \`/thinking <off|low|medium|high>\``;
      } else {
        newThinkingLevel = level as "off" | "low" | "medium" | "high";
        reply = `✅ 思考级别已设置为 **${level}**。${level === "off" ? "将不使用结构化推理。" : level === "low" ? "将使用基本推理。" : level === "medium" ? "将使用结构化推理+假设验证。" : "将使用深度推理+分支探索+反思验证。"}`;
      }
      break;
    }

    case "verbose": {
      const val = args[0]?.toLowerCase();
      if (val !== "on" && val !== "off") {
        reply = "用法: `/verbose on|off`";
      } else {
        reply = `✅ 详细输出已设置为 **${val}**。`;
      }
      break;
    }

    case "usage": {
      const val = args[0]?.toLowerCase();
      const valid = ["off", "tokens", "full"];
      if (!val || !valid.includes(val)) {
        reply = "用法: `/usage <off|tokens|full>`";
      } else {
        const label = { off: "关闭", tokens: "仅 Token", full: "完整报告" }[val]!;
        reply = `✅ 用量报告已设置为 **${label}**。`;
      }
      break;
    }

    case "memory": {
      if (!deps.memoryHub) {
        reply = "⚠ 记忆系统不可用";
        break;
      }
      const query = args.join(" ");
      if (!query) {
        reply = "用法: `/memory <查询关键词>`";
        break;
      }
      try {
        const results = await deps.memoryHub.getLongTerm().search({ query, limit: 5 });
        if (results.length === 0) {
          reply = `🔍 未找到与 "${query}" 相关的记忆。`;
        } else {
          const lines = [`**🔍 记忆搜索结果** (${results.length})`, ""];
          for (const r of results) {
            const content = typeof r.entry?.content === "string" ? r.entry.content.slice(0, 200) : String(r.entry?.content ?? "").slice(0, 200);
            lines.push(`- ${content}${content.length >= 200 ? "..." : ""}`);
          }
          reply = lines.join("\n");
        }
      } catch {
        reply = "⚠ 记忆搜索失败";
      }
      break;
    }

    case "cron": {
      const cronScheduler = deps.registry?.resolveService<{ listJobs?(): Array<{ id: string; name: string; schedule: string; enabled: boolean; status?: string; lastRun?: Date; nextRun?: Date; runCount?: number; errorCount?: number }> }>("cronScheduler");
      if (!cronScheduler || !cronScheduler.listJobs) {
        reply = "⚠ 定时任务管理器不可用";
        break;
      }
      const jobs = cronScheduler.listJobs();
      if (jobs.length === 0) {
        reply = "⏰ 暂无定时任务";
      } else {
        const lines = [`**⏰ 定时任务** (${jobs.length})`, ""];
        for (const j of jobs) {
          const statusIcon = j.enabled ? "✅" : "⏸";
          const statusStr = j.status ? ` [${j.status}]` : "";
          const runInfo = j.runCount ? ` (运行 ${j.runCount} 次)` : "";
          lines.push(`- ${statusIcon} \`${j.name}\` — ${j.schedule}${statusStr}${runInfo}`);
        }
        reply = lines.join("\n");
      }
      break;
    }

    case "plugin": {
      const pluginManager = deps.registry?.resolveService<{ getPlugins(): Array<{ manifest: { name: string; version: string; description: string; author?: string }; status: string; error?: string }> }>("pluginManager");
      if (!pluginManager) {
        reply = "⚠ 插件管理器不可用";
        break;
      }
      const plugins = pluginManager.getPlugins();
      if (plugins.length === 0) {
        reply = "🔌 暂无已安装插件";
      } else {
        const lines = [`**🔌 已安装插件** (${plugins.length})`, ""];
        for (const p of plugins) {
          const statusIcon = p.status === "active" ? "✅" : p.status === "disabled" ? "⏸" : "⚠";
          const author = p.manifest.author ? ` by ${p.manifest.author}` : "";
          const errTag = p.error ? ` — ❌ ${p.error}` : "";
          lines.push(`- ${statusIcon} **${p.manifest.name}** v${p.manifest.version}${author} — ${p.manifest.description}${errTag}`);
        }
        reply = lines.join("\n");
      }
      break;
    }

    case "focus": {
      if (args.length < 2) {
        reply = "用法: `/focus <type> <id>` — type 可以是 `channel`、`session`、`agent` 或 `peer`";
        break;
      }
      const [type, targetId] = args;
      const validTypes = ["channel", "session", "agent", "peer"];
      if (!validTypes.includes(type)) {
        reply = `⚠ 无效的聚焦类型: "${type}"。有效: ${validTypes.join(", ")}`;
      } else {
        reply = `✅ 已聚焦到 ${type}: \`${targetId}\``;
      }
      break;
    }

    case "unfocus": {
      reply = "✅ 已取消聚焦。消息将发送到广播模式。";
      break;
    }

    case "agents": {
      reply = "**📋 可用上下文目标**\n\n使用 `/focus <type> <id>` 聚焦到指定目标。";
      break;
    }

    case "checkpoints": {
      if (!deps.executionCheckpointStore) {
        reply = "⚠ 执行检查点存储不可用";
        break;
      }
      const resumable = deps.executionCheckpointStore.getResumableExecutions();
      if (resumable.length === 0) {
        reply = "✅ 没有可恢复的执行检查点。所有执行均已完成。";
      } else {
        const lines = [`**🔄 可恢复的执行检查点** (${resumable.length})`, ""];
        for (const exec of resumable) {
          const statusIcon = exec.status === "interrupted" ? "⚠️" : exec.status === "failed" ? "❌" : "🔄";
          const timeStr = new Date(exec.lastCheckpointTime).toLocaleString("zh-CN");
          lines.push(`- ${statusIcon} \`${exec.sessionId}\` — ${exec.status} | 快照: ${exec.snapshots.length} | ${timeStr}`);
          lines.push(`  "${exec.originalMessage.slice(0, 80)}${exec.originalMessage.length > 80 ? "..." : ""}"`);
        }
        lines.push("", "使用 `/resume <sessionId>` 恢复执行");
        lines.push("使用 `/checkpoint <sessionId> <index>` 查看快照详情");
        reply = lines.join("\n");
      }
      break;
    }

    case "resume": {
      if (!deps.executionCheckpointStore) {
        reply = "⚠ 执行检查点存储不可用";
        break;
      }
      const targetSessionId = args[0];
      if (!targetSessionId) {
        reply = "用法: `/resume <sessionId>`\n使用 `/checkpoints` 查看可恢复的执行";
        break;
      }
      const execState = deps.executionCheckpointStore.getExecution(targetSessionId);
      if (!execState) {
        reply = `⚠ 未找到会话 \`${targetSessionId}\` 的执行状态`;
        break;
      }
      if (execState.status === "completed") {
        reply = `✅ 会话 \`${targetSessionId}\` 已完成，无需恢复。`;
        break;
      }
      // Note: actual resume is handled by the caller (AgentModelExecutor)
      // This command returns a special action to trigger it
      reply = `🔄 正在恢复会话 \`${targetSessionId}\` 的执行 (状态: ${execState.status}, 快照: ${execState.snapshots.length})...`;
      break;
    }

    case "checkpoint": {
      if (!deps.executionCheckpointStore) {
        reply = "⚠ 执行检查点存储不可用";
        break;
      }
      const cpSessionId = args[0];
      const cpIndexRaw = args[1] ? parseInt(args[1], 10) : undefined;
      const cpIndex = cpIndexRaw !== undefined && Number.isFinite(cpIndexRaw) ? cpIndexRaw : undefined;
      if (!cpSessionId) {
        reply = "用法: `/checkpoint <sessionId> [index]`\n使用 `/checkpoints` 查看所有执行";
        break;
      }
      const execState = deps.executionCheckpointStore.getExecution(cpSessionId);
      if (!execState) {
        reply = `⚠ 未找到会话 \`${cpSessionId}\` 的执行状态`;
        break;
      }
      if (cpIndex === undefined) {
        // Show summary of all snapshots
        const lines = [`**📋 执行检查点: \`${cpSessionId}\`**`, ""];
        lines.push(`状态: ${execState.status} | 快照数: ${execState.snapshots.length} | 原始消息: "${execState.originalMessage.slice(0, 80)}"`);
        if (execState.error) lines.push(`错误: ${execState.error}`);
        if (execState.finalResult) lines.push(`最终结果: ${execState.finalResult.slice(0, 200)}`);
        lines.push("", "**快照列表:**");
        for (let i = 0; i < execState.snapshots.length; i++) {
          const snap = execState.snapshots[i];
          const timeStr = new Date(snap.timestamp).toLocaleTimeString("zh-CN");
          lines.push(`  ${i}. [${snap.stepType}] ${timeStr} — tokens: ${snap.tokensUsed}, ${snap.durationMs}ms`);
        }
        lines.push("", "使用 `/checkpoint <sessionId> <index>` 查看特定快照详情");
        reply = lines.join("\n");
      } else {
        const snapshot = deps.executionCheckpointStore.getSnapshot(cpSessionId, cpIndex);
        if (!snapshot) {
          reply = `⚠ 未找到快照索引 ${cpIndex}。有效范围: 0-${execState.snapshots.length - 1}`;
          break;
        }
        const lines = [`**🔍 快照详情: \`${cpSessionId}\` [${cpIndex}]**`, ""];
        lines.push(`类型: ${snapshot.stepType}`);
        lines.push(`时间: ${new Date(snapshot.timestamp).toLocaleString("zh-CN")}`);
        lines.push(`Token 用量: ${snapshot.tokensUsed}`);
        lines.push(`持续时间: ${snapshot.durationMs}ms`);
        if (snapshot.currentToolCall) {
          lines.push(`当前工具调用: \`${snapshot.currentToolCall.name}\``);
          lines.push(`参数: ${snapshot.currentToolCall.arguments.slice(0, 200)}`);
        }
        if (snapshot.toolResult) {
          lines.push(`工具结果: \`${snapshot.toolResult.name}\` (${snapshot.toolResult.success ? "✅" : "❌"})`);
          lines.push(`结果预览: ${snapshot.toolResult.result.slice(0, 300)}`);
        }
        lines.push(`消息数: ${snapshot.messages.length}`);
        reply = lines.join("\n");
      }
      break;
    }

    case "pending": {
      if (!deps.humanApprovalManager) {
        reply = "⚠ 人工审批系统未启用。请在配置中启用 `humanApproval` 功能标志。";
        break;
      }
      const pendingList = deps.humanApprovalManager.getPendingApprovals(sessionId);
      if (pendingList.length === 0) {
        reply = "✅ 当前没有等待审批的操作。";
      } else {
        const lines = [`**⏳ 等待审批的操作** (${pendingList.length})`, ""];
        for (const p of pendingList) {
          const riskIcons: Record<string, string> = { critical: "🔴", high: "🟠", medium: "🟡", low: "🟢" };
          const icon = riskIcons[p.riskLevel] || "⚪";
          const timeStr = new Date(p.createdAt).toLocaleTimeString("zh-CN");
          lines.push(`- ${icon} \`${p.id}\` — \`${p.toolName}\` (${p.riskLevel}) | ${timeStr}`);
          lines.push(`  ${p.reason}`);
        }
        lines.push("", "使用 `/approve <id> [trust]` 批准，`/reject <id> [reason]` 拒绝");
        reply = lines.join("\n");
      }
      break;
    }

    case "approve": {
      if (!deps.humanApprovalManager) {
        reply = "⚠ 人工审批系统未启用";
        break;
      }
      const approvalId = args[0];
      if (!approvalId) {
        reply = "用法: `/approve <approvalId> [trust]`\n使用 `/pending` 查看等待审批的操作";
        break;
      }
      const trustFuture = args[1]?.toLowerCase() === "trust";
      const approval = deps.humanApprovalManager.getApproval(approvalId);
      if (!approval || approval.status !== "pending") {
        reply = `⚠ 未找到待审批操作 \`${approvalId}\`，可能已处理或已过期。`;
        break;
      }
      const success = deps.humanApprovalManager.approve(approvalId, "user", trustFuture);
      if (success) {
        const trustNote = trustFuture ? "\n🔓 已添加信任规则，后续同类操作将自动批准。" : "";
        reply = `✅ 操作 \`${approval.toolName}\` 已批准。${trustNote}`;
      } else {
        reply = `⚠ 批准失败，操作可能已过期。`;
      }
      break;
    }

    case "reject": {
      if (!deps.humanApprovalManager) {
        reply = "⚠ 人工审批系统未启用";
        break;
      }
      const rejectId = args[0];
      if (!rejectId) {
        reply = "用法: `/reject <approvalId> [reason]`\n使用 `/pending` 查看等待审批的操作";
        break;
      }
      const reason = args.slice(1).join(" ") || undefined;
      const rejectApproval = deps.humanApprovalManager.getApproval(rejectId);
      if (!rejectApproval || rejectApproval.status !== "pending") {
        reply = `⚠ 未找到待审批操作 \`${rejectId}\`，可能已处理或已过期。`;
        break;
      }
      const rejectSuccess = deps.humanApprovalManager.reject(rejectId, "user", reason);
      if (rejectSuccess) {
        const reasonNote = reason ? ` (原因: ${reason})` : "";
        reply = `❌ 操作 \`${rejectApproval.toolName}\` 已拒绝。${reasonNote}`;
      } else {
        reply = `⚠ 拒绝失败，操作可能已过期。`;
      }
      break;
    }

    case "trust": {
      if (!deps.humanApprovalManager) {
        reply = "⚠ 人工审批系统未启用";
        break;
      }
      const trustTool = args[0];
      if (!trustTool) {
        reply = "用法: `/trust <toolName>`\n添加信任规则后，该工具的操作将自动批准。";
        break;
      }
      deps.humanApprovalManager.addTrustRule({
        toolName: trustTool,
        trustedBy: "user",
        createdAt: Date.now(),
        expiresAt: 0,
      });
      reply = `🔓 已添加信任规则: \`${trustTool}\`。后续该工具的操作将自动批准，无需人工审批。`;
      break;
    }

    case "untrust": {
      if (!deps.humanApprovalManager) {
        reply = "⚠ 人工审批系统未启用";
        break;
      }
      const untrustTool = args[0];
      if (!untrustTool) {
        reply = "用法: `/untrust <toolName>`";
        break;
      }
      deps.humanApprovalManager.removeTrustRule(untrustTool);
      reply = `🔒 已移除信任规则: \`${untrustTool}\`。该工具的操作将恢复需要人工审批。`;
      break;
    }

    case "approval_config": {
      if (!deps.humanApprovalManager) {
        reply = "⚠ 人工审批系统未启用。请在配置中启用 `humanApproval` 功能标志。";
        break;
      }
      const config = deps.humanApprovalManager.getConfig();
      const trustRules = deps.humanApprovalManager.getTrustRules();
      const lines = [
        "**⚙️ 审批配置**",
        "",
        `审批超时: ${config.approvalTimeout / 1000}s`,
        `每会话最大待审批数: ${config.maxPendingPerSession}`,
        "",
        "**风险等级审批要求:**",
      ];
      for (const [level, required] of Object.entries(config.requireApproval)) {
        const icon = required ? "🔴 需要审批" : "🟢 自动批准";
        lines.push(`- ${level}: ${icon}`);
      }
      lines.push("", `**信任规则** (${trustRules.length}):`);
      if (trustRules.length === 0) {
        lines.push("- (无)");
      } else {
        for (const rule of trustRules) {
          const expiry = rule.expiresAt > 0 ? ` | 过期: ${new Date(rule.expiresAt).toLocaleString("zh-CN")}` : " | 永不过期";
          lines.push(`- \`${rule.toolName}\` — 由 ${rule.trustedBy} 添加${expiry}`);
        }
      }
      reply = lines.join("\n");
      break;
    }

    case "eval": {
      if (!deps.evalRunner) {
        reply = "⚠ 评估系统未启用。EvalRunner 未注册。";
        break;
      }
      const subCmd = args[0]?.toLowerCase();
      if (!subCmd || subCmd === "help") {
        reply = [
          "**📊 评估系统命令**",
          "",
          "`/eval list` — 列出所有可用评估用例",
          "`/eval run [category]` — 运行评估（可按类别筛选）",
          "`/eval results [runId]` — 查看评估运行结果",
        ].join("\n");
      } else if (subCmd === "list") {
        const evalCases = deps.evalRunner.getCases();
        const categories = deps.evalRunner.getCategories();
        if (evalCases.length === 0) {
          reply = "📦 暂无评估用例。请添加用例或加载内置用例。";
        } else {
          const lines = [`**📊 评估用例** (${evalCases.length})`, ""];
          lines.push(`**类别:** ${categories.join(", ")}`, "");
          for (const c of evalCases) {
            const diffIcon = c.difficulty === "easy" ? "🟢" : c.difficulty === "medium" ? "🟡" : "🔴";
            const tags = c.tags?.length ? ` [${c.tags.join(", ")}]` : "";
            lines.push(`- ${diffIcon} \`${c.id}\` — ${c.name} (${c.category})${tags}`);
          }
          lines.push("", "使用 `/eval run` 运行所有用例，或 `/eval run <category>` 按类别运行");
          reply = lines.join("\n");
        }
      } else if (subCmd === "run") {
        const category = args[1];
        const casesToRun = category
          ? deps.evalRunner.getCasesByCategory(category)
          : deps.evalRunner.getCases();
        if (casesToRun.length === 0) {
          reply = category
            ? `⚠ 未找到类别 "${category}" 的评估用例`
            : "⚠ 暂无评估用例可运行";
          break;
        }
        const categoryInfo = category ? ` (类别: ${category})` : "";
        reply = `🔄 正在运行 ${casesToRun.length} 个评估用例${categoryInfo}...\n\n⚠ 评估需要通过 API 调用代理执行，请使用 EvalRunner.run() 方法进行完整评估。此处仅展示用例概览：\n`;
        for (const c of casesToRun) {
          reply += `\n- \`${c.id}\`: ${c.input.slice(0, 60)}${c.input.length > 60 ? "..." : ""}`;
        }
        reply += `\n\n使用 \`/eval results\` 查看最近运行结果。`;
      } else if (subCmd === "results") {
        const runId = args[1];
        const history = deps.evalRunner.getRunHistory();
        if (history.length === 0) {
          reply = "📊 暂无评估运行记录。使用 `/eval run` 运行评估。";
          break;
        }
        let targetRun: EvalRunSummary | undefined;
        if (runId) {
          targetRun = deps.evalRunner.getRunById(runId);
        } else {
          targetRun = history[history.length - 1];
        }
        if (!targetRun) {
          reply = `⚠ 未找到评估运行 \`${runId}\`。可用运行: ${history.map(r => r.id).join(", ")}`;
          break;
        }
        const lines = [
          `**📊 评估结果: \`${targetRun.name}\`**`,
          "",
          `运行 ID: \`${targetRun.id}\``,
          `时间: ${new Date(targetRun.timestamp).toLocaleString("zh-CN")}`,
          `总用例: ${targetRun.totalCases} | 通过: ${targetRun.passed} | 失败: ${targetRun.failed}`,
          `平均分数: ${targetRun.averageScore} | 幻觉率: ${targetRun.hallucinationRate}`,
          `平均耗时: ${targetRun.averageDurationMs}ms`,
          "",
          "**详细结果:**",
        ];
        for (const r of targetRun.results) {
          const icon = r.taskCompleted ? "✅" : "❌";
          const errTag = r.error ? ` — ❌ ${r.error}` : "";
          lines.push(`- ${icon} \`${r.caseId}\` — 分数: ${r.score} | ${r.durationMs}ms${errTag}`);
        }
        if (Object.keys(targetRun.categoryBreakdown).length > 0) {
          lines.push("", "**类别分布:**");
          for (const [cat, info] of Object.entries(targetRun.categoryBreakdown)) {
            lines.push(`- ${cat}: ${info.passed}/${info.total} 通过, 平均分 ${info.averageScore}`);
          }
        }
        reply = lines.join("\n");
      } else {
        reply = `⚠ 未知的 /eval 子命令: "${subCmd}"\n可用: list, run [category], results [runId]`;
      }
      break;
    }

    case "a2a": {
      const subCmd = args[0]?.toLowerCase();
      if (!subCmd || subCmd === "help") {
        reply = [
          "**📡 A2A 协议命令**",
          "",
          "`/a2a discover <url>` — 发现远程代理",
          "`/a2a agents` — 列出已知远程代理",
          "`/a2a send <agent> <message>` — 向远程代理发送任务",
          "`/a2a card` — 显示本机代理卡片",
        ].join("\n");
      } else if (subCmd === "discover") {
        const url = args[1];
        if (!url) {
          reply = "用法: `/a2a discover <url>`\n例如: `/a2a discover http://localhost:8080`";
          break;
        }
        const a2aClient = deps.registry?.resolveService<{
          discoverAgent(url: string): Promise<{ name: string; description: string; url: string; version: string; capabilities: Array<{ id: string; name: string; description: string }> }>;
        }>("a2aClient");
        if (!a2aClient) {
          reply = "⚠ A2A 客户端不可用";
          break;
        }
        try {
          const card = await a2aClient.discoverAgent(url);
          const capLines = card.capabilities.length > 0
            ? card.capabilities.map(c => `  - \`${c.id}\`: ${c.description}`).join("\n")
            : "  (无)";
          reply = [
            `✅ 已发现远程代理: **${card.name}**`,
            ``,
            `描述: ${card.description}`,
            `URL: \`${card.url}\``,
            `版本: ${card.version}`,
            `能力:`,
            capLines,
          ].join("\n");
        } catch (err) {
          reply = `❌ 发现代理失败: ${err instanceof Error ? err.message : String(err)}`;
        }
      } else if (subCmd === "agents") {
        const a2aClient = deps.registry?.resolveService<{
          listAgents(): Array<{ name: string; description: string; url: string; version: string }>;
        }>("a2aClient");
        if (!a2aClient) {
          reply = "⚠ A2A 客户端不可用";
          break;
        }
        const agents = a2aClient.listAgents();
        if (agents.length === 0) {
          reply = "📡 暂无已知远程代理。使用 `/a2a discover <url>` 发现代理。";
        } else {
          const lines = [`**📡 已知远程代理** (${agents.length})`, ""];
          for (const a of agents) {
            lines.push(`- **${a.name}** — ${a.description}`);
            lines.push(`  URL: \`${a.url}\` | 版本: ${a.version}`);
          }
          reply = lines.join("\n");
        }
      } else if (subCmd === "send") {
        const agentName = args[1];
        const taskMessage = args.slice(2).join(" ");
        if (!agentName || !taskMessage) {
          reply = "用法: `/a2a send <agent> <message>`\n例如: `/a2a send WeatherAgent 今天北京天气如何`";
          break;
        }
        const a2aClient = deps.registry?.resolveService<{
          sendTask(agentName: string, task: { capabilityId: string; input: unknown }): Promise<{ taskId: string; status: string; output?: unknown; error?: string; durationMs?: number }>;
        }>("a2aClient");
        if (!a2aClient) {
          reply = "⚠ A2A 客户端不可用";
          break;
        }
        try {
          const result = await a2aClient.sendTask(agentName, {
            capabilityId: "chat",
            input: taskMessage,
          });
          if (result.status === "completed") {
            const outputStr = typeof result.output === "string" ? result.output : JSON.stringify(result.output, null, 2);
            const durationInfo = result.durationMs ? ` (${result.durationMs}ms)` : "";
            reply = `✅ 任务完成${durationInfo}\n\n${outputStr}`;
          } else {
            reply = `❌ 任务失败: ${result.error || "未知错误"} (taskId: ${result.taskId})`;
          }
        } catch (err) {
          reply = `❌ 发送任务失败: ${err instanceof Error ? err.message : String(err)}`;
        }
      } else if (subCmd === "card") {
        const a2aServer = deps.registry?.resolveService<{
          getAgentCard(): { name: string; description: string; url: string; version: string; capabilities: Array<{ id: string; name: string; description: string }>; authentication?: { type: string } };
          isEnabled(): boolean;
        }>("a2aServer");
        if (!a2aServer) {
          reply = "⚠ A2A 服务端不可用";
          break;
        }
        if (!a2aServer.isEnabled()) {
          reply = "⚠ A2A 服务端未启用。请在功能标志中启用 `a2a`。";
          break;
        }
        const card = a2aServer.getAgentCard();
        const capLines = card.capabilities.length > 0
          ? card.capabilities.slice(0, 20).map(c => `  - \`${c.id}\`: ${c.description}`).join("\n")
          : "  (无)";
        const moreCaps = card.capabilities.length > 20 ? `\n  ...及其他 ${card.capabilities.length - 20} 个能力` : "";
        reply = [
          `**📡 本机 A2A 代理卡片**`,
          ``,
          `名称: **${card.name}**`,
          `描述: ${card.description}`,
          `URL: \`${card.url}\``,
          `版本: ${card.version}`,
          `认证: ${card.authentication?.type || "none"}`,
          `能力 (${card.capabilities.length}):`,
          capLines + moreCaps,
        ].join("\n");
      } else {
        reply = `⚠ 未知的 /a2a 子命令: "${subCmd}"\n可用: discover, agents, send, card`;
      }
      break;
    }

    default: {
      reply = `⚠ 未知命令: \`/${cmdName}\`。输入 \`/help\` 查看可用命令。`;
      break;
    }
  }

  // Apply side-effect actions
  if (action === "new_session" && deps.sessionManager) {
    const newId = `sess_${Date.now()}`;
    deps.sessionManager.createSession("default", { sessionId: newId });
    deps.conversationHistory.delete(sessionId);
    deps.sequentialThinkingHistory.delete(sessionId);
  }

  if (action === "reset_session" && deps.sessionManager) {
    const resetId = `sess_${Date.now()}`;
    deps.sessionManager.createSession("default", { sessionId: resetId });
    deps.conversationHistory.delete(sessionId);
    deps.sequentialThinkingHistory.delete(sessionId);
  }

  taskStatusTracker.set(sessionId, "done", "命令已执行", 100);

  return {
    reply,
    tokensUsed: 0,
    duration: Date.now() - startTime,
    permissionRequests: [],
    toolsExecuted: false,
    files: [],
    action: action ?? undefined,
    thinkingLevel: newThinkingLevel,
  };
}
