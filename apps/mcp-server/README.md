# EvoClaw MCP Server

桥接 IDE 与 EvoClaw Gateway，让任何 MCP 兼容 IDE 使用 EvoClaw 的 100+ 工具。

## 前置条件

1. EvoClaw Gateway 已在运行（默认端口 27788）
2. Node.js >= 20

## 快速开始

```bash
# 构建
pnpm build

# 测试连接
node apps/mcp-server/dist/index.js

# 设置 Gateway 地址（可选，默认 http://localhost:27788）
export EVOCLAW_GATEWAY_URL=http://localhost:27788
```

## IDE 配置

### Cursor

在 `~/.cursor/mcp.json` 中添加：

```json
{
  "mcpServers": {
    "evoclaw": {
      "command": "node",
      "args": ["/path/to/EvoClaw/apps/mcp-server/dist/index.js"],
      "env": {
        "EVOCLAW_GATEWAY_URL": "http://localhost:27788"
      }
    }
  }
}
```

### VS Code (Claude Code 扩展)

在 VS Code settings.json 中添加：

```json
{
  "claude-code.mcpServers": {
    "evoclaw": {
      "command": "node",
      "args": ["/path/to/EvoClaw/apps/mcp-server/dist/index.js"],
      "env": {
        "EVOCLAW_GATEWAY_URL": "http://localhost:27788"
      }
    }
  }
}
```

### Claude Desktop

在 `~/Library/Application Support/Claude/claude_desktop_config.json` (macOS) 或 `%APPDATA%\Claude\claude_desktop_config.json` (Windows) 中添加：

```json
{
  "mcpServers": {
    "evoclaw": {
      "command": "node",
      "args": ["/path/to/EvoClaw/apps/mcp-server/dist/index.js"],
      "env": {
        "EVOCLAW_GATEWAY_URL": "http://localhost:27788"
      }
    }
  }
}
```

### Windsurf

在 `~/.windsurf/mcp_config.json` 中添加（同 Cursor 格式）。

### Zed

在 `~/.config/zed/settings.json` 中添加：

```json
{
  "language_models": {
    "mcp_servers": {
      "evoclaw": {
        "command": "node",
        "args": ["/path/to/EvoClaw/apps/mcp-server/dist/index.js"]
      }
    }
  }
}
```

## 可用工具

连接后，你的 IDE 将获得 EvoClaw 的全部工具，包括：

- **run_tests** — 运行测试（vitest/jest/pytest）
- **lint** — 代码检查（eslint/prettier）
- **codebase_search** — 语义代码搜索
- **shell_exec** — 安全 shell 命令执行
- **file_read / file_create / file_modify** — 文件操作
- **git_status / git_diff / git_log** — Git 操作
- **apply_patch** — SEARCH/REPLACE 补丁应用
- **web_search / web_fetch** — 网络搜索与抓取
- **browser_navigate / browser_screenshot** — 浏览器自动化
- **vision_analyze** — VLM 视觉分析
- ... 更多

## 环境变量

| 变量 | 默认值 | 说明 |
|------|--------|------|
| `EVOCLAW_GATEWAY_URL` | `http://localhost:27788` | EvoClaw Gateway 地址 |
| `EVOCLAW_API_KEY` | (无) | API Key（如果 Gateway 启用了 JWT） |
| `EVOCLAW_MCP_DEBUG` | `false` | 设为 `true` 输出调试日志到 stderr |

## 调试

```bash
# 启用调试日志
EVOCLAW_MCP_DEBUG=true node apps/mcp-server/dist/index.js

# 测试 Gateway 连通性
curl -X POST http://localhost:27788/api/mcp \
  -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list","params":{}}'
```
