# EvoClaw 版本历史记录 (History)

> 本项目遵循语义化版本，记录每次代码修改、功能调整及系统变更的详细内容。
> 每次成功构建后更新此文件，按时间倒序排列。

---

## v0.4.7 (2026-05-24)

### 聊天输入框优化

- **文件**: `packages/web-ui/src/WebChatPage.tsx`
- **改动**:
  - 移除右侧"新会话"文字按钮（左侧菜单已有此功能）
  - 输入框最小高度从 40px 调整为 60px（约两行高度）

### 消息气泡复制按钮优化

- **文件**: `packages/web-ui/src/WebChatPage.tsx`
- **改动**:
  - 气泡悬停时仅显示复制图标 📋，不再显示文字
  - 鼠标悬停在复制图标上时才显示"复制为 Markdown"提示文字
  - 优化按钮样式：透明背景、无边框、更小 padding

---

## v0.4.6 (2026-05-24)

### 输入框工具栏功能完善

- **文件**: `packages/web-ui/src/WebChatPage.tsx`
- **新增功能**:
  - **附加文件 📎**: 点击打开文件选择器，支持多选，文件附加到消息发送
  - **设置 ⚙**: 点击发送 `evoclaw-open-settings` 自定义事件，打开右上角设置弹窗
  - **导出 📥**: 导出整个对话记录为 Markdown 文件下载
  - **新会话 +**: 点击清空对话，显示欢迎消息，同时清空附件列表
  - **语音输入 🎤**: 已禁用（显示半透明），提示"暂未支持"
- **上下文使用进度条**: 变量已预留（`contextUsed`/`contextLimit`），可接入真实 token 统计
- **输入框提示**: 改为 `给 {机器人昵称} 发消息 · Shift+Enter 换行 · Enter 发送`

### 消息气泡交互增强

- **文件**: `packages/web-ui/src/WebChatPage.tsx`
- **功能**:
  - EvoClaw 消息气泡鼠标悬停时边框高亮（主题蓝色）+ 阴影效果
  - 悬停时气泡右上角显示"📋 复制为 Markdown"按钮
  - 点击按钮将消息复制为格式化的 Markdown 文本（包含昵称、时间戳、内容）
  - 用户消息气泡不受影响
- **影响**: 用户可方便地将 EvoClaw 的回答复制为 Markdown 格式

---

## v0.4.5 (2026-05-24)

### 聊天输入框功能增强

- **文件**: `packages/web-ui/src/WebChatPage.tsx`
- **新增功能**:
  - **上下文使用进度条**: 显示当前对话占用的 token 比例 (45% context used, 89.1k/200k)，颜色随比例变化（绿色→黄色→红色）
  - **左侧工具栏**: 附加文件 📎、语音输入 🎤、设置 ⚙（hover 交互反馈）
  - **右侧工具栏**: 新会话按钮、导出按钮 📥、发送按钮
  - **输入框优化**: 圆角改为 12px，占位符动态显示机器人昵称
- **设计特点**:
  - 所有按钮支持 hover 状态（背景色变化）
  - 主题色与当前主题一致
  - 布局紧凑，信息层次清晰
- **影响**: 聊天界面功能更完善，用户体验提升

---

## v0.4.4 (2026-05-23)

### 聊天消息头像与时间戳位置定制

- **文件**: `packages/web-ui/src/WebChatPage.tsx`
- **功能**:
  - 用户消息：时间戳居左，昵称居中偏右，28px圆形头像最右侧
  - EvoClaw消息：28px圆形头像最左侧，昵称居中，时间戳居右
  - 头像从 `avatars.user`/`avatars.bot` 读取（来自右上角设置），支持自定义上传头像
  - 时间戳使用等宽字体 (monospace) 增强可读性
- **影响**: 聊天界面信息层次更清晰，用户可个性化头像和昵称

---

## v0.4.3 (2026-05-23)

### Evolution/Compactions API 认证白名单修复

- **文件**: `packages/gateway/src/auth-provider.ts`
- **问题**: `/api/evolution/*` 和 `/api/compactions` 路径不在认证白名单中，前端请求被 401 拦截
- **修复**: 将 `/api/evolution/` 和 `/api/compactions` 添加到公开 API 前缀白名单
- **影响**: Evolution Dashboard 和 Canvas 页面现在可以正常获取数据

### SkillDispatcher 搜索技能匹配增强

- **文件**: `packages/skills/src/auto-skill-manager.ts`, `packages/skills/src/skill-dispatcher.ts`
- **问题**:
  - 中文搜索意图（"搜索新闻"、"查找资讯"等）无法匹配到 `baidu-search` 技能
  - SkillDispatcher 回退搜索仅查找 `web-search`，不包含 `baidu-search`
- **修复**:
  - `computeKeywordRelevance()` 添加语义关键词映射：搜索意图词（搜索/查找/查询/新闻/search/find 等）自动提升搜索类技能的相关度分数
  - SkillDispatcher 回退搜索增加 `baidu-search` 匹配
- **影响**: 中文搜索请求现在能正确匹配到 baidu-search 技能

### SkillDispatcher 执行失败回退 LLM

