# Project Memory

## 约定
- EvoClaw 是 TypeScript pnpm monorepo，14 个内部包 + 2 个应用；**实际运行端口以 `.env` 的 `EvoClaw_PORT=27789` 为准**（代码/文档默认 27788 仅在未设该变量时生效；server 只绑 IPv4，健康检查用 `127.0.0.1:27789`）。
- 验证顺序必须为 `pnpm build -> pnpm typecheck -> pnpm test`（包间互相引用 dist 产物）。

## 约束
- pnpm 已通过 `corepack enable pnpm --install-directory "C:\Users\CY\AppData\Roaming\npm"` 安装 shim（2026-07-09）。该目录在 User PATH 中，新终端可直接用 `pnpm` / `pnpm -r build` / `pnpm -r typecheck`，无需再写 `corepack pnpm`。
- git 命令行缺失，用户将自行手动安装（EvoClaw 是 git 仓库且有 `.githooks/pre-commit`，安装后运行 `setup-hooks.bat`）。
- User PATH 已含 `C:\Users\CY\AppData\Local\pnpm`（pnpm 全局包目录，未来 `pnpm install -g <cli>` 用）。
- 启动服务器：`chcp 65001 > $null; node --max-old-space-size=4096 --env-file=.env apps/server/dist/index.js`（Windows）。
- 本机 npm 全局代理已于 2026-07-08 永久清除（原指向未运行的 127.0.0.1:31180/31181），registry 切换为 https://registry.npmmirror.com。

