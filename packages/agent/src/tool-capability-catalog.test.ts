import { describe, it, expect } from "vitest";
import {
  buildCapabilityCatalogLines,
  matchCapabilityTools,
  collectCreationTools,
} from "./tool-capability-catalog";

/**
 * 真实工具名的一个代表性子集。
 *
 * ★ 复合工具改造后：邮箱 9 个细粒度工具 → `email`；定时任务 7 个 → `scheduler`；
 *   技能 7 个 → `skill_manage` / `skill_list`；文档 3 个 → `document`；
 *   Git 9 个 → `git`；代码检索 2 个 → `code_search`；补丁/重命名 2 个 → `apply_patch`。
 * 速查表按**工具名**正则匹配，因此合并后每组只输出一个名字——这正是本文件
 * 要防住的回归：模型看到 `email_add_account` 不在列表里就以为「没有添加邮箱的能力」，
 * 现在必须看到 `email` 并知道它有 add_account 这个 action。
 */
const REAL_TOOLS = [
  "web_search", "web_fetch",
  "file_read", "file_write", "file_list", "file_delete",
  "shell_exec", "execute_code", "sequential_thinking",
  "browser_navigate", "browser_act", "browser_screenshot",
  "email",
  "scheduler",
  "skill_manage", "skill_list",
  "memory",
  "document",
  "image_generate", "video", "music",
  "git", "code_search", "apply_patch",
  "kanban", "dev_check",
  "vision_analyze",
];

describe("tool-capability-catalog", () => {
  describe("matchCapabilityTools", () => {
    it("按正则匹配工具名（合并后命中复合工具名本身）", () => {
      const out = matchCapabilityTools(REAL_TOOLS, /^email(_|$)/);
      expect(out).toEqual(["email"]);
    });

    it("limit 生效且不改原数组", () => {
      const copy = [...REAL_TOOLS];
      const out = matchCapabilityTools(REAL_TOOLS, /^file_/, 2);
      expect(out).toEqual(["file_read", "file_write"]);
      expect(REAL_TOOLS).toEqual(copy);
    });

    it("limit 为 0 或负数时返回全部匹配（视为不限制）", () => {
      expect(matchCapabilityTools(REAL_TOOLS, /^file_/, 0)).toHaveLength(REAL_TOOLS.filter(t => t.startsWith("file_")).length);
    });
  });

  describe("buildCapabilityCatalogLines", () => {
    it("空输入返回空数组", () => {
      expect(buildCapabilityCatalogLines([])).toEqual([]);
    });

    it("非数组输入安全返回空", () => {
      expect(buildCapabilityCatalogLines(undefined as unknown as string[])).toEqual([]);
    });

    it("★ 回归：email 必须出现在能力速查表中，且挂在邮箱意图下", () => {
      const lines = buildCapabilityCatalogLines(REAL_TOOLS);
      const joined = lines.join("\n");
      // 合并前这里断言的是 email_add_account；合并后同一个能力由 email 承担
      expect(joined).toContain("`email`");
      const emailLine = lines.find((l) => l.includes("邮箱"));
      expect(emailLine).toBeDefined();
      expect(emailLine).toContain("`email`");
      // 速查表是「意图 → 工具名」，不得再把已删除的细粒度名写回来
      expect(joined).not.toContain("`email_add_account`");
      expect(joined).not.toContain("`email_send`");
    });

    it("★ 回归：合并后的复合工具都在速查表中", () => {
      const joined = buildCapabilityCatalogLines(REAL_TOOLS).join("\n");
      for (const name of ["email", "scheduler", "skill_manage", "document", "git", "kanban", "file_write", "apply_patch"]) {
        expect(joined, `缺少复合工具 ${name}`).toContain(`\`${name}\``);
      }
    });

    it("每个工具至多出现在一条意图行中（不重复）", () => {
      const lines = buildCapabilityCatalogLines(REAL_TOOLS);
      const allNames = REAL_TOOLS.filter((t) => lines.some((l) => l.includes(`\`${t}\``)));
      for (const name of allNames) {
        const hits = lines.filter((l) => l.includes(`\`${name}\``));
        expect(hits.length, `工具 ${name} 重复出现`).toBe(1);
      }
    });

    it("不输出未在输入中登记的工具名（防止提示词出现幻觉工具）", () => {
      const lines = buildCapabilityCatalogLines(["web_search", "email"]);
      const joined = lines.join("\n");
      expect(joined).not.toContain("`email_send`");
      expect(joined).not.toContain("`browser_navigate`");
    });

    it("只有无法归类且非创建类工具时返回空数组", () => {
      expect(buildCapabilityCatalogLines(["totally_unknown_tool"])).toEqual([]);
    });

    it("未被意图规则覆盖的创建类工具才进入汇总行（避免重复）", () => {
      // invoice_create / contact_new 不匹配任何意图规则 → 应出现在汇总行
      const lines = buildCapabilityCatalogLines([...REAL_TOOLS, "invoice_create", "contact_new"]);
      const line = lines.find((l) => l.includes("其它「新建/添加/注册」类操作"));
      expect(line).toBeDefined();
      expect(line).toContain("invoice_create");
      expect(line).toContain("contact_new");
      // 已被意图规则覆盖的不重复出现
      expect(line).not.toContain("`email`");
      expect(line).not.toContain("`file_write`");
    });

    it("创建类工具全部被意图规则覆盖时不输出汇总行", () => {
      const lines = buildCapabilityCatalogLines(REAL_TOOLS);
      expect(lines.some((l) => l.includes("其它「新建/添加/注册」类操作"))).toBe(false);
    });
  });

  describe("collectCreationTools", () => {
    it("识别 add/create/register/install 特征（含词中位置，如 invoice_create）", () => {
      const out = collectCreationTools([...REAL_TOOLS, "invoice_create", "contact_new"]);
      expect(out).toContain("invoice_create");
      expect(out).toContain("contact_new");
      expect(out).not.toContain("web_search");
      expect(out).not.toContain("file_read");
    });

    it("合并后的复合工具必须被显式列入白名单（名字里没有 create/add 也要认）", () => {
      // file_write / email / scheduler / skill_manage / document / git / kanban
      // 都匹配不到 CREATION_PATTERN，但确实具备「新建/添加」能力；
      // 而 isCreationTool 同时是工具下发裁剪的白名单——漏一个，模型就少一项能力。
      const out = collectCreationTools(REAL_TOOLS);
      expect(out).toContain("file_write");
      expect(out).toContain("email");
      expect(out).toContain("scheduler");
      expect(out).toContain("skill_manage");
      expect(out).toContain("document");
      expect(out).toContain("git");
      expect(out).toContain("kanban");
    });

    it("尊重 limit", () => {
      expect(collectCreationTools(REAL_TOOLS, 2)).toHaveLength(2);
    });
  });
});

