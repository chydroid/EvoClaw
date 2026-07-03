import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import {
  PROJECT_MARKERS,
  CODE_EXTENSIONS,
  CODING_TOOLSET,
  editFormatLine,
  buildCodingWorkspaceBlock,
  resolveRuntimeMode,
  isCodingMode,
  isCodingContext,
  detectProjectFacts,
  codingSystemBlocks,
  codingCompactSkillCategories,
} from "./coding-context";

describe("coding-context", () => {
  describe("constants", () => {
    it("PROJECT_MARKERS is a non-empty array of strings", () => {
      expect(Array.isArray(PROJECT_MARKERS)).toBe(true);
      expect(PROJECT_MARKERS.length).toBeGreaterThan(0);
      for (const m of PROJECT_MARKERS) {
        expect(typeof m).toBe("string");
        expect(m.length).toBeGreaterThan(0);
      }
      // Sanity: common markers present.
      expect(PROJECT_MARKERS).toContain("package.json");
      expect(PROJECT_MARKERS).toContain("pyproject.toml");
    });

    it("CODE_EXTENSIONS is a non-empty set of dotted extensions", () => {
      expect(CODE_EXTENSIONS.size).toBeGreaterThan(0);
      expect(CODE_EXTENSIONS.has(".ts")).toBe(true);
      expect(CODE_EXTENSIONS.has(".py")).toBe(true);
      expect(CODE_EXTENSIONS.has(".go")).toBe(true);
    });

    it("CODING_TOOLSET is the coding toolset identifier", () => {
      expect(CODING_TOOLSET).toBe("coding");
    });
  });

  describe("editFormatLine", () => {
    it("returns a non-empty guidance string for known model families", () => {
      const gpt = editFormatLine("gpt-4o");
      expect(typeof gpt).toBe("string");
      expect(gpt.length).toBeGreaterThan(0);
      expect(gpt.toLowerCase()).toContain("patch");

      const claude = editFormatLine("claude-opus-4");
      expect(typeof claude).toBe("string");
      expect(claude.length).toBeGreaterThan(0);

      const gemini = editFormatLine("gemini-2.5-pro");
      expect(gemini.length).toBeGreaterThan(0);

      const deepseek = editFormatLine("deepseek-chat");
      expect(deepseek.length).toBeGreaterThan(0);
    });

    it("returns an empty string for unknown / null models", () => {
      expect(editFormatLine(null)).toBe("");
      expect(editFormatLine("")).toBe("");
      expect(editFormatLine("some-unknown-model")).toBe("");
    });
  });

  describe("resolveRuntimeMode / isCodingMode / isCodingContext", () => {
    it("off config → general profile, not coding", () => {
      const mode = resolveRuntimeMode({
        platform: "cli",
        cwd: "/tmp",
        config: { agent: { coding_context: "off" } },
      });
      expect(isCodingMode(mode)).toBe(false);
      expect(mode.configMode).toBe("off");
    });

    it("on config forces coding profile even outside a workspace", () => {
      const mode = resolveRuntimeMode({
        platform: "cli",
        cwd: "/tmp",
        config: { agent: { coding_context: "on" } },
      });
      expect(isCodingMode(mode)).toBe(true);
      expect(mode.configMode).toBe("on");
    });

    it("focus mode is mapped to focus configMode", () => {
      const mode = resolveRuntimeMode({
        platform: "cli",
        cwd: "/tmp",
        config: { agent: { coding_context: "focus" } },
      });
      expect(mode.configMode).toBe("focus");
    });

    it("isCodingContext wraps resolveRuntimeMode", () => {
      expect(
        isCodingContext({ platform: "cli", cwd: "/tmp", config: { agent: { coding_context: "off" } } }),
      ).toBe(false);
      expect(
        isCodingContext({ platform: "cli", cwd: "/tmp", config: { agent: { coding_context: "on" } } }),
      ).toBe(true);
    });

    it("non-interactive platform (messaging) defaults to general even in auto", () => {
      const mode = resolveRuntimeMode({
        platform: "slack",
        cwd: "/tmp",
        config: { agent: { coding_context: "auto" } },
      });
      expect(isCodingMode(mode)).toBe(false);
    });
  });

  describe("codingSystemBlocks & codingCompactSkillCategories", () => {
    it("returns empty blocks for non-coding mode", () => {
      const blocks = codingSystemBlocks({
        platform: "cli",
        cwd: "/tmp",
        config: { agent: { coding_context: "off" } },
      });
      expect(blocks).toEqual([]);
    });

    it("returns guidance + workspace blocks for forced coding mode", () => {
      const blocks = codingSystemBlocks({
        platform: "cli",
        cwd: "/tmp",
        config: { agent: { coding_context: "on" } },
        model: "gpt-4o",
      });
      expect(blocks.length).toBeGreaterThan(0);
      // First block carries the guidance.
      expect(blocks[0].length).toBeGreaterThan(0);
    });

    it("compactSkillCategories only returns a set in focus mode", () => {
      const off = codingCompactSkillCategories({
        platform: "cli",
        cwd: "/tmp",
        config: { agent: { coding_context: "off" } },
      });
      expect(off.size).toBe(0);

      const focus = codingCompactSkillCategories({
        platform: "cli",
        cwd: "/tmp",
        config: { agent: { coding_context: "focus" } },
      });
      expect(focus.size).toBeGreaterThan(0);
    });
  });

  describe("buildCodingWorkspaceBlock (F10.1 — command-injection-safe)", () => {
    let tmpDir: string;

    beforeEach(() => {
      tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "evo-cc-"));
    });

    afterEach(() => {
      try {
        fs.rmSync(tmpDir, { recursive: true, force: true });
      } catch {
        /* ignore */
      }
    });

    it("regression: does NOT throw on a real workspace path and returns a string", () => {
      // Put a marker file so the dir is recognised as a project root.
      fs.writeFileSync(path.join(tmpDir, "package.json"), '{"name":"test"}');
      fs.writeFileSync(path.join(tmpDir, "index.ts"), "export const x = 1;\n");

      // Must not throw — the fix uses execFileSync (no shell) so cwd with
      // shell metacharacters cannot inject commands.
      let block: string;
      expect(() => {
        block = buildCodingWorkspaceBlock(tmpDir);
      }).not.toThrow();
      expect(typeof block).toBe("string");
      expect(block.length).toBeGreaterThan(0);
      expect(block).toContain("Workspace");
      expect(block).toContain("package.json");
    });

    it("does not throw for a directory with no markers and no git", () => {
      // No marker files, no .git in the temp dir itself. (We do not assert the
      // result is empty: markerRoot walks up to 6 ancestors, and an ancestor
      // in the tmp path could theoretically carry a marker. The F10.1 guarantee
      // is "does not throw and returns a string".)
      const block = buildCodingWorkspaceBlock(tmpDir);
      expect(typeof block).toBe("string");
    });
  });

  describe("detectProjectFacts", () => {
    let tmpDir: string;

    beforeEach(() => {
      tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "evo-pf-"));
    });

    afterEach(() => {
      try {
        fs.rmSync(tmpDir, { recursive: true, force: true });
      } catch {
        /* ignore */
      }
    });

    it("detects manifests, package managers, and verify commands", () => {
      fs.writeFileSync(
        path.join(tmpDir, "package.json"),
        JSON.stringify({ name: "demo", scripts: { test: "vitest run", lint: "eslint ." } }),
      );
      fs.writeFileSync(path.join(tmpDir, "pnpm-lock.yaml"), "lockfileVersion: 6\n");

      const facts = detectProjectFacts(tmpDir);
      expect(facts.manifests).toContain("package.json");
      expect(facts.packageManagers).toContain("pnpm");
      expect(facts.verifyCommands.some((c) => c.includes("test"))).toBe(true);
      expect(facts.verifyCommands.some((c) => c.includes("lint"))).toBe(true);
    });

    it("returns empty facts for an empty directory", () => {
      const facts = detectProjectFacts(tmpDir);
      expect(facts.manifests).toEqual([]);
      expect(facts.packageManagers).toEqual([]);
      expect(facts.verifyCommands).toEqual([]);
      expect(facts.contextFiles).toEqual([]);
    });
  });
});
