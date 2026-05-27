/**
 * LLM Dispatcher — LLM调用调度器
 * 
 * 统一管理LLM调用，支持任务类型定制的系统提示、重试策略、Token追踪和上下文注入。
 * 借鉴 Claude Code 的 LLM 交互模式：System Prompt → Context → Task → Response → Verify
 */

import { ServiceRegistry, EventBus } from "@evoclaw/core";
import type { SubTask, SubTaskResult, TaskType } from "./task-decomposer";

// ── Types ──────────────────────────────────────────────────

export interface LLMDispatchRequest {
  task: SubTask;
  systemPrompt?: string;
  additionalContext?: string;
  maxTokens?: number;
  temperature?: number;
  stream?: boolean;
}

export interface LLMDispatchResponse {
  content: string;
  model: string;
  tokenUsage: { input: number; output: number };
  durationMs: number;
  finishReason: string;
}

export interface LLMDispatchConfig {
  maxRetries: number;
  retryBaseDelayMs: number;
  defaultMaxTokens: number;
  defaultTemperature: number;
  defaultModel: string;
  timeoutMs: number;
}

export const DEFAULT_LLM_CONFIG: LLMDispatchConfig = {
  maxRetries: 3,
  retryBaseDelayMs: 1000,
  defaultMaxTokens: 4096,
  defaultTemperature: 0.3,
  defaultModel: "default",
  timeoutMs: 120000,
};

// ── System Prompt Templates ────────────────────────────────

const SYSTEM_PROMPTS: Record<string, string> = {
  code_generation: `你是一个高级编程助手。你的任务是生成高质量的代码实现。

工作原则:
1. 遵循项目现有的编码规范和架构模式
2. 编写清晰、可维护、有适当注释的代码
3. 包含必要的错误处理和边界条件检查
4. 确保类型安全（如适用）
5. 输出格式：先简要说明实现思路，然后给出完整代码

输出格式:
## 实现思路
[简要说明]

## 代码实现
\`\`\`typescript
// 代码
\`\`\`

## 注意事项
[任何需要注意的点]`,

  debugging: `你是一个专业的调试专家。你的任务是定位和修复代码中的bug。

工作原则:
1. 先分析错误信息和上下文，形成假设
2. 逐步验证假设，定位根本原因
3. 提供最小化的修复方案
4. 解释修复原理，确保不引入新问题

输出格式:
## 问题分析
[错误分析和根因定位]

## 修复方案
\`\`\`diff
// diff 格式的修复
\`\`\`

## 验证建议
[如何验证修复有效]`,

  code_review: `你是一个严格的代码审查专家。你的任务是审查代码质量并提供改进建议。

审查维度:
1. 正确性：逻辑是否正确，边界条件是否处理
2. 可读性：命名、结构、注释是否清晰
3. 性能：是否存在性能瓶颈
4. 安全性：是否存在安全风险
5. 可维护性：是否易于修改和扩展

输出格式:
## 审查摘要
[总体评价]

## 问题列表
- [严重程度] 问题描述 → 建议修复

## 改进建议
[具体改进建议]`,

  refactoring: `你是一个代码重构专家。你的任务是在保持行为不变的前提下改善代码结构。

重构原则:
1. 小步重构，每步可验证
2. 先测试后重构
3. 保持外部接口不变
4. 消除重复，提取抽象
5. 改善命名和可读性

输出格式:
## 重构计划
[步骤说明]

## 重构后代码
\`\`\`typescript
// 重构后的代码
\`\`\`

## 变更说明
[关键变更和理由]`,

  testing: `你是一个测试工程专家。你的任务是编写全面的测试用例。

测试原则:
1. 覆盖正常路径和异常路径
2. 测试边界条件
3. 使用有意义的测试描述
4. 遵循 AAA 模式 (Arrange-Act-Assert)
5. 测试应独立、可重复

输出格式:
## 测试策略
[测试范围和方法]

## 测试代码
\`\`\`typescript
// 测试代码
\`\`\`

## 覆盖说明
[测试覆盖的功能点]`,

  documentation: `你是一个技术文档专家。你的任务是编写清晰准确的技术文档。

文档原则:
1. 面向目标读者编写
2. 提供具体示例
3. 结构清晰，层次分明
4. 包含必要的警告和注意事项

输出格式:
## 概述
[简要说明]

## 使用方法
[具体用法和示例]

## API 参考
[接口说明]`,

  analysis: `你是一个技术分析专家。你的任务是深入分析技术问题和方案。

分析原则:
1. 基于事实和数据
2. 考虑多种方案和权衡
3. 给出明确的结论和建议
4. 识别风险和依赖

输出格式:
## 分析目标
[明确分析范围]

## 分析过程
[详细分析]

## 结论与建议
[明确结论和行动建议]`,

  deployment: `你是一个DevOps专家。你的任务是处理部署和发布相关的工作。

工作原则:
1. 确保部署流程可重复
2. 包含回滚方案
3. 验证部署结果
4. 记录变更

输出格式:
## 部署计划
[步骤说明]

## 执行命令
\`\`\`bash
# 部署命令
\`\`\`

## 验证步骤
[如何验证部署成功]`,

  project_setup: `你是一个项目架构专家。你的任务是搭建和配置项目结构。

工作原则:
1. 遵循社区最佳实践
2. 配置合理的默认值
3. 确保开发体验流畅
4. 考虑可扩展性

输出格式:
## 项目结构
[目录和文件说明]

## 配置文件
[关键配置]

## 初始化步骤
[设置命令]`,

  integration: `你是一个系统集成专家。你的任务是处理系统间的对接和集成。

工作原则:
1. 理解双方接口规范
2. 处理数据格式转换
3. 实现错误处理和重试
4. 确保接口兼容性

输出格式:
## 集成方案
[方案说明]

## 接口定义
[接口代码]

## 集成代码
\`\`\`typescript
// 集成实现
\`\`\``,
};

