import type { EmbeddingProvider } from "./vector-memory";

/**
 * Options for constructing a {@link TransformersEmbeddingProvider}.
 */
export interface TransformersEmbeddingProviderOptions {
  /** Model identifier for @huggingface/transformers pipeline. Defaults to `"all-MiniLM-L6-v2"`. */
  model?: string;
  /** Dimensionality of the embedding vectors produced by the model. Defaults to `384`. */
  dimensions?: number;
  /**
   * Custom Hugging Face endpoint URL for model downloads. Useful in regions
   * where the default `huggingface.co` is unreachable. Common choices:
   *   - `"https://hf-mirror.com"` (community China mirror, default if HF_ENDPOINT env unset)
   *   - `"https://www.modelscope.cn"` (ModelScope, requires `model_name` mapping)
   *   - `"https://huggingface.co"` (official, default)
   */
  endpoint?: string;
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
  private endpoint: string;
  /** True once the underlying pipeline has been loaded at least once. */
  private _loaded = false;
  /** Set when loadPipeline() throws — surfaced to callers via embed() */
  private _loadError: Error | null = null;

  /**
   * Static cache for the loaded pipeline promise, keyed by model name.
   * This ensures multiple provider instances share the same model.
   */
  private static pipelineCache = new Map<string, Promise<FeatureExtractionPipeline>>();

  constructor(options?: TransformersEmbeddingProviderOptions) {
    // transformers.js v4 ships ONNX-converted weights under the Xenova/ namespace
    // on the HF Hub. The bare "all-MiniLM-L6-v2" name resolves to the original
    // (PyTorch) repo and 404s at download time. Use Xenova/... by default.
    this.modelName = options?.model ?? "Xenova/all-MiniLM-L6-v2";
    this.dimensions = options?.dimensions ?? 384;
    // Resolve endpoint priority: explicit option > HF_ENDPOINT env > default mirror.
    // Default to hf-mirror.com for users in CN; set endpoint option to "https://huggingface.co"
    // to force the official endpoint.
    this.endpoint =
      options?.endpoint ??
      process.env.HF_ENDPOINT ??
      "https://hf-mirror.com";
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
   *
   * Resolves with `true` if the model is now ready, `false` if loading failed
   * (e.g. no network access, model file not cached). Callers can use
   * {@link isLoaded} afterwards to check status.
   */
  async warmUp(): Promise<boolean> {
    try {
      await this.getPipeline();
      // Force a real inference so the ONNX session is fully initialized
      // and any silent tokenizer/config issues surface here.
      await this.embed("__warmup__");
      this._loaded = true;
      return true;
    } catch (err) {
      this._loadError = err instanceof Error ? err : new Error(String(err));
      this._loaded = false;
      return false;
    }
  }

  /** True once the model has been successfully warmed up. */
  isLoaded(): boolean {
    return this._loaded;
  }

  /** The error from the most recent failed warmUp(), or null. */
  getLoadError(): Error | null {
    return this._loadError;
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
   *
   * The HF endpoint is configured by patching `env.remoteHost` (transformers.js
   * v4 ignores the `HF_ENDPOINT` env var; the field is hard-coded to
   * "https://huggingface.co/"). We rewrite it to the configured mirror before
   * any pipeline() call, so weight/tokenizer/config downloads go to the
   * mirror.
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

    // Patch the live env object so all subsequent fetches use our mirror.
    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const env = (transformers as any).env;
      if (env && typeof env === "object") {
        const endpoint = this.endpoint.endsWith("/") ? this.endpoint : this.endpoint + "/";
        env.remoteHost = endpoint;
        for (const k of Object.keys(env)) {
          const v = env[k];
          if (typeof v === "string" && v.includes("huggingface.co")) {
            env[k] = v.replace(/https?:\/\/huggingface\.co\/?/g, endpoint);
          }
        }
      }
    } catch {
      /* env may be sealed — fall through to default */
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
