import type { AgentModelExecutor } from "@evoclaw/agent";

export function registerMemoryTools(executor: AgentModelExecutor): void {
  // memory_search: 语义搜索历史记忆
  executor.registerTool(
    "memory_search",
    {
      name: "memory_search",
      description: "Search conversation history and memory semantically. Use this to find past discussions, decisions, or context from previous sessions. Returns relevant memory entries with timestamps and relevance scores.",
      parameters: {
        query: { type: "string", description: "Search query (natural language)" },
        limit: { type: "string", description: "Max results (default: 10)" },
      },
    },
    async (params: Record<string, unknown>) => {
      const query = String(params.query || "");
      if (!query) return { success: false, error: "Query is required" };
      const limit = parseInt(String(params.limit || "10"), 10) || 10;

      // 通过 registry 获取 memoryHub
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
    },
  );

  // memory_stats: 显示记忆概览
  executor.registerTool(
    "memory_stats",
    {
      name: "memory_stats",
      description: "Get memory system statistics including layered memory counts (L0-L3), cache status, and storage info. Use this to show the user a summary of their stored memories.",
      parameters: {},
    },
    async (_params: Record<string, unknown>) => {
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
    },
  );
}
