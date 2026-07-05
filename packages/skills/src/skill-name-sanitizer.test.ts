import { describe, it, expect } from "vitest";
import { sanitizeSkillName, isSanitizedName, deriveSkillName } from "./skill-name-sanitizer";

describe("sanitizeSkillName", () => {
  it("lowercase", () => {
    expect(sanitizeSkillName("PDF-Extraction")).toBe("pdf-extraction");
  });

  it("空格转 -", () => {
    expect(sanitizeSkillName("pdf extraction")).toBe("pdf-extraction");
  });

  it("下划线转 -", () => {
    expect(sanitizeSkillName("pdf_extraction")).toBe("pdf-extraction");
  });

  it("特殊字符转 -", () => {
    expect(sanitizeSkillName("pdf@extraction#fallback")).toBe("pdf-extraction-fallback");
  });

  it("折叠多 -", () => {
    expect(sanitizeSkillName("pdf---extraction")).toBe("pdf-extraction");
  });

  it("去除首尾 -", () => {
    expect(sanitizeSkillName("---pdf-extraction---")).toBe("pdf-extraction");
  });

  it("空输入", () => {
    expect(sanitizeSkillName("")).toBe("");
    expect(sanitizeSkillName("   ")).toBe("");
  });

  it("长度限制（50 字符）+ 单词边界截断", () => {
    const long = "a".repeat(60);
    const result = sanitizeSkillName(long);
    expect(result.length).toBeLessThanOrEqual(50);
  });

  it("长名称在单词边界截断", () => {
    // 50 字符内有 -，应在 - 处截断
    const long = "pdf-extraction-fallback-enhanced-merged-abc123-xyz";
    const result = sanitizeSkillName(long);
    expect(result.length).toBeLessThanOrEqual(50);
    // 应该在某个 - 处截断（不以 - 结尾）
    expect(result.endsWith("-")).toBe(false);
  });

  it("长链派生名不超长", () => {
    const long = "panel-enhanced-enhanced-merged-abc123-xyz-def456-uvw789-rst012";
    const result = sanitizeSkillName(long);
    expect(result.length).toBeLessThanOrEqual(50);
  });
});

describe("isSanitizedName", () => {
  it("合法名称", () => {
    expect(isSanitizedName("pdf-extraction")).toBe(true);
    expect(isSanitizedName("pdf-extraction-fallback")).toBe(true);
    expect(isSanitizedName("abc123")).toBe(true);
  });

  it("非法：含大写", () => {
    expect(isSanitizedName("PDF-Extraction")).toBe(false);
  });

  it("非法：含下划线", () => {
    expect(isSanitizedName("pdf_extraction")).toBe(false);
  });

  it("非法：含空格", () => {
    expect(isSanitizedName("pdf extraction")).toBe(false);
  });

  it("非法：超长", () => {
    expect(isSanitizedName("a".repeat(51))).toBe(false);
  });
});

describe("deriveSkillName", () => {
  it("基础名 + 后缀", () => {
    expect(deriveSkillName("pdf-extraction", "enhanced")).toBe("pdf-extraction-enhanced");
  });

  it("超长时截断 base", () => {
    const longBase = "a".repeat(60);
    const result = deriveSkillName(longBase, "suffix");
    expect(result.length).toBeLessThanOrEqual(50);
    expect(result.endsWith("-suffix")).toBe(true);
  });

  it("空 base 返回 suffix", () => {
    expect(deriveSkillName("", "suffix")).toBe("suffix");
  });

  it("空 suffix 返回 base", () => {
    expect(deriveSkillName("base", "")).toBe("base");
  });
});
