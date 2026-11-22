/**
 * ExecutionAnalyzer — 任务后置执行分析（LLM）
 *
 * 借鉴 OpenSpace skill_engine/analyzer.py + prompts/skill_engine_prompts.py：
 *   读取 RecordingManager 三件套（conversations / traj / metadata），把执行轨迹
 *   压缩成可判定 digest，交给 LLM 独立评估：
 *     - task_completed（不信任 agent 自报 <COMPLETE>）
 *     - execution_note
 *     - tool_issues（工具语义问题，供 ToolQualityManager）
 *     - skill_judgments（逐技能 applied 判定，供质量四计数器）
 *     - evolution_suggestions（FIX / DERIVED / CAPTURED）
 *
 * 与 OpenSpace 的差异：
 *   - 不运行「分析器 agent loop」（避免让分析器调用工具改环境）；单次 LLM 调用 +
 *     给定 digest。执行证据不足时宁可不建议，保持主链路安全。
 *   - LLM 通道由调用方注入（EvoClaw 统一 aux fallback 链）。
 */

import { RecordingManager } from "@evoclaw/agent";
import type {
  RecordingRecord,
  RecordingMetadata,
  IterationContextRecord,
  RecordingToolExecutionRecord,
  SkillSelectionRecord,
} from "@evoclaw/agent";
import type {
  ExecutionAnalysis,
  EvolutionSuggestion,
  SkillJudgment,
} from "@evoclaw/skills";

// ── 类型 ──────────────────────────────────────────────────────

/** 单次 side-task LLM 调用（返回纯文本）。 */
export type AnalyzerCompleteFn = (input: {
  systemPrompt: string;
  prompt: string;
  maxTokens?: number;
  deadlineMs?: number;
}) => Promise<string>;

/** 参与判定的技能引用。 */
export interface AnalyzerSkillRef {
  /** 精确 sidecar id；缺失时用名称 */
  skillId: string;
  name: string;
  description?: string;
  /** 质量统计（用于让 LLM 知道历史表现） */
  applied?: number;
  completionRate?: number;
}

export interface AnalyzeExecutionInput {
  taskId: string;
  sessionId?: string;
  /** 用户原始消息 / 任务描述 */
  message: string;
  /** agent 最终回复（自报结果） */
  reply: string;
  /** 录制状态 */
  status: "completed" | "failed" | "cancelled";
  durationMs?: number;
  selectedSkills?: AnalyzerSkillRef[];
  availableTools?: string[];
  recordingDir?: string;
  /** 子代理运行不分析（避免噪声与成本） */
  isSubagent?: boolean;
  /** 单轮快速回复（无工具）不分析 */
  skip?: boolean;
}

export interface ExecutionAnalyzerConfig {
  /** 对话日志字符上限（默认 14k） */
  maxConversationChars?: number;
  /** 工具时间线条目上限（默认 80） */
  maxToolEvents?: number;
  /** 最终回复字符上限（默认 3k） */
  maxReplyChars?: number;
  /** LLM 超时（默认 90s） */
  timeoutMs?: number;
  /** 注入录制读取器（测试） */
  readRecording?: (taskId: string) => {
    conversations: RecordingRecord[];
    trajectory: RecordingRecord[];
    metadata: RecordingMetadata | null;
  };
}

