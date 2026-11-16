/**
 * 技能安装意图识别回归（v14 Round5 Task18 事故）：
 * "不得添加 profile 未要求的不安全指令" 中的「添加 profile」曾被误判成
 * 「安装 profile 技能」，导致整个 CSP 响应头交付任务被技能安装助手劫持
 * （0 token、0 LLM 调用）。弱信号 installSpecificSkill 在技术交付任务中必须失效，
 * 强信号（安装…技能 / 批量 / 查找并安装）不受影响。
 */
import { describe, it, expect } from "vitest";
import { classifySkillInstallIntent } from "./agent-model-executor";

describe("classifySkillInstallIntent", () => {
  it("技术交付任务中的『添加 profile』不得被当成技能安装", () => {
    // 取 Task 18 触发事故的关键片段
    const task18 =
      "你是 Web 安全工程师。在 /home/chy/EvoClaw/data/workspace/v14-security-headers/ 下交付 headers.js（CommonJS，无第三方依赖），" +
      "夹具 fixtures/profile-static.json 与 fixtures/profile-spa.json 由我提供。\n" +
      "3）指令顺序不限，但值必须完整；不得添加 profile 未要求的不安全指令。";
    expect(classifySkillInstallIntent(task18)).toEqual({ any: false, compound: false });
  });

  it("技术交付任务中的『添加 header』不得被当成技能安装", () => {
    const msg = "编写一个 headers.js 模块，向响应对象添加 x-frame-options 头。";
    expect(classifySkillInstallIntent(msg).any).toBe(false);
  });

  it("显式技能安装请求仍然命中（安装 weather）", () => {
    expect(classifySkillInstallIntent("安装 weather").any).toBe(true);
  });

  it("显式技能安装请求仍然命中（安装 weather 技能）", () => {
    expect(classifySkillInstallIntent("帮我安装 weather 技能").any).toBe(true);
  });

  it("强信号不受技术交付守卫影响（安装 weather 技能 + 交付脚本）", () => {
    const msg = "安装 weather 技能，并实现一个脚本调用它。";
    expect(classifySkillInstallIntent(msg).any).toBe(true);
  });

  it("批量安装仍然命中", () => {
    expect(classifySkillInstallIntent("批量安装所有技能").any).toBe(true);
  });

  it("查找并安装仍然命中", () => {
    expect(classifySkillInstallIntent("找一个能翻译的技能装上").any).toBe(true);
  });

  it("复合多步任务标记 compound=true（交给 LLM）", () => {
    expect(classifySkillInstallIntent("安装 weather 技能，然后用它查询天气").compound).toBe(true);
  });
});
