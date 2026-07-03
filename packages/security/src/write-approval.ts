/**
 * WriteApproval — 写审批门 + pending store。
 *
 * 对标 Hermes v0.18.0 `tools/write_approval.py` 的 `stage_write` +
 * `GateDecision` + `evaluate_gate`：
 * 所有写入操作先暂存到 pending store，评估门决策后：
 *   - allow → 直接写入
 *   - deny → 拒绝并返回原因
 *   - needs_confirm → 暂存等待人工放行
 *
 * 设计：
 * 1. 原子写入 pending store（temp + fsync + rename）
 * 2. 三层决策：file-safety denylist → profile scope → user preference
 * 3. 暂存记录可审计、可回滚
 * 4. 放行后实际写入目标路径
 *
 * 用法：
 * ```ts
 * const gate = new WriteApprovalGate({ pendingDir: "data/write-pending" });
 * const decision = await gate.stageWrite("/path/file.ts", content, {
 *   agentId: "agent-1",
 *   operation: "edit",
 * });
 * if (decision.decision === "needs_confirm") {
 *   // 等待用户审批
 *   const result = await gate.approve(decision.stageId);
 * }
 * ```
 */

import * as fs from "fs";
import * as path from "path";
import * as crypto from "crypto";

/** 门决策类型 */
export type GateDecisionType = "allow" | "deny" | "needs_confirm";

/** 门决策 */
export interface GateDecision {
  /** 决策类型 */
  decision: GateDecisionType;
  /** 暂存 ID（needs_confirm 时用于审批） */
  stageId?: string;
  /** 决策原因 */
  reason: string;
  /** 命中的规则 */
  rule?: string;
  /** 风险等级 */
  risk: "low" | "medium" | "high" | "critical";
}

/** 暂存记录 */
interface StagedWrite {
  /** 暂存 ID */
  stageId: string;
  /** 目标路径 */
  targetPath: string;
  /** 内容（base64 编码） */
  contentBase64: string;
  /** 操作类型 */
  operation: "create" | "edit" | "delete" | "move";
  /** agent ID */
  agentId: string;
  /** 创建时间 */
  createdAt: number;
  /** 决策 */
  decision: GateDecisionType;
  /** 决策原因 */
  reason: string;
  /** 风险等级 */
  risk: "low" | "medium" | "high" | "critical";
  /** 审批状态 */
  approvalStatus: "pending" | "approved" | "rejected" | "expired";
}

/** 门配置 */
export interface WriteApprovalConfig {
  /** pending store 目录 */
  pendingDir: string;
  /** 文件安全 denylist（绝对路径或 glob） */
  denylist?: string[];
  /** 允许写入的根目录（profile scope） */
  allowedRoots?: string[];
  /** 需要确认的路径模式（正则） */
  confirmPatterns?: RegExp[];
  /** 暂存过期时间（ms，默认 5 分钟） */
  stageTtlMs?: number;
  /** 是否启用（默认 true） */
  enabled?: boolean;
}

/** 审批结果 */
export interface ApprovalResult {
  success: boolean;
  stageId: string;
  targetPath: string;
  error?: string;
}

// ── 原子写入辅助 ──────────────────────────────────────────

