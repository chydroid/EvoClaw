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
RUN pnpm prune --prod

# ─── Stage 2: Production ──────────────────────────────────
FROM node:24-alpine AS production

WORKDIR /app

# Copy pruned node_modules from builder
COPY --from=builder /app/node_modules /app/node_modules

# Copy built packages
COPY --from=builder /app/packages /app/packages
COPY --from=builder /app/apps /app/apps

# Copy workspace config
COPY pnpm-workspace.yaml package.json ./

# Create data directory
RUN mkdir -p /app/data/workspace /app/data/sessions /app/logs

# Environment
ENV NODE_ENV=production
ENV EvoClaw_HOST=0.0.0.0
ENV EvoClaw_PORT=27788

EXPOSE 27788

# Health check
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "const http=require('http');http.get('http://localhost:'+(process.env.EvoClaw_PORT||27788)+'/health',r=>{process.exit(r.statusCode===200?0:1)})"

# Run as non-root user for security
RUN addgroup -S evoclaw && adduser -S evoclaw -G evoclaw
RUN chown -R evoclaw:evoclaw /app
USER evoclaw

CMD ["node", "--env-file=.env", "apps/server/dist/index.js"]
