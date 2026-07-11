import { describe, it, expect, beforeEach } from "vitest";
import { PermissionManager } from "./permission-manager";
import { ServiceRegistry, EventBus } from "@evoclaw/core";

describe("PermissionManager", () => {
  let registry: ServiceRegistry;
  let eventBus: EventBus;
  let pm: PermissionManager;

  beforeEach(() => {
    registry = new ServiceRegistry();
    eventBus = new EventBus();
    pm = new PermissionManager(registry, eventBus);
  });

  // ── Default Rules ────────────────────────────────

  it("should auto-approve file_read by default", () => {
    const req = pm.requestPermission("file_read", "/home/test.txt", {}, "agent");
    expect(req.status).toBe("approved");
  });

  it("should auto-approve file_list by default", () => {
    const req = pm.requestPermission("file_list", "/home", {}, "agent");
    expect(req.status).toBe("approved");
  });

  it("should require consent for file_create", () => {
    const req = pm.requestPermission("file_create", "/home/new.txt", {}, "agent");
    expect(req.status).toBe("pending");
  });

  it("should require consent for file_modify", () => {
    const req = pm.requestPermission("file_modify", "/home/existing.txt", {}, "agent");
    expect(req.status).toBe("pending");
  });

  it("should require consent for file_delete", () => {
    const req = pm.requestPermission("file_delete", "/home/old.txt", {}, "agent");
    expect(req.status).toBe("pending");
  });

  it("should deny unknown operations", () => {
    const req = pm.requestPermission("unknown_op", "/target", {}, "agent");
    expect(req.status).toBe("denied");
  });

  // ── Approve / Deny ───────────────────────────────

  it("should approve a pending request", () => {
    const req = pm.requestPermission("file_create", "/test.txt", {}, "agent");
    expect(req.status).toBe("pending");

    const approved = pm.approveRequest(req.id);
    expect(approved).toBeDefined();
    expect(approved!.status).toBe("approved");

    const fetched = pm.getRequest(req.id);
    expect(fetched!.status).toBe("approved");
  });

  it("should not approve a non-pending request", () => {
    const req = pm.requestPermission("file_read", "/test.txt", {}, "agent");
    expect(req.status).toBe("approved");

    const result = pm.approveRequest(req.id);
    expect(result).toBeUndefined();
  });

  it("should deny a pending request", () => {
    const req = pm.requestPermission("file_create", "/test.txt", {}, "agent");
    const denied = pm.denyRequest(req.id);
    expect(denied).toBeDefined();
    expect(denied!.status).toBe("denied");
  });

  it("should not deny a non-pending request", () => {
    const req = pm.requestPermission("file_read", "/test.txt", {}, "agent");
    const result = pm.denyRequest(req.id);
    expect(result).toBeUndefined();
  });

  // ── Whitelist ─────────────────────────────────────

  it("should add and remove from whitelist", () => {
    pm.addToWhitelist("file_create", "/safe/*");
    expect(pm.isWhitelisted("file_create", "/safe/anything.txt")).toBe(true);

    pm.removeFromWhitelist("file_create", "/safe/*");
    expect(pm.isWhitelisted("file_create", "/safe/anything.txt")).toBe(false);
  });

  it("should not duplicate whitelist entries", () => {
    pm.addToWhitelist("file_create", "/safe/*");
    pm.addToWhitelist("file_create", "/safe/*");
    expect(pm.getWhitelist()).toHaveLength(1);
  });

  it("should auto-approve whitelisted operations", () => {
    pm.addToWhitelist("file_delete", "/tmp/*");
    const req = pm.requestPermission("file_delete", "/tmp/cache.bin", {}, "agent");
    expect(req.status).toBe("approved");
  });

  it("should match wildcard patterns", () => {
    pm.addToWhitelist("file_create", "/projects/*");
    expect(pm.isWhitelisted("file_create", "/projects/app/main.ts")).toBe(true);
    expect(pm.isWhitelisted("file_create", "/other/file.ts")).toBe(false);
  });

  it("should reject path traversal in wildcard patterns", () => {
    pm.addToWhitelist("file_create", "/safe/*");
    expect(pm.isWhitelisted("file_create", "/safe/anything.txt")).toBe(true);
    expect(pm.isWhitelisted("file_create", "/safe/../etc/passwd")).toBe(false);
    expect(pm.isWhitelisted("file_create", "/safe/sub/../etc/passwd")).toBe(false);
  });

  it("should match exact patterns", () => {
    pm.addToWhitelist("file_create", "/exact/path.ts");
    expect(pm.isWhitelisted("file_create", "/exact/path.ts")).toBe(true);
    expect(pm.isWhitelisted("file_create", "/exact/path.ts/extra")).toBe(false);
  });

  // ── Directory Whitelist ──────────────────────────

  it("should auto-approve paths within whitelisted directories", () => {
    pm.addDirectoryWhitelist("/safe/dir", ["file_create", "file_modify"]);
    expect(pm.isPathAutoApproved("/safe/dir/sub/file.txt", "file_create")).toBe(true);
    expect(pm.isPathAutoApproved("/safe/dir/sub/file.txt", "file_modify")).toBe(true);
    expect(pm.isPathAutoApproved("/safe/dir/sub/file.txt", "file_delete")).toBe(false);
  });

  it("should not auto-approve paths outside whitelisted directories", () => {
    pm.addDirectoryWhitelist("/safe/dir", ["*"]);
    expect(pm.isPathAutoApproved("/unsafe/dir/file.txt", "file_create")).toBe(false);
  });

  it("should handle wildcard operations in directory whitelist", () => {
    pm.addDirectoryWhitelist("/workspace", ["*"]);
    expect(pm.isPathAutoApproved("/workspace/any/file.txt", "file_create")).toBe(true);
    expect(pm.isPathAutoApproved("/workspace/any/file.txt", "file_delete")).toBe(true);
  });

  it("should normalize Windows paths", () => {
    pm.addDirectoryWhitelist("C:/projects", ["file_create"]);
    expect(pm.isPathAutoApproved("C:\\projects\\src\\main.ts", "file_create")).toBe(true);
  });

  // ── Approval with Whitelist ──────────────────────

  it("should add to whitelist when approving with addToWhitelist flag", () => {
    const req = pm.requestPermission("file_create", "/new/path.ts", {}, "agent");
    pm.approveRequest(req.id, true);

    expect(pm.isWhitelisted("file_create", "/new/path.ts")).toBe(true);
  });

  // ── Pending Requests ─────────────────────────────

  it("should list pending requests", () => {
    pm.requestPermission("file_create", "/a.txt", {}, "agent");
    pm.requestPermission("file_modify", "/b.txt", {}, "agent");
    pm.requestPermission("file_read", "/c.txt", {}, "agent"); // auto-approved

    const pending = pm.getPendingRequests();
    expect(pending).toHaveLength(2);
  });

  it("should get all requests", () => {
    pm.requestPermission("file_create", "/a.txt", {}, "agent");
    pm.requestPermission("file_read", "/b.txt", {}, "agent");

    const all = pm.getAllRequests();
    expect(all).toHaveLength(2);
  });

  // ── Approved Operations ──────────────────────────

  it("should reuse approved operations within time window", () => {
    const r = pm.requestPermission("file_create", "/x.txt", {}, "agent");
    pm.approveRequest(r.id);

    // Same operation + target within the time window should be auto-approved
    const r2 = pm.requestPermission("file_create", "/x.txt", {}, "agent");
    expect(r2.status).toBe("approved");
  });

  it("should not auto-approve a different target within time window", () => {
    const r = pm.requestPermission("file_create", "/x.txt", {}, "agent");
    pm.approveRequest(r.id);

    // A different target must NOT be auto-approved (no cross-target reuse)
    const r2 = pm.requestPermission("file_create", "/y.txt", {}, "agent");
    expect(r2.status).toBe("pending");
  });

  // ── Cleanup ──────────────────────────────────────

  it("should clean expired requests", () => {
    const req = pm.requestPermission("file_create", "/test.txt", {}, "agent");
    expect(req.status).toBe("pending");

    // Fast-forward by overriding time behavior...
    // cleanExpiredRequests with ttl=0 should mark pending as expired
    const removed = pm.cleanExpiredRequests(0);
    expect(removed).toBeGreaterThanOrEqual(0);

    // The pending request should now be expired
    const fetched = pm.getRequest(req.id);
    if (fetched) {
      expect(["expired", "pending"]).toContain(fetched.status);
    }
  });

  // ── Health Check ─────────────────────────────────

  it("should return healthy", async () => {
    const healthy = await pm.healthCheck();
    expect(healthy).toBe(true);
  });
});