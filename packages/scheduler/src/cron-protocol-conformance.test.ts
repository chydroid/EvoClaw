import { describe, it, expect } from "vitest";
import {
  validateCronProtocol,
  checkCronExpression,
  isValidIanaTimezone,
  nextRunHint,
  hasErrors,
  findingsByRule,
  MAX_NAME_LENGTH,
  MAX_TIMEOUT_MS,
  MAX_RETRIES,
  type CronJobSpec,
} from "./cron-protocol-conformance";

function makeJob(overrides: Partial<CronJobSpec> = {}): CronJobSpec {
  return {
    id: "job-1",
    name: "Test Job",
    cron: "0 * * * *",
    timezone: "Asia/Shanghai",
    enabled: true,
    ...overrides,
  };
}

describe("checkCronExpression", () => {
  it("应接受合法的 5 段表达式", () => {
    expect(checkCronExpression("0 * * * *").valid).toBe(true);
    expect(checkCronExpression("*/5 * * * *").valid).toBe(true);
    expect(checkCronExpression("0 0 1 1 *").valid).toBe(true);
    expect(checkCronExpression("0,30 * * * *").valid).toBe(true);
    expect(checkCronExpression("0-30 * * * *").valid).toBe(true);
    expect(checkCronExpression("0 0 1-15 * *").valid).toBe(true);
  });

  it("应接受合法的 6 段表达式（含秒）", () => {
    expect(checkCronExpression("0 0 * * * *").valid).toBe(true);
    expect(checkCronExpression("30 0 * * * *").valid).toBe(true);
    expect(checkCronExpression("0 0 0 1 1 *").valid).toBe(true);
  });

  it("应接受月份和星期名称", () => {
    expect(checkCronExpression("0 0 * jan *").valid).toBe(true);
    expect(checkCronExpression("0 0 * * sun").valid).toBe(true);
    expect(checkCronExpression("0 0 * jan-dec *").valid).toBe(true);
  });

  it("段数错误应返回 invalid", () => {
    expect(checkCronExpression("0 * *").valid).toBe(false);
    expect(checkCronExpression("0 * * * * * *").valid).toBe(false);
  });

  it("字段字符非法应返回 invalid", () => {
    // @ 是非法字符
    expect(checkCronExpression("0 @ * * *").valid).toBe(false);
    expect(checkCronExpression("0 * * * $").valid).toBe(false);
  });

  it("字段取值越界应返回 invalid", () => {
    expect(checkCronExpression("60 * * * *").valid).toBe(false); // minute > 59
    expect(checkCronExpression("* 25 * * *").valid).toBe(false); // hour > 23
    expect(checkCronExpression("* * 32 * *").valid).toBe(false); // day > 31
    expect(checkCronExpression("* * * 13 *").valid).toBe(false); // month > 12
    expect(checkCronExpression("* * * * 8").valid).toBe(false); // dow > 7
  });

  it("step 值非法应返回 invalid", () => {
    expect(checkCronExpression("*/0 * * * *").valid).toBe(false); // step=0
    expect(checkCronExpression("*/abc * * * *").valid).toBe(false);
  });

  it("范围非法应返回 invalid", () => {
    expect(checkCronExpression("5-3 * * * *").valid).toBe(false); // lo > hi
    expect(checkCronExpression("0-60 * * * *").valid).toBe(false); // hi 越界
  });

  it("空表达式应返回 invalid", () => {
    expect(checkCronExpression("").valid).toBe(false);
    expect(checkCronExpression("   ").valid).toBe(false);
  });

  it("dayOfWeek=7 应被允许（等价于 0 周日）", () => {
    expect(checkCronExpression("* * * * 7").valid).toBe(true);
  });
});

