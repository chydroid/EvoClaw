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
- **对标基线（2026-10-12）**：`docs/hermes-alignment-roadmap.md` 是 EvoClaw 对标 Hermes Agent v0.21.6 的项目级提升方案基线。P0 两条欠账（files 恒空、token 事件体积平方增长）已于 v0.93 修复；后续迭代按该文件的 P0→P3 路线图推进，完成一项勾掉对应 checkbox。截至 2026-10-15：P0/P1/P2 及 P3 除「7 终端后端/serverless」（设计完成、实现排期在评测窗口外）外全部落地；发布流水线三件套齐备（release-prepare 脚本 + release.yml 两段式 + ghcr 口径统一），v0.92.5 已由 GitHub Release 的 receipt 资产验证两段式流水线端到端跑通；v0.92.7 同口径 receipt 验证通过（run 38742509991，receipt-v0.92.7.json：commitSha 6a2a8b9、stable ghcr.io/chydroid/evoclaw:v0.92.7 sha256:6c9e46be…、test …-test.6a2a8b9）；v0.92.8 同口径全绿（Release run 38837479511：commitSha 9369d57、stable sha256:b4c61a86…、test …-test.9369d57 sha256:14a44a88…、health=pass；CI/CD 38837479618 全绿）。
- **15 任务复杂评测（2026-10-15）**：/tmp/evoclaw-eval/eval15.mjs（驱动重建过一次）经 HTTP API 端到端跑 15 个复杂任务。首轮 0/15 → 修复后 13/15（t03 判定脚本自身 bug、t11 模型伪造完成态）→ 完成声明对账新增 write_claimed_not_executed 分支（v0.92.6）后复测中。已定位并修复的可靠性缺陷模式：① 绝对路径开头消息被误判斜杠命令；② 描述含 "Optional" 的参数被当成必填；③ shell_exec 结果缓存返回修复前旧输出（NO_RESULT_CACHE_TOOLS 豁免）；④ execute_code 软沙箱把 require() 当 ESM 跑（自动选 .cjs）；⑤ 换行硬拦无引导（block 信息附替代路径）；⑥ 只读工具跑过即放行伪造写完成态（写证据对账）。
- **多会话并行（2026-10-14）**：本机常有多个 Claude 会话同时改本仓库；动运行时资源（27789 server、/tmp/evoclaw-eval 评测驱动、浏览器）前先 `ListAgents` 确认所有权，曾因双开导致任务重复发送与 EADDRINUSE 竞速。
- **guardrails SQLi 误伤教训（2026-10-14）**：给 `ToolGuardrail` 规则加 `toolPattern: /./`（全工具生效）+ 含 `--\s*$`（多行）的模式会把源码注释分隔线误判成 SQL 注入并 block 写文件工具；任何"扫参数内容"的拦截规则都要先限定工具域、再用词界/引号锚定，防回归测试见 `packages/agent/src/guardrails.test.ts`。
- **guardrails SQLi `echo '---'` 误伤（2026-10-16）**：`'\s*--`（单引号后紧跟破折号）把 shell 分隔线用法 `echo '---'`/`echo '---' && df -h` 判成 SQL 注释注入并硬 block（末轮实例任务复跑中 4 条良性 shell_exec 全被拦，模型被迫绕路写脚本，任务对账为未完成）。修复：该分支追加负向前瞻 `(?![\-'"\w])`——真注释注入的特征是 `--` 后**不再**是破折号/引号/单词字符（如 `'admin' -- `），分隔线破折号串则放行。教训：引号锚定规则必须用负向前瞻区分「引号+破折号串（输出分隔线）」与「引号+SQL 注释符」。回归测试在 guardrails.test.ts「shell_exec 里 echo '---' 输出分隔线不被误拦」。
- better-sqlite3 v12.10.0 的预编译二进制（.node）在 pnpm install 时通过 .npmrc 配置的 `better-sqlite3_binary_host_mirror` 从 npmmirror 下载，ABI 137 匹配 Node v24，无需 `pnpm rebuild`。若 server-start.err 报 "native bindings not compiled"，先 `node -e "require('better-sqlite3')"` 测试，多为旧日志残留。
- 健康检查 `/health` 整体 status 为 `degraded` 属正常：personal_wechat 渠道启用但未连接（需扫码登录），非构建问题。
- server-start.err 中的 CanvasHost EPERM（无法创建 `C:\Users\CY\.evoclaw\canvas`）、DockerSandbox 不可用、可选 skill 缺 API key/二进制（jq/ffmpeg/fd/gh 等）、SkillRegistry 远程不可达，均为可选功能/外部依赖警告，不阻塞核心服务。
- git 钩子已配置：`git config core.hooksPath .githooks`，pre-commit 已 chmod +x（mode 100755），检查 secrets 和 console.log。
- **远端 ClawHub 技能的 SKILL.md frontmatter 可能是无效 YAML**（典型：`description: |` block scalar 中夹杂顶格中文段落，js-yaml 抛 "can not read a block mapping entry"）。修复见 `packages/skills/src/skill-md-parser.ts` 的 `parseFrontmatterLenient`：gray-matter 抛异常时用行级扫描抢救 name/version/description，避免技能因远端格式缺陷安装失败（name 回退到 H1 标题会触发命名规范校验失败）。正常技能仍走 gray-matter，零影响。
- WebUI marketplace API 认证用 Cookie `web_ui_token=<WEB_UI_TOKEN>`（非 Bearer JWT），值来自 .env 的 WEB_UI_TOKEN。
- **10 任务浏览器评测（2026-10-15，v0.92.7）**：`/tmp/evoclaw-eval/evalbrowser.mjs` 经 /api/chat 驱动 agent 的 browser_* 工具。首轮 6/10 → 修复四个根因后 10/10：① findElements 在去标签 bodyPreview 上匹配（rawHtml 修复）；② 双浏览器后端状态独立，navigate 需镜像到 Playwright；③ browser_tabs 需走 pwBrowser；④ browser_* 加入 NO_RESULT_CACHE_TOOLS。教训：github `/zen` 是**轮换**短句（同一分钟内观测 3 种），ground truth 不能锁定具体句子；dev-sidecar 中间人（CN=dev-sidecar 本地生成证书）导致 headless Chromium 对 api.github.com 报 ERR_CERT_AUTHORITY_INVALID（curl/node 不受影响，已信任）——镜像导航失败仅 warn，属环境因素非产品缺陷。
- **Playwright 环境 workaround（2026-10-15，WSL2 Ubuntu 26.04）**：完整 chromium 二进制缺失但 chrome-headless-shell（`~/.cache/ms-playwright/chromium_headless_shell-1223/…/chrome-headless-real`）可用；真实二进制被 rename 为 `chrome-headless-real`，符号链接指向 `/tmp/pw-debs/wrapper/chrome-headless-shell`（sh 脚本导出 `LD_LIBRARY_PATH=/tmp/pw-debs/root/usr/lib/x86_64-linux-gnu` 再 exec 真实二进制）；libnss3/libnspr4 经 `apt-get download` + `dpkg -x` 解包到 /tmp/pw-debs。server 默认 headless:true 直接可用。**/tmp 被清后需重建 /tmp/pw-debs（re-download deb + wrapper + rename 真实二进制）。**
- **实例任务评测（2026-10-16，worktemp.zip 14 文件 → 信阳市10月6日明查暗访问题清单.docx）**：驱动脚本 `/tmp/evoclaw-eval/instance-worktemp.mjs`（/api/chat + 自动审批 + python 解 docx 验证单位/行数；**/api/chat 需要 `Cookie: web_ui_token=<WEB_UI_TOKEN>`**，忘带会 401 空转全轮）。首轮暴露两个产品缺陷并修复：① `tool-privilege-sudo` argPattern 裸 `root` 子串命中 Python heredoc 的 `root = ET.fromstring(...)` 变量名（guardrails.ts 收窄为 sudo/su 组合词界）；② `validateToolParams` 对 array/object 参数收到合法 JSON 字符串时自动解析（LLM 把 docx_create 的 paragraphs/tables 序列化成字符串导致 "expected array, got string" 死循环，llm-caller.ts 加 JSON 字符串→真数组/对象强制转换，object 期望须排除数组）。回归测试在 guardrails.test.ts / llm-caller.test.ts。
- **安全等级「一般安全」的 newline_injection 规则会拦多行 shell_exec（2026-10-16）**：agent 生成含换行的多行 shell 命令（如 `cat > x.py << EOF … EOF; python3 x.py` 或带反斜杠换行的脚本）会被「一般安全」等级以 `rule=newline_injection` block，block 信息自带引导：改用 file_create 写 .py/.js 后 shell_exec 执行文件，或 execute_code。这是**产品设计的纵深防御**（不是缺陷，可通过「安全 → 总体安全」调等级放开），但有两点要记住：① 写驱动/验收脚本时看到「工具执行失败（换行符）」不要误判成回归——先读 block 消息里的替代路径；② 该 block 会计入对账器的「本回合有工具执行失败」证据，回复末尾会追加「⚠️ 任务未完成」尾注（对账行为正确，模型下轮自愈后消失）。评测 driver 里给多行脚本类任务时，直接在消息里提示「多行脚本用 file_create 写文件再执行」可省一轮绕路。
- **评测 driver 审批必须与 chat 并行轮询（2026-10-16）**：/api/chat 是非阻塞审批模型——遇到 requiresApproval 工具时该轮立即返回（工具结果标记 pendingApproval），审批 Promise 在 server 侧挂起；HITL 审批默认 5 分钟超时。若 driver 把审批轮询**串行**放在 chat fetch 之后（像 instance-followup2/3.mjs 那样），5 分钟超时先到期，agent 收尾对账为「等待审批中」→ 回复尾注「⚠️ 任务未完成」，实际任务可批完即续。正确写法：审批轮询器（15s 间隔）与 chat 并行跑（instance-followup4.mjs 模板），chat 返回后继续轮询 3 分钟兜底。
- **/tmp 会被清空（WSL 重启/周期清理）**：/tmp/evoclaw-eval 下所有评测 driver、server 日志、/tmp/pw-debs（Playwright workaround）都会丢；server 进程也随重启消失。恢复手段：driver 脚本用 heredoc 重建（内容在会话里留存）；Playwright 按上面 workaround 条目重新解包；server 直接 `node apps/server/dist/index.js` 重启。**跨 /tmp 清空的长任务收尾，提示词必须把已验证事实写死在 prompt 里（mtime/大小/测试计数），让新会话直接核对而非重跑长任务。**
- **GitHub 直连临时绕过 dev-sidecar（2026-10-16，C 方案·不落盘）**：本机 `dev-sidecar`（docmirror）MITM 代理 `127.0.0.1:31181`（`HTTPS_PROXY` 指向它）对 `api.github.com` 等 GitHub 系域名签发本地 `CN=*.github.com, O=dev-sidecar` 叶子证书，其**中间 CA 缺 Authority Key Identifier**，OpenSSL 3.5 严格校验报 `certificate verify failed: Missing Authority Key Identifier`；把自签根证书加进 `ca-certificates.crt`/cafile **也修不了**（缺 AKI 是证书本身缺陷）。而 GitHub 直连本身可用。用户选择 C（不落盘）：需要 GitHub 直连时在**该条命令**前临时挂白名单即可，不写 `~/.bashrc`/`.env`：
  ```bash
  NO_PROXY="api.github.com,github.com,*.github.com,raw.githubusercontent.com,objects.githubusercontent.com,codeload.github.com" \
  no_proxy="$NO_PROXY" \
  python3 your_script.py   # 或 curl / node / git 等
  ```
  已实测：临时设 → `api.github.com` rate_limit 200；不设（走 sidecar）→ 仍报 AKI 错（默认行为未变）。注意：会话脚本里 `ssl.CERT_NONE`（关校验）只是应急，**不要当常规做法**。
