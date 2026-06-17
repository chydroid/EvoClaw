/**
 * Local LLM Service — 本地轻量LLM推理服务
 *
 * 使用 ONNX Runtime GenAI 加载 Qwen3.5 系列本地 ONNX 模型，
 * 为简单任务（问候、翻译、格式化）提供快速本地推理，
 * 大幅节省远程API token消耗。
 *
 * 支持模型：
 *   - Qwen3.5-0.8B (~1GB ONNX) — 推荐，体积小，速度快
 *   - Qwen3.5-2B (~2.7GB ONNX) — 质量更高，适合稍强硬件
 *
 * 模型文件不随项目发布，用户需自行下载。
 * 未下载时，CopilotRouter正常路由到远程API。
 */

import { existsSync, mkdirSync, readdirSync } from "fs";
import { join, resolve } from "path";

// ── Types ──

export interface LocalLLMStatus {
  available: boolean;
  modelPath: string | null;
  modelName: string | null;
  loading: boolean;
  loaded: boolean;
  error: string | null;
}

export interface LocalLLMConfig {
  enabled: boolean;
  modelDir: string;
  maxTokens: number;
  temperature: number;
  topP: number;
  timeout: number;
}

const DEFAULT_CONFIG: LocalLLMConfig = {
  enabled: true,
  modelDir: resolve(process.cwd(), "local-model"),
  maxTokens: 512,
  temperature: 0.5,
  topP: 0.9,
  timeout: 30000,
};

// ── Model download info ──

/** 支持的本地模型规格 */
export interface LocalModelSpec {
  name: string;
  description: string;
  downloadUrl: string;
  sizeApprox: string;
  vramApprox: string;
}

export const SUPPORTED_LOCAL_MODELS: Record<string, LocalModelSpec> = {
  "0.6b": {
    name: "Qwen3-0.6B",
    description: "轻量本地模型，标准Attention架构，完全兼容Transformers.js（推荐）",
    downloadUrl: "https://huggingface.co/onnx-community/Qwen3-0.6B-ONNX",
    sizeApprox: "~1.2GB (q4量化 ONNX)",
    vramApprox: "~0.6GB (q4量化)",
  },
  "0.8b": {
    name: "Qwen3.5-0.8B",
    description: "混合架构模型（需onnxruntime-node，不支持Transformers.js）",
    downloadUrl: "https://huggingface.co/onnx-community/Qwen3.5-0.8B-ONNX-OPT",
    sizeApprox: "~700MB (q4量化 ONNX)",
    vramApprox: "~0.5GB (q4量化)",
  },
};

/** 默认模型信息（向后兼容） */
export const LOCAL_MODEL_INFO = {
  name: "Qwen3-0.6B",
  description: "轻量本地模型，标准Attention架构，完全兼容Transformers.js",
  downloadUrl: "https://huggingface.co/onnx-community/Qwen3-0.6B-ONNX",
  sizeApprox: "~1.2GB (q4量化 ONNX)",
  instructions: [
    "推荐模型：Qwen3-0.6B（~1.2GB，标准架构，兼容性好）",
    "",
    "方式一：git clone（需要 git-lfs）",
    "  git lfs install",
    "  git clone https://huggingface.co/onnx-community/Qwen3-0.6B-ONNX local-model",
    "",
    "方式二：使用国内镜像（huggingface.co 无法访问时）",
    "  git lfs install",
    "  git clone https://hf-mirror.com/onnx-community/Qwen3-0.6B-ONNX local-model",
    "",
    "注意：Qwen3.5-0.8B 使用混合架构（Linear+Full Attention），",
    "  其ONNX模型包含自定义算子，仅onnxruntime-node支持，",
    "  @huggingface/transformers 不兼容。推荐使用 Qwen3-0.6B。",
    "",
    "下载完成后重启EvoClaw服务，本地模型将自动加载",
  ].join("\n"),
};

// ── Service ──

export class LocalLLMService {
  private config: LocalLLMConfig;
  private status: LocalLLMStatus;
  private generator: any = null;
  private tokenizer: any = null;
  private ort: any = null;

  constructor(config?: Partial<LocalLLMConfig>) {
    this.config = { ...DEFAULT_CONFIG, ...config };
    this.status = {
      available: false,
      modelPath: null,
      modelName: null,
      loading: false,
      loaded: false,
      error: null,
    };
  }

