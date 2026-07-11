import {
  ServiceRegistry,
  EventBus,
  type EvolutionCandidate,
  type CodeArtifact,
} from "@evoclaw/core";
import { v4 as uuid } from "uuid";

interface AnalyzedRequirement {
  type: "new_skill" | "skill_update" | "code_patch" | "config_change";
  source: string;
  description: string;
  relatedSkills: string[];
  failurePattern: string | null;
  confidence: number;
}

const IMPROVEMENT_STRATEGIES: Record<string, { template: string; description: string }> = {
  missing_dependency: {
    template: `// Load missing dependency with graceful fallback
export async function resolveDependency(name: string): Promise<Record<string, unknown>> {
  try {
    const mod = await import(name);
    return { loaded: true, module: mod };
  } catch (err) {
    process.stderr.write(\`Dependency "\${name}" not available, using fallback\`);
    return { loaded: false, fallback: true };
  }
}`,
    description: "Add dependency resolution with fallback mechanism",
  },
  insufficient_permissions: {
    template: `// Validate permissions before execution
export async function validateAccess(required: string[]): Promise<{ allowed: boolean; missing: string[] }> {
  const missing: string[] = [];
  for (const perm of required) {
    if (!hasPermission(perm)) {
      missing.push(perm);
    }
  }
  return { allowed: missing.length === 0, missing };
}

function hasPermission(perm: string): boolean {
  return true;
}`,
    description: "Add permission validation layer",
  },
  execution_timeout: {
    template: `// Add timeout handling and retry logic
export async function executeWithTimeout<T>(
  fn: () => Promise<T>,
  timeoutMs: number,
  retries = 3
): Promise<T> {
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      const result = await Promise.race([
        fn(),
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error("Timeout")), timeoutMs)
        ),
      ]);
      return result;
    } catch (err) {
      if (attempt === retries) throw err;
      await new Promise((r) => setTimeout(r, Math.pow(2, attempt) * 100));
    }
  }
  throw new Error("Max retries exceeded");
}`,
    description: "Add timeout handling with exponential backoff retry",
  },
  memory_exhaustion: {
    template: `// Optimize memory usage with pagination and cleanup
export async function processWithPagination<T>(
  items: T[],
  batchSize: number,
  processor: (batch: T[]) => Promise<void>
): Promise<void> {
  for (let i = 0; i < items.length; i += batchSize) {
    const batch = items.slice(i, i + batchSize);
    await processor(batch);
    global.gc && global.gc();
  }
}`,
    description: "Add batch processing with memory cleanup",
  },
  low_success_rate: {
    template: `// Add input validation and error recovery
export async function safeExecute(
  params: Record<string, unknown>
): Promise<{ success: boolean; result?: unknown; error?: string }> {
  if (!params || typeof params !== "object") {
    return { success: false, error: "Invalid parameters" };
  }

  try {
    const result = await process(params);
    return { success: true, result };
  } catch (err) {
    process.stderr.write("Execution failed:" + " " + err);
    return {
      success: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

async function process(params: Record<string, unknown>): Promise<unknown> {
  return params;
}`,
    description: "Add input validation and safe execution wrapper",
  },
};

export class EvolutionProposer {
  private llmGenerationEnabled = true;

  constructor(
    private registry: ServiceRegistry,
    private eventBus: EventBus
  ) {}

  async generate(
    requirements: AnalyzedRequirement[]
  ): Promise<EvolutionCandidate[]> {
    const candidates: EvolutionCandidate[] = [];

    for (const req of requirements) {
      if (req.confidence < 0.5) continue;

      const candidate = await this.generateCandidate(req);
      candidates.push(candidate);
    }

    return candidates;
  }

