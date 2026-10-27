import { describe, it, expect } from "vitest";
import {
  isNonCodePath,
  filterVerifiablePaths,
  hasFileMutation,
  hasVerificationIntent,
  replyContainsVerificationEvidence,
  buildVerifyOnStopNudge,
  shouldTriggerVerificationGate,
  extractChangedPaths,
  FILE_MUTATING_TOOLS,
} from "./verification-stop";

describe("isNonCodePath", () => {
  it("识别纯文档扩展名", () => {
    expect(isNonCodePath("README.md")).toBe(true);
    expect(isNonCodePath("docs/design.md")).toBe(true);
    expect(isNonCodePath("data.csv")).toBe(true);
    expect(isNonCodePath("log.txt")).toBe(true);
    expect(isNonCodePath("config.json")).toBe(true);
  });

  it("识别可验证文件", () => {
    expect(isNonCodePath("src/index.ts")).toBe(false);
    expect(isNonCodePath("script.py")).toBe(false);
    expect(isNonCodePath("report.docx")).toBe(false);
    expect(isNonCodePath("data.xlsx")).toBe(false);
    expect(isNonCodePath("slides.pptx")).toBe(false);
  });

  it("识别纯文档文件名（无扩展名）", () => {
    expect(isNonCodePath("LICENSE")).toBe(true);
    expect(isNonCodePath("CHANGELOG")).toBe(true);
    expect(isNonCodePath("README")).toBe(true);
  });
});

describe("filterVerifiablePaths", () => {
  it("过滤掉纯文档路径", () => {
    const result = filterVerifiablePaths([
      "src/index.ts",
      "README.md",
      "report.docx",
      "config.json",
    ]);
    expect(result).toEqual(["src/index.ts", "report.docx"]);
  });

  it("空输入返回空数组", () => {
    expect(filterVerifiablePaths([])).toEqual([]);
  });

  it("去重", () => {
    const result = filterVerifiablePaths(["a.ts", "a.ts", "b.py"]);
    expect(result).toEqual(["a.ts", "b.py"]);
  });
});

describe("hasFileMutation", () => {
  it("检测到文件写工具（含合并后的复合工具）", () => {
    // 原 file_create / file_modify 合并为 file_write；原 docx_create 并入 document。
    // 该函数只按工具名匹配，action 由调用方在 toolName 之外另行判定。
    expect(hasFileMutation(["file_write", "shell_exec"])).toBe(true);
    expect(hasFileMutation(["document"])).toBe(true);
    expect(hasFileMutation(["file_delete"])).toBe(true);
  });

  it("未检测到文件写工具", () => {
    expect(hasFileMutation(["shell_exec", "file_read"])).toBe(false);
    expect(hasFileMutation([])).toBe(false);
  });
});

describe("FILE_MUTATING_TOOLS 覆盖合并后的复合工具", () => {
  it("file_write 与 document 都在变更类白名单里", () => {
    // 合并后细粒度工具名（file_create / file_modify / docx_create / xlsx_create /
    // pptx_create）已不存在，若白名单仍只列旧名，验证门会对新工具完全失明
    expect(FILE_MUTATING_TOOLS.has("file_write")).toBe(true);
    expect(FILE_MUTATING_TOOLS.has("file_delete")).toBe(true);
    expect(FILE_MUTATING_TOOLS.has("document")).toBe(true);
  });
});

describe("hasVerificationIntent", () => {
  it("检测到验证类工具", () => {
    expect(hasVerificationIntent(["file_read"])).toBe(true);
    expect(hasVerificationIntent(["shell_exec"])).toBe(true);
    expect(hasVerificationIntent(["execute_code"])).toBe(true);
  });

  it("未检测到验证类工具", () => {
    // file_write / document 是变更类工具，不算验证意图
    expect(hasVerificationIntent(["file_write"])).toBe(false);
    expect(hasVerificationIntent(["document"])).toBe(false);
    expect(hasVerificationIntent([])).toBe(false);
  });
});

describe("replyContainsVerificationEvidence", () => {
  it("识别中文验证证据", () => {
    expect(replyContainsVerificationEvidence("已验证，文件内容正确")).toBe(true);
    expect(replyContainsVerificationEvidence("解包验证通过，表格数=1")).toBe(true);
    expect(replyContainsVerificationEvidence("运行测试，全部通过")).toBe(true);
  });

  it("识别英文验证证据", () => {
    expect(replyContainsVerificationEvidence("verified successfully")).toBe(true);
    expect(replyContainsVerificationEvidence("tests passed")).toBe(true);
  });

  it("不把无验证证据的回复判为有证据", () => {
    expect(replyContainsVerificationEvidence("文件已创建完成")).toBe(false);
    expect(replyContainsVerificationEvidence("Done.")).toBe(false);
    expect(replyContainsVerificationEvidence("")).toBe(false);
  });
});

