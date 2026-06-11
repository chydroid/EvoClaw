import {
  type KnowledgeGraph,
  type GraphNode,
  type GraphEdge,
  type GraphQuery,
  type GraphQueryResult,
  type ReasoningResult,
  type ReasoningFact,
  type InferredRelation,
  type InferredRelationWithConfidence,
} from "@evoclaw/core";
import * as fs from "fs";
import * as path from "path";

const DATA_DIR = process.env.EVOCLAW_DATA_DIR || path.join(process.cwd(), "data");
const SAVE_DEBOUNCE_MS = 2000;

/** Relations that are transitive: if A rel B and B rel C, then A rel C */
const TRANSITIVE_RELATIONS = new Set(["part_of", "contains", "depends_on", "located_in"]);

/** Relations that are symmetric: if A rel B, then B rel A */
const SYMMETRIC_RELATIONS = new Set(["related_to", "connected_to", "linked_to", "sibling_of", "peer_of"]);

/** Inverse relation mapping: if A key B, then B value A */
const INVERSE_RELATIONS: Record<string, string> = {
  parent_of: "child_of",
  child_of: "parent_of",
  manager_of: "reports_to",
  reports_to: "manager_of",
  precedes: "follows",
  follows: "precedes",
  contains: "part_of",
  part_of: "contains",
};

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

  // ---------------------------------------------------------------------------
  // New methods
  // ---------------------------------------------------------------------------

  /**
   * Simple reasoning over the graph:
   * - Find entities mentioned in the query (by matching node ids, labels, or property values)
   * - Traverse relations from those entities (1-2 hops)
   * - Return discovered facts and inferred relations
   */
  async reason(query: string): Promise<ReasoningResult> {
    const matchedEntityIds = this.findEntitiesInQuery(query);

    const facts: ReasoningFact[] = [];
    const inferred: InferredRelation[] = [];
    const visitedFacts = new Set<string>();

    // 1-hop traversal
    for (const entityId of matchedEntityIds) {
      const directEdges = this.edges.filter((e) => e.from === entityId || e.to === entityId);
      for (const edge of directEdges) {
        const factKey = `${edge.from}|${edge.type}|${edge.to}`;
        if (!visitedFacts.has(factKey)) {
          visitedFacts.add(factKey);
          facts.push({
            subject: edge.from,
            relation: edge.type,
            object: edge.to,
            confidence: 1.0,
          });
        }

        // 2-hop traversal
        const nextHopSource = edge.from === entityId ? edge.to : edge.from;
        const secondHopEdges = this.edges.filter(
          (e) => e.from === nextHopSource || e.to === nextHopSource
        );
        for (const edge2 of secondHopEdges) {
          const factKey2 = `${edge2.from}|${edge2.type}|${edge2.to}`;
          if (!visitedFacts.has(factKey2)) {
            visitedFacts.add(factKey2);
            facts.push({
              subject: edge2.from,
              relation: edge2.type,
              object: edge2.to,
              confidence: 0.8,
            });
          }

          // Infer transitive relation across two hops
          if (edge.to === edge2.from && TRANSITIVE_RELATIONS.has(edge.type) && edge.type === edge2.type) {
            const inferredKey = `${edge.from}|${edge.type}|${edge2.to}`;
            if (!visitedFacts.has(inferredKey)) {
              visitedFacts.add(inferredKey);
              inferred.push({
                subject: edge.from,
                relation: edge.type,
                object: edge2.to,
                source: `transitive:${edge.from}-${edge.type}->${edge.to}-${edge2.type}->${edge2.to}`,
              });
            }
          }
        }
      }
    }

    // Generate a simple answer string
    let answer: string | undefined;
    if (facts.length > 0) {
      const factStrings = facts
        .slice(0, 5)
        .map((f) => `${f.subject} ${f.relation} ${f.object}`)
        .join("; ");
      answer = `Found ${facts.length} fact(s): ${factStrings}${facts.length > 5 ? "; ..." : ""}`;
    }

    return { query, facts, inferred, answer };
  }

  /**
   * Find all paths between two entities up to maxHops (default 3). Uses BFS.
   * Returns an array of paths, where each path is an array of { relation, target } steps.
   */
  async findPath(
    fromEntity: string,
    toEntity: string,
    maxHops: number = 3
  ): Promise<Array<Array<{ relation: string; target: string }>>> {
    if (fromEntity === toEntity) return [];

    // Build adjacency list (undirected: edges go both ways)
    const adjacency = new Map<string, Array<{ relation: string; target: string }>>();
    for (const edge of this.edges) {
      if (!adjacency.has(edge.from)) adjacency.set(edge.from, []);
      adjacency.get(edge.from)!.push({ relation: edge.type, target: edge.to });
      if (!adjacency.has(edge.to)) adjacency.set(edge.to, []);
      adjacency.get(edge.to)!.push({ relation: edge.type, target: edge.from });
    }

    const results: Array<Array<{ relation: string; target: string }>> = [];

    // BFS queue: each entry is [currentNode, pathSoFar]
    const queue: Array<[string, Array<{ relation: string; target: string }>]> = [
      [fromEntity, []],
    ];
    const visitedByPath = new Set<string>();

    while (queue.length > 0) {
      const [current, pathSoFar] = queue.shift()!;

      if (pathSoFar.length >= maxHops) continue;

      const neighbors = adjacency.get(current) || [];
      for (const { relation, target } of neighbors) {
        // Avoid cycles within the same path
        const pathKey = [...pathSoFar.map((s) => s.target), current, target].join("|");
        if (visitedByPath.has(pathKey)) continue;
        visitedByPath.add(pathKey);

        const step = { relation, target };
        const newPath = [...pathSoFar, step];

        if (target === toEntity) {
          results.push(newPath);
        } else {
          queue.push([target, newPath]);
        }
      }
    }

    return results;
  }

  /**
   * Get all entities related to the given entity up to `depth` hops (default 2).
   * Returns a Set of entity IDs.
   */
  async getRelatedEntities(entityId: string, depth: number = 2): Promise<Set<string>> {
    const result = new Set<string>();
    if (!this.nodes.has(entityId)) return result;

    // Build adjacency list (undirected)
    const adjacency = new Map<string, string[]>();
    for (const edge of this.edges) {
      if (!adjacency.has(edge.from)) adjacency.set(edge.from, []);
      adjacency.get(edge.from)!.push(edge.to);
      if (!adjacency.has(edge.to)) adjacency.set(edge.to, []);
      adjacency.get(edge.to)!.push(edge.from);
    }

    const visited = new Set<string>();
    let frontier = new Set<string>([entityId]);
    visited.add(entityId);

    for (let hop = 0; hop < depth; hop++) {
      const nextFrontier = new Set<string>();
      for (const node of frontier) {
        const neighbors = adjacency.get(node) || [];
        for (const neighbor of neighbors) {
          if (!visited.has(neighbor)) {
            visited.add(neighbor);
            nextFrontier.add(neighbor);
            result.add(neighbor);
          }
        }
      }
      frontier = nextFrontier;
    }

    return result;
  }

  /**
   * Infer new relations using simple rules:
   * - Transitive: if A "part_of" B and B "part_of" C, then A "part_of" C
   * - Symmetric: if A "related_to" B, then B "related_to" A
   * - Inverse: if A "parent_of" B, then B "child_of" A
   */
  async inferRelations(
    entityId: string
  ): Promise<InferredRelationWithConfidence[]> {
    const results: InferredRelationWithConfidence[] = [];
    const existingTriples = new Set<string>();

    // Build a set of existing triples for dedup
    for (const edge of this.edges) {
      existingTriples.add(`${edge.from}|${edge.type}|${edge.to}`);
    }

    const addIfNew = (
      subject: string,
      relation: string,
      object: string,
      confidence: number,
      basis: string
    ) => {
      const key = `${subject}|${relation}|${object}`;
      if (!existingTriples.has(key)) {
        existingTriples.add(key);
        results.push({ subject, relation, object, confidence, basis });
      }
    };

    // Get all edges involving this entity (both directions)
    const directEdges = this.edges.filter(
      (e) => e.from === entityId || e.to === entityId
    );

    for (const edge of directEdges) {
      // --- Symmetric rule ---
      if (SYMMETRIC_RELATIONS.has(edge.type)) {
        addIfNew(
          edge.to,
          edge.type,
          edge.from,
          0.9,
          `symmetric:${edge.from} ${edge.type} ${edge.to}`
        );
      }

      // --- Inverse rule ---
      const inverse = INVERSE_RELATIONS[edge.type];
      if (inverse) {
        addIfNew(
          edge.to,
          inverse,
          edge.from,
          0.9,
          `inverse:${edge.from} ${edge.type} ${edge.to}`
        );
      }

      // --- Transitive rule ---
      if (TRANSITIVE_RELATIONS.has(edge.type)) {
        // If edge is A -> B (with transitive rel), find B -> C (same rel)
        const nextEdges = this.edges.filter(
          (e) => e.from === edge.to && e.type === edge.type
        );
        for (const nextEdge of nextEdges) {
          addIfNew(
            edge.from,
            edge.type,
            nextEdge.to,
            0.7,
            `transitive:${edge.from} ${edge.type} ${edge.to} AND ${nextEdge.from} ${nextEdge.type} ${nextEdge.to}`
          );
        }
      }
    }

    return results;
  }

  // ---------------------------------------------------------------------------
  // Private helpers
  // ---------------------------------------------------------------------------

  /**
   * Find entity IDs whose id, labels, or string properties appear in the query text.
   */
  private findEntitiesInQuery(query: string): string[] {
    const lowerQuery = query.toLowerCase();
    const matched: string[] = [];

    for (const [id, node] of this.nodes) {
      // Match by id
      if (lowerQuery.includes(id.toLowerCase())) {
        matched.push(id);
        continue;
      }
      // Match by label
      const labelMatch = node.labels.some((l) => lowerQuery.includes(l.toLowerCase()));
      if (labelMatch) {
        matched.push(id);
        continue;
      }
      // Match by string property values
      const propMatch = Object.values(node.properties).some(
        (v) => typeof v === "string" && lowerQuery.includes((v as string).toLowerCase())
      );
      if (propMatch) {
        matched.push(id);
      }
    }

    return matched;
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
