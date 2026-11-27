import { describe, it, expect, afterEach } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  safeSessionFileComponent,
  dumpTimestamp,
  dumpFailedApiRequest,
} from "./request-dump";
import { REDACTED_PLACEHOLDER } from "./transcript-redactor";

// ═══════════════════════════════════════════════════════════
// request-dump（对标 hermes dump_api_request_debug）
// 覆盖：文件名清洗、时间戳格式、脱敏、原子落盘、永不抛
// ═══════════════════════════════════════════════════════════

const tmpDirs: string[] = [];
function mkTmpDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "evoclaw-dump-"));
  tmpDirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of tmpDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe("safeSessionFileComponent", () => {
  it("合法 id 原样返回（identity）", () => {
    expect(safeSessionFileComponent("abc-123_x")).toBe("abc-123_x");
  });

  it("路径成分被折叠为下划线并追加哈希（防撞名覆盖）", () => {
    const out = safeSessionFileComponent("../../etc/passwd");
    expect(out).not.toContain("/");
    expect(out).not.toContain("..");
    expect(out).toMatch(/_[0-9a-f]{12}$/);
  });

  it("两个不同 id 清洗后不撞名", () => {
    expect(safeSessionFileComponent("a/b")).not.toBe(safeSessionFileComponent("a:b"));
  });

  it("空/全非法 → session 占位", () => {
    expect(safeSessionFileComponent("")).toBe("session");
    expect(safeSessionFileComponent("...")).toBe("session");
    expect(safeSessionFileComponent(undefined as unknown as string)).toBe("session");
  });

  it("清洗后截断 96 字符（改写过再追加 12 位哈希）", () => {
    const out = safeSessionFileComponent("a".repeat(200));
    expect(out).toBe(`${"a".repeat(96)}_${out.slice(97)}`);
    expect(out.length).toBe(109);
  });

  it("首尾空白先 trim（hermes `str(session_id or '').strip()`）", () => {
    expect(safeSessionFileComponent("  abc  ")).toBe("abc");
  });

  it("确定性：同一输入两次调用结果一致", () => {
    expect(safeSessionFileComponent("x/y")).toBe(safeSessionFileComponent("x/y"));
  });
});

describe("dumpTimestamp", () => {
  it("形如 YYYYMMDD_HHMMSS_mmm000", () => {
    const ts = dumpTimestamp(new Date(2026, 0, 2, 3, 4, 5, 67).getTime());
    expect(ts).toBe("20260102_030405_067000");
  });

  it("毫秒补零到 3 位", () => {
    expect(dumpTimestamp(new Date(2026, 10, 27, 12, 0, 0, 5).getTime())).toBe(
      "20261127_120000_005000",
    );
  });
});

describe("dumpFailedApiRequest", () => {
  it("写出快照并返回路径", () => {
    const dir = mkTmpDir();
    const target = dumpFailedApiRequest({
      sessionId: "sess-1",
      reason: "non_retryable_client_error",
      url: "http://gw/v1/chat/completions",
      headers: { "Content-Type": "application/json" },
      body: { model: "m", messages: [{ role: "user", content: "hi" }] },
      error: { status: 400, text: "bad request" },
      dir,
      now: new Date(2026, 10, 27, 1, 2, 3, 4).getTime(),
    });
    expect(target).not.toBeNull();
    expect(path.dirname(target!)).toBe(dir);
    expect(path.basename(target!)).toBe(
      "request_dump_sess-1_20261127_010203_004000.json",
    );

    const payload = JSON.parse(fs.readFileSync(target!, "utf-8"));
    expect(payload.reason).toBe("non_retryable_client_error");
    expect(payload.session_id).toBe("sess-1");
    expect(payload.request.method).toBe("POST");
    expect(payload.request.url).toBe("http://gw/v1/chat/completions");
    expect(payload.request.body.model).toBe("m");
    expect(payload.error.status).toBe(400);
  });

  it("敏感头与敏感体字段被脱敏", () => {
    const dir = mkTmpDir();
    const target = dumpFailedApiRequest({
      sessionId: "s",
      reason: "r",
      url: "http://gw/v1",
      headers: { Authorization: "Bearer sk-live-secret", "Content-Type": "application/json" },
      body: { api_key: "sk-should-not-appear", messages: [] },
      dir,
    });
    const text = fs.readFileSync(target!, "utf-8");
    expect(text).not.toContain("sk-live-secret");
    expect(text).not.toContain("sk-should-not-appear");
    const payload = JSON.parse(text);
    expect(payload.request.headers.Authorization).toBe(REDACTED_PLACEHOLDER);
    expect(payload.request.body.api_key).toBe(REDACTED_PLACEHOLDER);
  });

  it("产出是合法 JSON（叶子脱敏不会吃掉引号）", () => {
    const dir = mkTmpDir();
    const target = dumpFailedApiRequest({
      sessionId: "s",
      reason: "r",
      url: "u",
      headers: {},
      body: { note: 'token: "abc" and key=def' },
      dir,
    });
    expect(() => JSON.parse(fs.readFileSync(target!, "utf-8"))).not.toThrow();
  });

  it("无 sessionId 时用 session 占位", () => {
    const dir = mkTmpDir();
    const target = dumpFailedApiRequest({
      reason: "r",
      url: "u",
      headers: {},
      body: {},
      dir,
    });
    expect(path.basename(target!).startsWith("request_dump_session_")).toBe(true);
  });

  it("目录不可写时返回 null（永不抛）", () => {
    const dir = mkTmpDir();
    const blocker = path.join(dir, "file-not-dir");
    fs.writeFileSync(blocker, "x");
    expect(() =>
      dumpFailedApiRequest({
        reason: "r",
        url: "u",
        headers: {},
        body: {},
        dir: path.join(blocker, "sub"),
      }),
    ).not.toThrow();
    expect(
      dumpFailedApiRequest({
        reason: "r",
        url: "u",
        headers: {},
        body: {},
        dir: path.join(blocker, "sub"),
      }),
    ).toBeNull();
  });

  it("自动创建缺失目录", () => {
    const dir = path.join(mkTmpDir(), "nested", "logs");
    const target = dumpFailedApiRequest({
      reason: "r",
      url: "u",
      headers: {},
      body: {},
      dir,
    });
    expect(target).not.toBeNull();
    expect(fs.existsSync(target!)).toBe(true);
  });
});
