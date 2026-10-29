import type { AgentModelExecutor } from "@evoclaw/agent";
import type { SessionManager } from "@evoclaw/agent";
import { SessionSearch, type SessionInfoProvider, type SessionInfoLike, type SessionTurnLike } from "@evoclaw/memory";

/**
 * Session Search Tools — 会话搜索复合工具
 *
 * 对标 Hermes `tools/session_search_tool.py`：
 *   - action=discover: FTS5 全文搜索定位会话，合并 lineage，附加 ±N 消息窗口
 *   - action=scroll:   以指定消息为锚点，返回会话内的消息窗口
 *   - action=browse:   按时间倒序列出最近会话（跳过 subagent/tool 来源）
 *
 * FTS5 引擎与 SessionSearch 类均已实现（packages/memory/src/session-search.ts），
 * 此前无工具面暴露（VERIFY-FAIL 修复）。
 */
export function registerSessionSearchTools(executor: AgentModelExecutor): void {
  // ── 构造 SessionInfoProvider（包装 SessionManager）───────────
  const buildProvider = (): SessionInfoProvider | null => {
    const registry = (executor as any).registry;
    if (!registry) return null;
    const sessionManager = registry.resolveService("sessionManager") as SessionManager | null;
    if (!sessionManager) return null;

    const defaultAgentId = "default";
    return {
      getSessionInfo(sessionId: string): SessionInfoLike | null {
        try {
          const sessions = sessionManager.listSessions(defaultAgentId);
          return sessions.find((s) => s.sessionId === sessionId) ?? null;
        } catch {
          return null;
        }
      },
      loadTranscript(sessionId: string): SessionTurnLike[] {
        try {
          return sessionManager.loadTranscript(defaultAgentId, sessionId) as unknown as SessionTurnLike[];
        } catch {
          return [];
        }
      },
      listSessions(): SessionInfoLike[] {
        try {
          return sessionManager.listSessions(defaultAgentId) as unknown as SessionInfoLike[];
        } catch {
          return [];
        }
      },
    };
  };

  // ── action=discover：FTS5 搜索定位会话 ───────────────────────
  const handleDiscover = async (params: Record<string, unknown>, search: SessionSearch) => {
    const query = String(params.query || "");
    if (!query) return { success: false, error: "query is required (action=discover)" };
    const limit = Math.max(1, Math.min(parseInt(String(params.limit ?? "10"), 10) || 10, 50));

    try {
      const results = await search.discover(query, limit);
      return { success: true, query, results: results || [], count: results?.length || 0 };
    } catch (err: any) {
      return { success: false, error: `Session search failed: ${err?.message || String(err)}` };
    }
  };

  // ── action=scroll：以锚点消息滚动浏览 ─────────────────────────
  const handleScroll = async (params: Record<string, unknown>, search: SessionSearch) => {
    const sessionId = String(params.session_id || "");
    const aroundMessageId = String(params.around_message_id || "");
    if (!sessionId) return { success: false, error: "session_id is required (action=scroll)" };
    if (!aroundMessageId) return { success: false, error: "around_message_id is required (action=scroll)" };
    const window = Math.max(0, Math.min(parseInt(String(params.window ?? "5"), 10) || 5, 20));

    try {
      const result = await search.scroll(sessionId, aroundMessageId, window);
      return { success: true, result };
    } catch (err: any) {
      return { success: false, error: `Session scroll failed: ${err?.message || String(err)}` };
    }
  };

  // ── action=browse：列出最近会话 ───────────────────────────────
  const handleBrowse = async (params: Record<string, unknown>, search: SessionSearch) => {
    const limit = Math.max(1, Math.min(parseInt(String(params.limit ?? "20"), 10) || 20, 100));

    try {
      const results = await search.browse(limit);
      return { success: true, results: results || [], count: results?.length || 0 };
    } catch (err: any) {
      return { success: false, error: `Session browse failed: ${err?.message || String(err)}` };
    }
  };

  executor.registerTool(
    "session_search",
    {
      name: "session_search",
      description:
        "Search across past conversation sessions. " +
        "action=discover: full-text search to locate sessions, with lineage merging and message windows; " +
        "action=scroll: return a message window around a specific anchor message in a session; " +
        "action=browse: list recent sessions by time (excludes subagent/tool internal sessions).",
      parameters: {
        action: {
          type: "string",
          description: "session_search 操作类型",
          required: true,
          enum: ["discover", "scroll", "browse"],
        },
        // discover 参数
        query: { type: "string", description: "Search query（action=discover 使用）", required: false },
        limit: { type: "string", description: "Max results（discover 默认 10，browse 默认 20）", required: false },
        // scroll 参数
        session_id: { type: "string", description: "Target session ID（action=scroll 使用）", required: false },
        around_message_id: { type: "string", description: "Anchor message ID（action=scroll 使用）", required: false },
        window: { type: "string", description: "Messages before/after anchor (default: 5, max: 20)（action=scroll 使用）", required: false },
      },
    },
    async (params: Record<string, unknown>) => {
      const action = String(params.action || "discover");

      // 构造 SessionSearch（每次调用构造，FTS5 引擎来自 memoryHub）
      const registry = (executor as any).registry;
      if (!registry) return { success: false, error: "Service registry not available" };
      const memoryHub = registry.resolveService("memoryHub");
      if (!memoryHub) return { success: false, error: "Memory service not available" };
      const fts = memoryHub.getFTS5?.();
      if (!fts) return { success: false, error: "FTS5 search engine not available" };

      const provider = buildProvider();
      const search = new SessionSearch(fts, provider);

      switch (action) {
        case "discover": return await handleDiscover(params, search);
        case "scroll": return await handleScroll(params, search);
        case "browse": return await handleBrowse(params, search);
        default:
          return { success: false, error: `未知 session_search action: ${action}（仅支持 discover / scroll / browse）` };
      }
    },
  );
}
