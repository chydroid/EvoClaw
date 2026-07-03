import { describe, it, expect, vi } from "vitest";
import {
  MEMORY_REVIEW_PROMPT,
  SKILL_REVIEW_PROMPT,
  COMBINED_REVIEW_PROMPT,
  DEFAULT_REVIEW_CONFIG,
  digestHistory,
  shouldRunBackgroundReview,
  summarizeBackgroundReviewActions,
  runBackgroundReview,
  resolveReviewRuntime,
  type ReviewMessage,
  type BackgroundReviewConfig,
} from "./background-review";

describe("background-review", () => {
  describe("prompt constants & defaults", () => {
    it("all prompt constants are non-empty strings", () => {
      expect(typeof MEMORY_REVIEW_PROMPT).toBe("string");
      expect(MEMORY_REVIEW_PROMPT.length).toBeGreaterThan(0);
      expect(typeof SKILL_REVIEW_PROMPT).toBe("string");
      expect(SKILL_REVIEW_PROMPT.length).toBeGreaterThan(0);
      expect(typeof COMBINED_REVIEW_PROMPT).toBe("string");
      expect(COMBINED_REVIEW_PROMPT.length).toBeGreaterThan(0);
    });

    it("DEFAULT_REVIEW_CONFIG has sensible defaults", () => {
      expect(DEFAULT_REVIEW_CONFIG.enabled).toBe(false);
      expect(DEFAULT_REVIEW_CONFIG.intervalTurns).toBe(10);
      expect(DEFAULT_REVIEW_CONFIG.reviewMemory).toBe(true);
      expect(DEFAULT_REVIEW_CONFIG.reviewSkills).toBe(true);
      expect(DEFAULT_REVIEW_CONFIG.digestTail).toBeGreaterThan(0);
    });
  });

  describe("shouldRunBackgroundReview", () => {
    const cfg: BackgroundReviewConfig = { ...DEFAULT_REVIEW_CONFIG, enabled: true, intervalTurns: 10 };

    it("returns false when disabled", () => {
      expect(
        shouldRunBackgroundReview(10, { ...cfg, enabled: false }),
      ).toBe(false);
    });

    it("returns true at exact interval multiples (turnIndex > 0)", () => {
      expect(shouldRunBackgroundReview(10, cfg)).toBe(true);
      expect(shouldRunBackgroundReview(20, cfg)).toBe(true);
    });

    it("returns false at turnIndex 0 (gated by turnIndex > 0)", () => {
      // turnIndex 0 is gated out even though 0 % 10 === 0.
      expect(shouldRunBackgroundReview(0, cfg)).toBe(false);
    });

    it("returns false for non-multiples", () => {
      expect(shouldRunBackgroundReview(5, cfg)).toBe(false);
      expect(shouldRunBackgroundReview(7, cfg)).toBe(false);
    });
  });

  describe("digestHistory (regression: negative-index / role-alternation)", () => {
    it("regression: keep slice must not start with a tool message", () => {
      // Build a history whose last 2 messages are [tool, user]. The naive
      // keep = msgs[-2:] would start with `tool`, violating role alternation.
      // The fix expands effectiveTail so the preceding assistant is included.
      const msgs: ReviewMessage[] = [
        { role: "user", content: "u1" },
        { role: "assistant", content: "a1" },
        { role: "tool", content: "t1" },
        { role: "user", content: "u2" },
      ];

      const result = digestHistory(msgs, 2);

      // Result is [digest(user), ...keep]. The first non-digest message must
      // NOT be a tool message.
      expect(result.length).toBeGreaterThan(0);
      const keep = result.slice(1);
      expect(keep.length).toBeGreaterThan(0);
      expect(keep[0].role).not.toBe("tool");
      // The expanded keep should include the assistant that precedes the tool.
      expect(keep[0].role).toBe("assistant");
      // The final message is preserved verbatim.
      expect(keep[keep.length - 1].role).toBe("user");
      expect(keep[keep.length - 1].content).toBe("u2");
    });

    it("returns messages unchanged when length <= tail", () => {
      const msgs: ReviewMessage[] = [
        { role: "user", content: "hi" },
        { role: "assistant", content: "hello" },
      ];
      const result = digestHistory(msgs, 24);
      expect(result).toBe(msgs);
    });

    it("the synthetic digest is a user-role message summarising older turns", () => {
      const msgs: ReviewMessage[] = [
        { role: "user", content: "first question" },
        { role: "assistant", content: "first answer" },
        { role: "user", content: "second" },
        { role: "assistant", content: "second answer" },
      ];
      const result = digestHistory(msgs, 2);
      expect(result[0].role).toBe("user");
      expect(typeof result[0].content).toBe("string");
      expect((result[0].content as string).length).toBeGreaterThan(0);
    });
  });

  describe("resolveReviewRuntime", () => {
    it("inherits parent runtime when no aux config / auto", () => {
      const rt = resolveReviewRuntime({
        parentProvider: "openai",
        parentModel: "gpt-4o",
      });
      expect(rt.routed).toBe(false);
      expect(rt.provider).toBe("openai");
      expect(rt.model).toBe("gpt-4o");
    });

    it("routes to a different model when explicitly configured", () => {
      const rt = resolveReviewRuntime({
        parentProvider: "openai",
        parentModel: "gpt-4o",
        config: {
          auxiliary: {
            background_review: { provider: "anthropic", model: "claude-opus-4" },
          },
        },
      });
      expect(rt.routed).toBe(true);
      expect(rt.provider).toBe("anthropic");
      expect(rt.model).toBe("claude-opus-4");
    });
  });

  describe("summarizeBackgroundReviewActions", () => {
    it("returns empty when notificationMode is off", () => {
      const actions = summarizeBackgroundReviewActions([], [], "off");
      expect(actions).toEqual([]);
    });

    it("extracts a successful memory tool call as an action", () => {
      const review: ReviewMessage[] = [
        {
          role: "assistant",
          tool_calls: [
            {
              id: "call_1",
              function: {
                name: "memory",
                arguments: JSON.stringify({ action: "add", target: "user", content: "likes tea" }),
              },
            },
          ],
        },
        {
          role: "tool",
          tool_call_id: "call_1",
          content: JSON.stringify({ success: true, message: "Memory added" }),
        },
      ];
      const actions = summarizeBackgroundReviewActions(review, [], "on");
      expect(actions.length).toBeGreaterThan(0);
      // "added" keyword in the message triggers the on-mode notice.
      expect(actions[0].tool).toMatch(/Memory|User/);
    });

    it("skips tool calls whose result is not successful", () => {
      const review: ReviewMessage[] = [
        {
          role: "assistant",
          tool_calls: [
            {
              id: "call_x",
              function: { name: "memory", arguments: JSON.stringify({}) },
            },
          ],
        },
        {
          role: "tool",
          tool_call_id: "call_x",
          content: JSON.stringify({ success: false, message: "nope" }),
        },
      ];
      const actions = summarizeBackgroundReviewActions(review, [], "on");
      expect(actions).toEqual([]);
    });
  });

  describe("runBackgroundReview", () => {
    it("returns [] immediately when disabled", async () => {
      const chatFn = vi.fn();
      const actions = await runBackgroundReview({
        parentProvider: "openai",
        parentModel: "gpt-4o",
        messagesSnapshot: [],
        chatFn,
        config: { enabled: false },
      });
      expect(actions).toEqual([]);
      expect(chatFn).not.toHaveBeenCalled();
    });

    it("invokes chatFn and reports actions on success", async () => {
      const chatFn = vi.fn().mockResolvedValue([
        {
          role: "assistant",
          tool_calls: [
            {
              id: "c1",
              function: {
                name: "memory",
                arguments: JSON.stringify({ action: "add", target: "memory", content: "fact" }),
              },
            },
          ],
        },
        {
          role: "tool",
          tool_call_id: "c1",
          content: JSON.stringify({ success: true, message: "Memory added" }),
        },
      ] as ReviewMessage[]);

      const onComplete = vi.fn();
      const actions = await runBackgroundReview({
        parentProvider: "openai",
        parentModel: "gpt-4o",
        messagesSnapshot: [{ role: "user", content: "hello" }],
        chatFn,
        config: { enabled: true, intervalTurns: 1, reviewMemory: true, reviewSkills: true },
        onComplete,
      });

      expect(chatFn).toHaveBeenCalledTimes(1);
      expect(onComplete).toHaveBeenCalledWith(actions);
      expect(actions.length).toBeGreaterThan(0);
    });

    it("swallows chatFn errors and returns []", async () => {
      const chatFn = vi.fn().mockRejectedValue(new Error("boom"));
      const onError = vi.fn();
      const actions = await runBackgroundReview({
        parentProvider: "openai",
        parentModel: "gpt-4o",
        messagesSnapshot: [],
        chatFn,
        config: { enabled: true, intervalTurns: 1, reviewMemory: true, reviewSkills: true },
        onError,
      });
      expect(actions).toEqual([]);
      expect(onError).toHaveBeenCalled();
    });
  });
});
