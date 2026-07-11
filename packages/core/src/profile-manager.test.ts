import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import { ProfileManager } from "./profile-manager";
import type { ProfileConfig } from "./profile-manager";

describe("ProfileManager", () => {
  let tmpDir: string;
  let pm: ProfileManager;

  beforeEach(() => {
    tmpDir = path.join(
      os.tmpdir(),
      `evoclaw-profile-test-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    );
    pm = new ProfileManager({ rootDataDir: tmpDir });
  });

  afterEach(() => {
    if (fs.existsSync(tmpDir)) {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  describe("default profile", () => {
    it("should create default profile on init", () => {
      const active = pm.getActiveProfile();
      expect(active).not.toBeNull();
      expect(active!.name).toBe("default");
      expect(active!.isDefault).toBe(true);
    });

    it("should create default profile directory structure", () => {
      const active = pm.getActiveProfile()!;
      const subdirs = ["skills", "memory", "workspace", "logs", "plugins"];
      for (const subdir of subdirs) {
        expect(fs.existsSync(path.join(active.dataDir, subdir))).toBe(true);
      }
    });

    it("should persist profiles.json on init", () => {
      const profilesFile = path.join(tmpDir, "profiles.json");
      expect(fs.existsSync(profilesFile)).toBe(true);
      const content = JSON.parse(fs.readFileSync(profilesFile, "utf-8"));
      expect(content.profiles).toHaveLength(1);
      expect(content.profiles[0].name).toBe("default");
    });
  });

  describe("createProfile", () => {
    it("should create a custom profile", async () => {
      const profile = await pm.createProfile("custom", "test profile");
      expect(profile.name).toBe("custom");
      expect(profile.description).toBe("test profile");
      expect(profile.dataDir).toBe(path.join(tmpDir, "custom"));
      expect(fs.existsSync(profile.dataDir)).toBe(true);
    });

    it("should create directory structure for custom profile", async () => {
      const profile = await pm.createProfile("custom");
      const subdirs = ["skills", "memory", "workspace", "logs", "plugins"];
      for (const subdir of subdirs) {
        expect(fs.existsSync(path.join(profile.dataDir, subdir))).toBe(true);
      }
    });

    it("should return existing profile if name already exists", async () => {
      const first = await pm.createProfile("dup", "first");
      const second = await pm.createProfile("dup", "second");
      expect(second.name).toBe("dup");
      expect(second.createdAt).toBe(first.createdAt);
    });

    it("should not set isDefault for non-default profile", async () => {
      const profile = await pm.createProfile("custom");
      expect(profile.isDefault).toBeFalsy();
    });

    it("should reject invalid profile names", async () => {
      const invalidNames = [
        "with space",
        "with/slash",
        "with.dot",
        "with:colon",
        "../traversal",
        "with*star",
        "",
      ];
      for (const name of invalidNames) {
        await expect(pm.createProfile(name)).rejects.toThrow();
      }
    });

    it("should accept valid profile names with hyphens and underscores", async () => {
      const validNames = ["my-profile", "my_profile", "Profile123", "A-B_C"];
      for (const name of validNames) {
        const profile = await pm.createProfile(name);
        expect(profile.name).toBe(name);
      }
    });

    it("should reject reserved name profiles-archive", async () => {
      await expect(pm.createProfile("profiles-archive")).rejects.toThrow();
    });
  });

  describe("concurrent creation", () => {
    it("should return same profile for concurrent creation of same name", async () => {
      const [p1, p2] = await Promise.all([
        pm.createProfile("concurrent", "first"),
        pm.createProfile("concurrent", "second"),
      ]);
      expect(p1.name).toBe("concurrent");
      expect(p2.name).toBe("concurrent");
      expect(p1.createdAt).toBe(p2.createdAt);
    });
  });

  describe("setActiveProfile", () => {
    it("should switch active profile", async () => {
      await pm.createProfile("custom");
      pm.setActiveProfile("custom");
      expect(pm.getActiveProfile()!.name).toBe("custom");
    });

    it("should update lastUsedAt on switch", async () => {
      await pm.createProfile("custom");
      const before = pm.getActiveProfile()!.lastUsedAt;
      // 等待确保时间戳不同
      await new Promise((r) => setTimeout(r, 10));
      pm.setActiveProfile("custom");
      const activeAfter = pm.getActiveProfile()!;
      expect(activeAfter.lastUsedAt).not.toBe(before);
    });

    it("should throw for non-existent profile", () => {
      expect(() => pm.setActiveProfile("nonexistent")).toThrow();
    });
  });

  describe("getEvoClawHome", () => {
    it("should return dataDir of active profile", () => {
      const active = pm.getActiveProfile()!;
      expect(pm.getEvoClawHome()).toBe(active.dataDir);
    });

    it("should return correct path after switching", async () => {
      await pm.createProfile("custom");
      pm.setActiveProfile("custom");
      expect(pm.getEvoClawHome()).toBe(path.join(tmpDir, "custom"));
    });
  });

  describe("displayEvoClawHome", () => {
    it("should sanitize username in path", () => {
      const home = os.homedir();
      const dataDir = pm.getEvoClawHome();
      const userName = path.basename(home);
      const displayed = pm.displayEvoClawHome();

      if (dataDir.startsWith(home)) {
        expect(displayed).toContain("<user>");
        expect(displayed).not.toContain(userName);
      } else {
        // 不在 home 下时原样返回
        expect(displayed).toBe(dataDir);
      }
    });

    it("should reflect active profile changes", async () => {
      await pm.createProfile("custom");
      pm.setActiveProfile("custom");
      const displayed = pm.displayEvoClawHome();
      const home = os.homedir();
      const dataDir = pm.getEvoClawHome();
      if (dataDir.startsWith(home)) {
        expect(displayed).toContain("custom");
      }
    });
  });

  describe("deleteProfile", () => {
    it("should archive profile (move to profiles-archive)", async () => {
      const profile = await pm.createProfile("to-delete");
      const dataDir = profile.dataDir;
      expect(fs.existsSync(dataDir)).toBe(true);

      await pm.deleteProfile("to-delete");

      // 原目录不存在
      expect(fs.existsSync(dataDir)).toBe(false);
      // 归档目录存在
      const archiveDir = path.join(tmpDir, "profiles-archive");
      expect(fs.existsSync(archiveDir)).toBe(true);
      const archives = fs.readdirSync(archiveDir);
      expect(archives.some((f) => f.startsWith("to-delete-"))).toBe(true);
    });

    it("should remove profile from list after deletion", async () => {
      await pm.createProfile("to-delete");
      expect(pm.getProfile("to-delete")).not.toBeNull();
      await pm.deleteProfile("to-delete");
      expect(pm.getProfile("to-delete")).toBeNull();
    });

    it("should not allow deleting default profile", async () => {
      await expect(pm.deleteProfile("default")).rejects.toThrow();
    });

    it("should switch to default when deleting active profile", async () => {
      await pm.createProfile("active");
      pm.setActiveProfile("active");
      expect(pm.getActiveProfile()!.name).toBe("active");

      await pm.deleteProfile("active");
      expect(pm.getActiveProfile()!.name).toBe("default");
    });

    it("should throw for non-existent profile", async () => {
      await expect(pm.deleteProfile("nonexistent")).rejects.toThrow();
    });

    it("should preserve archived directory structure", async () => {
      const profile = await pm.createProfile("archived");
      // 在 profile 目录下创建文件
      const testFile = path.join(profile.dataDir, "workspace", "test.txt");
      fs.writeFileSync(testFile, "test content");

      await pm.deleteProfile("archived");

      const archiveDir = path.join(tmpDir, "profiles-archive");
      const archives = fs.readdirSync(archiveDir);
      const archiveName = archives.find((f) => f.startsWith("archived-"));
      expect(archiveName).toBeDefined();
      const archivedFile = path.join(
        archiveDir,
        archiveName!,
        "workspace",
        "test.txt",
      );
      expect(fs.existsSync(archivedFile)).toBe(true);
    });
  });

  describe("listProfiles", () => {
    it("should list all profiles including default", async () => {
      await pm.createProfile("custom1");
      await pm.createProfile("custom2");
      const list = pm.listProfiles();
      expect(list).toHaveLength(3);
      const names = list.map((p) => p.name);
      expect(names).toContain("default");
      expect(names).toContain("custom1");
      expect(names).toContain("custom2");
    });

    it("should return only default when no custom profiles", () => {
      const list = pm.listProfiles();
      expect(list).toHaveLength(1);
      expect(list[0].name).toBe("default");
    });
  });

  describe("getProfile", () => {
    it("should return profile by name", async () => {
      await pm.createProfile("custom", "description");
      const profile = pm.getProfile("custom");
      expect(profile).not.toBeNull();
      expect(profile!.name).toBe("custom");
      expect(profile!.description).toBe("description");
    });

    it("should return null for non-existent profile", () => {
      expect(pm.getProfile("nonexistent")).toBeNull();
    });
  });

  describe("persist and load", () => {
    it("should persist profiles and reload them", async () => {
      await pm.createProfile("persisted1", "first");
      await pm.createProfile("persisted2", "second");
      pm.setActiveProfile("persisted1");

      // 创建新的 ProfileManager 加载同一目录
      const pm2 = new ProfileManager({ rootDataDir: tmpDir });
      const list = pm2.listProfiles();
      expect(list).toHaveLength(3);
      expect(pm2.getProfile("persisted1")).not.toBeNull();
      expect(pm2.getProfile("persisted2")).not.toBeNull();
      expect(pm2.getProfile("persisted1")!.description).toBe("first");
    });

    it("should restore active profile on load", async () => {
      await pm.createProfile("active-on-reload");
      pm.setActiveProfile("active-on-reload");

      const pm2 = new ProfileManager({ rootDataDir: tmpDir });
      expect(pm2.getActiveProfile()!.name).toBe("active-on-reload");
    });

    it("should restore active profile correctly after deletion and reload", async () => {
      await pm.createProfile("will-delete");
      pm.setActiveProfile("will-delete");
      await pm.deleteProfile("will-delete");

      const pm2 = new ProfileManager({ rootDataDir: tmpDir });
      expect(pm2.getActiveProfile()!.name).toBe("default");
    });

    it("should create default profile if profiles.json missing", () => {
      // 删除 profiles.json 模拟首次启动
      fs.rmSync(path.join(tmpDir, "profiles.json"));
      const pm2 = new ProfileManager({ rootDataDir: tmpDir });
      expect(pm2.getActiveProfile()!.name).toBe("default");
      expect(fs.existsSync(path.join(tmpDir, "profiles.json"))).toBe(true);
    });

    it("should recover from corrupted profiles.json", () => {
      fs.writeFileSync(path.join(tmpDir, "profiles.json"), "corrupted json {{{");
      const pm2 = new ProfileManager({ rootDataDir: tmpDir });
      expect(pm2.getActiveProfile()!.name).toBe("default");
    });

    it("should support custom default profile name", () => {
      const customTmp = path.join(
        os.tmpdir(),
        `evoclaw-profile-custom-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      );
      try {
        const pmCustom = new ProfileManager({
          rootDataDir: customTmp,
          defaultProfileName: "main",
        });
        expect(pmCustom.getActiveProfile()!.name).toBe("main");
        expect(pmCustom.getActiveProfile()!.isDefault).toBe(true);
        expect(pmCustom.getEvoClawHome()).toBe(path.join(customTmp, "main"));
      } finally {
        if (fs.existsSync(customTmp)) {
          fs.rmSync(customTmp, { recursive: true, force: true });
        }
      }
    });
  });
});
