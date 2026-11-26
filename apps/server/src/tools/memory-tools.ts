import type { AgentModelExecutor } from "@evoclaw/agent";
import type { MemoryEntry } from "@evoclaw/core";
import { findUniqueMemoryMatch, countOccurrences } from "@evoclaw/memory";

/**
 * Memory Tools — 记忆系统复合工具
 *
 * 对标 Hermes `tools/memory_tool.py`：
 *   - action=add:    写入新记忆条目（remember）
 *   - action=patch:  唯一匹配 old_string 后原地替换为 new_string（保留 id/ttl）
 *   - action=remove: 按 id 或唯一内容匹配删除（歧义返回候选，不静默命中第一条）
 *   - action=search: 语义搜索历史记忆
 *   - action=stats:  显示记忆概览
 *
 * 原 memory_search / memory_stats 合并为单一复合工具 `memory`，
 * 通过 `action` 判别字段分发。v0.75 扩展 add/patch/remove ——
 * 此前 agent 只能搜索记忆，无法自主写入或编辑（VERIFY-FAIL 修复）。
 */
export function registerMemoryTools(executor: AgentModelExecutor): void {
  // ── 内部辅助：获取 memoryHub + longTerm ─────────────────────
  const getMemoryServices = (executor: AgentModelExecutor) => {
    // AgentModelExecutor 接口未公开 registry 属性，此处用 as any 访问其内部字段。
    // 修改 AgentModelExecutor 接口需同步调整所有实现与调用方，风险较高，暂保持现状。
    const registry = (executor as any).registry;
    if (!registry) return { memoryHub: null, longTerm: null };
    const memoryHub = registry.resolveService("memoryHub");
    if (!memoryHub) return { memoryHub: null, longTerm: null };
    return { memoryHub, longTerm: memoryHub.getLongTerm() };
  };

  // ── action=search：语义搜索历史记忆 ─────────────────────────
  const handleSearch = async (params: Record<string, unknown>) => {
    const query = String(params.query || "");
    if (!query) return { success: false, error: "Query is required" };
    const limit = Math.max(1, Math.min(parseInt(String(params.limit ?? "10"), 10) || 10, 100));

    const { memoryHub } = getMemoryServices(executor);
    if (!memoryHub) return { success: false, error: "Memory service not available" };

    try {
      const results = await memoryHub.semanticSearch(query, limit);
      return { success: true, query, results: results || [], count: results?.length || 0 };
    } catch (err: any) {
      return { success: false, error: `Memory search failed: ${err?.message || String(err)}` };
    }
  };

  // ── action=stats：显示记忆概览 ──────────────────────────────
  const handleStats = async (_params: Record<string, unknown>) => {
    const { memoryHub } = getMemoryServices(executor);
    if (!memoryHub) return { success: false, error: "Memory service not available" };

    try {
      const stats = await memoryHub.getLayeredStats?.() || {};
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

  // ── action=add：写入新记忆条目 ──────────────────────────────
  // 对标 Hermes memory_tool.py _STORE_ACTIONS["add"]
  const handleAdd = async (params: Record<string, unknown>) => {
    const content = String(params.content || "");
    if (!content) return { success: false, error: "content is required (action=add)" };

    const type = String(params.type || "conversation") as MemoryEntry["type"];
    const validTypes: MemoryEntry["type"][] = [
      "conversation", "experience", "knowledge", "feedback", "system",
      "episodic", "semantic", "procedural",
    ];
    if (!validTypes.includes(type)) {
      return { success: false, error: `Invalid type "${type}". Must be one of: ${validTypes.join(", ")}` };
    }

    const tags = String(params.tags || "")
      .split(",")
      .map((t) => t.trim())
      .filter(Boolean);
    const importance = Math.max(0, Math.min(parseFloat(String(params.importance ?? "0.5")) || 0.5, 1.0));

    const { memoryHub } = getMemoryServices(executor);
    if (!memoryHub) return { success: false, error: "Memory service not available" };

    try {
      const entry = await memoryHub.remember({
        type,
        content,
        metadata: {
          source: "agent",
          sessionId: "unknown",
          userId: "unknown",
          tags,
          importance,
          associations: [],
          entities: [],
        },
        ttl: 0,
      });
      return {
        success: true,
        message: `Memory entry added (id: ${entry.id}, type: ${entry.type})`,
        id: entry.id,
        type: entry.type,
        content: entry.content.slice(0, 200),
      };
    } catch (err: any) {
      return { success: false, error: `Memory add failed: ${err?.message || String(err)}` };
    }
  };

  // ── action=patch：查找并替换记忆内容 ─────────────────────────
  // 对标 Hermes memory_tool_store.py 的唯一匹配 + 原地更新语义：
  //   - id 优先；否则整条精确匹配 > 子串匹配，歧义必须报候选；
  //   - old_string 在目标条目内必须恰好出现一次；
  //   - 原地更新（MemoryHub.updateMemoryContent），不新建 id、不丢 ttl。
  const handlePatch = async (params: Record<string, unknown>) => {
    const id = String(params.id || "").trim();
    const oldString = String(params.old_string || "");
    const newString = String(params.new_string || "");
    if (!oldString) return { success: false, error: "old_string is required (action=patch)" };
    if (!newString) return { success: false, error: "new_string is required (action=patch)" };
    if (oldString === newString) {
      return { success: false, error: "new_string equals old_string (no-op patch rejected)" };
    }

    const { memoryHub, longTerm } = getMemoryServices(executor);
    if (!memoryHub || !longTerm) return { success: false, error: "Memory service not available" };

    try {
      let target: MemoryEntry | undefined;
      if (id) {
        const found = await longTerm.get(id);
        if (!found) {
          return { success: false, error: `No memory entry with id "${id}"`, id };
        }
        target = found;
      } else {
        const all = (await longTerm.getAll()) as MemoryEntry[];
        const outcome = findUniqueMemoryMatch(all, oldString);
        if (outcome.status === "not_found") {
          return {
            success: false,
            error: "No memory entry found containing the specified old_string",
            nearest: outcome.nearest,
          };
        }
        if (outcome.status === "ambiguous") {
          return {
            success: false,
            error: `old_string matches ${outcome.candidates.length} memory entries; pass id or a more specific old_string`,
            candidates: outcome.candidates,
          };
        }
        target = outcome.entry;
      }
      // 显式守卫：后续 await 会重置 TS 对 let 变量的窄化
      if (!target) return { success: false, error: "No memory entry resolved for patch" };
      const targetEntry: MemoryEntry = target;

      const occurrences = countOccurrences(targetEntry.content, oldString);
      if (occurrences === 0) {
        return { success: false, error: `old_string not found in memory entry "${targetEntry.id}"`, id: targetEntry.id };
      }
      if (occurrences > 1) {
        return {
          success: false,
          error: `old_string appears ${occurrences} times in memory entry "${targetEntry.id}"; make it unique before patching`,
          id: targetEntry.id,
        };
      }

      const updatedContent = targetEntry.content.replace(oldString, newString);
      const updated = await memoryHub.updateMemoryContent(targetEntry.id, updatedContent);
      if (!updated) {
        return { success: false, error: `Memory entry "${targetEntry.id}" disappeared before update`, id: targetEntry.id };
      }

      return {
        success: true,
        message: `Memory entry patched (id: ${targetEntry.id})`,
        id: targetEntry.id,
        content: updatedContent.slice(0, 200),
      };
    } catch (err: any) {
      return { success: false, error: `Memory patch failed: ${err?.message || String(err)}` };
    }
  };

  // ── action=remove：删除记忆条目 ──────────────────────────────
  // 对标 Hermes memory_tool_store.py：删除必须命中唯一目标，不存在返回 not_found，
  // 不再对不存在的 id 静默成功。
  const handleRemove = async (params: Record<string, unknown>) => {
    const id = String(params.id || "").trim();
    const oldString = String(params.old_string || "").trim();
    if (!id && !oldString) {
      return { success: false, error: "Either id or old_string is required (action=remove)" };
    }

    const { memoryHub, longTerm } = getMemoryServices(executor);
    if (!memoryHub || !longTerm) return { success: false, error: "Memory service not available" };

    try {
      let targetId = id;
      if (targetId) {
        const existing = await longTerm.get(targetId);
        if (!existing) {
          return { success: false, error: `No memory entry with id "${targetId}"`, id: targetId };
        }
      } else {
        const all = (await longTerm.getAll()) as MemoryEntry[];
        const outcome = findUniqueMemoryMatch(all, oldString);
        if (outcome.status === "not_found") {
          return {
            success: false,
            error: "No memory entry found containing the specified old_string",
            nearest: outcome.nearest,
          };
        }
        if (outcome.status === "ambiguous") {
          return {
            success: false,
            error: `old_string matches ${outcome.candidates.length} memory entries; pass id or a more specific old_string`,
            candidates: outcome.candidates,
          };
        }
        targetId = outcome.entry.id;
      }

      await longTerm.delete(targetId);
      // longTerm.delete 触发 onEntriesRemoved → forgetMemory（FTS5/向量索引清理）

      return {
        success: true,
        message: `Memory entry removed (id: ${targetId})`,
        id: targetId,
      };
    } catch (err: any) {
      return { success: false, error: `Memory remove failed: ${err?.message || String(err)}` };
    }
  };

  executor.registerTool(
    "memory",
    {
      name: "memory",
      description:
        "Memory system operations. " +
        "action=add: store a new memory entry (content, type, tags, importance); " +
        "action=patch: replace old_string with new_string in the entry that uniquely matches (pass id to disambiguate; old_string must occur exactly once); " +
        "action=remove: delete an entry by id or by a unique content match (ambiguous matches return candidates); " +
        "action=search: search conversation history and memory semantically; " +
        "action=stats: get memory system statistics.",
      parameters: {
        action: {
          type: "string",
          description: "memory 操作类型",
          required: false, default: "search",
          enum: ["add", "patch", "remove", "search", "stats"],
        },
        // action=add 参数
        content: { type: "string", description: "Memory content to store（action=add 使用）", required: false },
        type: { type: "string", description: "Memory type: conversation/experience/knowledge/feedback/system（action=add 使用，默认 conversation）", required: false },
        tags: { type: "string", description: "Comma-separated tags（action=add 使用）", required: false },
        importance: { type: "string", description: "Importance score 0.0-1.0（action=add 使用，默认 0.5）", required: false },
        // action=patch / action=remove 定位参数
        old_string: { type: "string", description: "Text to find in existing memory（action=patch / action=remove 使用；必须唯一命中）", required: false },
        new_string: { type: "string", description: "Replacement text（action=patch 使用）", required: false },
        // action=search 参数
        query: { type: "string", description: "Search query (natural language)（action=search 使用）", required: false },
        limit: { type: "string", description: "Max results (default: 10)（action=search 使用）", required: false },
        // action=remove 参数
        id: { type: "string", description: "Memory entry id（action=patch / action=remove 使用，用于精确指定目标）", required: false },
      },
    },
    async (params: Record<string, unknown>) => {
      const action = String(params.action || "search");
      switch (action) {
        case "add": return await handleAdd(params);
        case "patch": return await handlePatch(params);
        case "remove": return await handleRemove(params);
        case "search": return await handleSearch(params);
        case "stats": return await handleStats(params);
        default:
          return { success: false, error: `未知 memory action: ${action}（仅支持 add / patch / remove / search / stats）` };
      }
    },
  );
}
