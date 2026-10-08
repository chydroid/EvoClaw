/**
 * 模型配置分组与排序（2026-10-08）。
 *
 * 用户诉求（原话）：「将模型分成两个分组，将配置好的模型默认排在最上方的分组中，
 * 最新配置的或者修改的会自动排到最上方的位置，而且只有配置好的模型参与排序，
 * 其它的未配置的模型分组不参与排序。」
 */
import { describe, it, expect } from "vitest";
import { groupProviders, isConfigured, markUpdated, flattenGrouped, reorderWithinGroup, type ProviderLike } from "./provider-grouping";

const configured = (id: string, over: Partial<ProviderLike> = {}): ProviderLike => ({
  id,
  name: id,
  baseURL: "https://api.example.com/v1",
  apiKey: "sk-real-key",
  models: ["model-a"],
  selectedModel: "model-a",
  order: 5,
  ...over,
});

const bare = (id: string, over: Partial<ProviderLike> = {}): ProviderLike => ({
  id,
  name: id,
  baseURL: "",
  apiKey: "",
  models: [],
  selectedModel: "",
  order: 1,
  ...over,
});

describe("isConfigured —— 什么算「配置好」", () => {
  it("URL + key + 模型 齐备才算配置完成", () => {
    expect(isConfigured(configured("a"))).toBe(true);
  });

  it("缺 URL 不算", () => {
    expect(isConfigured(configured("a", { baseURL: "" }))).toBe(false);
  });

  it("缺 key 不算（hasApiKey 也为 false）", () => {
    expect(isConfigured(configured("a", { apiKey: "", hasApiKey: false }))).toBe(false);
  });

  it("有 key 但没选模型不算", () => {
    expect(isConfigured(configured("a", { selectedModel: "", models: [] }))).toBe(false);
  });

  it("hasApiKey=true 可代替明文 key（后端返回的是引用而非明文）", () => {
    expect(isConfigured(configured("a", { apiKey: "${LLM_KEY}", hasApiKey: true }))).toBe(true);
  });

  it("空 provider 不算", () => {
    expect(isConfigured(bare("x"))).toBe(false);
  });
});

describe("groupProviders —— 两个分组", () => {
  it("已配置的进上组，未配置的进下组", () => {
    const g = groupProviders([bare("a"), configured("b"), bare("c"), configured("d")]);
    expect(g.configured.map((p) => p.id)).toEqual(["b", "d"]);
    expect(g.unconfigured.map((p) => p.id)).toEqual(["a", "c"]);
  });

  it("已配置组**永远**排在未配置组之前", () => {
    const g = groupProviders([bare("z"), configured("a")]);
    expect(flattenGrouped(g).map((p) => p.id)).toEqual(["a", "z"]);
  });

  it("全部已配置时不会产生空的未配置组", () => {
    const g = groupProviders([configured("a"), configured("b")]);
    expect(g.configured).toHaveLength(2);
    expect(g.unconfigured).toHaveLength(0);
  });

  it("全部未配置时不会产生空的已配置组", () => {
    const g = groupProviders([bare("a"), bare("b")]);
    expect(g.configured).toHaveLength(0);
    expect(g.unconfigured).toHaveLength(2);
  });
});

describe("★ 最新配置/修改的自动排最上", () => {
  it("按 updatedAt 降序：刚改动的在最前", () => {
    const g = groupProviders([
      configured("old", { updatedAt: 1000 }),
      configured("newest", { updatedAt: 3000 }),
      configured("mid", { updatedAt: 2000 }),
    ]);
    expect(g.configured.map((p) => p.id)).toEqual(["newest", "mid", "old"]);
  });

  it("updatedAt 相同则按 order 升序（保持手动顺序）", () => {
    const g = groupProviders([
      configured("b", { updatedAt: 1000, order: 2 }),
      configured("a", { updatedAt: 1000, order: 1 }),
    ]);
    expect(g.configured.map((p) => p.id)).toEqual(["a", "b"]);
  });

  it("从未配置过的（有 URL/key 但无时间戳）排在有时间戳的之后", () => {
    const g = groupProviders([
      configured("never", { order: 1 }),
      configured("saved", { updatedAt: 1000, order: 9 }),
    ]);
    expect(g.configured.map((p) => p.id)).toEqual(["saved", "never"]);
  });

  it("markUpdated 打戳后即排到最前", () => {
    const base = [configured("a", { updatedAt: 1000 }), configured("b", { updatedAt: 2000 })];
    // b 保存 → 时间戳更新 → 应排到 a 前面
    const after = [markUpdated(base[0], 5000), base[1]];
    const g = groupProviders(after);
    expect(g.configured[0].id).toBe("a");
  });

  it("markUpdated 默认使用当前时间且不改动原对象", () => {
    const p = configured("a", { updatedAt: 1 });
    const next = markUpdated(p, 9999);
    expect(next.updatedAt).toBe(9999);
    expect(p.updatedAt).toBe(1); // 原对象不变（不可变更新）
  });
});

