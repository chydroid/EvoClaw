import { ServiceRegistry, EventBus, type Task, type DAGNode, type ExecutionStep } from "@evoclaw/core";

interface DAGResult {
  output: Record<string, unknown>;
  steps: ExecutionStep[];
}

export class DAGExecutor {
  constructor(
    private registry: ServiceRegistry,
    private eventBus: EventBus
  ) {}

  async executeDAG(task: Task): Promise<DAGResult> {
    const completed = new Map<string, ExecutionStep>();
    const nodeMap = new Map<string, DAGNode>();

    for (const node of task.dag) {
      nodeMap.set(node.id, node);
    }

    const sortedNodes = this.topologicalSort(task.dag);

    for (const node of sortedNodes) {
      let depsReady = true;
      for (const depId of node.dependencies) {
        const depStep = completed.get(depId);
        if (!depStep || depStep.status !== "completed") {
          const step: ExecutionStep = {
            nodeId: node.id,
            status: "waiting_dependency",
            attempt: 1,
            result: null,
            error: `Dependency "${depId}" not completed`,
          };
          completed.set(node.id, step);
          depsReady = false;
          break;
        }
      }

      if (!depsReady) {
        continue;
      }

      try {
        const result = await this.executeNode(node, task.context);
        const step: ExecutionStep = {
          nodeId: node.id,
          status: "completed",
          startedAt: new Date(),
          completedAt: new Date(),
          attempt: 1,
          result: {
            success: true,
            data: result,
            artifacts: [],
            metrics: {
              startTime: new Date(),
              endTime: new Date(),
              durationMs: 0,
              cpuUsage: 0,
              memoryUsageMB: 0,
            },
          },
        };
        completed.set(node.id, step);
      } catch (err) {
        const step: ExecutionStep = {
          nodeId: node.id,
          status: "failed",
          attempt: 1,
          result: null,
          error: err instanceof Error ? err.message : String(err),
        };
        completed.set(node.id, step);
        throw err;
      }
    }

    return {
      output: { dagCompleted: true, nodeCount: task.dag.length },
      steps: Array.from(completed.values()),
    };
  }

  private async executeNode(node: DAGNode, _context: Task["context"]): Promise<unknown> {
    if (node.skill) {
      const skillManager = this.registry.resolveService<{
        executeSkill(name: string, params: Record<string, unknown>): Promise<unknown>;
      }>("skillManager");

      if (skillManager) {
        return skillManager.executeSkill(node.skill, node.params);
      }
    }

    return { executed: node.action, params: node.params };
  }

  private topologicalSort(nodes: DAGNode[]): DAGNode[] {
    const nodeMap = new Map<string, DAGNode>();
    const inDegree = new Map<string, number>();
    const adjacency = new Map<string, string[]>();

    for (const node of nodes) {
      nodeMap.set(node.id, node);
      if (!inDegree.has(node.id)) inDegree.set(node.id, 0);
      if (!adjacency.has(node.id)) adjacency.set(node.id, []);
    }

    for (const node of nodes) {
      for (const depId of node.dependencies) {
        inDegree.set(node.id, (inDegree.get(node.id) || 0) + 1);
        adjacency.get(depId)?.push(node.id);
      }
    }

    const queue: string[] = [];
    for (const [nodeId, degree] of inDegree) {
      if (degree === 0) queue.push(nodeId);
    }

    const sorted: DAGNode[] = [];

    while (queue.length > 0) {
      const current = queue.shift()!;
      const node = nodeMap.get(current);
      if (node) sorted.push(node);

      for (const neighbor of adjacency.get(current) || []) {
        const newDegree = (inDegree.get(neighbor) || 1) - 1;
        inDegree.set(neighbor, newDegree);
        if (newDegree === 0) queue.push(neighbor);
      }
    }

    if (sorted.length !== nodes.length) {
      throw new Error("DAG contains a cycle, cannot execute");
    }

    return sorted;
  }
}