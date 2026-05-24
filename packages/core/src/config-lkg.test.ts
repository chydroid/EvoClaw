import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import { LastKnownGoodConfig } from "./config-lkg";
import type { ConfigSnapshot } from "./config-lkg";

describe("LastKnownGoodConfig", () => {
  let lkg: LastKnownGoodConfig;
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = path.join(os.tmpdir(), `lkg-test-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
    lkg = new LastKnownGoodConfig({
      snapshotsDir: tmpDir,
      maxSnapshots: 5,
    });
  });

  afterEach(() => {
    if (fs.existsSync(tmpDir)) {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  describe("snapshot", () => {
    it("should create a snapshot", () => {
      const config = { server: { port: 3000 }, name: "test" };
      const snap = lkg.snapshot(config, "Initial config");

      expect(snap.id).toBeDefined();
      expect(snap.id.startsWith("lkg_")).toBe(true);
      expect(snap.label).toBe("Initial config");
      expect(snap.content).toEqual(config);
      expect(snap.checksum).toBeDefined();
      expect(snap.validated).toBe(true);
      expect(fs.existsSync(path.join(tmpDir, `${snap.id}.json`))).toBe(true);
    });

    it("should assign auto-label when not specified", () => {
      const snap = lkg.snapshot({ server: { port: 8080 } });
      expect(snap.label).toContain("Snapshot");
    });
  });

  describe("listSnapshots", () => {
    it("should list snapshots newest first", () => {
      const s1 = lkg.snapshot({ v: 1 });
      const s2 = lkg.snapshot({ v: 2 });
      const s3 = lkg.snapshot({ v: 3 });

      const list = lkg.listSnapshots();
      expect(list).toHaveLength(3);
      expect(list[0].id).toBe(s3.id); // Newest first
      expect(list[2].id).toBe(s1.id);
    });

    it("should return empty list when no snapshots", () => {
      expect(lkg.listSnapshots()).toHaveLength(0);
    });
  });

  describe("getLatest", () => {
    it("should return latest snapshot", () => {
      lkg.snapshot({ v: 1 });
      lkg.snapshot({ v: 2 });

      const latest = lkg.getLatest();
      expect(latest).not.toBeNull();
      expect(latest!.content).toEqual({ v: 2 });
    });

    it("should return null when no snapshots", () => {
      expect(lkg.getLatest()).toBeNull();
    });
  });

  describe("restore", () => {
    it("should restore latest snapshot to file", () => {
      const tmpConfig = path.join(tmpDir, "config.json");
      const restorable = new LastKnownGoodConfig({
        snapshotsDir: tmpDir,
        configPath: tmpConfig,
      });

      restorable.snapshot({ server: { port: 9090 }, name: "saved" }, "Working config");

      const restored = restorable.restore();
      expect(restored).not.toBeNull();

      const fileContent = JSON.parse(fs.readFileSync(tmpConfig, "utf-8"));
      expect(fileContent.server.port).toBe(9090);
      expect(fileContent.name).toBe("saved");
    });

    it("should return null when no snapshots", () => {
      const nonExistent = new LastKnownGoodConfig({ snapshotsDir: tmpDir });
      expect(nonExistent.restore()).toBeNull();
    });
  });

  describe("restoreById", () => {
    it("should restore specific snapshot", () => {
      const tmpConfig = path.join(tmpDir, "config.json");
      const restorable = new LastKnownGoodConfig({
        snapshotsDir: tmpDir,
        configPath: tmpConfig,
      });

      const s1 = restorable.snapshot({ v: 1 }, "V1");
      restorable.snapshot({ v: 2 }, "V2");

      const restored = restorable.restoreById(s1.id);
      expect(restored).not.toBeNull();
      expect(restored!.content).toEqual({ v: 1 });

      const fileContent = JSON.parse(fs.readFileSync(tmpConfig, "utf-8"));
      expect(fileContent.v).toBe(1);
    });

    it("should return null for unknown ID", () => {
      expect(lkg.restoreById("nonexistent")).toBeNull();
    });
  });

  describe("diff", () => {
    it("should detect added keys", () => {
      const old = { a: 1, b: 2 };
      const new_ = { a: 1, b: 2, c: 3 };

      const diff = lkg.diff(old, new_);
      expect(diff.added).toContain("c");
      expect(diff.removed).toHaveLength(0);
      expect(diff.changed).toHaveLength(0);
      expect(diff.identical).toBe(false);
    });

    it("should detect removed keys", () => {
      const old = { a: 1, b: 2, c: 3 };
      const new_ = { a: 1 };

      const diff = lkg.diff(old, new_);
      expect(diff.removed).toHaveLength(2);
    });

    it("should detect changed values", () => {
      const old = { a: 1, b: 2 };
      const new_ = { a: 1, b: 99 };

      const diff = lkg.diff(old, new_);
      expect(diff.changed).toHaveLength(1);
      expect(diff.changed[0].key).toBe("b");
      expect(diff.changed[0].oldValue).toBe(2);
      expect(diff.changed[0].newValue).toBe(99);
    });

    it("should detect identical configs", () => {
      const config = { a: 1, b: { c: 2 } };
      const diff = lkg.diff(config, { ...config });
      expect(diff.identical).toBe(true);
    });

    it("should diff nested objects", () => {
      const old = { server: { port: 3000, host: "localhost" } };
      const new_ = { server: { port: 8080, host: "localhost" } };

      const diff = lkg.diff(old, new_);
      expect(diff.changed).toHaveLength(1);
      expect(diff.changed[0].key).toBe("server.port");
    });

    it("should diff snapshots", () => {
      const s1 = lkg.snapshot({ a: 1 }, "V1");
      const s2 = lkg.snapshot({ a: 2 }, "V2");

      const diff = lkg.diff(s1, s2);
      expect(diff.changed).toHaveLength(1);
    });
  });

  describe("verify", () => {
    it("should verify checksum integrity", () => {
      const snap = lkg.snapshot({ data: "important" });
      expect(lkg.verify(snap.id)).toBe(true);
    });

    it("should fail verification for unknown ID", () => {
      expect(lkg.verify("nonexistent")).toBe(false);
    });
  });

  describe("deleteSnapshot", () => {
    it("should delete a snapshot", () => {
      const snap = lkg.snapshot({ v: 1 });
      expect(lkg.deleteSnapshot(snap.id)).toBe(true);
      expect(lkg.listSnapshots()).toHaveLength(0);
    });

    it("should return false for unknown ID", () => {
      expect(lkg.deleteSnapshot("nonexistent")).toBe(false);
    });
  });

  describe("rotation", () => {
    it("should keep at most maxSnapshots", () => {
      for (let i = 0; i < 10; i++) {
        lkg.snapshot({ v: i }, `V${i}`);
      }
      expect(lkg.listSnapshots().length).toBeLessThanOrEqual(5);
    });
  });

  describe("validateChange", () => {
    it("should detect large removals", () => {
      const previous = lkg.snapshot(
        Object.fromEntries(Array.from({ length: 15 }, (_, i) => [`key${i}`, i])),
      );

      const result = lkg.validateChange({}, previous);
      expect(result.safe).toBe(false);
      expect(result.warnings.some((w) => w.includes("removal"))).toBe(true);
    });

    it("should detect large additions", () => {
      const previous = lkg.snapshot({ a: 1 });

      const result = lkg.validateChange(
        Object.fromEntries(Array.from({ length: 25 }, (_, i) => [`key${i}`, i])),
        previous,
      );
      expect(result.safe).toBe(false);
      expect(result.warnings.some((w) => w.includes("addition"))).toBe(true);
    });

    it("should pass for safe changes", () => {
      const previous = lkg.snapshot({ a: 1, b: 2 });
      const result = lkg.validateChange({ a: 1, b: 3 }, previous);
      expect(result.safe).toBe(true);
    });
  });

  describe("pruneSnapshots", () => {
    it("should prune old snapshots", () => {
      // Create a snapshot
      lkg.snapshot({ v: 1 });
      // Prune with large max age — should keep all
      const deleted = lkg.pruneSnapshots(365);
      expect(deleted).toBe(0);
      expect(lkg.listSnapshots().length).toBe(1);

      // Prune with 0 days — should delete all
      lkg.pruneSnapshots(0);
      expect(lkg.listSnapshots().length).toBe(0);
    });
  });

  describe("configure", () => {
    it("should update config", () => {
      lkg.configure({ maxSnapshots: 20 });
      // Snapshot rotation will now keep up to 20
      expect(() => lkg.snapshot({ test: true })).not.toThrow();
    });
  });
});