describe("validateCronProtocol", () => {
  describe("合法 job", () => {
    it("单个合法 job 不应产生 findings", () => {
      const findings = validateCronProtocol([makeJob()]);
      expect(findings).toHaveLength(0);
    });

    it("多个合法且不冲突的 job 不应产生 error", () => {
      const findings = validateCronProtocol([
        makeJob({ id: "j1", cron: "0 * * * *" }),
        makeJob({ id: "j2", cron: "30 * * * *" }),
      ]);
      expect(hasErrors(findings)).toBe(false);
    });
  });

  describe("ID 校验", () => {
    it("重复 ID 应产生 error", () => {
      const findings = validateCronProtocol([
        makeJob({ id: "dup" }),
        makeJob({ id: "dup" }),
      ]);
      const dupFindings = findingsByRule(findings, "duplicate-id");
      expect(dupFindings).toHaveLength(1);
      expect(dupFindings[0].severity).toBe("error");
    });

    it("空 ID 应产生 error", () => {
      const findings = validateCronProtocol([makeJob({ id: "" })]);
      const emptyIdFindings = findingsByRule(findings, "empty-id");
      expect(emptyIdFindings).toHaveLength(1);
      expect(emptyIdFindings[0].severity).toBe("error");
    });
  });

  describe("name 校验", () => {
    it("空 name 应产生 error", () => {
      const findings = validateCronProtocol([makeJob({ name: "" })]);
      const nameFindings = findingsByRule(findings, "empty-name");
      expect(nameFindings).toHaveLength(1);
      expect(nameFindings[0].severity).toBe("error");
    });

    it(`name 长度超过 ${MAX_NAME_LENGTH} 应产生 error`, () => {
      const longName = "a".repeat(MAX_NAME_LENGTH + 1);
      const findings = validateCronProtocol([makeJob({ name: longName })]);
      const nameFindings = findingsByRule(findings, "name-too-long");
      expect(nameFindings).toHaveLength(1);
      expect(nameFindings[0].severity).toBe("error");
    });

    it(`name 长度恰好 ${MAX_NAME_LENGTH} 应通过`, () => {
      const exactName = "a".repeat(MAX_NAME_LENGTH);
      const findings = validateCronProtocol([makeJob({ name: exactName })]);
      expect(hasErrors(findings)).toBe(false);
    });
  });

  describe("cron 表达式校验", () => {
    it("非法 cron 表达式应产生 error", () => {
      const findings = validateCronProtocol([makeJob({ cron: "invalid expr" })]);
      const cronFindings = findingsByRule(findings, "invalid-cron-expr");
      expect(cronFindings).toHaveLength(1);
      expect(cronFindings[0].severity).toBe("error");
    });
  });

  describe("timezone 校验", () => {
    it("非法时区格式应产生 error", () => {
      const findings = validateCronProtocol([makeJob({ timezone: "NotATimezone" })]);
      const tzFindings = findingsByRule(findings, "invalid-timezone");
      expect(tzFindings).toHaveLength(1);
      expect(tzFindings[0].severity).toBe("error");
    });

    it("未知 IANA 时区应产生 warning", () => {
      const findings = validateCronProtocol([makeJob({ timezone: "Asia/FakeCity" })]);
      const tzFindings = findingsByRule(findings, "unknown-timezone");
      expect(tzFindings.length).toBeGreaterThanOrEqual(1);
      expect(tzFindings[0].severity).toBe("warning");
    });

    it("合法时区应通过", () => {
      const findings = validateCronProtocol([makeJob({ timezone: "America/New_York" })]);
      expect(hasErrors(findings)).toBe(false);
    });
  });

  describe("timeout 校验", () => {
    it(`timeoutMs 超过 ${MAX_TIMEOUT_MS} 应产生 error`, () => {
      const findings = validateCronProtocol([makeJob({ timeoutMs: MAX_TIMEOUT_MS + 1 })]);
      const toFindings = findingsByRule(findings, "timeout-too-large");
      expect(toFindings).toHaveLength(1);
      expect(toFindings[0].severity).toBe("error");
    });

    it(`timeoutMs 恰好 ${MAX_TIMEOUT_MS} 应通过`, () => {
      const findings = validateCronProtocol([makeJob({ timeoutMs: MAX_TIMEOUT_MS })]);
      expect(hasErrors(findings)).toBe(false);
    });

    it("负 timeoutMs 应产生 error", () => {
      const findings = validateCronProtocol([makeJob({ timeoutMs: -1 })]);
      const toFindings = findingsByRule(findings, "invalid-timeout");
      expect(toFindings).toHaveLength(1);
      expect(toFindings[0].severity).toBe("error");
    });
  });

  describe("maxRetries 校验", () => {
    it(`maxRetries 超过 ${MAX_RETRIES} 应产生 error`, () => {
      const findings = validateCronProtocol([makeJob({ maxRetries: MAX_RETRIES + 1 })]);
      const retryFindings = findingsByRule(findings, "retries-too-large");
      expect(retryFindings).toHaveLength(1);
      expect(retryFindings[0].severity).toBe("error");
    });

    it(`maxRetries 恰好 ${MAX_RETRIES} 应通过`, () => {
      const findings = validateCronProtocol([makeJob({ maxRetries: MAX_RETRIES })]);
      expect(hasErrors(findings)).toBe(false);
    });

    it("负 maxRetries 应产生 error", () => {
      const findings = validateCronProtocol([makeJob({ maxRetries: -1 })]);
      const retryFindings = findingsByRule(findings, "invalid-retries");
      expect(retryFindings).toHaveLength(1);
      expect(retryFindings[0].severity).toBe("error");
    });
  });

  describe("重复 cron+tz 组合", () => {
    it("两个 job 共享相同 cron+tz 应产生 warning", () => {
      const findings = validateCronProtocol([
        makeJob({ id: "j1", cron: "0 * * * *", timezone: "Asia/Shanghai" }),
        makeJob({ id: "j2", cron: "0 * * * *", timezone: "Asia/Shanghai" }),
      ]);
      const dupFindings = findingsByRule(findings, "duplicate-cron-tz");
      expect(dupFindings).toHaveLength(1);
      expect(dupFindings[0].severity).toBe("warning");
    });

    it("相同 cron 但不同 tz 不应触发 warning", () => {
      const findings = validateCronProtocol([
        makeJob({ id: "j1", cron: "0 * * * *", timezone: "Asia/Shanghai" }),
        makeJob({ id: "j2", cron: "0 * * * *", timezone: "America/New_York" }),
      ]);
      const dupFindings = findingsByRule(findings, "duplicate-cron-tz");
      expect(dupFindings).toHaveLength(0);
    });

    it("无时区时相同 cron 应触发 warning", () => {
      const findings = validateCronProtocol([
        makeJob({ id: "j1", cron: "0 * * * *", timezone: undefined }),
        makeJob({ id: "j2", cron: "0 * * * *", timezone: undefined }),
      ]);
      const dupFindings = findingsByRule(findings, "duplicate-cron-tz");
      expect(dupFindings).toHaveLength(1);
    });
  });

  describe("findings 排序", () => {
    it("应按 severity 降序排序（error 优先）", () => {
      const findings = validateCronProtocol([
        makeJob({ id: "dup", name: "a".repeat(MAX_NAME_LENGTH + 1), cron: "bad" }),
        makeJob({ id: "dup", name: "ok", cron: "0 * * * *" }),
      ]);
      // 第一个应是 error
      expect(findings[0].severity).toBe("error");
    });
  });
});

