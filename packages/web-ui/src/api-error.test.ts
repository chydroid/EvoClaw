import { describe, it, expect } from "vitest";
import {
  ApiError,
  apiErrorFromResponse,
  apiErrorFromNetworkFailure,
  errorMessage,
  extractDetail,
  humanizeStatus,
} from "./api-error";

describe("extractDetail", () => {
  it("从 {error: ...} 抽出 detail", () => {
    expect(extractDetail('{"error":"IMAP not configured"}')).toBe("IMAP not configured");
  });
  it("从 {message: ...} 抽出 detail（error 优先）", () => {
    expect(extractDetail('{"error":"a","message":"b"}')).toBe("a");
    expect(extractDetail('{"message":"b"}')).toBe("b");
  });
  it("从 {detail: ...} 抽出 detail", () => {
    expect(extractDetail('{"detail":"not found"}')).toBe("not found");
  });
  it("FastAPI validation error（detail 为数组）拼接 msg", () => {
    const body = JSON.stringify({ detail: [{ msg: "field required" }, { msg: "bad value" }] });
    expect(extractDetail(body)).toBe("field required; bad value");
  });
  it("结构化 detail 取 message 子字段", () => {
    const body = JSON.stringify({ detail: { code: "X", message: "the sentence" } });
    expect(extractDetail(body)).toBe("the sentence");
  });
  it("空 body / HTML 代理页返回 null", () => {
    expect(extractDetail("")).toBeNull();
    expect(extractDetail("<html>502</html>")).toBeNull();
  });
  it("纯文本短 body 原样返回", () => {
    expect(extractDetail("boom")).toBe("boom");
  });
  it("过长纯文本截断为 null", () => {
    expect(extractDetail("x".repeat(400))).toBeNull();
  });
});

describe("humanizeStatus", () => {
  it("常见状态码有人话文案", () => {
    expect(humanizeStatus(404)).toContain("找不到");
    expect(humanizeStatus(503)).toContain("暂不可用");
    expect(humanizeStatus(401)).toContain("过期");
  });
  it("未知状态码回落到通用文案", () => {
    expect(humanizeStatus(599)).toContain("599");
  });
});

describe("apiErrorFromResponse", () => {
  it("优先使用 body detail", () => {
    const e = apiErrorFromResponse(500, '{"error":"kaboom"}', "/api/x");
    expect(e.message).toBe("kaboom");
    expect(e.status).toBe(500);
    expect(e.body).toBe('{"error":"kaboom"}');
    expect(e.url).toBe("/api/x");
    expect(e.name).toBe("ApiError");
  });
  it("body 无 detail 时按状态码取文案", () => {
    const e = apiErrorFromResponse(404, "", "/api/x");
    expect(e.message).toContain("找不到");
  });
  it("details 提供多行技术详情", () => {
    const e = apiErrorFromResponse(500, '{"error":"x"}', "/api/x");
    expect(e.details).toBe("HTTP 500 /api/x\n{\"error\":\"x\"}");
  });
});

describe("apiErrorFromNetworkFailure", () => {
  it("status=0 且文案为不可达", () => {
    const e = apiErrorFromNetworkFailure(new TypeError("fetch failed"), "/api/x");
    expect(e.status).toBe(0);
    expect(e.message).toContain("无法连接");
    expect(e.body).toContain("TypeError");
  });
});

describe("errorMessage", () => {
  it("ApiError 取 .message，不产生双前缀", () => {
    const e = apiErrorFromResponse(500, '{"error":"x"}', "/api/x");
    expect(errorMessage(e)).toBe("x");
    expect(errorMessage(e)).not.toContain("Error:");
  });
  it("普通 Error 取 message", () => {
    expect(errorMessage(new Error("boom"))).toBe("boom");
  });
  it("字符串原样返回", () => {
    expect(errorMessage("offline")).toBe("offline");
  });
  it("未知对象转字符串", () => {
    expect(errorMessage({ foo: 1 })).toBe("[object Object]");
  });
});

describe("ApiError details（status=0）", () => {
  it("网络失败的 details 不带 HTTP 前缀", () => {
    const e = apiErrorFromNetworkFailure(new Error("down"), "/api/x");
    expect(e.details).toBe("network failure /api/x\nError: down");
  });
});