## 经验教训
- **对标基线（2026-10-12）**：`docs/hermes-alignment-roadmap.md` 是 EvoClaw 对标 Hermes Agent v0.21.6 的项目级提升方案基线。P0 两条欠账（files 恒空、token 事件体积平方增长）已于 v0.93 修复；后续迭代按该文件的 P0→P3 路线图推进，完成一项勾掉对应 checkbox。截至 2026-10-15：P0/P1/P2 及 P3 除「7 终端后端/serverless」（设计完成、实现排期在评测窗口外）外全部落地；发布流水线三件套齐备（release-prepare 脚本 + release.yml 两段式 + ghcr 口径统一），v0.92.5 已由 GitHub Release 的 receipt 资产验证两段式流水线端到端跑通；v0.92.7 同口径 receipt 验证通过（run 38742509991，receipt-v0.92.7.json：commitSha 6a2a8b9、stable ghcr.io/chydroid/evoclaw:v0.92.7 sha256:6c9e46be…、test …-test.6a2a8b9）。
- **15 任务复杂评测（2026-10-15）**：/tmp/evoclaw-eval/eval15.mjs（驱动重建过一次）经 HTTP API 端到端跑 15 个复杂任务。首轮 0/15 → 修复后 13/15（t03 判定脚本自身 bug、t11 模型伪造完成态）→ 完成声明对账新增 write_claimed_not_executed 分支（v0.92.6）后复测中。已定位并修复的可靠性缺陷模式：① 绝对路径开头消息被误判斜杠命令；② 描述含 "Optional" 的参数被当成必填；③ shell_exec 结果缓存返回修复前旧输出（NO_RESULT_CACHE_TOOLS 豁免）；④ execute_code 软沙箱把 require() 当 ESM 跑（自动选 .cjs）；⑤ 换行硬拦无引导（block 信息附替代路径）；⑥ 只读工具跑过即放行伪造写完成态（写证据对账）。
- **多会话并行（2026-10-14）**：本机常有多个 Claude 会话同时改本仓库；动运行时资源（27789 server、/tmp/evoclaw-eval 评测驱动、浏览器）前先 `ListAgents` 确认所有权，曾因双开导致任务重复发送与 EADDRINUSE 竞速。
- **guardrails SQLi 误伤教训（2026-10-14）**：给 `ToolGuardrail` 规则加 `toolPattern: /./`（全工具生效）+ 含 `--\s*$`（多行）的模式会把源码注释分隔线误判成 SQL 注入并 block 写文件工具；任何"扫参数内容"的拦截规则都要先限定工具域、再用词界/引号锚定，防回归测试见 `packages/agent/src/guardrails.test.ts`。
- better-sqlite3 v12.10.0 的预编译二进制（.node）在 pnpm install 时通过 .npmrc 配置的 `better-sqlite3_binary_host_mirror` 从 npmmirror 下载，ABI 137 匹配 Node v24，无需 `pnpm rebuild`。若 server-start.err 报 "native bindings not compiled"，先 `node -e "require('better-sqlite3')"` 测试，多为旧日志残留。
- 健康检查 `/health` 整体 status 为 `degraded` 属正常：personal_wechat 渠道启用但未连接（需扫码登录），非构建问题。
- server-start.err 中的 CanvasHost EPERM（无法创建 `C:\Users\CY\.evoclaw\canvas`）、DockerSandbox 不可用、可选 skill 缺 API key/二进制（jq/ffmpeg/fd/gh 等）、SkillRegistry 远程不可达，均为可选功能/外部依赖警告，不阻塞核心服务。
- git 钩子已配置：`git config core.hooksPath .githooks`，pre-commit 已 chmod +x（mode 100755），检查 secrets 和 console.log。
- **远端 ClawHub 技能的 SKILL.md frontmatter 可能是无效 YAML**（典型：`description: |` block scalar 中夹杂顶格中文段落，js-yaml 抛 "can not read a block mapping entry"）。修复见 `packages/skills/src/skill-md-parser.ts` 的 `parseFrontmatterLenient`：gray-matter 抛异常时用行级扫描抢救 name/version/description，避免技能因远端格式缺陷安装失败（name 回退到 H1 标题会触发命名规范校验失败）。正常技能仍走 gray-matter，零影响。
- WebUI marketplace API 认证用 Cookie `web_ui_token=<WEB_UI_TOKEN>`（非 Bearer JWT），值来自 .env 的 WEB_UI_TOKEN。
- **10 任务浏览器评测（2026-10-15，v0.92.7）**：`/tmp/evoclaw-eval/evalbrowser.mjs` 经 /api/chat 驱动 agent 的 browser_* 工具。首轮 6/10 → 修复四个根因后 10/10：① findElements 在去标签 bodyPreview 上匹配（rawHtml 修复）；② 双浏览器后端状态独立，navigate 需镜像到 Playwright；③ browser_tabs 需走 pwBrowser；④ browser_* 加入 NO_RESULT_CACHE_TOOLS。教训：github `/zen` 是**轮换**短句（同一分钟内观测 3 种），ground truth 不能锁定具体句子；dev-sidecar 中间人（CN=dev-sidecar 本地生成证书）导致 headless Chromium 对 api.github.com 报 ERR_CERT_AUTHORITY_INVALID（curl/node 不受影响，已信任）——镜像导航失败仅 warn，属环境因素非产品缺陷。
- **Playwright 环境 workaround（2026-10-15，WSL2 Ubuntu 26.04）**：完整 chromium 二进制缺失但 chrome-headless-shell（`~/.cache/ms-playwright/chromium_headless_shell-1223/…/chrome-headless-real`）可用；真实二进制被 rename 为 `chrome-headless-real`，符号链接指向 `/tmp/pw-debs/wrapper/chrome-headless-shell`（sh 脚本导出 `LD_LIBRARY_PATH=/tmp/pw-debs/root/usr/lib/x86_64-linux-gnu` 再 exec 真实二进制）；libnss3/libnspr4 经 `apt-get download` + `dpkg -x` 解包到 /tmp/pw-debs。server 默认 headless:true 直接可用。**/tmp 被清后需重建 /tmp/pw-debs（re-download deb + wrapper + rename 真实二进制）。**
- **实例任务评测（2026-10-16，worktemp.zip 14 文件 → 信阳市10月6日明查暗访问题清单.docx）**：驱动脚本 `/tmp/evoclaw-eval/instance-worktemp.mjs`（/api/chat + 自动审批 + python 解 docx 验证单位/行数；**/api/chat 需要 `Cookie: web_ui_token=<WEB_UI_TOKEN>`**，忘带会 401 空转全轮）。首轮暴露两个产品缺陷并修复：① `tool-privilege-sudo` argPattern 裸 `root` 子串命中 Python heredoc 的 `root = ET.fromstring(...)` 变量名（guardrails.ts 收窄为 sudo/su 组合词界）；② `validateToolParams` 对 array/object 参数收到合法 JSON 字符串时自动解析（LLM 把 docx_create 的 paragraphs/tables 序列化成字符串导致 "expected array, got string" 死循环，llm-caller.ts 加 JSON 字符串→真数组/对象强制转换，object 期望须排除数组）。回归测试在 guardrails.test.ts / llm-caller.test.ts。
