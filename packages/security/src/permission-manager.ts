import { ServiceRegistry, EventBus } from "@evoclaw/core";
import { v4 as uuid } from "uuid";

export interface PermissionRequest {
  id: string;
  operation: string;
  description: string;
  target: string;
  details: Record<string, unknown>;
  status: "pending" | "approved" | "denied" | "expired";
  requestedAt: Date;
  respondedAt?: Date;
  requestedBy: string;
}

export interface PermissionRule {
  operation: string;
  autoApprove: boolean;
  requireExplicitConsent: boolean;
  description: string;
}

export interface WhitelistEntry {
  operation: string;
  targetPattern: string;
  createdAt: Date;
}

export class PermissionManager {
  private requests = new Map<string, PermissionRequest>();
  private rules = new Map<string, PermissionRule>();
  private approvedOperations = new Map<string, Date>();
  private whitelist: WhitelistEntry[] = [];
  private whitelistedDirs: Array<{ dirPath: string; operations: string[] }> = [];

  /**
   * Add a directory to the auto-approve whitelist.
   * All file operations (create/modify/delete) within this directory get
   * automatically approved without prompting the user.
   * @param dirPath Absolute path to the directory
   * @param operations File operations to auto-approve, or ["*"] for all
   */
  addDirectoryWhitelist(dirPath: string, operations: string[]): void {
    const normalized = dirPath.replace(/\\/g, "/").replace(/\/$/, "") + "/";
    this.whitelistedDirs.push({ dirPath: normalized, operations });
    console.log(`[PermissionManager] Directory whitelisted: ${normalized} → ${operations.join(", ")}`);
  }

