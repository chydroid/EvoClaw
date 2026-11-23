import { describe, it, expect } from "vitest";
import { Command } from "commander";
import { register } from "../src/commands/mcp";

// ═══════════════════════════════════════════════════════════
// 回归：commander 的 .command("a b") 只注册名为 "a" 的单条命令，
// 不产生嵌套子命令。旧实现用 .command("external list") 等写法，
// 第二次注册 "external" 时直接抛 "cannot add command 'external'"，
// 导致整个 mcp 模块加载失败 —— oauth / serve 等后续子命令全部丢失，
// CLI 帮助里出现畸形条目 `external [options] <list>`。
// ═══════════════════════════════════════════════════════════
function buildProgram(): Command {
  const program = new Command();
  program.exitOverride();
  register(program, (c) => c, () => {});
  return program;
}

function subcommandNames(cmd: Command): string[] {
  return cmd.commands.map((c) => c.name()).sort();
}

describe("mcp CLI 命令结构", () => {
  it("注册时不抛错，且 oauth / serve 子命令存在（模块未被整体丢弃）", () => {
    const program = buildProgram();
    const mcp = program.commands.find((c) => c.name() === "mcp");
    expect(mcp).toBeDefined();
    const names = subcommandNames(mcp!);
    expect(names).toContain("oauth");
    expect(names).toContain("serve");
    expect(names).toContain("external");
  });

  it("external 是嵌套命令组，四个子命令齐全且无畸形占位参数", () => {
    const program = buildProgram();
    const mcp = program.commands.find((c) => c.name() === "mcp")!;
    const external = mcp.commands.find((c) => c.name() === "external")!;
    expect(external).toBeDefined();
    expect(subcommandNames(external)).toEqual(["add", "list", "reconnect", "remove"]);
    // 旧写法会把 "list" 当成 external 的必填参数
    expect(external.registeredArguments ?? []).toHaveLength(0);
  });

  it("oauth 下 login / logout / status 齐全", () => {
    const program = buildProgram();
    const mcp = program.commands.find((c) => c.name() === "mcp")!;
    const oauth = mcp.commands.find((c) => c.name() === "oauth")!;
    expect(subcommandNames(oauth)).toEqual(["login", "logout", "status"]);
  });
});
