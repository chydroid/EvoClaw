/**
 * ACP (Agent Delegation Protocol) - Agent 委派协议
 *
 * 受 OpenClaw ACP 启发，实现任务委派到外部代理（如 Claude Code、Codex 等代理框架）。
 * 支持代理注册、能力匹配、任务委派、超时控制和委派历史追踪。
 */

// ─── Interfaces ────────────────────────────────────────────────────────────────

/** ACP 代理描述 */
export interface ACPAgent {
  /** 唯一代理标识 */
  id: string;
  /** 显示名称 */
  name: string;
  /** 能力描述 */
  description: string;
  /** 远程端点 URL（可选，本地代理不需要） */
  endpoint?: string;
  /** 能力标签列表 */
  capabilities: string[];
  /** 代理当前状态 */
  status: "available" | "busy" | "offline";
  /** 附加元数据 */
  metadata?: Record<string, unknown>;
}

/** ACP 委派请求 */
export interface ACPDelegationRequest {
  /** 请求唯一 ID */
  id: string;
  /** 委派方代理 ID */
  fromAgent: string;
  /** 被委派方代理 ID */
  toAgent: string;
  /** 任务描述 */
  task: string;
  /** 附加上下文 */
  context?: Record<string, unknown>;
  /** 优先级 */
  priority: "low" | "normal" | "high";
  /** 超时时间（毫秒），默认 60000 */
  timeoutMs: number;
  /** 创建时间戳 */
  createdAt: number;
}

/** ACP 委派结果 */
export interface ACPDelegationResult {
  /** 对应的请求 ID */
  requestId: string;
  /** 是否成功 */
  success: boolean;
  /** 代理输出结果 */
  result?: unknown;
  /** 错误信息 */
  error?: string;
  /** 执行耗时（毫秒） */
  duration: number;
  /** 执行代理 ID */
  delegateAgent: string;
  /** 附加元数据 */
  metadata?: Record<string, unknown>;
}

// ─── Internal types ────────────────────────────────────────────────────────────

