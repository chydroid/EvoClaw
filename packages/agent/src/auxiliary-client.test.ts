import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  classifyProvider,
  isCreditExhaustedError,
  isRateLimitError,
  withInterruptProtection,
  isInterruptProtected,
  resolveAuxRuntime,
  callAuxLLM,
  collectAllRuntimes,
  type AuxRuntime,
  type AuxCallResult,
} from "./auxiliary-client";

const ENV_KEYS = [
  "OPENROUTER_API_KEY",
  "ANTHROPIC_API_KEY",
  "OPENAI_API_KEY",
  "ZAI_API_KEY",
  "MOONSHOT_API_KEY",
  "MINIMAX_API_KEY",
];

describe("auxiliary-client", () => {
  let savedEnv: Record<string, string | undefined>;

  beforeEach(() => {
    savedEnv = {};
    for (const k of ENV_KEYS) {
      savedEnv[k] = process.env[k];
      delete process.env[k];
    }
  });

  afterEach(() => {
    for (const k of ENV_KEYS) {
      if (savedEnv[k] === undefined) delete process.env[k];
      else process.env[k] = savedEnv[k];
    }
  });

  describe("classifyProvider", () => {
    it("classifies a base URL containing 'openrouter'", () => {
      expect(classifyProvider("https://openrouter.ai/api/v1")).toBe("openrouter");
    });

    it("classifies named providers", () => {
      expect(classifyProvider("anthropic")).toBe("anthropic");
      expect(classifyProvider("claude-3-opus")).toBe("anthropic");
      expect(classifyProvider("openai")).toBe("openai");
      expect(classifyProvider("gpt-4o")).toBe("openai");
      expect(classifyProvider("codex")).toBe("codex");
      expect(classifyProvider("z.ai")).toBe("zai");
      expect(classifyProvider("glm-4")).toBe("zai");
      expect(classifyProvider("moonshot")).toBe("kimi");
      expect(classifyProvider("kimi")).toBe("kimi");
      expect(classifyProvider("minimax")).toBe("minimax");
      expect(classifyProvider("minimax-cn")).toBe("minimax_cn");
      expect(classifyProvider("nous")).toBe("nous_portal");
    });

    it("returns 'unknown' for unmatched names", () => {
      expect(classifyProvider("some-unknown-provider")).toBe("unknown");
      expect(classifyProvider("")).toBe("unknown");
    });
  });

  describe("isCreditExhaustedError", () => {
    it("returns true for HTTP 402 (status or statusCode)", () => {
      expect(isCreditExhaustedError({ status: 402 })).toBe(true);
      expect(isCreditExhaustedError({ statusCode: 402 })).toBe(true);
    });

    it("returns true for credit-related messages", () => {
      expect(isCreditExhaustedError({ message: "insufficient credits" })).toBe(true);
      expect(isCreditExhaustedError({ message: "Payment Required" })).toBe(true);
      expect(isCreditExhaustedError({ message: "credit balance too low" })).toBe(true);
      expect(isCreditExhaustedError({ code: "402" })).toBe(true);
    });

    it("returns false for unrelated errors and non-objects", () => {
      expect(isCreditExhaustedError({ status: 500 })).toBe(false);
      expect(isCreditExhaustedError({ message: "timeout" })).toBe(false);
      expect(isCreditExhaustedError(null)).toBe(false);
      expect(isCreditExhaustedError(undefined)).toBe(false);
      expect(isCreditExhaustedError("string")).toBe(false);
      expect(isCreditExhaustedError({})).toBe(false);
    });
  });

  describe("isRateLimitError", () => {
    it("returns true for HTTP 429", () => {
      expect(isRateLimitError({ status: 429 })).toBe(true);
      expect(isRateLimitError({ statusCode: 429 })).toBe(true);
    });

    it("returns true for rate_limit codes", () => {
      expect(isRateLimitError({ code: "rate_limit_exceeded" })).toBe(true);
      expect(isRateLimitError({ code: "ratelimit" })).toBe(true);
    });

    it("returns false for unrelated errors", () => {
      expect(isRateLimitError({ status: 500 })).toBe(false);
      expect(isRateLimitError(null)).toBe(false);
      expect(isRateLimitError({})).toBe(false);
    });
  });

  describe("withInterruptProtection / isInterruptProtected (AsyncLocalStorage isolation)", () => {
    it("regression: isInterruptProtected is true inside, false after resolution", async () => {
      // The bug: a module-level counter shared state across all side tasks.
      // The fix uses AsyncLocalStorage so the flag is context-local and does
      // not leak after the protected block resolves.
      let insideProtection = false;
      await withInterruptProtection(async () => {
        insideProtection = isInterruptProtected();
      });
      expect(insideProtection).toBe(true);
      expect(isInterruptProtected()).toBe(false);
    });

    it("is false outside any protection block", () => {
      expect(isInterruptProtected()).toBe(false);
    });

    it("does not leak into sibling async tasks", async () => {
      // A concurrent unprotected task must NOT see the protection flag set
      // by a sibling protected task.
      let unprotectedSawFlag = true;
      const protectedTask = withInterruptProtection(async () => {
        // Yield so the sibling runs while we're still inside protection.
        await Promise.resolve();
        return isInterruptProtected();
      });
      const siblingTask = (async () => {
        await Promise.resolve();
        unprotectedSawFlag = isInterruptProtected();
        return unprotectedSawFlag;
      })();
      const [protectedResult, _siblingResult] = await Promise.all([protectedTask, siblingTask]);
      expect(protectedResult).toBe(true);
      expect(unprotectedSawFlag).toBe(false);
    });
  });

  describe("resolveAuxRuntime", () => {
    it("returns the main runtime when provider+model are present", () => {
      const rt = resolveAuxRuntime(
        "compression",
        { provider: "openai", model: "gpt-4o", apiKey: "sk-x", baseUrl: "https://api.openai.com/v1" },
        {},
        false,
      );
      expect(rt).not.toBeNull();
      expect(rt!.source).toBe("main");
      expect(rt!.provider).toBe("openai");
      expect(rt!.model).toBe("gpt-4o");
    });

    it("per-task override takes precedence over main", () => {
      const rt = resolveAuxRuntime(
        "title_generation",
        { provider: "openai", model: "gpt-4o" },
        {
          tasks: {
            title_generation: { provider: "anthropic", model: "claude-haiku-4-5", apiKey: "sk-a" },
          },
        },
        false,
      );
      expect(rt).not.toBeNull();
      expect(rt!.source).toBe("override");
      expect(rt!.provider).toBe("anthropic");
      expect(rt!.model).toBe("claude-haiku-4-5");
    });

    it("falls back to OpenRouter when main is absent and key is set", () => {
      process.env.OPENROUTER_API_KEY = "or-key";
      const rt = resolveAuxRuntime("generic", { provider: null, model: null }, {}, false);
      expect(rt).not.toBeNull();
      expect(rt!.source).toBe("openrouter");
      expect(rt!.apiKey).toBe("or-key");
      expect(rt!.baseUrl).toBe("https://openrouter.ai/api/v1");
    });

    it("returns null when nothing is available", () => {
      const rt = resolveAuxRuntime("generic", { provider: null, model: null }, {}, false);
      expect(rt).toBeNull();
    });

    it("skips a non-vision main runtime when requireVision is true", () => {
      const rt = resolveAuxRuntime(
        "vision",
        { provider: "openai", model: "gpt-4o", visionCapable: false },
        {},
        true,
      );
      // No main (not vision-capable), no env keys → null.
      expect(rt).toBeNull();
    });
  });

  describe("collectAllRuntimes", () => {
    it("collects main + env-var runtimes", () => {
      process.env.OPENROUTER_API_KEY = "or-key";
      process.env.ANTHROPIC_API_KEY = "an-key";
      const runtimes = collectAllRuntimes(
        { provider: "openai", model: "gpt-4o", apiKey: "sk-main", baseUrl: "https://api.openai.com/v1" },
        {},
        false,
      );
      const sources = runtimes.map((r) => r.source);
      expect(sources).toContain("main");
      expect(sources).toContain("openrouter");
      expect(sources).toContain("anthropic");
    });

    it("returns empty when nothing is configured", () => {
      const runtimes = collectAllRuntimes({ provider: null, model: null }, {}, false);
      expect(runtimes).toEqual([]);
    });
  });

  describe("callAuxLLM", () => {
    it("returns the result when the first runtime succeeds", async () => {
      const chatFn = vi.fn(async (): Promise<AuxCallResult> => ({
        content: "ok",
        model: "gpt-4o",
        provider: "openai",
        runtime: {} as AuxRuntime,
      }));
      const result = await callAuxLLM(
        { task: "compression", messages: [{ role: "user", content: "hi" }] },
        { provider: "openai", model: "gpt-4o", apiKey: "sk-x" },
        chatFn,
        {},
      );
      expect(result.content).toBe("ok");
      expect(chatFn).toHaveBeenCalledTimes(1);
    });

    it("regression: falls back to the next runtime on HTTP 402 (credit exhausted)", async () => {
      let calls = 0;
      const chatFn = vi.fn(async (): Promise<AuxCallResult> => {
        calls++;
        if (calls === 1) {
          const err = Object.assign(new Error("insufficient credits"), { status: 402 });
          throw err;
        }
        return {
          content: "fallback-ok",
          model: "gpt-4o",
          provider: "openai",
          runtime: {} as AuxRuntime,
        };
      });
      // Set up two runtimes: main + openrouter fallback.
      process.env.OPENROUTER_API_KEY = "or-key";
      const result = await callAuxLLM(
        { task: "generic", messages: [{ role: "user", content: "hi" }] },
        { provider: "openai", model: "gpt-4o", apiKey: "sk-main" },
        chatFn,
        {},
      );
      expect(result.content).toBe("fallback-ok");
      expect(chatFn).toHaveBeenCalledTimes(2);
    });

    it("rethrows non-credit, non-ratelimit errors immediately", async () => {
      const chatFn = vi.fn(async (): Promise<AuxCallResult> => {
        throw new Error("boom");
      });
      await expect(
        callAuxLLM(
          { task: "generic", messages: [{ role: "user", content: "hi" }] },
          { provider: "openai", model: "gpt-4o", apiKey: "sk-main" },
          chatFn,
          {},
        ),
      ).rejects.toThrow("boom");
      expect(chatFn).toHaveBeenCalledTimes(1);
    });
  });
});
