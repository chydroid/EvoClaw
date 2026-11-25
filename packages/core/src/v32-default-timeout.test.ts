import { describe, it, expect } from "vitest";
import { DEFAULT_LLM_REQUEST_TIMEOUT_MS, CONFIG_SCHEMA } from "./config-schema";

describe("v32 LLM 默认超时（防止 UI 旧默认 60s 绕过 reasoning floor）", () => {
  it("默认 300s，schema 上限容纳 600s reasoning floor", () => {
    expect(DEFAULT_LLM_REQUEST_TIMEOUT_MS).toBe(300_000);
    const llm = CONFIG_SCHEMA.llm;
    if (llm.type === "object" && llm.properties) {
      expect(llm.properties.timeout?.default).toBe(300_000);
      expect(llm.properties.timeout?.max).toBeGreaterThanOrEqual(600_000);
    }
  });
});
