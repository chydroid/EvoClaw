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

export class PermissionManager {
  private requests = new Map<string, PermissionRequest>();
  private rules = new Map<string, PermissionRule>();
  private approvedOperations = new Map<string, Date>();

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
      description: "Create a new file at the specified path",
    });

    this.rules.set("file_modify", {
      operation: "file_modify",
      autoApprove: false,
      requireExplicitConsent: true,
      description: "Modify an existing file's content",
    });

    this.rules.set("file_delete", {
      operation: "file_delete",
      autoApprove: false,
      requireExplicitConsent: true,
      description: "Delete a file at the specified path",
    });

    this.rules.set("file_read", {
      operation: "file_read",
      autoApprove: true,
      requireExplicitConsent: false,
      description: "Read the contents of a file",
    });

    this.rules.set("file_list", {
      operation: "file_list",
      autoApprove: true,
      requireExplicitConsent: false,
      description: "List files and directories in a folder",
    });

    this.rules.set("skill_find_and_install", {
      operation: "skill_find_and_install",
      autoApprove: false,
      requireExplicitConsent: true,
      description: "Automatically find and install a suitable skill",
    });

    this.rules.set("skill_search", {
      operation: "skill_search",
      autoApprove: true,
      requireExplicitConsent: false,
      description: "Search for available skills",
    });
  }

  requestPermission(
    operation: string,
    target: string,
    details: Record<string, unknown>,
    requestedBy: string = "system"
  ): PermissionRequest {
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
      description: "Unknown operation",
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

  approveRequest(requestId: string): PermissionRequest | undefined {
    const request = this.requests.get(requestId);
    if (!request || request.status !== "pending") return undefined;

    request.status = "approved";
    request.respondedAt = new Date();
    this.approvedOperations.set(request.operation, new Date());

    this.eventBus.publish(
      "permission.approved",
      { requestId, operation: request.operation, target: request.target },
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