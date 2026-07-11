/**
 * 技能匹配验证 — 构造 WebUI 用户输入场景
 * 验证 TF-IDF 匹配效果（frontmatter 修复后）
 */
import { describe, it, expect, beforeAll } from "vitest";
import { AutoSkillManager } from "../src/auto-skill-manager";
import { ServiceRegistry, EventBus } from "@evoclaw/core";

describe("技能匹配验证 — WebUI 用户输入场景", () => {
  let manager: AutoSkillManager;

  beforeAll(() => {
    const registry = new ServiceRegistry();
    const eventBus = new EventBus();
    manager = new AutoSkillManager(registry, eventBus);
    manager.buildCorpus();
  });

  // 辅助：验证 top-1 匹配在期望列表中
  async function expectTopMatch(input: string, expected: string[]) {
    const matches = await manager.findAllMatches(input, 5);
    const topMatch = matches[0]?.skillName || "";
    expect(expected).toContain(topMatch);
  }

  // 辅助：验证至少有一个期望技能在 top-3 中
  async function expectAnyInTop3(input: string, expected: string[]) {
    const matches = await manager.findAllMatches(input, 5);
    const top3 = matches.slice(0, 3).map(m => m.skillName);
    const found = expected.some(e => top3.includes(e));
    expect(found).toBe(true);
  }

  // ── 开发工具类 ──
  it("开发工具: 帮我检查 PR 上的评审评论", async () => {
    await expectAnyInTop3("帮我检查 PR 上的评审评论", ["gh-address-comments", "pr-review-ci-fix", "brooks-review"]);
  });

  it("开发工具: CI 构建失败了，帮我修复", async () => {
    await expectAnyInTop3("CI 构建失败了，帮我修复", ["gh-fix-ci", "pr-review-ci-fix"]);
  });

  it("开发工具: 帮我创建一个 MCP 服务器", async () => {
    await expectTopMatch("帮我创建一个 MCP 服务器", ["mcp-builder"]);
  });

  it("开发工具: 配置部署流水线到 Vercel", async () => {
    await expectAnyInTop3("配置部署流水线到 Vercel", ["deploy-pipeline"]);
  });

  it("开发工具: Sentry 报了个错误，帮我分析", async () => {
    await expectAnyInTop3("Sentry 报了个错误，帮我分析", ["sentry-triage"]);
  });

  // ── 生产力类 ──
  it("生产力: 帮我整理会议纪要和行动项", async () => {
    await expectTopMatch("帮我整理会议纪要和行动项", ["meeting-notes-and-actions"]);
  });

  it("生产力: 分析一下这次会议转录的质量", async () => {
    await expectAnyInTop3("分析一下这次会议转录的质量", ["meeting-insights-analyzer"]);
  });

  it("生产力: 帮我整理下载文件夹", async () => {
    await expectAnyInTop3("帮我整理下载文件夹", ["file-organizer"]);
  });

  it("生产力: 帮我写一篇学术论文", async () => {
    await expectAnyInTop3("帮我写一篇学术论文", ["paperjsx"]);
  });

  // ── 写作类 ──
  it("写作: 帮我写一封商务邮件", async () => {
    await expectAnyInTop3("帮我写一封商务邮件", ["email-draft-polish"]);
  });

  it("写作: 帮我写一篇技术博客文章", async () => {
    await expectAnyInTop3("帮我写一篇技术博客文章", ["content-research-writer"]);
  });

  it("写作: 根据职位描述定制我的简历", async () => {
    await expectAnyInTop3("根据职位描述定制我的简历", ["tailored-resume-generator"]);
  });

  // ── 数据分析类 ──
  it("分析: 帮我写 Excel VLOOKUP 公式", async () => {
    await expectAnyInTop3("帮我写 Excel VLOOKUP 公式", ["spreadsheet-formula-helper"]);
  });

  it("分析: 帮我的项目起个域名", async () => {
    await expectAnyInTop3("帮我的项目起个域名", ["domain-name-brainstormer"]);
  });

  // ── 新移植技能 ──
  it("新技能: 帮我创建一个新的技能", async () => {
    await expectAnyInTop3("帮我创建一个新的技能", ["skill-creator"]);
  });

  it("新技能: 生成一个 GIF 动画", async () => {
    await expectAnyInTop3("生成一个 GIF 动画", ["slack-gif-creator"]);
  });

  it("新技能: 帮我选一套配色方案", async () => {
    await expectAnyInTop3("帮我选一套配色方案", ["theme-factory"]);
  });

  it("新技能: 设计一张海报", async () => {
    await expectAnyInTop3("设计一张海报", ["canvas-design"]);
  });

  it("新技能: 写一份内部沟通公告", async () => {
    await expectAnyInTop3("写一份内部沟通公告", ["internal-comms"]);
  });

  it("新技能: 帮我分类客服工单", async () => {
    await expectAnyInTop3("帮我分类客服工单", ["support-ticket-triage"]);
  });

  // ── bundled 技能 ──
  it("bundled: 帮我计算 123 * 456 + 789", async () => {
    await expectAnyInTop3("帮我计算 123 * 456 + 789", ["calculator"]);
  });

  it("bundled: 生成一个 UUID", async () => {
    await expectTopMatch("生成一个 UUID", ["uuid-generator"]);
  });

  it("bundled: 帮我测试正则表达式", async () => {
    await expectTopMatch("帮我测试正则表达式", ["regex-tester"]);
  });

  it("bundled: 把这段文本转成 base64", async () => {
    await expectTopMatch("把这段文本转成 base64", ["base64-codec"]);
  });

  it("bundled: 计算 SHA256 哈希", async () => {
    await expectTopMatch("计算 SHA256 哈希", ["hash-computer"]);
  });

  it("bundled: 时间戳转换", async () => {
    await expectTopMatch("时间戳转换", ["timestamp-converter"]);
  });

  it("bundled: 英制单位转换", async () => {
    await expectTopMatch("英制单位转换", ["unit-converter"]);
  });

  it("bundled: 帮我选个颜色", async () => {
    await expectTopMatch("帮我选个颜色", ["color-tools"]);
  });

  it("bundled: 统计文本字数", async () => {
    await expectTopMatch("统计文本字数", ["text-utils"]);
  });

  // ── brooks-lint 子技能（通过父技能 brooks-lint 匹配，子技能不单独入语料库） ──
  it("brooks-lint: 审计项目架构和模块依赖", async () => {
    await expectAnyInTop3("审计项目架构和模块依赖", ["brooks-lint", "brooks-audit"]);
  });

  it("brooks-lint: 评估技术债务", async () => {
    await expectAnyInTop3("评估技术债务", ["brooks-lint", "brooks-debt"]);
  });

  it("brooks-lint: 代码库健康度评分", async () => {
    await expectAnyInTop3("代码库健康度评分", ["brooks-lint", "brooks-health"]);
  });

  it("brooks-lint: 审查这个 PR 的代码质量", async () => {
    await expectAnyInTop3("审查这个 PR 的代码质量", ["brooks-lint", "brooks-review"]);
  });

  it("brooks-lint: 全量扫描代码并自动修复", async () => {
    await expectAnyInTop3("全量扫描代码并自动修复", ["brooks-lint", "brooks-sweep"]);
  });

  it("brooks-lint: 评审测试质量", async () => {
    await expectAnyInTop3("评审测试质量", ["brooks-lint", "brooks-test"]);
  });

  // ── 早期 optional 技能 ──
  it("optional: 生成变更日志", async () => {
    await expectAnyInTop3("生成变更日志", ["changelog-generator"]);
  });

  it("optional: 重构大型代码库", async () => {
    await expectAnyInTop3("重构大型代码库", ["codebase-migrate"]);
  });

  it("optional: 帮我制定执行计划", async () => {
    await expectAnyInTop3("帮我制定执行计划", ["create-plan"]);
  });

  it("optional: 测试 Web 应用", async () => {
    await expectAnyInTop3("测试 Web 应用", ["webapp-testing"]);
  });

  it("optional: 公众号文章排版", async () => {
    await expectTopMatch("公众号文章排版", ["gzh-design"]);
  });

  // ── 模糊/口语化查询 ──
  it("模糊: 我想做一个 GIF 动图", async () => {
    await expectAnyInTop3("我想做一个 GIF 动图", ["slack-gif-creator"]);
  });

  it("模糊: 帮我润色邮件", async () => {
    await expectAnyInTop3("帮我润色邮件", ["email-draft-polish"]);
  });

  it("模糊: 技能开发", async () => {
    await expectAnyInTop3("技能开发", ["skill-creator"]);
  });

  it("模糊: 主题配色", async () => {
    await expectAnyInTop3("主题配色", ["theme-factory"]);
  });
});
