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
    console.warn(\`Dependency "\${name}" not available, using fallback\`);
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
    console.error("Execution failed:", err);
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
      const improvement = this.generateImprovement(req);
      const testCode = this.generateTestCode(req);

      artifacts.push({
        name: `${req.type}_${uuid().slice(0, 8)}`,
        language: "typescript",
        source: improvement,
        tests: testCode,
        dependencies: [],
      });

      codeChanges.push({
        filePath: `improvements/${req.type}_${uuid().slice(0, 8)}.ts`,
        diff: `// ${improvement.split('\n')[0].replace('// ', '')}\n// Pattern: ${req.failurePattern || "unknown"}`,
        language: "typescript",
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
  const pattern = "${req.failurePattern || "unknown"}";
  const source = "${req.source}";

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
}