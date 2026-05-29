import { describe, it, expect, vi, beforeEach } from "vitest";
import { SSHSandbox } from "./ssh-sandbox";
import { SandboxManager } from "./sandbox-manager";

describe("SSHSandbox", () => {
  describe("constructor", () => {
    it("should accept SSH config", () => {
      const ssh = new SSHSandbox({
        host: "192.168.1.100",
        port: 22,
        user: "testuser",
        password: "testpass",
      });

      expect(ssh).toBeDefined();
    });

    it("should use default port 22", () => {
      const ssh = new SSHSandbox({
        host: "192.168.1.100",
        user: "testuser",
      });

      expect(ssh).toBeDefined();
    });
  });

  describe("isAvailable", () => {
    it("should return false when SSH is not available", async () => {
      const ssh = new SSHSandbox({
        host: "127.0.0.1",
        port: 59999,
        user: "nonexistent",
        password: "wrong",
      });

      const available = await ssh.isAvailable();
      expect(available).toBe(false);
    });
  });

  describe("execute", () => {
    it("should return error when SSH is not available", async () => {
      const ssh = new SSHSandbox({
        host: "127.0.0.1",
        port: 59999,
        user: "nonexistent",
        password: "wrong",
      });

      const result = await ssh.execute("echo hello");
      expect(result.success).toBe(false);
      expect(result.exitCode).not.toBe(0);
    });
  });

  describe("dispose", () => {
    it("should reset availability state", async () => {
      const ssh = new SSHSandbox({
        host: "127.0.0.1",
        port: 59999,
        user: "testuser",
      });

      await ssh.isAvailable();
      ssh.dispose();
    });
  });
});

describe("SandboxManager", () => {
  let manager: SandboxManager;

  beforeEach(() => {
    manager = new SandboxManager();
  });

  describe("createSession", () => {
    it("should create a Docker session (when Docker unavailable)", async () => {
      try {
        const session = await manager.createSession({ backend: "docker" });
        expect(session.backend).toBe("docker");
        expect(session.id).toMatch(/^sandbox-/);
      } catch (err) {
        expect((err as Error).message).toContain("Docker is not available");
      }
    });

    it("should create an SSH session (when SSH unavailable)", async () => {
      try {
        const session = await manager.createSession({
          backend: "ssh",
          ssh: {
            host: "127.0.0.1",
            port: 59999,
            user: "testuser",
            password: "testpass",
          },
        });
        expect(session.backend).toBe("ssh");
      } catch (err) {
        expect((err as Error).message).toContain("not available");
      }
    });

    it("should reject SSH session without config", async () => {
      await expect(
        manager.createSession({ backend: "ssh" })
      ).rejects.toThrow("SSH config is required");
    });
  });

  describe("execute", () => {
    it("should return error for unknown session", async () => {
      const result = await manager.execute("nonexistent", ["echo", "hello"]);
      expect(result.success).toBe(false);
      expect(result.error).toBe("Session not found");
    });
  });

  describe("executeScript", () => {
    it("should return error for unknown session", async () => {
      const result = await manager.executeScript("nonexistent", "console.log(1)");
      expect(result.success).toBe(false);
      expect(result.error).toBe("Session not found");
    });
  });

  describe("listSessions", () => {
    it("should list active sessions", async () => {
      expect(manager.listSessions()).toEqual([]);
    });
  });

  describe("listBackends", () => {
    it("should list available backends", async () => {
      const backends = await manager.listBackends();
      expect(backends.length).toBe(3);
      expect(backends.map((b) => b.type).sort()).toEqual(["docker", "process", "ssh"]);
    });
  });

  describe("destroySession", () => {
    it("should handle destroying nonexistent session", async () => {
      await expect(manager.destroySession("nonexistent")).resolves.toBeUndefined();
    });
  });

  describe("dispose", () => {
    it("should clean up all resources", async () => {
      await manager.dispose();
      expect(manager.listSessions()).toEqual([]);
    });
  });
});