interface PendingDelegation {
  request: ACPDelegationRequest;
  resolve: (result: ACPDelegationResult) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

// ─── Built-in agents ───────────────────────────────────────────────────────────

const BUILTIN_AGENTS: ACPAgent[] = [
  {
    id: "code-generator",
    name: "Code Generator",
    description: "Generates code, implements features, and debugs programming issues",
    capabilities: ["code-generation", "programming", "debugging"],
    status: "available",
  },
  {
    id: "code-reviewer",
    name: "Code Reviewer",
    description: "Reviews code for quality, best practices, and potential issues",
    capabilities: ["code-review", "quality-check", "best-practices"],
    status: "available",
  },
  {
    id: "web-researcher",
    name: "Web Researcher",
    description: "Searches the web, retrieves information, and summarizes findings",
    capabilities: ["web-research", "information-retrieval", "summarization"],
    status: "available",
  },
  {
    id: "data-analyst",
    name: "Data Analyst",
    description: "Analyzes data, creates visualizations, and performs statistical computations",
    capabilities: ["data-analysis", "visualization", "statistics"],
    status: "available",
  },
];

// ─── Keyword matching helpers ──────────────────────────────────────────────────

/** 将文本拆分为小写关键词集合 */
function extractKeywords(text: string): Set<string> {
  return new Set(
    text
      .toLowerCase()
      .replace(/[^a-z0-9\s-]/g, " ")
      .split(/\s+/)
      .filter((w) => w.length > 1),
  );
}

/** 计算关键词与代理能力/描述的匹配分数 */
function computeMatchScore(
  taskKeywords: Set<string>,
  requiredCapabilities: string[] | undefined,
  agent: ACPAgent,
): number {
  let score = 0;

  // 必需能力精确匹配（权重最高）
  if (requiredCapabilities && requiredCapabilities.length > 0) {
    const agentCapSet = new Set(agent.capabilities.map((c) => c.toLowerCase()));
    const matchedRequired = requiredCapabilities.filter((c) => agentCapSet.has(c.toLowerCase()));
    if (matchedRequired.length === 0) {
      return -1; // 不满足任何必需能力，直接排除
    }
    score += (matchedRequired.length / requiredCapabilities.length) * 50;
  }

  // 任务关键词与能力标签匹配
  for (const cap of agent.capabilities) {
    const capLower = cap.toLowerCase();
    if (taskKeywords.has(capLower)) {
      score += 10;
    }
    // 能力标签中的子词匹配（如 "code-generation" 拆为 "code" 和 "generation"）
    const capParts = capLower.split(/[-_]/);
    for (const part of capParts) {
      if (part.length > 1 && taskKeywords.has(part)) {
        score += 5;
      }
    }
  }

  // 任务关键词与描述匹配
  const descKeywords = extractKeywords(agent.description);
  for (const kw of taskKeywords) {
    if (descKeywords.has(kw)) {
      score += 3;
    }
  }

  return score;
}

// ─── Local delegation execution ────────────────────────────────────────────────

/** 本地代理的委派执行，基于能力匹配返回结构化委派结果 */
function executeLocalDelegation(
  request: ACPDelegationRequest,
  agent: ACPAgent,
): ACPDelegationResult {
  const startTime = Date.now();
  try {
    // Try to find and execute relevant tools from the agent's capabilities
    const taskLower = request.task.toLowerCase();
    let result: unknown = null;

    // Map agent capabilities to tool names
    const capabilityToolMap: Record<string, string[]> = {
      "code-generation": ["write_file", "create_file", "code_generate"],
      "programming": ["write_file", "execute_code", "run_command"],
      "debugging": ["read_file", "execute_code", "run_command"],
      "code-review": ["read_file", "diff", "git_status"],
      "quality-check": ["read_file", "lint", "test"],
      "best-practices": ["read_file", "search", "web_search"],
      "web-research": ["web_search", "web_fetch", "search"],
      "information-retrieval": ["web_search", "web_fetch", "search"],
      "summarization": ["web_fetch", "read_file"],
      "data-analysis": ["execute_code", "read_file", "web_fetch"],
      "visualization": ["execute_code", "write_file"],
      "statistics": ["execute_code", "read_file"],
    };

    // Find matching tools for this agent's capabilities
    const relevantTools: string[] = [];
    for (const cap of agent.capabilities) {
      const tools = capabilityToolMap[cap];
      if (tools) relevantTools.push(...tools);
    }

    // Return a structured delegation result with task context and suggested tools
    result = {
      delegated: true,
      agent: agent.name,
      task: request.task,
      suggestedTools: [...new Set(relevantTools)],
      status: "delegated",
      message: `Task delegated to ${agent.name}. Use suggested tools to execute: ${[...new Set(relevantTools)].join(", ")}`,
    };

    return {
      requestId: request.id,
      success: true,
      result,
      duration: Date.now() - startTime,
      delegateAgent: agent.id,
    };
  } catch (err) {
    return {
      requestId: request.id,
      success: false,
      error: err instanceof Error ? err.message : String(err),
      duration: Date.now() - startTime,
      delegateAgent: agent.id,
    };
  }
}

// ─── ACPProtocolHandler ────────────────────────────────────────────────────────

/**
 * ACP 协议处理器 - 管理代理注册、能力匹配、任务委派和结果追踪
 */
export class ACPProtocolHandler {
  private readonly agents = new Map<string, ACPAgent>();
  private readonly history: ACPDelegationResult[] = [];
  private readonly maxHistory = 1000;
  private readonly pending = new Map<string, PendingDelegation>();
  private idCounter = 0;

  constructor(registerBuiltins = true) {
    if (registerBuiltins) {
      for (const agent of BUILTIN_AGENTS) {
        this.agents.set(agent.id, { ...agent });
      }
    }
  }