- **会话 sess_mvasc4w8 复盘的三处工具层缺陷（2026-10-16，commit 21af12b）**：agent 执行「GitHub 搜上升快、star>2000 的开源软件→写公众号文章」任务暴露：① `tool-shell-injection` 的 `&&\s*curl`/`\|\s*wget` 分支把合法「下载+处理」链路（`curl -s URL -o x.json && python3 …`）硬拦→模型改走 Python 直连再撞 sidecar AKI；修复：curl/wget 仅下载非破坏性，从各操作符后分支移除，破坏性集合（rm/del/format/shutdown/reboot/nc/ncat）不变。② `web_fetch` 结果被截断（`"truncated":true`，只拿到第 1 条数据）时 llm-caller 仍注入 "Do NOT search again"→模型产出残稿；修复：结果含 `"truncated":true` 时跳过该提示。③ `scrapling_fetch`/`runPythonScriptAsync` 硬编码 `spawn("python")`，发行版只装 python3 时 `ENOENT`；修复：新增 resolvePython/resolvePythonBin（EVOCLAW_PYTHON_BIN→python→python3）。回归测试见 guardrails.test.ts。
- **v0.92.9 全面审计复盘（2026-10-17，agent 包 Explore 审计 + 主会话逐条核实后修复 7 处）**：基线 build→typecheck→test 全绿（269 文件 / 6272 passed，13 skipped）。修复并加回归测试：
  - **P1-1 OpenAI 原生流式 usage 被 guard 吞（llm-caller parseStreamingResponse）**：`if (!choice?.delta) continue` 在读 usage 前执行，原生 OpenAI 末块 `{"choices":[],"usage":{…}}` 永远读不到 usage/prompt/finish → 3d3588b 的「provider 缓存命中真值」在原生 OpenAI 流式路径失效（tokensUsed 退化为 len/4 估算、cacheHit 恒 0）。修复：usage/finish 在 guard 前读取。回归：llm-caller.test.ts 新增 P1-1 流（末块 choices 空 + 带 cached_tokens，断言 promptTokens/tokensUsed/usageDetails）。
  - **P1-2 Token 用量同一轮被记 2 遍（agent-model-executor.chat）**：executor 在 llm-caller 逐次 record（4 处，含 cache 明细）后又按 `result.tokensUsed`（全轮 total_tokens 之和、且 total_tokens 被误当 inputTokens）再记一条 → TokenUsagePage 总量/成本/cacheHitRate 虚高。修复：executor 主路径删除该 record（保留 skill-fallback 本地路径，LLM 全挂时 llm-caller 无记录）。
  - **P2-1 CE 分支当前 user 消息重复注入 2 次（llm-caller tryCallLLM）**：ContextEngine.assembleContext 已 push currentTask，llm-caller 又 push effectiveMessage → 请求里两条连续 user 消息。修复：CE 分支不再二次 push；纯文本把 CE 末条 user 替换为 llm-caller 传入的 message（增强版，去重且不丢搜索/新闻上下文），多模态把末条 user 换成 parts 版（CE 只拼字符串 currentTask，不感知附件）。回归：llm-caller.test.ts 新增 P2-1（http server 捕获真实请求体断言 user 消息条数）。
  - **P2-2 PromptRegistry 未自注册内置模板（prompt-registry）**：`format("web.tool_strategy")` 等在非 server 宿主上抛「not registered」被外层 catch 吞成「LLM 调用失败/空响应」。修复：ensureLoaded() 内先自注册 BUILTIN_TEMPLATES（幂等、不覆盖磁盘/用户注册，加 builtinsRegistered 防递归）。
  - **P3-1 guardrails 反引号/`$()` 分支 nc/ncat 加固（guardrails tool-shell-injection）**：审计称 21af12b 误删了 nc/ncat（经核实原 3d3588b 这两分支**本就**不含 nc，非本次回归，但确为既有漏拦，`$(nc …)`/`` `nc …` `` 可反弹 shell）——补回 nc/ncat 并加 `\b` 词界（避免 `python -c "…connect(nc)"` 子串误伤）。回归：guardrails.test.ts 新增子命令 nc/ncat 拦截。
  - **P4 extension-registry 动态 import 临时目录扩展失败（extension-registry + vitest.config）**：`"file:///" + fullPath` 对 POSIX 绝对路径（/tmp/…）拼出四斜杠畸形 URL，Vite（vitest）resolver 拒绝 → `loadExtension` 在 mkdtemp 扩展场景失败（Node 自身 importer 容忍、Vite 不容忍，故仅在测试暴露）。修复：`pathToFileURL(fullPath).href` 生成规范 URL + vitest server.fs.allow 放行 tmpdir。回归：extension-registry.test.ts 2 例由 fail 转 pass。
  - **不修的 P3-2（sessionToolGroups/conversationHistory 无界）**：已有 retention 过期驱动 clearChatHistory 清理（protocol-adapter 7742），且 maxHistoryLength=200 为 P0-1 有意设计（CompactionManager 才是结构改写点），非缺陷，避免过度改动。
  - **不修的 P3-3（cacheControlAnnotations 无消费者）**：context-engine 产出该字段（带 charOffset）但 llm-caller 走 `applyAnthropicCacheControl(messages, frozenBoundary)`，属死输出/双实现并存，非「错误结果」——留作后续统一断点策略的重构，不在本次 bug 修复范围。
  修复后 build→typecheck→test 全绿（269 文件 / 6275 passed，13 skipped，+3 新增断言）。