  /**
   * Check whether a resolved (absolute) path falls within a whitelisted directory
   * for the given operation.
   */
  isPathAutoApproved(resolvedPath: string, operation: string): boolean {
    const normalized = resolvedPath.replace(/\\/g, "/");
    // Remove path traversal components
    const safePath = normalized.replace(/\/\.\.\//g, "/").replace(/\/\.\//g, "/");
    for (const entry of this.whitelistedDirs) {
      if (!entry.operations.includes(operation) && !entry.operations.includes("*")) continue;
      const safeDir = entry.dirPath.replace(/\/\.\.\//g, "/").replace(/\/\.\//g, "/");
      if (safePath.startsWith(safeDir)) return true;
    }
    return false;
  }

  constructor(
    private registry: ServiceRegistry,
    private eventBus: EventBus
  ) {
    this.registerDefaultRules();
  }

  private registerDefaultRules(): void {
    this.rules.set("file_create", {
      operation: "file_create",
      autoApprove: false,
      requireExplicitConsent: true,
      description: "创建文件",
    });

    this.rules.set("file_modify", {
      operation: "file_modify",
      autoApprove: false,
      requireExplicitConsent: true,
      description: "修改文件内容",
    });

    this.rules.set("file_delete", {
      operation: "file_delete",
      autoApprove: false,
      requireExplicitConsent: true,
      description: "删除文件",
    });

    this.rules.set("file_read", {
      operation: "file_read",
      autoApprove: true,
      requireExplicitConsent: false,
      description: "读取文件内容",
    });

    this.rules.set("file_list", {
      operation: "file_list",
      autoApprove: true,
      requireExplicitConsent: false,
      description: "列出文件夹内容",
    });

    this.rules.set("skill_find_and_install", {
      operation: "skill_find_and_install",
      autoApprove: false,
      requireExplicitConsent: true,
      description: "自动查找并安装技能",
    });

    this.rules.set("skill_search", {
      operation: "skill_search",
      autoApprove: true,
      requireExplicitConsent: false,
      description: "搜索可用技能",
    });

    this.rules.set("browser_navigate", {
      operation: "browser_navigate",
      autoApprove: false,
      requireExplicitConsent: true,
      description: "访问网页URL",
    });

    this.rules.set("browser_submit_form", {
      operation: "browser_submit_form",
      autoApprove: false,
      requireExplicitConsent: true,
      description: "提交网页表单",
    });

    this.rules.set("email_add_account", {
      operation: "email_add_account",
      autoApprove: false,
      requireExplicitConsent: true,
      description: "添加邮箱账户",
    });

    this.rules.set("email_send", {
      operation: "email_send",
      autoApprove: false,
      requireExplicitConsent: true,
      description: "发送邮件",
    });
  }

  addToWhitelist(operation: string, target: string): WhitelistEntry {
    const existing = this.whitelist.find(
      (e) => e.operation === operation && e.targetPattern === target
    );
    if (existing) return existing;

    const entry: WhitelistEntry = {
      operation,
      targetPattern: target,
      createdAt: new Date(),
    };
    this.whitelist.push(entry);

    this.eventBus.publish(
      "permission.whitelist_added",
      { operation, target },
      "permission-manager"
    );

    return entry;
  }

  removeFromWhitelist(operation: string, target: string): boolean {
    const idx = this.whitelist.findIndex(
      (e) => e.operation === operation && e.targetPattern === target
    );
    if (idx === -1) return false;
    this.whitelist.splice(idx, 1);
    return true;
  }

  isWhitelisted(operation: string, target: string): boolean {
    for (const entry of this.whitelist) {
      if (entry.operation !== operation) continue;
      if (this.matchTarget(target, entry.targetPattern)) return true;
    }
    return false;
  }

  getWhitelist(): WhitelistEntry[] {
    return [...this.whitelist];
  }

  private matchTarget(target: string, pattern: string): boolean {
    if (pattern.endsWith("*")) {
      return target.startsWith(pattern.slice(0, -1));
    }
    return target === pattern;
  }

  requestPermission(
    operation: string,
    target: string,
    details: Record<string, unknown>,
    requestedBy: string = "system"
  ): PermissionRequest {
    if (this.isWhitelisted(operation, target)) {
      const approved: PermissionRequest = {
        id: uuid().slice(0, 8),
        operation,
        description: `白名单授权: ${operation}`,
        target,
        details,
        status: "approved",
        requestedAt: new Date(),
        respondedAt: new Date(),
        requestedBy,
      };
      this.requests.set(approved.id, approved);
      this.approvedOperations.set(operation, new Date());
      return approved;
    }

    if (this.isApprovedForOperation(operation, target)) {
      const approved: PermissionRequest = {
        id: uuid().slice(0, 8),
        operation,
        description: `已批准: ${operation}`,
        target,
        details,
        status: "approved",
        requestedAt: new Date(),
        respondedAt: new Date(),
        requestedBy,
      };
      this.requests.set(approved.id, approved);
      this.approvedOperations.set(operation, new Date());
      return approved;
    }

    const rule = this.rules.get(operation);

    if (rule?.autoApprove) {
      const approved: PermissionRequest = {
        id: uuid().slice(0, 8),
        operation,
        description: rule.description,
        target,
        details,
        status: "approved",
        requestedAt: new Date(),
        respondedAt: new Date(),
        requestedBy,
      };
      this.requests.set(approved.id, approved);
      this.approvedOperations.set(operation, new Date());

      this.eventBus.publish(
        "permission.auto_approved",
        { requestId: approved.id, operation, target },
        "permission-manager"
      );

      return approved;
    }

    if (rule?.requireExplicitConsent) {
      const request: PermissionRequest = {
        id: uuid().slice(0, 8),
        operation,
        description: rule.description,
        target,
        details,
        status: "pending",
        requestedAt: new Date(),
        requestedBy,
      };

      this.requests.set(request.id, request);

      this.eventBus.publish(
        "permission.requested",
        { requestId: request.id, operation, target, details },
        "permission-manager"
      );

      return request;
    }

    const denied: PermissionRequest = {
      id: uuid().slice(0, 8),
      operation,
      description: "未知操作类型",
      target,
      details,
      status: "denied",
      requestedAt: new Date(),
      respondedAt: new Date(),
      requestedBy,
    };

    this.requests.set(denied.id, denied);
    return denied;
  }

  approveRequest(requestId: string, addToWhitelist: boolean = false): PermissionRequest | undefined {
    const request = this.requests.get(requestId);
    if (!request || request.status !== "pending") return undefined;

    request.status = "approved";
    request.respondedAt = new Date();
    this.approvedOperations.set(request.operation, new Date());

    if (addToWhitelist) {
      this.addToWhitelist(request.operation, request.target);
    }

    this.eventBus.publish(
      "permission.approved",
      {
        requestId,
        operation: request.operation,
        target: request.target,
        whitelisted: addToWhitelist,
      },
      "permission-manager"
    );

    return request;
  }

  denyRequest(requestId: string): PermissionRequest | undefined {
    const request = this.requests.get(requestId);
    if (!request || request.status !== "pending") return undefined;

    request.status = "denied";
    request.respondedAt = new Date();

    this.eventBus.publish(
      "permission.denied",
      { requestId, operation: request.operation, target: request.target },
      "permission-manager"
    );

    return request;
  }

  checkApproval(operation: string): boolean {
    const approvedAt = this.approvedOperations.get(operation);
    if (!approvedAt) return false;

    const fiveMinutes = 5 * 60 * 1000;
    const elapsed = Date.now() - approvedAt.getTime();
    if (elapsed > fiveMinutes) {
      this.approvedOperations.delete(operation);
      return false;
    }

    return true;
  }

  isApprovedForOperation(operation: string, target: string): boolean {
    if (this.isWhitelisted(operation, target)) return true;
    if (this.checkApproval(operation)) return true;

    for (const [, req] of this.requests) {
      if (
        req.operation === operation &&
        req.target === target &&
        req.status === "approved"
      ) {
        const elapsed = Date.now() - new Date(req.respondedAt!).getTime();
        if (elapsed < 5 * 60 * 1000) return true;
      }
    }

    return false;
  }

  getPendingRequests(): PermissionRequest[] {
    return Array.from(this.requests.values()).filter(
      (r) => r.status === "pending"
    );
  }

  getRequest(requestId: string): PermissionRequest | undefined {
    return this.requests.get(requestId);
  }

  getAllRequests(): PermissionRequest[] {
    return Array.from(this.requests.values());
  }

  cleanExpiredRequests(ttlMs: number = 10 * 60 * 1000): number {
    let removed = 0;
    const now = Date.now();

    for (const [key, req] of this.requests) {
      const elapsed = now - req.requestedAt.getTime();
      if (elapsed > ttlMs) {
        if (req.status === "pending") {
          req.status = "expired";
        } else {
          this.requests.delete(key);
          removed++;
        }
      }
    }

    for (const [op, time] of this.approvedOperations) {
      if (now - time.getTime() > 5 * 60 * 1000) {
        this.approvedOperations.delete(op);
      }
    }

    return removed;
  }

  async healthCheck(): Promise<boolean> {
    return true;
  }
}