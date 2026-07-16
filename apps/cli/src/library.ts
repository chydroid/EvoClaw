/**
 * EvoClaw Library — 公共程序化 API 入口。
 *
 * 对标 OpenClaw `src/library.ts`：非 CLI 调用方通过 `@evoclaw/cli/library`
 * 子路径导入 EvoClaw 的运行时能力（配置加载、自动回复、会话管理、端口探测、
 * 命令执行），无需启动子进程。
 *
 * 设计要点：
 *   - 重型依赖（agent / gateway / memory 包）使用 `createLazyRuntimeModule` 延迟加载，
 *     避免库导入即触发整条依赖链。
 *   - 仅暴露函数与必要的类型；类实例化留给调用方（通过工厂函数）。
 *   - 与 OpenClaw library.ts 保持 API 形状一致，便于生态移植。
 */
import { execFileSync } from "node:child_process";
import { createLazyRuntimeModule } from "./lazy-runtime.js";

// ── 模板渲染（轻量，直接同步导出） ────────────────────────────────────────────

/**
 * 简单的 `{{var}}` 模板插值，对标 OpenClaw `applyTemplate`。
 * 不对未知变量报错，缺失变量替换为空字符串，避免抛错打断流程。
 *
 * @example
 *   applyTemplate("Hello {{name}}!", { name: "world" })  // → "Hello world!"
 */
export function applyTemplate(
  template: string,
  vars: Record<string, string | number | undefined | null>,
): string {
  return template.replace(/\{\{(\w+)\}\}/g, (_match, key: string) => {
    const v = vars[key];
    return v === undefined || v === null ? "" : String(v);
  });
}

// ── 端口探测（同步可用，无需 lazy load） ──────────────────────────────────────

/** 端口占用错误，对标 OpenClaw `PortInUseError`。 */
export class PortInUseError extends Error {
  readonly port: number;
  constructor(port: number, message?: string) {
    super(message ?? `Port ${port} is already in use`);
    this.name = "PortInUseError";
    this.port = port;
  }
}

/**
 * 探测端口是否可用；被占用时抛出 `PortInUseError`。
 * 对标 OpenClaw `ensurePortAvailable`。
 */
export async function ensurePortAvailable(port: number): Promise<void> {
  const net = await import("node:net");
  return new Promise<void>((resolve, reject) => {
    const server = net.createServer();
    server.once("error", (err: NodeJS.ErrnoException) => {
      if (err.code === "EADDRINUSE") {
        reject(new PortInUseError(port));
      } else {
        reject(err);
      }
    });
    server.once("listening", () => {
      server.close(() => resolve());
    });
    server.listen(port);
  });
}

/**
 * 尽力查询端口占用者（PID/进程信息）。失败返回 null，不抛错。
 * 对标 OpenClaw `describePortOwner`。
 */
export async function describePortOwner(port: number): Promise<string | null> {
  try {
    if (process.platform === "win32") {
      const out = execFileSync("netstat", ["-ano", "-p", "tcp"], {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
      });
      for (const line of out.split(/\r?\n/)) {
        const parts = line.trim().split(/\s+/);
        if (parts.length >= 4 && parts[1]?.endsWith(`:${port}`)) {
          const pid = parts[parts.length - 1];
          return `pid=${pid}`;
        }
      }
      return null;
    }
    // POSIX：使用 lsof（若不存在则返回 null）
    const out = execFileSync("lsof", [`-i:${port}`], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    });
    const lines = out.split(/\r?\n/).filter(Boolean);
    return lines.length > 1 ? lines.slice(1).join("; ") : null;
  } catch {
    return null;
  }
}

// ── 命令执行（同步可用，无需 lazy load） ──────────────────────────────────────

