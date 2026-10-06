import { describe, it, expect } from "vitest";
import {
  buildCapabilityCatalogLines,
  matchCapabilityTools,
  collectCreationTools,
} from "./tool-capability-catalog";

/** 真实工具名的一个代表性子集（含本次出问题的 email_add_account） */
const REAL_TOOLS = [
  "web_search", "web_fetch", "file_read", "file_create", "file_modify",
  "file_list", "file_delete", "shell_exec", "sequential_thinking",
  "browser_navigate", "browser_click", "browser_screenshot",
  "email_add_account", "email_send", "email_analyze", "email_summarize",
  "email_list_accounts", "email_list_inbox", "email_get_inbox_summary",
  "scheduler_create", "scheduler_list", "scheduler_delete",
  "skill_execute", "skill_install", "skill_find_and_install",
  "memory_store", "memory_search",
  "docx_create", "xlsx_create", "image_generate", "video_download",
  "codebase_search", "mcp_list_servers",
];

describe("tool-capability-catalog", () => {
  describe("matchCapabilityTools", () => {
    it("按正则匹配工具名", () => {
      const out = matchCapabilityTools(REAL_TOOLS, /^email_(add|create|register)/);
      expect(out).toEqual(["email_add_account"]);
    });

    it("limit 生效且不改原数组", () => {
      const copy = [...REAL_TOOLS];
      const out = matchCapabilityTools(REAL_TOOLS, /^file_/, 2);
      expect(out).toEqual(["file_read", "file_create"]);
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

    it("★ 回归：email_add_account 必须出现在能力速查表中", () => {
      const lines = buildCapabilityCatalogLines(REAL_TOOLS);
      const joined = lines.join("\n");
      expect(joined).toContain("email_add_account");
      // 且必须挂在「添加/配置/注册邮箱账户」这个意图下
      expect(joined).toMatch(/添加\/配置\/注册邮箱账户.*email_add_account/);
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
      const lines = buildCapabilityCatalogLines(["web_search", "email_add_account"]);
      const joined = lines.join("\n");
      expect(joined).not.toContain("email_send");
      expect(joined).not.toContain("browser_navigate");
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
      expect(line).not.toContain("email_add_account");
    });

    it("创建类工具全部被意图规则覆盖时不输出汇总行", () => {
      const lines = buildCapabilityCatalogLines(REAL_TOOLS);
      expect(lines.some((l) => l.includes("其它「新建/添加/注册」类操作"))).toBe(false);
    });
  });

  describe("collectCreationTools", () => {
    it("识别 add/create/register/install 特征（含词中位置，如 email_add_account）", () => {
      const out = collectCreationTools(REAL_TOOLS);
      expect(out).toContain("email_add_account");
      expect(out).toContain("file_create");
      expect(out).toContain("scheduler_create");
      expect(out).not.toContain("web_search");
      expect(out).not.toContain("email_send");
    });

    it("尊重 limit", () => {
      expect(collectCreationTools(REAL_TOOLS, 2)).toHaveLength(2);
    });
  });
});
