/**
 * blueprint-plugins.test — 插件蓝图注册测试
 */

import { describe, it, expect } from "vitest";
import {
  buildPluginBlueprint,
  buildPluginBlueprints,
  listPluginBlueprints,
  mergeBlueprints,
  validateBlueprintSlots,
  createPluginBlueprintRegistry,
  addBlueprintToRegistry,
  PluginBlueprintError,
  type PluginManagerLike,
} from "./blueprint-plugins";
import type { AutomationBlueprint } from "./blueprint-catalog";

// ── 测试辅助 ──────────────────────────────────────────

function makeBlueprint(overrides: Partial<AutomationBlueprint> = {}): AutomationBlueprint {
  return {
    key: "test-blueprint",
    title: "Test Blueprint",
    description: "A test blueprint",
    category: "test",
    scheduleTemplate: "0 ${time:HH:MM} * * *",
    promptTemplate: "Do something at ${time:HH:MM}",
    slots: [
      { name: "time", type: "time", label: "Time", default: "09:00" },
    ],
    ...overrides,
  };
}

// ── buildPluginBlueprint ─────────────────────────────

describe("buildPluginBlueprint", () => {
  it("命名空间化 key 为 <plugin>:<key>", () => {
    const bp = buildPluginBlueprint("my-plugin", makeBlueprint({ key: "my-bp" }));
    expect(bp.key).toBe("my-plugin:my-bp");
  });

  it("标题添加插件前缀", () => {
    const bp = buildPluginBlueprint("my-plugin", makeBlueprint({ title: "My BP" }));
    expect(bp.title).toBe("[my-plugin] My BP");
  });

  it("添加 plugin tag", () => {
    const bp = buildPluginBlueprint("my-plugin", makeBlueprint({ tags: ["daily"] }));
    expect(bp.tags).toContain("plugin:my-plugin");
    expect(bp.tags).toContain("daily");
  });

  it("保留原始蓝图的其他字段", () => {
    const bp = buildPluginBlueprint("my-plugin", makeBlueprint());
    expect(bp.description).toBe("A test blueprint");
    expect(bp.category).toBe("test");
    expect(bp.scheduleTemplate).toBe("0 ${time:HH:MM} * * *");
    expect(bp.promptTemplate).toBe("Do something at ${time:HH:MM}");
    expect(bp.slots).toHaveLength(1);
  });

  it("插件名称为空时抛出错误", () => {
    expect(() => buildPluginBlueprint("", makeBlueprint())).toThrow(PluginBlueprintError);
    expect(() => buildPluginBlueprint("   ", makeBlueprint())).toThrow(PluginBlueprintError);
  });

  it("插件名称格式无效时抛出错误", () => {
    expect(() => buildPluginBlueprint("Invalid Name!", makeBlueprint())).toThrow(PluginBlueprintError);
    expect(() => buildPluginBlueprint("123invalid", makeBlueprint())).toThrow(PluginBlueprintError);
  });

  it("蓝图 key 为空时抛出错误", () => {
    expect(() => buildPluginBlueprint("my-plugin", makeBlueprint({ key: "" }))).toThrow(PluginBlueprintError);
  });

  it("蓝图 key 格式无效时抛出错误", () => {
    expect(() => buildPluginBlueprint("my-plugin", makeBlueprint({ key: "Invalid Key!" }))).toThrow(PluginBlueprintError);
  });

  it("标题为空时抛出错误", () => {
    expect(() => buildPluginBlueprint("my-plugin", makeBlueprint({ title: "" }))).toThrow(PluginBlueprintError);
  });

  it("scheduleTemplate 为空时抛出错误", () => {
    expect(() => buildPluginBlueprint("my-plugin", makeBlueprint({ scheduleTemplate: "" }))).toThrow(PluginBlueprintError);
  });

  it("promptTemplate 为空时抛出错误", () => {
    expect(() => buildPluginBlueprint("my-plugin", makeBlueprint({ promptTemplate: "" }))).toThrow(PluginBlueprintError);
  });

  it("slot 缺少 name 时抛出错误", () => {
    const bp = makeBlueprint({ slots: [{ name: "", type: "text", label: "Test" }] as any });
    expect(() => buildPluginBlueprint("my-plugin", bp)).toThrow(PluginBlueprintError);
  });

  it("slot 缺少 label 时抛出错误", () => {
    const bp = makeBlueprint({ slots: [{ name: "test", type: "text", label: "" }] as any });
    expect(() => buildPluginBlueprint("my-plugin", bp)).toThrow(PluginBlueprintError);
  });
});

// ── buildPluginBlueprints ───────────────────────────

describe("buildPluginBlueprints", () => {
  it("批量构建插件蓝图", () => {
    const bps = buildPluginBlueprints("my-plugin", [
      makeBlueprint({ key: "bp1" }),
      makeBlueprint({ key: "bp2" }),
    ]);
    expect(bps).toHaveLength(2);
    expect(bps[0].key).toBe("my-plugin:bp1");
    expect(bps[1].key).toBe("my-plugin:bp2");
  });

  it("空数组返回空数组", () => {
    expect(buildPluginBlueprints("my-plugin", [])).toEqual([]);
  });
});

// ── listPluginBlueprints ────────────────────────────