  // ── Agent Management ──────────────────────────────────────────────────────

  /** 注册一个可委派的代理 */
  registerAgent(agent: ACPAgent): void {
    this.agents.set(agent.id, { ...agent });
  }

  /** 注销代理 */
  unregisterAgent(agentId: string): void {
    this.agents.delete(agentId);
  }

  /** 列出所有已注册代理 */
  listAgents(): ACPAgent[] {
    return Array.from(this.agents.values()).map((a) => ({ ...a }));
  }

  // ── Delegate Discovery ────────────────────────────────────────────────────

  /**
   * 根据任务描述和所需能力，找到最合适的委派代理
   *
   * 匹配策略：
   * 1. 若指定 requiredCapabilities，代理必须至少满足一项
   * 2. 按任务关键词与代理能力/描述的匹配度评分
   * 3. 可用代理优先于忙碌代理，离线代理不参与
   * 4. 无合适代理时返回 null
   */
  findBestDelegate(
    task: string,
    requiredCapabilities?: string[],
  ): ACPAgent | null {
    const taskKeywords = extractKeywords(task);
    let bestAgent: ACPAgent | null = null;
    let bestScore = -1;

    for (const agent of this.agents.values()) {
      // 离线代理不参与匹配
      if (agent.status === "offline") continue;

      const score = computeMatchScore(taskKeywords, requiredCapabilities, agent);
      if (score < 0) continue; // 不满足必需能力

      // 可用代理加分
      const adjustedScore = score + (agent.status === "available" ? 20 : 0);

      if (adjustedScore > bestScore) {
        bestScore = adjustedScore;
        bestAgent = agent;
      }
    }

    return bestAgent ? { ...bestAgent } : null;
  }

  // ── Delegation Execution ──────────────────────────────────────────────────

  /**
   * 委派任务到最合适的代理
   *
   * 流程：
   * 1. 查找最佳代理（若 toAgent 已指定则直接使用）
   * 2. 执行委派（本地代理直接调用，远程代理需 HTTP）
   * 3. 超时控制
   * 4. 记录结果到历史
   */
  async delegate(
    request: Omit<ACPDelegationRequest, "id" | "createdAt">,
  ): Promise<ACPDelegationResult> {
    const fullRequest: ACPDelegationRequest = {
      ...request,
      id: this.generateId(),
      createdAt: Date.now(),
    };

    // 确定目标代理
    let targetAgent = this.agents.get(request.toAgent);
    if (!targetAgent) {
      // 如果指定了 toAgent 但不存在，尝试自动匹配
      const delegate = this.findBestDelegate(request.task);
      if (!delegate) {
        const result: ACPDelegationResult = {
          requestId: fullRequest.id,
          success: false,
          error: `No suitable delegate agent found for task: "${request.task}"`,
          duration: 0,
          delegateAgent: request.toAgent,
        };
        this.history.push(result);

        if (this.history.length > this.maxHistory) this.history.splice(0, this.history.length - this.maxHistory);
        return result;
      }
      targetAgent = this.agents.get(delegate.id);
      fullRequest.toAgent = delegate.id;
    }

    if (targetAgent!.status === "offline") {
      const result: ACPDelegationResult = {
        requestId: fullRequest.id,
        success: false,
        error: `Agent "${targetAgent!.id}" is offline`,
        duration: 0,
        delegateAgent: targetAgent!.id,
      };
      this.history.push(result);

      if (this.history.length > this.maxHistory) this.history.splice(0, this.history.length - this.maxHistory);
      return result;
    }

    // 标记为忙碌
    targetAgent!.status = "busy";

    const startTime = Date.now();

    try {
      const result = await this.executeWithTimeout(
        targetAgent!,
        fullRequest,
        request.timeoutMs,
      );
      return result;
    } finally {
      // 恢复为可用
      if (this.agents.has(targetAgent!.id)) {
        this.agents.get(targetAgent!.id)!.status = "available";
      }
    }
  }

