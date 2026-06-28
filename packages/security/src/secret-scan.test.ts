import { describe, it, expect } from "vitest";
import {
  scanSecrets,
  redactValue,
  hasPlaintextSecrets,
  getDefaultSecretRules,
  DEFAULT_SECRET_RULES,
} from "./secret-scan";

// ═══════════════════════════════════════════════════════════
// 测试套件：secret-scan（明文密钥扫描）
// ═══════════════════════════════════════════════════════════

describe("secret-scan > AWS Access Key", () => {
  it("检测 AKIA 开头的 AWS Access Key ID", () => {
    const findings = scanSecrets({
      aws: { accessKeyId: "AKIAIOSFODNN7EXAMPLE" },
    });
    const hit = findings.find((f) => f.ruleId === "aws-access-key");
    expect(hit).toBeDefined();
    expect(hit!.severity).toBe("error");
    expect(hit!.key).toBe("aws.accessKeyId");
  });
});

describe("secret-scan > AWS Secret Access Key", () => {
  it("检测 AWS Secret Access Key 赋值语句", () => {
    const findings = scanSecrets({
      config: 'aws_secret_access_key = "abcdefghijklmnopqrstuvwxyz0123456789ABCD"',
    });
    const hit = findings.find((f) => f.ruleId === "aws-secret-key");
    expect(hit).toBeDefined();
    expect(hit!.severity).toBe("error");
  });
});

describe("secret-scan > GitHub Token", () => {
  it("检测 ghp_ 开头的 GitHub Token", () => {
    const findings = scanSecrets({
      github: { token: "ghp_1234567890abcdefghijklmnopqrstuvwxyz" },
    });
    const hit = findings.find((f) => f.ruleId === "github-token");
    expect(hit).toBeDefined();
    expect(hit!.severity).toBe("error");
  });
});

describe("secret-scan > OpenAI API Key", () => {
  it("检测 sk- 开头的 OpenAI API Key", () => {
    const findings = scanSecrets({
      openai: { apiKey: "sk-" + "a".repeat(48) },
    });
    const hit = findings.find((f) => f.ruleId === "openai-api-key");
    expect(hit).toBeDefined();
    expect(hit!.severity).toBe("error");
  });
});

describe("secret-scan > Anthropic API Key", () => {
  it("检测 sk-ant- 开头的 Anthropic API Key", () => {
    const findings = scanSecrets({
      anthropic: { apiKey: "sk-ant-" + "a".repeat(93) },
    });
    const hit = findings.find((f) => f.ruleId === "anthropic-api-key");
    expect(hit).toBeDefined();
    expect(hit!.severity).toBe("error");
  });
});

describe("secret-scan > Google API Key", () => {
  it("检测 AIza 开头的 Google API Key", () => {
    const findings = scanSecrets({
      google: { apiKey: "AIzaSyA1234567890abcdefghijklmnopqrstuvwx" },
    });
    const hit = findings.find((f) => f.ruleId === "google-api-key");
    expect(hit).toBeDefined();
    expect(hit!.severity).toBe("error");
  });
});

describe("secret-scan > JWT Token", () => {
  it("检测 JWT 三段式 token", () => {
    const findings = scanSecrets({
      jwt: "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.signaturepart",
    });
    const hit = findings.find((f) => f.ruleId === "jwt-token");
    expect(hit).toBeDefined();
    expect(hit!.severity).toBe("warning");
  });
});

describe("secret-scan > PEM Private Key", () => {
  it("检测 PEM 私钥起始标记", () => {
    const findings = scanSecrets({
      privateKey: "-----BEGIN RSA PRIVATE KEY-----\nMIIabc...",
    });
    const hit = findings.find((f) => f.ruleId === "private-key-pem");
    expect(hit).toBeDefined();
    expect(hit!.severity).toBe("error");
  });
});

describe("secret-scan > Slack Token", () => {
  it("检测 xox 开头的 Slack Token", () => {
    const findings = scanSecrets({
      slack: { token: "xoxb-1234567890-abcdef" },
    });
    const hit = findings.find((f) => f.ruleId === "slack-token");
    expect(hit).toBeDefined();
    expect(hit!.severity).toBe("error");
  });
});

describe("secret-scan > Stripe Key", () => {
  it("检测 sk_live_ 开头的 Stripe Key", () => {
    // Stripe key pattern: sk_(live|test)_[A-Za-z0-9]{24}，需要恰好 24 个字符
    // 使用 join 构造避免触发 GitHub push protection 的密钥扫描
    const stripePrefix = ["sk", "live"].join("_") + "_";
    const stripeKey = stripePrefix + "1234567890abcdefghijklmn";
    const findings = scanSecrets({
      stripe: { key: stripeKey },
    });
    const hit = findings.find((f) => f.ruleId === "stripe-key");
    expect(hit).toBeDefined();
    expect(hit!.severity).toBe("error");
  });
});

describe("secret-scan > Generic API Key", () => {
  it("检测通用的 api_key 字段（32+ 字符）", () => {
    const findings = scanSecrets({
      api_key: "12345678901234567890123456789012abc",
    });
    const hit = findings.find((f) => f.ruleId === "generic-api-key");
    expect(hit).toBeDefined();
    expect(hit!.severity).toBe("warning");
  });

  it("豁免 exemptKeys 中的键名", () => {
    const findings = scanSecrets({
      api_key_placeholder: "12345678901234567890123456789012abc",
    });
    expect(findings.find((f) => f.ruleId === "generic-api-key")).toBeUndefined();
  });
});

