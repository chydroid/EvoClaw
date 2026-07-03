import { describe, it, expect } from "vitest";
import {
  emptyUsage,
  promptTokens,
  totalTokens,
  sumUsage,
  resolveBillingRoute,
  getPricingEntry,
  normalizeUsage,
  estimateUsageCost,
  hasKnownPricing,
  formatDurationCompact,
  formatTokenCountCompact,
} from "./usage-pricing";

// ── Canonical usage helpers ───────────────────────────────────────────
describe("usage-pricing: canonical usage", () => {
  it("emptyUsage returns all-zero buckets with requestCount=1", () => {
    const u = emptyUsage();
    expect(u.inputTokens).toBe(0);
    expect(u.outputTokens).toBe(0);
    expect(u.cacheReadTokens).toBe(0);
    expect(u.cacheWriteTokens).toBe(0);
    expect(u.reasoningTokens).toBe(0);
    expect(u.requestCount).toBe(1);
  });

  it("promptTokens sums input + cacheRead + cacheWrite", () => {
    const u = {
      ...emptyUsage(),
      inputTokens: 100,
      cacheReadTokens: 30,
      cacheWriteTokens: 20,
    };
    expect(promptTokens(u)).toBe(150);
  });

  it("totalTokens adds output on top of promptTokens", () => {
    const u = {
      ...emptyUsage(),
      inputTokens: 100,
      outputTokens: 50,
      cacheReadTokens: 10,
    };
    expect(totalTokens(u)).toBe(160);
  });

  it("sumUsage(a, b) adds fields pairwise and drops rawUsage", () => {
    // NOTE: sumUsage takes TWO args (not an array) — mirrors the source.
    const a = { ...emptyUsage(), inputTokens: 100, outputTokens: 50, rawUsage: { x: 1 } };
    const b = { ...emptyUsage(), inputTokens: 200, outputTokens: 75, rawUsage: { y: 2 } };
    const sum = sumUsage(a, b);
    expect(sum.inputTokens).toBe(300);
    expect(sum.outputTokens).toBe(125);
    expect(sum.requestCount).toBe(2);
    expect(sum.rawUsage).toBeUndefined();
  });
});

// ── resolveBillingRoute ──────────────────────────────────────────────
describe("usage-pricing: resolveBillingRoute", () => {
  it("openai-codex → subscription_included", () => {
    const r = resolveBillingRoute("o3-mini", "openai-codex", "");
    expect(r.billingMode).toBe("subscription_included");
    expect(r.provider).toBe("openai-codex");
  });

  it("openrouter detected by provider name and by baseUrl host", () => {
    expect(resolveBillingRoute("x", "openrouter", "").billingMode).toBe("official_models_api");
    expect(
      resolveBillingRoute("x", null, "https://openrouter.ai/api/v1").provider,
    ).toBe("openrouter");
  });

  it("infers provider from anthropic/ prefix when provider is empty", () => {
    const r = resolveBillingRoute("anthropic/claude-opus-4-8");
    expect(r.provider).toBe("anthropic");
    expect(r.model).toBe("claude-opus-4-8");
    expect(r.billingMode).toBe("official_docs_snapshot");
  });

  it("vertex provider maps to gemini billing route", () => {
    const r = resolveBillingRoute("gemini-2.5-pro", "vertex", "");
    expect(r.provider).toBe("gemini");
    expect(r.billingMode).toBe("official_docs_snapshot");
  });

  it("custom/local/localhost → unknown billing mode", () => {
    expect(resolveBillingRoute("my-model", "local", "").billingMode).toBe("unknown");
    expect(resolveBillingRoute("m", null, "http://localhost:8080").billingMode).toBe("unknown");
  });

  it("unknown provider falls through to unknown billing mode", () => {
    const r = resolveBillingRoute("weird-model", "acme", "");
    expect(r.billingMode).toBe("unknown");
    expect(r.provider).toBe("acme");
  });
});

