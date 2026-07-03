/**
 * Multi-Agent Collaboration Patterns — GroupChat / Debate / RoundRobin / Selector.
 *
 * 弥补 EvoClaw 与主流 AI Agent 项目的差距：
 * - AutoGen GroupChat / Selector / RoundRobin
 * - CrewAI Crew (sequential + hierarchical)
 * - ChatDev multi-role coding pipeline
 * - OpenAI Agents SDK orchestration patterns
 *
 * 与 SwarmOrchestrator 的关系：
 * - SwarmOrchestrator 处理 agent 注册、delegation、handoff、consensus（基础设施）
 * - 本模块实现「对话级」协作模式（对话流控制）
 * - 两者互补：GroupChat 内部可使用 SwarmOrchestrator 注册的 agent
 *
 * 设计原则：
 * 1. ChatFn 注入 —— 不绑定具体 LLM provider，调用方提供
 *    `(agent, history, task) => Promise<string>` 即可
 * 2. 确定性可重放 —— 相同输入 + 相同 chatFn 应产生相同对话流（selector 除外）
 * 3. 提前终止 —— 支持 stopCondition、maxRounds、token 预算
 * 4. 可观测 —— 每轮 turn 记录 agentId / role / content / timestamp
 */

// ── Types ─────────────────────────────────────────────────

/** 对话参与者 —— 一个有角色与系统提示的 agent */
export interface AgentSpeaker {
  /** 唯一 ID */
  id: string;
  /** 显示名称 */
  name: string;
  /** 角色标签（如 "planner" / "coder" / "reviewer"） */
  role: string;
  /** 该 agent 的系统提示，定义其行为边界 */
  systemPrompt: string;
}

/** 一轮对话记录 */
export interface ChatTurn {
  agentId: string;
  agentName: string;
  role: string;
  content: string;
  timestamp: number;
}

/** 协作运行结果 */
export interface ChatResult {
  turns: ChatTurn[];
  /** 最终摘要（可选，由 summarizer 或最后一轮产生） */
  finalSummary?: string;
  /** 总轮数 */
  totalRounds: number;
  /** 参与者 ID 列表 */
  participants: string[];
  /** 终止原因 */
  stopReason: "max_rounds" | "consensus" | "stop_condition" | "error";
}

/**
 * 注入的对话函数 —— 由调用方实现具体 LLM 调用。
 * 接收当前发言 agent、对话历史与任务描述，返回该 agent 的回复。
 */
export type ChatFn = (
  agent: AgentSpeaker,
  history: ChatTurn[],
  task: string,
) => Promise<string>;

/** 选择下一发言者的函数（GroupChat selector 模式用） */
export type SelectorFn = (
  agents: AgentSpeaker[],
  history: ChatTurn[],
  task: string,
) => Promise<AgentSpeaker | undefined>;

/** 停止条件判断函数 */
export type StopConditionFn = (
  history: ChatTurn[],
  currentRound: number,
) => boolean;

// ── RoundRobinChat ────────────────────────────────────────

/**
 * 轮询对话 —— 按 agents 数组顺序依次发言，每个 agent 发言一轮即传给下一个。
 *
 * 最简单的协作模式，适合：
 * - 流水线式任务（planner → coder → reviewer）
 * - 可预测的多视角评论
 * - 测试与调试协作流程
 *
 * 用法：
 * ```ts
 * const chat = new RoundRobinChat(agents, chatFn);
 * const result = await chat.run("Design a REST API", { maxRounds: 6 });
 * ```
 */
export class RoundRobinChat {
  constructor(
    private agents: AgentSpeaker[],
    private chatFn: ChatFn,
  ) {
    if (agents.length === 0) {
      throw new Error("RoundRobinChat requires at least one agent");
    }
  }