describe("secret-scan > 环境变量引用豁免", () => {
  it("${VAR_NAME} 形式的值被豁免", () => {
    const findings = scanSecrets({
      openai: { apiKey: "${OPENAI_API_KEY}" },
    });
    expect(findings).toHaveLength(0);
  });

  it("非环境变量引用形式不被豁免", () => {
    const findings = scanSecrets({
      openai: { apiKey: "sk-" + "a".repeat(48) },
    });
    expect(findings.length).toBeGreaterThan(0);
  });
});

describe("secret-scan > 脱敏", () => {
  it("长字符串保留前后 4 字符", () => {
    expect(redactValue("sk-abcdef1234567890end")).toBe("sk-a***0end");
  });

  it("短字符串整体替换为 ***", () => {
    expect(redactValue("short")).toBe("***");
    expect(redactValue("12345678")).toBe("***");
  });

  it("恰好 9 字符保留前后 4 字符", () => {
    expect(redactValue("123456789")).toBe("1234***6789");
  });

  it("finding 中包含脱敏后的值", () => {
    const value = "sk-" + "a".repeat(48);
    const findings = scanSecrets({ openai: { apiKey: value } });
    const hit = findings.find((f) => f.ruleId === "openai-api-key");
    expect(hit).toBeDefined();
    expect(hit!.matchedValue).toContain("***");
    // 不应包含完整 key
    expect(hit!.matchedValue).not.toContain("a".repeat(48));
  });
});

describe("secret-scan > 递归遍历", () => {
  it("递归检测嵌套对象中的密钥", () => {
    const findings = scanSecrets({
      channels: {
        wechat: {
          config: {
            openaiApiKey: "sk-" + "a".repeat(48),
          },
        },
      },
    });
    const hit = findings.find((f) => f.ruleId === "openai-api-key");
    expect(hit).toBeDefined();
    expect(hit!.key).toContain("channels.wechat.config");
  });

  it("递归检测数组中的密钥", () => {
    const findings = scanSecrets({
      providers: [
        { name: "openai", key: "sk-" + "a".repeat(48) },
        { name: "anthropic", key: "sk-ant-" + "a".repeat(93) },
      ],
    });
    expect(findings.length).toBeGreaterThanOrEqual(2);
    const keys = findings.map((f) => f.key);
    expect(keys.some((k) => k.includes("providers[0]"))).toBe(true);
    expect(keys.some((k) => k.includes("providers[1]"))).toBe(true);
  });

  it("循环引用不导致无限递归", () => {
    const cyclic: Record<string, unknown> = { a: "sk-" + "a".repeat(48) };
    cyclic.self = cyclic;
    const findings = scanSecrets(cyclic);
    expect(findings.length).toBeGreaterThan(0);
    // 应只检测一次，不重复
    const openaiFindings = findings.filter((f) => f.ruleId === "openai-api-key");
    expect(openaiFindings).toHaveLength(1);
  });
});

describe("secret-scan > hasPlaintextSecrets", () => {
  it("包含明文密钥返回 true", () => {
    expect(
      hasPlaintextSecrets({ openai: { apiKey: "sk-" + "a".repeat(48) } }),
    ).toBe(true);
  });

  it("不含明文密钥返回 false", () => {
    expect(hasPlaintextSecrets({ openai: { apiKey: "${OPENAI_API_KEY}" } })).toBe(false);
    expect(hasPlaintextSecrets({ name: "evoclaw", version: "1.0.0" })).toBe(false);
  });
});

describe("secret-scan > getDefaultSecretRules", () => {
  it("返回默认规则列表副本", () => {
    const rules = getDefaultSecretRules();
    expect(rules.length).toBe(DEFAULT_SECRET_RULES.length);
    // 修改返回值不影响原数组
    rules.push({
      id: "test",
      name: "test",
      pattern: /test/,
      severity: "info",
    });
    expect(getDefaultSecretRules().length).toBe(DEFAULT_SECRET_RULES.length);
  });
});

describe("secret-scan > 自定义规则", () => {
  it("使用自定义规则集替换默认规则", () => {
    const customRules = [
      {
        id: "custom-secret",
        name: "Custom Secret",
        pattern: /CUSTOM-SECRET-[0-9]+/,
        severity: "warning" as const,
      },
    ];
    const findings = scanSecrets(
      { config: "CUSTOM-SECRET-12345" },
      { rules: customRules },
    );
    expect(findings).toHaveLength(1);
    expect(findings[0].ruleId).toBe("custom-secret");
  });

  it("额外 exemptKeys 与规则 exemptKeys 都生效", () => {
    const findings = scanSecrets(
      {
        my_special_key: "12345678901234567890123456789012abc",
        api_key_placeholder: "12345678901234567890123456789012abc",
      },
      { exemptKeys: ["my_special_key"] },
    );
    // my_special_key 被豁免
    expect(findings.find((f) => f.key === "my_special_key")).toBeUndefined();
    // api_key_placeholder 被规则级豁免
    expect(findings.find((f) => f.key === "api_key_placeholder")).toBeUndefined();
  });
});
