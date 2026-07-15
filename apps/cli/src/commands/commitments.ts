/**
 * commitments — 管理 Agent 向用户作出的承诺（OpenClaw 兼容命令）
 *
 * 借鉴 openclaw 的 register.status-health-sessions.ts 注册逻辑：
 *   - commitments list           查询当前未完成承诺
 *   - commitments dismiss <ids>  丢弃指定承诺（支持多个 id）
 *
 * 承诺（Commitment）的生命周期：
 *   pending → in_progress → fulfilled | cancelled
 *
 * 本命令通过 Gateway API 查询与变更状态。若服务端未实现对应端点，
 * 会返回明确的错误提示，方便用户排查。
 */
import { Command } from "commander";
import { c, ICONS } from "../utils/colors";
import { apiRequest } from "../utils/api";
import {
  ensureServer,
  printError,
  printSuccess,
  printWarn,
  printInfo,
  printJson,
  printTable,
  formatTimestamp,
  confirmPrompt,
} from "../utils/shared";

// ──────────────────────────────────────────────────────────────────
// 类型定义（对齐 packages/agent/src/commitments.ts）
// ──────────────────────────────────────────────────────────────────

type CommitmentStatus = "pending" | "in_progress" | "fulfilled" | "cancelled";

interface Commitment {
  id: string;
  description: string;
  status: CommitmentStatus;
  sessionId?: string;
  agentId?: string;
  createdAt: number;
  updatedAt: number;
  deadline?: number;
  metadata?: Record<string, unknown>;
  tags?: string[];
}

interface ListResponse {
  commitments?: Commitment[];
  items?: Commitment[]; // 兼容 openclaw 字段名
}

interface DismissResponse {
  dismissed?: string[];
  failed?: Array<{ id: string; reason?: string }>;
  success?: boolean;
}

// ──────────────────────────────────────────────────────────────────
// 工具函数
// ──────────────────────────────────────────────────────────────────

/** 计算距离 deadline 的剩余时间，已过期返回 "overdue"。 */
function describeDeadline(deadline?: number): string {
  if (!deadline) return "—";
  const now = Date.now();
  const diff = deadline - now;
  if (diff <= 0) return c("red", "overdue");
  const hours = Math.floor(diff / 3_600_000);
  const days = Math.floor(hours / 24);
  if (days > 0) return `${days}d ${hours % 24}h`;
  if (hours > 0) return `${hours}h ${Math.floor((diff % 3_600_000) / 60_000)}m`;
  return `${Math.floor(diff / 60_000)}m`;
}

/** 状态着色 */
function colorStatus(status: CommitmentStatus): string {
  switch (status) {
    case "pending":
      return c("yellow", status);
    case "in_progress":
      return c("cyan", status);
    case "fulfilled":
      return c("green", status);
    case "cancelled":
      return c("gray", status);
    default:
      return status;
  }
}

/** 同时尝试 /api/commitments 与 /api/commitment/list 两个端点 */
async function fetchCommitments(
  filter: Record<string, unknown>,
): Promise<{ status: number; data: Commitment[] | null; endpoint: string }> {
  const endpoints = [
    { path: "/api/commitments", method: "GET", body: undefined },
    { path: "/api/commitment/list", method: "POST", body: filter },
  ];
  let lastErr: unknown = null;
  for (const ep of endpoints) {
    try {
      const r = await apiRequest<ListResponse>(ep.method, ep.path, ep.body);
      if (r.status >= 200 && r.status < 300) {
        const list = r.data?.commitments || r.data?.items || [];
        return { status: r.status, data: list, endpoint: ep.path };
      }
      // 非 2xx：尝试下一个
      lastErr = new Error(`HTTP ${r.status}`);
    } catch (err) {
      lastErr = err;
    }
  }
  if (lastErr instanceof Error) {
    process.stderr.write(c("gray", `  (last error: ${lastErr.message})\n`));
  }
  return { status: 0, data: null, endpoint: "" };
}

// ──────────────────────────────────────────────────────────────────
// 注册
// ──────────────────────────────────────────────────────────────────

