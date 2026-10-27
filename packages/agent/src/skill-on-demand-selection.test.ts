/**
 * P0-5 skill 按需选择（Fix F）：已安装 skill > 阈值时只注入相关性选中的
 * top-K + 最近使用 top-3（上限 ~12），选择结果按 sessionId 粘性缓存。
 *
 * 覆盖：
 * - >30 skills 时 prompt 只含选中子集（≤12）
 * - ≤30 skills 时全量（不过滤，向后兼容）
 * - 会话粘性：同 topic 重复调用不重算（选择缓存 entry 不变）
 * - 话题切换信号：top-1 命中不在已选集合且 relevanceScore ≥ 0.3 → 重算
 * - skill 集合变化且新装 skill 命中当前 topic → 重算
 */
import { describe, it, expect } from "vitest";
import { ServiceRegistry, EventBus } from "@evoclaw/core";
import { AgentModelExecutor } from "./agent-model-executor";

interface FakeIndexEntry {
  name: string;
  useCount: number;
  lastUsedAt: number | null;
}

/** 可控 SkillIndex：按 topic 返回预置搜索结果 */
function createFakeIndex(allSkills: string[], topics: Record<string, Array<{ name: string; score: number }>>) {
  const entries: FakeIndexEntry[] = allSkills.map((name) => ({ name, useCount: 0, lastUsedAt: null }));
  return {
    search(query: string, _limit?: number) {
      const topic = Object.keys(topics).find((t) => query.includes(t));
      const results = topic ? topics[topic] : [];
      return results.map((r) => ({ entry: { name: r.name }, relevanceScore: r.score }));
    },
    getAll() {
      return entries;
    },
  };
}

function createExecutor(
  skillCount: number,
  topics: Record<string, Array<{ name: string; score: number }>> = {},
): { executor: AgentModelExecutor; skillManager: { listSkills: () => Promise<unknown[]> } } {
  const registry = new ServiceRegistry();
  const eventBus = new EventBus();
  const allNames: string[] = [];
  for (let i = 0; i < skillCount; i++) allNames.push(`skill-${i}`);
  const skillManager = {
    listSkills: async () =>
      allNames.map((name, i) => ({
        id: `s${i}`,
        name,
        description: `description of ${name}`,
        installPath: `skills/${name}/SKILL.md`,
      })),
  };
  registry.registerService("skillManager", skillManager);
  registry.registerService("skillIndex", createFakeIndex(allNames, topics));
  const executor = new AgentModelExecutor(registry, eventBus);
  return { executor, skillManager };
}

/** 从 prompt 中提取选中的 skill 名（<name> 标签） */
function selectedNames(prompt: string): string[] {
  return [...prompt.matchAll(/<name>([^<]+)<\/name>/g)].map((m) => m[1]);
}

