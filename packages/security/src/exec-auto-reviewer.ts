/**
 * Exec Auto-Reviewer — 命令执行自动审查规则引擎
 *
 * 借鉴 openclaw-main exec-auto-review 设计：在 ExecApprovalPolicy 产出决策后，
 * 对 (request, decision) 二元组做补充审查，输出结构化 findings 供审计/告警。
 *
 * 与 ExecApprovalPolicy 的关系：
 *   - Policy 决定 allow/deny/require_approval/audit_only（动作）
 *   - AutoReviewer 产出 findings（info/warning/error），不改变动作，仅补充信号
 *
 * 默认审查规则：
 *   1. env-leak：环境变量泄露（KEY/SECRET/TOKEN/PASSWORD 赋值）
 *   2. path-traversal：路径遍历（../ 或 /etc /root /home 绝对路径）
 *   3. net-pipe-shell：网络下载执行（curl|sh、wget|bash）
 *   4. cmd-injection：命令注入（$() 或反引号）
 *   5. dangerous-perm：危险权限（chmod 777、chown root）
 *   6. rm-rf-root：大文件删除（rm -rf / 未带 --no-preserve-root）
 */

import type {
  ExecApprovalAction,
  ExecApprovalDecision,
  ExecApprovalRequest,
} from "./exec-approval.js";

/** 单条审查发现 */
export interface ExecReviewFinding {
  severity: "info" | "warning" | "error";
  /** 规则 ID */
  rule: string;
  /** 人类可读消息 */
  message: string;
  /** 修复建议（可选） */
  suggestion?: string;
}

/** 审查器内部结构 */
interface Reviewer {
  id: string;
  appliesToActions: ExecApprovalAction[];
  review: (req: ExecApprovalRequest, decision: ExecApprovalDecision) => ExecReviewFinding | null;
}

// 默认审查器适用的全部动作
const ALL_ACTIONS: ExecApprovalAction[] = ["allow", "deny", "require_approval", "audit_only"];

/**
 * 自动审查引擎：注册并执行多个 reviewer，聚合 findings。
 */
export class ExecAutoReviewer {
  private reviewers: Reviewer[] = [];

  constructor() {
    this.registerDefaultReviewers();
  }

  /**
   * 对 (request, decision) 执行所有适用 reviewer，返回 findings 列表。
   */
  review(req: ExecApprovalRequest, decision: ExecApprovalDecision): ExecReviewFinding[] {
    const findings: ExecReviewFinding[] = [];
    for (const reviewer of this.reviewers) {
      if (!reviewer.appliesToActions.includes(decision.action)) continue;
      try {
        const finding = reviewer.review(req, decision);
        if (finding) findings.push(finding);
      } catch {
        // 审查器内部异常不应影响其他审查器执行
      }
    }
    return findings;
  }

  /** 注册自定义审查器 */
  registerReviewer(
    id: string,
    appliesTo: ExecApprovalAction[],
    fn: (req: ExecApprovalRequest, decision: ExecApprovalDecision) => ExecReviewFinding | null,
  ): void {
    // 同 ID 替换
    const idx = this.reviewers.findIndex((r) => r.id === id);
    const entry: Reviewer = { id, appliesToActions: appliesTo, review: fn };
    if (idx >= 0) {
      this.reviewers[idx] = entry;
    } else {
      this.reviewers.push(entry);
    }
  }

  /** 移除审查器 */
  removeReviewer(id: string): boolean {
    const before = this.reviewers.length;
    this.reviewers = this.reviewers.filter((r) => r.id !== id);
    return this.reviewers.length < before;
  }

  /** 列出已注册审查器 ID */
  listReviewers(): string[] {
    return this.reviewers.map((r) => r.id);
  }

  // ── 默认审查器 ──────────────────────────────────────────