- **v0.93.0 后关键流程全面审计（2026-10-17，4 个 Explore 子代理并行 + 主会话逐条核实）**：基线 build→typecheck→test 全绿。确认是 bug 才修，共修复 20 处、补 5 组回归测试，修后 build→typecheck→test 全绿（271 文件 / 6282 passed，13 skipped）。修复清单：
  - **shell-media-tools execute_code**：背压上限误用生命周期累计值 pendingCount（只增不减）→ 改判积压队列 `queue.length > MAX_PENDING`。
  - **skill-tools skill_create（SKILL-1）**：经 FileSystemManager.createFile 传绝对路径恒抛 "Access denied: absolute paths" → 改直接 node:fs 写 `data/skills/<name>/SKILL.md` 再 installSkill。
  - **apps/server index.ts**：initMigrations 的 `path.resolve("data")` 锚定启动 cwd → 改 `__dirname` 三层上溯。
  - **email-client（EM1/EM2）**：纯文本 body 直接进 html 无转义 → 新增 escapeHtml；imapflow fetchOne 缺 `uid: true` 按序列号误取 → 补选项（对照 imapflow@1.3.3 源码 L2934 验证）。
  - **evolution-engine（E1）**：沙箱失败早退未置 completedAt/schedulePersist → 循环记录永久"进行中"。
  - **cron-scheduler（S1）**：超时后提前释放 running 去重槽，同 job 双实例并发 → 先 `await taskPromise` settle 再抛（回归测试断言超时后第二次 executeJob 被跳过）。
  - **skill-curator（K1/K3）**：pinned 判定 Map 键（UUID）≠ 目录名时单键匹配落空 → isSkillPinned 双键 + isSkillPinnedAsync 经 skillManager.listSkills 目录名→id 解析（回归测试注册 fake skillManager）；restoreSkill 不清 deprecation 死状态 → 恢复后清 null + schedulePersist。
  - **mcp-poisoning-scanner（SEC1）**：黑名单 addBlacklistPattern 是 no-op（fail-open）→ blacklistCompiled 缓存 + effectivePatterns() 进 scan/sanitize，FIFO 淘汰同步删缓存（回归测试 2 例）。
  - **vector-memory（M1）**：384→256 维切换后旧索引锁死 → resetDimension(newDim) 清空并锁新维（回归测试）；memory-hub installLocalFallback 建 store 后调之并打印 dropped。
  - **memory-hub（M3/M4）**：FTS5 回退用 rowid 冒充记忆 id → 取 metadata.id；LongTermMemoryStore.expire/delete 不联动 FTS5/向量删除 → 构造注入 onEntriesRemoved 回调（forgetMemory 可选链）。
  - **tenant-manager（SEC2）**：checkQuota 无 stats 时 fail-open → 按需 createEmptyStats 让配额照常生效。
  - **process-manager**：kill() 已退出分支把 exit 监听器标的 "crashed" 覆盖成 "stopped" → 仅 running 时改写。
  - **docx-tools（DOCX-UNIT）**：ImageRun.transformation 传英寸值被 docx.js 当像素（96 DPI）→ ×96。
  - **message-queue（MQ-1）**：退避 timer 回调直接重入 processTopic，与仍在跑的循环并发 → 持锁期间到点只置 backoffFired 标记由持锁循环消费，锁已释放才重入（回归测试 2 例）。
  - **scheduler-tools**：scheduled shell 默认 cwd 用 process.cwd()（split brain）→ 改 `__dirname` 4 层与 shell_exec 对齐。
  - **gateway ws-protocol（GW-1）**：幂等重放 `{...cached.result, id}` 注释写反——对象字面量后写属性胜出，实为正确行为；仅订正注释（agent 报告误判，未改行为）。
  - **mcp-protocol-handler（MCPGW-1）**：executeTool 抛错返回 result.content 无 `isError: true`，MCP 客户端把失败当成功 → 补标记 + handleToolCall 返回类型加 isError。
  - **dead-letter-queue（GW-DLQ-1）**：delete/writeAll 对遗留 JSONL 整文件删除（delete(A) 把 B 也删了、purge 误杀保留行）→ 行级过滤原子写回。
  - **gateway-server（GW-MSG-1）**：message.send 恒回 `delivered: true` → 按 ChannelSendResult.success 计算。
  不修记录（设计取舍/误报，勿重复上报）：SEC4 agentPolicy `*` 短路命名策略（注释声明 first-most-specific-wins）；SEC3/S2 cron 解析器与 conformance 校验器口径差异（spec 待决）；ServiceRegistry stopAll / EventBus 超时吞错 / ProcessSupervisor 永久放弃重试（设计）；DLQ getStats 把 replayed 计入 total（统计口径，文档已注明）；retry-all 端点无真实 resend 路径（"标记未重放"语义，属既有 API 契约而非本次缺陷）；ChannelManager.handleIncomingMessage 死代码与入站策略门绕路（attachAdapter 直连 messageHandler 是既有布线，修复属架构改动超出本轮 bug 范围——记录在案）；Weixin 适配器 stopMonitor 不 notifyStop / sendMessage false 静默（微信渠道为可选外部依赖，记录在案）。
  验证：build 12 包+2 应用全绿 → typecheck 全绿 → test 6282 passed。未推送（等用户指令）。
