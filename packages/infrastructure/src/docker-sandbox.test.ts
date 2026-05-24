import { describe, it, expect, vi, beforeEach } from "vitest";
import { DockerSandbox } from "./docker-sandbox";
import type { SandboxConfig } from "./docker-sandbox";

// Mock child_process spawn to avoid actually running docker
vi.mock("child_process", () => ({
  spawn: vi.fn(),
}));

describe("DockerSandbox", () => {
  let sandbox: DockerSandbox;

  beforeEach(() => {
    sandbox = new DockerSandbox();
  });

  // ── Config Defaults ───────────────────────────────

  it("should create a DockerSandbox instance", () => {
    expect(sandbox).toBeDefined();
  });

  it("should return result with error when docker is unavailable", async () => {
    // isAvailable caches the result, so we need a fresh instance
    // that hasn't checked yet. We can force the check by creating a new one.
    const sb = new DockerSandbox();
    // The first call to isAvailable will try `docker info` which spawn mocks
    // will reject by default because no mock is set up
    // Actually let's test the runScript method which calls isAvailable internally
    // and should fall back
    const result = await sb.runScript("console.log(1)");
    // Since spawn mock returns a mock with no listeners, it should fail
    expect(result.success).toBe(false);
  });
});