- **文件**: `packages/agent/src/agent-model-executor.ts`
- **问题**: 当 SkillDispatcher 匹配到技能但执行失败时（如缺少 API Key），不会回退到 LLM 处理
- **修复**: 添加 else 分支，当技能匹配但执行失败时打印日志并回退到 LLM 流程
- **影响**: 搜索类请求即使技能执行失败，也能通过 LLM 的 web_fetch 工具获取结果

---

## v0.4.2 (2026-05-23)

### 删除会话确认弹窗定制化

- **文件**: `packages/web-ui/src/WebChatPage.tsx`
- **问题**: 删除聊天会话使用浏览器原生 `confirm()` 弹窗，体验简陋
- **修复**:
  - 替换为自定义精美弹窗：圆角卡片 + 毛玻璃遮罩 + 缩放动画
  - 弹窗主题色与当前主题一致（使用 CSS 变量 `--bg-card`, `--border`, `--text-primary` 等）
  - 新增"以后删除不再提示"复选框，勾选后存储到 localStorage，后续删除直接执行
  - 按钮交互优化：hover 状态变色，删除按钮红色高亮
  - 点击遮罩层可关闭弹窗
- **影响**: 删除会话体验大幅提升，用户可自主选择是否跳过确认

### 安全修复：移除诊断接口中的环境变量泄露

- **文件**: `packages/infrastructure/src/crestodian.ts`
- **问题**: `collectDiagnostics()` 返回完整 `process.env`，包含 API 密钥等敏感信息
- **修复**: 移除 `env: process.env` 字段，仅保留 `config.NODE_ENV`
- **影响**: 防止通过 Ops 诊断接口泄露 API 密钥等敏感信息

---

## v0.4.1 (2026-05-23)

### 系统核心功能连接与数据流修复

本次更新重点解决了 WebUI 多个 Tab 页面数据为空的问题，打通了从后端服务到前端展示的完整数据链路。

#### EventLedger 事件账本数据记录
- **文件**: `packages/agent/src/agent-model-executor.ts`
- **问题**: EventLedger.append() 从未被调用，导致事件账本 Tab 始终为空
- **修复**:
  - 在 chat() 方法中挂载 `session_start` 事件记录（会话开始时触发）
  - 在工具执行循环中添加工具调用成功/失败的事件记录
  - 在会话结束时挂载 `session_end` 事件记录
- **影响**: 每次用户对话和工具调用都会被记录到事件账本，支持按时间/类型/代理/会话查询

#### Canvas 进化统计与学习统计数据修复
- **文件**: `apps/server/src/index.ts`
- **问题**: EvolutionEngine 已创建但未注册到 ServiceRegistry，导致 `/api/evolution/dashboard` 和 `/api/evolution/learning/stats` 始终返回空数据
- **修复**: 添加 `registry.registerService("evolutionEngine", this.evolutionEngine)` 及 Crestodian 健康注册
- **影响**: Canvas 页面的进化统计和学习统计将从 evolutionEngine 获取运行时数据

#### Ops 服务健康状态修复
- **文件**: `apps/server/src/index.ts`, `packages/infrastructure/src/crestodian.ts`
- **问题**:
  - 无服务向 Crestodian 注册，导致"无服务数据"
  - `collectDiagnostics()` 返回的字段（health, overview, recentOperations, env）与前端 Diagnostics 接口（status, collectedAt, os, process, config）完全不匹配
- **修复**:
  - 注册 agentModelExecutor、gatewayServer、autoSkillManager、skillDispatcher、eventLedger、permissionManager、taskOrchestrator、evolutionEngine 等关键服务到 Crestodian
  - 重构 `collectDiagnostics()` 返回结构，增加 `status`、`collectedAt`、`os`、`process`、`config` 等前端期望字段，同时保留原有 health、overview、recentOperations、env 信息
- **影响**: Ops 页面正确显示各服务健康状态和诊断信息

#### Permissions 权限页面修复
- **文件**: `apps/server/src/index.ts`, `packages/web-ui/src/PermissionsPage.tsx`
- **问题**:
  - 刷新按钮无视觉反馈
  - `permRelay.request()` 缺少必填参数 `agentId` 和 `sessionId`，导致权限请求未被记录
  - 前端 PermissionsPage 查询 permissionRelay 但文件操作工具未向其写入数据
- **修复**:
  - 前端添加 `refreshing` 状态，刷新时按钮禁用并显示加载状态
  - 文件工具处理器（file_create/file_modify/file_delete）调用 `permRelay.request()` 时传入 `agentId: "system"` 和 `sessionId: "default"`
- **影响**: 文件操作时的权限请求现在会记录到 permissionRelay 并在 WebUI 中显示

#### OpsPage/PermissionsPage 刷新交互优化
- **文件**: `packages/web-ui/src/OpsPage.tsx`, `packages/web-ui/src/PermissionsPage.tsx`
- **修复**: 添加 `refreshing` 状态变量，刷新按钮在加载时显示禁用+半透明状态，提升用户体验
- **影响**: 用户点击刷新后获得明确的加载反馈