describe("buildCapabilityCatalogLines — 可读性折行（回归）", () => {
  // 真实数据：browser_* 前缀天然命中 14 个工具名，全挤在一行。
  // 一行十几个名字 = 回到「模型必然漏看单项」的老问题。
  const many = Array.from({ length: 14 }, (_, i) => `browser_tool_${i}`);

  // 注意：统计必须数「反引号包裹的完整名字」，用 includes 会被子串误伤
  // （browser_tool_1 是 browser_tool_11 的子串，会多数一个）
  const countNames = (line: string) => (line.match(/`[^`]+`/g) || []).length;

  it("★ 工具数超过阈值时自动折行，单行不超过 3 个", () => {
    const lines = buildCapabilityCatalogLines(many);
    const worst = lines.reduce((m, l) => Math.max(m, countNames(l)), 0);
    expect(worst).toBeLessThanOrEqual(3);
  });

  it("★ 折行后总行数变多，但意图标题仍在", () => {
    const lines = buildCapabilityCatalogLines(many);
    expect(lines.length).toBeGreaterThan(1);
    expect(lines[0]).toMatch(/^- .*（共 14 个）：$/);
  });

  it("★ 工具数少时仍保持单行（不要无谓折行）", () => {
    const lines = buildCapabilityCatalogLines(["email", "web_search"]);
    expect(lines.every((l) => l.startsWith("- ") && !l.includes("共"))).toBe(true);
  });

  it("折行不丢工具（全部可从输出中找回）", () => {
    const lines = buildCapabilityCatalogLines(many);
    const joined = lines.join("\n");
    for (const t of many) expect(joined, `丢失了 ${t}`).toContain(t);
  });
});