const SYSTEM_PROMPT = `You are an expert analyst evaluating an autonomous agent's task execution.
Assess how the agent used its skills and tools, judge actual task completion from
evidence (never trust the agent's self-report), and surface actionable insights.

Return EXACTLY ONE JSON object, no markdown fences, no prose outside JSON:
{
  "task_completed": true|false,
  "execution_note": "2-3 sentence assessment of execution quality and outcome.",
  "tool_issues": ["toolKey — symptom; likely cause (tool fault / agent misuse)"],
  "skill_judgments": [{"skill_id": "exact id", "skill_applied": true|false, "note": "how it was used or why not"}],
  "evolution_suggestions": [{"type": "fix"|"derived"|"captured", "target_skills": ["exact id"], "category": "tool_guide"|"workflow"|"reference", "direction": "what to fix/derive/capture and why"}]
}

Rules:
- task_completed=true ONLY when the user's goal is genuinely fulfilled. Watch for
  premature completion claims and for finished work without a completion marker.
- skill_judgments: exactly one entry per selected skill (see list). Empty list if none.
- tool_issues: ONLY tools that actually misbehaved (errors, timeouts, HTTP 200 with
  wrong/unusable data). [] when none. Use the exact tool key when known.
- evolution_suggestions: 0..N. fix → exactly 1 target skill that was wrong/outdated/
  incomplete; derived → 1+ parent skills to enhance/merge; captured → [] (new reusable
  pattern discovered without skill guidance). Do NOT capture trivial one-off operations
  or data unlikely to recur. Be conservative: if evidence is insufficient, suggest nothing.`;

// ── 主类 ──────────────────────────────────────────────────────

export class ExecutionAnalyzer {
  private readonly complete: AnalyzerCompleteFn;
  private readonly config: Required<Omit<ExecutionAnalyzerConfig, "readRecording">> & {
    readRecording: NonNullable<ExecutionAnalyzerConfig["readRecording"]>;
  };

  constructor(complete: AnalyzerCompleteFn, config: ExecutionAnalyzerConfig = {}) {
    this.complete = complete;
    this.config = {
      maxConversationChars: config.maxConversationChars ?? 14_000,
      maxToolEvents: config.maxToolEvents ?? 80,
      maxReplyChars: config.maxReplyChars ?? 3_000,
      timeoutMs: config.timeoutMs ?? 90_000,
      readRecording:
        config.readRecording ??
        ((taskId: string) => RecordingManager.getInstance().readRecording(taskId)),
    };
  }

  /**
   * 分析一次执行。任何失败返回 null（后置分析不得影响主流程）。
   */
  async analyze(input: AnalyzeExecutionInput): Promise<ExecutionAnalysis | null> {
    if (input.skip || input.isSubagent) return null;

    let recording: ReturnType<NonNullable<ExecutionAnalyzerConfig["readRecording"]>> | null = null;
    try {
      recording = this.config.readRecording(input.taskId);
    } catch {
      recording = null;
    }

    const toolEvents = this.extractToolEvents(recording?.trajectory ?? []);
    // 无工具调用且无技能 → 纯聊天，不分析（省成本，避免污染技能库）
    if (toolEvents.length === 0 && (input.selectedSkills?.length ?? 0) === 0 && input.status === "completed") {
      return null;
    }

    const skills = this.normalizeSkills(
      input.selectedSkills?.length
        ? input.selectedSkills
        : this.skillsFromRecording(recording?.trajectory ?? []),
    );
    const prompt = this.buildPrompt(input, recording, toolEvents, skills);

    let output: string;
    try {
      output = await withDeadline(
        this.complete({
          systemPrompt: SYSTEM_PROMPT,
          prompt,
          maxTokens: 2400,
          deadlineMs: this.config.timeoutMs,
        }),
        this.config.timeoutMs,
      );
    } catch (err) {
      process.stderr.write(
        `[ExecutionAnalyzer] LLM call failed for ${input.taskId}: ${err instanceof Error ? err.message : String(err)}\n`,
      );
      return null;
    }

    return this.parse(output, input.taskId, skills);
  }

  // ── Prompt 构建 ─────────────────────────────────────────