// ── getPricingEntry ───────────────────────────────────────────────────
describe("usage-pricing: getPricingEntry", () => {
  it("subscription_included route returns zero-cost entry", () => {
    const entry = getPricingEntry("o3-mini", { provider: "openai-codex" });
    expect(entry).not.toBeNull();
    expect(entry!.inputCostPerMillion).toBe(0);
    expect(entry!.outputCostPerMillion).toBe(0);
    expect(entry!.source).toBe("none");
  });

  it("known model returns official docs pricing", () => {
    const entry = getPricingEntry("gpt-4o", { provider: "openai" });
    expect(entry).not.toBeNull();
    expect(entry!.inputCostPerMillion).toBe(2.5);
    expect(entry!.outputCostPerMillion).toBe(10.0);
    expect(entry!.source).toBe("official_docs_snapshot");
  });

  it("unknown model returns null", () => {
    expect(getPricingEntry("no-such-model", { provider: "openai" })).toBeNull();
  });

  it("metadata takes precedence over docs snapshot", () => {
    const entry = getPricingEntry("gpt-4o", {
      provider: "openai",
      metadata: {
        "gpt-4o": { pricing: { prompt: 0.000003, completion: 0.000012 } },
      },
    });
    expect(entry).not.toBeNull();
    expect(entry!.source).toBe("provider_models_api");
    // 0.000003 per token → 3.0 per million
    expect(entry!.inputCostPerMillion).toBe(3.0);
    expect(entry!.outputCostPerMillion).toBe(12.0);
  });
});

// ── normalizeUsage ────────────────────────────────────────────────────
describe("usage-pricing: normalizeUsage", () => {
  it("null / non-object → emptyUsage", () => {
    expect(normalizeUsage(null).inputTokens).toBe(0);
    expect(normalizeUsage("string").inputTokens).toBe(0);
  });

  it("Anthropic shape: cache tokens NOT subtracted from input", () => {
    const u = normalizeUsage(
      {
        input_tokens: 1000,
        output_tokens: 500,
        cache_read_input_tokens: 200,
        cache_creation_input_tokens: 50,
      },
      { provider: "anthropic" },
    );
    expect(u.inputTokens).toBe(1000);
    expect(u.outputTokens).toBe(500);
    expect(u.cacheReadTokens).toBe(200);
    expect(u.cacheWriteTokens).toBe(50);
  });

  it("OpenAI Chat Completions: cache subtracted from prompt total", () => {
    const u = normalizeUsage({
      prompt_tokens: 1000,
      completion_tokens: 500,
      prompt_tokens_details: { cached_tokens: 200 },
    });
    // input = 1000 - 200 = 800
    expect(u.inputTokens).toBe(800);
    expect(u.outputTokens).toBe(500);
    expect(u.cacheReadTokens).toBe(200);
  });

  it("reasoning tokens from completion_tokens_details", () => {
    const u = normalizeUsage({
      prompt_tokens: 100,
      completion_tokens: 50,
      completion_tokens_details: { reasoning_tokens: 30 },
    });
    expect(u.reasoningTokens).toBe(30);
  });
});

