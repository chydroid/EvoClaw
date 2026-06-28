import * as fs from "fs";
import * as path from "path";

export interface TaskCheckpoint {
  sessionId: string;
  originalMessage: string;
  subtasks: Array<{
    id: string;
    description: string;
    status: "pending" | "completed" | "failed";
    result?: string;
    error?: string;
  }>;
  completedCount: number;
  totalSubtasks: number;
  createdAt: number;
  updatedAt: number;
  overallResult?: string;
}

class TaskCheckpointManager {
  private checkpoints = new Map<string, TaskCheckpoint>();
  private checkpointDir: string;

  constructor(baseDir?: string) {
    this.checkpointDir = baseDir || path.resolve(process.cwd(), "data", "checkpoints");
    if (!fs.existsSync(this.checkpointDir)) {
      fs.mkdirSync(this.checkpointDir, { recursive: true });
    }
    this.loadFromDisk();
  }

  save(sessionId: string, checkpoint: TaskCheckpoint): void {
    checkpoint.updatedAt = Date.now();
    this.checkpoints.set(sessionId, checkpoint);
    this.persistToDisk(sessionId, checkpoint);
  }

  get(sessionId: string): TaskCheckpoint | undefined {
    return this.checkpoints.get(sessionId);
  }

  has(sessionId: string): boolean {
    return this.checkpoints.has(sessionId);
  }

  delete(sessionId: string): void {
    this.checkpoints.delete(sessionId);
    try {
      const filePath = path.join(this.checkpointDir, `${sessionId}.json`);
      if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
    } catch { /* ignore */ }
  }

  updateSubtask(sessionId: string, subtaskId: string, status: "completed" | "failed", result?: string, error?: string): void {
    const cp = this.checkpoints.get(sessionId);
    if (!cp) return;
    const st = cp.subtasks.find(s => s.id === subtaskId);
    if (!st) return;
    st.status = status;
    if (result !== undefined) st.result = result;
    if (error !== undefined) st.error = error;
    cp.completedCount = cp.subtasks.filter(s => s.status === "completed").length;
    cp.updatedAt = Date.now();
    this.persistToDisk(sessionId, cp);
  }

  getNextPendingSubtask(sessionId: string): TaskCheckpoint["subtasks"][number] | undefined {
    const cp = this.checkpoints.get(sessionId);
    if (!cp) return undefined;
    return cp.subtasks.find(s => s.status === "pending");
  }

  private persistToDisk(sessionId: string, checkpoint: TaskCheckpoint): void {
    try {
      const filePath = path.join(this.checkpointDir, `${sessionId}.json`);
      const data = JSON.stringify(checkpoint, null, 2);
      // 原子写入：temp + fsync + rename，防止崩溃时 JSON 文件损坏
      const tmpPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
      const fd = fs.openSync(tmpPath, "w");
      try {
        fs.writeFileSync(fd, data, "utf-8");
        fs.fsyncSync(fd);
      } finally {
        fs.closeSync(fd);
      }
      try {
        fs.renameSync(tmpPath, filePath);
      } catch (renameErr) {
        // EXDEV/EBUSY 跨设备回退：在目标目录侧创建临时文件再 rename
        const dstTmp = `${filePath}.${process.pid}.${Date.now()}.dst.tmp`;
        try {
          fs.copyFileSync(tmpPath, dstTmp);
          fs.renameSync(dstTmp, filePath);
          try { fs.unlinkSync(tmpPath); } catch { /* ignore */ }
        } catch (fallbackErr) {
          try { fs.unlinkSync(dstTmp); } catch { /* ignore */ }
          try { fs.unlinkSync(tmpPath); } catch { /* ignore */ }
          throw fallbackErr;
        }
      }
    } catch (err) {
      process.stderr.write(`[TaskCheckpointManager] Failed to persist checkpoint for ${sessionId}:` + " " + err + "\n");
    }
  }

  private loadFromDisk(): void {
    try {
      if (!fs.existsSync(this.checkpointDir)) return;
      const files = fs.readdirSync(this.checkpointDir).filter(f => f.endsWith(".json"));
      const now = Date.now();
      const MAX_AGE = 24 * 60 * 60 * 1000;
      for (const file of files) {
        try {
          const data = fs.readFileSync(path.join(this.checkpointDir, file), "utf-8");
          const cp = JSON.parse(data) as TaskCheckpoint;
          if (now - cp.updatedAt < MAX_AGE) {
            this.checkpoints.set(cp.sessionId, cp);
          } else {
            fs.unlinkSync(path.join(this.checkpointDir, file));
          }
        } catch { /* skip corrupt files */ }
      }
    } catch { /* ignore */ }
    process.stdout.write(`[TaskCheckpointManager] Loaded ${this.checkpoints.size} checkpoints from disk\n`);
  }
}

export const taskCheckpointManager = new TaskCheckpointManager();