#### 编译错误修复
- **`toolsExecuted` 属性**: 将 `chat()` 方法及 `detectAndConfigureEmailAccount`、`handleEmailOperation`、`handleSkillInstall` 等 12 个方法的返回类型统一添加 `toolsExecuted: boolean` 字段，修复约 40+ 处 TS2741 错误
- **`anyToolExecuted` 作用域**: 修复变量在不同函数作用域中未定义的问题
- **`toInstall` 作用域**: 修复 `handleBatchSkillInstall` 中 `toInstall` 变量在 `if` 块内部定义导致外部无法访问的问题
- **`handleSkillInstall` 语法结构**: 修复函数体中 `if` 块缺少闭合括号导致的 TS1128 错误

---

## v0.4.0 (2026-05-22 ~ 2026-05-23)

### 综合技能系统与工作流改进
- **提交**: `bc01e8b`
- **内容**: 全面升级技能系统，增加自动发现、安装、调度功能
- **文件**: `packages/skills/src/skill-dispatcher.ts`, `packages/skills/src/tfidf-matcher.ts`
- **新增**:
  - SkillDispatcher 技能调度器：基于 TF-IDF 匹配自动将用户任务路由到对应技能
  - TF-IDF 匹配器：本地语义匹配，支持中英文
  - 自动技能安装流程：检测技能安装请求并执行批量安装
  - 远端搜索回退：本地无匹配时自动执行网页搜索

### 邮件功能修复
- **提交**: `b8ccc4b`
- **内容**: 修复邮件工具在有现有账户时无法正常工作的问题
- **影响**: 邮件查询、整理功能恢复正常

### 技能安装流程修复
- **提交**: `226c921`
- **内容**: 添加 handleSkillInstall 方法，改进技能安装检测逻辑
- **影响**: 支持"安装 weather"等自然语言安装指令

---

## v0.3.x (2026-05-21 ~ 2026-05-22)

### 技能安装与搜索功能
- **提交**: `a9adb24`
- **内容**: 添加 skill_install、skill_search 工具，支持对话中安装和搜索技能
- **影响**: 用户可通过自然语言请求安装技能

### Session 管理修复
- **提交**: `011e286`
- **内容**: 修复删除最后一个会话时的 React 错误
- **影响**: Session 列表操作稳定性提升

### UI 体验改进
- **提交**: `5ec798c`, `e18ddae`, `5815ed3`, `c695062`, `8d58ce0`
- **内容**:
  - 会话预览优化：23 字预览，中英文智能计数
  - 加载动画：添加进度条、动画点、5 条轮换加载消息
  - 动画速度调优至 3 秒
- **影响**: 用户等待体验显著改善

### 权限弹窗响应式修复
- **提交**: `9e35204`
- **内容**: 修复权限弹窗在不同屏幕尺寸下的响应式布局
- **影响**: 移动端和窄屏用户体验改善

### 黑屏崩溃修复 + 亮色主题支持
- **提交**: `91b4e26`
- **内容**: 修复 SkillsConfig 页面黑屏崩溃，全局页面亮色主题适配
- **影响**: 主题切换稳定性提升

---

## v0.2.x (2026-05-20)

### 持久化内存与 Session 集成
- **提交**: `26ffebd`
- **内容**: 从 OpenClaw 设计移植持久化内存与会话集成
- **影响**: 跨会话记忆保持

### SkillsConfig UI 改进
- **提交**: `ee18534`
- **内容**: SkillsConfig 界面显示 OpenClaw 元数据中的必需环境变量
- **影响**: 技能配置界面更直观

### 技能执行引擎升级
- **提交**: `be961a0`
- **内容**: 支持 Python/bash 子进程、web_fetch/web_search 工具
- **影响**: 技能执行能力大幅增强

---

## v0.1.x (2026-05-18 ~ 2026-05-19)

### Skill-First 执行策略
- **提交**: `6d6f28d`
- **内容**:
  - 优先使用技能搜索而非浏览器工具处理网页搜索任务
  - 添加 skill_install/execute/create 工具
  - 输出换行优化、工具结果截断
- **影响**: 任务执行效率提升

### Agent 韧性提升
- **提交**: `7a36504`, `d7bc278`
- **内容**:
  - 修复输出多余空行和浏览器工具上下文溢出
  - Agent 韧性提升、新闻搜索自主化
  - LLM 错误日志增强
- **影响**: 系统稳定性和可调试性提升

---

## v0.1.0 (项目初始)

### 项目基础架构
- Monorepo 结构 (pnpm workspace)
- 15+ 核心包：agent、skills、evolution、security、infrastructure、gateway、web-ui 等
- WebUI 前端：React + TypeScript + Vite
- 后端服务：Express + TypeScript
- 插件系统：Hook 生命周期拦截器
- 权限系统：PermissionManager + PermissionRelay
- 运维系统：Crestodian 健康监控与诊断
- 进化引擎：EvolutionEngine 任务学习与改进
- 事件账本：EventLedger 全量事件记录
- 技能系统：SkillManager + AutoSkillManager + SkillDispatcher

---

*此文件由 EvoClaw 开发团队维护，每次成功构建后必须更新。*