import { describe, it, expect } from "vitest";
import { buildAgentSystemPrompt, buildCompactSkillsPrompt } from "./system-prompt";

const base = {
  promptMode: "full" as const,
  personaName: "EvoClaw",
  personaTitle: "Assistant",
  masterTerm: "主人",
  personaTone: "warm",
  registeredToolNames: [
    "email_add_account", "email_send", "email_list_accounts",
    "web_search", "web_fetch", "file_read", "file_create", "shell_exec",
  ],
};

const build = (over: Partial<typeof base> = {}) => buildAgentSystemPrompt({ ...base, ...over });

describe("buildAgentSystemPrompt — 基本结构", () => {
  it("full 模式产出非空提示词并包含核心章节", () => {
    const p = build();
    expect(p.length).toBeGreaterThan(1000);
    expect(p).toContain("## Tooling");
    expect(p).toContain("## 真实性契约");
    expect(p).toContain("## Execution Strategy (MANDATORY)");
  });

  it("promptMode=none 只返回最小身份句", () => {
    const p = build({ promptMode: "none" });
    expect(p).toBe("You are EvoClaw, the Assistant.");
    expect(p).not.toContain("## Tooling");
  });

  it("minimal 模式仍保留最高优先级的真实性契约与任务定位纪律", () => {
    const p = build({ promptMode: "minimal" });
    expect(p).toContain("## 真实性契约");
    // 这两节是行为底线，minimal 也不能丢
    expect(p).toContain("## 接到任务先定位，再动手");
  });
});

describe("能力速查表 —— 必须由真实工具名生成（回归）", () => {
  // 历史事故：清单曾被平铺成一行 90+ 个名字，弱模型必然漏看单项，
  // 遂断言「系统没有这个工具」并臆造出「需要改配置文件」这类不存在的限制。
  it("★ 注入结构化速查表，且创建类工具被单独高亮", () => {
    const p = build();
    expect(p).toContain("能力速查表");
    expect(p).toContain("email_add_account");
    expect(p).toMatch(/新建\/添加\/注册|添加\/配置\/注册/);
  });

  it("★ 不再把全部工具平铺成一行（用真实规模 120 个工具验证）", () => {
    // 历史事故：清单曾渲染成 `Available tools: a, b, c, ...`（一行 90+ 个名字）。
    // 短列表测不出来，必须用接近真实的工具规模（实际注册 127 个）才有效。
    const many = Array.from({ length: 120 }, (_, i) => `tool_${i}_do`);
    const p = buildAgentSystemPrompt({ ...base, registeredToolNames: many });
    const worstLine = p
      .split("\n")
      .reduce((max, line) => Math.max(max, many.filter((n) => line.includes(n)).length), 0);
    expect(worstLine, `某一行仍平铺了 ${worstLine} 个工具名`).toBeLessThan(10);
  });
});

describe("真实性契约 —— 不得被后续改动削弱（回归）", () => {
  it("★ 七条契约全部在位", () => {
    const p = build();
    expect(p).toContain("动手前不要预告成功");
    expect(p).toContain("只报告工具的真实结果");
    expect(p).toContain("我不知道有这个能力 / 系统没有这个工具");
    expect(p).toContain("需要多步才能完成的任务");
    expect(p).toContain("宁可如实说");
    expect(p).toContain("严禁在回复中回显用户提供的密码");
    // 第 7 条：2026-10-07 重写为「同轮内执行到底、出错自己修正后接着跑」
    expect(p).toContain("在同一轮内把剩余步骤执行到底");
  });

  it("★ 第 7 条点名禁止「停下来等继续」的话术", () => {
    const p = build();
    expect(p).toContain("你回个继续我就开工");
    expect(p).toContain("要不要我继续");
  });
});

describe("任务定位纪律 —— 位置与反冲突声明（回归）", () => {
  // 历史事故：0.86.x 反复出现「提示词自相矛盾」——
  // 一处要求「先输出五项再动手」，另一处要求「不要停下来问用户」，
  // 模型被夹在中间，输出五项后就停下等用户点头。
  it("★ 六条要点齐全", () => {
    const p = build();
    for (const s of [
      "澄清四件事",
      "先自查后提问",
      "歧义处理",
      "复杂任务",
      "简单任务",
      "修 Bug 先找根因",
    ]) {
      expect(p, `缺少要点「${s}」`).toContain(s);
    }
  });

  it("★ 必须排在 Execution Strategy 之前（先定位，再选方法执行）", () => {
    const p = build();
    const orient = p.indexOf("## 接到任务先定位，再动手");
    const exec = p.indexOf("## Execution Strategy (MANDATORY)");
    expect(orient).toBeGreaterThan(-1);
    expect(exec).toBeGreaterThan(-1);
    expect(orient, "任务定位必须在 Execution Strategy 之前").toBeLessThan(exec);
  });

  it("★ 必须带反冲突声明：输出五项后立刻继续执行，不是等用户点头", () => {
    const p = build();
    expect(p).toContain("立刻继续执行");
    expect(p).toContain("不是发出五项然后等用户点头");
    // 唯一允许停顿的三类例外要说清楚
    expect(p).toContain("核心歧义");
    expect(p).toContain("需要人工审批");
  });

  it("★ 不为了走流程而牺牲「简单任务直接执行」", () => {
    const p = build();
    expect(p).toContain("需求明确直接执行，不为走流程而机械提问");
  });
});

describe("buildCompactSkillsPrompt — 压缩模式保持精简", () => {
  it("接受技能数组并产出压缩提示词", () => {
    const p = buildCompactSkillsPrompt([
      { name: "cicc-news", description: "抓取财新新闻", location: "skills/cicc-news/SKILL.md" },
      { name: "translate", description: "翻译工具", location: "skills/translate/SKILL.md" },
    ]);
    expect(p).toContain("cicc-news");
    expect(p).toContain("skills/translate/SKILL.md");
    // 压缩提示词不得比完整提示词还长
    expect(p.length).toBeLessThan(build().length);
  });

  it("空技能列表不抛异常", () => {
    expect(() => buildCompactSkillsPrompt([])).not.toThrow();
  });
});