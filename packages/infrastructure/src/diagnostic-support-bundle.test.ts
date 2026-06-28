import { describe, it, expect } from "vitest";
import {
  SupportBundleBuilder,
  redactString,
  type SupportBundleInput,
} from "./diagnostic-support-bundle";
import { DiagnosticPayloadBuilder } from "./diagnostic-payload";
import type { DiagnosticPhase } from "./diagnostic-phase";
import type { StabilityAssessment } from "./diagnostic-stability";

function makePhase(kind: DiagnosticPhase["kind"], status: DiagnosticPhase["status"] = "succeeded"): DiagnosticPhase {
  return {
    kind,
    startedAt: new Date("2026-01-01T00:00:00Z"),
    endedAt: new Date("2026-01-01T00:00:01Z"),
    durationMs: 1000,
    status,
  };
}

function makeInput(): SupportBundleInput {
  const phasesMap = new Map<string, DiagnosticPhase[]>();
  phasesMap.set("session-1", [makePhase("init"), makePhase("auth")]);
  return {
    description: "Test bundle",
    phases: phasesMap,
    payloads: [
      DiagnosticPayloadBuilder.create({
        severity: "error",
        category: "tool.timeout",
        message: "Tool timed out",
        entityId: "session-1",
        entityType: "session",
        data: { apiKey: "sk-123456", toolName: "search" },
      }),
    ],
    stabilityAssessments: [
      {
        issue: "frequent-retry",
        severity: "warning",
        entityId: "session-1",
        reason: "3 retries in 60s",
        evidence: { retryCount: 3 },
      },
    ],
    systemInfo: {
      platform: "linux",
      nodeVersion: "v22.0.0",
      arch: "x64",
      uptime: 3600,
    },
    configSnapshot: {
      port: 27788,
      apiKey: "sk-secret",
      database: { password: "db-password" },
      logLevel: "info",
    },
    logExcerpt: [
      "[INFO] server started",
      'Token: Bearer abc123',
      'Authorization: Bearer sk-test',
      '{"apiKey": "sk-xyz"}',
    ],
  };
}