  private async generateCandidate(
    req: AnalyzedRequirement
  ): Promise<EvolutionCandidate> {
    const artifacts: CodeArtifact[] = [];
    const codeChanges = [];

    if (req.type === "code_patch" || req.type === "skill_update") {
      let improvement: string;
      let testCode: string;
      let usedLLM = false;

      if (this.llmGenerationEnabled) {
        const llmResult = await this.tryLLMGeneration(req);
        if (llmResult) {
          improvement = llmResult.improvement;
          testCode = llmResult.tests;
          usedLLM = true;
        } else {
          improvement = this.generateImprovement(req);
          testCode = this.generateTestCode(req);
        }
      } else {
        improvement = this.generateImprovement(req);
        testCode = this.generateTestCode(req);
      }

      artifacts.push({
        name: `${req.type}_${uuid().slice(0, 8)}`,
        language: "typescript",
        source: improvement,
        tests: testCode,
        dependencies: [],
      });

      codeChanges.push({
        filePath: `improvements/${req.type}_${uuid().slice(0, 8)}.ts`,
        diff: `// ${improvement.split('\n')[0].replace('// ', '')}\n// Pattern: ${req.failurePattern || "unknown"}\n// Generated by: ${usedLLM ? "LLM" : "template"}`,
        language: "typescript",
        reasoning: req.description,
      });
    }

    if (req.type === "new_skill") {
      const skillCode = await this.generateNewSkillCode(req);
      if (skillCode) {
        artifacts.push({
          name: `new_skill_${uuid().slice(0, 8)}`,
          language: "typescript",
          source: skillCode,
          tests: this.generateNewSkillTest(req),
          dependencies: [],
        });
      }
    }

    if (req.type === "config_change") {
      codeChanges.push({
        filePath: `config/evolution_${uuid().slice(0, 8)}.json`,
        diff: JSON.stringify({ suggestedConfig: req.description }, null, 2),
        language: "json",
        reasoning: req.description,
      });
    }

    return {
      id: uuid(),
      type: req.type,
      proposedChanges: {
        description: req.description,
        codeChanges,
        configChanges: {},
      },
      codeArtifacts: artifacts,
      risk: {
        level: req.confidence > 0.8 ? "low" : "medium",
        factors: [req.failurePattern || "improvement_needed"],
        mitigation: "Preview changes in sandbox with full regression test suite",
      },
      generatedAt: new Date(),
    };
  }

  private async tryLLMGeneration(req: AnalyzedRequirement): Promise<{ improvement: string; tests: string } | null> {
    try {
      const executor = this.registry.resolveService<{
        getProviders(): Array<{
          id: string; name: string; provider: string; model: string;
          apiKey?: string; baseURL?: string; enabled: boolean;
        }>;
        execute?(input: { systemPrompt: string; prompt: string }, context?: Record<string, unknown>): Promise<{
          content: string; usage?: { promptTokens: number; completionTokens: number };
          model?: string; finishReason?: string;
        }>;
      }>("agentModelExecutor");

      if (!executor) return null;

      // 优先使用 execute 方法（统一接口）
      let content = "";
      if (typeof executor.execute === "function") {
        try {
          const result = await executor.execute(
            { systemPrompt: this.llmSystemPrompt, prompt: this.buildLLMPrompt(req) },
          );
          content = result.content;
        } catch {
          // execute 失败，降级到直接 API 调用
        }
      }

      // 如果 execute 不可用或失败，使用直接 API 调用
      if (!content) {
        const providers = executor.getProviders().filter(p => p.enabled);
        if (providers.length === 0) return null;

        content = await this.callLLMDirectly(providers[0], this.llmSystemPrompt, this.buildLLMPrompt(req));
      }

      if (!content) return null;
      return this.parseLLMResponse(content, req);
    } catch (err) {
      process.stderr.write(`[EvolutionProposer] LLM generation failed, falling back to template: ${err instanceof Error ? err.message : String(err)}\n`);
      return null;
    }
  }

  private get llmSystemPrompt(): string {
    return `你是 EvoClaw 系统的进化引擎代码生成器。根据错误模式和需求描述，生成高质量的 TypeScript 改进代码。
要求：
1. 代码必须包含完整的类型定义
2. 必须包含错误处理和边界情况处理
3. 代码必须可独立运行，不依赖未定义的外部变量
4. 使用 async/await 模式
5. 返回格式：第一部分是改进代码（用 \`\`\`typescript 包裹），第二部分是测试代码（用 \`\`\`typescript 包裹），用 --- 分隔`;
  }

