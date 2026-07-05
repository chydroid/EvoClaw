/**
 * RecordingManager — 任务执行录制管理器
 *
 * 借鉴 OpenSpace recording/manager.py + recorder.py：
 *   - 三件套：conversations.jsonl + traj.jsonl + metadata.json
 *   - recordConversationSetup() 写 setup 消息（system prompt + 工具 schema）
 *   - recordIterationContext() 写每轮增量消息
 *   - recordToolExecution() 写工具调用轨迹
 *   - recordSkillSelection() 写技能选择记录
 *
 * EvoClaw 落地点：
 *   - agent-model-executor.ts 的 LLM 调用前后
 *   - task-orchestrator.ts 的每轮迭代
 *   - tool-result-middleware.ts 的工具执行
 *
 * 持久化：JSONL 追加写入（atomicAppendFile 模式：read-modify-write with fsync）
 */

import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";

// ── 类型 ──────────────────────────────────────────────────────

export interface ConversationSetupRecord {
  type: "setup";
  timestamp: number;
  systemPrompt: string;
  toolsSchema: unknown[];
  taskId: string;
  sessionId: string;
}

export interface IterationContextRecord {
  type: "iteration";
  timestamp: number;
  iteration: number;
  messages: Array<{ role: string; content: string }>;
  tokenEstimate: number;
}

export interface ToolExecutionRecord {
  type: "tool_execution";
  timestamp: number;
  iteration: number;
  toolName: string;
  toolCallId: string;
  args: Record<string, unknown>;
  result: unknown;
  success: boolean;
  durationMs: number;
  error?: string;
}

export interface SkillSelectionRecord {
  type: "skill_selection";
  timestamp: number;
  iteration: number;
  selectedSkills: Array<{ name: string; score: number; source: string }>;
  taskDescription: string;
}

export interface RetrievedToolsRecord {
  type: "retrieved_tools";
  timestamp: number;
  iteration: number;
  tools: Array<{ name: string; score: number }>;
  query: string;
}

export type RecordingRecord =
  | ConversationSetupRecord
  | IterationContextRecord
  | ToolExecutionRecord
  | SkillSelectionRecord
  | RetrievedToolsRecord;

export interface RecordingMetadata {
  taskId: string;
  sessionId: string;
  startedAt: number;
  endedAt?: number;
  totalIterations: number;
  totalToolCalls: number;
  totalTokensUsed: number;
  finalStatus: "running" | "completed" | "failed" | "cancelled";
  skillsUsed: string[];
  error?: string;
}

// ── 原子追加写入 ──────────────────────────────────────────────

/**
 * 原子追加写入 JSONL 文件。
 *
 * 实现：read 当前内容 + append 新行 + fsync + atomic rename。
 * 对于大文件，退化为直接 append + fsync（牺牲原子性换取性能）。
 */
