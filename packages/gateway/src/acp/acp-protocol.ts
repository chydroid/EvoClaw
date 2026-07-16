/**
 * ACP 协议类型与常量 — 对标 OpenClaw @openclaw/acp-core。
 *
 * 定义标准 ACP (Agent Client Protocol) 的方法名、会话更新 tag、错误码、
 * 协议版本等。与 https://agentclientprotocol.com/ 规范对齐。
 *
 * EvoClaw 的 AcpServer 同时支持自定义 `acp.*` 方法（向后兼容）和标准
 * ACP 方法（initialize/session/new/session/prompt 等），由本模块统一定义。
 */

// ─── 协议版本 ──────────────────────────────────────────────────────────

/** ACP 协议版本（对标 @agentclientprotocol/sdk PROTOCOL_VERSION） */
export const ACP_PROTOCOL_VERSION = 1 as const;

// ─── 代理身份 ──────────────────────────────────────────────────────────

/** ACP 代理身份信息（initialize 响应中返回） */
export interface AcpAgentInfo {
  name: string;
  title: string;
  version: string;
  protocolVersion: typeof ACP_PROTOCOL_VERSION;
}

/** 默认代理身份（对标 OpenClaw ACP_AGENT_INFO） */
export const DEFAULT_ACP_AGENT_INFO: AcpAgentInfo = {
  name: "evoclaw-acp",
  title: "EvoClaw ACP Gateway",
  version: "0.0.0",
  protocolVersion: ACP_PROTOCOL_VERSION,
};

// ─── 标准 ACP 方法名 ──────────────────────────────────────────────────

export const ACP_METHODS = {
  INITIALIZE: "initialize",
  NEW_SESSION: "session/new",
  PROMPT: "session/prompt",
  CANCEL: "session/cancel",
  LIST_SESSIONS: "session/list",
  LOAD_SESSION: "session/load",
  RESUME_SESSION: "session/resume",
  CLOSE_SESSION: "session/close",
  SET_MODE: "session/set_mode",
  SET_CONFIG_OPTION: "session/set_config_option",
  REQUEST_PERMISSION: "session/request_permission",
  NOTIFICATION_SESSION_UPDATE: "session/update",
  NOTIFICATION_CANCEL: "session/cancel",
} as const;

export type AcpMethodName = (typeof ACP_METHODS)[keyof typeof ACP_METHODS];

// ─── 会话更新 Tag ──────────────────────────────────────────────────────

export const ACP_SESSION_UPDATE_TAGS = {
  AGENT_MESSAGE_CHUNK: "agent_message_chunk",
  AGENT_THOUGHT_CHUNK: "agent_thought_chunk",
  TOOL_CALL: "tool_call",
  TOOL_CALL_UPDATE: "tool_call_update",
  USAGE_UPDATE: "usage_update",
  AVAILABLE_COMMANDS_UPDATE: "available_commands_update",
  CURRENT_MODE_UPDATE: "current_mode_update",
  CONFIG_OPTION_UPDATE: "config_option_update",
  SESSION_INFO_UPDATE: "session_info_update",
  PLAN: "plan",
} as const;

export type AcpSessionUpdateTag =
  | (typeof ACP_SESSION_UPDATE_TAGS)[keyof typeof ACP_SESSION_UPDATE_TAGS]
  | (string & {});

// ─── 会话更新通知 ──────────────────────────────────────────────────────

export interface AcpSessionUpdate {
  /** 更新类型 tag */
  tag: AcpSessionUpdateTag;
  /** 更新内容（结构因 tag 而异） */
  [key: string]: unknown;
}

// ─── 会话信息 ──────────────────────────────────────────────────────────

export interface AcpSessionInfo {
  sessionId: string;
  cwd?: string;
  mcpServers?: string[];
  mode?: "persistent" | "oneshot";
  state?: "idle" | "running";
}

// ─── 内容块 ────────────────────────────────────────────────────────────

export type AcpContentBlock =
  | { type: "text"; text: string }
  | { type: "resource"; resource: { uri: string; mimeType?: string; text?: string } }
  | { type: "image"; data: string; mimeType: string };

// ─── ACP 错误码 ────────────────────────────────────────────────────────

/** ACP 特有错误码（对标 OpenClaw ACP_ERROR_CODES） */
export const ACP_ERROR_CODES = [
  "ACP_BACKEND_MISSING",
  "ACP_BACKEND_UNAVAILABLE",
  "ACP_BACKEND_UNSUPPORTED_CONTROL",
  "ACP_DISPATCH_DISABLED",
  "ACP_INVALID_RUNTIME_OPTION",
  "ACP_SESSION_INIT_FAILED",
  "ACP_TURN_FAILED",
] as const;

export type AcpErrorCode = (typeof ACP_ERROR_CODES)[number];

/** ACP 错误（对标 OpenClaw AcpRuntimeError） */
export class AcpError extends Error {
  readonly code: AcpErrorCode;
  readonly detailCode?: string;
  readonly cause?: unknown;

  constructor(code: AcpErrorCode, message: string, opts?: { detailCode?: string; cause?: unknown }) {
    super(message);
    this.name = "AcpError";
    this.code = code;
    if (opts?.detailCode !== undefined) this.detailCode = opts.detailCode;
    if (opts?.cause !== undefined) this.cause = opts.cause;
  }

  toJSON(): { code: string; message: string; detailCode?: string } {
    return {
      code: this.code,
      message: this.message,
      ...(this.detailCode !== undefined ? { detailCode: this.detailCode } : {}),
    };
  }
}

/** 将任意错误包装为 AcpError */
export function toAcpError(err: unknown): AcpError {
  if (err instanceof AcpError) return err;
  const message = err instanceof Error ? err.message : String(err);
  return new AcpError("ACP_TURN_FAILED", message, { cause: err });
}

/** 判断值是否为 AcpError */
export function isAcpError(v: unknown): v is AcpError {
  return v instanceof AcpError;
}

// ─── 运行时控制 ────────────────────────────────────────────────────────

export type AcpRuntimeControl =
  | "session/set_mode"
  | "session/set_config_option"
  | "session/status";

// ─── 会话模式 ──────────────────────────────────────────────────────────

export type AcpSessionMode = "persistent" | "oneshot";
export type AcpPromptMode = "prompt" | "steer";

// ─── 溯源模式 ──────────────────────────────────────────────────────────

export type AcpProvenanceMode = "off" | "meta" | "meta+receipt";

// ─── 协议限制 ──────────────────────────────────────────────────────────

/** 最大 prompt 字节数（CWE-400 防护，对标 OpenClaw MAX_PROMPT_BYTES） */
export const ACP_MAX_PROMPT_BYTES = 2 * 1024 * 1024; // 2MB

/** loadSession 重放事件上限 */
export const ACP_LOAD_SESSION_REPLAY_LIMIT = 1_000_000;

/** Gateway 断连宽限期（ms） */
export const ACP_GATEWAY_DISCONNECT_GRACE_MS = 5_000;