describe("★ 未配置组不参与排序", () => {
  it("保持传入顺序（目录原始顺序），不按 order 重排", () => {
    const g = groupProviders([
      bare("first", { order: 99 }),
      bare("second", { order: 1 }),
      bare("third", { order: 50 }),
    ]);
    expect(g.unconfigured.map((p) => p.id)).toEqual(["first", "second", "third"]);
  });

  it("未配置组的顺序不受已配置组影响", () => {
    const withCfg = groupProviders([configured("cfg", { updatedAt: 9 }), bare("u1"), bare("u2")]);
    const withoutCfg = groupProviders([bare("u1"), bare("u2")]);
    expect(withCfg.unconfigured.map((p) => p.id)).toEqual(withoutCfg.unconfigured.map((p) => p.id));
  });

  it("未配置的即使 updatedAt 最新也不参与排序（保持原序）", () => {
    const g = groupProviders([
      bare("u1", { updatedAt: 1 }),
      bare("u2", { updatedAt: 9999 }),
    ]);
    expect(g.unconfigured.map((p) => p.id)).toEqual(["u1", "u2"]);
  });
});

describe("真实场景：30 个内置目录 + 4 个已配置", () => {
  it("已配置的 4个聚在顶部，未配置的保持目录顺序", () => {
    const dir = Array.from({ length: 30 }, (_, i) => bare(`builtin-${i}`, { order: i + 1 }));
    const mine = [
      configured("deepseek", { updatedAt: 3000 }),
      configured("xiaomi-mimo", { updatedAt: 5000 }),
      configured("agnes-1", { updatedAt: 1000 }),
      configured("agnes-2", { updatedAt: 4000 }),
    ];
    const g = groupProviders([...dir, ...mine]);

    expect(g.configured).toHaveLength(4);
    expect(g.unconfigured).toHaveLength(30);
    // 最近改动排最上
    expect(g.configured.map((p) => p.id)).toEqual([
      "xiaomi-mimo", // 5000
      "agnes-2",      // 4000
      "deepseek",     // 3000
      "agnes-1",      // 1000
    ]);
    // 未配置组仍是原目录顺序
    expect(g.unconfigured[0].id).toBe("builtin-0");
    expect(g.unconfigured[29].id).toBe("builtin-29");
  });
});

// ══════════════════════════════════════════════════════════════
// 手动上移/下移（2026-10-08 修 bug：箭头点了没反应）
// ══════════════════════════════════════════════════════════════
describe("★ reorderWithinGroup —— 箭头必须真的能动", () => {
  /** 事故复现：显示顺序由 updatedAt 主导，只交换 order 的话点了没反应 */
  const build = () => ([
    configured("A", { order: 1, updatedAt: 300 }),
    configured("B", { order: 2, updatedAt: 200 }),
    configured("C", { order: 3, updatedAt: 100 }),
  ]);

  it("上移：位置真的换了（核心断言）", () => {
    const list = build();
    const next = reorderWithinGroup(list, "C", "up")!;
    expect(next.map((p) => p.id)).toEqual(["A", "C", "B"]);
  });

  it("★ 移动后按 groupProviders 重排，显示顺序与手动顺序一致", () => {
    // 这才是「点了有反应」的真实验证：渲染用的就是 groupProviders 的结果
    const list = build();
    const moved = reorderWithinGroup(list, "C", "up")!;
    const rendered = groupProviders(moved).configured.map((p) => p.id);
    expect(rendered).toEqual(["A", "C", "B"]);
  });

  it("旧实现（只交换 order）确实无效 —— 锁住这个回归", () => {
    const list = build();
    // 模拟旧行为：只交换 order，不动 updatedAt
    const old = [...list];
    const t = old[1].order; old[1].order = old[2].order; old[2].order = t;
    // 重新渲染后顺序没变 → 用户看到「点不了」
    expect(groupProviders(old).configured.map((p) => p.id)).toEqual(["A", "B", "C"]);
  });

  it("下移同样生效", () => {
    const next = reorderWithinGroup(build(), "A", "down")!;
    expect(next.map((p) => p.id)).toEqual(["B", "A", "C"]);
    expect(groupProviders(next).configured.map((p) => p.id)).toEqual(["B", "A", "C"]);
  });

  it("首项上移 / 末项下移返回 null（已在边界）", () => {
    const list = build();
    expect(reorderWithinGroup(list, "A", "up")).toBeNull();
    expect(reorderWithinGroup(list, "C", "down")).toBeNull();
  });

  it("不存在的 id 返回 null", () => {
    expect(reorderWithinGroup(build(), "Z", "up")).toBeNull();
  });

  it("不改动原数组（不可变）", () => {
    const list = build();
    const snapshot = list.map((p) => p.id);
    reorderWithinGroup(list, "C", "up");
    expect(list.map((p) => p.id)).toEqual(snapshot);
  });

  it("同步更新 order，保持 order 与显示一致", () => {
    const next = reorderWithinGroup(build(), "C", "up")!;
    const byId = new Map(next.map((p) => [p.id, p.order]));
    expect(byId.get("A")).toBe(1);
    expect(byId.get("C")).toBe(2);
    expect(byId.get("B")).toBe(3);
  });

  it("连续多次上移，逐步前移而非跳到最前", () => {
    let list = build();
    list = reorderWithinGroup(list, "C", "up")!;   // A C B
    list = reorderWithinGroup(list, "C", "up")!;   // C A B
    expect(groupProviders(list).configured.map((p) => p.id)).toEqual(["C", "A", "B"]);
  });
});