- **第二轮 10 任务复跑（2026-10-17，eval10.mjs 重跑，server 已用含三处修复的 dist 重启）**：t01-t08 全 PASS，t09/t10 为「非产品缺陷」：
  - **三处修复确认生效**：t02（WS-DUP 嵌套目录）、t04（ACP-FIX 委派不再假完成）、t06（SCHED-WSDUP 定时任务嵌套写）全部转 PASS。
  - **t09（27999 残留）非产品缺陷**：任务要求「启动微服务→验证→停掉」，模型两次都只启动不 kill。本机 `kill <pid>` 在复合命令里偶发 exit 144（疑似 shell 信号），需 `pgrep -af "server.mjs"` 先拿到真实 PID（模型 nohup 起的进程 ppid=1，`pgrep -f eval10/t09` 抓不到）再单独 kill。教训：评测 driver 里「启动后台服务」类任务的验收应直接查端口而非依赖模型自觉 kill。
  - **t10（avg.txt 假阴性）非产品缺陷**：avg.txt 实为 `32.80`（5 字节，与 CSV 交叉核对均值 32.80、top3 重庆39/广州38/深圳36 全对），是 driver verify 在文件写入瞬间读到旧内容的竞态；复算 `/\d+\.\d{2}/.test("32.80")`=true，当前逻辑正确。
  - **t05 driver bug（非产品）**：verify 仍用 `unzip`（本机未装）→ 改 python3 zipfile。
