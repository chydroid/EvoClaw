/**
 * SafeWriter — 安全输出写入器
 *
 * 借鉴 hermes-agent 的 SafeWriter 设计：
 * - 包装 process.stdout/stderr，捕获 EPIPE/ERR_STREAM_DESTROYED 等错误
 * - 防止 systemd/Docker 环境中 broken pipe 导致进程崩溃
 * - 优雅降级：写入失败时静默丢弃而非抛出异常
 */

/** 检查错误是否为可安全忽略的 IO 错误 */
function isSafeIOError(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  const code = (err as NodeJS.ErrnoException).code;
  return (
    code === "EPIPE" ||
    code === "ERR_STREAM_DESTROYED" ||
    code === "ERR_STREAM_WRITE_AFTER_END" ||
    err.message.includes("write EPIPE") ||
    err.message.includes("broken pipe")
  );
}

/** 可写流接口（包含 destroyed/writableEnded 属性） */
interface SafeWritableStream extends NodeJS.WritableStream {
  destroyed?: boolean;
  writableEnded?: boolean;
}

/**
 * 创建安全写入器，包装原始可写流
 */
export class SafeWriter {
  private stream: SafeWritableStream;
  private errorCount = 0;
  private readonly maxErrorLog = 5;

  constructor(stream: SafeWritableStream) {
    this.stream = stream;

    // 监听 error 事件，防止未捕获异常导致进程崩溃
    this.stream.on?.("error", (err: Error) => {
      if (isSafeIOError(err)) {
        this.errorCount++;
        // 静默忽略，仅在前几次记录
        if (this.errorCount <= this.maxErrorLog) {
          process.stderr.write(`[SafeWriter] Suppressed IO error: ${err.message}\n`);
        }
      } else {
        // 非 IO 错误重新抛出
        throw err;
      }
    });
  }

  /**
   * 安全写入数据。如果流已关闭或管道断裂，静默丢弃。
   */
  write(data: string | Buffer): boolean {
    try {
      if (this.stream.destroyed || this.stream.writableEnded) {
        return false;
      }
      return this.stream.write(data);
    } catch (err) {
      if (isSafeIOError(err)) {
        return false;
      }
      throw err;
    }
  }

  /** 获取已抑制的错误数 */
  getErrorCount(): number {
    return this.errorCount;
  }

  /** 重置错误计数 */
  reset(): void {
    this.errorCount = 0;
  }
}

/** 全局安全 stdout 写入器 */
let safeStdout: SafeWriter | null = null;
/** 全局安全 stderr 写入器 */
let safeStderr: SafeWriter | null = null;

/**
 * 获取安全 stdout 写入器（单例）
 */
export function getSafeStdout(): SafeWriter {
  if (!safeStdout) {
    safeStdout = new SafeWriter(process.stdout);
  }
  return safeStdout;
}

/**
 * 获取安全 stderr 写入器（单例）
 */
export function getSafeStderr(): SafeWriter {
  if (!safeStderr) {
    safeStderr = new SafeWriter(process.stderr);
  }
  return safeStderr;
}

/**
 * 安装全局未捕获异常处理器，防止 EPIPE 导致进程崩溃
 */
export function installSafeIOHandlers(): void {
  process.stdout?.on?.("error", (err: Error) => {
    if (isSafeIOError(err)) {
      // 静默忽略
      return;
    }
    throw err;
  });

  process.stderr?.on?.("error", (err: Error) => {
    if (isSafeIOError(err)) {
      return;
    }
    throw err;
  });
}