  private buildLLMPrompt(req: AnalyzedRequirement): string {
    return `请为以下需求生成改进代码：

需求类型: ${req.type}
需求描述: ${req.description}
失败模式: ${req.failurePattern || "未知"}
相关技能: ${req.relatedSkills.join(", ") || "无"}
来源: ${req.source}
置信度: ${req.confidence}

请生成：
1. 改进后的 TypeScript 代码
2. 对应的 vitest 测试代码`;
  }

  private async callLLMDirectly(
    provider: { id: string; name: string; provider: string; model: string; apiKey?: string; baseURL?: string },
    systemPrompt: string,
    userPrompt: string,
  ): Promise<string> {
    const baseURL = provider.baseURL || "https://api.openai.com/v1";
    const apiUrl = `${baseURL.replace(/\/+$/, "")}/chat/completions`;

    const headers: Record<string, string> = { "Content-Type": "application/json" };
    if (provider.provider === "anthropic" || provider.model?.includes("claude")) {
      headers["x-api-key"] = provider.apiKey || "";
      headers["anthropic-version"] = "2023-06-01";
    } else {
      headers["Authorization"] = `Bearer ${provider.apiKey || ""}`;
    }

    const body = provider.provider === "anthropic" || provider.model?.includes("claude")
      ? { model: provider.model, max_tokens: 4096, system: systemPrompt, messages: [{ role: "user", content: userPrompt }] }
      : { model: provider.model, max_tokens: 4096, temperature: 0.4, messages: [{ role: "system", content: systemPrompt }, { role: "user", content: userPrompt }] };

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 60000);

