import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import {
  IncomingWebhookManager,
  matchFilter,
  resolveField,
  type WebhookFilter,
  type WebhookFilterContext,
} from "./webhook-manager";

function makeContext(
  overrides: Partial<WebhookFilterContext> = {},
): WebhookFilterContext {
  return {
    payload: { action: "opened", number: 42, user: { id: "u1", login: "alice" } },
    headers: { "x-github-event": "pull_request", "content-type": "application/json" },
    eventType: "pull_request",
    ...overrides,
  };
}

describe("resolveField", () => {
  it("resolves nested payload path", () => {
    expect(resolveField("payload.user.login", makeContext())).toBe("alice");
  });

  it("resolves payload number field", () => {
    expect(resolveField("payload.number", makeContext())).toBe(42);
  });

  it("resolves headers case-insensitively", () => {
    expect(resolveField("headers.X-GitHub-Event", makeContext())).toBe("pull_request");
    expect(resolveField("headers.x-github-event", makeContext())).toBe("pull_request");
  });

  it("resolves event_type", () => {
    expect(resolveField("event_type", makeContext())).toBe("pull_request");
  });

  it("returns undefined for missing path", () => {
    expect(resolveField("payload.nonexistent.path", makeContext())).toBeUndefined();
  });

  it("returns undefined when traversing non-object", () => {
    expect(resolveField("payload.number.foo", makeContext())).toBeUndefined();
  });

  it("handles array index", () => {
    const ctx = makeContext({
      payload: { items: [{ id: "a" }, { id: "b" }] },
    });
    expect(resolveField("payload.items.1.id", ctx)).toBe("b");
  });

  it("returns undefined for out-of-range array index", () => {
    const ctx = makeContext({
      payload: { items: [{ id: "a" }] },
    });
    expect(resolveField("payload.items.5.id", ctx)).toBeUndefined();
  });

  it("returns undefined for empty path", () => {
    expect(resolveField("", makeContext())).toBeUndefined();
  });

  it("handles null payload value", () => {
    const ctx = makeContext({ payload: { foo: null } });
    expect(resolveField("payload.foo", ctx)).toBeNull();
  });

  it("resolves single-segment path from payload by default", () => {
    expect(resolveField("action", makeContext())).toBe("opened");
  });

  it("handles unknown root namespace by looking up full path in payload", () => {
    // 未知根命名空间时，将整条路径（含根）作为 payload 中的路径
    const ctx = makeContext({ payload: { custom: { nested: "value" } } });
    expect(resolveField("custom.nested", ctx)).toBe("value");
  });

  it("returns undefined when unknown root key not present in payload", () => {
    const ctx = makeContext({ payload: { foo: { bar: "baz" } } });
    expect(resolveField("unknown.foo.bar", ctx)).toBeUndefined();
  });
});