  private buildPrompt(
    input: AnalyzeExecutionInput,
    recording: { conversations: RecordingRecord[]; trajectory: RecordingRecord[]; metadata: RecordingMetadata | null } | null,
    toolEvents: ToolEventDigest[],
    skills: AnalyzerSkillRef[],
  ): string {
    const toolList = (input.availableTools ?? []).slice(0, 60).join(", ") || "(unknown)";
    const skillSection = skills.length > 0
      ? [
          "## Selected skills (use these exact skill_ids in skill_judgments)",
          ...skills.map((s) => {
            const quality = typeof s.applied === "number"
              ? ` | history: applied ${s.applied}, completion ${(s.completionRate ?? 0).toFixed(2)}`
              : "";
            return `- skill_id: ${s.skillId} | name: ${s.name}${quality}\n  description: ${(s.description ?? "").slice(0, 240)}`;
          }),
        ].join("\n")
      : "## Selected skills\n(none — skill_judgments must be [])";

    const metadata = recording?.metadata;
    const conversation = this.formatConversation(recording?.conversations ?? []);
    const traj = toolEvents.length > 0
      ? toolEvents.map((e) => `- [iter ${e.iteration}] ${e.toolName} ${e.success ? "OK" : "ERROR"} (${e.durationMs}ms): ${e.detail}`).join("\n")
      : "(no tool execution records)";

    return [
      "## Task Context",
      `Task: ${input.message.slice(0, 2_000)}`,
      `Agent self-reported status: ${input.status} (NOT ground truth — judge independently)`,
      `Iterations: ${metadata?.totalIterations ?? "?"} | Tool calls: ${metadata?.totalToolCalls ?? toolEvents.length}`,
      `Available tools: ${toolList}`,
      "",
      skillSection,
      "",
      "## Tool Execution Timeline",
      traj,
      "",
      "## Agent Conversation Log",
      conversation,
      "",
      "## Final Agent Reply",
      (input.reply || "(empty)").slice(0, this.config.maxReplyChars),
      "",
      "Now return the single JSON object described in the system prompt.",
    ].join("\n");
  }

  private formatConversation(conversations: RecordingRecord[]): string {
    const lines: string[] = [];
    const seen = new Set<string>();
    let budget = this.config.maxConversationChars;

    for (const record of conversations) {
      if (record.type !== "iteration") continue;
      const iteration = record as IterationContextRecord;
      for (const msg of iteration.messages.slice(-8)) {
        const content = typeof msg.content === "string" ? msg.content : JSON.stringify(msg.content ?? "");
        if (!content.trim()) continue;
        const signature = `${msg.role}:${content.slice(0, 120)}`;
        if (seen.has(signature)) continue;
        seen.add(signature);
        const line = `[iter ${iteration.iteration}] ${msg.role.toUpperCase()}: ${content.slice(0, 1_200)}`;
        if (line.length > budget) {
          lines.push("...(truncated)");
          break;
        }
        lines.push(line);
        budget -= line.length;
      }
      if (budget <= 0) break;
    }
    return lines.length > 0 ? lines.join("\n") : "(no conversation records)";
  }

  private extractToolEvents(trajectory: RecordingRecord[]): ToolEventDigest[] {
    const events: ToolEventDigest[] = [];
    for (const record of trajectory) {
      if (record.type !== "tool_execution") continue;
      const tool = record as RecordingToolExecutionRecord;
      const result = summarizeValue(tool.error || tool.result, 300);
      const args = summarizeValue(tool.args, 160);
      events.push({
        iteration: tool.iteration ?? 0,
        toolName: tool.toolName || "unknown",
        success: tool.success === true,
        durationMs: tool.durationMs ?? 0,
        detail: args ? `args=${args} → ${result}` : result,
      });
    }
    // 保留最近 N 条 + 所有失败（失败更有分析价值）
    if (events.length > this.config.maxToolEvents) {
      const recent = events.slice(-this.config.maxToolEvents);
      const failures = events.filter((e) => !e.success && !recent.includes(e)).slice(-10);
      return [...failures, ...recent];
    }
    return events;
  }

