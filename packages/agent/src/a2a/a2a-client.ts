import type { A2AAgentCard, A2ATask, A2ATaskResult, A2AClientConfig } from "./types";

export class A2AClient {
  private config: A2AClientConfig;
  private knownAgents = new Map<string, A2AAgentCard>();

  constructor(config?: Partial<A2AClientConfig>) {
    this.config = {
      timeout: config?.timeout ?? 30000,
      maxRetries: config?.maxRetries ?? 2,
      apiKeys: config?.apiKeys ?? {},
    };
  }

  /** Register a known agent */
  registerAgent(card: A2AAgentCard): void {
    this.knownAgents.set(card.name, card);
  }

  /** Discover an agent's capabilities by fetching its agent card */
  async discoverAgent(url: string): Promise<A2AAgentCard> {
    const response = await fetch(`${url.replace(/\/+$/, "")}/a2a/card`);
    if (!response.ok) throw new Error(`Failed to discover agent at ${url}: ${response.statusText}`);
    const card = await response.json() as A2AAgentCard;
    this.knownAgents.set(card.name, card);
    return card;
  }

  /** Send a task to a remote agent */
  async sendTask(agentName: string, task: Omit<A2ATask, "id">): Promise<A2ATaskResult> {
    const agent = this.knownAgents.get(agentName);
    if (!agent) throw new Error(`Unknown agent: ${agentName}`);

    const fullTask: A2ATask = { ...task, id: `task-${Date.now()}-${Math.random().toString(36).slice(2, 8)}` };

    const headers: Record<string, string> = { "Content-Type": "application/json" };
    const apiKey = this.config.apiKeys[agentName];
    if (apiKey) headers["Authorization"] = `Bearer ${apiKey}`;

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), this.config.timeout);

    try {
      const response = await fetch(`${agent.url.replace(/\/+$/, "")}/a2a/task`, {
        method: "POST",
        headers,
        body: JSON.stringify(fullTask),
        signal: controller.signal,
      });
      clearTimeout(timeoutId);

      if (!response.ok) {
        return { taskId: fullTask.id, status: "failed", error: `HTTP ${response.status}: ${response.statusText}` };
      }
      return await response.json() as A2ATaskResult;
    } catch (err) {
      clearTimeout(timeoutId);
      return { taskId: fullTask.id, status: "failed", error: err instanceof Error ? err.message : String(err) };
    }
  }

  /** Get a known agent's card */
  getAgentCard(name: string): A2AAgentCard | undefined {
    return this.knownAgents.get(name);
  }

  /** List all known agents */
  listAgents(): A2AAgentCard[] {
    return Array.from(this.knownAgents.values());
  }

  /** Remove a known agent */
  unregisterAgent(name: string): boolean {
    return this.knownAgents.delete(name);
  }
}
