import { describe, it, expect } from "vitest";
import { RBACManager } from "./rbac-manager";

describe("RBACManager", () => {
  it("should have default roles", () => {
    const rbac = new RBACManager(null as never, null as never);
    const roles = rbac.listRoles();
    expect(roles).toContain("admin");
    expect(roles).toContain("developer");
    expect(roles).toContain("viewer");
  });

  it("should have default admin user", () => {
    const rbac = new RBACManager(null as never, null as never);
    const admin = rbac.getUser("admin");
    expect(admin).toBeDefined();
    expect(admin!.roles).toContain("admin");
  });

  it("should grant access to user with correct role", () => {
    const rbac = new RBACManager(null as never, null as never);

    rbac.addUser({ id: "user1", roles: ["developer"], apiKeys: [], metadata: {} });

    expect(
      rbac.checkAccess({ userId: "user1", resource: "skills", action: "write", context: {} })
    ).toBe(true);
  });

  it("should deny access to user without permission", () => {
    const rbac = new RBACManager(null as never, null as never);

    rbac.addUser({ id: "user2", roles: ["viewer"], apiKeys: [], metadata: {} });

    expect(
      rbac.checkAccess({ userId: "user2", resource: "skills", action: "write", context: {} })
    ).toBe(false);
  });

  it("should deny access to unknown user", () => {
    const rbac = new RBACManager(null as never, null as never);

    expect(
      rbac.checkAccess({ userId: "unknown", resource: "any", action: "read", context: {} })
    ).toBe(false);
  });

  it("should create and validate API keys", () => {
    const rbac = new RBACManager(null as never, null as never);

    rbac.addUser({ id: "dev1", roles: ["developer"], apiKeys: [], metadata: {} });

    const key = rbac.createApiKey("dev1", "test-key", ["read", "write"]);
    expect(key).toBeTruthy();
    expect(key).toMatch(/^ek_/);

    const validation = rbac.validateApiKey(key!);
    expect(validation).toBeTruthy();
    expect(validation!.permissions).toContain("read");

    const invalid = rbac.validateApiKey("ek_invalid");
    expect(invalid).toBeNull();
  });

  it("should assign and revoke roles", () => {
    const rbac = new RBACManager(null as never, null as never);

    rbac.addUser({ id: "user3", roles: [], apiKeys: [], metadata: {} });

    expect(rbac.assignRole("user3", "viewer")).toBe(true);
    expect(rbac.getUser("user3")!.roles).toContain("viewer");

    expect(rbac.revokeRole("user3", "viewer")).toBe(true);
    expect(rbac.getUser("user3")!.roles).not.toContain("viewer");
  });

  it("should throw on access denial when using checkAccessOrThrow", () => {
    const rbac = new RBACManager(null as never, null as never);

    rbac.addUser({ id: "viewer", roles: ["viewer"], apiKeys: [], metadata: {} });

    expect(() =>
      rbac.checkAccessOrThrow({
        userId: "viewer",
        resource: "evolution",
        action: "deploy",
        context: {},
      })
    ).toThrow();
  });

  it("should register custom roles", () => {
    const rbac = new RBACManager(null as never, null as never);

    rbac.registerRole({
      name: "operator",
      permissions: ["read", "execute"],
      inherits: ["viewer"],
    });

    const role = rbac.getRole("operator");
    expect(role).toBeDefined();
    expect(role!.permissions).toContain("execute");
    expect(role!.inherits).toContain("viewer");
  });

  it("should expand inherited permissions", () => {
    const rbac = new RBACManager(null as never, null as never);

    rbac.registerRole({
      name: "operator",
      permissions: ["execute"],
      inherits: ["viewer"],
    });

    rbac.addUser({ id: "op1", roles: ["operator"], apiKeys: [], metadata: {} });

    expect(
      rbac.checkAccess({ userId: "op1", resource: "any", action: "read", context: {} })
    ).toBe(true);

    expect(
      rbac.checkAccess({ userId: "op1", resource: "any", action: "execute", context: {} })
    ).toBe(true);

    expect(
      rbac.checkAccess({ userId: "op1", resource: "any", action: "admin", context: {} })
    ).toBe(false);
  });
});