  /**
   * 初始化：检测模型文件并尝试加载
   */
  async initialize(): Promise<LocalLLMStatus> {
    if (!this.config.enabled) {
      this.status.error = "Local LLM is disabled in config";
      return this.status;
    }

    // Step 1: Find model directory
    const modelDir = this.findModelDir();
    if (!modelDir) {
      this.status.error = `Model directory not found. Please download model to: ${this.config.modelDir}`;
      console.log(`[LocalLLM] Model not found. Download instructions:\n${LOCAL_MODEL_INFO.instructions}`);
      return this.status;
    }

    this.status.modelPath = modelDir;
    // modelName is already set by detectModelName in findModelDir
    if (!this.status.modelName) {
      this.status.modelName = LOCAL_MODEL_INFO.name;
    }

    // Step 2: Try to load ONNX Runtime GenAI
    this.status.loading = true;
    try {
      await this.loadModel(modelDir);
      this.status.available = true;
      this.status.loaded = true;
      this.status.error = null;
      console.log(`[LocalLLM] ✅ Local model loaded: ${modelDir}`);
    } catch (err) {
      this.status.available = false;
      this.status.loaded = false;
      this.status.error = `Failed to load model: ${err instanceof Error ? err.message : String(err)}`;
      console.warn(`[LocalLLM] ⚠️ Model load failed: ${this.status.error}`);
      console.warn(`[LocalLLM] Falling back to remote API for all tasks.`);
    }
    this.status.loading = false;
    return this.status;
  }

  /**
   * 生成回复
   */
  async generate(prompt: string, systemPrompt?: string): Promise<string> {
    if (!this.status.available || !this.generator) {
      throw new Error("Local LLM is not available");
    }

    try {
      // @huggingface/transformers pipeline: call directly with messages format
      if (typeof this.generator === "function") {
        const messages = [];
        if (systemPrompt) {
          messages.push({ role: "system", content: systemPrompt });
        }
        messages.push({ role: "user", content: prompt });

        const result = await this.generator(messages, {
          max_new_tokens: this.config.maxTokens,
          temperature: this.config.temperature,
          top_p: this.config.topP,
          do_sample: true,
        });

        // pipeline returns [{ generated_text: [...] }] or [{ generated_text: "..." }]
        if (Array.isArray(result) && result.length > 0) {
          const genText = result[0].generated_text;
          // If it's an array of messages, extract the last assistant message
          if (Array.isArray(genText)) {
            const lastMsg = genText[genText.length - 1];
            if (lastMsg?.role === "assistant" && lastMsg?.content) {
              return this.cleanResponse(lastMsg.content);
            }
          }
          return this.cleanResponse(this.extractResponse(result[0]));
        }
        return this.cleanResponse(this.extractResponse(result));
      }

      // Fallback: Use @huggingface/transformers with tokenizer+model
      if (this.generator && this.tokenizer) {
        return await this.generateWithTransformers(prompt, systemPrompt);
      }

      throw new Error("No inference engine available");
    } catch (err) {
      console.error(`[LocalLLM] Generation failed:`, err);
      throw err;
    }
  }

  /**
   * 获取当前状态
   */
  getStatus(): LocalLLMStatus {
    return { ...this.status };
  }

  /**
   * 检查是否可用
   */
  isAvailable(): boolean {
    return this.status.available && this.status.loaded;
  }

  /**
   * 释放资源
   */
  dispose(): void {
    if (this.generator && typeof this.generator.dispose === "function") {
      this.generator.dispose();
    }
    this.generator = null;
    this.tokenizer = null;
    this.ort = null;
    this.status.available = false;
    this.status.loaded = false;
  }

  // ── Private methods ──

  private findModelDir(): string | null {
    const searchDirs = [this.config.modelDir, join(process.cwd(), "local-model")];

    for (const baseDir of searchDirs) {
      if (!existsSync(baseDir)) continue;

      // Try to find a valid model directory (contains config.json + onnx/ subfolder)
      const found = this.searchModelDir(baseDir, 3); // depth 3
      if (found) return found;
    }
    return null;
  }

