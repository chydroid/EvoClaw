/**
 * SessionCheckpoint — 会话检查点
 *
 * 对标 Devin session resume：保存当前会话状态（消息历史 + 工具调用记录 + 上下文），
 * 可在进程重启或会话切换后恢复。
 *
 * 设计：
 *  - CheckpointStore 抽象，便于切换存储后端（文件 / SQLite / 远程）
 *  - FileCheckpointStore：每个检查点存为独立 JSON 文件，原子写入
 *  - SessionCheckpointManager：上层 API，提供 save / restore / list / delete / diff
 *  - restore 不修改 store，只返回 checkpoint 内容
 *  - load 时校验必需字段，损坏文件返回 null
 */

import * as fs from "fs";
import * as path from "path";
import { randomUUID } from "crypto";

// ── 类型 ────────────────────────────────────────────────────────────────────

export interface SessionCheckpoint {
  id: string;
  sessionId: string;
  createdAt: number;
  label?: string;
  messages: Array<{
    role: string;
    content: string;
    toolCalls?: unknown[];
    toolCallId?: string;
  }>;
  toolCallHistory: Array<{
    toolName: string;
    params: unknown;
    result: unknown;
    success: boolean;
    timestamp: number;
  }>;
  context: {
    systemPrompt?: string;
    skills?: string[];
    activeToolPolicy?: unknown;
  };
  metadata?: Record<string, unknown>;
}

export interface CheckpointMeta {
  id: string;
  sessionId: string;
  createdAt: number;
  label?: string;
}

export interface CheckpointStore {
  save(checkpoint: SessionCheckpoint): Promise<void>;
  load(id: string): Promise<SessionCheckpoint | null>;
  list(sessionId?: string): Promise<CheckpointMeta[]>;
  delete(id: string): Promise<void>;
}

// ── 原子写入工具 ────────────────────────────────────────────────────────────

/**
 * 原子写入：temp + fsync + rename。
 * 临时文件名加 `.pid.timestamp.tmp` 后缀，遵循 AGENTS.md 规则。
 */
