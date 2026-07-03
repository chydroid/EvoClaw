/**
 * 认知科学三层记忆分类（借鉴认知心理学与 LangChain Memory 的分层理念）。
 *
 * - episodic（情景记忆）：特定事件、对话、任务执行经历。时间戳 + 上下文相关。
 *   对应 type: "conversation" | "experience"
 * - semantic（语义记忆）：事实、知识、用户偏好。脱离上下文仍成立。
 *   对应 type: "knowledge" | "feedback"
 * - procedural（程序记忆）：操作流程、技能步骤、如何做某事。
 *   对应 type: "experience"（task_pattern 类） + system
 * - working（工作记忆）：当前会话的临时上下文，短期保留。
 *   对应 ShortTermMemoryStore，不持久化到 LongTermMemory。
 *
 * 与 type 的关系：type 是内容类型分类，cognitiveLayer 是认知层级分类。
 * 一条记忆同时拥有 type 与 cognitiveLayer，后者可由前者推断。
 */
export type CognitiveLayer = "episodic" | "semantic" | "procedural" | "working";

export interface MemoryEntry {
  id: string;
  type: "conversation" | "experience" | "knowledge" | "feedback" | "system" | "episodic" | "semantic" | "procedural";
  content: string;
  embedding: number[] | null;
  metadata: MemoryMetadata;
  ttl: number;
  createdAt: Date;
  accessedAt: Date;
  /**
   * 认知层级分类（可选，未设置时由 inferCognitiveLayer() 推断）。
   * 明确区分 episodic/semantic/procedural 三层，便于分层检索、衰减与压缩。
   */
  cognitiveLayer?: CognitiveLayer;
}

/**
 * 根据 MemoryEntry.type 推断认知层级。
 *
 * 映射规则（与 MemoryCurator 的 category→type 映射对齐）：
 * - conversation → episodic（对话事件）
 * - experience → procedural（若 metadata.tags 含 "task_pattern"）否则 episodic（经历事件）
 * - knowledge → semantic（事实知识）
 * - feedback → semantic（用户偏好，稳定属性）
 * - system → procedural（系统操作流程）
 * - episodic/semantic/procedural → 同名层级（自映射）
 */
export function inferCognitiveLayer(entry: Pick<MemoryEntry, "type" | "metadata">): CognitiveLayer {
  switch (entry.type) {
    case "episodic":
      return "episodic";
    case "semantic":
      return "semantic";
    case "procedural":
      return "procedural";
    case "conversation":
      return "episodic";
    case "knowledge":
      return "semantic";
    case "feedback":
      return "semantic";
    case "experience":
      // task_pattern 类的 experience 属于程序记忆，其余属情景记忆
      return entry.metadata?.tags?.includes("task_pattern") ? "procedural" : "episodic";
    case "system":
      return "procedural";
    default:
      return "episodic";
  }
}

export interface MemoryMetadata {
  source: string;
  sessionId: string;
  userId: string;
  tags: string[];
  importance: number;
  associations: string[];
  entities: string[];
}

export interface MemorySearchQuery {
  query: string;
  embedding?: number[];
  type?: MemoryEntry["type"];
  tags?: string[];
  minImportance?: number;
  limit?: number;
  threshold?: number;
  /**
   * 按认知层级过滤：episodic（情景）/ semantic（语义）/ procedural（程序）。
   * 允许调用方只检索某一层记忆，例如反思时只取 episodic，事实查询时只取 semantic。
   */
  cognitiveLayer?: CognitiveLayer;
}

export interface MemorySearchResult {
  entry: MemoryEntry;
  score: number;
  matchedFields: string[];
}

export interface KnowledgeGraph {
  addNode(entity: GraphNode): Promise<void>;
  addEdge(edge: GraphEdge): Promise<void>;
  query(query: GraphQuery): Promise<GraphQueryResult>;
  deleteNode(nodeId: string): Promise<void>;
}

export interface GraphNode {
  id: string;
  type: string;
  properties: Record<string, unknown>;
  labels: string[];
}

export interface GraphEdge {
  from: string;
  to: string;
  type: string;
  properties: Record<string, unknown>;
}

export interface GraphQuery {
  pattern: string;
  params: Record<string, unknown>;
  limit?: number;
}

export interface GraphQueryResult {
  nodes: GraphNode[];
  edges: GraphEdge[];
  paths: GraphPath[];
}

export interface ReasoningFact {
  subject: string;
  relation: string;
  object: string;
  confidence: number;
}

export interface InferredRelation {
  subject: string;
  relation: string;
  object: string;
  source: string;
}

export interface ReasoningResult {
  query: string;
  facts: ReasoningFact[];
  inferred: InferredRelation[];
  answer?: string;
}

export interface InferredRelationWithConfidence {
  subject: string;
  relation: string;
  object: string;
  confidence: number;
  basis: string;
}

export interface GraphPath {
  nodes: GraphNode[];
  edges: GraphEdge[];
  length: number;
}

export interface ShortTermMemory {
  set(key: string, value: unknown, ttl?: number): Promise<void>;
  get<T>(key: string): Promise<T | null>;
  delete(key: string): Promise<void>;
  exists(key: string): Promise<boolean>;
  clear(): Promise<void>;
  keys(pattern: string): Promise<string[]>;
}

export interface LongTermMemory {
  store(entry: MemoryEntry): Promise<MemoryEntry>;
  search(query: MemorySearchQuery): Promise<MemorySearchResult[]>;
  get(id: string): Promise<MemoryEntry | null>;
  update(id: string, updates: Partial<MemoryEntry>): Promise<void>;
  delete(id: string): Promise<void>;
  expire(): Promise<number>;
}

export interface EmbeddingProvider {
  /** Generate an embedding vector for a single text. */
  embed(text: string): Promise<number[]>;
  /** Generate embedding vectors for multiple texts. */
  embedBatch(texts: string[]): Promise<number[][]>;
  /** The dimensionality of the embedding vectors produced by this provider. */
  readonly dimensions: number;
}

export const DEFAULT_EMBEDDING_DIMENSION = 1536;
export const COSINE_SIMILARITY_THRESHOLD = 0.75;