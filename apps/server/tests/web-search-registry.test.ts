import { describe, it, expect } from "vitest";
import {
  resolveWebBackend,
  resolveSearchBackendConfig,
  WebSearchRegistry,
  LEGACY_WEB_PREFERENCE,
  type WebSearchBackend,
} from "../src/tools/web-search-registry";

function makeBackend(
  name: string,
  opts: { search?: boolean; extract?: boolean; available?: boolean } = {},
): WebSearchBackend {
  return {
    name,
    supportsSearch: () => opts.search ?? true,
    supportsExtract: () => opts.extract ?? false,
    isAvailable: () => opts.available ?? true,
  };
}

describe("resolveWebBackend", () => {
  it("无配置时返回全部能力合格且可用的唯一 provider", () => {
    const backends = [makeBackend("a", { available: true }), makeBackend("b", { available: false })];
    expect(resolveWebBackend({ capability: "search", backends })!.name).toBe("a");
  });

  it("多个可用时按 legacy 偏好顺序", () => {
    const backends = [makeBackend("ddg", { available: true }), makeBackend("tavily", { available: true })];
    expect(resolveWebBackend({ capability: "search", backends })!.name).toBe("tavily");
  });

  it("显式配置优先于 legacy 顺序", () => {
    const backends = [makeBackend("tavily", { available: true }), makeBackend("baidu", { available: true })];
    expect(resolveWebBackend({ configured: "baidu", capability: "search", backends })!.name).toBe("baidu");
  });

  it("显式配置已注册但不可用时仍返回 pinned 后端（宁可报错不静默切换）", () => {
    const backends = [makeBackend("baidu", { available: false })];
    expect(resolveWebBackend({ configured: "baidu", capability: "search", backends })!.name).toBe("baidu");
  });

  it("显式配置未注册时 fall-through 到 legacy", () => {
    const backends = [makeBackend("tavily", { available: true })];
    expect(resolveWebBackend({ configured: "nonexistent", capability: "search", backends })!.name).toBe("tavily");
  });

  it("显式配置已注册但不具备此能力时 fall-through", () => {
    const backends = [makeBackend("tavily", { available: true, search: false })];
    expect(resolveWebBackend({ configured: "tavily", capability: "search", backends })).toBeNull();
  });

  it("能力过滤：不具备 search 能力的后端不出现在结果里", () => {
    const backends = [makeBackend("ddg", { available: true, search: false })];
    expect(resolveWebBackend({ capability: "search", backends })).toBeNull();
  });

  it("empty 返回 null", () => {
    expect(resolveWebBackend({ capability: "search", backends: [] })).toBeNull();
  });

  it("名称归一化：拼写差异也能命中配置", () => {
    const withDash = makeBackend("web-tools-tavily", { available: true });
    const pinned = resolveWebBackend({ configured: "web_tools_tavily", capability: "search", backends: [withDash] });
    expect(pinned).not.toBeNull();
    expect(pinned!.name).toBe("web-tools-tavily");
  });
});

describe("resolveSearchBackendConfig", () => {
  it("默认无配置", () => {
    expect(resolveSearchBackendConfig({})).toBeNull();
  });
  it("读取 env 并 trim", () => {
    expect(resolveSearchBackendConfig({ EVOCLAW_WEB_SEARCH_BACKEND: "  tavily " })).toBe("tavily");
  });
  it("空串视为未配置", () => {
    expect(resolveSearchBackendConfig({ EVOCLAW_WEB_SEARCH_BACKEND: "   " })).toBeNull();
  });
});

describe("WebSearchRegistry", () => {
  it("register 去重 + snapshot", () => {
    const r = new WebSearchRegistry();
    r.register(makeBackend("tavily", { available: true }));
    r.register(makeBackend("Tavily", { available: true })); // 归一化解重
    expect(r.size()).toBe(1);
    expect(r.snapshot().length).toBe(1);
  });

  it("resolveSearch 走配置键", () => {
    const r = new WebSearchRegistry();
    r.register(makeBackend("tavily", { available: true }));
    r.register(makeBackend("baidu", { available: true }));
    expect(r.resolveSearch("baidu")!.name).toBe("baidu");
    expect(r.resolveSearch(null)!.name).toBe("tavily"); // legacy
  });
});

describe("LEGACY_WEB_PREFERENCE", () => {
  it("tavily 在 baidu 之前（付费优先于免费的一致性）", () => {
    expect(LEGACY_WEB_PREFERENCE.indexOf("tavily")).toBeLessThan(LEGACY_WEB_PREFERENCE.indexOf("baidu"));
  });
});