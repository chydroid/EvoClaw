/**
 * response-filters.test — 交付过滤测试（对标 hermes-agent gateway/response_filters.py）
 */

import { describe, it, expect } from "vitest";
import {
  isIntentionalSilenceResponse,
  isAutonomousSilenceResponse,
  isIntentionalSilenceAgentResult,
  isMachineryDisplayKind,
  silenceAllowed,
  isPartialSilenceMarker,
  shouldSuppressDelivery,
  LIVE_GATEWAY_SILENT_MARKERS,
} from "./response-filters";

describe("isIntentionalSilenceResponse", () => {
  it("匹配精确静默标记", () => {
    expect(isIntentionalSilenceResponse("[SILENT]")).toBe(true);
    expect(isIntentionalSilenceResponse("SILENT")).toBe(true);
    expect(isIntentionalSilenceResponse("NO_REPLY")).toBe(true);
    expect(isIntentionalSilenceResponse("NO REPLY")).toBe(true);
    expect(isIntentionalSilenceResponse("[静默]")).toBe(true);
    expect(isIntentionalSilenceResponse("静默")).toBe(true);
    expect(isIntentionalSilenceResponse("[沉默]")).toBe(true);
    expect(isIntentionalSilenceResponse("沉默")).toBe(true);
  });

  it("忽略前后空白和大小写", () => {
    expect(isIntentionalSilenceResponse("  [SILENT]  ")).toBe(true);
    expect(isIntentionalSilenceResponse("silent")).toBe(true);
    expect(isIntentionalSilenceResponse("No_Reply")).toBe(true);
  });

  it("忽略边缘标点", () => {
    expect(isIntentionalSilenceResponse(".NO_REPLY")).toBe(true);
    expect(isIntentionalSilenceResponse("*NO_REPLY*")).toBe(true);
  });

  it("普通文本不算静默", () => {
    expect(isIntentionalSilenceResponse("Hello world")).toBe(false);
    expect(isIntentionalSilenceResponse("I will not reply with NO_REPLY")).toBe(false);
    expect(isIntentionalSilenceResponse("Silent retry succeeded")).toBe(false);
  });

  it("空响应不算静默", () => {
    expect(isIntentionalSilenceResponse("")).toBe(false);
    expect(isIntentionalSilenceResponse("   ")).toBe(false);
  });

  it("非字符串返回 false", () => {
    expect(isIntentionalSilenceResponse(null)).toBe(false);
    expect(isIntentionalSilenceResponse(undefined)).toBe(false);
    expect(isIntentionalSilenceResponse(123)).toBe(false);
  });

  it("超长响应不算静默", () => {
    expect(isIntentionalSilenceResponse("SILENT ".repeat(20))).toBe(false);
  });
});

describe("isAutonomousSilenceResponse", () => {
  it("匹配带括号标记的前缀", () => {
    expect(isAutonomousSilenceResponse("[SILENT] No changes detected")).toBe(true);
    expect(isAutonomousSilenceResponse("[静默] 无更新")).toBe(true);
  });

  it("匹配首行/末行的精确标记", () => {
    expect(isAutonomousSilenceResponse("[SILENT]\nsome content")).toBe(true);
    expect(isAutonomousSilenceResponse("some content\n[SILENT]")).toBe(true);
  });

  it("匹配整响应为标记", () => {
    expect(isAutonomousSilenceResponse("NO_REPLY")).toBe(true);
  });

  it("不匹配埋在句子中间的标记", () => {
    expect(isAutonomousSilenceResponse("The word SILENT appears here")).toBe(false);
  });

  it("不匹配无括号的裸标记前缀", () => {
    expect(isAutonomousSilenceResponse("Silent retry succeeded")).toBe(false);
  });
});

