import { describe, it, expect } from "vitest";
import {
  redactSensitiveText,
  maskSecret,
  containsSecret,
  redactObject,
  redactUrlCredentials,
  redactEnvValue,
  redactingFormatter,
} from "./redact";

describe("redactSensitiveText", () => {
  it("F4.1 回归：global flag 应脱敏同一密钥的所有出现", () => {
    // 使用 Bearer token（匹配模式含 +，满足 minLength 15）
    const text = "Bearer abcdefghijklmnop123456 Bearer abcdefghijklmnop123456";
    const result = redactSensitiveText(text);
    expect(result.count).toBe(2);
    // 两处都应被替换为 [REDACTED:bearer]
    expect(result.redacted).not.toContain("abcdefghijklmnop123456");
    expect(result.redacted.match(/\[REDACTED:bearer\]/g)).toHaveLength(2);
  });

  it("应脱敏单个密钥", () => {
    const result = redactSensitiveText("token=abcdefghijklmnop1234567890");
    expect(result.count).toBe(1);
    expect(result.redacted).not.toContain("abcdefghijklmnop1234567890");
  });

  it("空文本应返回空结果", () => {
    const result = redactSensitiveText("");
    expect(result.count).toBe(0);
    expect(result.redacted).toBe("");
  });

  it("preservePrefix=false 时不保留前缀", () => {
    const text = "Bearer abcdefghijklmnop123456";
    const result = redactSensitiveText(text, { preservePrefix: false });
    expect(result.redacted).not.toContain("Bear");
    expect(result.redacted).toContain("[REDACTED:bearer]");
  });

  it("自定义 placeholder 应被使用", () => {
    const text = "Bearer abcdefghijklmnop123456";
    const result = redactSensitiveText(text, {
      preservePrefix: false,
      placeholder: () => "***HIDDEN***",
    });
    expect(result.redacted).toContain("***HIDDEN***");
  });

  it("无密钥文本应原样返回", () => {
    const text = "just a normal string with no secrets";
    const result = redactSensitiveText(text);
    expect(result.count).toBe(0);
    expect(result.redacted).toBe(text);
  });
});

describe("maskSecret", () => {
  it("应遮蔽中间保留首尾", () => {
    const result = maskSecret("sk-abc123xyz789");
    // 默认 visiblePrefix=4, visibleSuffix=4
    expect(result.startsWith("sk-a")).toBe(true);
    expect(result.endsWith("z789")).toBe(true);
    expect(result).toContain("*");
  });

  it("空字符串应返回空", () => {
    expect(maskSecret("")).toBe("");
  });

  it("过短密钥应全部遮蔽", () => {
    const result = maskSecret("ab");
    expect(result).toBe("**");
  });

  it("自定义 visiblePrefix/visibleSuffix", () => {
    const result = maskSecret("sk-abcdefghij", { visiblePrefix: 2, visibleSuffix: 2 });
    expect(result.startsWith("sk")).toBe(true);
    expect(result.endsWith("ij")).toBe(true);
  });
});

describe("containsSecret", () => {
  it("应检测包含密钥的文本", () => {
    expect(containsSecret("Bearer abcdefghijklmnop123456")).toBe(true);
  });

  it("无密钥文本应返回 false", () => {
    expect(containsSecret("just plain text")).toBe(false);
  });

  it("空文本应返回 false", () => {
    expect(containsSecret("")).toBe(false);
  });
});

describe("redactObject", () => {
  it("应脱敏对象中的敏感字段", () => {
    const obj = { apiKey: "sk-somekey1234567890", name: "test" };
    const result = redactObject(obj);
    expect(result.apiKey).not.toBe("sk-somekey1234567890");
    expect(result.apiKey).toContain("*");
    expect(result.name).toBe("test");
  });

  it("应递归脱敏嵌套对象", () => {
    const obj = { config: { secret: "abcdefghijklmnop1234" }, other: "val" };
    const result = redactObject(obj);
    expect(result.config.secret).toContain("*");
    expect(result.other).toBe("val");
  });

  it("应处理数组", () => {
    const obj = { items: ["Bearer abcdefghijklmnop123456", "normal"] };
    const result = redactObject(obj);
    expect(result.items[0]).not.toContain("abcdefghijklmnop123456");
  });

  it("depth=0 时应原样返回", () => {
    const obj = { secret: "abcdefghijklmnop" };
    const result = redactObject(obj, 0);
    expect(result).toBe(obj);
  });
});

describe("redactUrlCredentials", () => {
  it("F4.2 回归：mongodb+srv scheme 含 + 应脱敏凭据", () => {
    const result = redactUrlCredentials("mongodb+srv://user:pass@host/db");
    expect(result).not.toContain("user:pass");
    expect(result).toContain("[REDACTED:url-cred]");
    expect(result).toContain("host/db");
  });

  it("应脱敏 postgresql URL 凭据", () => {
    const result = redactUrlCredentials("postgresql://admin:secret@localhost:5432/db");
    expect(result).not.toContain("admin:secret");
    expect(result).toContain("[REDACTED:url-cred]");
  });

  it("无凭据的 URL 应原样返回", () => {
    const url = "https://example.com/path";
    expect(redactUrlCredentials(url)).toBe(url);
  });

  it("应脱敏同一文本中多个 URL 凭据", () => {
    const text = "mongodb://u1:p1@h1/db mongodb://u2:p2@h2/db";
    const result = redactUrlCredentials(text);
    expect(result.match(/\[REDACTED:url-cred\]/g)).toHaveLength(2);
  });
});

describe("redactEnvValue", () => {
  it("敏感 key 应遮蔽值", () => {
    const result = redactEnvValue("API_KEY", "sk-abcdefghij123456");
    expect(result).not.toBe("sk-abcdefghij123456");
    expect(result).toContain("*");
  });

  it("非敏感 key 且值非密钥应原样返回", () => {
    expect(redactEnvValue("PORT", "3000")).toBe("3000");
  });

  it("非敏感 key 但值为密钥应遮蔽", () => {
    const result = redactEnvValue("CONFIG", "Bearer abcdefghijklmnop123456");
    expect(result).not.toContain("abcdefghijklmnop123456");
  });

  it("空值应原样返回", () => {
    expect(redactEnvValue("KEY", "")).toBe("");
  });
});

describe("redactingFormatter", () => {
  it("应脱敏日志 message 中的密钥", () => {
    const formatter = redactingFormatter();
    const info = { message: "Bearer abcdefghijklmnop123456", level: "info" };
    const result = formatter.transform(info);
    expect(result.message).not.toContain("abcdefghijklmnop123456");
  });

  it("应脱敏 meta 中的敏感字段", () => {
    const formatter = redactingFormatter();
    const info = { message: "ok", apiKey: "sk-secret1234567890abcd" };
    const result = formatter.transform(info);
    expect(result.apiKey).not.toBe("sk-secret1234567890abcd");
    expect(result.apiKey).toContain("*");
  });
});