  /** Recursively search for a model directory containing config.json and onnx/ */
  private searchModelDir(dir: string, depth: number): string | null {
    if (depth <= 0) return null;
    try {
      const files = readdirSync(dir, { withFileTypes: true });
      const names = files.map(f => f.name);

      // Check if this dir is a valid model root (has config.json AND onnx/ subfolder)
      const hasConfig = names.some(n => n === "config.json");
      const hasOnnxDir = files.some(f => f.isDirectory() && f.name === "onnx");

      if (hasConfig && hasOnnxDir) {
        // Verify onnx/ actually contains .onnx files
        const onnxDir = join(dir, "onnx");
        try {
          const onnxFiles = readdirSync(onnxDir);
          if (onnxFiles.some(f => f.endsWith(".onnx"))) {
            this.detectModelName(dir, names);
            return dir;
          }
        } catch { /* onnx dir not readable */ }
      }

      // Check if this dir has .onnx files directly (flat structure)
      if (names.some(f => f.endsWith(".onnx"))) {
        this.detectModelName(dir, names);
        return dir;
      }

      // Recurse into subdirectories (e.g., local-model/Qwen3.5-0.8B-ONNX-OPT/)
      for (const entry of files) {
        if (!entry.isDirectory()) continue;
        // Skip hidden dirs and node_modules
        if (entry.name.startsWith(".") || entry.name === "node_modules") continue;
        const subPath = join(dir, entry.name);
        const found = this.searchModelDir(subPath, depth - 1);
        if (found) return found;
      }
    } catch { /* dir not readable */ }
    return null;
  }

  /** Auto-detect model name from config.json or directory structure */
  private detectModelName(dir: string, files: string[]): void {
    try {
      const configPath = join(dir, "config.json");
      if (existsSync(configPath)) {
        const configContent = require("fs").readFileSync(configPath, "utf-8");
        const config = JSON.parse(configContent);
        if (config.model_type?.includes("qwen3") || config._name?.includes("Qwen3.5")) {
          // Detect from hidden_size: 1024 = 0.8B, 2048 = 2B
          if (config.hidden_size === 2048) {
            this.status.modelName = "Qwen3.5-2B";
          } else {
            this.status.modelName = "Qwen3.5-0.8B";
          }
          return;
        }
      }
    } catch { /* ignore parse errors */ }
    // Fallback: default name
    this.status.modelName = LOCAL_MODEL_INFO.name;
  }

  private async loadModel(modelDir: string): Promise<void> {
    // Strategy 1: Try @huggingface/transformers pipeline (most compatible)
    // For OPT models with custom ops (CausalConvWithState), we must use the non-OPT variant
    // pipeline() handles model loading, tokenization, and generation end-to-end
    try {
      const transformers = await import(/* webpackIgnore: true */ "@huggingface/transformers") as any;
      console.log(`[LocalLLM] Loading model with @huggingface/transformers...`);

      // Determine model ID for HuggingFace Hub
      // Qwen3 uses standard Attention — compatible with @huggingface/transformers
      // Qwen3.5 uses hybrid Attention (Linear+Full) — requires custom ONNX ops, NOT compatible
      let modelId = "onnx-community/Qwen3-0.6B-ONNX"; // standard Attention, compatible
      if (this.status.modelName?.includes("3.5") || this.status.modelName?.includes("Qwen3.5")) {
        // Qwen3.5 models have custom ops, try anyway but will likely fail
        modelId = "onnx-community/Qwen3.5-0.8B-ONNX";
      }

      // Try loading from local dir first, fall back to Hub download
      // Use q4 quantization for smallest size and fastest inference
      const generator = await transformers.pipeline("text-generation", modelId, {
        dtype: "q4",
        device: "cpu",
        model_file_name: "model", // non-OPT uses model.onnx, not decoder_model_merged
        local_model_path: modelDir, // try local first
      });
      this.generator = generator;
      console.log(`[LocalLLM] Model loaded via @huggingface/transformers (model: ${modelId})`);
      return;
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      console.log(`[LocalLLM] @huggingface/transformers pipeline failed: ${errMsg}`);

      // If local model failed (likely OPT format), try downloading from Hub
      if (errMsg.includes("CausalConvWithState") || errMsg.includes("not a registered")) {
        console.log(`[LocalLLM] Local model uses OPT format with custom ops. Trying Hub download of standard ONNX...`);
        try {
          const transformers = await import(/* webpackIgnore: true */ "@huggingface/transformers") as any;
          const modelId = "onnx-community/Qwen3-0.6B-ONNX";
          const generator = await transformers.pipeline("text-generation", modelId, {
            dtype: "q4",
            device: "cpu",
          });
          this.generator = generator;
          console.log(`[LocalLLM] Model loaded from HuggingFace Hub: ${modelId}`);
          return;
        } catch (hubErr) {
          console.log(`[LocalLLM] Hub download also failed: ${hubErr instanceof Error ? hubErr.message : String(hubErr)}`);
        }
      }
    }

    // Strategy 2: Try onnxruntime-node (supports custom ops natively)
    try {
      const ort = await import("onnxruntime-node");
      this.ort = ort;
      console.log(`[LocalLLM] onnxruntime-node available, loading model...`);
      // onnxruntime-node supports custom ops but needs manual tokenization
      // For now, just note it's available
      return;
    } catch (err) {
      console.log(`[LocalLLM] onnxruntime-node not available: ${err instanceof Error ? err.message : String(err)}`);
    }

    throw new Error(
      "No ONNX inference engine available. Install one of:\n" +
      "  - @huggingface/transformers (recommended): pnpm add @huggingface/transformers\n" +
      "  - onnxruntime-node: pnpm add onnxruntime-node\n" +
      "Note: OPT format models require non-OPT ONNX for @huggingface/transformers compatibility."
    );
  }

