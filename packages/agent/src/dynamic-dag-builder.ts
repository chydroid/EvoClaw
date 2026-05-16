import { ServiceRegistry, EventBus, type DAGNode, type TaskPriority } from "@evoclaw/core";

export interface DAGBuilderConfig {
  maxRetries: number;
  defaultTimeout: number;
  maxConcurrency: number;
}

export interface BuildContext {
  skills: Array<{
    id: string;
    name: string;
    keywords: string[];
    triggers: Array<{ type: string; pattern: string; description: string }>;
    requires: Array<{ name: string; version: string; optional?: boolean }>;
  }>;
  taskDescription: string;
  priority: TaskPriority;
}

export interface BuiltDAG {
  id: string;
  nodes: DAGNode[];
  edges: Array<{ from: string; to: string; metadata?: Record<string, unknown> }>;
  entryNode: string;
  terminalNode: string;
}

const DEFAULT_CONFIG: DAGBuilderConfig = {
  maxRetries: 3,
  defaultTimeout: 30000,
  maxConcurrency: 4,
};

export class DynamicDAGBuilder {
  private config: DAGBuilderConfig;

  constructor(private registry: ServiceRegistry, private eventBus: EventBus) {
    this.config = { ...DEFAULT_CONFIG };
    registry.registerService("dagBuilder", this);
  }

  configure(config: Partial<DAGBuilderConfig>): void {
    this.config = { ...this.config, ...config };
  }

  buildDAG(context: BuildContext): BuiltDAG {
    const nodes = this.buildNodes(context);
    if (nodes.length === 0) {
      throw new Error(
        `Cannot build DAG: no nodes generated for task "${context.taskDescription.slice(0, 80)}...". ` +
        `Ensure matching skills are available.`
      );
    }
    const edges = this.buildEdges(nodes, context);
    const entryNode = nodes[0].id;
    const terminalNode = nodes[nodes.length - 1].id;

    return {
      id: `dag_${Date.now()}`,
      nodes,
      edges,
      entryNode,
      terminalNode,
    };
  }

  buildFromTaskDescription(
    taskDescription: string,
    availableSkills: BuildContext["skills"]
  ): BuiltDAG {
    const context: BuildContext = {
      skills: availableSkills,
      taskDescription,
      priority: this.inferPriority(taskDescription),
    };

    return this.buildDAG(context);
  }

  estimateComplexity(context: BuildContext): {
    complexity: "simple" | "moderate" | "complex";
    estimatedDuration: number;
    parallelismPossible: boolean;
    dependencyChain: string[];
  } {
    const nodes = this.buildNodes(context);
    const edges = this.buildEdges(nodes, context);

    if (nodes.length <= 2) {
      return {
        complexity: "simple",
        estimatedDuration: nodes.reduce((sum, n) => sum + (n.timeout || 30000), 0),
        parallelismPossible: false,
        dependencyChain: nodes.map((n) => n.action),
      };
    }

    const parallelizable = this.findParallelGroups(nodes);
    const hasParallelism = parallelizable.some((g) => g.length > 1);

    if (nodes.length <= 5 && !hasParallelism) {
      return {
        complexity: "moderate",
        estimatedDuration: nodes.length * 10000,
        parallelismPossible: hasParallelism,
        dependencyChain: nodes.map((n) => n.action),
      };
    }

    return {
      complexity: "complex",
      estimatedDuration: nodes.length * 15000,
      parallelismPossible: hasParallelism,
      dependencyChain: nodes.map((n) => n.action),
    };
  }