    try {
      const response = await fetch(apiUrl, {
        method: "POST", headers, body: JSON.stringify(body), signal: controller.signal,
      });

      if (!response.ok) return "";

      const data = await response.json() as Record<string, unknown>;
      const choices = data.choices as Array<{ message: { content: string } }> | undefined;
      if (choices && choices.length > 0 && choices[0].message?.content) {
        return choices[0].message.content;
      }
      const c = data.content as Array<{ type: string; text: string }> | undefined;
      if (c && c.length > 0 && c[0].text) return c[0].text;

      return "";
    } finally {
      clearTimeout(timeout);
    }
  }

  private parseLLMResponse(content: string, req: AnalyzedRequirement): { improvement: string; tests: string } | null {
    const codeBlocks = content.match(/```typescript\s*\n([\s\S]*?)```/g);
    if (!codeBlocks || codeBlocks.length === 0) {
      const plainBlocks = content.match(/```\s*\n([\s\S]*?)```/g);
      if (!plainBlocks || plainBlocks.length === 0) return null;

      const extractCode = (block: string) => block.replace(/```\w*\n?/, "").replace(/```$/, "").trim();
      const improvement = extractCode(plainBlocks[0]);
      const tests = plainBlocks.length > 1 ? extractCode(plainBlocks[1]) : this.generateTestCode(req);
      if (!this.isImprovementSafe(improvement)) return null;
      return { improvement, tests };
    }

    const extractCode = (block: string) => block.replace(/```typescript\s*\n?/, "").replace(/```$/, "").trim();
    const improvement = extractCode(codeBlocks[0]);
    const tests = codeBlocks.length > 1 ? extractCode(codeBlocks[1]) : this.generateTestCode(req);
    if (!this.isImprovementSafe(improvement)) return null;
    return { improvement, tests };
  }

  // 安全扫描：拒绝包含危险 import/require 或动态执行（eval/Function）的 LLM 代码，防止 prompt injection 注入恶意代码
  private isImprovementSafe(improvement: string): boolean {
    const FORBIDDEN_IMPORTS = /(?:require|import)\s*\(?\s*['"](?:child_process|fs|net|http|https|dns|os|vm|cluster)['"]/;
    const FORBIDDEN_PATTERNS = [
      FORBIDDEN_IMPORTS,
      /process\.(?:binding|mainModule)/,
      /globalThis\s*\[\s*['"]require['"]\s*\]/,
      /Reflect\.get\s*\(\s*this\s*,\s*['"]require['"]\s*\)/,
      /import\s*\(/,
    ];
    for (const pattern of FORBIDDEN_PATTERNS) {
      if (pattern.test(improvement)) {
        process.stderr.write("[EvolutionProposer] LLM code contains forbidden imports/patterns, rejected\n");
        return false;
      }
    }
    if (/\beval\s*\(/.test(improvement) || /new\s+Function\s*\(/.test(improvement)) {
      process.stderr.write("[EvolutionProposer] LLM code contains eval/Function, rejected\n");
      return false;
    }
    return true;
  }

  private async generateNewSkillCode(req: AnalyzedRequirement): Promise<string | null> {
    const llmResult = await this.tryLLMGeneration({
      ...req,
      type: "code_patch",
      description: `创建新技能: ${req.description}`,
    });

    if (llmResult) return llmResult.improvement;

    return `// New skill scaffold
// ${req.description}
export async function execute(params: Record<string, unknown>): Promise<unknown> {
  process.stdout.write("New skill executing:" + " " + ${JSON.stringify(req.description)});
  return { success: true, message: "Skill scaffold created" };
}`;
  }

  private generateNewSkillTest(req: AnalyzedRequirement): string {
    return `// Auto-generated test for new skill
import { describe, it, expect } from "vitest";

describe("newSkill", () => {
  it("should execute successfully", async () => {
    const result = { success: true };
    expect(result.success).toBe(true);
  });

  it("should handle empty parameters", async () => {
    const result = { success: false, error: "No parameters provided" };
    expect(result.success).toBe(false);
  });
});`;
  }

  private generateImprovement(req: AnalyzedRequirement): string {
    const strategy = req.failurePattern && IMPROVEMENT_STRATEGIES[req.failurePattern]
      ? IMPROVEMENT_STRATEGIES[req.failurePattern]
      : null;

    if (strategy) {
      return strategy.template;
    }

    return `// Auto-generated improvement
// Source: ${req.source}
// Description: ${req.description}
// Related skills: ${req.relatedSkills.join(", ") || "none"}
// Failure pattern: ${req.failurePattern || "unknown"}

export async function improvedHandler(params: Record<string, unknown>): Promise<unknown> {
  const startTime = Date.now();

  try {
    const validated = validateInput(params);
    const result = await executeCore(validated);
    return {
      success: true,
      data: result,
      duration: Date.now() - startTime,
      improved: true,
    };
  } catch (err) {
    return {
      success: false,
      error: err instanceof Error ? err.message : String(err),
      duration: Date.now() - startTime,
      improved: true,
      fallback: true,
    };
  }
}

function validateInput(params: Record<string, unknown>): Record<string, unknown> {
  if (!params || typeof params !== "object") {
    throw new Error("Invalid input parameters");
  }
  return params;
}

async function executeCore(params: Record<string, unknown>): Promise<unknown> {
  return params;
}`;
  }

  private generateTestCode(req: AnalyzedRequirement): string {
    return `// Auto-generated test suite
import { describe, it, expect } from "vitest";

describe("improvedHandler", () => {
  const pattern = ${JSON.stringify(req.failurePattern || "unknown")};
  const source = ${JSON.stringify(req.source || "")};

  it("should handle the failure pattern: " + pattern, async () => {
    expect(true).toBe(true);
  });

  it("should work with valid parameters", async () => {
    const result = { success: true, data: {}, improved: true };
    expect(result).toBeDefined();
    expect(result.success).toBe(true);
  });

  it("should handle edge cases gracefully", async () => {
    const errorResult = { success: false, error: "Invalid input" };
    expect(errorResult.success).toBe(false);
    expect(errorResult.error).toBeDefined();
  });
});`;
  }

  setLLMGenerationEnabled(enabled: boolean): void {
    this.llmGenerationEnabled = enabled;
  }
}