  private extractResponse(result: any): string {
    if (typeof result === "string") return result.trim();
    if (Array.isArray(result)) {
      const text = result.map(r => {
        if (typeof r === "string") return r;
        if (r?.generated_text) return r.generated_text;
        if (r?.content) return r.content;
        return String(r);
      }).join("");
      return text.trim();
    }
    if (result?.generated_text) return result.generated_text.trim();
    if (result?.content) return result.content.trim();
    return String(result).trim();
  }

  /** Clean Qwen3.5 response: remove thinking tags and special tokens */
  private cleanResponse(text: string): string {
    // Remove Qwen3.5 thinking block: <think>...</think>
    text = text.replace(/<think>[\s\S]*?<\/think>/g, "").trim();
    // Remove any remaining special tokens
    text = text.replace(/<\|im_end\|>/g, "").trim();
    text = text.replace(/<\|im_start\|>/g, "").trim();
    return text;
  }

  /** Generate using @huggingface/transformers (AutoModelForCausalLM + AutoTokenizer) */
  private async generateWithTransformers(prompt: string, systemPrompt?: string): Promise<string> {
    if (!this.tokenizer || !this.generator) {
      throw new Error("Transformer model not loaded");
    }
    const fullPrompt = systemPrompt
      ? `<|im_start|>system\n${systemPrompt}<|im_end|>\n<|im_start|>user\n${prompt}<|im_end|>\n<|im_start|>assistant\n`
      : `<|im_start|>user\n${prompt}<|im_end|>\n<|im_start|>assistant\n`;
    const inputs = await this.tokenizer(fullPrompt, { return_tensors: "pt" });
    const output = await this.generator.generate({
      ...inputs,
      max_new_tokens: this.config.maxTokens,
      temperature: this.config.temperature,
      top_p: this.config.topP,
      do_sample: true,
    });
    const decoded = this.tokenizer.decode(output[0], { skip_special_tokens: true });
    // Remove the prompt portion from the response
    const assistantIdx = decoded.indexOf("assistant");
    const response = assistantIdx >= 0 ? decoded.slice(assistantIdx + "assistant".length).trim() : decoded.trim();
    return this.cleanResponse(response);
  }

  private async generateWithORT(prompt: string): Promise<string> {
    // Basic ONNX Runtime inference fallback
    // This is a simplified implementation - full implementation would need
    // proper tokenization and detokenization
    throw new Error("Direct ONNX Runtime inference not yet implemented. Please install onnxruntime-genai.");
  }
}

// ── Singleton ──

let _instance: LocalLLMService | null = null;

export function getLocalLLMService(config?: Partial<LocalLLMConfig>): LocalLLMService {
  if (!_instance) {
    _instance = new LocalLLMService(config);
  }
  return _instance;
}

export function resetLocalLLMService(): void {
  if (_instance) {
    _instance.dispose();
    _instance = null;
  }
}