describe("matchFilter - leaf operators", () => {
  it("exists: passes when field present", () => {
    const f: WebhookFilter = { op: "all", field: "payload.user.id", operator: "exists" };
    expect(matchFilter(f, makeContext())).toBe(true);
  });

  it("exists: fails when field missing", () => {
    const f: WebhookFilter = { op: "all", field: "payload.missing", operator: "exists" };
    expect(matchFilter(f, makeContext())).toBe(false);
  });

  it("exists: treats null as not existing", () => {
    const ctx = makeContext({ payload: { x: null } });
    const f: WebhookFilter = { op: "all", field: "payload.x", operator: "exists" };
    expect(matchFilter(f, ctx)).toBe(false);
  });

  it("missing: passes when field absent", () => {
    const f: WebhookFilter = { op: "all", field: "payload.absent", operator: "missing" };
    expect(matchFilter(f, makeContext())).toBe(true);
  });

  it("missing: fails when field present", () => {
    const f: WebhookFilter = { op: "all", field: "payload.user.id", operator: "missing" };
    expect(matchFilter(f, makeContext())).toBe(false);
  });

  it("equals: matches primitive value", () => {
    const f: WebhookFilter = { op: "all", field: "payload.action", operator: "equals", value: "opened" };
    expect(matchFilter(f, makeContext())).toBe(true);
  });

  it("equals: fails on mismatch", () => {
    const f: WebhookFilter = { op: "all", field: "payload.action", operator: "equals", value: "closed" };
    expect(matchFilter(f, makeContext())).toBe(false);
  });

  it("equals: matches object value via deep equality", () => {
    const ctx = makeContext({ payload: { obj: { a: 1, b: 2 } } });
    const f: WebhookFilter = {
      op: "all",
      field: "payload.obj",
      operator: "equals",
      value: { b: 2, a: 1 },
    };
    expect(matchFilter(f, ctx)).toBe(true);
  });

  it("not_equals: passes on different value", () => {
    const f: WebhookFilter = { op: "all", field: "payload.action", operator: "not_equals", value: "closed" };
    expect(matchFilter(f, makeContext())).toBe(true);
  });

  it("not_equals: fails on same value", () => {
    const f: WebhookFilter = { op: "all", field: "payload.action", operator: "not_equals", value: "opened" };
    expect(matchFilter(f, makeContext())).toBe(false);
  });

  it("contains: substring match on string", () => {
    const f: WebhookFilter = {
      op: "all",
      field: "payload.user.login",
      operator: "contains",
      value: "lic",
    };
    expect(matchFilter(f, makeContext())).toBe(true);
  });

  it("contains: element match on array", () => {
    const ctx = makeContext({ payload: { tags: ["a", "b", "c"] } });
    const f: WebhookFilter = {
      op: "all",
      field: "payload.tags",
      operator: "contains",
      value: "b",
    };
    expect(matchFilter(f, ctx)).toBe(true);
  });

  it("contains: fails on missing substring", () => {
    const f: WebhookFilter = {
      op: "all",
      field: "payload.user.login",
      operator: "contains",
      value: "xyz",
    };
    expect(matchFilter(f, makeContext())).toBe(false);
  });

  it("in: matches when value in list", () => {
    const f: WebhookFilter = {
      op: "all",
      field: "payload.action",
      operator: "in",
      value: ["opened", "reopened"],
    };
    expect(matchFilter(f, makeContext())).toBe(true);
  });

  it("in: fails when value not in list", () => {
    const f: WebhookFilter = {
      op: "all",
      field: "payload.action",
      operator: "in",
      value: ["closed", "edited"],
    };
    expect(matchFilter(f, makeContext())).toBe(false);
  });

  it("in: fails when value is not an array", () => {
    const f: WebhookFilter = {
      op: "all",
      field: "payload.action",
      operator: "in",
      value: "opened",
    };
    expect(matchFilter(f, makeContext())).toBe(false);
  });

  it("regex: matches pattern", () => {
    const f: WebhookFilter = {
      op: "all",
      field: "payload.user.login",
      operator: "regex",
      value: "^al.*",
    };
    expect(matchFilter(f, makeContext())).toBe(true);
  });

  it("regex: fails on non-match", () => {
    const f: WebhookFilter = {
      op: "all",
      field: "payload.user.login",
      operator: "regex",
      value: "^bob",
    };
    expect(matchFilter(f, makeContext())).toBe(false);
  });

  it("regex: fails on non-string field", () => {
    const f: WebhookFilter = {
      op: "all",
      field: "payload.number",
      operator: "regex",
      value: ".*",
    };
    expect(matchFilter(f, makeContext())).toBe(false);
  });

  it("regex: returns false on invalid pattern", () => {
    const f: WebhookFilter = {
      op: "all",
      field: "payload.user.login",
      operator: "regex",
      value: "(", // invalid regex
    };
    expect(matchFilter(f, makeContext())).toBe(false);
  });

  it("returns false when field/operator missing on leaf", () => {
    const f: WebhookFilter = { op: "all" };
    expect(matchFilter(f, makeContext())).toBe(false);
  });
});

