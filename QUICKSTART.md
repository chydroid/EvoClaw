# EvoClaw 快速启动指南

## 方式一：Docker（推荐，最快速）

```bash
# 拉取预构建镜像（无需下载源码和编译）
docker pull evoclaw/evoclaw:latest

# 启动
docker run -d --name evoclaw \
  -p 27788:27788 \
  --env-file .env \
  -v evoclaw-data:/app/data \
  evoclaw/evoclaw:latest

# 查看日志
docker logs -f evoclaw
```

首次启动约 5 秒。访问 http://localhost:27788 进入 Web UI。

## 方式二：源码安装（开发者）

### 最小安装（约 30 秒）

适合不需要浏览器自动化和本地嵌入模型的场景：

```bash
git clone https://github.com/chydroid/EvoClaw.git
cd EvoClaw
pnpm install          # optional 依赖会自动跳过
pnpm build
pnpm start
```

### 完整安装（约 2-3 分钟）

如果需要浏览器自动化或本地嵌入模型：

```bash
pnpm install --config.optional=true   # 安装所有 optional 依赖
pnpm exec playwright install chromium # 安装浏览器（仅首次）
pnpm build
pnpm start
```

### 可选依赖说明

| 依赖 | 安装命令 | 用途 | 不装的影响 |
|------|---------|------|-----------|
| playwright | `pnpm add playwright -F @evoclaw/infrastructure` | 浏览器自动化 | browser_* 工具不可用 |
| @huggingface/transformers | `pnpm add @huggingface/transformers -F @evoclaw/memory` | 本地嵌入模型 | 回退到 OpenAI embeddings |
| better-sqlite3 | `pnpm add better-sqlite3` | FTS5 全文检索 | 回退到内存搜索 |
| @tencent-weixin/openclaw-weixin | `pnpm add @tencent-weixin/openclaw-weixin` | 微信渠道 | 微信渠道不可用 |

## 方式三：IDE 集成

让 VS Code / Cursor / Claude Desktop 使用 EvoClaw 的工具：

1. 确保 EvoClaw Gateway 正在运行（`pnpm start`）
2. 构建 MCP Server：`pnpm build`
3. 在 IDE 配置中添加 MCP Server：

```json
{
  "mcpServers": {
    "evoclaw": {
      "command": "node",
      "args": ["/path/to/EvoClaw/apps/mcp-server/dist/index.js"]
    }
  }
}
```

详见 [apps/mcp-server/README.md](apps/mcp-server/README.md)。

## 验证安装

```bash
# 检查服务健康
curl http://localhost:27788/health

# 检查 MCP 连通性
curl -X POST http://localhost:27788/api/mcp \
  -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list","params":{}}'
```

## 常见问题

### Q: pnpm install 很慢？
A: .npmrc 已配置 npmmirror 镜像。如果仍慢，尝试 `pnpm config set registry https://registry.npmmirror.com`。

### Q: better-sqlite3 编译失败？
A: 确保 Node.js >= 20 和 Python 3 已安装。或使用 Docker 方式部署。

### Q: playwright 浏览器下载失败？
A: playwright 是可选依赖。如不需要浏览器自动化，可忽略。如需要，设置镜像：`PLAYWRIGHT_DOWNLOAD_HOST=https://npmmirror.com/mirrors/playwright`。