// ── estimateUsageCost ─────────────────────────────────────────────────
describe("usage-pricing: estimateUsageCost", () => {
  it("subscription route → included, $0", () => {
    const r = estimateUsageCost("o3-mini", emptyUsage(), { provider: "openai-codex" });
    expect(r.amountUsd).toBe(0);
    expect(r.status).toBe("included");
    expect(r.label).toBe("included");
  });

  it("unknown model → null amount, unknown status", () => {
    const r = estimateUsageCost("no-such-model", emptyUsage(), { provider: "openai" });
    expect(r.amountUsd).toBeNull();
    expect(r.status).toBe("unknown");
  });

  it("known model computes estimated cost", () => {
    const usage = {
      ...emptyUsage(),
      inputTokens: 1_000_000,
      outputTokens: 500_000,
      cacheReadTokens: 100_000,
    };
    // gpt-4o: input=2.5, output=10.0, cacheRead=1.25 per million
    // 2.5 + 5.0 + 0.125 = 7.625
    const r = estimateUsageCost("gpt-4o", usage, { provider: "openai" });
    expect(r.status).toBe("estimated");
    expect(r.amountUsd).toBeCloseTo(7.625, 6);
    expect(r.label).toBe("~$7.63");
  });

  it("cache-read tokens with no cache pricing → unknown with note", () => {
    // deepseek-chat has no cacheReadCostPerMillion in the table.
    const usage = { ...emptyUsage(), inputTokens: 1000, cacheReadTokens: 500 };
    const r = estimateUsageCost("deepseek-chat", usage, { provider: "deepseek" });
    expect(r.amountUsd).toBeNull();
    expect(r.status).toBe("unknown");
    expect(r.notes).toContain("cache-read pricing unavailable for route");
  });
});

// ── hasKnownPricing ───────────────────────────────────────────────────
describe("usage-pricing: hasKnownPricing", () => {
  it("subscription route → true", () => {
    expect(hasKnownPricing("o3-mini", { provider: "openai-codex" })).toBe(true);
  });

  it("known model → true", () => {
    expect(hasKnownPricing("gpt-4o", { provider: "openai" })).toBe(true);
  });

  it("unknown model → false", () => {
    expect(hasKnownPricing("no-such-model", { provider: "openai" })).toBe(false);
  });
});

// ── formatDurationCompact ─────────────────────────────────────────────
describe("usage-pricing: formatDurationCompact", () => {
  it("seconds < 60 → Xs", () => {
    expect(formatDurationCompact(0)).toBe("0s");
    expect(formatDurationCompact(5)).toBe("5s");
    expect(formatDurationCompact(59)).toBe("59s");
  });

  it("minutes < 60 → Xm", () => {
    expect(formatDurationCompact(60)).toBe("1m");
    expect(formatDurationCompact(120)).toBe("2m");
  });

  it("hours show remaining minutes when non-zero", () => {
    expect(formatDurationCompact(3600)).toBe("1h");
    // 3700s = 1h 1m 40s → "1h 1m"
    expect(formatDurationCompact(3700)).toBe("1h 1m");
  });

  it("days → X.Yd", () => {
    expect(formatDurationCompact(86400)).toBe("1.0d");
  });
});

// ── formatTokenCountCompact ───────────────────────────────────────────
describe("usage-pricing: formatTokenCountCompact", () => {
  it("values < 1000 returned as-is", () => {
    expect(formatTokenCountCompact(0)).toBe("0");
    expect(formatTokenCountCompact(999)).toBe("999");
  });

  it("1500 → 1.5K (positive)", () => {
    expect(formatTokenCountCompact(1500)).toBe("1.5K");
  });

  it("-1500 → -1.5K (negative — regression: was -2K with Math.floor)", () => {
    // The implementation uses Math.trunc, not Math.floor, so negative
    // values round toward zero. For -1500 (an integer) both give the same
    // result, but the sign handling + absValue path is the regression.
    expect(formatTokenCountCompact(-1500)).toBe("-1.5K");
  });

  it("small negative non-integer → trunc toward zero (regression: floor gave -2)", () => {
    // trunc(-1.5) = -1 → "-1"; floor(-1.5) = -2 → "-2" (the old bug).
    expect(formatTokenCountCompact(-1.5)).toBe("-1");
  });

  it("millions scale to M", () => {
    expect(formatTokenCountCompact(1_500_000)).toBe("1.5M");
  });

  it("large value with two significant digits", () => {
    // 15000 / 1000 = 15, 10 ≤ scaled < 100 → one decimal place
    expect(formatTokenCountCompact(15_000)).toBe("15K");
  });
});
