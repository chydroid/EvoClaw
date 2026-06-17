// Type declarations for optional dependencies
// These packages may not be installed, but we import them dynamically at runtime

declare module "onnxruntime-genai" {
  export class Generator {
    static create(modelDir: string): Promise<Generator>;
    generate(prompt: string, options?: Record<string, unknown>): Promise<string | Array<{ generated_text?: string; content?: string }>>;
    dispose(): void;
  }
}

declare module "onnxruntime-node" {
  const ort: any;
  export default ort;
  export const InferenceSession: any;
}

declare module "@huggingface/transformers" {
  export function pipeline(
    task: string,
    model: string,
    options?: Record<string, unknown>
  ): Promise<any>;

  export const AutoModelForCausalLM: {
    from_pretrained(modelId: string, options?: Record<string, unknown>): Promise<any>;
  };

  export const AutoTokenizer: {
    from_pretrained(modelId: string, options?: Record<string, unknown>): Promise<any>;
  };

  export const TextGenerationPipeline: any;
}
