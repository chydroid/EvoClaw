import crypto from "crypto";
import { ServiceRegistry, EventBus } from "@evoclaw/core";

export type Permission = "read" | "write" | "execute" | "admin" | "deploy";

export interface Role {
  name: string;
  permissions: Permission[];
  inherits: string[];
}

export interface RBACUser {
  id: string;
  roles: string[];
  apiKeys: ApiKeyInfo[];
  metadata: Record<string, unknown>;
}

export interface ApiKeyInfo {
  keyHash: string;
  name: string;
  createdAt: Date;
  lastUsed: Date | null;
  expiresAt: Date | null;
  permissions: Permission[];
}

export interface AccessRequest {
  userId: string;
  resource: string;
  action: Permission;
  context: Record<string, unknown>;
}

export class RBACManager {
  private roles = new Map<string, Role>();
  private users = new Map<string, RBACUser>();
  private apiKeys = new Map<string, ApiKeyInfo>();

  constructor(
    private registry: ServiceRegistry,
    private eventBus: EventBus
  ) {
    if (registry) {
      registry.registerService("rbacManager", this);
    }
    this.initializeDefaultRoles();
    this.initializeDefaultAdmin();
  }

  private initializeDefaultRoles(): void {
    this.registerRole({
      name: "admin",
      permissions: ["read", "write", "execute", "admin", "deploy"],
      inherits: [],
    });

    this.registerRole({
      name: "developer",
      permissions: ["read", "write", "execute"],
      inherits: [],
    });

    this.registerRole({
      name: "viewer",
      permissions: ["read"],
      inherits: [],
    });

    this.registerRole({
      name: "agent",
      permissions: ["read", "write", "execute"],
      inherits: [],
    });
  }

  private initializeDefaultAdmin(): void {
    const adminUser: RBACUser = {
      id: "admin",
      roles: ["admin"],
      apiKeys: [],
      metadata: { type: "system" },
    };
    this.users.set("admin", adminUser);
  }

  registerRole(role: Role): void {
    this.roles.set(role.name, role);
  }

  getRole(name: string): Role | undefined {
    return this.roles.get(name);
  }

  listRoles(): string[] {
    return Array.from(this.roles.keys());
  }

  addUser(user: RBACUser): void {
    this.users.set(user.id, user);
  }

  assignRole(userId: string, roleName: string): boolean {
    const user = this.users.get(userId);
    const role = this.roles.get(roleName);

    if (!user || !role) return false;

    if (!user.roles.includes(roleName)) {
      user.roles.push(roleName);
    }

    return true;
  }

  revokeRole(userId: string, roleName: string): boolean {
    const user = this.users.get(userId);
    if (!user) return false;

    user.roles = user.roles.filter((r) => r !== roleName);
    return true;
  }

  checkAccess(request: AccessRequest): boolean {
    const user = this.users.get(request.userId);
    if (!user) return false;

    const allPermissions = this.expandPermissions(user.roles);

    return allPermissions.has(request.action);
  }

  checkAccessOrThrow(request: AccessRequest): void {
    if (!this.checkAccess(request)) {
      throw new Error(
        `Access denied: user "${request.userId}" lacks "${request.action}" on "${request.resource}"`
      );
    }
  }

  createApiKey(userId: string, name: string, permissions: Permission[]): string | null {
    const user = this.users.get(userId);
    if (!user) return null;

    const rawKey = `ek_${this.generateKey()}`;
    const keyHash = this.hashKey(rawKey);

    const apiKey: ApiKeyInfo = {
      keyHash,
      name,
      createdAt: new Date(),
      lastUsed: null,
      expiresAt: new Date(Date.now() + 90 * 24 * 60 * 60 * 1000),
      permissions,
    };

    user.apiKeys.push(apiKey);
    this.apiKeys.set(keyHash, apiKey);

    return rawKey;
  }

  validateApiKey(rawKey: string): ApiKeyInfo | null {
    const keyHash = this.hashKey(rawKey);
    const apiKey = this.apiKeys.get(keyHash);

    if (!apiKey) return null;

    if (apiKey.expiresAt && apiKey.expiresAt < new Date()) {
      this.apiKeys.delete(keyHash);
      return null;
    }

    apiKey.lastUsed = new Date();
    return apiKey;
  }

  revokeApiKey(userId: string, keyHash: string): boolean {
    const user = this.users.get(userId);
    if (!user) return false;

    const index = user.apiKeys.findIndex((k) => k.keyHash === keyHash);
    if (index === -1) return false;

    user.apiKeys.splice(index, 1);
    this.apiKeys.delete(keyHash);

    return true;
  }

  private expandPermissions(userRoles: string[]): Set<Permission> {
    const permissions = new Set<Permission>();
    const visited = new Set<string>();

    const collectPermissions = (roleName: string) => {
      if (visited.has(roleName)) return;
      visited.add(roleName);

      const role = this.roles.get(roleName);
      if (!role) return;

      for (const perm of role.permissions) {
        permissions.add(perm);
      }

      for (const inherited of role.inherits) {
        collectPermissions(inherited);
      }
    };

    for (const roleName of userRoles) {
      collectPermissions(roleName);
    }

    return permissions;
  }

  private generateKey(): string {
    const chars = "abcdefghijklmnopqrstuvwxyz0123456789";
    let key = "";
    for (let i = 0; i < 48; i++) {
      key += chars[crypto.randomInt(chars.length)];
    }
    return key;
  }

  private hashKey(key: string): string {
    return crypto.createHash("sha256").update(key).digest("hex");
  }

  getUser(userId: string): RBACUser | undefined {
    return this.users.get(userId);
  }

  listUsers(): RBACUser[] {
    return Array.from(this.users.values());
  }
}