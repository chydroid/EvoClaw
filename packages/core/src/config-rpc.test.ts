import { describe, it, expect, beforeEach, vi } from "vitest";
import { ConfigRPC } from "./config-rpc";
import type { ConfigSchemaEntry } from "./config-rpc";

describe("ConfigRPC", () => {
  let rpc: ConfigRPC;

  beforeEach(() => {
    rpc = new ConfigRPC();
  });

  describe("register", () => {
    it("should register a config key with schema", () => {
      rpc.register("server.port", { default: 3000, description: "HTTP port" });
      expect(rpc.get("server.port")).toBe(3000);
      expect(rpc.getSchema("server.port")!.description).toBe("HTTP port");
    });

    it("should batch register", () => {
      rpc.registerAll({
        "server.port": { default: 3000 },
        "server.host": { default: "localhost" },
        "debug": { default: false },
      });

      expect(rpc.get("server.port")).toBe(3000);
      expect(rpc.get("server.host")).toBe("localhost");
      expect(rpc.get("debug")).toBe(false);
    });
  });

  describe("get/set", () => {
    beforeEach(() => {
      rpc.register("port", { default: 3000 });
      rpc.register("debug", { default: false });
    });

    it("should get a value", () => {
      expect(rpc.get("port")).toBe(3000);
    });

    it("should return null for unregistered key", () => {
      expect(rpc.get("unknown")).toBeNull();
    });

    it("should set a value", () => {
      rpc.set("port", 8080);
      expect(rpc.get("port")).toBe(8080);
    });

    it("should set boolean values", () => {
      rpc.set("debug", true);
      expect(rpc.get("debug")).toBe(true);
    });

    it("should set string values", () => {
      rpc.register("name", { default: "" });
      rpc.set("name", "EvoClaw");
      expect(rpc.get("name")).toBe("EvoClaw");
    });
  });

  describe("nested paths", () => {
    it("should get nested values", () => {
      rpc.register("server", { default: { port: 3000, host: "localhost" } });
      expect(rpc.get("server.port")).toBe(3000);
      expect(rpc.get("server.host")).toBe("localhost");
    });

    it("should set nested values", () => {
      rpc.register("server", { default: { port: 3000, host: "localhost" } });
      rpc.set("server.port", 9090);
      expect(rpc.get("server.port")).toBe(9090);
      expect(rpc.get("server.host")).toBe("localhost"); // Unchanged
    });

    it("should create nested path if not exists", () => {
      rpc.register("config", { default: {} });
      rpc.set("config.debug", true);
      expect(rpc.get("config.debug")).toBe(true);
    });
  });

  describe("validation", () => {
    it("should accept valid values", () => {
      rpc.register("port", {
        default: 3000,
        validate: (v) => (typeof v === "number" && v > 0 && v < 65536 ? null : "Invalid port"),
      });

      rpc.set("port", 8080);
      expect(rpc.get("port")).toBe(8080);
    });

    it("should reject invalid values", () => {
      rpc.register("port", {
        default: 3000,
        validate: (v) => (typeof v === "number" && v > 0 && v < 65536 ? null : "Invalid port"),
      });

      expect(() => rpc.set("port", -1)).toThrow("Invalid port");
      expect(() => rpc.set("port", "not-a-number" as unknown as number)).toThrow("Invalid port");
    });
  });

  describe("immutability", () => {
    it("should reject setting immutable keys", () => {
      rpc.register("version", { default: "1.0", mutable: false });
      expect(() => rpc.set("version", "2.0")).toThrow("not mutable");
    });
  });

  describe("unset", () => {
    it("should reset to default", () => {
      rpc.register("timeout", { default: 5000 });
      rpc.set("timeout", 10000);
      expect(rpc.get("timeout")).toBe(10000);

      rpc.unset("timeout");
      expect(rpc.get("timeout")).toBe(5000);
    });

    it("should return false for unregistered key", () => {
      expect(rpc.unset("unknown")).toBe(false);
    });
  });

  describe("resetAll", () => {
    it("should reset all keys", () => {
      rpc.register("a", { default: 1 });
      rpc.register("b", { default: 2 });
      rpc.set("a", 10);
      rpc.set("b", 20);

      rpc.resetAll();
      expect(rpc.get("a")).toBe(1);
      expect(rpc.get("b")).toBe(2);
    });
  });

  describe("has", () => {
    it("should check key existence", () => {
      rpc.register("x", { default: 1 });
      expect(rpc.has("x")).toBe(true);
      expect(rpc.has("y")).toBe(false);
    });

    it("should check nested key", () => {
      rpc.register("db", { default: { host: "localhost", port: 5432 } });
      expect(rpc.has("db.host")).toBe(true);
      expect(rpc.has("db.password")).toBe(false);
    });
  });

  describe("events", () => {
    it("should emit change event", () => {
      const handler = vi.fn();
      rpc.on("change", handler);

      rpc.register("port", { default: 3000 });
      rpc.set("port", 8080);

      expect(handler).toHaveBeenCalledTimes(1);
      const change = handler.mock.calls[0][0];
      expect(change.path).toBe("port");
      expect(change.oldValue).toBe(3000);
      expect(change.newValue).toBe(8080);
    });

    it("should emit path-specific events", () => {
      const handler = vi.fn();
      rpc.on("change:port", handler);

      rpc.register("port", { default: 3000 });
      rpc.set("port", 8080);

      expect(handler).toHaveBeenCalledWith(8080, 3000);
    });
  });

  describe("history", () => {
    it("should record change history", () => {
      rpc.register("a", { default: 0 });
      rpc.set("a", 1);
      rpc.set("a", 2);

      const history = rpc.getHistory();
      expect(history).toHaveLength(2);
      expect(history[0].newValue).toBe(1);
      expect(history[1].newValue).toBe(2);
    });

    it("should undo changes", () => {
      rpc.register("a", { default: 0 });
      rpc.set("a", 10);
      rpc.set("a", 20);

      rpc.undo(1);
      expect(rpc.get("a")).toBe(10);

      rpc.undo(1);
      expect(rpc.get("a")).toBe(0);
    });

    it("should clear history", () => {
      rpc.register("x", { default: 0 });
      rpc.set("x", 1);
      rpc.clearHistory();
      expect(rpc.getHistory()).toHaveLength(0);
    });
  });

  describe("getAll", () => {
    it("should return all values", () => {
      rpc.register("port", { default: 3000 });
      rpc.register("host", { default: "localhost", sensitive: true });

      const all = rpc.getAll();
      expect(all.port).toBe(3000);
      expect(all.host).toBe("***"); // Sensitive masked
    });
  });

  describe("diff", () => {
    it("should diff current vs defaults", () => {
      rpc.register("a", { default: 1 });
      rpc.register("b", { default: 2 });
      rpc.set("a", 10);

      const diffs = rpc.diff();
      expect(diffs).toHaveLength(1);
      expect(diffs[0].key).toBe("a");
      expect(diffs[0].current).toBe(10);
      expect(diffs[0].default).toBe(1);
    });
  });

  describe("configure", () => {
    it("should update config", () => {
      rpc.configure({ source: "cli" });
    });
  });
});