describe("isValidIanaTimezone", () => {
  it("应接受合法的 IANA 时区", () => {
    expect(isValidIanaTimezone("Asia/Shanghai")).toBe(true);
    expect(isValidIanaTimezone("America/New_York")).toBe(true);
    expect(isValidIanaTimezone("Europe/London")).toBe(true);
    expect(isValidIanaTimezone("UTC")).toBe(false); // 不符合 Area/Location 格式
  });

  it("应拒绝格式错误的时区", () => {
    expect(isValidIanaTimezone("NotATimezone")).toBe(false);
    expect(isValidIanaTimezone("Asia")).toBe(false);
    expect(isValidIanaTimezone("")).toBe(false);
  });

  it("应拒绝未知但格式正确的时区", () => {
    expect(isValidIanaTimezone("Asia/FakeCity")).toBe(false);
    expect(isValidIanaTimezone("Fake/Place")).toBe(false);
  });
});

describe("nextRunHint", () => {
  it("合法表达式应返回包含表达式的提示", () => {
    const hint = nextRunHint("0 * * * *");
    expect(hint).toContain("0 * * * *");
    expect(hint).toContain("cron parser");
  });

  it("非法表达式应返回错误信息", () => {
    const hint = nextRunHint("invalid");
    expect(hint).toContain("invalid");
  });
});

describe("工具函数", () => {
  it("hasErrors 应正确检测 error 级别", () => {
    const errorFindings = validateCronProtocol([makeJob({ id: "" })]);
    expect(hasErrors(errorFindings)).toBe(true);

    const cleanFindings = validateCronProtocol([makeJob()]);
    expect(hasErrors(cleanFindings)).toBe(false);
  });

  it("findingsByRule 应按 rule 名筛选", () => {
    const findings = validateCronProtocol([
      makeJob({ id: "dup", name: "a".repeat(MAX_NAME_LENGTH + 1) }),
      makeJob({ id: "dup" }),
    ]);
    const nameFindings = findingsByRule(findings, "name-too-long");
    const idFindings = findingsByRule(findings, "duplicate-id");
    expect(nameFindings).toHaveLength(1);
    expect(idFindings).toHaveLength(1);
    expect(findingsByRule(findings, "nonexistent-rule")).toHaveLength(0);
  });
});