/** 运行外部命令并返回 stdout 字符串。对标 OpenClaw `runExec`。 */
export function runExec(
  cmd: string,
  args: ReadonlyArray<string> = [],
  opts: { cwd?: string; encoding?: BufferEncoding } = {},
): string {
  return execFileSync(cmd, args as string[], {
    encoding: opts.encoding ?? "utf8",
    cwd: opts.cwd,
    stdio: ["ignore", "pipe", "pipe"],
  });
}

/** 带超时的命令执行。对标 OpenClaw `runCommandWithTimeout`。 */
export function runCommandWithTimeout(
  cmd: string,
  args: ReadonlyArray<string>,
  opts: { cwd?: string; encoding?: BufferEncoding } = {},
  timeoutMs = 30_000,
): string {
  return execFileSync(cmd, args as string[], {
    encoding: opts.encoding ?? "utf8",
    cwd: opts.cwd,
    timeout: timeoutMs,
    stdio: ["ignore", "pipe", "pipe"],
  });
}

/** 检测二进制是否在 PATH 中可用。对标 OpenClaw `ensureBinary`。 */
export async function ensureBinary(name: string): Promise<boolean> {
  const checkCmd = process.platform === "win32" ? "where" : "which";
  try {
    execFileSync(checkCmd, [name], { stdio: ["ignore", "pipe", "ignore"] });
    return true;
  } catch {
    return false;
  }
}

/** 永不 resolve 的 Promise，用于守护进程式常驻。对标 OpenClaw `waitForever`。 */
export function waitForever(): Promise<void> {
  return new Promise<void>(() => {});
}

// ── 配置 / 自动回复 / 会话管理（延迟加载） ────────────────────────────────────

const loadCoreRuntime = createLazyRuntimeModule(() => import("@evoclaw/core"));
const loadAgentRuntime = createLazyRuntimeModule(() => import("@evoclaw/agent"));

/**
 * 加载配置（默认从 .env 与工作区）。对标 OpenClaw `loadConfig`。
 */
export async function loadConfig(configPath?: string): Promise<unknown> {
  const { ConfigManager } = await loadCoreRuntime();
  const cm = new ConfigManager();
  if (configPath) {
    // ConfigManager.loadFromFile 是 async
    await (cm as unknown as { loadFromFile: (p: string) => Promise<void> }).loadFromFile(configPath);
  }
  (cm as unknown as { loadFromEnv: () => void }).loadFromEnv();
  return (cm as unknown as { getConfig: () => unknown }).getConfig();
}

/**
 * 根据自动回复配置评估消息并返回首个匹配的回复。
 * 对标 OpenClaw `getReplyFromConfig`。
 */
export async function getReplyFromConfig(
  // 通过 unknown 隔离，避免把 agent 包的类型拉到库导入路径
  config: unknown,
  ctx: unknown,
): Promise<unknown> {
  const { AutoReplyEngine } = await loadAgentRuntime();
  const engine = new (AutoReplyEngine as unknown as new () => {
    configure: (c: unknown) => void;
    evaluate: (c: unknown) => unknown;
  })();
  engine.configure(config);
  return engine.evaluate(ctx);
}

/**
 * 创建会话管理器实例。对标 OpenClaw `loadSessionStore` + `saveSessionStore` 的合体。
 * EvoClaw 的 SessionManager 同时承担加载与保存职责。
 */
export async function createSessionManager(config: { sessionsDir: string }): Promise<unknown> {
  const { SessionManager } = await loadAgentRuntime();
  return new SessionManager(config);
}

// ── 类的延迟重导出（高级用法） ─────────────────────────────────────────────────
//
// 注意：这些类只在使用时才加载，避免库导入即拉起整条 agent/gateway 依赖链。

export const ConfigManagerLazy = {
  load: async () => (await loadCoreRuntime()).ConfigManager,
};

export const AutoReplyEngineLazy = {
  load: async () => (await loadAgentRuntime()).AutoReplyEngine,
};

export const SessionManagerLazy = {
  load: async () => (await loadAgentRuntime()).SessionManager,
};