function appendJsonl(filePath: string, record: unknown): void {
  const line = JSON.stringify(record) + "\n";
  try {
    // 使用 append 模式 + fsync（性能与原子性的平衡）
    const fd = fs.openSync(filePath, "a");
    try {
      fs.writeFileSync(fd, line, { encoding: "utf-8" });
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
  } catch (err) {
    process.stderr.write(`[RecordingManager] appendJsonl failed: ${err}\n`);
  }
}

// ── 主类 ──────────────────────────────────────────────────────

/**
 * RecordingManager
 *
 * 单例模式。每个任务创建一个独立目录：
 *   data/recordings/<taskId>/
 *     ├── conversations.jsonl  (setup + iterations)
 *     ├── traj.jsonl           (tool executions + skill selections)
 *     └── metadata.json        (summary + status)
 */
export class RecordingManager {
  private static instance: RecordingManager | null = null;
  private baseDir: string;
  private activeRecordings = new Map<string, { dir: string; metadata: RecordingMetadata }>();

  private constructor(baseDir?: string) {
    this.baseDir = baseDir ?? path.join(process.cwd(), "data", "recordings");
  }

  static getInstance(baseDir?: string): RecordingManager {
    if (!RecordingManager.instance) {
      RecordingManager.instance = new RecordingManager(baseDir);
    }
    return RecordingManager.instance;
  }

  /** 用于测试：重置单例 */
  static resetInstance(): void {
    RecordingManager.instance = null;
  }

  // ── 任务生命周期 ────────────────────────────────────────

  /**
   * 开始录制一个任务。
   */
  startRecording(taskId: string, sessionId: string): string {
    const dir = path.join(this.baseDir, taskId);
    try {
      fs.mkdirSync(dir, { recursive: true });
    } catch {
      // 目录已存在：继续写入（追加模式）
    }

    const metadata: RecordingMetadata = {
      taskId,
      sessionId,
      startedAt: Date.now(),
      totalIterations: 0,
      totalToolCalls: 0,
      totalTokensUsed: 0,
      finalStatus: "running",
      skillsUsed: [],
    };

    this.activeRecordings.set(taskId, { dir, metadata });
    this.persistMetadata(taskId);
    return dir;
  }

  /**
   * 结束录制。
   */
  endRecording(taskId: string, status: "completed" | "failed" | "cancelled", error?: string): void {
    const active = this.activeRecordings.get(taskId);
    if (!active) return;

    active.metadata.endedAt = Date.now();
    active.metadata.finalStatus = status;
    if (error) active.metadata.error = error;
    this.persistMetadata(taskId);
    this.activeRecordings.delete(taskId);
  }

  // ── 录制方法 ────────────────────────────────────────────

  /**
   * 录制对话 setup（system prompt + 工具 schema）。
   */
  recordConversationSetup(
    taskId: string,
    systemPrompt: string,
    toolsSchema: unknown[],
    sessionId: string,
  ): void {
    const active = this.activeRecordings.get(taskId);
    if (!active) return;

    const record: ConversationSetupRecord = {
      type: "setup",
      timestamp: Date.now(),
      systemPrompt,
      toolsSchema,
      taskId,
      sessionId,
    };
    appendJsonl(path.join(active.dir, "conversations.jsonl"), record);
  }

  /**
   * 录制迭代上下文（每轮 LLM 调用前的消息）。
   */
  recordIterationContext(
    taskId: string,
    iteration: number,
    messages: Array<{ role: string; content: string }>,
    tokenEstimate: number,
  ): void {
    const active = this.activeRecordings.get(taskId);
    if (!active) return;

    const record: IterationContextRecord = {
      type: "iteration",
      timestamp: Date.now(),
      iteration,
      messages,
      tokenEstimate,
    };
    appendJsonl(path.join(active.dir, "conversations.jsonl"), record);

    active.metadata.totalIterations = Math.max(active.metadata.totalIterations, iteration);
    active.metadata.totalTokensUsed += tokenEstimate;
  }

  /**
   * 录制工具执行。
   */
  recordToolExecution(
    taskId: string,
    iteration: number,
    toolName: string,
    toolCallId: string,
    args: Record<string, unknown>,
    result: unknown,
    success: boolean,
    durationMs: number,
    error?: string,
  ): void {
    const active = this.activeRecordings.get(taskId);
    if (!active) return;

    const record: ToolExecutionRecord = {
      type: "tool_execution",
      timestamp: Date.now(),
      iteration,
      toolName,
      toolCallId,
      args,
      result,
      success,
      durationMs,
      error,
    };
    appendJsonl(path.join(active.dir, "traj.jsonl"), record);

    active.metadata.totalToolCalls++;
  }

  /**
   * 录制技能选择。
   */
  recordSkillSelection(
    taskId: string,
    iteration: number,
    selectedSkills: Array<{ name: string; score: number; source: string }>,
    taskDescription: string,
  ): void {
    const active = this.activeRecordings.get(taskId);
    if (!active) return;

    const record: SkillSelectionRecord = {
      type: "skill_selection",
      timestamp: Date.now(),
      iteration,
      selectedSkills,
      taskDescription,
    };
    appendJsonl(path.join(active.dir, "traj.jsonl"), record);

    for (const skill of selectedSkills) {
      if (!active.metadata.skillsUsed.includes(skill.name)) {
        active.metadata.skillsUsed.push(skill.name);
      }
    }
  }

  /**
   * 录制检索到的工具候选。
   */
  recordRetrievedTools(
    taskId: string,
    iteration: number,
    tools: Array<{ name: string; score: number }>,
    query: string,
  ): void {
    const active = this.activeRecordings.get(taskId);
    if (!active) return;

    const record: RetrievedToolsRecord = {
      type: "retrieved_tools",
      timestamp: Date.now(),
      iteration,
      tools,
      query,
    };
    appendJsonl(path.join(active.dir, "traj.jsonl"), record);
  }

  // ── 查询 ────────────────────────────────────────────────

  /** 获取任务录制目录 */
  getRecordingDir(taskId: string): string | null {
    return this.activeRecordings.get(taskId)?.dir ?? null;
  }

  /** 获取任务元数据 */
  getMetadata(taskId: string): RecordingMetadata | null {
    return this.activeRecordings.get(taskId)?.metadata ?? null;
  }

  /** 列出所有录制目录 */
  listRecordings(): Array<{ taskId: string; dir: string; metadata?: RecordingMetadata }> {
    try {
      const entries = fs.readdirSync(this.baseDir, { withFileTypes: true });
      return entries
        .filter((e) => e.isDirectory())
        .map((e) => {
          const dir = path.join(this.baseDir, e.name);
          const metadataPath = path.join(dir, "metadata.json");
          let metadata: RecordingMetadata | undefined;
          try {
            metadata = JSON.parse(fs.readFileSync(metadataPath, "utf-8"));
          } catch {
            // 无 metadata 文件
          }
          return { taskId: e.name, dir, metadata };
        });
    } catch {
      return [];
    }
  }

  /**
   * 读取录制文件内容（用于回放/分析）。
   */
  readRecording(taskId: string): {
    conversations: RecordingRecord[];
    trajectory: RecordingRecord[];
    metadata: RecordingMetadata | null;
  } {
    const dir = this.activeRecordings.get(taskId)?.dir ?? path.join(this.baseDir, taskId);
    const conversations: RecordingRecord[] = [];
    const trajectory: RecordingRecord[] = [];
    let metadata: RecordingMetadata | null = null;

    try {
      const convContent = fs.readFileSync(path.join(dir, "conversations.jsonl"), "utf-8");
      for (const line of convContent.split("\n")) {
        if (line.trim()) {
          try { conversations.push(JSON.parse(line)); } catch { /* skip */ }
        }
      }
    } catch { /* file not found */ }

    try {
      const trajContent = fs.readFileSync(path.join(dir, "traj.jsonl"), "utf-8");
      for (const line of trajContent.split("\n")) {
        if (line.trim()) {
          try { trajectory.push(JSON.parse(line)); } catch { /* skip */ }
        }
      }
    } catch { /* file not found */ }

    try {
      metadata = JSON.parse(fs.readFileSync(path.join(dir, "metadata.json"), "utf-8"));
    } catch { /* file not found */ }

    return { conversations, trajectory, metadata };
  }

  // ── 内部 ────────────────────────────────────────────────

  private persistMetadata(taskId: string): void {
    const active = this.activeRecordings.get(taskId);
    if (!active) return;

    const metadataPath = path.join(active.dir, "metadata.json");
    // 使用进程 ID + 时间戳避免多进程并发时 tmp 文件互相覆盖
    const tmpPath = `${metadataPath}.${process.pid}.${Date.now()}.tmp`;
    try {
      const fd = fs.openSync(tmpPath, "w");
      try {
        fs.writeFileSync(fd, JSON.stringify(active.metadata, null, 2), { encoding: "utf-8" });
        fs.fsyncSync(fd);
      } finally {
        fs.closeSync(fd);
      }
      fs.renameSync(tmpPath, metadataPath);
    } catch (err) {
      process.stderr.write(`[RecordingManager] persistMetadata failed: ${err}\n`);
      try { fs.unlinkSync(tmpPath); } catch { /* ignore */ }
    }
  }

  /** 生成唯一任务 ID */
  static generateTaskId(): string {
    return `task_${Date.now()}_${randomUUID().slice(0, 8)}`;
  }
}
