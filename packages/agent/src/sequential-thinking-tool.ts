import type { ToolDefinition } from "./types";

export interface ThinkingHistoryEntry {
  thoughtNumber: number;
  thought: string;
  isRevision?: boolean;
  revisesThought?: number;
  branchFromThought?: number;
  branchId?: string;
}

export type ThinkingHistoryMap = Map<string, ThinkingHistoryEntry[]>;

export function registerSequentialThinkingTool(
  executor: {
    registerTool: (
      name: string,
      def: ToolDefinition,
      handler: (params: Record<string, unknown>) => Promise<unknown>
    ) => void;
  },
  thinkingHistory: ThinkingHistoryMap
): void {
  executor.registerTool(
    "sequential_thinking",
    {
      name: "sequential_thinking",
      description: `A detailed tool for dynamic and reflective problem-solving through sequential thoughts.
Use this tool to break down complex problems into structured thinking steps.
Each thought can build on, question, or revise previous insights as understanding deepens.

When to use this tool:
- Breaking down complex problems into steps
- Planning and design with room for revision
- Analysis that might need course correction
- Problems where the full scope might not be clear initially
- Multi-step problems requiring context maintenance

Key features:
- Adjust total_thoughts up or down as you progress
- Question or revise previous thoughts (isRevision=true, revisesThought=N)
- Branch into alternative approaches (branchFromThought=N, branchId="...")
- Generate and verify hypotheses
- Express uncertainty and explore alternatives

Parameters:
- thought: Your current thinking step content
- nextThoughtNeeded: Whether another thought step is needed
- thoughtNumber: Current thought number in sequence
- totalThoughts: Estimated total thoughts needed (adjustable)
- isRevision: Whether this revises previous thinking
- revisesThought: Which thought number is being reconsidered
- branchFromThought: Branching point thought number
- branchId: Identifier for the current branch
- needsMoreThoughts: If more thoughts are needed beyond initial estimate`,
      parameters: {
        thought: { type: "string", description: "Your current thinking step", required: true },
        // ★ 2026-11-26 取证：nextThoughtNeeded / thoughtNumber / totalThoughts 此前
        //   声明 required:true，而 llm-caller 会**丢弃本工具的返回值**（只回一句
        //   「思考步骤已记录」），三者对行为零影响——纯记账。历史上 3 次
        //   `Missing required parameter "nextThoughtNeeded"` 让整条调用报废。
        //   改为可选 + 处理器内给确定性回退，缺字段不再失败。
        nextThoughtNeeded: { type: "boolean", description: "Whether another thought step is needed（可选，默认 false）", required: false, default: false },
        thoughtNumber: { type: "number", description: "Current thought number (e.g. 1, 2, 3)（可选，默认按已记录条数递增）", required: false },
        totalThoughts: { type: "number", description: "Estimated total thoughts needed (e.g. 5, 10)（可选，默认同 thoughtNumber）", required: false },
        isRevision: { type: "boolean", description: "Whether this revises previous thinking", required: false },
        revisesThought: { type: "number", description: "Which thought is being reconsidered", required: false },
        branchFromThought: { type: "number", description: "Branching point thought number", required: false },
        branchId: { type: "string", description: "Branch identifier", required: false },
        needsMoreThoughts: { type: "boolean", description: "If more thoughts are needed beyond initial estimate", required: false },
      },
    },
    async (args: Record<string, unknown>) => {
      const sessionId = (args._sessionId as string) || "default";
      const thought = args.thought as string;
      // 三个数字/布尔字段可选（见 schema 注释）：缺省时用已记录条数推导，
      // 保证「只给 thought」的调用也能落一条结构完整的思考记录。
      const history = thinkingHistory.get(sessionId) || [];
      const thoughtNumber =
        typeof args.thoughtNumber === "number" && Number.isFinite(args.thoughtNumber)
          ? args.thoughtNumber
          : history.length + 1;
      const totalThoughts =
        typeof args.totalThoughts === "number" && Number.isFinite(args.totalThoughts)
          ? args.totalThoughts
          : thoughtNumber;
      const nextThoughtNeeded = args.nextThoughtNeeded === true;
      const isRevision = args.isRevision as boolean | undefined;
      const revisesThought = args.revisesThought as number | undefined;
      const branchFromThought = args.branchFromThought as number | undefined;
      const branchId = args.branchId as string | undefined;
      const needsMoreThoughts = args.needsMoreThoughts as boolean | undefined;

      // Adjust totalThoughts if thoughtNumber exceeds it
      const adjustedTotal = Math.max(totalThoughts, thoughtNumber + (needsMoreThoughts ? 1 : 0));

      // Store in history
      history.push({
        thoughtNumber,
        thought,
        isRevision,
        revisesThought,
        branchFromThought,
        branchId,
      });
      thinkingHistory.set(sessionId, history);

      // Build context from previous thoughts
      let contextStr = "";
      if (history.length > 1) {
        const recentHistory = history.slice(-5); // Last 5 thoughts for context
        contextStr = "\n\nPrevious thoughts context:\n" + recentHistory.map(h =>
          `  ${h.isRevision ? "🔄" : h.branchFromThought ? "🌿" : "💭"} Thought ${h.thoughtNumber}: ${h.thought.slice(0, 200)}${h.thought.length > 200 ? "..." : ""}`
        ).join("\n");
      }

      const result = {
        thoughtNumber,
        totalThoughts: adjustedTotal,
        nextThoughtNeeded,
        isRevision: isRevision || false,
        revisesThought,
        branchFromThought,
        branchId,
        needsMoreThoughts,
        thoughtHistoryLength: history.length,
        message: nextThoughtNeeded
          ? `Thought ${thoughtNumber}/${adjustedTotal} recorded. Continue with next thought.`
          : `Thinking complete. ${history.length} thoughts recorded. You now have a structured analysis to inform your response.`,
      };

      return JSON.stringify(result) + contextStr;
    }
  );
}
