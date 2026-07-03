import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  clarifyTool,
  flattenChoice,
  clarifyError,
  clarifySuccess,
  checkClarifyRequirements,
  ClarifyGateway,
  getClarifyGateway,
  _resetClarifyGatewayForTests,
  CLARIFY_SCHEMA,
  MAX_CHOICES,
  DEFAULT_CLARIFY_TIMEOUT_MS,
} from "./clarify-tool";

// ── Constants & schema ────────────────────────────────────────────────
describe("clarify-tool: constants & schema", () => {
  it("MAX_CHOICES is 4 and DEFAULT_CLARIFY_TIMEOUT_MS is 1 hour", () => {
    expect(MAX_CHOICES).toBe(4);
    expect(DEFAULT_CLARIFY_TIMEOUT_MS).toBe(3_600_000);
  });

  it("CLARIFY_SCHEMA has name 'clarify' and choices maxItems = MAX_CHOICES", () => {
    expect(CLARIFY_SCHEMA.name).toBe("clarify");
    expect(CLARIFY_SCHEMA.parameters.properties.choices.maxItems).toBe(MAX_CHOICES);
    expect(CLARIFY_SCHEMA.parameters.required).toEqual(["question"]);
  });
});

// ── flattenChoice ─────────────────────────────────────────────────────
describe("clarify-tool: flattenChoice", () => {
  it("null / undefined → empty string", () => {
    expect(flattenChoice(null)).toBe("");
    expect(flattenChoice(undefined)).toBe("");
  });

  it("bare string → trimmed", () => {
    expect(flattenChoice("  yes  ")).toBe("yes");
  });

  it("object: label takes priority over description/text/title", () => {
    expect(flattenChoice({ label: "Label", description: "Desc" })).toBe("Label");
  });

  it("object: description used when no label", () => {
    expect(flattenChoice({ description: "Desc" })).toBe("Desc");
  });

  it("object: name/value deliberately excluded → empty string", () => {
    // name and value are component-shaped fields, not human-readable labels.
    expect(flattenChoice({ name: "opt1", value: "x" })).toBe("");
  });

  it("array → recursive join with spaces", () => {
    expect(flattenChoice(["a", "b", "c"])).toBe("a b c");
  });
});

// ── clarifyError / clarifySuccess / checkClarifyRequirements ──────────
describe("clarify-tool: result helpers", () => {
  it("clarifyError wraps message", () => {
    expect(clarifyError("oops")).toEqual({ error: "oops" });
  });

  it("clarifySuccess trims user response", () => {
    const r = clarifySuccess("Q?", ["a", "b"], "  yes  ");
    expect(r).toEqual({
      question: "Q?",
      choices_offered: ["a", "b"],
      user_response: "yes",
    });
  });

  it("checkClarifyRequirements always returns true", () => {
    expect(checkClarifyRequirements()).toBe(true);
  });
});

// ── clarifyTool ───────────────────────────────────────────────────────
describe("clarify-tool: clarifyTool", () => {
  it("empty question → error", async () => {
    const r = await clarifyTool({ question: "  ", callback: async () => "x" });
    expect(r.error).toBe("Question text is required.");
  });

  it("non-array choices → error", async () => {
    const r = await clarifyTool({ question: "Q?", choices: "not-array" as unknown as unknown[], callback: async () => "x" });
    expect(r.error).toBe("choices must be a list of strings.");
  });

  it("choices exceeding MAX_CHOICES are sliced to 4", async () => {
    const cb = vi.fn(async (_q: string, _c: string[] | null): Promise<string> => "pick");
    const r = await clarifyTool({
      question: "Q?",
      choices: ["a", "b", "c", "d", "e", "f"],
      callback: cb,
    });
    expect(r.choices_offered).toEqual(["a", "b", "c", "d"]);
    expect(cb).toHaveBeenCalledWith("Q?", ["a", "b", "c", "d"]);
  });

  it("dict-shaped choices are flattened before reaching callback", async () => {
    const cb = vi.fn(async (_q: string, _c: string[] | null): Promise<string> => "yes");
    await clarifyTool({
      question: "Q?",
      choices: [{ label: "Yes" }, { description: "Maybe" }, "No"],
      callback: cb,
    });
    expect(cb).toHaveBeenCalledWith("Q?", ["Yes", "Maybe", "No"]);
  });

  it("no callback → context error", async () => {
    const r = await clarifyTool({ question: "Q?" });
    expect(r.error).toBe("Clarify tool is not available in this execution context.");
  });

  it("callback throws → wrapped error", async () => {
    const r = await clarifyTool({
      question: "Q?",
      callback: async () => {
        throw new Error("UI crashed");
      },
    });
    expect(r.error).toBe("Failed to get user input: UI crashed");
  });

  it("happy path returns clarifySuccess", async () => {
    const r = await clarifyTool({
      question: "Deploy?",
      choices: ["staging", "prod"],
      callback: async () => "prod",
    });
    expect(r.user_response).toBe("prod");
    expect(r.choices_offered).toEqual(["staging", "prod"]);
  });
});

