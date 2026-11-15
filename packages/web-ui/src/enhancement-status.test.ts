import { describe, it, expect } from "vitest";
import {
  deriveCapabilityState,
  describeMetrics,
  isHealthyServiceStatus,
} from "./enhancement-status";

describe("EnhancementHub 状态推导 — 修复「全部未就绪」", () => {
  it("ServiceRegistry 的 running 必须视为健康", () => {
    expect(isHealthyServiceStatus("running")).toBe(true);
    expect(isHealthyServiceStatus("error")).toBe(false);
    expect(isHealthyServiceStatus("stopped")).toBe(false);
  });

  it("已注册服务 → 已激活", () => {
    expect(deriveCapabilityState(true, null)).toBe("active");
  });

  it("指标端点 available:true → 模块可用（不再误报未就绪）", () => {
    expect(deriveCapabilityState(undefined, { available: true, registered: false })).toBe("available");
  });

  it("指标端点 enabled:true / registered:true / wired:true → 已激活", () => {
    expect(deriveCapabilityState(undefined, { enabled: true })).toBe("active");
    expect(deriveCapabilityState(undefined, { available: true, registered: true })).toBe("active");
    expect(deriveCapabilityState(undefined, { available: true, wired: true })).toBe("active");
  });

  it("指标端点 enabled:false 且无服务注册 → 未启用", () => {
    expect(deriveCapabilityState(undefined, { enabled: false })).toBe("inactive");
    expect(deriveCapabilityState(false, { enabled: false })).toBe("inactive");
  });

  it("无任何证据 → 未检测", () => {
    expect(deriveCapabilityState(undefined, null)).toBe("unknown");
  });

  it("模块可用但统计未接线时给出可读说明", () => {
    expect(
      describeMetrics("available", { available: true, note: "module available; stats counters not yet instrumented" }),
    ).toBe("模块可用 · 统计未接线");
    expect(describeMetrics("inactive", { enabled: false })).toBe("接口报告未启用");
  });
});