// ── LLM Dispatcher ─────────────────────────────────────────

export class LLMDispatcher {
  private config: LLMDispatchConfig;
  private callHistory: Array<{
    taskId: string;
    timestamp: Date;
    tokenUsage: { input: number; output: number };
    durationMs: number;
    success: boolean;
  }> = [];

  constructor(
    private registry?: ServiceRegistry,
    private eventBus?: EventBus,
    config?: Partial<LLMDispatchConfig>,
  ) {
    this.config = { ...DEFAULT_LLM_CONFIG, ...config };
  }

  /**
   * Dispatch an LLM call for a subtask.
   */
  async dispatch(request: LLMDispatchRequest): Promise<SubTaskResult> {
    const startTime = Date.now();
    const { task, additionalContext, maxTokens, temperature } = request;

    // Build the full prompt
    const systemPrompt = request.systemPrompt || this.getSystemPrompt(task.type);
    const taskPrompt = this.buildTaskPrompt(task, additionalContext);

    let lastError: Error | null = null;
    let attempt = 0;

    while (attempt <= this.config.maxRetries) {
      attempt++;

      try {
        const response = await this.callLLM(
          systemPrompt,
          taskPrompt,
          maxTokens ?? this.config.defaultMaxTokens,
          temperature ?? this.config.defaultTemperature,
        );

        const durationMs = Date.now() - startTime;

        // Record call history
        this.callHistory.push({
          taskId: task.id,
          timestamp: new Date(),
          tokenUsage: response.tokenUsage,
          durationMs,
          success: true,
        });

        // Parse the response into a SubTaskResult
        const result = this.parseResponse(response, task, durationMs);

        this.eventBus?.publish("claude-code-tools:llm-dispatched", {
          taskId: task.id,
          taskName: task.name,
          model: response.model,
          tokenUsage: response.tokenUsage,
          durationMs,
          attempt,
        }, "llm-dispatcher").catch(() => {});

        return result;
      } catch (err) {
        lastError = err instanceof Error ? err : new Error(String(err));

        this.callHistory.push({
          taskId: task.id,
          timestamp: new Date(),
          tokenUsage: { input: 0, output: 0 },
          durationMs: Date.now() - startTime,
          success: false,
        });

        if (attempt <= this.config.maxRetries) {
          const delay = this.config.retryBaseDelayMs * Math.pow(2, attempt - 1);
          await this.sleep(delay);
        }
      }
    }

    // All retries exhausted
    const durationMs = Date.now() - startTime;
    return {
      success: false,
      output: null,
      artifacts: [],
      issues: [lastError?.message || "LLM dispatch failed after all retries"],
      suggestions: ["检查网络连接", "确认模型配置正确", "尝试简化任务描述"],
      tokenUsage: { input: 0, output: 0 },
      durationMs,
    };
  }

  /**
   * Dispatch multiple tasks in parallel with concurrency control.
   */
  async dispatchParallel(
    requests: LLMDispatchRequest[],
    maxConcurrency: number = 3,
  ): Promise<SubTaskResult[]> {
    const results: SubTaskResult[] = [];
    const executing: Promise<void>[] = [];

    for (const request of requests) {
      const promise = this.dispatch(request).then(result => {
        results.push(result);
      });

      executing.push(promise);

      if (executing.length >= maxConcurrency) {
        await Promise.race(executing);
        // Remove completed promises
        for (let i = executing.length - 1; i >= 0; i--) {
          // Check if promise is settled by racing with an already resolved promise
          const settled = await Promise.race([
            executing[i].then(() => true, () => true),
            Promise.resolve(false),
          ]);
          if (settled) {
            executing.splice(i, 1);
          }
        }
      }
    }

    await Promise.all(executing);
    return results;
  }

  /**
   * Get the system prompt for a task type.
   */
  getSystemPrompt(taskType: TaskType | string): string {
    return SYSTEM_PROMPTS[taskType] || SYSTEM_PROMPTS.code_generation;
  }