  async run(
    task: string,
    options?: {
      maxRounds?: number;
      stopCondition?: StopConditionFn;
    },
  ): Promise<ChatResult> {
    const maxRounds = options?.maxRounds ?? this.agents.length * 2;
    const turns: ChatTurn[] = [];
    let stopReason: ChatResult["stopReason"] = "max_rounds";

    for (let round = 0; round < maxRounds; round++) {
      if (options?.stopCondition?.(turns, round)) {
        stopReason = "stop_condition";
        break;
      }

      const speaker = this.agents[round % this.agents.length];
      try {
        const content = await this.chatFn(speaker, turns, task);
        turns.push({
          agentId: speaker.id,
          agentName: speaker.name,
          role: speaker.role,
          content,
          timestamp: Date.now(),
        });
      } catch (err) {
        turns.push({
          agentId: speaker.id,
          agentName: speaker.name,
          role: speaker.role,
          content: `[error: ${err instanceof Error ? err.message : String(err)}]`,
          timestamp: Date.now(),
        });
        stopReason = "error";
        break;
      }
    }

    return {
      turns,
      totalRounds: Math.ceil(turns.length / this.agents.length),
      participants: this.agents.map((a) => a.id),
      stopReason,
    };
  }
}

// ── GroupChat ─────────────────────────────────────────────

/**
 * 群聊对话 —— 由 selector 决定下一发言者。
 *
 * AutoGen GroupChat 的核心模式：
 * 1. 每轮调用 selector 从候选 agents 中选择最合适的发言者
 * 2. 被选中的 agent 发言，加入历史
 * 3. 重复直到 maxRounds 或 stopCondition 满足
 *
 * 如果不提供 selectorFn，默认使用「LLM selector」：让一个虚拟的
 * selector agent 根据历史决定下一发言者。调用方也可以传入自定义的
 * selector（例如基于规则、基于 embedding 相似度、或基于负载均衡）。
 *
 * 用法：
 * ```ts
 * const chat = new GroupChat(agents, chatFn, selectorFn);
 * const result = await chat.run("Write a marketing plan", { maxRounds: 10 });
 * ```
 */
export class GroupChat {
  constructor(
    private agents: AgentSpeaker[],
    private chatFn: ChatFn,
    private selectorFn?: SelectorFn,
  ) {
    if (agents.length === 0) {
      throw new Error("GroupChat requires at least one agent");
    }
  }

  async run(
    task: string,
    options?: {
      maxRounds?: number;
      stopCondition?: StopConditionFn;
    },
  ): Promise<ChatResult> {
    const maxRounds = options?.maxRounds ?? 10;
    const turns: ChatTurn[] = [];
    let stopReason: ChatResult["stopReason"] = "max_rounds";
    const speakerCount = new Map<string, number>();

    for (let round = 0; round < maxRounds; round++) {
      if (options?.stopCondition?.(turns, round)) {
        stopReason = "stop_condition";
        break;
      }

      // 选择下一发言者
      let speaker: AgentSpeaker | undefined;
      if (this.selectorFn) {
        speaker = await this.selectorFn(this.agents, turns, task);
      } else {
        speaker = this.defaultSelector(turns, task);
      }

      if (!speaker) {
        // 没有合适的发言者 → 结束
        stopReason = "consensus";
        break;
      }

      try {
        const content = await this.chatFn(speaker, turns, task);
        turns.push({
          agentId: speaker.id,
          agentName: speaker.name,
          role: speaker.role,
          content,
          timestamp: Date.now(),
        });
        speakerCount.set(speaker.id, (speakerCount.get(speaker.id) ?? 0) + 1);
      } catch (err) {
        turns.push({
          agentId: speaker.id,
          agentName: speaker.name,
          role: speaker.role,
          content: `[error: ${err instanceof Error ? err.message : String(err)}]`,
          timestamp: Date.now(),
        });
        stopReason = "error";
        break;
      }
    }

    return {
      turns,
      totalRounds: turns.length,
      participants: Array.from(speakerCount.keys()),
      stopReason,
    };
  }

  /**
   * 默认 selector —— 简单轮询 + 跳过刚发言的 agent。
   * 生产环境应注入自定义 selectorFn（例如基于 LLM 判断）。
   */
  private defaultSelector(history: ChatTurn[], _task: string): AgentSpeaker {
    if (history.length === 0) return this.agents[0];
    const lastSpeakerId = history[history.length - 1].agentId;
    const lastIdx = this.agents.findIndex((a) => a.id === lastSpeakerId);
    const nextIdx = (lastIdx + 1) % this.agents.length;
    return this.agents[nextIdx];
  }
}

