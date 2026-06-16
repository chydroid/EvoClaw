/**
 * Local LLM Service — 本地轻量LLM推理服务
 *
 * 使用 ONNX Runtime GenAI 加载 Qwen2.5-0.5B-Instruct ONNX 模型，
 * 为简单任务（问候、翻译、格式化）提供快速本地推理，
 * 大幅节省远程API token消耗。
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

export const LOCAL_MODEL_INFO = {
  name: "Qwen2.5-0.5B-Instruct",
  description: "轻量本地模型，适合简单对话、翻译、格式化等任务",
  downloadUrl: "https://huggingface.co/Qwen/Qwen2.5-0.5B-Instruct-Onnx",
  sizeApprox: "~500MB (ONNX格式)",
  instructions: [
    "1. 访问 https://huggingface.co/Qwen/Qwen2.5-0.5B-Instruct-Onnx",
    "2. 下载所有文件到项目的 local-model/ 目录",
    "3. 确保目录中包含 model.onnx 和 tokenizer.json",
    "4. 重启EvoClaw服务，本地模型将自动加载",
    "",
    "或者使用 git clone (需要 git-lfs):",
    "  cd <EvoClaw项目目录>",
    "  git lfs install",
    "  git clone https://huggingface.co/Qwen/Qwen2.5-0.5B-Instruct-Onnx local-model",
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
    this.status.modelName = LOCAL_MODEL_INFO.name;

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

    const fullPrompt = systemPrompt
      ? `<|im_start|>system\n${systemPrompt}<|im_end|>\n<|im_start|>user\n${prompt}<|im_end|>\n<|im_start|>assistant\n`
      : `<|im_start|>user\n${prompt}<|im_end|>\n<|im_start|>assistant\n`;

    try {
      // Use ONNX Runtime GenAI for inference
      if (this.generator && typeof this.generator.generate === "function") {
        const result = await this.generator.generate(fullPrompt, {
          maxTokens: this.config.maxTokens,
          temperature: this.config.temperature,
          topP: this.config.topP,
        });
        return this.extractResponse(result);
      }

      // Fallback: Use ONNX Runtime directly
      if (this.ort && this.tokenizer) {
        return await this.generateWithORT(fullPrompt);
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
    const dirs = [this.config.modelDir, join(process.cwd(), "local-model")];

    for (const dir of dirs) {
      if (existsSync(dir)) {
        // Check for ONNX model files
        const files = readdirSync(dir);
        const hasOnnx = files.some(f => f.endsWith(".onnx") || f.endsWith(".onnx_data"));
        const hasTokenizer = files.some(f => f.includes("tokenizer") || f.includes("config.json"));
        if (hasOnnx) {
          return dir;
        }
        // Check subdirectories (e.g., model was cloned with subfolder)
        for (const sub of files) {
          const subPath = join(dir, sub);
          try {
            if (existsSync(subPath) && readdirSync(subPath).some(f => f.endsWith(".onnx"))) {
              return subPath;
            }
          } catch { /* not a directory */ }
        }
        // Has tokenizer but no onnx yet (partial download)
        if (hasTokenizer) {
          console.log(`[LocalLLM] Found tokenizer in ${dir} but no ONNX model files yet.`);
        }
      }
    }
    return null;
  }

  private async loadModel(modelDir: string): Promise<void> {
    // Strategy 1: Try onnxruntime-genai (preferred)
    try {
      // @ts-ignore - optional dependency, may not be installed
      const genai = await import("onnxruntime-genai");
      console.log(`[LocalLLM] Loading model with onnxruntime-genai from: ${modelDir}`);
      this.generator = await genai.Generator.create(modelDir);
      console.log(`[LocalLLM] Model loaded successfully via onnxruntime-genai`);
      return;
    } catch (err) {
      console.log(`[LocalLLM] onnxruntime-genai not available: ${err instanceof Error ? err.message : String(err)}`);
    }

    // Strategy 2: Try onnxruntime-node
    try {
      // @ts-ignore - optional dependency, may not be installed
      const ort = await import("onnxruntime-node");
      this.ort = ort;
      console.log(`[LocalLLM] onnxruntime-node available, will use for inference`);
      try {
        const { readFileSync } = await import("fs");
        const tokenizerPath = join(modelDir, "tokenizer.json");
        if (existsSync(tokenizerPath)) {
          console.log(`[LocalLLM] Tokenizer file found at ${tokenizerPath}`);
        }
      } catch { /* tokenizer not available */ }
      return;
    } catch (err) {
      console.log(`[LocalLLM] onnxruntime-node not available: ${err instanceof Error ? err.message : String(err)}`);
    }

    // Strategy 3: Try @huggingface/transformers (already a project dependency)
    try {
      const transformers = await import(/* webpackIgnore: true */ "@huggingface/transformers") as any;
      const pipeline = transformers.pipeline;
      console.log(`[LocalLLM] Loading model with @huggingface/transformers from: ${modelDir}`);
      this.generator = await pipeline("text-generation", modelDir, {
        dtype: "q4",
        device: "cpu",
      });
      console.log(`[LocalLLM] Model loaded via @huggingface/transformers`);
      return;
    } catch (err) {
      console.log(`[LocalLLM] @huggingface/transformers text-generation failed: ${err instanceof Error ? err.message : String(err)}`);
    }

    throw new Error(
      "No ONNX inference engine available. Install one of:\n" +
      "  - onnxruntime-genai (recommended): pnpm add onnxruntime-genai\n" +
      "  - onnxruntime-node: pnpm add onnxruntime-node\n" +
      "Or ensure @huggingface/transformers is installed."
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
