import { ServiceRegistry, EventBus } from "@evoclaw/core";

interface InternalLogEntry {
  level: "debug" | "info" | "warn" | "error" | "fatal";
  time: number;
  pid: number;
  hostname: string;
  msg: string;
  service: string;
  traceId?: string;
  context?: Record<string, unknown>;
}

export type LogLevel = "debug" | "info" | "warn" | "error" | "fatal";

export interface LoggerConfig {
  level: LogLevel;
  prettyPrint: boolean;
  serviceName: string;
}

export class Logger {
  private config: LoggerConfig;
  private buffer: InternalLogEntry[] = [];
  private maxBuffer = 1000;

  constructor(
    private registry: ServiceRegistry,
    private eventBus: EventBus
  ) {
    this.config = {
      level: (process.env.LOG_LEVEL as LogLevel) || "info",
      prettyPrint: process.env.NODE_ENV !== "production",
      serviceName: "evoclaw",
    };

    if (registry) {
      registry.registerService("logger", this);
    }
  }

  configure(config: Partial<LoggerConfig>): void {
    this.config = { ...this.config, ...config };
  }

  debug(msg: string, context?: Record<string, unknown>, traceId?: string): void {
    this.log("debug", msg, context, traceId);
  }

  info(msg: string, context?: Record<string, unknown>, traceId?: string): void {
    this.log("info", msg, context, traceId);
  }

  warn(msg: string, context?: Record<string, unknown>, traceId?: string): void {
    this.log("warn", msg, context, traceId);
  }

  error(msg: string, context?: Record<string, unknown>, traceId?: string): void {
    this.log("error", msg, context, traceId);
  }

  fatal(msg: string, context?: Record<string, unknown>, traceId?: string): void {
    this.log("fatal", msg, context, traceId);
  }

  child(service: string): Logger {
    const childLogger = new Logger(this.registry, this.eventBus);
    childLogger.config = { ...this.config, serviceName: service };
    return childLogger;
  }

  private log(level: LogLevel, msg: string, context?: Record<string, unknown>, traceId?: string): void {
    if (!this.shouldLog(level)) return;

    const entry: InternalLogEntry = {
      level,
      time: Date.now(),
      pid: process.pid,
      hostname: process.env.HOSTNAME || "localhost",
      msg,
      service: this.config.serviceName,
      traceId,
      context,
    };

    this.output(entry);
    this.buffer.push(entry);

    if (this.buffer.length > this.maxBuffer) {
      this.buffer = this.buffer.slice(-this.maxBuffer);
    }

    if (level === "error" || level === "fatal") {
      this.eventBus?.publish(
        "system.error",
        { level, message: msg, context, traceId },
        this.config.serviceName
      ).catch((err) => { console.debug("[Logger] Event publish error:", err); });
    }
  }

  private shouldLog(level: LogLevel): boolean {
    const levels: LogLevel[] = ["debug", "info", "warn", "error", "fatal"];
    const currentIndex = levels.indexOf(this.config.level);
    const msgIndex = levels.indexOf(level);
    return msgIndex >= currentIndex;
  }

  private output(entry: InternalLogEntry): void {
    const timestamp = new Date(entry.time).toISOString();

    if (this.config.prettyPrint) {
      const color = this.getLevelColor(entry.level);
      const reset = "\x1b[0m";
      const dim = "\x1b[2m";
      const ctx = entry.context ? ` ${dim}${JSON.stringify(entry.context)}${reset}` : "";
      console.log(
        `${dim}${timestamp}${reset} ${color}${entry.level.toUpperCase().padEnd(5)}${reset} [${entry.service}]${ctx} ${entry.msg}`
      );
    } else {
      console.log(JSON.stringify(entry));
    }
  }

  private getLevelColor(level: LogLevel): string {
    switch (level) {
      case "debug": return "\x1b[36m";
      case "info": return "\x1b[32m";
      case "warn": return "\x1b[33m";
      case "error": return "\x1b[31m";
      case "fatal": return "\x1b[35m";
    }
  }

  getRecent(count = 100): InternalLogEntry[] {
    return this.buffer.slice(-count);
  }

  clearBuffer(): void {
    this.buffer = [];
  }
}