describe("buildVerifyOnStopNudge", () => {
  it("有可验证路径时返回 nudge", () => {
    const nudge = buildVerifyOnStopNudge(["src/index.ts", "report.docx"], 0);
    expect(nudge).not.toBeNull();
    expect(nudge).toContain("验证门");
    expect(nudge).toContain("src/index.ts");
    expect(nudge).toContain("report.docx");
  });

  it("纯文档路径全部被过滤时返回 null", () => {
    const nudge = buildVerifyOnStopNudge(["README.md", "CHANGELOG"], 0);
    expect(nudge).toBeNull();
  });

  it("达到最大 nudge 次数后返回 null", () => {
    const nudge = buildVerifyOnStopNudge(["src/index.ts"], 2);
    expect(nudge).toBeNull();
  });

  it("空路径返回 null", () => {
    expect(buildVerifyOnStopNudge([], 0)).toBeNull();
  });

  it("nudge 包含验证指引", () => {
    const nudge = buildVerifyOnStopNudge(["report.docx"], 0);
    expect(nudge).toContain("读取");
    expect(nudge).toContain("验证");
  });
});

describe("shouldTriggerVerificationGate", () => {
  it("变更可验证文件后未验证 → 触发", () => {
    expect(
      shouldTriggerVerificationGate(
        ["report.docx"],
        ["file_write", "document"],
        "文件已创建完成",
        0,
      ),
    ).toBe(true);
  });

  it("已调用验证工具 → 不触发", () => {
    expect(
      shouldTriggerVerificationGate(
        ["report.docx"],
        ["file_write", "file_read"],
        "文件已创建完成",
        0,
      ),
    ).toBe(false);
  });

  it("回复含验证证据 → 不触发", () => {
    expect(
      shouldTriggerVerificationGate(
        ["report.docx"],
        ["file_write"],
        "已验证，解包验证通过",
        0,
      ),
    ).toBe(false);
  });

  it("无变更类工具 → 不触发", () => {
    expect(
      shouldTriggerVerificationGate(
        ["report.docx"],
        ["shell_exec", "file_read"],
        "已完成",
        0,
      ),
    ).toBe(false);
  });

  it("只变更纯文档文件（无可验证对象）→ 不触发", () => {
    expect(
      shouldTriggerVerificationGate(
        ["README.md", "config.json"],
        ["file_write"],
        "文件已创建完成",
        0,
      ),
    ).toBe(false);
  });

  it("空变更路径 → 不触发", () => {
    expect(
      shouldTriggerVerificationGate(
        [],
        ["file_write"],
        "文件已创建完成",
        0,
      ),
    ).toBe(false);
  });

  it("达到最大次数 → 不触发", () => {
    expect(
      shouldTriggerVerificationGate(
        ["report.docx"],
        ["file_write"],
        "文件已创建完成",
        2,
      ),
    ).toBe(false);
  });

  it("显式禁用 → 不触发", () => {
    expect(
      shouldTriggerVerificationGate(
        ["report.docx"],
        ["file_write"],
        "文件已创建完成",
        0,
        { enabled: false },
      ),
    ).toBe(false);
  });
});

describe("extractChangedPaths", () => {
  it("从 file_write 参数提取路径", () => {
    const paths = extractChangedPaths([
      { name: "file_write", arguments: { action: "create", path: "data/test.txt" } },
    ]);
    expect(paths).toEqual(["data/test.txt"]);
  });

  it("从多个工具提取路径（含 document 复合工具）", () => {
    const paths = extractChangedPaths([
      { name: "file_write", arguments: { action: "create", path: "a.docx" } },
      { name: "document", arguments: { action: "create_docx", path: "b.docx" } },
      { name: "shell_exec", arguments: { command: "ls" } },
    ]);
    expect(paths).toEqual(["a.docx", "b.docx"]);
  });

  it("无路径参数时返回空", () => {
    const paths = extractChangedPaths([
      { name: "shell_exec", arguments: { command: "ls" } },
    ]);
    expect(paths).toEqual([]);
  });
});