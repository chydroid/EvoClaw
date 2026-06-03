import {
  ServiceRegistry,
  EventBus,
  SystemEvents,
  type EvolutionInput,
} from "@evoclaw/core";

interface AnalyzedRequirement {
  type: "new_skill" | "skill_update" | "code_patch" | "config_change";
  source: EvolutionInput["triggerEvent"];
  description: string;
  relatedSkills: string[];
  failurePattern: string | null;
  confidence: number;
  /** LLM 增强分析结果（如果可用） */
  llmAnalysis?: string;
  /** 子任务拆解（LLM 生成） */
  subTasks?: string[];
}

const FAILURE_PATTERNS = [
  { regex: /dependency\s*["']?(\w+)["']?\s*not found/i, pattern: "missing_dependency" },
  { regex: /permission denied/i, pattern: "insufficient_permissions" },
  { regex: /timeout/i, pattern: "execution_timeout" },
  { regex: /out of memory/i, pattern: "memory_exhaustion" },
  { regex: /syntax\s*error/i, pattern: "syntax_error" },
  { regex: /type\s*error/i, pattern: "type_error" },
  { regex: /reference\s*error/i, pattern: "reference_error" },
  { regex: /network\s*error/i, pattern: "network_failure" },
  { regex: /\bENOENT\b/, pattern: "missing_file" },
  { regex: /undefined is not/i, pattern: "null_reference" },
  { regex: /cannot read propert/i, pattern: "null_reference" },
  { regex: /is not a function/i, pattern: "type_error" },
  { regex: /unexpected token/i, pattern: "syntax_error" },
  { regex: /connection refused/i, pattern: "network_failure" },
  { regex: /rate limit/i, pattern: "rate_limited" },
] as const;

const LLM_REQUIREMENT_ANALYSIS_PROMPT = `你是 EvoClaw 自进化引擎的需求分析专家。
请分析以下执行失败日志和上下文，提取关键信息：

## 分析要求
1. 识别失败的根本原因和模式
2. 判断需要哪种类型的改进（skill_update/code_patch/new_skill/config_change）
3. 将任务拆解为可执行的子任务（2-5个步骤）
4. 评估置信度（0-1）

## 返回 JSON 格式
{
  "type": "skill_update|code_patch|new_skill|config_change",
  "description": "需求描述",
  "failurePattern": "失败模式标识",
  "confidence": 0.0-1.0,
  "subTasks": ["子任务1", "子任务2", ...],
  "analysis": "详细分析"
}`;

export class RequirementMiner {
  private observedPatterns = new Map<string, number>();
  private llmEnabled = true;

  constructor(
    private registry: ServiceRegistry,
    private eventBus: EventBus
  ) {
    this.eventBus.subscribe(SystemEvents.SKILL_FAILED, async (event) => {
      const data = event.data as Record<string, unknown>;
      if (data?.skillId) {
        this.observeFailure(String(data.skillId));
      }
    });
  }

  async analyze(input: EvolutionInput): Promise<AnalyzedRequirement[]> {
    const requirements: AnalyzedRequirement[] = [];

    // 第一阶段：正则模式匹配（快速筛选）
    for (const log of input.failureLogs) {
      const pattern = this.extractFailurePattern(log);
      if (pattern) {
        requirements.push({
          type: "skill_update",
          source: input.triggerEvent,
          description: `Detected failure pattern: ${pattern}`,
          relatedSkills: input.relatedSkills,
          failurePattern: pattern,
          confidence: input.successRate < 0.5 ? 0.8 : 0.4,
        });
      }
    }

    if (requirements.length === 0 && input.successRate < 0.3) {
      requirements.push({
        type: "code_patch",
        source: input.triggerEvent,
        description: "Low success rate detected, generating improvement candidate",
        relatedSkills: input.relatedSkills,
        failurePattern: "low_success_rate",
        confidence: 0.6,
      });
    }

    // 第二阶段：尝试 LLM 增强分析（补充/修正正则结果）
    if (this.llmEnabled && input.failureLogs.length > 0) {
      try {
        const llmResults = await this.analyzeWithLLM(input);
        // 合并 LLM 结果与正则结果
        for (const llm of llmResults) {
          const existing = requirements.find(
            (r) => r.failurePattern === llm.failurePattern
          );
          if (existing) {
            // 用 LLM 结果增强已有条目
            existing.description = llm.description || existing.description;
            existing.confidence = Math.max(existing.confidence, llm.confidence);
            existing.subTasks = llm.subTasks;
            existing.llmAnalysis = llm.llmAnalysis;
          } else if (llm.confidence >= 0.5) {
            requirements.push(llm);
          }
        }
      } catch (err) {
        console.warn(
          "[RequirementMiner] LLM analysis failed, using regex-only results:",
          err instanceof Error ? err.message : String(err)
        );
      }
    }

    return requirements;
  }

  /**
   * 使用 LLM 进行深度需求分析
   */
  async analyzeWithLLM(input: EvolutionInput): Promise<AnalyzedRequirement[]> {
    const executor = this.resolveLLMExecutor();
    if (!executor) return [];

    const logsText = input.failureLogs.slice(0, 5).join("\n");
    const context = JSON.stringify(input.context, null, 2).slice(0, 1500);

    const prompt = `${LLM_REQUIREMENT_ANALYSIS_PROMPT}\n\n## 失败日志\n${logsText}\n\n## 上下文\n${context}\n\n## 触发源\n${input.triggerEvent}\n\n## 关联技能\n${input.relatedSkills.join(", ")}`;

    try {
      const result = await executor.execute(
        {
          systemPrompt:
            "你是自进化引擎的需求分析专家。只返回有效的 JSON，不要添加额外解释。",
          prompt,
        }
      );

      const jsonMatch = result.content.match(/\{[\s\S]*\}/);
      if (!jsonMatch) return [];

      const parsed = JSON.parse(jsonMatch[0]) as Partial<AnalyzedRequirement> & {
        analysis?: string;
        subTasks?: string[];
      };

      // 验证类型
      const validTypes: AnalyzedRequirement["type"][] = [
        "new_skill",
        "skill_update",
        "code_patch",
        "config_change",
      ];

      if (!validTypes.includes(parsed.type as AnalyzedRequirement["type"])) {
        return [];
      }

      return [
        {
          type: parsed.type as AnalyzedRequirement["type"],
          source: input.triggerEvent,
          description: parsed.description || `LLM analysis for ${input.triggerEvent}`,
          relatedSkills: input.relatedSkills,
          failurePattern: parsed.failurePattern || "llm_detected",
          confidence: typeof parsed.confidence === "number"
            ? Math.max(0, Math.min(1, parsed.confidence))
            : 0.5,
          subTasks: Array.isArray(parsed.subTasks)
            ? parsed.subTasks.filter((s): s is string => typeof s === "string")
            : undefined,
          llmAnalysis: parsed.analysis,
        },
      ];
    } catch {
      return [];
    }
  }

  /**
   * 启用/禁用 LLM 增强分析
   */
  setLLMEnabled(enabled: boolean): void {
    this.llmEnabled = enabled;
  }

  observePattern(userIntent: string): void {
    const count = this.observedPatterns.get(userIntent) || 0;
    this.observedPatterns.set(userIntent, count + 1);

    if (count + 1 >= 5) {
      console.log(`[RequirementMiner] Pattern detected: "${userIntent}" has ${count + 1} occurrences`);
    }
  }

  getFrequentPatterns(threshold = 3): string[] {
    const results: string[] = [];
    for (const [pattern, count] of this.observedPatterns) {
      if (count >= threshold) {
        results.push(pattern);
      }
    }
    return results;
  }

  private observeFailure(skillId: string): void {
    const key = `failure:${skillId}`;
    this.observedPatterns.set(key, (this.observedPatterns.get(key) || 0) + 1);
  }

  private extractFailurePattern(log: string): string | null {
    for (const { regex, pattern } of FAILURE_PATTERNS) {
      if (regex.test(log)) {
        return pattern;
      }
    }
    return null;
  }

  private resolveLLMExecutor(): LLMExecutor | null {
    try {
      const executor = this.registry.resolveService<LLMExecutor>("agentModelExecutor");
      if (!executor || typeof executor.execute !== "function") return null;
      return executor;
    } catch {
      return null;
    }
  }
}

interface LLMExecutor {
  execute(
    input: { systemPrompt: string; prompt: string },
    context?: Record<string, unknown>
  ): Promise<{ content: string }>;
}