  private skillsFromRecording(trajectory: RecordingRecord[]): AnalyzerSkillRef[] {
    const refs: AnalyzerSkillRef[] = [];
    for (const record of trajectory) {
      if (record.type !== "skill_selection") continue;
      const selection = record as SkillSelectionRecord;
      for (const skill of selection.selectedSkills ?? []) {
        const skillId = skill.skillId || skill.name;
        if (!refs.some((r) => r.skillId === skillId || r.name === skill.name)) {
          refs.push({ skillId, name: skill.name });
        }
      }
    }
    return refs;
  }

  private normalizeSkills(refs: AnalyzerSkillRef[]): AnalyzerSkillRef[] {
    const out: AnalyzerSkillRef[] = [];
    const seen = new Set<string>();
    for (const ref of refs) {
      const name = String(ref.name || "").trim();
      if (!name) continue;
      const skillId = String(ref.skillId || name).trim();
      const key = `${skillId}::${name}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({ ...ref, skillId, name });
    }
    return out;
  }

  // ── 解析 ────────────────────────────────────────────────

  private parse(
    output: string,
    taskId: string,
    skills: AnalyzerSkillRef[],
  ): ExecutionAnalysis | null {
    const jsonText = extractJsonObject(output);
    if (!jsonText) return null;
    let data: Record<string, unknown>;
    try {
      data = JSON.parse(jsonText) as Record<string, unknown>;
    } catch {
      return null;
    }

    const judgments: SkillJudgment[] = [];
    const rawJudgments = Array.isArray(data.skill_judgments) ? data.skill_judgments : [];
    for (const raw of rawJudgments) {
      if (!raw || typeof raw !== "object") continue;
      const item = raw as Record<string, unknown>;
      const rawId = String(item.skill_id || "").trim();
      const corrected = correctSkillRef(rawId, skills);
      if (!corrected) continue;
      judgments.push({
        skillId: corrected.skillId,
        skillName: corrected.name,
        skillApplied: item.skill_applied === true,
        note: String(item.note || "").slice(0, 500),
      });
    }

    const toolIssues: Array<{ toolKey: string; toolName: string; description: string }> = [];
    const rawIssues = Array.isArray(data.tool_issues) ? data.tool_issues : [];
    for (const raw of rawIssues) {
      if (typeof raw !== "string" || !raw.trim()) continue;
      const parsed = parseToolIssue(raw);
      if (parsed) toolIssues.push(parsed);
    }

    const suggestions: EvolutionSuggestion[] = [];
    const rawSuggestions = Array.isArray(data.evolution_suggestions)
      ? data.evolution_suggestions
      : [];
    for (const raw of rawSuggestions) {
      if (!raw || typeof raw !== "object") continue;
      const item = raw as Record<string, unknown>;
      const type = String(item.type || "").toLowerCase();
      if (type !== "fix" && type !== "derived" && type !== "captured") continue;
      const targetsRaw = Array.isArray(item.target_skills) ? item.target_skills : [];
      const targets: string[] = [];
      for (const t of targetsRaw) {
        const ref = correctSkillRef(String(t || ""), skills);
        if (ref && !targets.includes(ref.skillId)) targets.push(ref.skillId);
      }
      if (type !== "captured" && targets.length === 0) continue; // 无目标不执行
      if (type === "fix" && targets.length !== 1) continue;
      const category = String(item.category || "").toLowerCase();
      suggestions.push({
        type,
        targetSkillIds: targets,
        reason: String(item.direction || "").slice(0, 1_000),
        proposedChange: String(item.direction || "").slice(0, 4_000),
        category:
          category === "tool_guide" || category === "workflow" || category === "reference"
            ? category
            : "workflow",
        triggeredBy: "post-analysis",
        llmConfirmed: false,
        createdAt: Date.now(),
      });
    }

    return {
      taskId,
      taskCompleted: data.task_completed === true,
      executionNote: String(data.execution_note || "").slice(0, 1_000),
      skillJudgments: judgments,
      suggestions,
      toolIssues,
      summary: String(data.execution_note || "").slice(0, 1_000),
      analyzedAt: Date.now(),
    };
  }
}

// ── 工具函数 ──────────────────────────────────────────────────

interface ToolEventDigest {
  iteration: number;
  toolName: string;
  success: boolean;
  durationMs: number;
  detail: string;
}

function summarizeValue(value: unknown, maxLen: number): string {
  if (value === undefined || value === null) return "";
  let text: string;
  if (typeof value === "string") text = value;
  else {
    try {
      text = JSON.stringify(value);
    } catch {
      text = String(value);
    }
  }
  return text.replace(/\s+/g, " ").trim().slice(0, maxLen);
}

function parseToolIssue(
  raw: string,
): { toolKey: string; toolName: string; description: string } | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;
  // 支持 "key — description" / "key - description" / "key: description"
  const match = /^([^\s—:-]+(?::[^\s—:-]+)*)\s*(?:—|-|:)\s*(.+)$/s.exec(trimmed);
  if (!match) {
    return { toolKey: trimmed.slice(0, 80), toolName: trimmed.slice(0, 80), description: trimmed };
  }
  const toolKey = match[1].trim();
  const description = match[2].trim();
  const toolName = toolKey.includes(":") ? toolKey.split(":").pop()! : toolKey;
  return { toolKey, toolName, description: description.slice(0, 600) };
}

/** 从可能带 markdown/说明的文本中截取第一个平衡的 JSON 对象。 */
export function extractJsonObject(text: string): string | null {
  const start = text.indexOf("{");
  if (start < 0) return null;
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === "\\") escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') {
      inString = true;
    } else if (ch === "{") {
      depth++;
    } else if (ch === "}") {
      depth--;
      if (depth === 0) return text.slice(start, i + 1);
    }
  }
  return null;
}

/** skill_id 纠错：精确 → 名称 → Levenshtein ≤3。 */
export function correctSkillRef(
  rawId: string,
  skills: AnalyzerSkillRef[],
): AnalyzerSkillRef | null {
  const value = rawId.trim();
  if (!value) return null;
  const exact = skills.find((s) => s.skillId === value || s.name === value);
  if (exact) return exact;
  const normalized = value.toLowerCase().replace(/[^a-z0-9一-鿿]+/g, "");
  const byName = skills.find(
    (s) => s.name.toLowerCase().replace(/[^a-z0-9一-鿿]+/g, "") === normalized,
  );
  if (byName) return byName;
  let best: { ref: AnalyzerSkillRef; dist: number } | null = null;
  const lower = value.toLowerCase();
  for (const skill of skills) {
    const dist = Math.min(
      levenshtein(lower, skill.skillId.toLowerCase()),
      levenshtein(lower, skill.name.toLowerCase()),
    );
    if (dist <= 3 && (!best || dist < best.dist)) best = { ref: skill, dist };
  }
  return best?.ref ?? null;
}

function levenshtein(a: string, b: string): number {
  if (a === b) return 0;
  if (Math.abs(a.length - b.length) > 3) return 99;
  const m = a.length;
  const n = b.length;
  const prev = new Array<number>(n + 1);
  const curr = new Array<number>(n + 1);
  for (let j = 0; j <= n; j++) prev[j] = j;
  for (let i = 1; i <= m; i++) {
    curr[0] = i;
    for (let j = 1; j <= n; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      curr[j] = Math.min(prev[j] + 1, curr[j - 1] + 1, prev[j - 1] + cost);
    }
    for (let j = 0; j <= n; j++) prev[j] = curr[j];
  }
  return prev[n];
}

function withDeadline<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | null = null;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`analysis timed out after ${ms}ms`)), ms);
    timer.unref?.();
  });
  return Promise.race([promise, timeout]).finally(() => {
    if (timer) clearTimeout(timer);
  });
}
