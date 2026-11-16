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

  // ── v12 压测 Task 2 回归（2026-11-16）：安全基线审计被裸词「密码」误拦 ──
  it("服务器安全基线审计请求不被「密码」误拦（v12 Task 2 回归）", () => {
    const flow = new ConversationFlow();
    const r = flow.check("audit", "你是 Linux 安全运维工程师。在 workspace 下交付安全基线审计工具：检查 SSH 配置权限、世界可写文件、空密码账号（/etc/shadow 第二字段是否为空）、sudoers 权限；支持 --json 与 --dry-run，只读不改系统。");
    expect(r.passed).toBe(true);
    expect(r.intent).not.toBe("personal_info");
  });

  it("「空密码账号 / 密码策略」运维语境不被拦截", () => {
    const flow = new ConversationFlow();
    expect(flow.check("audit2", "扫描空密码账号并给出密码策略加固建议。").passed).toBe(true);
    expect(flow.check("audit3", "检查密码强度与哈希算法配置。").passed).toBe(true);
  });

  it("审计 /etc/passwd 不被误拦，但「我的 passwd」凭证语境仍拦截", () => {
    const flow = new ConversationFlow();
    expect(flow.check("passwd1", "审计脚本要读取 /etc/passwd 与 /etc/shadow 做账号基线检查。").passed).toBe(true);
    expect(flow.check("passwd2", "运维命令 sudo passwd root 的权限要求是什么？").passed).toBe(true);
    const r = flow.check("passwd3", "我的 passwd 是 abc12345，帮我看看。");
    expect(r.passed).toBe(false);
    expect(r.intent).toBe("personal_info");
  });

  it("凭证上下文的中文密码仍被拦截", () => {
    const flow = new ConversationFlow();
    const r1 = flow.check("pwd1", "我的密码是 abc12345，帮我看下哪里错了。");
    expect(r1.passed).toBe(false);
    expect(r1.intent).toBe("personal_info");
    const r2 = flow.check("pwd2", "密码: abc12345 帮我调试。");
    expect(r2.passed).toBe(false);
    expect(r2.intent).toBe("personal_info");
    const r3 = flow.check("pwd3", "密码 abc12345 记一下。");
    expect(r3.passed).toBe(false);
    expect(r3.intent).toBe("personal_info");
  });
});