describe("listPluginBlueprints", () => {
  it("从插件管理器读取蓝图", () => {
    const mockManager: PluginManagerLike = {
      listPlugins: () => [
        { name: "plugin-a" },
        { name: "plugin-b" },
      ],
      getPluginBlueprints: (pluginName) => {
        if (pluginName === "plugin-a") return [makeBlueprint({ key: "bp1" })];
        if (pluginName === "plugin-b") return [makeBlueprint({ key: "bp2" })];
        return [];
      },
    };
    const result = listPluginBlueprints(mockManager);
    expect(result).toHaveLength(2);
    expect(result[0].key).toBe("plugin-a:bp1");
    expect(result[1].key).toBe("plugin-b:bp2");
  });

  it("插件没有蓝图时返回空数组", () => {
    const mockManager: PluginManagerLike = {
      listPlugins: () => [{ name: "empty-plugin" }],
      getPluginBlueprints: () => [],
    };
    expect(listPluginBlueprints(mockManager)).toEqual([]);
  });

  it("插件管理器没有 listPlugins 方法时使用 getPluginBlueprints 的空结果", () => {
    const mockManager: PluginManagerLike = {
      getPluginBlueprints: () => [],
    };
    expect(listPluginBlueprints(mockManager)).toEqual([]);
  });

  it("单个插件蓝图注册失败不影响其他插件", () => {
    const mockManager: PluginManagerLike = {
      listPlugins: () => [{ name: "good" }, { name: "bad" }],
      getPluginBlueprints: (pluginName) => {
        if (pluginName === "bad") throw new Error("Registration failed");
        return [makeBlueprint({ key: "bp1" })];
      },
    };
    const result = listPluginBlueprints(mockManager);
    expect(result).toHaveLength(1);
    expect(result[0].key).toBe("good:bp1");
  });
});

// ── mergeBlueprints ─────────────────────────────────

describe("mergeBlueprints", () => {
  it("合并内置和插件蓝图", () => {
    const builtin = [makeBlueprint({ key: "builtin-bp" })];
    const plugin = [makeBlueprint({ key: "plugin-bp" })];
    const merged = mergeBlueprints(builtin, plugin);
    expect(merged).toHaveLength(2);
    expect(merged[0].key).toBe("builtin-bp");
    expect(merged[1].key).toBe("plugin-bp");
  });

  it("内置蓝图优先（同名时插件被过滤）", () => {
    const builtin = [makeBlueprint({ key: "shared-bp" })];
    const plugin = [makeBlueprint({ key: "shared-bp" })];
    const merged = mergeBlueprints(builtin, plugin);
    expect(merged).toHaveLength(1);
    expect(merged[0].key).toBe("shared-bp");
  });

  it("空插件列表时只返回内置蓝图", () => {
    const builtin = [makeBlueprint({ key: "bp1" })];
    expect(mergeBlueprints(builtin, [])).toHaveLength(1);
  });

  it("空内置列表时只返回插件蓝图", () => {
    const plugin = [makeBlueprint({ key: "bp1" })];
    expect(mergeBlueprints([], plugin)).toHaveLength(1);
  });
});

// ── validateBlueprintSlots ──────────────────────────

describe("validateBlueprintSlots", () => {
  it("有效蓝图返回空错误列表", () => {
    const bp = makeBlueprint();
    const errors = validateBlueprintSlots(bp);
    expect(errors).toEqual([]);
  });

  it("无效 slot 类型返回错误", () => {
    const bp = makeBlueprint({
      slots: [{ name: "t", type: "invalid" as any, label: "Test" }],
      scheduleTemplate: "0 9 * * *",
    });
    const errors = validateBlueprintSlots(bp);
    expect(errors.length).toBe(1);
    expect(errors[0]).toContain("无效");
  });

  it("enum slot 缺少 options 返回错误", () => {
    const bp = makeBlueprint({
      slots: [{ name: "e", type: "enum", label: "Enum" }],
      scheduleTemplate: "0 9 * * *",
    });
    const errors = validateBlueprintSlots(bp);
    expect(errors.length).toBe(1);
    expect(errors[0]).toContain("options");
  });

  it("time slot 无 help 不报错（help 是可选的）", () => {
    const bp = makeBlueprint({
      slots: [{ name: "t", type: "time", label: "Time" }],
      scheduleTemplate: "0 9 * * *",
    });
    const errors = validateBlueprintSlots(bp);
    // help 是可选字段，不应报错
    expect(errors.length).toBe(0);
  });

  it("scheduleTemplate 引用未定义的 slot 返回错误", () => {
    const bp = makeBlueprint({
      scheduleTemplate: "0 ${undefined_slot:HH:MM} * * *",
    });
    const errors = validateBlueprintSlots(bp);
    expect(errors.length).toBe(1);
    expect(errors[0]).toContain("undefined_slot");
  });
});

// ── createPluginBlueprintRegistry / addBlueprintToRegistry ──

describe("createPluginBlueprintRegistry", () => {
  it("创建空注册表", () => {
    const reg = createPluginBlueprintRegistry("my-plugin", "1.0.0");
    expect(reg.pluginName).toBe("my-plugin");
    expect(reg.pluginVersion).toBe("1.0.0");
    expect(reg.blueprints).toEqual([]);
  });

  it("添加蓝图到注册表", () => {
    const reg = createPluginBlueprintRegistry("my-plugin");
    addBlueprintToRegistry(reg, makeBlueprint({ key: "bp1" }));
    expect(reg.blueprints).toHaveLength(1);
    expect(reg.blueprints[0].key).toBe("my-plugin:bp1");
  });
});

// ── PluginBlueprintError ─────────────────────────────

describe("PluginBlueprintError", () => {
  it("是一个 Error 子类", () => {
    const err = new PluginBlueprintError("test");
    expect(err).toBeInstanceOf(Error);
    expect(err.name).toBe("PluginBlueprintError");
  });
});
