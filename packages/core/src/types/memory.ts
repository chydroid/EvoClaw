export interface MemoryEntry {
  id: string;
  type: "conversation" | "experience" | "knowledge" | "feedback" | "system";
  content: string;
  embedding: number[] | null;
  metadata: MemoryMetadata;
  ttl: number;
  createdAt: Date;
  accessedAt: Date;
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