describe("P0-5 skill 按需选择（Fix F）", () => {
  it("≤30 skills：全量注入（不过滤，向后兼容）", async () => {
    const { executor } = createExecutor(25);
    const prompt = await executor.buildSkillsPromptForRun(undefined, "hello", "sess-small");
    expect(selectedNames(prompt)).toHaveLength(25);
  });

  it(">30 skills：只注入选中子集（≤12），未选中的不可见", async () => {
    const { executor } = createExecutor(50, {
      alpha: [{ name: "skill-10", score: 10 }, { name: "skill-11", score: 8 }, { name: "skill-12", score: 6 }],
    });
    const prompt = await executor.buildSkillsPromptForRun(undefined, "alpha topic", "sess-big");
    const names = selectedNames(prompt);
    expect(names.length).toBeLessThanOrEqual(12);
    expect(names).toContain("skill-10");
    expect(names).toContain("skill-11");
    // 未命中的 skill 不在 prompt 中（skill-49/48 不在相关性 top-K 也不在 recent top-3）
    expect(names).not.toContain("skill-49");
    expect(names).not.toContain("skill-48");
  });

  it("会话粘性：同 topic 重复调用不重算（选择缓存 entry 不变）", async () => {
    const { executor } = createExecutor(50, {
      alpha: [{ name: "skill-10", score: 10 }],
    });
    await executor.buildSkillsPromptForRun(undefined, "alpha topic", "sess-sticky");
    const entry1 = (executor as unknown as {
      _skillSelectionBySession: Map<string, { names: string[]; topicHash: string }>;
    })._skillSelectionBySession.get("sess-sticky");
    const prompt2 = await executor.buildSkillsPromptForRun(undefined, "alpha topic again", "sess-sticky");
    const entry2 = (executor as unknown as {
      _skillSelectionBySession: Map<string, { names: string[]; topicHash: string }>;
    })._skillSelectionBySession.get("sess-sticky");
    expect(entry2!.topicHash).toBe(entry1!.topicHash);
    expect(entry2!.names).toEqual(entry1!.names);
    expect(prompt2).toContain("skill-10");
  });

  it("话题切换信号：top-1 命中不在已选集合且 score ≥ 0.3 → 重算", async () => {
    const { executor } = createExecutor(50, {
      alpha: [{ name: "skill-10", score: 10 }],
      beta: [{ name: "skill-20", score: 5 }],
    });
    await executor.buildSkillsPromptForRun(undefined, "alpha topic", "sess-switch");
    const entry1 = (executor as unknown as {
      _skillSelectionBySession: Map<string, { names: string[]; topicHash: string }>;
    })._skillSelectionBySession.get("sess-switch");
    expect(entry1!.topicHash).toBe("skill-10");

    // beta topic：top-1 = skill-20（不在已选集合，score 5 ≥ 0.3）→ 重算
    const prompt2 = await executor.buildSkillsPromptForRun(undefined, "beta topic", "sess-switch");
    const entry2 = (executor as unknown as {
      _skillSelectionBySession: Map<string, { names: string[]; topicHash: string }>;
    })._skillSelectionBySession.get("sess-switch");
    expect(entry2!.topicHash).toBe("skill-20");
    expect(selectedNames(prompt2)).toContain("skill-20");
  });

  it("低相关话题切换（score < 0.3）不触发重算（保持粘性）", async () => {
    const { executor } = createExecutor(50, {
      alpha: [{ name: "skill-10", score: 10 }],
      beta: [{ name: "skill-20", score: 0.1 }],
    });
    await executor.buildSkillsPromptForRun(undefined, "alpha topic", "sess-low");
    const entry1 = (executor as unknown as {
      _skillSelectionBySession: Map<string, { names: string[]; topicHash: string }>;
    })._skillSelectionBySession.get("sess-low");
    await executor.buildSkillsPromptForRun(undefined, "beta topic", "sess-low");
    const entry2 = (executor as unknown as {
      _skillSelectionBySession: Map<string, { names: string[]; topicHash: string }>;
    })._skillSelectionBySession.get("sess-low");
    expect(entry2!.topicHash).toBe(entry1!.topicHash);
  });

  it("不同 session 的选择互不干扰", async () => {
    const { executor } = createExecutor(50, {
      alpha: [{ name: "skill-10", score: 10 }],
      beta: [{ name: "skill-20", score: 10 }],
    });
    const pA = await executor.buildSkillsPromptForRun(undefined, "alpha topic", "sess-a");
    const pB = await executor.buildSkillsPromptForRun(undefined, "beta topic", "sess-b");
    expect(selectedNames(pA)).toContain("skill-10");
    expect(selectedNames(pA)).not.toContain("skill-20");
    expect(selectedNames(pB)).toContain("skill-20");
    expect(selectedNames(pB)).not.toContain("skill-10");
  });

  it("无 SkillIndex：安全兜底全量（不过滤）", async () => {
    const registry = new ServiceRegistry();
    const eventBus = new EventBus();
    const skillManager = {
      listSkills: async () =>
        Array.from({ length: 40 }, (_, i) => ({
          id: `s${i}`,
          name: `skill-${i}`,
          description: `desc ${i}`,
          installPath: `skills/skill-${i}/SKILL.md`,
        })),
    };
    registry.registerService("skillManager", skillManager);
    const executor = new AgentModelExecutor(registry, eventBus);
    const prompt = await executor.buildSkillsPromptForRun(undefined, "any topic", "sess-noindex");
    expect(selectedNames(prompt)).toHaveLength(40);
  });
});