export function register(
  program: Command,
  _shared: (c: Command) => Command,
  _apply: (o: Record<string, unknown>) => void,
): void {
  const commitments = program
    .command("commitments")
    .description("Manage commitments the agent has made to the user");

  // ── commitments list ─────────────────────────────────────────────
  commitments
    .command("list")
    .description("List commitments (default: active only)")
    .option("--status <status>", "Filter by status (pending|in_progress|fulfilled|cancelled|all)")
    .option("--session <id>", "Filter by session id")
    .option("--agent <id>", "Filter by agent id")
    .option("--overdue", "Only show overdue commitments")
    .option("--tag <tag>", "Filter by tag (repeatable)", (v: string, acc: string[]) => [...acc, v], [] as string[])
    .option("--limit <n>", "Limit number of results", "50")
    .option("--json", "Output as JSON")
    .action(async (opts: Record<string, unknown>) => {
      if (!(await ensureServer())) return;

      const statusFilter = String(opts.status || "active");
      const filter: Record<string, unknown> = {};
      if (statusFilter !== "all" && statusFilter !== "active") {
        filter.status = statusFilter;
      } else if (statusFilter === "active") {
        filter.status = ["pending", "in_progress"];
      }
      if (opts.session) filter.sessionId = String(opts.session);
      if (opts.agent) filter.agentId = String(opts.agent);
      if (opts.overdue) filter.overdue = true;
      if (Array.isArray(opts.tag) && opts.tag.length > 0) filter.tags = opts.tag;

      const limit = parseInt(String(opts.limit ?? "50"), 10);
      if (isNaN(limit) || limit < 1) {
        printError("Invalid --limit value");
        return;
      }

      const { data, endpoint } = await fetchCommitments(filter);
      if (data === null) {
        printError(
          "Failed to fetch commitments",
          "Gateway has no /api/commitments or /api/commitment/list endpoint. Verify server version supports commitments.",
        );
        return;
      }

      let list = data;
      // 客户端再次过滤 active（兼容服务端不支持 status 数组的场景）
      if (statusFilter === "active") {
        list = list.filter((c) => c.status === "pending" || c.status === "in_progress");
      }
      // 截断
      list = list.slice(0, limit);

      if (opts.json) {
        printJson({ count: list.length, commitments: list, endpoint });
        return;
      }

      console.log();
      console.log(c("bold", `${ICONS.rock}  Commitments (${list.length})\n`));

      if (list.length === 0) {
        console.log(c("gray", "  No commitments match the filter."));
        console.log();
        return;
      }

      const rows: string[][] = list.map((c) => [
        c.id,
        colorStatus(c.status),
        describeDeadline(c.deadline),
        (c.description || "").slice(0, 50),
        c.agentId || "—",
        formatTimestamp(c.createdAt),
      ]);

      printTable(
        [
          { header: "ID", width: 22 },
          { header: "Status", width: 14 },
          { header: "Deadline", width: 12 },
          { header: "Description", width: 50 },
          { header: "Agent", width: 14 },
          { header: "Created", width: 20 },
        ],
        rows,
      );

      // 过期承诺汇总
      const overdue = list.filter(
        (c) => c.deadline && c.deadline < Date.now() && c.status !== "fulfilled" && c.status !== "cancelled",
      );
      if (overdue.length > 0) {
        console.log();
        printWarn(`${overdue.length} overdue commitment(s) detected.`);
      }
      console.log();
    });

  // ── commitments dismiss <ids...> ─────────────────────────────────
  commitments
    .command("dismiss <ids...>")
    .description("Dismiss (cancel) one or more commitments by id")
    .option("--reason <text>", "Reason for dismissal")
    .option("--force", "Skip confirmation prompt")
    .option("--json", "Output as JSON")
    .action(async (ids: string[], opts: Record<string, unknown>) => {
      if (!(await ensureServer())) return;
      if (!Array.isArray(ids) || ids.length === 0) {
        printError("No commitment ids provided");
        return;
      }

      // 去重
      const uniqueIds = Array.from(new Set(ids));
      if (uniqueIds.length > 1 && !opts.force) {
        const ok = await confirmPrompt(
          `Dismiss ${uniqueIds.length} commitments (${uniqueIds.slice(0, 3).join(", ")}${uniqueIds.length > 3 ? "..." : ""})?`,
          false,
        );
        if (!ok) {
          printInfo("Dismissal cancelled.");
          return;
        }
      }

      const reason = opts.reason ? String(opts.reason) : undefined;
      const dismissed: string[] = [];
      const failed: Array<{ id: string; reason?: string }> = [];

      // 逐个调用 POST /api/commitments/:id/dismiss（后端由 CommitmentManager.cancel 支撑）
      for (const id of uniqueIds) {
        try {
          const r = await apiRequest<DismissResponse>(
            "POST",
            `/api/commitments/${encodeURIComponent(id)}/dismiss`,
            { reason },
          );
          if (r.status >= 200 && r.status < 300 && r.data?.success !== false) {
            const rDismissed = r.data?.dismissed ?? [];
            dismissed.push(...(rDismissed.length > 0 ? rDismissed : [id]));
            failed.push(...(r.data?.failed ?? []));
          } else {
            const fr = r.data?.failed?.[0]?.reason || `HTTP ${r.status}`;
            failed.push({ id, reason: fr });
          }
        } catch (err) {
          failed.push({ id, reason: err instanceof Error ? err.message : String(err) });
        }
      }

      if (opts.json) {
        printJson({ success: true, dismissed, failed });
        return;
      }

      if (dismissed.length > 0) {
        printSuccess(`Dismissed ${dismissed.length} commitment(s):`);
        for (const id of dismissed) console.log(`  ${ICONS.bullet()} ${c("cyan", id)}`);
      }
      if (failed.length > 0) {
        printWarn(`${failed.length} commitment(s) could not be dismissed:`);
        for (const f of failed) {
          console.log(`  ${ICONS.error()} ${c("cyan", f.id)} ${c("gray", f.reason || "unknown reason")}`);
        }
      }
      if (dismissed.length === 0 && failed.length === 0) {
        printWarn("Server acknowledged request but reported no changes.");
      }
    });

  // ── commitments show <id> ────────────────────────────────────────
  commitments
    .command("show <id>")
    .description("Show detailed information about a single commitment")
    .option("--json", "Output as JSON")
    .action(async (id: string, opts: Record<string, unknown>) => {
      if (!(await ensureServer())) return;
      const endpoints = [
        { path: `/api/commitments/${encodeURIComponent(id)}`, method: "GET" },
        { path: `/api/commitment/get`, method: "POST" },
      ];
      let found: Commitment | null = null;
      for (const ep of endpoints) {
        try {
          const body = ep.method === "POST" ? { id } : undefined;
          const r = await apiRequest<Commitment | { commitment: Commitment }>(ep.method, ep.path, body);
          if (r.status >= 200 && r.status < 300) {
            if (r.data && typeof r.data === "object") {
              if ("id" in (r.data as Record<string, unknown>)) {
                found = r.data as Commitment;
              } else if ("commitment" in (r.data as Record<string, unknown>)) {
                found = (r.data as { commitment: Commitment }).commitment;
              }
            }
            if (found) break;
          }
        } catch {
          // 尝试下一个端点
        }
      }

      if (!found) {
        printError(`Commitment ${id} not found`, "Gateway has no commitments detail endpoint or id is invalid.");
        return;
      }

      if (opts.json) {
        printJson(found);
        return;
      }

      console.log();
      console.log(c("bold", `${ICONS.rock}  Commitment ${found.id}\n`));
      console.log(`  Status:      ${colorStatus(found.status)}`);
      console.log(`  Description: ${found.description}`);
      console.log(`  Created:     ${formatTimestamp(found.createdAt)}`);
      console.log(`  Updated:     ${formatTimestamp(found.updatedAt)}`);
      console.log(`  Deadline:    ${found.deadline ? formatTimestamp(found.deadline) : "—"}`);
      if (found.sessionId) console.log(`  Session:     ${c("cyan", found.sessionId)}`);
      if (found.agentId) console.log(`  Agent:       ${c("cyan", found.agentId)}`);
      if (found.tags && found.tags.length > 0) {
        console.log(`  Tags:        ${found.tags.map((t) => c("gray", t)).join(", ")}`);
      }
      if (found.metadata && Object.keys(found.metadata).length > 0) {
        console.log(`  Metadata:    ${JSON.stringify(found.metadata)}`);
      }
      console.log();
    });

  // ── commitments summary ──────────────────────────────────────────
  commitments
    .command("summary")
    .description("Show a summary of active commitments grouped by status")
    .option("--session <id>", "Filter by session id")
    .option("--json", "Output as JSON")
    .action(async (opts: Record<string, unknown>) => {
      if (!(await ensureServer())) return;
      const filter: Record<string, unknown> = { status: ["pending", "in_progress"] };
      if (opts.session) filter.sessionId = String(opts.session);

      const { data } = await fetchCommitments(filter);
      if (data === null) {
        printError(
          "Failed to fetch commitments",
          "Gateway has no commitments endpoint. Verify server version.",
        );
        return;
      }

      const pending = data.filter((c) => c.status === "pending");
      const inProgress = data.filter((c) => c.status === "in_progress");
      const overdue = data.filter(
        (c) => c.deadline && c.deadline < Date.now(),
      );

      if (opts.json) {
        printJson({
          total: data.length,
          pending: pending.length,
          inProgress: inProgress.length,
          overdue: overdue.length,
        });
        return;
      }

      console.log();
      console.log(c("bold", `${ICONS.rock}  Commitments Summary\n`));
      console.log(`  ${c("yellow", "Pending")}:       ${pending.length}`);
      console.log(`  ${c("cyan", "In Progress")}:  ${inProgress.length}`);
      console.log(`  ${c("red", "Overdue")}:      ${overdue.length}`);
      console.log(`  ${c("bold", "Total active")}: ${data.length}`);
      console.log();
    });
}