  // ── History & Stats ───────────────────────────────────────────────────────

  /** 获取委派历史，可按代理 ID 过滤 */
  getDelegationHistory(agentId?: string): ACPDelegationResult[] {
    if (agentId === undefined) {
      return [...this.history];
    }
    return this.history.filter((r) => r.delegateAgent === agentId);
  }

  /** 获取委派统计信息 */
  getStats(): { totalDelegations: number; successRate: number; avgDuration: number } {
    const total = this.history.length;
    if (total === 0) {
      return { totalDelegations: 0, successRate: 0, avgDuration: 0 };
    }

    const successes = this.history.filter((r) => r.success).length;
    const totalDuration = this.history.reduce((sum, r) => sum + r.duration, 0);

    return {
      totalDelegations: total,
      successRate: successes / total,
      avgDuration: totalDuration / total,
    };
  }

  // ── Private helpers ───────────────────────────────────────────────────────

  private generateId(): string {
    return `acp-${Date.now().toString(36)}-${(++this.idCounter).toString(36)}`;
  }

  private executeWithTimeout(
    agent: ACPAgent,
    request: ACPDelegationRequest,
    timeoutMs: number,
  ): Promise<ACPDelegationResult> {
    return new Promise<ACPDelegationResult>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(request.id);
        const result: ACPDelegationResult = {
          requestId: request.id,
          success: false,
          error: `Delegation timed out after ${timeoutMs}ms`,
          duration: timeoutMs,
          delegateAgent: agent.id,
        };
        this.history.push(result);

        if (this.history.length > this.maxHistory) this.history.splice(0, this.history.length - this.maxHistory);
        resolve(result);
      }, timeoutMs);

      this.pending.set(request.id, { request, resolve, reject, timer });

      // 异步执行委派
      this.runDelegation(agent, request)
        .then((result) => {
          clearTimeout(timer);
          this.pending.delete(request.id);
          this.history.push(result);

          if (this.history.length > this.maxHistory) this.history.splice(0, this.history.length - this.maxHistory);
          resolve(result);
        })
        .catch((err: unknown) => {
          clearTimeout(timer);
          this.pending.delete(request.id);
          const result: ACPDelegationResult = {
            requestId: request.id,
            success: false,
            error: err instanceof Error ? err.message : String(err),
            duration: Date.now() - request.createdAt,
            delegateAgent: agent.id,
          };
          this.history.push(result);

          if (this.history.length > this.maxHistory) this.history.splice(0, this.history.length - this.maxHistory);
          resolve(result);
        });
    });
  }

  private async runDelegation(
    agent: ACPAgent,
    request: ACPDelegationRequest,
  ): Promise<ACPDelegationResult> {
    const startTime = Date.now();

    if (agent.endpoint) {
      // 远程代理：通过 HTTP 调用（当前为占位实现）
      const result = await this.executeRemoteDelegation(agent, request);
      return {
        requestId: request.id,
        success: true,
        result,
        duration: Date.now() - startTime,
        delegateAgent: agent.id,
      };
    }

    // 本地代理：基于能力匹配的委派执行
    return executeLocalDelegation(request, agent);
  }

  /** 远程代理 HTTP 调用（占位实现，实际需集成 HTTP 客户端） */
  private async executeRemoteDelegation(
    agent: ACPAgent,
    request: ACPDelegationRequest,
  ): Promise<unknown> {
    // 当前为占位实现，真实场景需使用 fetch/HTTP 客户端调用 agent.endpoint
    return {
      status: "delegated-remote",
      delegateAgent: agent.id,
      endpoint: agent.endpoint,
      task: request.task,
      message: `Remote delegation to ${agent.endpoint} is a placeholder. Integrate an HTTP client for real execution.`,
      timestamp: Date.now(),
    };
  }
}
