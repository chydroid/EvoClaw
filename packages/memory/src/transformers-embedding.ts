import type { EmbeddingProvider } from "./vector-memory";

/**
 * Options for constructing a {@link TransformersEmbeddingProvider}.
 */
export interface TransformersEmbeddingProviderOptions {
  /** Model identifier for @huggingface/transformers pipeline. Defaults to `"all-MiniLM-L6-v2"`. */
  model?: string;
  /** Dimensionality of the embedding vectors produced by the model. Defaults to `384`. */
  dimensions?: number;
}

/**
 * Local embedding provider powered by `@huggingface/transformers` (v4).
 *
 * Uses the `feature-extraction` pipeline with the `all-MiniLM-L6-v2` model
 * by default (384 dimensions). The dependency is **optional** — the class can
 * always be constructed, but calling {@link embed} or {@link embedBatch}
 * without `@huggingface/transformers` installed will throw a clear error.
 *
 * The model is lazily loaded on first use and cached statically so that
 * multiple {@link TransformersEmbeddingProvider} instances share the same
 * underlying pipeline.
 *
 * @example
 * ```ts
 * if (TransformersEmbeddingProvider.isAvailable()) {
 *   const provider = new TransformersEmbeddingProvider();
 *   await provider.warmUp(); // optional: pre-load the model
 *   const vec = await provider.embed("hello world");
 * }
 * ```
 */
/**
 * Minimal type for the feature-extraction pipeline callable.
 * Avoids importing @huggingface/transformers at compile time so the
 * dependency remains truly optional.
 */
type FeatureExtractionPipeline = (
  text: string,
  options?: { pooling?: string; normalize?: boolean }
) => Promise<{ data: Float32Array; dims: number[] }>;

export class TransformersEmbeddingProvider implements EmbeddingProvider {
  readonly dimensions: number;
  private modelName: string;

  /**
   * Static cache for the loaded pipeline promise, keyed by model name.
   * This ensures multiple provider instances share the same model.
   */
  private static pipelineCache = new Map<string, Promise<FeatureExtractionPipeline>>();

  constructor(options?: TransformersEmbeddingProviderOptions) {
    this.modelName = options?.model ?? "all-MiniLM-L6-v2";
    this.dimensions = options?.dimensions ?? 384;
  }

  /**
   * Check whether `@huggingface/transformers` can be imported.
   * Returns `true` if the package is available, `false` otherwise.
   */
  static isAvailable(): boolean {
    try {
      // require.resolve is synchronous and does not actually load the module
      require.resolve("@huggingface/transformers");
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Pre-load the model so that subsequent calls to {@link embed} / {@link embedBatch}
   * do not incur the one-time loading cost.
   */
  async warmUp(): Promise<void> {
    await this.getPipeline();
  }

  async embed(text: string): Promise<number[]> {
    const pipe = await this.getPipeline();
    const output = await pipe(text, { pooling: "mean", normalize: false });
    return this.normalizeTensor(output);
  }

  async embedBatch(texts: string[]): Promise<number[][]> {
    // Call embed sequentially — the transformers.js pipeline handles
    // internal batching and the sequential approach avoids potential
    // memory pressure from large concurrent inference requests.
    const results: number[][] = [];
    for (const text of texts) {
      results.push(await this.embed(text));
    }
    return results;
  }

  // ── Private helpers ──────────────────────────────────────────────────────

  /**
   * Lazily load the feature-extraction pipeline (singleton per model name).
   * Uses a static promise map so that multiple instances share the same model.
   */
  private getPipeline(): Promise<FeatureExtractionPipeline> {
    let cached = TransformersEmbeddingProvider.pipelineCache.get(this.modelName);
    if (!cached) {
      cached = this.loadPipeline();
      TransformersEmbeddingProvider.pipelineCache.set(this.modelName, cached);
    }
    return cached;
  }

  /**
   * Dynamically import @huggingface/transformers and create the pipeline.
   * Throws a descriptive error if the package is not installed.
   */
  private async loadPipeline(): Promise<FeatureExtractionPipeline> {
    let transformers: typeof import("@huggingface/transformers");
    try {
      transformers = await import("@huggingface/transformers");
    } catch {
      throw new Error(
        "@huggingface/transformers is not installed. " +
          "Install it with `pnpm add @huggingface/transformers` to use TransformersEmbeddingProvider."
      );
    }

    const { pipeline } = transformers;
    return pipeline("feature-extraction", this.modelName, { dtype: "fp32" }) as Promise<FeatureExtractionPipeline>;
  }

  /**
   * L2-normalize a tensor output and convert it to a plain number array.
   */
  private normalizeTensor(tensor: { data: Float32Array; dims: number[] }): number[] {
    const data = tensor.data;
    const vec = Array.from(data);

    // L2 normalize
    let normSq = 0;
    for (let i = 0; i < vec.length; i++) {
      normSq += vec[i] * vec[i];
    }
    const norm = Math.sqrt(normSq);
    if (norm > 0) {
      for (let i = 0; i < vec.length; i++) {
        vec[i] /= norm;
      }
    }

    return vec;
  }
}