  /**
   * Get call statistics.
   */
  getStats(): {
    totalCalls: number;
    successRate: number;
    totalInputTokens: number;
    totalOutputTokens: number;
    averageDurationMs: number;
  } {
    const total = this.callHistory.length;
    const successes = this.callHistory.filter(c => c.success).length;
    const totalInput = this.callHistory.reduce((sum, c) => sum + c.tokenUsage.input, 0);
    const totalOutput = this.callHistory.reduce((sum, c) => sum + c.tokenUsage.output, 0);
    const totalDuration = this.callHistory.reduce((sum, c) => sum + c.durationMs, 0);

    return {
      totalCalls: total,
      successRate: total > 0 ? successes / total : 0,
      totalInputTokens: totalInput,
      totalOutputTokens: totalOutput,
      averageDurationMs: total > 0 ? Math.round(totalDuration / total) : 0,
    };
  }

  // ── Private Methods ──────────────────────────────────────

  private async callLLM(
    systemPrompt: string,
    userPrompt: string,
    maxTokens: number,
    temperature: number,
  ): Promise<LLMDispatchResponse> {
    const startTime = Date.now();

    // Try to resolve the agent model executor from the service registry
    if (this.registry) {
      const executor = this.registry.resolveService<{
        execute(params: Record<string, unknown>): Promise<{ content: string; usage?: { promptTokens: number; completionTokens: number }; model?: string; finishReason?: string }>;
      }>("agentModelExecutor");

      if (executor) {
        const response = await executor.execute({
          prompt: userPrompt,
          systemPrompt,
          maxTokens,
          temperature,
          task: "code_task",
        });

        return {
          content: response.content,
          model: response.model || this.config.defaultModel,
          tokenUsage: {
            input: response.usage?.promptTokens || 0,
            output: response.usage?.completionTokens || 0,
          },
          durationMs: Date.now() - startTime,
          finishReason: response.finishReason || "stop",
        };
      }
    }

    // Fallback: return a placeholder response
    // In production, this would integrate with a direct LLM API
    throw new Error("No LLM executor available. Ensure agentModelExecutor is registered in ServiceRegistry.");
  }

  private buildTaskPrompt(task: SubTask, additionalContext?: string): string {
    const parts: string[] = [];

    parts.push(`# 任务: ${task.name}`);
    parts.push("");
    parts.push(task.description);
    parts.push("");

    if (task.acceptanceCriteria.length > 0) {
      parts.push("## 验收标准");
      for (const criteria of task.acceptanceCriteria) {
        parts.push(`- ${criteria}`);
      }
      parts.push("");
    }

    if (task.context && Object.keys(task.context).length > 0) {
      parts.push("## 上下文信息");
      for (const [key, value] of Object.entries(task.context)) {
        parts.push(`- ${key}: ${JSON.stringify(value)}`);
      }
      parts.push("");
    }

    if (additionalContext) {
      parts.push("## 附加上下文");
      parts.push(additionalContext);
      parts.push("");
    }

    return parts.join("\n");
  }

  private parseResponse(response: LLMDispatchResponse, task: SubTask, durationMs: number): SubTaskResult {
    const content = response.content;

    // Extract code artifacts from the response
    const artifacts = this.extractArtifacts(content);
    
    // Extract issues/warnings from the response
    const issues = this.extractIssues(content);

    // Extract suggestions
    const suggestions = this.extractSuggestions(content);

    return {
      success: true,
      output: content,
      artifacts,
      issues,
      suggestions,
      tokenUsage: response.tokenUsage,
      durationMs,
    };
  }

  private extractArtifacts(content: string): string[] {
    const artifacts: string[] = [];
    // Extract file paths from code blocks
    const fileMatch = content.match(/(?:文件|file|path):\s*`?([^\s`]+\.\w+)`?/gi);
    if (fileMatch) {
      artifacts.push(...fileMatch.map(m => m.replace(/^(?:文件|file|path):\s*`?/i, "").replace(/`$/, "")));
    }
    // Extract code block language+content indicators
    const codeBlocks = content.match(/```\w+\n[\s\S]*?```/g);
    if (codeBlocks) {
      artifacts.push(`${codeBlocks.length} code blocks generated`);
    }
    return artifacts;
  }

  private extractIssues(content: string): string[] {
    const issues: string[] = [];
    const issuePatterns = [
      /(?:注意|warning|caution|issue|问题)[:：]\s*(.+)/gi,
      /(?:⚠️|⚠)\s*(.+)/g,
    ];
    for (const pattern of issuePatterns) {
      let match;
      while ((match = pattern.exec(content)) !== null) {
        issues.push(match[1].trim().substring(0, 200));
      }
    }
    return issues;
  }

  private extractSuggestions(content: string): string[] {
    const suggestions: string[] = [];
    const suggestionPatterns = [
      /(?:建议|suggestion|recommend)[:：]\s*(.+)/gi,
    ];
    for (const pattern of suggestionPatterns) {
      let match;
      while ((match = pattern.exec(content)) !== null) {
        suggestions.push(match[1].trim().substring(0, 200));
      }
    }
    return suggestions;
  }

  private sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }
}
