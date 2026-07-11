# scripts/

EvoClaw 仓库级工具脚本。这些脚本不属于 pnpm workspace 包，独立运行。

## 供应链安全工具

借鉴 hermes-agent 的供应链安全实践（精确锁定依赖 + OSV 漏洞检查），提供以下两个脚本。

### osv-check.ts — OSV 漏洞检查

解析 `pnpm-lock.yaml` 中的所有外部依赖，并查询 [OSV API](https://osv.dev/) 检测已知漏洞。

```bash
# 基本检查（终端表格输出）
npx tsx scripts/osv-check.ts

# 仅显示 HIGH 及以上漏洞
npx tsx scripts/osv-check.ts --severity HIGH

# 输出 JSON（便于 CI 解析）
npx tsx scripts/osv-check.ts --json
```

特性：

- 读取 `pnpm-lock.yaml` 的 `packages:` 段，自动跳过 `@evoclaw/*` 内部包
- 并发查询 OSV API（限制并发 10），结果缓存到 `.osv-cache.json`（24 小时 TTL）
- 报告漏洞 ID、包名、受影响版本、严重程度、修复版本、参考链接
- 支持 `--severity LOW|MEDIUM|HIGH|CRITICAL` 过滤展示
- 退出码：发现 HIGH/CRITICAL 漏洞时 `exit 1`（CI 用），出错 `exit 2`

> 缓存文件 `.osv-cache.json` 已加入 `.gitignore`，可安全删除后重新检查。

### lock-deps.ts — 依赖锁定检查

检查 `packages/*/package.json` 与 `apps/*/package.json` 中使用范围版本（`^` / `~` / `>` / `*` 等）的依赖，建议改为精确版本。

```bash
# 检查范围版本依赖
npx tsx scripts/lock-deps.ts

# 自动将 ^X.Y.Z / ~X.Y.Z 改写为 X.Y.Z（精确锁定）
npx tsx scripts/lock-deps.ts --fix

# 输出 JSON
npx tsx scripts/lock-deps.ts --json

# 使用白名单（每行一个允许保留范围版本的包名，# 开头为注释）
npx tsx scripts/lock-deps.ts --allow scripts/lock-deps-allow.txt
```

特性：

- 跳过 `workspace:*` / `file:` / `link:` / `git` / `http` 协议依赖
- 跳过 `@evoclaw/*` 内部包
- `--fix` 仅自动修复 `^` / `~` 前缀（剥离即得精确版本）；`>` / `<` / `*` / `latest` 等仅报告、不自动改写，需手动确认
- 定向字符串替换，保留 `package.json` 原有缩进与格式
- 退出码：仍存在范围版本时 `exit 1`，出错 `exit 2`

#### 白名单文件示例

```
# 允许保留范围版本（如需跟随上游主版本）
@types/node
vitest
```

## 其他脚本

- `vitest-runner.mjs` — Vitest 启动包装器，统一处理参数与临时目录（被根 `package.json` 的 `test` 脚本调用）。
- `test-suite.mjs` — 测试套件辅助脚本。
- `download-embedding-model.js` — 从国内镜像预下载 embedding 模型到本地缓存。
