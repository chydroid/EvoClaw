/**
 * P5 收尾：/api/mcp-external/add 的「校验通过再落盘」+ oauth 字段持久化。
 *
 * 修复前的缺陷：addServer 先写 mcp-servers.json 再连接，非法 OAuth 配置
 * （如 stdio + oauth.enabled）会在 connectServer 抛错后留下坏配置文件。
 */

import { describe, it, expect } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { MCPClientManager } from "./mcp-client-manager";
import type { ExternalMCPServerConfig } from "./mcp-client-transport";

function managerInTempDir(): { manager: MCPClientManager; configPath: string; cleanup: () => void } {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "mcp-add-test-"));
  const manager = new MCPClientManager(dataDir);
  // 本测试只验证「校验 → 落盘」顺序，不触发真实 MCP 连接（避免网络/子进程句柄）。
  // connectServer 是私有实现细节，用最小桩替换其连接结果。
  (manager as unknown as { connectServer: () => Promise<unknown> }).connectServer = async () => ({
    name: "stub",
    connected: false,
    tools: [],
  });
  return {
    manager,
    configPath: path.join(dataDir, "mcp-servers.json"),
    cleanup: () => fs.rmSync(dataDir, { recursive: true, force: true }),
  };
}

function readConfig(configPath: string): Record<string, ExternalMCPServerConfig> {
  if (!fs.existsSync(configPath)) return {};
  return (JSON.parse(fs.readFileSync(configPath, "utf-8")) as { mcpServers: Record<string, ExternalMCPServerConfig> }).mcpServers;
}

describe("MCPClientManager.addServer — 落盘前校验（P5）", () => {
  it("非法 OAuth 配置（stdio + oauth.enabled）拒绝且不落盘", async () => {
    const { manager, configPath, cleanup } = managerInTempDir();
    try {
      await expect(
        manager.addServer("bad", {
          type: "stdio",
          command: "echo",
          oauth: { enabled: true },
        } as ExternalMCPServerConfig),
      ).rejects.toThrow(/OAuth config invalid/);
      expect(fs.existsSync(configPath)).toBe(false);
    } finally {
      cleanup();
    }
  });

  it("合法 oauth 配置完整持久化（enabled/scopes/clientId）", async () => {
    const { manager, configPath, cleanup } = managerInTempDir();
    try {
      await manager.addServer("remote", {
        type: "streamable-http",
        url: "http://127.0.0.1:1/mcp",
        oauth: { enabled: true, scopes: ["tools.read"], clientId: "cid-1" },
      });

      const stored = readConfig(configPath).remote;
      expect(stored).toBeDefined();
      expect(stored.oauth).toEqual({ enabled: true, scopes: ["tools.read"], clientId: "cid-1" });
    } finally {
      cleanup();
    }
  });
});