// ── ClarifyGateway ────────────────────────────────────────────────────
describe("clarify-tool: ClarifyGateway", () => {
  let gw: ClarifyGateway;

  beforeEach(() => {
    gw = new ClarifyGateway();
  });

  it("register returns entry + response promise; open-ended sets awaitingText", () => {
    const { entry, response } = gw.register({ sessionKey: "s1", question: "Q?" });
    expect(entry.clarifyId).toBeTruthy();
    expect(entry.awaitingText).toBe(true); // no choices → open-ended
    expect(entry.sessionKey).toBe("s1");
    expect(response).toBeInstanceOf(Promise);
  });

  it("register with choices sets awaitingText=false", () => {
    const { entry } = gw.register({
      sessionKey: "s1",
      question: "Q?",
      choices: ["a", "b"],
    });
    expect(entry.awaitingText).toBe(false);
  });

  it("resolveGatewayClarify resolves the response promise", async () => {
    const { entry, response } = gw.register({ sessionKey: "s1", question: "Q?" });
    expect(gw.resolveGatewayClarify(entry.clarifyId, "user_answer")).toBe(true);
    const result = await response;
    expect(result).toBe("user_answer");
  });

  it("resolveGatewayClarify returns false for unknown id", () => {
    expect(gw.resolveGatewayClarify("nonexistent", "x")).toBe(false);
  });

  it("RACE FIX: response resolves even when resolveGatewayClarify fires before await", async () => {
    // Regression (F9.1): the old wrapping approach lost responses when
    // resolveGatewayClarify fired before waitForResponse installed the
    // wrapper. The fix stores responsePromise on the entry at register
    // time, so the promise is always available regardless of timing.
    const { entry, response } = gw.register({ sessionKey: "s1", question: "Q?" });
    // Simulate user responding IMMEDIATELY (before any await / waitForResponse).
    gw.resolveGatewayClarify(entry.clarifyId, "user_choice");
    const result = await response;
    expect(result).toBe("user_choice"); // NOT null/timeout
  });

  it("waitForResponse returns null for unknown id", async () => {
    expect(await gw.waitForResponse("nope", 50)).toBeNull();
  });

  it("waitForResponse times out and returns null (ms not seconds)", async () => {
    vi.useFakeTimers();
    try {
      const { entry } = gw.register({ sessionKey: "s1", question: "Q?" });
      // 50ms — the unit is milliseconds (regression: old code treated as seconds).
      const waitP = gw.waitForResponse(entry.clarifyId, 50);
      await vi.advanceTimersByTimeAsync(50);
      const result = await waitP;
      expect(result).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it("after resolveGatewayClarify, entry is gone but response promise already resolved", async () => {
    const { entry, response } = gw.register({ sessionKey: "s1", question: "Q?" });
    gw.resolveGatewayClarify(entry.clarifyId, "early_answer");
    // Entry was removed by resolveGatewayClarify, so waitForResponse can't find it.
    expect(await gw.waitForResponse(entry.clarifyId, 1000)).toBeNull();
    // But the response promise from register already resolved with the answer.
    expect(await response).toBe("early_answer");
  });

  it("hasPending reflects active entries", () => {
    expect(gw.hasPending("s1")).toBe(false);
    gw.register({ sessionKey: "s1", question: "Q?" });
    expect(gw.hasPending("s1")).toBe(true);
  });

  it("clearSession cancels entries with empty-string sentinel", async () => {
    const { response } = gw.register({ sessionKey: "s1", question: "Q?" });
    const n = gw.clearSession("s1");
    expect(n).toBe(1);
    expect(await response).toBe("");
    expect(gw.hasPending("s1")).toBe(false);
  });

  it("getPendingForSession only returns text-awaiting by default", () => {
    // Open-ended (no choices) → awaitingText=true → returned.
    gw.register({ sessionKey: "s1", question: "Open?" });
    expect(gw.getPendingForSession("s1")).not.toBeNull();

    gw.clearSession("s1");

    // Choice-based → awaitingText=false → NOT returned without flag.
    gw.register({ sessionKey: "s1", question: "Pick?", choices: ["a", "b"] });
    expect(gw.getPendingForSession("s1")).toBeNull();
    expect(gw.getPendingForSession("s1", { includeChoicePrompts: true })).not.toBeNull();
  });

  it("markAwaitingText flips a choice entry into text-capture mode", () => {
    const { entry } = gw.register({
      sessionKey: "s1",
      question: "Q?",
      choices: ["a", "b"],
    });
    expect(gw.getPendingForSession("s1")).toBeNull();
    expect(gw.markAwaitingText(entry.clarifyId)).toBe(true);
    // Now visible without includeChoicePrompts.
    expect(gw.getPendingForSession("s1")).not.toBeNull();
  });

  it("resolveTextResponseForSession coerces numeric text to choice", async () => {
    const { response } = gw.register({
      sessionKey: "s1",
      question: "Q?",
      choices: ["Yes", "No", "Maybe"],
    });
    // User typed "2" → index 1 → "No"
    expect(gw.resolveTextResponseForSession("s1", "2")).toBe(true);
    expect(await response).toBe("No");
  });

  it("clearAll cancels every pending entry across sessions", () => {
    gw.register({ sessionKey: "s1", question: "Q1?" });
    gw.register({ sessionKey: "s2", question: "Q2?" });
    const n = gw.clearAll();
    expect(n).toBe(2);
    expect(gw.hasPending("s1")).toBe(false);
    expect(gw.hasPending("s2")).toBe(false);
  });
});

// ── Singleton accessor ────────────────────────────────────────────────
describe("clarify-tool: singleton", () => {
  afterEach(() => {
    _resetClarifyGatewayForTests();
  });

  it("getClarifyGateway returns the same instance", () => {
    const a = getClarifyGateway();
    const b = getClarifyGateway();
    expect(a).toBe(b);
  });

  it("_resetClarifyGatewayForTests clears pending and nulls singleton", () => {
    const a = getClarifyGateway();
    a.register({ sessionKey: "sx", question: "Q?" });
    expect(a.hasPending("sx")).toBe(true);
    _resetClarifyGatewayForTests();
    const b = getClarifyGateway();
    expect(b).not.toBe(a);
    expect(b.hasPending("sx")).toBe(false);
  });
});