describe("SupportBundleBuilder", () => {
  describe("build", () => {
    it("应生成包含 bundleId / createdAt 的支持包", () => {
      const bundle = SupportBundleBuilder.build(makeInput());
      expect(bundle.bundleId).toMatch(/^[0-9a-f-]{36}$/i);
      expect(bundle.createdAt).toBeInstanceOf(Date);
      expect(bundle.description).toBe("Test bundle");
      expect(bundle.generator.name).toBe("@evoclaw/infrastructure/diagnostic-support-bundle");
      expect(typeof bundle.generator.version).toBe("string");
    });

    it("应使用自定义 bundleId / createdAt", () => {
      const customId = "custom-bundle-id";
      const customDate = new Date("2026-06-01T12:00:00Z");
      const bundle = SupportBundleBuilder.build({
        ...makeInput(),
        bundleId: customId,
        createdAt: customDate,
      });
      expect(bundle.bundleId).toBe(customId);
      expect(bundle.createdAt).toBe(customDate);
    });

    it("phases 应从 Map 转换为数组形式", () => {
      const bundle = SupportBundleBuilder.build(makeInput());
      expect(bundle.phases).toHaveLength(1);
      expect(bundle.phases[0].entityId).toBe("session-1");
      expect(bundle.phases[0].phases).toHaveLength(2);
      // 应是拷贝
      expect(bundle.phases[0].phases[0]).not.toBe(makePhase("init"));
    });

    it("phases 也应支持数组形式输入", () => {
      const bundle = SupportBundleBuilder.build({
        phases: [{ entityId: "s1", phases: [makePhase("init")] }],
      });
      expect(bundle.phases).toHaveLength(1);
      expect(bundle.phases[0].phases).toHaveLength(1);
    });
  });

  describe("payloads 脱敏", () => {
    it("应脱敏 payloads 中的敏感字段", () => {
      const bundle = SupportBundleBuilder.build(makeInput());
      expect(bundle.payloads).toHaveLength(1);
      const payload = bundle.payloads[0];
      expect(payload.redacted).toBe(true);
      expect(payload.redactedFields).toContain("apiKey");
      const data = payload.data as Record<string, unknown>;
      expect(data.apiKey).toBe("***REDACTED***");
      // 非敏感字段保留
      expect(data.toolName).toBe("search");
    });

    it("应支持 additionalSensitiveKeys 扩展", () => {
      const bundle = SupportBundleBuilder.build(
        {
          payloads: [
            DiagnosticPayloadBuilder.create({
              severity: "info",
              category: "test",
              message: "test",
              data: { customSecret: "abc" },
            }),
          ],
        },
        { additionalSensitiveKeys: ["customsecret"] },
      );
      const data = bundle.payloads[0].data as Record<string, unknown>;
      expect(data.customSecret).toBe("***REDACTED***");
      expect(bundle.redactionSummary.redactedFieldNames).toContain("customSecret");
    });
  });

  describe("configSnapshot 脱敏", () => {
    it("应递归脱敏 configSnapshot 中的敏感字段", () => {
      const bundle = SupportBundleBuilder.build(makeInput());
      expect(bundle.configSnapshot).toBeDefined();
      const config = bundle.configSnapshot as Record<string, unknown>;
      expect(config.port).toBe(27788);
      expect(config.apiKey).toBe("***REDACTED***");
      expect(config.logLevel).toBe("info");
      const db = config.database as Record<string, unknown>;
      expect(db.password).toBe("***REDACTED***");
      expect(bundle.redactionSummary.redactedFieldNames).toContain("apiKey");
      expect(bundle.redactionSummary.redactedFieldNames).toContain("database.password");
    });

    it("includeConfigSnapshot=false 时不应包含 configSnapshot", () => {
      const bundle = SupportBundleBuilder.build(makeInput(), {
        includeConfigSnapshot: false,
      });
      expect(bundle.configSnapshot).toBeUndefined();
    });
  });

  describe("logExcerpt 脱敏", () => {
    it("应使用 redactString 脱敏日志行", () => {
      const bundle = SupportBundleBuilder.build(makeInput());
      expect(bundle.logExcerpt).toBeDefined();
      expect(bundle.logExcerpt).toHaveLength(4);
      expect(bundle.logExcerpt![0]).toBe("[INFO] server started");
      expect(bundle.logExcerpt![1]).toBe("Token: Bearer <redacted>");
      expect(bundle.logExcerpt![2]).toBe("Authorization: Bearer <redacted>");
      // JSON 字段：regex 替换内部字段值，保留外层 { }
      expect(bundle.logExcerpt![3]).toBe('{"apiKey": "<redacted>"}');
    });

    it("includeLogExcerpt=false 时不应包含 logExcerpt", () => {
      const bundle = SupportBundleBuilder.build(makeInput(), {
        includeLogExcerpt: false,
      });
      expect(bundle.logExcerpt).toBeUndefined();
    });

    it("maxLogEntries 应截断日志条数", () => {
      const bundle = SupportBundleBuilder.build(
        {
          logExcerpt: ["a", "b", "c", "d"],
        },
        { maxLogEntries: 2 },
      );
      expect(bundle.logExcerpt).toEqual(["a", "b"]);
    });
  });

  describe("includeStabilityAssessments", () => {
    it("默认应包含 stabilityAssessments", () => {
      const bundle = SupportBundleBuilder.build(makeInput());
      expect(bundle.stabilityAssessments).toHaveLength(1);
      expect(bundle.stabilityAssessments[0].issue).toBe("frequent-retry");
    });

    it("includeStabilityAssessments=false 时应为空数组", () => {
      const bundle = SupportBundleBuilder.build(makeInput(), {
        includeStabilityAssessments: false,
      });
      expect(bundle.stabilityAssessments).toEqual([]);
    });
  });

  describe("redactionSummary", () => {
    it("应统计脱敏字段总数与字段名", () => {
      const bundle = SupportBundleBuilder.build(makeInput());
      expect(bundle.redactionSummary.totalFieldsRedacted).toBeGreaterThan(0);
      expect(bundle.redactionSummary.redactedFieldNames.length).toBeGreaterThan(0);
      // 应去重排序
      const names = bundle.redactionSummary.redactedFieldNames;
      const unique = Array.from(new Set(names));
      expect(names).toEqual(unique);
      // 检查是否已排序
      const sorted = [...names].sort();
      expect(names).toEqual(sorted);
    });
  });

  describe("toJSON", () => {
    it("应序列化为 JSON 字符串", () => {
      const bundle = SupportBundleBuilder.build(makeInput());
      const json = SupportBundleBuilder.toJSON(bundle);
      expect(typeof json).toBe("string");
      const parsed = JSON.parse(json);
      expect(parsed.bundleId).toBe(bundle.bundleId);
    });

    it("prettyPrint=true 应生成缩进 JSON", () => {
      const bundle = SupportBundleBuilder.build(makeInput());
      const compact = SupportBundleBuilder.toJSON(bundle);
      const pretty = SupportBundleBuilder.toJSON(bundle, true);
      expect(pretty.length).toBeGreaterThan(compact.length);
      expect(pretty).toContain("\n");
    });
  });

  describe("estimateSize / isWithinSizeLimit", () => {
    it("estimateSize 应返回字节数", () => {
      const bundle = SupportBundleBuilder.build(makeInput());
      const size = SupportBundleBuilder.estimateSize(bundle);
      expect(size).toBeGreaterThan(0);
      // 应等于 toJSON 的字节长度
      expect(size).toBe(Buffer.byteLength(SupportBundleBuilder.toJSON(bundle), "utf8"));
    });

    it("isWithinSizeLimit 应正确判断大小限制", () => {
      const bundle = SupportBundleBuilder.build(makeInput());
      const size = SupportBundleBuilder.estimateSize(bundle);
      expect(SupportBundleBuilder.isWithinSizeLimit(bundle, size + 1)).toBe(true);
      expect(SupportBundleBuilder.isWithinSizeLimit(bundle, size - 1)).toBe(false);
      expect(SupportBundleBuilder.isWithinSizeLimit(bundle, size)).toBe(true);
    });
  });

  describe("空输入", () => {
    it("应支持完全空的输入", () => {
      const bundle = SupportBundleBuilder.build({});
      expect(bundle.phases).toEqual([]);
      expect(bundle.payloads).toEqual([]);
      expect(bundle.stabilityAssessments).toEqual([]);
      expect(bundle.redactionSummary.totalFieldsRedacted).toBe(0);
      expect(bundle.redactionSummary.redactedFieldNames).toEqual([]);
    });

    it("应保留 systemInfo 不脱敏", () => {
      const bundle = SupportBundleBuilder.build({
        systemInfo: {
          platform: "linux",
          memoryUsage: { rss: 100, heapTotal: 50, heapUsed: 30, external: 10, arrayBuffers: 5 } as NodeJS.MemoryUsage,
        },
      });
      expect(bundle.systemInfo?.platform).toBe("linux");
      expect(bundle.systemInfo?.memoryUsage?.rss).toBe(100);
    });
  });
});

describe("redactString", () => {
  it("应脱敏 Bearer token", () => {
    expect(redactString("Authorization: Bearer sk-abc123")).toBe("Authorization: Bearer <redacted>");
  });

  it("应脱敏 JWT", () => {
    const jwt = "eyJhbGciOiJIUzI1.eyJzdWIiOiIxMjM0.test1234567890";
    expect(redactString(`token: ${jwt}`)).toBe("token: <redacted-jwt>");
  });

  it("应脱敏数据库连接字符串", () => {
    expect(
      redactString("postgres://user:password@host:5432/db"),
    ).toBe("postgres://user:<redacted>@host:5432/db");
  });

  it("应脱敏 Basic Auth", () => {
    expect(redactString("Authorization: Basic dXNlcjpwYXNz")).toBe("Authorization: Basic <redacted>");
  });

  it("应脱敏 JSON 字段中的密钥", () => {
      // regex 替换内部字段值，保留 JSON 外层 { }
      expect(
        redactString('{"apiKey": "sk-xyz", "port": 27788}'),
      ).toBe('{"apiKey": "<redacted>", "port": 27788}');
    });
});
