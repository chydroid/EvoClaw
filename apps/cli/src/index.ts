#!/usr/bin/env node
/**
 * EvoClaw CLI — Self-Evolving Agent OS command-line interface.
 * Built on Commander.js v13 for professional CLI ergonomics.
 *
 * 本文件同时承担两个角色（对标 OpenClaw `src/index.ts`）：
 *   - 当作为主模块直接运行时（`node apps/cli/dist/index.js …`）→ 启动 CLI
 *   - 当被其他模块 `import` 时 → 仅暴露库导出（library.ts），不执行 CLI
 * 这样消费者可以通过 `@evoclaw/cli/library` 子路径以编程方式使用 EvoClaw 能力，
 * 而不会触发 CLI 解析逻辑。
 */
import { Command } from "commander";
import * as path from "path";
import * as fs from "fs";
import { VERSION, DEFAULT_PORT, DEV_PORT, setPort, OPENCLAW_COMPAT_VERSION } from "./utils/api";
import { setColorEnabled, c, divider, ICONS } from "./utils/colors";
import { setLogLevel, getValidLevels } from "./utils/logger";

// ── Shared flags factory ──────────────────────────────────────────
function sharedFlags(cmd: Command): Command {
  return cmd
    .option("--no-color", "Disable colored output")
    .option("--dev", "Use development port and config")
    .option("--profile <name>", "Run under a named profile", (v) => v.replace(/[^a-zA-Z0-9_-]/g, ""))
    .option("--log-level <level>", `Set log level (${getValidLevels().join("|")})`, "info");
}

function applySharedOptions(opts: Record<string, unknown>): void {
  if (opts.noColor) setColorEnabled(false);
  if (opts.logLevel && !setLogLevel(String(opts.logLevel))) {
    const { setLogLevel: sl } = require("./utils/logger");
    const { c: cc } = require("./utils/colors");
    process.stderr.write(cc("yellow", `⚠ Invalid log level "${opts.logLevel}". Expected: ${getValidLevels().join(", ")}\n`));
  }
  if (opts.dev) {
    process.env.EvoClaw_DEV = "1";
    setPort(DEV_PORT);
    const baseDir = path.join(process.cwd(), ".evoclaw-dev");
    if (!fs.existsSync(baseDir)) fs.mkdirSync(baseDir, { recursive: true });
  }
  if (opts.profile) {
    const profileName = String(opts.profile);
    if (profileName) {
      process.env.EvoClaw_PROFILE = profileName;
      if (!opts.dev) setPort(DEFAULT_PORT);
      const baseDir = path.join(process.cwd(), `.evoclaw-${profileName}`);
      if (!fs.existsSync(baseDir)) fs.mkdirSync(baseDir, { recursive: true });
    }
  }
}

// ── Brand banner ───────────────────────────────────────────────────
function brandBanner(): string {
  const bar = c("cyan", "═".repeat(50));
  return [
    "", bar,
    `${c("bold", `  ${ICONS.rock}  EvoClaw`)} ${c("gray", `v${VERSION}`)}`,
    "  Self-Evolving Agent OS",
    bar, "",
  ].join("\n");
}

// ── Build CLI program ─────────────────────────────────────────────
const program = new Command();

// Detect if invoked as "openclaw" for compatibility mode
const invokedAs = path.basename(process.argv[1] || "").toLowerCase();
const isCompatMode = invokedAs === "openclaw" || process.argv[1]?.endsWith("openclaw") || process.env.EVOCLAW_COMPAT === "1";
const displayVersion = isCompatMode ? OPENCLAW_COMPAT_VERSION : VERSION;
const cliName = isCompatMode ? "openclaw" : "EvoClaw";

program
  .name(cliName)
  .description(`${ICONS.rock} EvoClaw — Self-Evolving Agent OS CLI${isCompatMode ? " (OpenClaw compat mode)" : ""}`)
  .version(displayVersion, "-v, --version", "Output the version number")
  .helpOption("-h, --help", "Display help for command")
  .addHelpText("beforeAll", brandBanner())
  .addHelpText("afterAll", `\n${c("gray", "Global Flags: --help/-h  --version/-v  --no-color  --json  --dev  --profile <name>  --log-level <level>")}\n${c("gray", `Log levels: ${getValidLevels().join(" ")}`)}\n${c("dim", `Docs: https://github.com/chydroid/EvoClaw`)}\n`)
  .configureHelp({ sortSubcommands: true, sortOptions: true })
  .showHelpAfterError(c("gray", "Use EvoClaw --help for a list of all commands."));

sharedFlags(program);

// 在每个命令 action 执行前应用共享选项（--no-color / --dev / --profile / --log-level）
program.hook("preAction", () => {
  applySharedOptions(program.opts());
});

// ── Auto-register all command modules ──────────────────────────────
const commandModules = [
  "setup", "onboard", "config", "doctor", "dashboard", "completion",
  "health", "status", "sessions",
  "chat", "agent", "agents", "message", "acp",
  "skills", "memory", "models",
  "gateway", "logs", "system",
  "channels", "security", "secrets", "approvals", "pairing",
  "sandbox", "tasks", "hooks",
  "cron", "webhooks", "plugins", "mcp",
  "directory", "docs",
  "configure", "infer", "tui", "transcripts", "dns", "qr",
  "update", "backup", "uninstall", "reset",
  "enhancements",
  // ── openclaw parity (v0.62.0) ──────────────────────────────────
  "exec-policy", "migrate", "node", "nodes", "proxy", "devices", "commitments",
];

for (const mod of commandModules) {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { register } = require(`./commands/${mod}`);
    if (typeof register === "function") register(program, sharedFlags, applySharedOptions);
  } catch (err) {
    process.stderr.write(`[CLI] Warning: failed to load command "${mod}": ${err instanceof Error ? err.message : String(err)}\n`);
  }
}

// ── Parse & run (only when invoked as main module) ─────────────────
//
// 对标 OpenClaw `src/index.ts` 的 `isMainModule` 守卫：
// 当本文件被 `import` 时（库模式），跳过 CLI 解析与全局错误处理；
// 仅在被 `node` 直接运行时（CLI 模式）才执行以下逻辑。
function isMainModule(): boolean {
  try {
    if (!process.argv[1]) return true;
    const invoked = path.resolve(process.argv[1]);
    // CommonJS 模式下 __filename 为 Node 注入的全局变量
    const here = __filename;
    return invoked === here;
  } catch {
    return true;
  }
}

if (isMainModule()) {
  process.on("unhandledRejection", (reason) => {
    const msg = reason instanceof Error ? reason.message : String(reason);
    process.stderr.write(c("red", `Unhandled rejection: ${msg}\n`));
    process.exitCode = 1;
  });

  program.parseAsync(process.argv).catch((err: Error) => {
    process.stderr.write(c("red", `Error: ${err.message}\n`));
    process.exitCode = 1;
  });
}

// ── Library-mode re-exports ────────────────────────────────────────
//
// 当作为库被 `import` 时，透传 library.ts 的程序化 API（applyTemplate、
// loadConfig、getReplyFromConfig、ensurePortAvailable 等）。这些导出仅在
// 库模式下有意义，CLI 模式不读取它们。
export {
  applyTemplate,
  ensurePortAvailable,
  describePortOwner,
  PortInUseError,
  runExec,
  runCommandWithTimeout,
  ensureBinary,
  waitForever,
  loadConfig,
  getReplyFromConfig,
  createSessionManager,
  ConfigManagerLazy,
  AutoReplyEngineLazy,
  SessionManagerLazy,
} from "./library.js";