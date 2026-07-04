/**
 * L1 AtomicMemoryExtractor — 启发式原子记忆提取器。
 *
 * 借鉴 TencentDB-Agent-Memory L1 extractor 的三大类型分类
 * （persona / episodic / instruction），但**不依赖 LLM**：
 * - 用正则匹配中文/英文触发词
 * - 从用户消息中抽取"独立完整"的陈述
 * - 同步到 LongTermMemoryStore（type: "knowledge"/"experience"/"feedback"）
 *
 * 三大类型映射到 EvoClaw 已有 MemoryEntry.type：
 *   persona      → type: "feedback" (用户偏好/属性)   cognitiveLayer: "semantic"
 *   episodic     → type: "experience" (事件/动作)     cognitiveLayer: "episodic"
 *   instruction  → type: "knowledge"  (长期行为规则)  cognitiveLayer: "semantic"
 *
 * 与 memory-curator.ts 的关系：
 * - curator 是粗粒度对话级评估（"这段对话值得保存吗？"）
 * - L1 extractor 是细粒度原子级提取（"这段对话里有 3 条独立记忆"）
 */

import type { ConversationMessage } from "./conversation-recorder";

/** L1 原子记忆类型。 */
export type AtomicMemoryType = "persona" | "episodic" | "instruction";

/** L1 原子记忆（提取后的结构化结果）。 */
export interface AtomicMemory {
  /** 全局唯一 ID。 */
  id: string;
  /** 类型：persona / episodic / instruction。 */
  type: AtomicMemoryType;
  /** 提取出的记忆陈述（独立完整，跳出对话也成立）。 */
  content: string;
  /** 优先级（0-100）。persona: 50-100，episodic: 60-100，instruction: 70-100。 */
  priority: number;
  /** 来源消息 ID 列表（用于溯源回 L0）。 */
  sourceMessageIds: string[];
  /** 来源会话键。 */
  sessionKey: string;
  /** 提取时间戳（epoch ms）。 */
  extractedAt: number;
  /** 关联场景名（由调用方或 L2 填写）。 */
  sceneName?: string;
  /** 附加元数据。 */
  metadata?: Record<string, unknown>;
}

/** L1 提取规则：模式 + 类型 + 优先级。 */
interface ExtractionRule {
  /** 匹配正则。 */
  pattern: RegExp;
  /** 类型。 */
  type: AtomicMemoryType;
  /** 基础优先级（实际值会根据上下文微调）。 */
  basePriority: number;
  /** 描述（用于调试）。 */
  desc: string;
}