describe("matchFilter - composite operators", () => {
  it("all: requires every condition", () => {
    const f: WebhookFilter = {
      op: "all",
      conditions: [
        { op: "all", field: "payload.action", operator: "equals", value: "opened" },
        { op: "all", field: "payload.number", operator: "equals", value: 42 },
      ],
    };
    expect(matchFilter(f, makeContext())).toBe(true);
  });

  it("all: fails when one condition fails", () => {
    const f: WebhookFilter = {
      op: "all",
      conditions: [
        { op: "all", field: "payload.action", operator: "equals", value: "opened" },
        { op: "all", field: "payload.number", operator: "equals", value: 99 },
      ],
    };
    expect(matchFilter(f, makeContext())).toBe(false);
  });

  it("all: empty conditions passes (vacuous truth)", () => {
    const f: WebhookFilter = { op: "all", conditions: [] };
    expect(matchFilter(f, makeContext())).toBe(true);
  });

  it("any: passes when at least one matches", () => {
    const f: WebhookFilter = {
      op: "any",
      conditions: [
        { op: "all", field: "payload.action", operator: "equals", value: "closed" },
        { op: "all", field: "payload.action", operator: "equals", value: "opened" },
      ],
    };
    expect(matchFilter(f, makeContext())).toBe(true);
  });

  it("any: fails when none match", () => {
    const f: WebhookFilter = {
      op: "any",
      conditions: [
        { op: "all", field: "payload.action", operator: "equals", value: "closed" },
        { op: "all", field: "payload.action", operator: "equals", value: "edited" },
      ],
    };
    expect(matchFilter(f, makeContext())).toBe(false);
  });

  it("any: empty conditions fails", () => {
    const f: WebhookFilter = { op: "any", conditions: [] };
    expect(matchFilter(f, makeContext())).toBe(false);
  });

  it("not: negates single condition", () => {
    const f: WebhookFilter = {
      op: "not",
      conditions: [
        { op: "all", field: "payload.action", operator: "equals", value: "closed" },
      ],
    };
    expect(matchFilter(f, makeContext())).toBe(true);
  });

  it("not: negates matching single condition to false", () => {
    const f: WebhookFilter = {
      op: "not",
      conditions: [
        { op: "all", field: "payload.action", operator: "equals", value: "opened" },
      ],
    };
    expect(matchFilter(f, makeContext())).toBe(false);
  });

  it("nested: all(any, not)", () => {
    const f: WebhookFilter = {
      op: "all",
      conditions: [
        {
          op: "any",
          conditions: [
            { op: "all", field: "payload.action", operator: "equals", value: "closed" },
            { op: "all", field: "payload.action", operator: "equals", value: "opened" },
          ],
        },
        {
          op: "not",
          conditions: [
            { op: "all", field: "payload.draft", operator: "exists" },
          ],
        },
      ],
    };
    expect(matchFilter(f, makeContext())).toBe(true);
  });

  it("filter undefined returns true (no filtering)", () => {
    expect(matchFilter(undefined, makeContext())).toBe(true);
  });
});

// ── IncomingWebhookManager integration: filter on trigger ────────────────

