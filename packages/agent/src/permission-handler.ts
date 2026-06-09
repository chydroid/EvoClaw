// Permission handling for AgentModelExecutor
// Extracted from agent-model-executor.ts for modularity

import type { ServiceRegistry, EventBus } from "@evoclaw/core";
import type { LedgerEventType, LedgerEntry } from "./event-ledger";
import type { ToolDefinition } from "./types";

/** EventLedger interface for permission handler */
export interface EventLedgerLike {
  append(type: LedgerEventType, data: Record<string, unknown>, opts?: { agentId?: string; sessionId?: string; causedBy?: number; duration?: number }): number;
  recordToolExecution(toolName: string, params: Record<string, unknown>, result: unknown, duration: number, opts?: { agentId?: string; sessionId?: string }): { callSeq: number; resultSeq: number };
  query(q: Record<string, unknown>): LedgerEntry[];
  snapshot(): Record<string, unknown>;
}

/** Pending operation entry */
export interface PendingOperation {
  sessionId: string;
  message: string;
  requestId: string;
  toolName: string;
  toolArgs: Record<string, unknown>;
}

/** Dependencies needed by permission handler functions */
export interface PermissionHandlerDeps {
  pendingOperations: Map<string, PendingOperation>;
  registeredTools: Map<string, { definition: ToolDefinition; handler: (params: Record<string, unknown>) => Promise<unknown> }>;
  registry: ServiceRegistry;
  eventBus: EventBus;
  getEventLedger(): EventLedgerLike | null;
}

/**
 * Permission approved event handler — clears the pending operation
 * and publishes a fast-approval event.
 */
export async function onPermissionApproved(
  deps: PermissionHandlerDeps,
  requestId: string,
): Promise<void> {
  const pending = deps.pendingOperations.get(requestId);
  if (!pending) return;
  deps.pendingOperations.delete(requestId);
  console.log(`[PermissionHandler] Permission approved for request "${requestId}". Notifying via event...`);
  deps.eventBus.publish("permission.approved_fast", {
    requestId,
    sessionId: pending.sessionId,
    toolName: pending.toolName,
  }, "agent-model-executor");
}

/**
 * 权限批准快速通道：直接重新执行被阻塞的工具，不经过 LLM
 * 返回工具执行结果，由调用方直接反馈给用户
 */
export async function approveAndExecute(
  deps: PermissionHandlerDeps,
  requestId: string,
  addToWhitelist: boolean = true,
): Promise<{ success: boolean; reply: string; toolName?: string }> {
  const pending = deps.pendingOperations.get(requestId);
  if (!pending) {
    return { success: false, reply: "⚠️ 未找到对应的权限请求，可能已过期或已处理。" };
  }
  deps.pendingOperations.delete(requestId);

  console.log(`[PermissionHandler] approveAndExecute: re-executing tool "${pending.toolName}" for request "${requestId}"`);

  // 1. 先在 PermissionManager 中批准该操作（加入白名单，5分钟内同类操作自动通过）
  const permManager = deps.registry?.resolveService<any>("permissionManager");
  if (permManager) {
    try {
      permManager.approveRequest(requestId, addToWhitelist);
    } catch (err) {
      console.warn(`[PermissionHandler] approveAndExecute: failed to approve in PermissionManager:`, err);
    }
  }

  // 2. 直接重新执行被阻塞的工具
  const toolEntry = deps.registeredTools.get(pending.toolName);
  if (!toolEntry) {
    return { success: false, reply: `⚠️ 工具 "${pending.toolName}" 未找到，无法执行。`, toolName: pending.toolName };
  }

  try {
    const toolStartTime = Date.now();
    const rawResult = await toolEntry.handler(pending.toolArgs);
    const duration = Date.now() - toolStartTime;

    // 记录到 EventLedger
    const ledger = deps.getEventLedger();
    if (ledger) {
      ledger.recordToolExecution(pending.toolName, pending.toolArgs, rawResult, duration, { agentId: "default", sessionId: pending.sessionId });
    }

    // 构建用户友好的反馈
    let resultText = "";
    if (rawResult && typeof rawResult === "object") {
      const r = rawResult as Record<string, unknown>;
      if (typeof r.content === "string") resultText = r.content;
      else if (typeof r.text === "string") resultText = r.text;
      else if (typeof r.message === "string") resultText = r.message;
      else resultText = JSON.stringify(rawResult);
    } else if (typeof rawResult === "string") {
      resultText = rawResult;
    } else {
      resultText = JSON.stringify(rawResult);
    }

    // 根据工具类型生成简洁的确认消息
    const toolLabelMap: Record<string, string> = {
      "file_create": "创建文件",
      "file_modify": "修改文件",
      "file_delete": "删除文件",
      "browser_navigate": "浏览器访问",
      "browser_submit_form": "提交表单",
      "skill_find_and_install": "安装技能",
      "email_add_account": "添加邮箱",
      "email_send": "发送邮件",
    };
    const toolLabel = toolLabelMap[pending.toolName] || pending.toolName;

    // 提取目标文件路径（如果有）
    const targetPath = (pending.toolArgs?.path as string) || (pending.toolArgs?.filePath as string) || (pending.toolArgs?.target as string) || "";
    const targetInfo = targetPath ? `: ${targetPath.split("/").pop() || targetPath.split("\\").pop() || targetPath}` : "";

    const reply = `✅ ${toolLabel}${targetInfo} 已完成\n\n${resultText.length > 2000 ? resultText.slice(0, 2000) + "\n...(结果已截断)" : resultText}`;

    console.log(`[PermissionHandler] approveAndExecute: tool "${pending.toolName}" executed successfully in ${duration}ms`);
    return { success: true, reply, toolName: pending.toolName };
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : String(err);
    console.warn(`[PermissionHandler] approveAndExecute: tool "${pending.toolName}" failed:`, errMsg);
    return { success: false, reply: `❌ 工具执行失败: ${errMsg}`, toolName: pending.toolName };
  }
}

/**
 * 权限拒绝快速通道：清理 pending 状态，返回拒绝确认
 */
export function rejectPermission(
  deps: PermissionHandlerDeps,
  requestId: string,
): { success: boolean; reply: string } {
  const pending = deps.pendingOperations.get(requestId);
  if (!pending) {
    return { success: false, reply: "⚠️ 未找到对应的权限请求。" };
  }
  deps.pendingOperations.delete(requestId);

  const permManager = deps.registry?.resolveService<any>("permissionManager");
  if (permManager) {
    try {
      permManager.denyRequest(requestId);
    } catch (err) {
      console.warn(`[PermissionHandler] rejectPermission: failed to deny in PermissionManager:`, err);
    }
  }

  console.log(`[PermissionHandler] rejectPermission: request "${requestId}" rejected`);
  return { success: true, reply: "❌ 操作已取消。" };
}