function atomicWriteFile(targetPath: string, content: string): void {
  const dir = path.dirname(targetPath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  const tmpPath = `${targetPath}.${process.pid}.${Date.now()}.tmp`;
  const fd = fs.openSync(tmpPath, "w");
  try {
    fs.writeFileSync(fd, content, "utf-8");
    fs.fsyncSync(fd);
  } catch (err) {
    try { fs.closeSync(fd); } catch { /* ignore */ }
    try { fs.unlinkSync(tmpPath); } catch { /* ignore */ }
    throw err;
  }
  fs.closeSync(fd);
  try {
    fs.renameSync(tmpPath, targetPath);
  } catch (err) {
    try { fs.unlinkSync(tmpPath); } catch { /* ignore */ }
    throw err;
  }
}

/** 校验 checkpoint 必需字段 */
function isValidCheckpoint(obj: unknown): obj is SessionCheckpoint {
  if (typeof obj !== "object" || obj === null) return false;
  const o = obj as Record<string, unknown>;
  return (
    typeof o.id === "string" &&
    typeof o.sessionId === "string" &&
    typeof o.createdAt === "number" &&
    Array.isArray(o.messages) &&
    Array.isArray(o.toolCallHistory) &&
    typeof o.context === "object" && o.context !== null
  );
}

// ── 文件存储实现 ────────────────────────────────────────────────────────────

/**
 * 文件存储后端。
 * 路径布局：`{baseDir}/{sessionId}/{id}.json`
 */
export class FileCheckpointStore implements CheckpointStore {
  private readonly baseDir: string;

  constructor(baseDir: string) {
    this.baseDir = baseDir;
  }

  async save(checkpoint: SessionCheckpoint): Promise<void> {
    const filePath = this.checkpointPath(checkpoint.sessionId, checkpoint.id);
    const content = JSON.stringify(checkpoint, null, 2);
    await Promise.resolve(atomicWriteFile(filePath, content));
  }

  async load(id: string): Promise<SessionCheckpoint | null> {
    // id 可能跨多个 session 目录，需要扫描
    const sessions = await this.listSessionDirs();
    for (const sid of sessions) {
      const filePath = path.join(this.baseDir, sid, `${id}.json`);
      if (!fs.existsSync(filePath)) continue;
      try {
        const content = await fs.promises.readFile(filePath, "utf-8");
        const parsed: unknown = JSON.parse(content);
        if (isValidCheckpoint(parsed)) {
          return parsed;
        }
        return null;
      } catch {
        // 损坏的 JSON 返回 null
        return null;
      }
    }
    return null;
  }

  async list(sessionId?: string): Promise<CheckpointMeta[]> {
    const sessions = sessionId ? [sessionId] : await this.listSessionDirs();
    const metas: CheckpointMeta[] = [];

    for (const sid of sessions) {
      const dir = path.join(this.baseDir, sid);
      let files: string[];
      try {
        files = await fs.promises.readdir(dir);
      } catch {
        continue;
      }
      for (const f of files) {
        if (!f.endsWith(".json")) continue;
        const fullPath = path.join(dir, f);
        try {
          const content = await fs.promises.readFile(fullPath, "utf-8");
          const parsed: unknown = JSON.parse(content);
          if (isValidCheckpoint(parsed)) {
            metas.push({
              id: parsed.id,
              sessionId: parsed.sessionId,
              createdAt: parsed.createdAt,
              label: parsed.label,
            });
          }
        } catch {
          // 跳过损坏文件
        }
      }
    }

    // 按 createdAt 倒序
    metas.sort((a, b) => b.createdAt - a.createdAt);
    return metas;
  }

  async delete(id: string): Promise<void> {
    const sessions = await this.listSessionDirs();
    for (const sid of sessions) {
      const filePath = path.join(this.baseDir, sid, `${id}.json`);
      if (fs.existsSync(filePath)) {
        try {
          await fs.promises.unlink(filePath);
        } catch {
          /* ignore */
        }
        return;
      }
    }
  }

  // ── 私有 ──────────────────────────────────────────────────────────────────

  private checkpointPath(sessionId: string, id: string): string {
    return path.join(this.baseDir, sessionId, `${id}.json`);
  }

  private async listSessionDirs(): Promise<string[]> {
    try {
      const entries = await fs.promises.readdir(this.baseDir, {
        withFileTypes: true,
      });
      return entries
        .filter((e) => e.isDirectory())
        .map((e) => e.name);
    } catch {
      return [];
    }
  }
}

// ── 管理器 ──────────────────────────────────────────────────────────────────

/**
 * 会话检查点管理器：上层 API。
 * 通过 CheckpointStore 抽象与具体存储后端解耦。
 */
export class SessionCheckpointManager {
  private readonly store: CheckpointStore;

  constructor(store: CheckpointStore) {
    this.store = store;
  }

  /**
   * 保存当前会话状态为检查点。
   * @returns 新建的 checkpoint ID
   */
  async save(
    sessionId: string,
    messages: Array<{ role: string; content: string }>,
    toolCallHistory: Array<{
      toolName: string;
      params: unknown;
      result: unknown;
      success: boolean;
      timestamp: number;
    }>,
    context: { systemPrompt?: string; skills?: string[] },
    label?: string,
  ): Promise<string> {
    const id = randomUUID();
    const checkpoint: SessionCheckpoint = {
      id,
      sessionId,
      createdAt: Date.now(),
      label,
      messages,
      toolCallHistory,
      context,
    };
    await this.store.save(checkpoint);
    return id;
  }

  /** 恢复检查点（不修改 store，只返回内容） */
  async restore(checkpointId: string): Promise<SessionCheckpoint | null> {
    return this.store.load(checkpointId);
  }

  /** 列出检查点（按 createdAt 倒序） */
  async list(sessionId?: string): Promise<CheckpointMeta[]> {
    return this.store.list(sessionId);
  }

  /** 删除检查点 */
  async delete(checkpointId: string): Promise<void> {
    await this.store.delete(checkpointId);
  }

  /**
   * 比较两个检查点：
   *  - addedMessages: cp2 比 cp1 多的消息数
   *  - removedMessages: cp2 比 cp1 少的消息数
   *  - toolCallsDiff: toolCallHistory 长度差（cp2 - cp1）
   */
  async diff(
    checkpointId1: string,
    checkpointId2: string,
  ): Promise<{ addedMessages: number; removedMessages: number; toolCallsDiff: number }> {
    const cp1 = await this.store.load(checkpointId1);
    const cp2 = await this.store.load(checkpointId2);

    const m1 = cp1?.messages.length ?? 0;
    const m2 = cp2?.messages.length ?? 0;
    const t1 = cp1?.toolCallHistory.length ?? 0;
    const t2 = cp2?.toolCallHistory.length ?? 0;

    return {
      addedMessages: Math.max(0, m2 - m1),
      removedMessages: Math.max(0, m1 - m2),
      toolCallsDiff: t2 - t1,
    };
  }
}