  private buildNodes(context: BuildContext): DAGNode[] {
    const nodes: DAGNode[] = [];
    const matchedSkills = this.matchSkills(context.taskDescription, context.skills);

    const parseNode: DAGNode = {
      id: `node_parse`,
      action: "parse_input",
      dependencies: [],
      params: { taskDescription: context.taskDescription },
      timeout: this.config.defaultTimeout,
    };
    nodes.push(parseNode);

    for (let i = 0; i < matchedSkills.length; i++) {
      const skill = matchedSkills[i];
      const node: DAGNode = {
        id: `node_skill_${i}_${skill.id.slice(0, 6)}`,
        action: "skill_execution",
        skill: skill.id,
        dependencies: [],
        params: {},
        timeout: this.config.defaultTimeout,
      };

      if (i === 0) {
        node.dependencies = [parseNode.id];
      } else {
        const previousSkill = matchedSkills[i - 1];
        const previousNode = nodes[nodes.length - 1];
        if (this.areSkillsParallelizable(previousSkill, skill)) {
          node.dependencies = [parseNode.id];
        } else {
          node.dependencies = [previousNode.id];
        }
      }

      nodes.push(node);
    }

    const aggregateNode: DAGNode = {
      id: `node_aggregate`,
      action: "aggregate_results",
      dependencies: [],
      params: {},
      timeout: 5000,
    };

    const skillNodes = nodes.filter((n) => n.action === "skill_execution");
    aggregateNode.dependencies = skillNodes.map((n) => n.id);
    nodes.push(aggregateNode);

    return nodes;
  }

  private buildEdges(
    nodes: DAGNode[],
    context: BuildContext
  ): Array<{ from: string; to: string; metadata?: Record<string, unknown> }> {
    const edges: Array<{ from: string; to: string; metadata?: Record<string, unknown> }> = [];

    for (const node of nodes) {
      for (const depId of node.dependencies) {
        edges.push({
          from: depId,
          to: node.id,
          metadata: { type: "dependency", priority: context.priority },
        });
      }
    }

    return edges;
  }

  private matchSkills(
    description: string,
    skills: BuildContext["skills"]
  ): BuildContext["skills"] {
    const descLower = description.toLowerCase();
    const scored = skills.map((skill) => {
      let score = 0;

      for (const keyword of skill.keywords) {
        if (descLower.includes(keyword.toLowerCase())) {
          score += 3;
        }
      }

      for (const trigger of skill.triggers) {
        try {
          const regex = new RegExp(trigger.pattern, "i");
          if (regex.test(description)) {
            score += 5;
          }
        } catch {
          // Invalid regex pattern in skill trigger - skip silently
        }
      }

      if (descLower.includes(skill.name.toLowerCase())) {
        score += 2;
      }

      return { skill, score };
    });

    return scored
      .filter((s) => s.score > 0)
      .sort((a, b) => b.score - a.score)
      .map((s) => s.skill);
  }

  private areSkillsParallelizable(
    skillA: BuildContext["skills"][0],
    skillB: BuildContext["skills"][0]
  ): boolean {
    const aDeps = new Set(skillA.requires.filter((d) => !d.optional).map((d) => d.name));
    const bDeps = new Set(skillB.requires.filter((d) => !d.optional).map((d) => d.name));

    if (aDeps.has(skillB.name) || bDeps.has(skillA.name)) {
      return false;
    }

    return !([...aDeps].some((dep) => bDeps.has(dep)));
  }

  private findParallelGroups(nodes: DAGNode[]): string[][] {
    const groups: string[][] = [];
    const grouped = new Set<string>();

    for (const node of nodes) {
      if (grouped.has(node.id)) continue;

      if (node.dependencies.length === 0 || node.action === "parse_input") {
        const group: string[] = [node.id];
        grouped.add(node.id);

        for (const other of nodes) {
          if (
            grouped.has(other.id) ||
            other.id === node.id ||
            other.action !== node.action
          )
            continue;

          const sameDeps =
            node.dependencies.length === other.dependencies.length &&
            node.dependencies.every((d) => other.dependencies.includes(d));

          if (sameDeps) {
            group.push(other.id);
            grouped.add(other.id);
          }
        }

        groups.push(group);
      }
    }

    return groups;
  }

  private inferPriority(
    description: string
  ): TaskPriority {
    const lower = description.toLowerCase();
    if (lower.includes("urgent") || lower.includes("critical") || lower.includes("emergency"))
      return "critical";
    if (lower.includes("high") || lower.includes("priority") || lower.includes("important"))
      return "high";
    if (lower.includes("low") || lower.includes("background") || lower.includes("later"))
      return "low";
    return "normal";
  }
}