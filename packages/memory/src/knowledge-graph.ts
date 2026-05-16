import {
  type KnowledgeGraph,
  type GraphNode,
  type GraphEdge,
  type GraphQuery,
  type GraphQueryResult,
} from "@evoclaw/core";

export class KnowledgeGraphStore implements KnowledgeGraph {
  private nodes = new Map<string, GraphNode>();
  private edges: GraphEdge[] = [];

  async addNode(node: GraphNode): Promise<void> {
    this.nodes.set(node.id, node);
  }

  async addEdge(edge: GraphEdge): Promise<void> {
    this.edges.push(edge);
  }

  async query(query: GraphQuery): Promise<GraphQueryResult> {
    const { limit = 100, params = {} } = query;

    let filteredNodes = Array.from(this.nodes.values());

    if (params.type) {
      filteredNodes = filteredNodes.filter((n) => n.type === params.type);
    }
    if (params.label) {
      filteredNodes = filteredNodes.filter((n) =>
        n.labels.includes(params.label as string)
      );
    }
    if (params.property && params.value !== undefined) {
      filteredNodes = filteredNodes.filter(
        (n) => n.properties[params.property as string] === params.value
      );
    }

    const nodeIds = new Set(filteredNodes.map((n) => n.id));
    const filteredEdges = this.edges.filter(
      (e) => nodeIds.has(e.from) || nodeIds.has(e.to)
    );

    const paths = this.buildPaths(filteredNodes, filteredEdges);

    return {
      nodes: filteredNodes.slice(0, limit),
      edges: filteredEdges.slice(0, limit),
      paths: paths.slice(0, limit),
    };
  }

  async deleteNode(nodeId: string): Promise<void> {
    this.nodes.delete(nodeId);
    this.edges = this.edges.filter((e) => e.from !== nodeId && e.to !== nodeId);
  }

  async getNode(id: string): Promise<GraphNode | undefined> {
    return this.nodes.get(id);
  }

  async findNodes(label: string): Promise<GraphNode[]> {
    return Array.from(this.nodes.values()).filter((n) => n.labels.includes(label));
  }

  async findEdges(fromNodeId: string, type?: string): Promise<GraphEdge[]> {
    return this.edges.filter((e) => {
      if (e.from !== fromNodeId) return false;
      if (type && e.type !== type) return false;
      return true;
    });
  }

  private buildPaths(
    nodes: GraphNode[],
    edges: GraphEdge[]
  ): import("@evoclaw/core").GraphPath[] {
    const nodeMap = new Map(nodes.map((n) => [n.id, n]));
    const adjacency = new Map<string, GraphEdge[]>();

    for (const edge of edges) {
      if (!adjacency.has(edge.from)) {
        adjacency.set(edge.from, []);
      }
      adjacency.get(edge.from)!.push(edge);
    }

    const visited = new Set<string>();
    const paths: import("@evoclaw/core").GraphPath[] = [];

    function dfs(currentId: string, pathNodes: GraphNode[], pathEdges: GraphEdge[]) {
      if (pathNodes.length > 2) return;
      visited.add(currentId);

      const neighbors = adjacency.get(currentId) || [];
      if (neighbors.length === 0 && pathNodes.length > 0) {
        paths.push({
          nodes: [...pathNodes],
          edges: [...pathEdges],
          length: pathEdges.length,
        });
      }

      for (const edge of neighbors) {
        if (visited.has(edge.to)) continue;
        const nextNode = nodeMap.get(edge.to);
        if (nextNode) {
          dfs(edge.to, [...pathNodes, nextNode], [...pathEdges, edge]);
        }
      }

      visited.delete(currentId);
    }

    for (const node of nodes) {
      dfs(node.id, [node], []);
    }

    return paths;
  }
}