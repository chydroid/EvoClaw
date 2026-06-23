/**
 * Conversation Summarizer Plugin
 *
 * Auto-summarizes long conversations to maintain context efficiency.
 * Hooks into:
 * - agent_end: checks if conversation is getting long and inserts summary hints
 * - before_prompt_build: injects rolling summaries into system prompt
 *
 * Helps reduce token waste by maintaining compressed conversation summaries.
 */

import type { Plugin, PluginHookRegistration, AgentEndHook, BeforePromptBuildHook } from "@evoclaw/core";

const MANIFEST = {
  name: "Conversation Summarizer",
  version: "1.0.0",
  description: "Auto-summarizes long conversations to maintain context efficiency and reduce token waste",
  description_zh: "对话摘要：自动总结长对话，保持上下文效率并减少 Token 浪费",
  author: "evoclaw",
};

interface ConversationSummary {
  sessionId: string;
  lastTurnAt: Date;
  turnCount: number;
  summary: string;
  keyTopics: string[];
  keyDecisions: string[];
  keyFiles: string[];
}

const SUMMARIZE_THRESHOLD_TURNS = 10;
const MAX_CONVERSATION_SUMMARIES = 100;
let conversationSummaries = new Map<string, ConversationSummary>();

function generateSummary(messages: Array<{ role: string; content: string | null }>, sessionId: string): ConversationSummary {
  const userMessages = messages.filter((m) => m.role === "user" && m.content);
  const assistantMessages = messages.filter((m) => m.role === "assistant" && m.content);

  // Extract key topics from user messages
  const allUserText = userMessages.map((m) => m.content!).join(" ");
  const topicKeywords = extractTopics(allUserText);

  // Extract file references
  const allText = messages.map((m) => m.content || "").join(" ");
  const filePattern = /(?:`|")?([\w./-]+\.[\w]{1,6})(?:`|")?/g;
  const files = new Set<string>();
  let fm;
  while ((fm = filePattern.exec(allText)) !== null) {
    if (fm[1].includes(".") && !fm[1].startsWith("http")) {
      files.add(fm[1]);
    }
  }

  // Extract decisions (messages starting with action verbs)
  const decisionPattern = /\b(decided|agreed|confirmed|resolved|fixed|created|updated|deleted|chose|selected)\b/i;
  const decisions: string[] = [];
  for (const msg of assistantMessages) {
    const text = msg.content || "";
    if (decisionPattern.test(text)) {
      const sentence = text.match(/[^.!?]+(?:[.!?]+|$)/g)?.find((s) => decisionPattern.test(s));
      if (sentence) decisions.push(sentence.trim().substring(0, 100));
    }
  }

  const summary = [
    `${userMessages.length} user turns, ${assistantMessages.length} assistant responses`,
    topicKeywords.length > 0 ? `Topics: ${topicKeywords.join(", ")}` : "",
    decisions.length > 0 ? `Key decisions: ${decisions.slice(0, 3).join("; ")}` : "",
  ]
    .filter(Boolean)
    .join(". ");

  return {
    sessionId,
    lastTurnAt: new Date(),
    turnCount: messages.filter((m) => m.role === "user").length,
    summary,
    keyTopics: topicKeywords,
    keyDecisions: decisions.slice(0, 5),
    keyFiles: [...files].slice(0, 10),
  };
}

function extractTopics(text: string): string[] {
  // Simple keyword extraction from user messages
  const stopWords = new Set(["the", "a", "an", "is", "are", "was", "were", "be", "been", "being", "have", "has", "had", "do", "does", "did", "will", "would", "could", "should", "may", "might", "can", "shall", "to", "of", "in", "for", "on", "with", "at", "by", "from", "as", "into", "through", "during", "before", "after", "above", "below", "between", "and", "but", "or", "not", "no", "so", "if", "then", "else", "when", "where", "why", "how", "all", "each", "every", "both", "few", "more", "most", "other", "some", "such", "only", "own", "same", "than", "too", "very", "just", "about", "also", "now", "here", "there", "this", "that", "these", "those", "i", "you", "he", "she", "it", "we", "they", "me", "him", "her", "us", "them", "my", "your", "his", "its", "our", "their", "请", "帮助", "需要", "一下", "这个", "那个", "什么", "怎么", "可以", "吗", "呢", "吧", "的", "了", "在", "是"]);

  const words = text.toLowerCase().match(/\b[\w\u4e00-\u9fff]{2,}\b/g) || [];
  const freq = new Map<string, number>();
  for (const w of words) {
    if (!stopWords.has(w)) {
      freq.set(w, (freq.get(w) || 0) + 1);
    }
  }

  return [...freq.entries()]
    .filter(([, count]) => count >= 2)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 8)
    .map(([word]) => word);
}

function buildSummaryContext(sessionId: string): string {
  const summary = conversationSummaries.get(sessionId);
  if (!summary) return "";

  const parts = [
    `\n## 会话历史摘要 (最近 ${summary.turnCount} 轮)`,
    summary.summary,
  ];

  if (summary.keyFiles.length > 0) {
    parts.push(`涉及文件: ${summary.keyFiles.join(", ")}`);
  }

  return parts.join("\n");
}

export function createConversationSummarizerPlugin(): Plugin {
  return {
    manifest: MANIFEST,
    hooks: [
      {
        hookType: "agent_end",
        priority: "last",
        handler: (hook: AgentEndHook) => {
          const sessionId = hook.context.sessionId;
          if (!sessionId) return;

          const userTurnCount = hook.messages.filter((m) => m.role === "user").length;

          if (userTurnCount >= SUMMARIZE_THRESHOLD_TURNS) {
            const summary = generateSummary(hook.messages, sessionId);
            conversationSummaries.set(sessionId, summary);

            // Prune old summaries
            if (conversationSummaries.size > MAX_CONVERSATION_SUMMARIES) {
              const oldest = [...conversationSummaries.entries()]
                .sort((a, b) => a[1].lastTurnAt.getTime() - b[1].lastTurnAt.getTime())
                .slice(0, 20)
                .map(([k]) => k);
              for (const k of oldest) conversationSummaries.delete(k);
            }
          }
        },
      } as PluginHookRegistration,
      {
        hookType: "before_prompt_build",
        priority: "normal",
        handler: (hook: BeforePromptBuildHook) => {
          const sessionId = hook.context.sessionId;
          if (!sessionId) return;

          const summaryCtx = buildSummaryContext(sessionId);
          if (summaryCtx) {
            return {
              appendSystemContext: summaryCtx,
            } as Partial<{ appendSystemContext: string }>;
          }
        },
      } as PluginHookRegistration,
    ],

    async init() {
      console.log("[ConversationSummarizer] Initialized — will summarize conversations after 10+ turns");
    },

    async shutdown() {
      console.log(`[ConversationSummarizer] Shutdown — ${conversationSummaries.size} active summaries`);
      conversationSummaries.clear();
    },

    async healthCheck() {
      return {
        healthy: true,
        message: `${conversationSummaries.size} active conversation summaries`,
      };
    },
  };
}