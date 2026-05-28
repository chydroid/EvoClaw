# ─── EvoClaw Dockerfile ──────────────────────────────────
# Multi-stage build: builder → production
# Usage:
#   docker build -t evoclaw .
#   docker run -p 17788:17788 --env-file .env -v evoclaw-data:/app/data evoclaw

# ─── Stage 1: Builder ─────────────────────────────────────
FROM node:24-alpine AS builder

RUN corepack enable && corepack prepare pnpm@10 --activate

WORKDIR /app

# Copy workspace config
COPY pnpm-workspace.yaml pnpm-lock.yaml package.json tsconfig.base.json ./

# Copy all packages and apps
COPY packages/ packages/
COPY apps/ apps/

# Install dependencies
RUN pnpm install --frozen-lockfile

# Build everything
RUN pnpm build

# ─── Stage 2: Production ──────────────────────────────────
FROM node:24-alpine AS production

RUN corepack enable && corepack prepare pnpm@10 --activate

WORKDIR /app

# Copy only production deps from builder
COPY --from=builder /app/node_modules/.pnpm /app/node_modules/.pnpm
COPY --from=builder /app/node_modules /app/node_modules

# Copy built packages
COPY --from=builder /app/packages /app/packages
COPY --from=builder /app/apps /app/apps

# Copy workspace config
COPY pnpm-workspace.yaml package.json ./

# Copy start script
COPY start.bat ./

# Create data directory
RUN mkdir -p /app/data/workspace /app/data/sessions /app/logs

# Note: packages/web-ui/dist/ is already copied from builder stage in line 39

# Environment
ENV NODE_ENV=production
ENV EvoClaw_HOST=0.0.0.0
ENV EvoClaw_PORT=17788

EXPOSE 17788

# Health check
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "const http=require('http');http.get('http://localhost:'+(process.env.EvoClaw_PORT||17788)+'/health',r=>{process.exit(r.statusCode===200?0:1)})"

CMD ["node", "--env-file=.env", "apps/server/dist/index.js"]