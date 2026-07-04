/**
 * L0 ConversationRecorder — 原始对话流捕获器。
 *
 * 借鉴 TencentDB-Agent-Memory 的 L0 设计：按会话保存原始对话到 JSONL 文件，
 * 同时在内存中维护可检索的 ConversationMessage 数组。
 *
 * 与 LongTermMemoryStore 的区别：
 * - L0 保存完整对话（含时间戳、角色、元数据），用于溯源
 * - LongTermMemory 保存的是已经被 curator 处理过的"对话快照"
 *
 * 文件布局：
 *   ${DATA_DIR}/memory/layered/conversations/${sessionKey}.jsonl
 *
 * 每个 JSONL 行格式：
 *   { id, role, content, timestamp, sessionKey, sessionId?, metadata }
 */

import * as fs from "fs";
import * as path from "path";

/** L0 单条消息。 */
export interface ConversationMessage {
  /** 全局唯一消息 ID（uuid 风格）。 */
  id: string;
  /** 消息角色：user / assistant / system / tool。 */
  role: "user" | "assistant" | "system" | "tool";
  /** 消息文本内容。 */
  content: string;
  /** 消息时间戳（epoch ms）。 */
  timestamp: number;
  /** 会话键（稳定跨重连）。 */
  sessionKey: string;
  /** 子会话 ID（可选）。 */
  sessionId?: string;
  /** 附加元数据（工具调用结果、token 数等）。 */
  metadata?: Record<string, unknown>;
}

/**
 * L0 对话记录器。线程安全（顺序写入），原子追加。
 *
 * 使用方式：
 *   const recorder = new ConversationRecorder(dataDir);
 *   recorder.record({ role: "user", content: "你好", sessionKey: "s1" });
 *   const recent = recorder.loadRecent("s1", 10);
 */
export class ConversationRecorder {
  private readonly conversationsDir: string;

  constructor(private dataDir: string) {
    this.conversationsDir = path.join(dataDir, "memory", "layered", "conversations");
    this.ensureDir(this.conversationsDir);
  }

  /**
   * 记录一条对话消息。原子追加到对应会话 JSONL 文件。
   * @returns 生成的消息 ID
   */
  record(msg: Omit<ConversationMessage, "id" | "timestamp"> & { timestamp?: number }): ConversationMessage {
    const full: ConversationMessage = {
      id: this.genId(),
      timestamp: msg.timestamp ?? Date.now(),
      ...msg,
    };
    const file = this.sessionFile(full.sessionKey);
    const line = JSON.stringify(full) + "\n";
    fs.appendFileSync(file, line, { encoding: "utf-8" });
    return full;
  }

  /**
   * 加载某会话最近 N 条消息（默认 50）。
   * 若会话文件不存在，返回空数组。
   */
  loadRecent(sessionKey: string, limit = 50): ConversationMessage[] {
    const file = this.sessionFile(sessionKey);
    if (!fs.existsSync(file)) return [];
    const text = fs.readFileSync(file, "utf-8");
    const lines = text.split("\n").filter(Boolean);
    const tail = lines.slice(-limit);
    const msgs: ConversationMessage[] = [];
    for (const line of tail) {
      try {
        msgs.push(JSON.parse(line) as ConversationMessage);
      } catch {
        /* skip malformed line */
      }
    }
    return msgs;
  }

  /** 列出所有会话键（按最近修改时间倒序）。 */
  listSessions(): string[] {
    if (!fs.existsSync(this.conversationsDir)) return [];
    const entries = fs.readdirSync(this.conversationsDir);
    return entries
      .filter((f) => f.endsWith(".jsonl"))
      .map((f) => {
        const full = path.join(this.conversationsDir, f);
        const stat = fs.statSync(full);
        return { key: f.replace(/\.jsonl$/, ""), mtime: stat.mtimeMs };
      })
      .sort((a, b) => b.mtime - a.mtime)
      .map((e) => e.key);
  }

  /**
   * 全文搜索（线性扫描所有会话文件，返回最多 limit 条匹配）。
   * 适用中小规模数据；大规模数据应使用 FTS5 索引。
   */
  search(query: string, limit = 20): ConversationMessage[] {
    if (!query.trim()) return [];
    const lower = query.toLowerCase();
    const results: ConversationMessage[] = [];
    for (const sessionKey of this.listSessions()) {
      const msgs = this.loadRecent(sessionKey, 10000);
      for (const m of msgs) {
        if (m.content.toLowerCase().includes(lower)) {
          results.push(m);
          if (results.length >= limit) return results;
        }
      }
    }
    return results;
  }

  /** 删除某会话的全部 L0 记录（用于清理过期数据）。 */
  deleteSession(sessionKey: string): void {
    const file = this.sessionFile(sessionKey);
    try {
      if (fs.existsSync(file)) fs.unlinkSync(file);
    } catch {
      /* ignore */
    }
  }

  /** 清空所有 L0 对话记录。 */
  clear(): void {
    if (!fs.existsSync(this.conversationsDir)) return;
    for (const f of fs.readdirSync(this.conversationsDir)) {
      if (f.endsWith(".jsonl")) {
        try { fs.unlinkSync(path.join(this.conversationsDir, f)); } catch { /* ignore */ }
      }
    }
  }

  /** 返回数据目录（供测试用）。 */
  getDataDir(): string {
    return this.dataDir;
  }

  // ── 私有辅助 ──

  private sessionFile(sessionKey: string): string {
    // 防止路径穿越
    const safe = sessionKey.replace(/[^a-zA-Z0-9_\-]/g, "_");
    return path.join(this.conversationsDir, `${safe}.jsonl`);
  }

  private ensureDir(dir: string): void {
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
  }

  private genId(): string {
    return `l0_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
  }
}
