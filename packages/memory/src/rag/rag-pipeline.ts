// ─── RAG Pipeline ────────────────────────────────────────────────────────────

import { EmbeddingProvider, VectorMemoryStore } from "../vector-memory.js";
import { chunkDocument, type ChunkOptions, type DocumentChunk } from "./document-chunker.js";
import { SimpleReranker, type RerankInput } from "./reranker.js";

export interface RAGPipelineConfig {
  /** The embedding provider to use */
  provider: EmbeddingProvider;
  /** Chunking options */
  chunkOptions?: ChunkOptions;
  /** Number of top results to retrieve. Default: 5 */
  topK?: number;
  /** Minimum similarity threshold for retrieval. Default: 0.5 */
  threshold?: number;
  /** Whether to enable reranking. Default: true */
  enableReranking?: boolean;
}

export interface RAGDocument {
  /** Unique document ID */
  id: string;
  /** Document text content */
  text: string;
  /** Optional metadata */
  metadata?: Record<string, unknown>;
}

export interface RAGRetrievalResult {
  /** The chunk text */
  text: string;
  /** Similarity score (after reranking if enabled) */
  score: number;
  /** Source document ID */
  documentId: string;
  /** Chunk index in the source document */
  chunkIndex: number;
  /** Chunk metadata */
  metadata: Record<string, unknown>;
}

const DEFAULT_TOP_K = 5;
const DEFAULT_THRESHOLD = 0.5;
const DEFAULT_ENABLE_RERANKING = true;

export class RAGPipeline {
  private store: VectorMemoryStore;
  private chunkOptions: ChunkOptions;
  private topK: number;
  private threshold: number;
  private enableReranking: boolean;
  private reranker: SimpleReranker;

  /** Track document IDs and their chunk IDs */
  private documentChunks = new Map<string, string[]>();
  /** Track total chunk count */
  private _chunkCount = 0;

  constructor(config: RAGPipelineConfig) {
    this.store = new VectorMemoryStore(
      null as never,
      null as never,
      config.provider
    );
    this.chunkOptions = config.chunkOptions ?? {};
    this.topK = config.topK ?? DEFAULT_TOP_K;
    this.threshold = config.threshold ?? DEFAULT_THRESHOLD;
    this.enableReranking = config.enableReranking ?? DEFAULT_ENABLE_RERANKING;
    this.reranker = new SimpleReranker();
  }

  /** Index a document: chunk it and store embeddings */
  async indexDocument(document: RAGDocument): Promise<void> {
    const chunks = chunkDocument(document.text, this.chunkOptions);
    const chunkIds: string[] = [];

    // Prepare batch entries
    const entries = chunks.map((chunk, i) => {
      const chunkId = `${document.id}_chunk_${i}`;
      chunkIds.push(chunkId);

      const metadata: Record<string, unknown> = {
        _documentId: document.id,
        _chunkIndex: i,
        _startOffset: chunk.startOffset,
        _endOffset: chunk.endOffset,
        ...(document.metadata ?? {}),
        ...(chunk.metadata ?? {}),
      };

      return { id: chunkId, text: chunk.text, metadata };
    });

    await this.store.batchAddAsync(entries);

    this.documentChunks.set(document.id, chunkIds);
    this._chunkCount += chunks.length;
  }

  /** Index multiple documents */
  async indexDocuments(documents: RAGDocument[]): Promise<void> {
    for (const doc of documents) {
      await this.indexDocument(doc);
    }
  }

  /** Retrieve relevant chunks for a query */
  async retrieve(
    query: string,
    options?: { topK?: number; threshold?: number }
  ): Promise<RAGRetrievalResult[]> {
    const topK = options?.topK ?? this.topK;
    const threshold = options?.threshold ?? this.threshold;

    // Embed the query
    const queryVector = await this.store.getProvider().embed(query);

    // Search by vector
    const searchResults = await this.store.search(queryVector, {
      threshold,
      limit: topK * 2, // Retrieve more candidates for reranking
    });

    // Map search results to RAGRetrievalResult
    const candidates: RAGRetrievalResult[] = searchResults.map((result) => ({
      text: (result.metadata._sourceText as string) ?? "",
      score: result.score,
      documentId: (result.metadata._documentId as string) ?? "",
      chunkIndex: (result.metadata._chunkIndex as number) ?? 0,
      metadata: result.metadata,
    }));

    // Apply reranking if enabled
    if (this.enableReranking && candidates.length > 0) {
      const rerankInputs: RerankInput[] = candidates.map((c) => ({
        text: c.text,
        score: c.score,
        metadata: c.metadata,
      }));

      const reranked = this.reranker.rerank(query, rerankInputs);

      return reranked.slice(0, topK).map((r) => ({
        text: r.text,
        score: r.score,
        documentId: (r.metadata._documentId as string) ?? "",
        chunkIndex: (r.metadata._chunkIndex as number) ?? 0,
        metadata: r.metadata,
      }));
    }

    return candidates.slice(0, topK);
  }

  /** Remove a document from the index */
  async removeDocument(documentId: string): Promise<void> {
    const chunkIds = this.documentChunks.get(documentId);
    if (!chunkIds) return;

    for (const chunkId of chunkIds) {
      this.store.delete(chunkId);
    }

    this._chunkCount -= chunkIds.length;
    this.documentChunks.delete(documentId);
  }

  /** Get the number of indexed documents */
  documentCount(): number {
    return this.documentChunks.size;
  }

  /** Get the total number of chunks */
  chunkCount(): number {
    return this._chunkCount;
  }
}