// ── Persona 规则：用户偏好/属性/习惯 ──
const PERSONA_RULES: ExtractionRule[] = [
  // 中文
  { pattern: /我\s*(?:喜欢|偏好|习惯|经常|常常|总是|从来不|不喜欢|讨厌|擅长|爱|恨)/g, type: "persona", basePriority: 70, desc: "中文偏好陈述" },
  { pattern: /我\s*(?:是|在|有|住|工作|学习)/g, type: "persona", basePriority: 60, desc: "中文身份陈述" },
  { pattern: /我的\s*(?:名字|职业|专业|工作|爱好|兴趣|生日|年龄|地址|城市|国家|公司|学校)/g, type: "persona", basePriority: 80, desc: "中文身份属性" },
  { pattern: /我\s*(?:用|不用)\s*(?:Python|TypeScript|JavaScript|Rust|Go|Java|C\+\+|React|Vue|Angular|Node)/gi, type: "persona", basePriority: 65, desc: "技术栈偏好" },
  // 英文
  { pattern: /I\s+(?:prefer|like|always|never|usually|often|love|hate|dislike)/gi, type: "persona", basePriority: 70, desc: "EN preference" },
  { pattern: /I\s+am\s+(?:a|an)\s+\w+/gi, type: "persona", basePriority: 60, desc: "EN identity" },
  { pattern: /my\s+(?:name|job|role|profession|hobby|interest|birthday|age|address|city|country|company|school)\s+(?:is|are)/gi, type: "persona", basePriority: 80, desc: "EN identity attribute" },
  { pattern: /I\s+(?:use|don'?t\s+use)\s+(?:Python|TypeScript|JavaScript|Rust|Go|Java|React|Vue|Angular|Node)/gi, type: "persona", basePriority: 65, desc: "EN tech stack" },
];

// ── Episodic 规则：客观事件/动作 ──
const EPISODIC_RULES: ExtractionRule[] = [
  // 中文
  { pattern: /我\s*(?:昨天|今天|明天|上周|下周|刚才|刚刚|已经|正在|准备|计划|决定)/g, type: "episodic", basePriority: 70, desc: "中文事件时态" },
  { pattern: /(?:完成|做完|做完|搞定|启动|部署|发布|升级|修复|重构|删除|添加|创建)/g, type: "episodic", basePriority: 60, desc: "中文动作" },
  // 英文
  { pattern: /I\s+(?:did|finished|completed|started|deployed|shipped|fixed|refactored|deleted|created|built|wrote|ran)/gi, type: "episodic", basePriority: 70, desc: "EN past action" },
  { pattern: /I\s+(?:am\s+(?:going\s+to|planning\s+to)|will|plan\s+to|decided\s+to)/gi, type: "episodic", basePriority: 70, desc: "EN future plan" },
  { pattern: /(?:yesterday|today|tomorrow|last\s+week|next\s+week|just\s+now)/gi, type: "episodic", basePriority: 65, desc: "EN time anchor" },
];

// ── Instruction 规则：长期行为指令 ──
const INSTRUCTION_RULES: ExtractionRule[] = [
  // 中文
  { pattern: /(?:以后|从现在开始|记住|必须|请(?:始终|永远|总是|每次)|永远(?:不要|别)|务必)/g, type: "instruction", basePriority: 90, desc: "中文长期指令" },
  { pattern: /(?:回答时|回复时|输出时|生成时)\s*(?:要|不要|必须|应该)/g, type: "instruction", basePriority: 85, desc: "中文格式指令" },
  // 英文
  { pattern: /(?:from\s+now\s+on|always|never|remember\s+to|make\s+sure\s+to|you\s+must|you\s+should\s+always)/gi, type: "instruction", basePriority: 90, desc: "EN long-term instruction" },
  { pattern: /(?:when\s+answering|when\s+responding|when\s+outputting|in\s+your\s+replies)\s+(?:always|never|make\s+sure)/gi, type: "instruction", basePriority: 85, desc: "EN format instruction" },
];

const ALL_RULES = [...PERSONA_RULES, ...EPISODIC_RULES, ...INSTRUCTION_RULES];

/**
 * L1 原子记忆提取器。
 *
 * 启发式（非 LLM）提取，速度快、零依赖。
 * 适用场景：每次对话结束后同步提取，避免 LLM 调用成本。
 * 局限：复杂多句表达可能漏提，可后续叠加 LLM 提取层。
 */
export class AtomicMemoryExtractor {
  /** 从最近对话中提取原子记忆。 */
  extract(messages: ConversationMessage[]): AtomicMemory[] {
    const memories: AtomicMemory[] = [];
    const seenContent = new Set<string>();

    for (const msg of messages) {
      // 只从用户消息提取（assistant 消息多为响应，不是用户属性）
      if (msg.role !== "user") continue;
      if (!msg.content || msg.content.trim().length < 4) continue;

      // 把用户消息按句子切分（中英标点）
      const sentences = this.splitSentences(msg.content);
      for (const sentence of sentences) {
        const trimmed = sentence.trim();
        if (trimmed.length < 4 || trimmed.length > 200) continue;

        // 跳过明显的指令交互（"帮我..."、"请..." 这类工具性请求，不是记忆）
        if (this.isToolRequest(trimmed)) continue;

        for (const rule of ALL_RULES) {
          // 重置 lastIndex（全局正则复用）
          rule.pattern.lastIndex = 0;
          if (rule.pattern.test(trimmed)) {
            const content = this.normalizeContent(trimmed, rule.type);
            if (!content || seenContent.has(content)) continue;
            seenContent.add(content);

            memories.push({
              id: this.genId(),
              type: rule.type,
              content,
              priority: this.adjustPriority(rule.basePriority, trimmed),
              sourceMessageIds: [msg.id],
              sessionKey: msg.sessionKey,
              extractedAt: Date.now(),
              metadata: {
                extractor: "heuristic-v1",
                rule: rule.desc,
                sourceTimestamp: msg.timestamp,
              },
            });
            // 同一句只匹配一个规则，避免重复
            break;
          }
        }
      }
    }

    // 按优先级倒序
    memories.sort((a, b) => b.priority - a.priority);
    return memories;
  }

  // ── 私有辅助 ──

  private splitSentences(text: string): string[] {
    // 按中英标点切分，但不切分数字之间的小数点（如 v0.66.9 / 3.14）
    // 使用 lookbehind/lookahead: 只在 . 不被数字包围时才切分
    return text
      .split(/[。！？\n;；]+|(?<!\d)\.(?!\d)/)
      .map((s) => s.trim())
      .filter((s) => s.length > 0);
  }

  private isToolRequest(text: string): boolean {
    // 跳过明显的工具性请求
    return /^(?:帮我|请|麻烦|能不能|可以|would\s+you|could\s+you|please|can\s+you)/i.test(text.trim());
  }

  private normalizeContent(text: string, type: AtomicMemoryType): string {
    let clean = text.trim()
      .replace(/^(?:那么|然后|所以|但是|不过|而且|因此|因为)[,，]?\s*/i, "")
      .replace(/[,，。！！.!?？]+$/, "");
    if (clean.length < 4) return "";

    // 根据类型加前缀，让记忆独立可读
    switch (type) {
      case "persona":
        // 已经以 "我" 或 "I" 开头，无需改
        if (!/^(?:我|I)\s/i.test(clean)) clean = `用户：${clean}`;
        break;
      case "episodic":
        if (!/^(?:我|I|昨天|今天|明天|刚才|yesterday|today)/i.test(clean)) {
          clean = `用户${clean}`;
        }
        break;
      case "instruction":
        // 保持原句
        break;
    }
    return clean;
  }

  private adjustPriority(base: number, content: string): number {
    let p = base;
    // 包含具体技术名词 → +5
    if (/\b(?:TypeScript|Python|React|Vue|Node|Docker|Kubernetes|k8s)\b/i.test(content)) p += 5;
    // 包含具体版本号 → +3
    if (/\bv?\d+\.\d+/i.test(content)) p += 3;
    // 长句（>80字符）→ -5（容易是复杂表达，提取质量低）
    if (content.length > 80) p -= 5;
    // 截断到 [0, 100]
    return Math.max(0, Math.min(100, p));
  }

  private genId(): string {
    return `l1_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
  }
}
