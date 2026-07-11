# Project Memory

## 约定
- EvoClaw 是 TypeScript pnpm monorepo，14 个内部包 + 2 个应用，端口 27788。
- 验证顺序必须为 `pnpm build -> pnpm typecheck -> pnpm test`（包间互相引用 dist 产物）。

## 约束
- pnpm 已通过 `corepack enable pnpm --install-directory "C:\Users\CY\AppData\Roaming\npm"` 安装 shim（2026-07-09）。该目录在 User PATH 中，新终端可直接用 `pnpm` / `pnpm -r build` / `pnpm -r typecheck`，无需再写 `corepack pnpm`。
- git 命令行缺失，用户将自行手动安装（EvoClaw 是 git 仓库且有 `.githooks/pre-commit`，安装后运行 `setup-hooks.bat`）。
- User PATH 已含 `C:\Users\CY\AppData\Local\pnpm`（pnpm 全局包目录，未来 `pnpm install -g <cli>` 用）。
- 启动服务器：`chcp 65001 > $null; node --max-old-space-size=4096 --env-file=.env apps/server/dist/index.js`（Windows）。
- 本机 npm 全局代理已于 2026-07-08 永久清除（原指向未运行的 127.0.0.1:31180/31181），registry 切换为 https://registry.npmmirror.com。

## 经验教训
- better-sqlite3 v12.10.0 的预编译二进制（.node）在 pnpm install 时通过 .npmrc 配置的 `better-sqlite3_binary_host_mirror` 从 npmmirror 下载，ABI 137 匹配 Node v24，无需 `pnpm rebuild`。若 server-start.err 报 "native bindings not compiled"，先 `node -e "require('better-sqlite3')"` 测试，多为旧日志残留。
- 健康检查 `/health` 整体 status 为 `degraded` 属正常：personal_wechat 渠道启用但未连接（需扫码登录），非构建问题。
- server-start.err 中的 CanvasHost EPERM（无法创建 `C:\Users\CY\.evoclaw\canvas`）、DockerSandbox 不可用、可选 skill 缺 API key/二进制（jq/ffmpeg/fd/gh 等）、SkillRegistry 远程不可达，均为可选功能/外部依赖警告，不阻塞核心服务。
- git 钩子已配置：`git config core.hooksPath .githooks`，pre-commit 已 chmod +x（mode 100755），检查 secrets 和 console.log。
- **远端 ClawHub 技能的 SKILL.md frontmatter 可能是无效 YAML**（典型：`description: |` block scalar 中夹杂顶格中文段落，js-yaml 抛 "can not read a block mapping entry"）。修复见 `packages/skills/src/skill-md-parser.ts` 的 `parseFrontmatterLenient`：gray-matter 抛异常时用行级扫描抢救 name/version/description，避免技能因远端格式缺陷安装失败（name 回退到 H1 标题会触发命名规范校验失败）。正常技能仍走 gray-matter，零影响。
- WebUI marketplace API 认证用 Cookie `web_ui_token=<WEB_UI_TOKEN>`（非 Bearer JWT），值来自 .env 的 WEB_UI_TOKEN。