- **主菜单缺口审计（2026-10-17，packages/web-ui/src/App.tsx 的 NAV_GROUPS vs renderPage case 分支 + gateway 全部 /api 路由）**：**所有 case 分支都有菜单项，无死渲染**；缺口在「能力有但没入口」：
  - **email**：agent 工具齐（email_add_account/email_send/email_analyze，apps/server/src/tools/email-tools.ts，registerEmailTools 在 index.ts:1800 注册），feature flag `emailIntegration` 默认 false，但 **WebUI 无邮件页面、gateway 无 /api/email 路由** → 菜单无入口。
  - **reporting**：仅 `/api/reporting/templates`（protocol-adapter.ts:3407）+ scheduler 的 report_generate handler，**WebUI 无报告页面**。
  - **commitments**：`/api/commitments` 路由存在（CommitmentManager 在 agent 包），**WebUI 无对应页面**（grep commitments 在 web-ui/src 全空）。
  - 已有页面覆盖的：/api/executions→ObservabilityPage、/api/intelligence/classify→EnhancementHubPage、/api/files/*→CanvasPage、/api/kanban→KanbanBoardPage、/api/marketplace→SkillsConfig、/api/system/providers→Dashboard。**建议（未实施）**：email/reporting/commitments 三处补 WebUI 页面入口。
