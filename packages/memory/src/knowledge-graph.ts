import {
  type KnowledgeGraph,
  type GraphNode,
  type GraphEdge,
  type GraphQuery,
  type GraphQueryResult,
} from "@evoclaw/core";
import * as fs from "fs";
import * as path from "path";

const DATA_DIR = process.env.EVOCLAW_DATA_DIR || path.join(process.cwd(), "data");
const SAVE_DEBOUNCE_MS = 2000;

export class KnowledgeGraphStore implements KnowledgeGraph {
  private nodes = new Map<string, GraphNode>();
  private edges: GraphEdge[] = [];
  private filePath: string;
  private saveTimer: NodeJS.Timeout | null = null;
  private dirty = false;

  constructor() {
    this.filePath = path.join(DATA_DIR, "memory", "knowledge-graph.json");
    this.load();
  }

  private load(): void {
    try {
      if (fs.existsSync(this.filePath)) {
        const raw = fs.readFileSync(this.filePath, "utf-8");
        const data = JSON.parse(raw);
        if (data.nodes && Array.isArray(data.nodes)) {
          for (const node of data.nodes) {
            this.nodes.set(node.id, node);
          }
        }
        if (data.edges && Array.isArray(data.edges)) {
          this.edges = data.edges;
        }
        console.log(`[KnowledgeGraph] Loaded ${this.nodes.size} nodes, ${this.edges.length} edges from disk`);
      }
    } catch (err) {
      console.warn(`[KnowledgeGraph] Failed to load from disk: ${err}`);
    }
  }

  private scheduleSave(): void {
    this.dirty = true;
    if (this.saveTimer) clearTimeout(this.saveTimer);
    this.saveTimer = setTimeout(() => this.save(), SAVE_DEBOUNCE_MS);
  }

  private save(): void {
    if (!this.dirty) return;
    this.dirty = false;
    try {
      const dir = path.dirname(this.filePath);
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }
      const data = {
        nodes: Array.from(this.nodes.values()),
        edges: this.edges,
      };
      fs.writeFileSync(this.filePath, JSON.stringify(data, null, 2), "utf-8");
    } catch (err) {
      console.warn(`[KnowledgeGraph] Failed to save: ${err}`);
    }
  }

  async addNode(node: GraphNode): Promise<void> {
    this.nodes.set(node.id, node);
    this.scheduleSave();
  }

  async addEdge(edge: GraphEdge): Promise<void> {
    this.edges.push(edge);
    this.scheduleSave();
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
    this.scheduleSave();
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

  async removeEdge(from: string, to: string, type?: string): Promise<void> {
    this.edges = this.edges.filter((e) => {
      if (e.from !== from || e.to !== to) return true;
      if (type && e.type !== type) return true;
      return false;
    });
    this.scheduleSave();
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
