import type { AgentModelExecutor } from "@evoclaw/agent";

/**
 * Memory Tools — 记忆系统复合工具
 *
 * 原 memory_search / memory_stats 合并为单一复合工具 `memory`，
 * 通过 `action` 判别字段分发。
 */
export function registerMemoryTools(executor: AgentModelExecutor): void {
  // ── action=search（原 memory_search）：语义搜索历史记忆 ────────
  const handleSearch = async (params: Record<string, unknown>) => {
    const query = String(params.query || "");
    if (!query) return { success: false, error: "Query is required" };
    const limit = Math.max(1, Math.min(parseInt(String(params.limit ?? "10"), 10) || 10, 100));

    // 通过 registry 获取 memoryHub
    // AgentModelExecutor 接口未公开 registry 属性，此处用 as any 访问其内部字段。
    // 修改 AgentModelExecutor 接口需同步调整所有实现与调用方，风险较高，暂保持现状。
    const registry = (executor as any).registry;
    if (!registry) return { success: false, error: "Service registry not available" };
    const memoryHub = registry.resolveService("memoryHub");
    if (!memoryHub) return { success: false, error: "Memory service not available" };

    try {
      const results = await memoryHub.semanticSearch(query, limit);
      return { success: true, query, results: results || [], count: results?.length || 0 };
    } catch (err: any) {
      return { success: false, error: `Memory search failed: ${err?.message || String(err)}` };
    }
  };

  // ── action=stats（原 memory_stats）：显示记忆概览 ───────────────
  const handleStats = async (_params: Record<string, unknown>) => {
    // 同 memory_search：AgentModelExecutor 未公开 registry，用 as any 访问
    const registry = (executor as any).registry;
    if (!registry) return { success: false, error: "Service registry not available" };
    const memoryHub = registry.resolveService("memoryHub");
    if (!memoryHub) return { success: false, error: "Memory service not available" };

    try {
      const stats = await memoryHub.getLayeredStats?.() || {};
      // ShortTermMemory 接口没有 .size 属性，使用 keys() 方法获取条目数
      let shortTermCount = 0;
      try {
        const keys = await memoryHub.getShortTerm?.()?.keys("*");
        shortTermCount = Array.isArray(keys) ? keys.length : 0;
      } catch {
        // keys() 可能不支持，回退为 0
      }
      return {
        success: true,
        shortTermEntries: shortTermCount,
        layeredStats: stats,
      };
    } catch (err: any) {
      return { success: false, error: `Memory stats failed: ${err?.message || String(err)}` };
    }
  };

  executor.registerTool(
    "memory",
    {
      name: "memory",
      description:
        "Memory system operations. " +
        "action=search: search conversation history and memory semantically; " +
        "action=stats: get memory system statistics including layered memory counts (L0-L3), cache status, and storage info.",
      parameters: {
        action: { type: "string", description: "memory 操作类型", required: true, enum: ["search", "stats"] },
        query: { type: "string", description: "Search query (natural language)（action=search 使用）", required: false },
        limit: { type: "string", description: "Max results (default: 10)（action=search 使用）", required: false },
      },
    },
    async (params: Record<string, unknown>) => {
      const action = String(params.action || "search");
      if (action === "search") return await handleSearch(params);
      if (action === "stats") return await handleStats(params);
      return { success: false, error: `未知 memory action: ${action}（仅支持 search / stats）` };
    },
  );
}