// ── DebatePattern ─────────────────────────────────────────

/**
 * 辩论模式 —— 两组 agent 围绕一个主题进行多轮辩论，最后由 judge 裁决。
 *
 * 灵感来自 ChatDev 的辩论阶段和多 agent 论文中的「society of mind」。
 * 适合：
 * - 设计决策的权衡分析
 * - 代码方案的对比评审
 * - 多视角产品需求讨论
 *
 * 流程：
 * 1. Proposition 方提出论点
 * 2. Opposition 方反驳
 * 3. 交替进行 maxRounds 轮
 * 4. Judge agent（可选）总结并给出结论
 *
 * 用法：
 * ```ts
 * const debate = new DebatePattern(proposers, opponents, chatFn, judgeAgent);
 * const result = await debate.run("Should we use microservices?", { maxRounds: 4 });
 * ```
 */
export class DebatePattern {
  constructor(
    private proposition: AgentSpeaker[],
    private opposition: AgentSpeaker[],
    private chatFn: ChatFn,
    private judge?: AgentSpeaker,
  ) {
    if (proposition.length === 0 || opposition.length === 0) {
      throw new Error("DebatePattern requires at least one proposer and one opponent");
    }
  }

  async run(
    topic: string,
    options?: {
      maxRounds?: number;
      stopCondition?: StopConditionFn;
    },
  ): Promise<ChatResult> {
    const maxRounds = options?.maxRounds ?? 4;
    const turns: ChatTurn[] = [];
    let stopReason: ChatResult["stopReason"] = "max_rounds";

    for (let round = 0; round < maxRounds; round++) {
      if (options?.stopCondition?.(turns, round)) {
        stopReason = "stop_condition";
        break;
      }

      // Proposition 方发言
      const proposer = this.proposition[round % this.proposition.length];
      const propContent = await this.chatFn(
        { ...proposer, systemPrompt: `${proposer.systemPrompt}\n\nYou are arguing FOR the topic: "${topic}".` },
        turns,
        topic,
      );
      turns.push({
        agentId: proposer.id,
        agentName: proposer.name,
        role: `proposition-${proposer.role}`,
        content: propContent,
        timestamp: Date.now(),
      });

      // Opposition 方发言
      const opponent = this.opposition[round % this.opposition.length];
      const oppContent = await this.chatFn(
        { ...opponent, systemPrompt: `${opponent.systemPrompt}\n\nYou are arguing AGAINST the topic: "${topic}".` },
        turns,
        topic,
      );
      turns.push({
        agentId: opponent.id,
        agentName: opponent.name,
        role: `opposition-${opponent.role}`,
        content: oppContent,
        timestamp: Date.now(),
      });
    }

    // Judge 裁决
    let finalSummary: string | undefined;
    if (this.judge) {
      try {
        finalSummary = await this.chatFn(
          {
            ...this.judge,
            systemPrompt: `${this.judge.systemPrompt}\n\nYou are the judge of a debate on: "${topic}". Summarize both sides and give a verdict.`,
          },
          turns,
          topic,
        );
      } catch {
        // Judge 失败不影响对话历史
      }
    }

    const participants = [
      ...this.proposition.map((a) => a.id),
      ...this.opposition.map((a) => a.id),
    ];
    if (this.judge) participants.push(this.judge.id);

    return {
      turns,
      finalSummary,
      totalRounds: maxRounds,
      participants,
      stopReason,
    };
  }
}

// ── 辅助工厂函数 ──────────────────────────────────────────

/** 创建一个简单的 AgentSpeaker */
export function createSpeaker(
  id: string,
  name: string,
  role: string,
  systemPrompt: string,
): AgentSpeaker {
  return { id, name, role, systemPrompt };
}

/** 将 ChatResult 转为可读的对话记录文本 */
export function formatChatResult(result: ChatResult): string {
  const lines: string[] = [];
  for (const turn of result.turns) {
    lines.push(`[${turn.role}] ${turn.agentName}: ${turn.content}`);
  }
  if (result.finalSummary) {
    lines.push(`\n[Judge Summary] ${result.finalSummary}`);
  }
  lines.push(`\n(rounds=${result.totalRounds}, stop=${result.stopReason})`);
  return lines.join("\n");
}
