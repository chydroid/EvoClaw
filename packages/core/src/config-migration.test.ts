import { describe, it, expect, beforeEach } from "vitest";
import {
  ConfigMigrationManager,
  MigrationStep,
  SemVer,
} from "./config-migration";

function makeStep(
  toVersion: SemVer,
  description: string,
  opts?: {
    migrate?: (c: Record<string, unknown>) => Record<string, unknown>;
    rollback?: (c: Record<string, unknown>) => Record<string, unknown>;
    reversible?: boolean;
    breaking?: boolean;
  },
): MigrationStep {
  return {
    toVersion,
    description,
    migrate: opts?.migrate ?? ((c) => ({ ...c, _migrated: toVersion })),
    rollback: opts?.rollback,
    reversible: opts?.reversible ?? true,
    breaking: opts?.breaking ?? false,
  };
}

describe("ConfigMigrationManager", () => {
  let mgr: ConfigMigrationManager;

  beforeEach(() => {
    mgr = new ConfigMigrationManager();
  });

  // ── Registration ──────────────────────────────────────

  describe("register / unregister", () => {
    it("registers a step and lists it", () => {
      const step = makeStep("1.1.0", "Add new field");
      mgr.register(step);
      expect(mgr.listSteps()).toHaveLength(1);
      expect(mgr.listSteps()[0].toVersion).toBe("1.1.0");
    });

    it("registerAll registers multiple steps", () => {
      mgr.registerAll([
        makeStep("1.1.0", "v1.1"),
        makeStep("1.2.0", "v1.2"),
        makeStep("1.0.1", "v1.0.1"),
      ]);
      expect(mgr.listSteps()).toHaveLength(3);
    });

    it("unregisters a step", () => {
      mgr.register(makeStep("1.1.0", "v1.1"));
      expect(mgr.unregister("1.1.0")).toBe(true);
      expect(mgr.listSteps()).toHaveLength(0);
    });

    it("unregister returns false for unknown version", () => {
      expect(mgr.unregister("9.9.9")).toBe(false);
    });

    it("listSteps returns steps sorted by version", () => {
      mgr.registerAll([
        makeStep("2.0.0", "major"),
        makeStep("1.1.0", "minor"),
        makeStep("1.0.1", "patch"),
      ]);
      const versions = mgr.listSteps().map((s) => s.toVersion);
      expect(versions).toEqual(["1.0.1", "1.1.0", "2.0.0"]);
    });
  });

  // ── Latest Version ────────────────────────────────────

  describe("getLatestVersion", () => {
    it("returns null when no steps registered", () => {
      expect(mgr.getLatestVersion()).toBeNull();
    });

    it("returns the highest version", () => {
      mgr.registerAll([
        makeStep("1.0.0", ""),
        makeStep("2.0.0", ""),
        makeStep("1.5.0", ""),
      ]);
      expect(mgr.getLatestVersion()).toBe("2.0.0");
    });
  });

  // ── Migrate ───────────────────────────────────────────

  describe("migrate", () => {
    it("applies a single migration step", () => {
      mgr.register(
        makeStep("1.1.0", "Add greeting", {
          migrate: (c) => ({ ...c, greeting: "hello" }),
        }),
      );

      const result = mgr.migrate({});
      expect(result.success).toBe(true);
      expect(result.applied).toBe(1);
      expect(result.skipped).toBe(0);
      expect(result.failed).toBe(0);
      expect(result.config.greeting).toBe("hello");
    });

    it("applies migration chain in order", () => {
      mgr.registerAll([
        makeStep("1.1.0", "Step 1", {
          migrate: (c) => ({ ...c, step1: true }),
        }),
        makeStep("1.2.0", "Step 2", {
          migrate: (c) => ({ ...c, step2: true }),
        }),
      ]);

      const result = mgr.migrate({});
      expect(result.applied).toBe(2);
      expect(result.config.step1).toBe(true);
      expect(result.config.step2).toBe(true);
    });

    it("sets schemaVersion in result config after migration", () => {
      mgr.register(makeStep("1.1.0", "v1.1"));
      const result = mgr.migrate({});
      expect(result.config.schemaVersion).toBe("1.1.0");
    });

    it("skips already applied versions", () => {
      mgr.registerAll([
        makeStep("1.1.0", "Step 1"),
        makeStep("1.2.0", "Step 2"),
      ]);

      const result = mgr.migrate({ schemaVersion: "1.1.0" });
      expect(result.applied).toBe(1);
      expect(result.skipped).toBe(0);
      expect(result.fromVersion).toBe("1.1.0");
    });

    it("handles config with no schema version (from null)", () => {
      mgr.register(makeStep("1.1.0", "v1.1"));
      const result = mgr.migrate({});
      expect(result.fromVersion).toBeNull();
      expect(result.applied).toBe(1);
    });

    it("dry run does not set schemaVersion in output", () => {
      mgr.register(makeStep("1.1.0", "v1.1"));
      const result = mgr.migrate({}, { dryRun: true });
      expect(result.dryRun).toBe(true);
      expect(result.applied).toBe(1);
      // In dry run schemaVersion is NOT written to config
      expect(result.config.schemaVersion).toBeUndefined();
    });

    it("migrates to a specific target version", () => {
      mgr.registerAll([
        makeStep("1.1.0", "Step 1"),
        makeStep("1.2.0", "Step 2"),
        makeStep("1.3.0", "Step 3"),
      ]);

      const result = mgr.migrate({}, { targetVersion: "1.2.0" });
      expect(result.applied).toBe(2);
      expect(result.toVersion).toBe("1.2.0");
    });

    it("warns about breaking changes", () => {
      mgr.register(
        makeStep("1.1.0", "Breaking: removed field X", {
          breaking: true,
        }),
      );

      const result = mgr.migrate({});
      expect(result.warnings).toHaveLength(1);
      expect(result.warnings[0]).toContain("Breaking change");
    });

    it("reports errors on migration failure", () => {
      mgr.register(
        makeStep("1.1.0", "Failing step", {
          migrate: () => {
            throw new Error("Boom");
          },
        }),
      );

      const result = mgr.migrate({});
      expect(result.success).toBe(false);
      expect(result.failed).toBe(1);
      expect(result.errors).toHaveLength(1);
      expect(result.errors[0]).toContain("Boom");
    });

    it("stops chain on first failure", () => {
      mgr.registerAll([
        makeStep("1.1.0", "Fails", {
          migrate: () => {
            throw new Error("Fail");
          },
        }),
        makeStep("1.2.0", "Should not run"),
      ]);

      const result = mgr.migrate({});
      expect(result.applied).toBe(0);
      expect(result.failed).toBe(1);
    });

    it("warns when no migrations registered", () => {
      const result = mgr.migrate({});
      expect(result.success).toBe(true);
      expect(result.warnings).toContain("No migrations registered");
    });
  });

  // ── Rollback ──────────────────────────────────────────

  describe("rollback", () => {
    it("rolls back to previous version", () => {
      mgr.registerAll([
        makeStep("1.1.0", "Add field", {
          migrate: (c) => ({ ...c, newField: "value" }),
          rollback: (c) => {
            const { newField: _, ...rest } = c;
            return rest;
          },
        }),
        makeStep("1.2.0", "Another field"),
      ]);

      // First migrate to 1.1.0
      mgr.migrate({});
      // Then rollback from 1.1.0
      const config = { schemaVersion: "1.1.0", newField: "value" };
      const result = mgr.rollback(config);

      expect(result.success).toBe(true);
      expect(result.config.newField).toBeUndefined();
      expect(result.config.schemaVersion).toBeUndefined(); // No previous version
    });

    it("rollback fails when no schema version", () => {
      const result = mgr.rollback({});
      expect(result.success).toBe(false);
      expect(result.error).toContain("No schema version");
    });

    it("rollback fails when no step registered for version", () => {
      const result = mgr.rollback({ schemaVersion: "9.9.9" });
      expect(result.success).toBe(false);
      expect(result.error).toContain("No rollback registered");
    });

    it("rollback fails when step is not reversible", () => {
      mgr.register(
        makeStep("1.1.0", "Irreversible", {
          reversible: false,
          rollback: undefined,
        }),
      );

      const result = mgr.rollback({ schemaVersion: "1.1.0" });
      expect(result.success).toBe(false);
      expect(result.error).toContain("not reversible");
    });

    it("rollback fails when rollback function throws", () => {
      mgr.register(
        makeStep("1.1.0", "Bad rollback", {
          rollback: () => {
            throw new Error("Rollback fail");
          },
        }),
      );

      const result = mgr.rollback({ schemaVersion: "1.1.0" });
      expect(result.success).toBe(false);
      expect(result.error).toBe("Rollback fail");
    });

    it("rollback sets schemaVersion to previous version when available", () => {
      mgr.registerAll([
        makeStep("1.0.0", "Base"),
        makeStep("1.1.0", "Current", {
          rollback: (c) => {
            const { added: _, ...rest } = c;
            return rest;
          },
        }),
      ]);

      const config = { schemaVersion: "1.1.0", added: true };
      const result = mgr.rollback(config);
      expect(result.success).toBe(true);
      expect(result.config.schemaVersion).toBe("1.0.0");
      expect(result.config.added).toBeUndefined();
    });
  });

  // ── getMigrationPath ──────────────────────────────────

  describe("getMigrationPath", () => {
    it("returns steps between two versions", () => {
      mgr.registerAll([
        makeStep("1.0.0", "v1"),
        makeStep("1.1.0", "v2"),
        makeStep("1.2.0", "v3"),
        makeStep("1.3.0", "v4"),
      ]);

      const path = mgr.getMigrationPath("1.0.0", "1.2.0");
      expect(path).toHaveLength(2);
      expect(path[0].toVersion).toBe("1.1.0");
      expect(path[1].toVersion).toBe("1.2.0");
    });

    it("returns steps from null (no version)", () => {
      mgr.registerAll([
        makeStep("1.0.0", "v1"),
        makeStep("1.1.0", "v2"),
      ]);

      const path = mgr.getMigrationPath(null, "1.1.0");
      expect(path).toHaveLength(2);
    });

    it("returns empty array when no steps in range", () => {
      mgr.register(makeStep("2.0.0", "v2"));
      const path = mgr.getMigrationPath("1.0.0", "1.5.0");
      expect(path).toHaveLength(0);
    });
  });

  // ── needsMigration ────────────────────────────────────

  describe("needsMigration", () => {
    it("returns true when no version in config", () => {
      mgr.register(makeStep("1.1.0", "v1.1"));
      expect(mgr.needsMigration({})).toBe(true);
    });

    it("returns true when version is behind", () => {
      mgr.registerAll([
        makeStep("1.0.0", ""),
        makeStep("1.1.0", ""),
      ]);
      expect(mgr.needsMigration({ schemaVersion: "1.0.0" })).toBe(true);
    });

    it("returns false when at latest version", () => {
      mgr.registerAll([
        makeStep("1.0.0", ""),
        makeStep("1.1.0", ""),
      ]);
      expect(mgr.needsMigration({ schemaVersion: "1.1.0" })).toBe(false);
    });

    it("returns false when no migrations registered", () => {
      expect(mgr.needsMigration({})).toBe(false);
    });
  });

  // ── getBreakingChanges ────────────────────────────────

  describe("getBreakingChanges", () => {
    it("returns breaking changes ahead of current version", () => {
      mgr.registerAll([
        makeStep("1.0.0", "Non-breaking"),
        makeStep("1.1.0", "Breaking rename", { breaking: true }),
        makeStep("1.2.0", "Another breaking", { breaking: true }),
        makeStep("1.3.0", "Non-breaking again"),
      ]);

      const breaking = mgr.getBreakingChanges("1.0.0");
      expect(breaking).toHaveLength(2);
      expect(breaking[0].toVersion).toBe("1.1.0");
      expect(breaking[1].toVersion).toBe("1.2.0");
    });

    it("returns empty when no breaking changes ahead", () => {
      mgr.registerAll([
        makeStep("1.1.0", "Safe"),
        makeStep("1.2.0", "Safe too"),
      ]);

      expect(mgr.getBreakingChanges("1.0.0")).toHaveLength(0);
    });

    it("returns breaking changes from null version", () => {
      mgr.register(
        makeStep("1.1.0", "Breaking", { breaking: true }),
      );
      expect(mgr.getBreakingChanges(null)).toHaveLength(1);
    });
  });

  // ── configure ─────────────────────────────────────────

  describe("configure", () => {
    it("updates config options", () => {
      mgr.configure({ schemaVersionKey: "myVersion", backupBeforeMigrate: false });
      // Verify by checking detection works with custom key
      const step = makeStep("1.1.0", "Test");
      mgr.register(step);
      const result = mgr.migrate({ myVersion: "1.0.0" });
      expect(result.fromVersion).toBe("1.0.0");
      expect(result.config.myVersion).toBe("1.1.0");
    });
  });

  // ── Custom schemaVersionKey ───────────────────────────

  describe("custom schemaVersionKey", () => {
    it("detects version with custom key", () => {
      const mgr2 = new ConfigMigrationManager({ schemaVersionKey: "cfgVersion" });
      mgr2.register(makeStep("2.0.0", "Test"));
      const result = mgr2.migrate({ cfgVersion: "1.0.0" });
      expect(result.fromVersion).toBe("1.0.0");
    });
  });
});