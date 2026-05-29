import { describe, it, expect, vi, beforeEach } from "vitest";
import { PluginHost } from "./plugin-host";
import type { PluginManifest, PluginState } from "./types";
import { PluginStatus } from "./types";
import type { Plugin } from "./plugin";
import { createManifest } from "./plugin";

function createTestPlugin(overrides?: Partial<PluginManifest>): Plugin {
  const manifest = createManifest(
    `test-plugin-${Date.now()}`,
    "Test Plugin",
    "1.0.0",
    { description: "A test plugin", ...overrides }
  );

  return {
    manifest,
    get state(): PluginState {
      return { manifest, status: PluginStatus.Registered };
    },
    init: vi.fn().mockResolvedValue(undefined),
    shutdown: vi.fn().mockResolvedValue(undefined),
    getHooks: vi.fn().mockReturnValue(["onMessageReceived", "onToolExecuted"]),
    healthCheck: vi.fn().mockResolvedValue({ healthy: true }),
  };
}

describe("PluginHost", () => {
  let host: PluginHost;

  beforeEach(() => {
    host = new PluginHost({ autoActivate: false });
  });

  describe("registerPlugin", () => {
    it("should register a plugin", () => {
      const plugin = createTestPlugin({ id: "test-1" });
      host.registerPlugin(plugin);

      const state = host.getPluginState("test-1");
      expect(state).toBeDefined();
      expect(state!.manifest.id).toBe("test-1");
      expect(state!.status).toBe(PluginStatus.Registered);
    });

    it("should reject duplicate plugin IDs", () => {
      const plugin = createTestPlugin({ id: "dup" });
      host.registerPlugin(plugin);

      expect(() => host.registerPlugin(createTestPlugin({ id: "dup" }))).toThrow(
        "already registered"
      );
    });

    it("should reject invalid manifests", () => {
      const badPlugin = {
        manifest: { name: "no-id" } as any,
        get state() { return { manifest: badPlugin.manifest, status: PluginStatus.Registered }; },
        init: vi.fn().mockResolvedValue(undefined),
        shutdown: vi.fn().mockResolvedValue(undefined),
      };

      expect(() => host.registerPlugin(badPlugin)).toThrow("Invalid plugin manifest");
    });

    it("should enforce max plugins limit", () => {
      const limitedHost = new PluginHost({ maxPlugins: 2, autoActivate: false });

      limitedHost.registerPlugin(createTestPlugin({ id: "p1" }));
      limitedHost.registerPlugin(createTestPlugin({ id: "p2" }));

      expect(() => limitedHost.registerPlugin(createTestPlugin({ id: "p3" }))).toThrow(
        "Maximum number of plugins"
      );
    });

    it("should auto-activate when configured", async () => {
      const autoHost = new PluginHost({ autoActivate: true });
      const plugin = createTestPlugin({ id: "auto-1" });

      autoHost.registerPlugin(plugin);

      await new Promise((r) => setTimeout(r, 100));

      const state = autoHost.getPluginState("auto-1");
      expect(state!.status).toBe(PluginStatus.Active);
    });
  });

  describe("activate / deactivate", () => {
    it("should activate a plugin", async () => {
      const plugin = createTestPlugin({ id: "act-1" });
      host.registerPlugin(plugin);

      await host.activate("act-1");

      const state = host.getPluginState("act-1");
      expect(state!.status).toBe(PluginStatus.Active);
      expect(plugin.init).toHaveBeenCalled();
    });

    it("should deactivate a plugin", async () => {
      const plugin = createTestPlugin({ id: "deact-1" });
      host.registerPlugin(plugin);
      await host.activate("deact-1");

      await host.deactivate("deact-1");

      const state = host.getPluginState("deact-1");
      expect(state!.status).toBe(PluginStatus.Disabled);
      expect(plugin.shutdown).toHaveBeenCalled();
    });

    it("should handle activation errors", async () => {
      const plugin = createTestPlugin({ id: "err-1" });
      (plugin.init as any).mockRejectedValue(new Error("Init failed"));

      host.registerPlugin(plugin);

      await expect(host.activate("err-1")).rejects.toThrow("Init failed");

      const state = host.getPluginState("err-1");
      expect(state!.status).toBe(PluginStatus.Error);
      expect(state!.error).toBe("Init failed");
    });

    it("should not activate already active plugin", async () => {
      const plugin = createTestPlugin({ id: "already-active" });
      host.registerPlugin(plugin);
      await host.activate("already-active");

      await host.activate("already-active");

      expect(plugin.init).toHaveBeenCalledTimes(1);
    });
  });

  describe("unregister", () => {
    it("should unregister a plugin", async () => {
      const plugin = createTestPlugin({ id: "unreg-1" });
      host.registerPlugin(plugin);
      await host.activate("unreg-1");

      await host.unregister("unreg-1");

      expect(host.getPlugin("unreg-1")).toBeUndefined();
      expect(host.getPluginState("unreg-1")).toBeUndefined();
    });
  });

  describe("emitHook", () => {
    it("should emit hooks to registered plugins", async () => {
      const plugin = createTestPlugin({ id: "hook-1" });
      (plugin.onHook as any) = vi.fn().mockResolvedValue(undefined);
      host.registerPlugin(plugin);
      await host.activate("hook-1");

      await host.emitHook("onMessageReceived", { text: "hello" });

      expect(plugin.onHook).toHaveBeenCalledWith(
        expect.objectContaining({
          pluginId: "hook-1",
          hookName: "onMessageReceived",
          data: { text: "hello" },
        })
      );
    });

    it("should not emit hooks to inactive plugins", async () => {
      const plugin = createTestPlugin({ id: "inactive-hook" });
      (plugin.onHook as any) = vi.fn().mockResolvedValue(undefined);
      host.registerPlugin(plugin);

      await host.emitHook("onMessageReceived", {});

      expect(plugin.onHook).not.toHaveBeenCalled();
    });

    it("should handle hook errors gracefully", async () => {
      const plugin = createTestPlugin({ id: "hook-err" });
      (plugin.onHook as any) = vi.fn().mockRejectedValue(new Error("Hook failed"));
      host.registerPlugin(plugin);
      await host.activate("hook-err");

      await host.emitHook("onMessageReceived", {});

      expect(plugin.onHook).toHaveBeenCalled();
    });
  });

  describe("listPlugins", () => {
    it("should list all plugins", () => {
      host.registerPlugin(createTestPlugin({ id: "list-1" }));
      host.registerPlugin(createTestPlugin({ id: "list-2" }));

      const list = host.listPlugins();
      expect(list.length).toBe(2);
      expect(list.map((p) => p.id).sort()).toEqual(["list-1", "list-2"]);
    });
  });

  describe("getActivePlugins", () => {
    it("should return only active plugins", async () => {
      host.registerPlugin(createTestPlugin({ id: "active-1" }));
      host.registerPlugin(createTestPlugin({ id: "active-2" }));
      await host.activate("active-1");

      const active = host.getActivePlugins();
      expect(active).toEqual(["active-1"]);
    });
  });

  describe("healthCheck", () => {
    it("should report health for all plugins", async () => {
      const plugin = createTestPlugin({ id: "health-1" });
      host.registerPlugin(plugin);
      await host.activate("health-1");

      const results = await host.healthCheck();
      expect(results.length).toBe(1);
      expect(results[0].pluginId).toBe("health-1");
      expect(results[0].healthy).toBe(true);
    });
  });

  describe("getStats", () => {
    it("should return plugin statistics", async () => {
      host.registerPlugin(createTestPlugin({ id: "s1" }));
      host.registerPlugin(createTestPlugin({ id: "s2" }));
      await host.activate("s1");

      const stats = host.getStats();
      expect(stats.total).toBe(2);
      expect(stats.active).toBe(1);
    });
  });

  describe("ServiceLocator", () => {
    it("should register and retrieve services", () => {
      host.register("myService", { doStuff: () => 42 });

      const svc = host.get<{ doStuff: () => number }>("myService");
      expect(svc).toBeDefined();
      expect(svc!.doStuff()).toBe(42);
    });

    it("should check service existence", () => {
      host.register("existing", {});
      expect(host.has("existing")).toBe(true);
      expect(host.has("missing")).toBe(false);
    });

    it("should list service names", () => {
      host.register("svc1", {});
      host.register("svc2", {});

      expect(host.list().sort()).toEqual(["svc1", "svc2"]);
    });
  });

  describe("shutdown", () => {
    it("should shutdown all active plugins", async () => {
      const p1 = createTestPlugin({ id: "shut-1" });
      const p2 = createTestPlugin({ id: "shut-2" });
      host.registerPlugin(p1);
      host.registerPlugin(p2);
      await host.activate("shut-1");
      await host.activate("shut-2");

      await host.shutdown();

      expect(p1.shutdown).toHaveBeenCalled();
      expect(p2.shutdown).toHaveBeenCalled();
      expect(host.listPlugins()).toEqual([]);
    });
  });
});