function atomicWriteFile(targetPath: string, content: string | Buffer): void {
  const dir = path.dirname(targetPath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  const tmpPath = `${targetPath}.${process.pid}.${crypto.randomBytes(4).toString("hex")}.tmp`;
  const fd = fs.openSync(tmpPath, "w");
  try {
    fs.writeFileSync(fd, content);
    fs.fsyncSync(fd);
  } catch (err) {
    try { fs.closeSync(fd); } catch { /* ignore */ }
    try { fs.unlinkSync(tmpPath); } catch { /* ignore */ }
    throw err;
  }
  fs.closeSync(fd);
  try {
    fs.renameSync(tmpPath, targetPath);
  } catch (err: unknown) {
    try { fs.unlinkSync(tmpPath); } catch { /* ignore */ }
    throw err;
  }
}

// ── WriteApprovalGate ────────────────────────────────────

/**
 * 写审批门。
 * 所有写入操作先评估决策，needs_confirm 时暂存等待审批。
 */
export class WriteApprovalGate {
  private config: Required<Omit<WriteApprovalConfig, "confirmPatterns" | "denylist" | "allowedRoots">> & {
    denylist: string[];
    allowedRoots: string[];
    confirmPatterns: RegExp[];
  };

  constructor(config: WriteApprovalConfig) {
    this.config = {
      pendingDir: config.pendingDir,
      denylist: config.denylist ?? [],
      allowedRoots: config.allowedRoots ?? [],
      confirmPatterns: config.confirmPatterns ?? [],
      stageTtlMs: config.stageTtlMs ?? 5 * 60 * 1000,
      enabled: config.enabled ?? true,
    };
    if (!fs.existsSync(this.config.pendingDir)) {
      fs.mkdirSync(this.config.pendingDir, { recursive: true });
    }
  }

  /**
   * 评估写入操作的门决策。
   * 三层：file-safety denylist → profile scope → confirm patterns
   */
  evaluate(targetPath: string, _content: string | Buffer, options: { operation: string; agentId: string }): GateDecision {
    if (!this.config.enabled) {
      return { decision: "allow", reason: "gate disabled", risk: "low" };
    }

    const absPath = path.resolve(targetPath);

    // 1. denylist 检查
    for (const pattern of this.config.denylist) {
      if (this.matchPattern(absPath, pattern)) {
        return {
          decision: "deny",
          reason: `路径匹配 denylist 规则: ${pattern}`,
          rule: "denylist",
          risk: "critical",
        };
      }
    }

    // 2. 敏感文件检查（SSH / 环境变量 / 凭据等）
    if (this.isSensitivePath(absPath)) {
      return {
        decision: "deny",
        reason: `路径是敏感文件: ${path.basename(absPath)}`,
        rule: "sensitive_path",
        risk: "critical",
      };
    }

    // 3. profile scope 检查
    if (this.config.allowedRoots.length > 0) {
      const withinRoot = this.config.allowedRoots.some((root) => {
        const absRoot = path.resolve(root);
        return absPath === absRoot || absPath.startsWith(absRoot + path.sep);
      });
      if (!withinRoot) {
        return {
          decision: "deny",
          reason: `路径不在允许的根目录内: ${absPath}`,
          rule: "scope_violation",
          risk: "high",
        };
      }
    }

    // 4. confirm patterns 检查
    for (const pattern of this.config.confirmPatterns) {
      if (pattern.test(absPath)) {
        return {
          decision: "needs_confirm",
          reason: `路径匹配确认模式: ${pattern.source}`,
          rule: "confirm_pattern",
          risk: "medium",
        };
      }
    }

    // 5. 默认放行
    return {
      decision: "allow",
      reason: "default allow",
      risk: "low",
    };
  }

  /**
   * 暂存写入操作。
   * 评估门决策，若 allow 则直接写入，needs_confirm 则暂存。
   *
   * @returns 门决策（含 stageId 若暂存）
   */
  async stageWrite(
    targetPath: string,
    content: string | Buffer,
    options: { operation: "create" | "edit" | "delete" | "move"; agentId: string },
  ): Promise<GateDecision> {
    const decision = this.evaluate(targetPath, content, options);

    if (decision.decision === "allow") {
      // 直接写入
      try {
        const dir = path.dirname(targetPath);
        if (!fs.existsSync(dir)) {
          fs.mkdirSync(dir, { recursive: true });
        }
        atomicWriteFile(targetPath, content);
        return decision;
      } catch (err) {
        return {
          decision: "deny",
          reason: `写入失败: ${err instanceof Error ? err.message : String(err)}`,
          rule: "write_error",
          risk: "high",
        };
      }
    }

    if (decision.decision === "deny") {
      return decision;
    }

    // needs_confirm：暂存
    const stageId = `stage-${Date.now()}-${crypto.randomBytes(4).toString("hex")}`;
    const contentBase64 = Buffer.from(
      typeof content === "string" ? content : content,
    ).toString("base64");

    const staged: StagedWrite = {
      stageId,
      targetPath: path.resolve(targetPath),
      contentBase64,
      operation: options.operation,
      agentId: options.agentId,
      createdAt: Date.now(),
      decision: decision.decision,
      reason: decision.reason,
      risk: decision.risk,
      approvalStatus: "pending",
    };

    const stagePath = path.join(this.config.pendingDir, `${stageId}.json`);
    atomicWriteFile(stagePath, JSON.stringify(staged, null, 2));

    return {
      ...decision,
      stageId,
    };
  }

  /**
   * 审批通过：从 pending store 读取并实际写入。
   */
  async approve(stageId: string): Promise<ApprovalResult> {
    const staged = this.loadStage(stageId);
    if (!staged) {
      return { success: false, stageId, targetPath: "", error: "暂存记录不存在或已过期" };
    }
    if (staged.approvalStatus !== "pending") {
      return { success: false, stageId, targetPath: staged.targetPath, error: `暂存记录状态为 ${staged.approvalStatus}` };
    }

    try {
      const content = Buffer.from(staged.contentBase64, "base64");
      const dir = path.dirname(staged.targetPath);
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }
      atomicWriteFile(staged.targetPath, content);

      // 更新暂存状态
      staged.approvalStatus = "approved";
      const stagePath = path.join(this.config.pendingDir, `${stageId}.json`);
      atomicWriteFile(stagePath, JSON.stringify(staged, null, 2));

      return { success: true, stageId, targetPath: staged.targetPath };
    } catch (err) {
      return {
        success: false,
        stageId,
        targetPath: staged.targetPath,
        error: `审批写入失败: ${err instanceof Error ? err.message : String(err)}`,
      };
    }
  }

  /**
   * 审批拒绝：删除暂存记录。
   */
  reject(stageId: string, _reason?: string): boolean {
    const stagePath = path.join(this.config.pendingDir, `${stageId}.json`);
    if (!fs.existsSync(stagePath)) return false;

    try {
      const staged = this.loadStage(stageId);
      if (staged) {
        staged.approvalStatus = "rejected";
        atomicWriteFile(stagePath, JSON.stringify(staged, null, 2));
      }
      return true;
    } catch {
      return false;
    }
  }

  /** 列出所有待审批的暂存记录 */
  listPending(): Array<{
    stageId: string;
    targetPath: string;
    operation: string;
    agentId: string;
    createdAt: number;
    reason: string;
    risk: string;
  }> {
    if (!fs.existsSync(this.config.pendingDir)) return [];
    const result: Array<{
      stageId: string;
      targetPath: string;
      operation: string;
      agentId: string;
      createdAt: number;
      reason: string;
      risk: string;
    }> = [];

    for (const file of fs.readdirSync(this.config.pendingDir)) {
      if (!file.endsWith(".json")) continue;
      const stagePath = path.join(this.config.pendingDir, file);
      try {
        const raw = fs.readFileSync(stagePath, "utf-8");
        const staged: StagedWrite = JSON.parse(raw);
        if (staged.approvalStatus === "pending") {
          result.push({
            stageId: staged.stageId,
            targetPath: staged.targetPath,
            operation: staged.operation,
            agentId: staged.agentId,
            createdAt: staged.createdAt,
            reason: staged.reason,
            risk: staged.risk,
          });
        }
      } catch {
        // 跳过损坏的暂存文件
      }
    }

    return result.sort((a, b) => a.createdAt - b.createdAt);
  }

  /** 清理过期的暂存记录 */
  cleanupExpired(): number {
    if (!fs.existsSync(this.config.pendingDir)) return 0;
    const now = Date.now();
    let cleaned = 0;

    for (const file of fs.readdirSync(this.config.pendingDir)) {
      if (!file.endsWith(".json")) continue;
      const stagePath = path.join(this.config.pendingDir, file);
      try {
        const raw = fs.readFileSync(stagePath, "utf-8");
        const staged: StagedWrite = JSON.parse(raw);
        if (now - staged.createdAt > this.config.stageTtlMs) {
          staged.approvalStatus = "expired";
          atomicWriteFile(stagePath, JSON.stringify(staged, null, 2));
          cleaned++;
        }
      } catch {
        // 跳过损坏的暂存文件
      }
    }

    return cleaned;
  }

  // ── 内部辅助 ────────────────────────────────────────────

  private loadStage(stageId: string): StagedWrite | null {
    const stagePath = path.join(this.config.pendingDir, `${stageId}.json`);
    if (!fs.existsSync(stagePath)) return null;
    try {
      const raw = fs.readFileSync(stagePath, "utf-8");
      return JSON.parse(raw) as StagedWrite;
    } catch {
      return null;
    }
  }

  /** 路径模式匹配（支持 glob 和字面量） */
  private matchPattern(filePath: string, pattern: string): boolean {
    if (pattern.includes("*")) {
      // glob 匹配（简化版：* 匹配任意字符）
      const regex = new RegExp(
        "^" +
        pattern
          .replace(/[.+^${}()|[\]\\]/g, "\\$&")
          .replace(/\*/g, ".*")
          .replace(/\?/g, ".") +
        "$",
      );
      return regex.test(filePath);
    }
    return filePath === pattern || filePath.startsWith(pattern + path.sep);
  }

  /** 敏感路径检测 */
  private isSensitivePath(filePath: string): boolean {
    const basename = path.basename(filePath).toLowerCase();
    const sensitive = [
      ".env", ".env.local", ".env.production", ".env.staging",
      "id_rsa", "id_dsa", "id_ecdsa", "id_ed25519",
      "authorized_keys", "known_hosts",
      ".npmrc", ".pypirc", ".netrc",
      "credentials", "credentials.json",
      ".aws/credentials", ".aws/config",
      ".gitconfig", ".git-credentials",
      ".ssh/config",
      "shadow", "passwd",
      "sudoers",
    ];
    if (sensitive.includes(basename)) return true;
    // 路径包含 .ssh 或 .aws
    return filePath.includes(path.sep + ".ssh" + path.sep) ||
           filePath.includes(path.sep + ".aws" + path.sep);
  }
}

/**
 * 创建默认的写审批门。
 * 配置：pendingDir=data/write-pending，敏感文件拒绝，需确认模式默认空。
 */
export function createDefaultWriteGate(workspaceRoot: string): WriteApprovalGate {
  return new WriteApprovalGate({
    pendingDir: path.join(workspaceRoot, "data", "write-pending"),
    allowedRoots: [workspaceRoot],
    stageTtlMs: 5 * 60 * 1000,
    enabled: true,
  });
}