describe("isIntentionalSilenceAgentResult", () => {
  it("成功回合 + 静默标记 = true", () => {
    expect(isIntentionalSilenceAgentResult({ failed: false }, "[SILENT]")).toBe(true);
    expect(isIntentionalSilenceAgentResult({}, "NO_REPLY")).toBe(true);
  });

  it("失败回合 = false", () => {
    expect(isIntentionalSilenceAgentResult({ failed: true }, "[SILENT]")).toBe(false);
  });

  it("非静默响应 = false", () => {
    expect(isIntentionalSilenceAgentResult({ failed: false }, "Hello")).toBe(false);
  });

  it("null/undefined = false", () => {
    expect(isIntentionalSilenceAgentResult(null, "[SILENT]")).toBe(false);
    expect(isIntentionalSilenceAgentResult(undefined, "[SILENT]")).toBe(false);
  });
});

describe("isMachineryDisplayKind", () => {
  it("匹配机器内部 kind", () => {
    expect(isMachineryDisplayKind("internal_notification")).toBe(true);
    expect(isMachineryDisplayKind("process_complete")).toBe(true);
    expect(isMachineryDisplayKind("async_delegation_complete")).toBe(true);
  });

  it("不匹配人类回合", () => {
    expect(isMachineryDisplayKind("user")).toBe(false);
    expect(isMachineryDisplayKind("")).toBe(false);
    expect(isMachineryDisplayKind(undefined)).toBe(false);
  });
});

describe("silenceAllowed", () => {
  it("机器内部回合允许静默", () => {
    expect(silenceAllowed("internal_notification")).toBe(true);
  });

  it("replyExpected=false 允许静默", () => {
    expect(silenceAllowed("user", false)).toBe(true);
  });

  it("人类回合 + replyExpected=true 不允许静默", () => {
    expect(silenceAllowed("user", true)).toBe(false);
  });

  it("人类回合 + replyExpected=null 不允许静默", () => {
    expect(silenceAllowed("user", null)).toBe(false);
    expect(silenceAllowed("user", undefined)).toBe(false);
  });
});

describe("isPartialSilenceMarker", () => {
  it("匹配标记前缀", () => {
    expect(isPartialSilenceMarker("NO")).toBe(true);
    expect(isPartialSilenceMarker("NO_RE")).toBe(true);
    expect(isPartialSilenceMarker("[SILEN")).toBe(true);
  });

  it("不匹配无关文本", () => {
    expect(isPartialSilenceMarker("Hello")).toBe(false);
    expect(isPartialSilenceMarker("123")).toBe(false);
  });

  it("空字符串返回 false", () => {
    expect(isPartialSilenceMarker("")).toBe(false);
  });
});

describe("shouldSuppressDelivery", () => {
  it("成功机器内部回合 + 静默 = 抑制", () => {
    expect(shouldSuppressDelivery("internal_notification", null, "[SILENT]")).toBe(true);
  });

  it("成功人类回合 + 静默 + replyExpected=true = 不抑制", () => {
    expect(shouldSuppressDelivery("user", true, "[SILENT]")).toBe(false);
  });

  it("成功人类回合 + 静默 + replyExpected=false = 抑制", () => {
    expect(shouldSuppressDelivery("user", false, "[SILENT]")).toBe(true);
  });

  it("失败回合不抑制", () => {
    expect(shouldSuppressDelivery("user", true, "[SILENT]", true)).toBe(false);
  });

  it("非静默响应不抑制", () => {
    expect(shouldSuppressDelivery("internal_notification", null, "Hello")).toBe(false);
  });
});

describe("LIVE_GATEWAY_SILENT_MARKERS", () => {
  it("包含中英文标记", () => {
    expect(LIVE_GATEWAY_SILENT_MARKERS.has("[SILENT]")).toBe(true);
    expect(LIVE_GATEWAY_SILENT_MARKERS.has("NO_REPLY")).toBe(true);
    expect(LIVE_GATEWAY_SILENT_MARKERS.has("[静默]")).toBe(true);
    expect(LIVE_GATEWAY_SILENT_MARKERS.has("沉默")).toBe(true);
  });
});
