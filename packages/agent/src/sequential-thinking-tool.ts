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
        nextThoughtNeeded: { type: "boolean", description: "Whether another thought step is needed", required: true },
        thoughtNumber: { type: "number", description: "Current thought number (e.g. 1, 2, 3)", required: true },
        totalThoughts: { type: "number", description: "Estimated total thoughts needed (e.g. 5, 10)", required: true },
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
      const thoughtNumber = args.thoughtNumber as number;
      const totalThoughts = args.totalThoughts as number;
      const nextThoughtNeeded = args.nextThoughtNeeded as boolean;
      const isRevision = args.isRevision as boolean | undefined;
      const revisesThought = args.revisesThought as number | undefined;
      const branchFromThought = args.branchFromThought as number | undefined;
      const branchId = args.branchId as string | undefined;
      const needsMoreThoughts = args.needsMoreThoughts as boolean | undefined;

      // Adjust totalThoughts if thoughtNumber exceeds it
      const adjustedTotal = Math.max(totalThoughts, thoughtNumber + (needsMoreThoughts ? 1 : 0));

      // Store in history
      const history = thinkingHistory.get(sessionId) || [];
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