  private registerDefaultReviewers(): void {
    // 1. 环境变量泄露检测
    this.registerReviewer("env-leak", ALL_ACTIONS, (req) => {
      const text = `${req.command} ${Object.keys(req.env ?? {}).join(" ")}`;
      // 形如 API_KEY=...、SECRET=...、TOKEN=...、PASSWORD=...
      if (/\b[\w-]*(?:KEY|SECRET|TOKEN|PASSWORD|CREDENTIAL|APIKEY)\w*\s*=/i.test(text)) {
        return {
          severity: "warning",
          rule: "env-leak",
          message: "命令或环境变量中检测到疑似凭据赋值",
          suggestion: "避免在命令行直接传递凭据，改用 secret manager 或环境文件",
        };
      }
      return null;
    });

    // 2. 路径遍历检测
    this.registerReviewer("path-traversal", ALL_ACTIONS, (req) => {
      const text = req.command;
      // 相对路径遍历 ../ 或 ..\
      if (/\.\.[\\/]/.test(text)) {
        return {
          severity: "warning",
          rule: "path-traversal",
          message: "命令中包含路径遍历序列（..）",
          suggestion: "校验目标路径在工作目录范围内",
        };
      }
      // 敏感系统目录绝对路径（/etc/...、/root/...、/home/...）
      if (/(^|[\s"'(])(\/etc|\/root|\/home)(\/|$|\s)/.test(text)) {
        return {
          severity: "warning",
          rule: "path-traversal",
          message: "命令引用敏感系统目录",
          suggestion: "确认操作必要性并限定范围",
        };
      }
      return null;
    });

    // 3. 网络下载执行检测（curl|sh / wget|bash）
    this.registerReviewer("net-pipe-shell", ALL_ACTIONS, (req) => {
      if (/(?:curl|wget)\b[\s\S]*\|\s*(?:sh|bash|zsh)\b/i.test(req.command)) {
        return {
          severity: "error",
          rule: "net-pipe-shell",
          message: "检测到网络下载并管道执行 shell 解释器",
          suggestion: "下载到文件并校验哈希后再执行",
        };
      }
      return null;
    });

    // 4. 命令注入检测（$() 或反引号）
    this.registerReviewer("cmd-injection", ALL_ACTIONS, (req) => {
      if (/\$\(/.test(req.command) || /`[^`]*`/.test(req.command)) {
        return {
          severity: "warning",
          rule: "cmd-injection",
          message: "命令中包含命令替换语法（$() 或反引号）",
          suggestion: "确认替换内容受信，避免拼接不可信输入",
        };
      }
      return null;
    });

    // 5. 危险权限检测（chmod 777、chown root）
    this.registerReviewer("dangerous-perm", ALL_ACTIONS, (req) => {
      if (/\bchmod\b[\s\S]*\b777\b/i.test(req.command)) {
        return {
          severity: "warning",
          rule: "dangerous-perm",
          message: "chmod 777 给予所有人读写执行权限",
          suggestion: "使用更严格的权限位（如 750）",
        };
      }
      if (/\bchown\b[\s\S]*\broot\b/i.test(req.command)) {
        return {
          severity: "warning",
          rule: "dangerous-perm",
          message: "chown root 修改属主为 root",
          suggestion: "确认是否必须，避免提权风险",
        };
      }
      return null;
    });

    // 6. 大文件删除检测（rm -rf / 未带 --no-preserve-root）
    this.registerReviewer("rm-rf-root", ALL_ACTIONS, (req) => {
      // rm -rf / 或 rm -rf /* 但未显式带 --no-preserve-root
      if (/\brm\b[\s\S]*-r\w*f\b[\s\S]*\s+\/(\s|$)/i.test(req.command) &&
          !/--no-preserve-root/.test(req.command)) {
        return {
          severity: "error",
          rule: "rm-rf-root",
          message: "递归强制删除根路径（未带 --no-preserve-root）",
          suggestion: "显式指定目标子目录，避免误删根文件系统",
        };
      }
      return null;
    });
  }
}
