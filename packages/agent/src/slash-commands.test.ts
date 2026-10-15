/**
 * 斜杠命令守卫（2026-10-15 eval15 事故）：以绝对路径开头的消息
 * （"/home/.../app.log 是一个日志..."）曾被当成未知斜杠命令兜底，
 * LLM 根本没触发。命令名是单词（不含 "/"）；首个词含 "/" 即路径。
 */
import { describe, it, expect } from "vitest";
import { handleSlashCommand, type SlashCommandDeps } from "./slash-commands";

/**
 * handleSlashCommand 对守卫分支只读 message；对真实命令分支只读
 * deps.providers/conversationHistory 等浅字段——Proxy 兜底即可。
 * 返回值若是函数则返回安全的 async no-op，否则返回 []（.length/.find 可用）。
 */
const deps = new Proxy(
  {},
  {
    get: (_, prop) => {
      if (prop === Symbol.toStringTag) return undefined;
      const fn: unknown = async () => [];
      return new Proxy(fn, {
        get: (target, p) => (p === Symbol.toPrimitive ? () => "" : (target as unknown as Record<PropertyKey, unknown>)[p]),
        apply: () => Promise.resolve([]),
      });
    },
  }
) as SlashCommandDeps;

describe("handleSlashCommand 路径消息守卫", () => {
  it("以绝对路径开头的消息不拦截（交给正常对话）", async () => {
    const r = await handleSlashCommand(
      deps,
      "/home/chy/EvoClaw/data/workspace/ws-t03/app.log 是一个服务日志，请解析它",
      "s1",
      Date.now()
    );
    expect(r).toBeNull();
  });

  it("以 /tmp/... 开头的消息不拦截", async () => {
    const r = await handleSlashCommand(deps, "/tmp/x/report.md 在吗", "s1", Date.now());
    expect(r).toBeNull();
  });

  it("真实命令仍拦截（/help）", async () => {
    const r = await handleSlashCommand(deps, "/help", "s1", Date.now());
    expect(r?.reply).toContain("可用命令");
  });

  it("未知名单词命令仍走兜底（不静默丢弃）", async () => {
    const r = await handleSlashCommand(deps, "/definitely_not_a_command", "s1", Date.now());
    expect(r?.reply).toContain("未知命令");
  });

  it("非斜杠消息不拦截", async () => {
    const r = await handleSlashCommand(deps, "hello", "s1", Date.now());
    expect(r).toBeNull();
  });
});
