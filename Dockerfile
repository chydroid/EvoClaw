# ─── EvoClaw Dockerfile ──────────────────────────────────
# Multi-stage build: builder → production
# Usage:
#   docker build -t evoclaw .
#   docker run -p 27788:27788 --env-file .env -v evoclaw-data:/app/data evoclaw

# ─── Stage 1: Builder ─────────────────────────────────────
FROM node:24-alpine AS builder

# better-sqlite3 v12.10.0 仅提供 Electron prebuilt，Node.js 运行时需从源码编译。
# alpine 默认无 python3/make/g++，安装原生编译工具链以支持 node-gyp。
# 多阶段构建，最终镜像不包含这些工具。
RUN apk add --no-cache python3 make g++

RUN corepack enable && corepack prepare pnpm@10 --activate

WORKDIR /app

# Step 1: Copy only package.json files for dependency caching
COPY pnpm-workspace.yaml pnpm-lock.yaml package.json tsconfig.base.json ./
COPY .npmrc ./
COPY packages/core/package.json packages/core/
COPY packages/agent/package.json packages/agent/
COPY packages/gateway/package.json packages/gateway/
COPY packages/skills/package.json packages/skills/
COPY packages/memory/package.json packages/memory/
COPY packages/security/package.json packages/security/
COPY packages/evolution/package.json packages/evolution/
COPY packages/infrastructure/package.json packages/infrastructure/
COPY packages/scheduler/package.json packages/scheduler/
COPY packages/reporting/package.json packages/reporting/
COPY packages/intelligence/package.json packages/intelligence/
COPY packages/plugin-sdk/package.json packages/plugin-sdk/
COPY packages/email/package.json packages/email/
COPY packages/claude-code-tools/package.json packages/claude-code-tools/
COPY packages/web-ui/package.json packages/web-ui/
COPY apps/server/package.json apps/server/
COPY apps/cli/package.json apps/cli/
COPY apps/mcp-server/package.json apps/mcp-server/

# Step 2: Install dependencies (cached unless package.json changes)
RUN pnpm install --frozen-lockfile

# Step 3: Copy source code and build
COPY packages/ packages/
COPY apps/ apps/
RUN pnpm build

# Step 4: Prune dev dependencies for production
# CI=true 避免 pnpm prune 因缺少 TTY 而交互式确认失败
ENV CI=true
RUN pnpm prune --prod

# ─── Stage 2: Production ──────────────────────────────────
FROM node:24-alpine AS production

# 2026-10-15 v0.92.4 修复（release 两段式流水线首次冒烟发现）：
# 旧实现只 COPY builder 的根 node_modules + 已构建的 packages/apps，
# 但 pnpm workspace 把各包的生产依赖放在 per-package node_modules
# （apps/server/node_modules/dotenv → 根 .pnpm store 的相对符号链接），
# 符号链接在容器内解析目标布局与 builder 不一致 → 容器启动
# "Cannot find module 'dotenv'"，/health 永不就绪。
# 修复：生产阶段独立做完整 pnpm install（frozen lockfile），
# 从 builder 只取编译产物 dist；原生模块（better-sqlite3）在 alpine
# 容器内源码编译，需要 python3/make/g++。
RUN corepack enable && corepack prepare pnpm@10 --activate \
  && apk add --no-cache python3 make g++

WORKDIR /app

# Step 1: 各包清单 + lockfile（依赖缓存层）
COPY pnpm-workspace.yaml pnpm-lock.yaml package.json tsconfig.base.json ./
COPY .npmrc ./
COPY packages/core/package.json packages/core/
COPY packages/agent/package.json packages/agent/
COPY packages/gateway/package.json packages/gateway/
COPY packages/skills/package.json packages/skills/
COPY packages/memory/package.json packages/memory/
COPY packages/security/package.json packages/security/
COPY packages/evolution/package.json packages/evolution/
COPY packages/infrastructure/package.json packages/infrastructure/
COPY packages/scheduler/package.json packages/scheduler/
COPY packages/reporting/package.json packages/reporting/
COPY packages/intelligence/package.json packages/intelligence/
COPY packages/plugin-sdk/package.json packages/plugin-sdk/
COPY packages/email/package.json packages/email/
COPY packages/claude-code-tools/package.json packages/claude-code-tools/
COPY packages/web-ui/package.json packages/web-ui/
COPY apps/server/package.json apps/server/
COPY apps/cli/package.json apps/cli/
COPY apps/mcp-server/package.json apps/mcp-server/

# Step 2: 完整安装（frozen lockfile，恢复 pnpm per-package node_modules 布局）
RUN pnpm install --frozen-lockfile

# Step 3: 编译产物从 builder 取（builder 内已 pnpm build）
COPY --from=builder /app/packages /app/packages
COPY --from=builder /app/apps /app/apps

# Create data directory
RUN mkdir -p /app/data/workspace /app/data/sessions /app/logs

# Environment
ENV NODE_ENV=production
ENV EvoClaw_HOST=0.0.0.0
ENV EvoClaw_PORT=27788

EXPOSE 27788

# Health check — start-period=30s 给启动足够时间，retries=5 增强恢复能力
HEALTHCHECK --start-period=30s --interval=30s --timeout=10s --retries=5 \
  CMD node -e "const http=require('http');http.get('http://localhost:'+(process.env.EvoClaw_PORT||27788)+'/health',r=>{process.exit(r.statusCode===200?0:1)})"

# Run as non-root user for security
RUN addgroup -S evoclaw && adduser -S evoclaw -G evoclaw
RUN chown -R evoclaw:evoclaw /app
COPY --chown=evoclaw:evoclaw assets ./assets
USER evoclaw

CMD ["node", "--max-old-space-size=4096", "--env-file-if-exists=.env", "apps/server/dist/index.js"]
