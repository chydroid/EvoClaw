/**
 * api-error — WebUI REST 层的用户级错误形状（对标 hermes web/src/lib/api-error.ts）。
 *
 * 背景：api-client 原来抛 `new ApiError(status, body)`，页面 catch 里用
 * `err instanceof Error ? err.message : String(err)` 渲染，用户看到的是
 * `HTTP 503: {"error":"..."}` 这种原始串。本模块把它转成一句可操作的人话，
 * 同时把 status / raw body / url 留在错误对象上供诊断（复制详情、控制台）。
 */

/** 后端完全不可达（fetch 被 reject，请求根本没到 server）时的用户文案。 */
export const API_UNREACHABLE_MESSAGE =
  "无法连接到 EvoClaw 服务，请确认服务是否正在运行（端口 27789）。";

/** HTTP 状态 → 一句话人话（body 里没有可用 detail 时的兜底）。 */
const STATUS_COPY: Record<number, string> = {
  400: "请求格式不正确，请重试或联系管理员。",
  401: "会话已过期，请刷新页面重新登录。",
  403: "你没有执行该操作的权限。",
  404: "服务器找不到所请求的资源。",
  409: "该变更与服务器当前状态冲突，请刷新后重试。",
  413: "上传的文件过大，服务器无法接受。",
  422: "提交的某些字段不合法，请检查后重试。",
  429: "请求过于频繁，稍等片刻再试。",
  500: "EvoClaw 服务发生内部错误，请稍后重试。",
  502: "代理无法连接到 EvoClaw 服务。",
  503: "EvoClaw 服务暂不可用，请稍后重试。",
  504: "EvoClaw 服务响应超时。",
};

/** 按状态码取人话文案。 */
export function humanizeStatus(status: number): string {
  return STATUS_COPY[status] ?? `服务器返回了意外错误（HTTP ${status}）。`;
}

/**
 * 从典型错误 body 里抽出一句人话，找不到返回 null。
 * 兼容 EvoClaw 后端的 `{error:"..."}` / `{message:"..."}` / `{detail:"..."}`，
 * 以及 FastAPI 风格的 validation error（detail 为数组）。
 */
export function extractDetail(body: string): string | null {
  const text = body.trim();
  if (!text) return null;
  if (text.startsWith("{") || text.startsWith("[")) {
    try {
      const parsed: unknown = JSON.parse(text);
      if (parsed && typeof parsed === "object") {
        const record = parsed as Record<string, unknown>;
        for (const key of ["error", "message", "detail"]) {
          const value = record[key];
          if (typeof value === "string" && value.trim()) return value.trim();
          if (Array.isArray(value)) {
            const msgs = value
              .map((item) => (item && typeof item === "object" ? (item as { msg?: unknown }).msg : null))
              .filter((m): m is string => typeof m === "string");
            if (msgs.length) return msgs.join("; ");
          } else if (value && typeof value === "object") {
            const message = (value as { message?: unknown }).message;
            if (typeof message === "string" && message.trim()) return message.trim();
          }
        }
      }
    } catch {
      return null;
    }
    return null;
  }
  if (text.startsWith("<")) return null; // 代理返回的 HTML 错误页
  return text.length <= 300 ? text : null;
}

export class ApiError extends Error {
  readonly name = "ApiError";
  /** HTTP 状态；0 表示请求根本没到达服务器。 */
  readonly status: number;
  /** 原始响应 body（或传输错误文本），供「复制详情」使用。 */
  readonly body: string;
  /** 请求路径（不含 query），供诊断。 */
  readonly url: string;

  constructor(message: string, init: { status: number; body: string; url: string }) {
    super(message);
    this.status = init.status;
    this.body = init.body;
    this.url = init.url;
  }

  /** 多行技术详情，供复制或控制台输出。 */
  get details(): string {
    const head = this.status ? `HTTP ${this.status} ${this.url}` : `network failure ${this.url}`;
    return this.body ? `${head}\n${this.body}` : head;
  }
}

/** 从 HTTP 响应构造 ApiError：优先取 body 里的 detail，否则按状态码取人话文案。 */
export function apiErrorFromResponse(status: number, body: string, url: string): ApiError {
  const detail = extractDetail(body);
  return new ApiError(detail ?? humanizeStatus(status), { status, body, url });
}

/** fetch 被 reject（网络错误 / 超时中止）时构造 ApiError。 */
export function apiErrorFromNetworkFailure(cause: unknown, url: string): ApiError {
  const body = cause instanceof Error ? `${cause.name}: ${cause.message}` : String(cause);
  return new ApiError(API_UNREACHABLE_MESSAGE, { status: 0, body, url });
}

/**
 * 把捕获的 unknown 转成 toast/内联文案。
 * 永远不产生 `Error: Error:` 双前缀——读 `.message` 而非 `String(e)`。
 */
export function errorMessage(err: unknown): string {
  if (err instanceof ApiError) return err.message;
  if (err instanceof Error) return err.message || err.name;
  if (typeof err === "string") return err;
  return String(err);
}