describe("IncomingWebhookManager.trigger with filter", () => {
  let manager: IncomingWebhookManager;

  beforeEach(() => {
    manager = new IncomingWebhookManager();
  });

  afterEach(() => {
    manager.dispose();
  });

  it("returns 202 and skips handler when filter does not match", async () => {
    const handler = vi.fn().mockResolvedValue({ statusCode: 200 });
    manager.setActionHandler(handler);
    manager.register({
      id: "ep-filter",
      path: "/wh",
      method: "POST",
      action: "test",
      enabled: true,
      filter: {
        op: "all",
        field: "payload.action",
        operator: "equals",
        value: "opened",
      },
    });

    const result = await manager.trigger(
      "ep-filter",
      "/wh",
      "POST",
      {},
      { action: "closed" },
    );

    expect(result.statusCode).toBe(202);
    expect(result.eventLog.error).toBe("Filter did not match");
    expect(handler).not.toHaveBeenCalled();
    // 不应计入 triggerCount（过滤未通过）
    expect(manager.get("ep-filter")!.triggerCount).toBe(0);
  });

  it("invokes handler when filter matches", async () => {
    const handler = vi.fn().mockResolvedValue({ statusCode: 200, response: { ok: true } });
    manager.setActionHandler(handler);
    manager.register({
      id: "ep-filter",
      path: "/wh",
      method: "POST",
      action: "test",
      enabled: true,
      filter: {
        op: "all",
        field: "payload.action",
        operator: "equals",
        value: "opened",
      },
    });

    const result = await manager.trigger(
      "ep-filter",
      "/wh",
      "POST",
      {},
      { action: "opened" },
    );

    expect(result.statusCode).toBe(200);
    expect(handler).toHaveBeenCalledTimes(1);
    expect(manager.get("ep-filter")!.triggerCount).toBe(1);
  });

  it("no filter means all requests pass through", async () => {
    const handler = vi.fn().mockResolvedValue({ statusCode: 200 });
    manager.setActionHandler(handler);
    manager.register({
      id: "ep-nofilter",
      path: "/wh",
      method: "POST",
      action: "test",
      enabled: true,
    });

    const result = await manager.trigger("ep-nofilter", "/wh", "POST", {}, { anything: true });
    expect(result.statusCode).toBe(200);
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it("uses x-github-event header in eventType-derived filter", async () => {
    const handler = vi.fn().mockResolvedValue({ statusCode: 200 });
    manager.setActionHandler(handler);
    manager.register({
      id: "ep-event",
      path: "/wh",
      method: "POST",
      action: "fallback-action",
      enabled: true,
      filter: {
        op: "all",
        field: "event_type",
        operator: "equals",
        value: "pull_request",
      },
    });

    const result = await manager.trigger(
      "ep-event",
      "/wh",
      "POST",
      { "x-github-event": "pull_request" },
      {},
    );
    expect(result.statusCode).toBe(200);
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it("falls back to action when no event header present", async () => {
    const handler = vi.fn().mockResolvedValue({ statusCode: 200 });
    manager.setActionHandler(handler);
    manager.register({
      id: "ep-action",
      path: "/wh",
      method: "POST",
      action: "my-action",
      enabled: true,
      filter: {
        op: "all",
        field: "event_type",
        operator: "equals",
        value: "my-action",
      },
    });

    const result = await manager.trigger("ep-action", "/wh", "POST", {}, {});
    expect(result.statusCode).toBe(200);
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it("filter can match on headers", async () => {
    const handler = vi.fn().mockResolvedValue({ statusCode: 200 });
    manager.setActionHandler(handler);
    manager.register({
      id: "ep-header",
      path: "/wh",
      method: "POST",
      action: "test",
      enabled: true,
      filter: {
        op: "all",
        field: "headers.x-github-event",
        operator: "equals",
        value: "push",
      },
    });

    const pass = await manager.trigger(
      "ep-header",
      "/wh",
      "POST",
      { "x-github-event": "push" },
      {},
    );
    expect(pass.statusCode).toBe(200);

    const fail = await manager.trigger(
      "ep-header",
      "/wh",
      "POST",
      { "x-github-event": "pull_request" },
      {},
    );
    expect(fail.statusCode).toBe(202);
  });
});

// ── Persistence ──────────────────────────────────────────────────────────

describe("IncomingWebhookManager persistence", () => {
  let tmpDir: string;
  let persistencePath: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "wh-test-"));
    persistencePath = path.join(tmpDir, "webhook-subscriptions.json");
  });

  afterEach(() => {
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch {
      // ignore
    }
  });

  it("persists endpoints on register", () => {
    const manager = new IncomingWebhookManager({ persistencePath });
    manager.register({
      id: "ep-1",
      path: "/wh",
      method: "POST",
      action: "test",
      enabled: true,
    });

    expect(fs.existsSync(persistencePath)).toBe(true);
    const data = JSON.parse(fs.readFileSync(persistencePath, "utf-8"));
    expect(Array.isArray(data)).toBe(true);
    expect(data).toHaveLength(1);
    expect(data[0].id).toBe("ep-1");
    expect(data[0].path).toBe("/wh");
    manager.dispose();
  });

  it("persists filter along with endpoint", () => {
    const manager = new IncomingWebhookManager({ persistencePath });
    manager.register({
      id: "ep-1",
      path: "/wh",
      method: "POST",
      action: "test",
      enabled: true,
      filter: { op: "all", field: "payload.action", operator: "equals", value: "opened" },
    });

    const data = JSON.parse(fs.readFileSync(persistencePath, "utf-8"));
    expect(data[0].filter).toBeDefined();
    expect(data[0].filter.op).toBe("all");
    manager.dispose();
  });

  it("loads endpoints from persistence file on construction", () => {
    // 第一次实例写入
    const m1 = new IncomingWebhookManager({ persistencePath });
    m1.register({
      id: "ep-persist",
      path: "/wh/persist",
      method: "POST",
      action: "loaded",
      enabled: true,
    });
    m1.dispose();

    // 第二次实例应加载到已写入的 endpoint
    const m2 = new IncomingWebhookManager({ persistencePath });
    const ep = m2.get("ep-persist");
    expect(ep).toBeDefined();
    expect(ep!.path).toBe("/wh/persist");
    expect(ep!.action).toBe("loaded");
    m2.dispose();
  });

  it("updates persistence on unregister", () => {
    const manager = new IncomingWebhookManager({ persistencePath });
    manager.register({
      id: "ep-1",
      path: "/wh",
      method: "POST",
      action: "test",
      enabled: true,
    });
    manager.register({
      id: "ep-2",
      path: "/wh2",
      method: "POST",
      action: "test2",
      enabled: true,
    });

    manager.delete("ep-1");
    const data = JSON.parse(fs.readFileSync(persistencePath, "utf-8"));
    expect(data).toHaveLength(1);
    expect(data[0].id).toBe("ep-2");
    manager.dispose();
  });

  it("updates persistence on update", () => {
    const manager = new IncomingWebhookManager({ persistencePath });
    manager.register({
      id: "ep-1",
      path: "/wh",
      method: "POST",
      action: "test",
      enabled: true,
    });
    manager.update("ep-1", { action: "updated-action" });

    const data = JSON.parse(fs.readFileSync(persistencePath, "utf-8"));
    expect(data[0].action).toBe("updated-action");
    manager.dispose();
  });

  it("does not persist when persistencePath is not set", () => {
    const manager = new IncomingWebhookManager();
    manager.register({
      id: "ep-1",
      path: "/wh",
      method: "POST",
      action: "test",
      enabled: true,
    });
    expect(fs.existsSync(persistencePath)).toBe(false);
    manager.dispose();
  });

  it("handles missing persistence file gracefully", () => {
    // 文件不存在时不应抛出
    const manager = new IncomingWebhookManager({ persistencePath });
    expect(manager.list()).toHaveLength(0);
    manager.dispose();
  });

  it("handles corrupted persistence file gracefully", () => {
    fs.writeFileSync(persistencePath, "not valid json {{{", "utf-8");
    // 不应抛出，仅记录到 stderr
    const manager = new IncomingWebhookManager({ persistencePath });
    expect(manager.list()).toHaveLength(0);
    manager.dispose();
  });

  it("loads filter from persistence", () => {
    const m1 = new IncomingWebhookManager({ persistencePath });
    m1.register({
      id: "ep-1",
      path: "/wh",
      method: "POST",
      action: "test",
      enabled: true,
      filter: { op: "all", field: "payload.action", operator: "equals", value: "opened" },
    });
    m1.dispose();

    const m2 = new IncomingWebhookManager({ persistencePath });
    const ep = m2.get("ep-1");
    expect(ep!.filter).toBeDefined();
    expect(ep!.filter!.op).toBe("all");
    expect(ep!.filter!.field).toBe("payload.action");
    m2.dispose();
  });

  it("skips invalid entries in persistence file", () => {
    const invalid = [
      { id: "valid", path: "/wh", method: "POST", action: "a", enabled: true, createdAt: "x", triggerCount: 0 },
      { id: 123, path: "/wh" }, // invalid id type
      "not an object",
      null,
    ];
    fs.writeFileSync(persistencePath, JSON.stringify(invalid), "utf-8");
    const manager = new IncomingWebhookManager({ persistencePath });
    expect(manager.list()).toHaveLength(1);
    expect(manager.get("valid")).toBeDefined();
    manager.dispose();
  });
});
