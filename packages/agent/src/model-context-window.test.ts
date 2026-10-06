import { describe, it, expect } from "vitest";
import { resolveContextWindow, matchModelEntry, describeContextWindowSource } from "./model-context-window";
import { getCatalog } from "./model-catalog";

describe("matchModelEntry", () => {
  const catalog = getCatalog();

  it("精确命中 catalog id", () => {
    const e = matchModelEntry("gpt-4o", catalog);
    expect(e?.id).toBe("gpt-4o");
  });

  it("带日期后缀的模型能前缀命中（这是旧实现的老大难）", () => {
    // 旧实现用 pattern.replace("-4o","") 把 "gpt-4o" 削成 "gpt"，
    // 导致任何含 "gpt" 的模型都命中第一条 —— 这里验证取的是最长前缀。
    const e = matchModelEntry("gpt-4o-2024-11-20", catalog);
    expect(e?.id).toBe("gpt-4o");
  });

  it("取最长匹配而非首条命中", () => {
    const e = matchModelEntry("gpt-4o-mini-2025", catalog);
    expect(e?.id).toBe("gpt-4o-mini");
  });

  it("大小写与空白不敏感", () => {
    expect(matchModelEntry("  GPT-4O ", catalog)?.id).toBe("gpt-4o");
  });

  it("完全未收录的模型返回 undefined（而不是错配到同族其它型号）", () => {
    expect(matchModelEntry("some-unknown-llm-v9", catalog)).toBeUndefined();
  });
});

describe("resolveContextWindow", () => {
  const catalog = getCatalog();
  const windowOf = (id: string) => catalog.find((m) => m.id === id)?.maxContextTokens;

  it("按 catalog 真实值解析，而非固定 128k", () => {
    const gpt41 = windowOf("gpt-4.1");
    expect(gpt41).toBeTruthy();
    const r = resolveContextWindow({ model: "gpt-4.1-2025-04-14" });
    // 关键回归：1M 窗口的模型绝不能再被报成 128k
    expect(r.limit).toBe(gpt41);
    expect(r.limit).not.toBe(128000);
    expect(r.source).toBe("catalog");
  });

  it("不同型号解析出不同窗口（证明分母是动态的）", () => {
    const a = resolveContextWindow({ model: "gpt-4.1" }).limit;
    const b = resolveContextWindow({ model: "gpt-3.5-turbo" }).limit;
    expect(a).not.toBe(b);
  });

  it("用户显式设置优先级最高，覆盖 catalog", () => {
    const r = resolveContextWindow({ model: "gpt-4.1", userOverride: 64_000 });
    expect(r.limit).toBe(64_000);
    expect(r.source).toBe("user");
  });

  it("provider 报告值优先于 catalog", () => {
    const r = resolveContextWindow({ model: "gpt-4.1", reported: 2_000_000 });
    expect(r.limit).toBe(2_000_000);
    expect(r.source).toBe("provider");
  });

  it("优先级链：user > reported > catalog", () => {
    const r = resolveContextWindow({ model: "gpt-4.1", userOverride: 8_000, reported: 2_000_000 });
    expect(r.limit).toBe(8_000);
    expect(r.source).toBe("user");
  });

  it("非法 userOverride（0/负数/NaN）视为未设置，回落到 catalog", () => {
    expect(resolveContextWindow({ model: "gpt-4.1", userOverride: 0 }).source).toBe("catalog");
    expect(resolveContextWindow({ model: "gpt-4.1", userOverride: -5 }).source).toBe("catalog");
    expect(resolveContextWindow({ model: "gpt-4.1", userOverride: NaN }).source).toBe("catalog");
  });

  it("模型未收录时按 provider 维度兜底，并标记为 fallback", () => {
    const r = resolveContextWindow({ model: "mystery-model-x", provider: "anthropic" });
    expect(r.limit).toBe(200_000);
    expect(r.source).toBe("fallback");
  });

  it("provider 串里带厂商名也能兜底（claude-3-5-sonnet 这类写法）", () => {
    expect(resolveContextWindow({ model: "claude-3-5-sonnet-20241022", provider: "claude-3-5-sonnet" }).limit).toBe(200_000);
  });

  it("模型与 provider 都未知时才用最终兜底", () => {
    const r = resolveContextWindow({});
    expect(r.limit).toBe(128_000);
    expect(r.source).toBe("fallback");
  });

  it("支持自定义 fallback", () => {
    expect(resolveContextWindow({ fallback: 32_000 }).limit).toBe(32_000);
  });

  it("空模型名不会误命中", () => {
    expect(resolveContextWindow({ model: "" }).source).toBe("fallback");
    expect(resolveContextWindow({ model: null }).source).toBe("fallback");
  });

  it("catalog 中所有模型的窗口都应为正值", () => {
    for (const m of catalog) {
      expect(m.maxContextTokens, `model ${m.id}`).toBeGreaterThan(0);
    }
  });
});

describe("describeContextWindowSource", () => {
  it("标注估算值，便于 UI 提示用户", () => {
    expect(describeContextWindowSource(resolveContextWindow({ model: "gpt-4.1" }))).toContain("内置模型库");
    expect(describeContextWindowSource(resolveContextWindow({ model: "gpt-4.1", userOverride: 1000 }))).toBe("用户设置");
    expect(describeContextWindowSource(resolveContextWindow({ model: "totally-unknown" }))).toContain("估算值");
  });
});
