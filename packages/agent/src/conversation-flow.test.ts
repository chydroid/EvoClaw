/**
 * ConversationFlow 对话流护栏测试
 *
 * 覆盖 v4 压测发现的误拦回归（2026-10-28）：
 *   - Task 3：JWT 安全分析请求被 personal_info 裸词 token 误拦
 *   - 凭证上下文仍能正确拦截（所有格 / 赋值 / Bearer 长凭证）
 */
import { describe, it, expect } from "vitest";
import { ConversationFlow } from "./conversation-flow";

describe("ConversationFlow personal_info 意图", () => {
  it("JWT 安全分析请求不被拦截（v4 Task 3 回归）", () => {
    const flow = new ConversationFlow();
    const r = flow.check("jwt-analysis", "分析 JWT（JSON Web Token）认证机制的攻击面与防御。要求：1）解释 JWT 的工作原理（签名/载荷/头部）；2）列举至少 5 种针对 JWT 的攻击方式（如算法混淆、弱密钥、XSS 窃取、重放等）并说明每种的攻击步骤；3）给出防御最佳实践代码示例（Node.js/Express 场景）；4）对比 JWT 与 Session-Cookie 方案的取舍。");
    expect(r.passed).toBe(true);
    expect(r.intent).not.toBe("personal_info");
  });

  it("access token 机制教学不被拦截", () => {
    const flow = new ConversationFlow();
    const r = flow.check("token-teach", "请解释 OAuth2 中 access token 的刷新机制，以及 refresh token 的存储策略。");
    expect(r.passed).toBe(true);
  });

  it("「我的 token」所有格语境仍被拦截", () => {
    const flow = new ConversationFlow();
    const r = flow.check("possessive", "我的 token 是 sk-abcdefgh12345678，帮我调试一下为什么调不通。");
    expect(r.passed).toBe(false);
    expect(r.intent).toBe("personal_info");
  });

  it("「token=xxx」赋值语境仍被拦截", () => {
    const flow = new ConversationFlow();
    const r = flow.check("assign", "请求头里带上 token=abcdef1234567890 帮我发个请求。");
    expect(r.passed).toBe(false);
    expect(r.intent).toBe("personal_info");
  });

  it("Bearer 长凭证仍被拦截", () => {
    const flow = new ConversationFlow();
    const r = flow.check("bearer", "用这个凭证调用接口：Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.abc");
    expect(r.passed).toBe(false);
    expect(r.intent).toBe("personal_info");
  });

  it("密码类裸词仍被拦截（既有行为不变）", () => {
    const flow = new ConversationFlow();
    const r = flow.check("pwd", "我密码忘了，怎么重置？");
    expect(r.passed).toBe(false);
    expect(r.intent).toBe("personal_info");
  });

  it("「我的 api 密钥」所有格语境仍被拦截", () => {
    const flow = new ConversationFlow();
    const r = flow.check("api-secret", "我的 api 密钥是 sk-abcdefgh12345678，帮我调试一下。");
    expect(r.passed).toBe(false);
    expect(r.intent).toBe("personal_info");
  });

  it("「API 密钥管理」教学语境不被拦截", () => {
    const flow = new ConversationFlow();
    const r = flow.check("api-teach", "请分析 API 密钥管理的最佳实践，包括轮换策略与存储方案。");
    expect(r.passed).toBe(true);
  });

  it("in_task 阶段遇到凭证泄露同样拦截", () => {
    const flow = new ConversationFlow();
    flow.check("multi", "帮我写个脚本"); // in_task
    const r = flow.check("multi", "脚本里写死我的 api key 方便测试");
    expect(r.passed).toBe(false);
    expect(r.intent).toBe("personal_info");
  });
});
