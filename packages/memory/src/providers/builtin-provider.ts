/**
 * 内置 MemoryProvider — 基于 MemoryHub 的 FTS5/向量检索能力。
 *
 * 提供 memory_recall 和 memory_store 两个工具，systemPromptBlock 用
 * <memory> 标签包裹相关记忆，prefetch 调用 FTS5 预取。
 */
import type { MemoryHub } from "../memory-hub";
import type {
  MemoryProvider,
  MemoryProviderContext,
  ToolSchema,
  TurnData,
} from "../memory-provider";

/** memory_recall 工具的入参 schema。 */
const RECALL_SCHEMA: ToolSchema = {
  name: "memory_recall",
  description: "从长期记忆中检索与查询相关的记忆条目。",
  parameters: {
    type: "object",
    properties: {
      query: {
        type: "string",
        description: "检索查询文本",
      },
      limit: {
        type: "number",
        description: "最大返回条数，默认 5",
      },
    },
    required: ["query"],
  },
};

/** memory_store 工具的入参 schema。 */
const STORE_SCHEMA: ToolSchema = {
  name: "memory_store",
  description: "将一条记忆存储到长期记忆中。",
  parameters: {
    type: "object",
    properties: {
      content: {
        type: "string",
        description: "记忆内容文本",
      },
      type: {
        type: "string",
        description: "记忆类型",
        enum: ["conversation", "experience", "knowledge", "feedback", "system"],
      },
      tags: {
        type: "array",
        items: { type: "string" },
        description: "标签列表",
      },
    },
    required: ["content"],
  },
};

/**
 * 基于 MemoryHub 的内置记忆 provider。
 *
 * 使用现有 MemoryHub 的 FTS5 搜索、向量检索和长期记忆存储能力，
 * 无需外部依赖即可工作。
 */
export class BuiltinMemoryProvider implements MemoryProvider {
  readonly name = "builtin";
  private hub: MemoryHub | null = null;
  private ctx: MemoryProviderContext | null = null;
  /** prefetch 预取的相关记忆片段，供 systemPromptBlock 拼接。 */
  private prefetchedSnippet = "";

  constructor(hub: MemoryHub) {
    this.hub = hub;
  }

  async initialize(ctx: MemoryProviderContext): Promise<void> {
    this.ctx = ctx;
  }

  systemPromptBlock(): string {
    if (!this.prefetchedSnippet) return "";
    return `<memory>\n${this.prefetchedSnippet}\n</memory>`;
  }

  async prefetch(query: string): Promise<void> {
    if (!this.hub) return;
    const results = this.hub.searchFullText(query, 5);
    if (results.length === 0) {
      this.prefetchedSnippet = "";
      return;
    }
    const lines = results.map((r, i) => `${i + 1}. ${r.snippet || r.content}`);
    this.prefetchedSnippet = lines.join("\n");
  }

  async syncTurn(turnData: TurnData): Promise<void> {
    if (!this.hub || !this.ctx) return;
    const content = `User: ${turnData.userMessage}\nAssistant: ${turnData.assistantMessage}`;
    await this.hub.remember({
      type: "conversation",
      content,
      embedding: null,
      metadata: {
        source: "builtin-provider",
        sessionId: turnData.sessionId,
        userId: this.ctx.userId ?? "",
        tags: ["turn"],
        importance: 0.5,
        associations: [],
        entities: [],
      },
      ttl: 0,
    });
  }

  getToolSchemas(): ToolSchema[] {
    return [RECALL_SCHEMA, STORE_SCHEMA];
  }

  async handleToolCall(name: string, args: unknown): Promise<unknown> {
    if (!this.hub) {
      return { error: "MemoryHub not available" };
    }
    const params = (args ?? {}) as Record<string, unknown>;
    if (name === "memory_recall") {
      const query = String(params.query ?? "");
      const limit = typeof params.limit === "number" ? params.limit : 5;
      const results = await this.hub.recall({ query, limit });
      return results.map((r) => ({
        content: r.entry.content,
        score: r.score,
        type: r.entry.type,
        sessionId: r.entry.metadata.sessionId,
      }));
    }
    if (name === "memory_store") {
      const content = String(params.content ?? "");
      const type = (params.type as never) ?? "knowledge";
      const tags = Array.isArray(params.tags) ? (params.tags as string[]) : [];
      const entry = await this.hub.remember({
        type,
        content,
        embedding: null,
        metadata: {
          source: "builtin-provider",
          sessionId: this.ctx?.sessionId ?? "",
          userId: this.ctx?.userId ?? "",
          tags,
          importance: 0.5,
          associations: [],
          entities: [],
        },
        ttl: 0,
      });
      return { id: entry.id, stored: true };
    }
    return { error: `Unknown tool: ${name}` };
  }

  async shutdown(): Promise<void> {
    this.hub = null;
    this.ctx = null;
    this.prefetchedSnippet = "";
  }
}
