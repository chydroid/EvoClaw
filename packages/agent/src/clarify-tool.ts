/**
 * Clarify tool — interactive clarifying questions.
 *
 * Allows the agent to present structured multiple-choice questions or
 * open-ended prompts to the user. In CLI mode, choices are navigable with
 * arrow keys. On messaging platforms, choices are rendered as a numbered
 * list. TypeScript port of hermes-agent/tools/clarify_tool.py +
 * clarify_gateway.py.
 *
 * The actual user-interaction logic lives in the platform layer (CLI / gateway
 * / TUI). This module defines:
 *   1. The OpenAI function-calling schema (CLARIFY_SCHEMA).
 *   2. Validation + the `_flattenChoice` helper that coerces dict-shaped
 *      choices LLMs sometimes emit into bare strings.
 *   3. A thin dispatcher (`clarifyTool`) that delegates to a platform-
 *      provided callback.
 *   4. The gateway-side blocking primitive (`ClarifyGateway`) — a thread-safe
 *      (well, async-safe) registry that lets a worker agent await a user
 *      response that arrives later via the event loop.
 */

// ── Constants ─────────────────────────────────────────────────────────
/** Maximum number of predefined choices the agent can offer. */
export const MAX_CHOICES = 4;

// ── _flatten_choice ───────────────────────────────────────────────────
/**
 * Coerce a single choice into its user-facing display string.
 *
 * The schema declares choices as bare strings, but LLMs sometimes emit
 * dict-shaped choices like `[{"description": "..."}]`. A naive `String(c)`
 * turns the whole object into its JSON repr — which then leaks onto every
 * surface that renders the choice (CLI panel, gateway buttons, numbered list)
 * AND is returned verbatim as the user's answer. Normalising here, at the one
 * platform-agnostic entry point, fixes the whole class in one place.
 *
 * Dict unwrap order is the canonical LLM tool-call user-facing keys:
 * `label` → `description` → `text` → `title`. `name` and `value` are
 * deliberately excluded — they're component-shaped fields that could carry
 * raw enum values or short identifiers, not human-readable labels. An object
 * with none of the canonical keys is dropped (returns ""), since a garbage
 * label is worse than no choice at all.
 */
export function flattenChoice(c: unknown): string {
  if (c === null || c === undefined) return "";
  if (typeof c === "string") return c.trim();
  if (typeof c === "object") {
    if (Array.isArray(c)) {
      return c.map((x) => flattenChoice(x)).join(" ").trim();
    }
    const obj = c as Record<string, unknown>;
    for (const key of ["label", "description", "text", "title"]) {
      const v = obj[key];
      if (typeof v === "string" && v.trim()) return v.trim();
    }
    return "";
  }
  return String(c).trim();
}

// ── OpenAI Function-Calling Schema ────────────────────────────────────
export const CLARIFY_SCHEMA = {
  name: "clarify",
  description:
    "Ask the user a question when you need clarification, feedback, or a " +
    "decision before proceeding. Supports two modes:\n\n" +
    "1. **Multiple choice** — provide up to 4 choices. The user picks one " +
    "or types their own answer via a 5th 'Other' option.\n" +
    "2. **Open-ended** — omit choices entirely. The user types a free-form " +
    "response.\n\n" +
    "CRITICAL: when you are offering options, put each option ONLY in the " +
    "`choices` array — NEVER enumerate the options inside the `question` " +
    "text. The UI renders `choices` as selectable rows; options written " +
    "into the question string render as dead prose the user can't pick. " +
    "Right: question='Which deployment target?', choices=['staging', " +
    "'prod']. Wrong: question='Which target? 1) staging 2) prod', choices=[].\n\n" +
    "Use this tool when:\n" +
    "- The task is ambiguous and you need the user to choose an approach\n" +
    "- You want post-task feedback ('How did that work out?')\n" +
    "- You want to offer to save a skill or update memory\n" +
    "- A decision has meaningful trade-offs the user should weigh in on\n\n" +
    "Do NOT use this tool for simple yes/no confirmation of dangerous " +
    "commands (the terminal tool handles that). Prefer making a reasonable " +
    "default choice yourself when the decision is low-stakes.",
  parameters: {
    type: "object",
    properties: {
      question: {
        type: "string",
        description:
          "The question itself, and ONLY the question (e.g. 'Which " +
          "deployment target?'). Do NOT embed the answer options here " +
          "— pass them as separate elements in `choices`.",
      },
      choices: {
        type: "array",
        items: { type: "string" },
        maxItems: MAX_CHOICES,
        description:
          "REQUIRED whenever you are presenting selectable options: " +
          "each distinct option is its own array element (up to 4). " +
          "The UI renders these as pickable rows and auto-appends an " +
          "'Other (type your answer)' option. Omit this parameter " +
          "entirely ONLY for a genuinely open-ended free-text question.",
      },
    },
    required: ["question"],
  },
} as const;

// ── ClarifyCallback ───────────────────────────────────────────────────
/**
 * Platform-provided function that handles the actual UI interaction.
 * Signature: (question, choices) → response string.
 * Injected by the agent runner (CLI / gateway).
 */
export type ClarifyCallback = (
  question: string,
  choices: string[] | null,
) => string | Promise<string>;

// ── Tool result shape ─────────────────────────────────────────────────
export interface ClarifyResult {
  question?: string;
  choices_offered?: string[] | null;
  user_response?: string;
  error?: string;
}

export function clarifyError(message: string): ClarifyResult {
  return { error: message };
}

export function clarifySuccess(
  question: string,
  choices: string[] | null,
  userResponse: string,
): ClarifyResult {
  return {
    question,
    choices_offered: choices,
    user_response: userResponse.trim(),
  };
}

/**
 * Ask the user a question, optionally with multiple-choice options.
 *
 * Returns a ClarifyResult (object). Callers that need a JSON string can
 * `JSON.stringify` the result. The Python original returned a JSON string
 * because tools on the Python side universally speak JSON; in TypeScript we
 * prefer structured returns and let the caller choose the serialization.
 */
export async function clarifyTool(opts: {
  question: string;
  choices?: unknown[] | null;
  callback?: ClarifyCallback | null;
}): Promise<ClarifyResult> {
  const { callback } = opts;
  const question = (opts.question ?? "").trim();
  if (!question) return clarifyError("Question text is required.");

  // Validate and trim choices
  let choices: string[] | null = null;
  if (opts.choices !== null && opts.choices !== undefined) {
    if (!Array.isArray(opts.choices)) {
      return clarifyError("choices must be a list of strings.");
    }
    // LLMs sometimes emit dict-shaped choices — flattenChoice unwraps them
    // to their user-facing text here, the single platform-agnostic entry
    // point, so the CLI panel, gateway buttons, and numbered list all
    // render clean text and the resolved answer is never a raw object repr.
    const flattened = opts.choices
      .map((c) => flattenChoice(c))
      .filter((s) => s.length > 0);
    if (flattened.length > MAX_CHOICES) {
      choices = flattened.slice(0, MAX_CHOICES);
    } else if (flattened.length > 0) {
      choices = flattened;
    }
    // Empty list → null (open-ended)
  }

  if (!callback) {
    return clarifyError("Clarify tool is not available in this execution context.");
  }

  let userResponse: string;
  try {
    userResponse = await callback(question, choices);
  } catch (exc) {
    const msg = exc instanceof Error ? exc.message : String(exc);
    return clarifyError(`Failed to get user input: ${msg}`);
  }

  return clarifySuccess(question, choices, userResponse);
}

/** Clarify tool has no external requirements — always available. */
export function checkClarifyRequirements(): boolean {
  return true;
}

// =========================================================================
// Gateway-side clarify primitive (blocking event-based queue)
// =========================================================================
//
// The `clarify` tool needs to ask the user a question and block the agent
// thread until they respond. In CLI mode this is trivial — `input()` is
// synchronous. In gateway mode the agent runs on a worker thread (or async
// task) while the event loop handles the user's reply, so we need a
// primitive that:
//   * stores a pending clarify request (with a generated `clarifyId`),
//   * blocks the agent via a Promise that resolves on `resolveGatewayClarify`,
//   * supports timeouts so a user who never responds does NOT hang the agent
//     forever (which would also pin the gateway's running-agent guard).
//
// Two delivery paths from the adapter:
//   1. **Button UI** — adapters override `sendClarify` to render inline
//      buttons. The button callback resolves with the chosen string. A
//      final "Other (type answer)" button enters text-capture mode.
//   2. **Text fallback** — adapters without rich UI render a numbered list.
//      The user replies with a number ("2") or with free text; the gateway's
//      message handler intercepts the reply and resolves directly.

export interface ClarifyEntry {
  clarifyId: string;
  sessionKey: string;
  question: string;
  choices: string[] | null;
  /** Set when user picked "Other" or clarify is open-ended. */
  awaitingText: boolean;
  /** Resolves when the user responds, or rejects on timeout. */
  resolve: (response: string | null) => void;
  /** Optional reject hook for cleanup paths. */
  reject: (err: unknown) => void;
  /** Deadline (Date.now() + timeoutMs) for timeout enforcement. */
  deadline: number;
  /**
   * Promise that resolves with the user response (or null on timeout/cancel).
   * Stored on the entry so `waitForResponse` can race it directly without
   * wrapping `entry.resolve` (the wrapping approach loses responses when
   * `resolveGatewayClarify` fires before `waitForResponse` installs the
   * wrapper — see F9.1 race condition fix).
   */
  responsePromise: Promise<string | null>;
}

/**
 * Default response timeout (ms). Long enough that a user who steps away
 * (meeting, AFK, slow to read) still finds a live entry when they tap the
 * button, short enough that a genuinely abandoned prompt eventually unblocks
 * the agent thread instead of pinning the running-agent guard forever.
 */
export const DEFAULT_CLARIFY_TIMEOUT_MS = 3_600_000; // 1 hour

function randomClarifyId(): string {
  // Cryptographically-irrelevant unique id; `crypto.randomUUID` is available
  // in Node ≥ 14.17 and modern browsers. Fall back to a Math.random concat
  // for older runtimes.
  const g = globalThis as { crypto?: { randomUUID?: () => string } };
  if (g.crypto?.randomUUID) {
    return `clr_${g.crypto.randomUUID()}`;
  }
  return `clr_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
}

/**
 * In-process registry of pending clarify requests. Mirrors the module-level
 * state in `tools.clarify_gateway` — module-level so platform adapters can
 * call `resolveGatewayClarify` without holding a back-reference to the
 * gateway instance.
 *
 * For multi-process deployments, replace this with a Redis-backed registry.
 */
export class ClarifyGateway {
  private readonly entries = new Map<string, ClarifyEntry>();
  /** sessionKey → list[clarifyId] (FIFO; for text-fallback intercept + cleanup). */
  private readonly sessionIndex = new Map<string, string[]>();
  /** Per-session notify callback used by the agent-thread side. */
  private readonly notifyCbs = new Map<string, (entry: ClarifyEntry) => void>();
  /** Active timeout handles for cleanup. */
  private readonly timeouts = new Map<string, ReturnType<typeof setTimeout>>();

  constructor(private readonly timeoutMs: number = DEFAULT_CLARIFY_TIMEOUT_MS) {}

  /**
   * Register a pending clarify request and return the entry plus a promise
   * that resolves when the user responds (or null on timeout).
   *
   * The caller (gateway clarify_callback) will send the prompt to the user
   * and `await` on the returned promise.
   */
  register(opts: {
    sessionKey: string;
    question: string;
    choices?: string[] | null;
    clarifyId?: string;
    timeoutMs?: number;
  }): { entry: ClarifyEntry; response: Promise<string | null> } {
    const clarifyId = opts.clarifyId ?? randomClarifyId();
    const choices = opts.choices ? [...opts.choices] : null;
    const timeout = opts.timeoutMs ?? this.timeoutMs;

    let resolveFn!: (response: string | null) => void;
    let rejectFn!: (err: unknown) => void;
    const response = new Promise<string | null>((resolve, reject) => {
      resolveFn = resolve;
      rejectFn = reject;
    });

    const entry: ClarifyEntry = {
      clarifyId,
      sessionKey: opts.sessionKey,
      question: opts.question,
      choices,
      // Open-ended (no choices) → next message IS the response, no buttons.
      awaitingText: choices === null,
      resolve: resolveFn,
      reject: rejectFn,
      deadline: Date.now() + timeout,
      responsePromise: response,
    };

    this.entries.set(clarifyId, entry);
    const list = this.sessionIndex.get(opts.sessionKey) ?? [];
    list.push(clarifyId);
    this.sessionIndex.set(opts.sessionKey, list);

    // Schedule timeout. Polls in 1-second slices in the Python original so
    // the agent's inactivity heartbeat keeps firing; here we just sleep the
    // full timeout since the agent awaits the promise directly.
    const handle = setTimeout(() => {
      const e = this.entries.get(clarifyId);
      if (!e) return;
      this.remove(clarifyId);
      e.resolve(null);
    }, timeout);
    // The handle should not pin the event loop if the process is shutting
    // down — unref it. In non-Node runtimes `unref` is missing; guard.
    if (typeof handle === "object" && handle && "unref" in handle) {
      (handle as { unref?: () => void }).unref?.();
    }
    this.timeouts.set(clarifyId, handle);

    return { entry, response };
  }

  /**
   * Block on the entry's event until resolved or timeout fires. Convenience
   * wrapper around the promise returned by `register`.
   *
   * NOTE: `timeoutMs` is in **milliseconds** (consistent with `register`'s
   * `timeoutMs` and `DEFAULT_CLARIFY_TIMEOUT_MS`). Earlier versions accepted
   * seconds and multiplied by 1000 — that was a unit-mismatch footgun.
   *
   * Race-safe: uses the `responsePromise` stored on the entry (created in
   * `register`) rather than wrapping `entry.resolve`. The wrapping approach
   * could lose responses when `resolveGatewayClarify` fired before this
   * method installed the wrapper.
   */
  async waitForResponse(clarifyId: string, timeoutMs: number): Promise<string | null> {
    const entry = this.entries.get(clarifyId);
    if (!entry) return null;
    // The entry's own deadline already incorporates the original timeout;
    // honour a shorter caller timeout if provided.
    const remaining = Math.max(0, entry.deadline - Date.now());
    const effective = Math.min(timeoutMs, remaining);
    return Promise.race([
      entry.responsePromise,
      timeoutPromise<string | null>(effective, null),
    ]);
  }

  /**
   * Unblock the agent thread waiting on `clarifyId`.
   * Returns true if an entry was found and resolved, false otherwise
   * (already resolved, expired, or never existed).
   */
  resolveGatewayClarify(clarifyId: string, response: string): boolean {
    const entry = this.entries.get(clarifyId);
    if (!entry) return false;
    this.remove(clarifyId);
    entry.resolve(response ?? "");
    return true;
  }

  /**
   * Return the oldest pending clarify entry for a session, or null.
   *
   * By default this only returns entries awaiting free-form text (open-ended
   * clarifies, or a multi-choice clarify after the user picked `Other`).
   * Gateways may pass `includeChoicePrompts=true` when the user has typed
   * directly in response to an active multi-choice prompt; in that case the
   * oldest unresolved clarify is returned so the text can resolve it instead
   * of being queued as an unrelated follow-up turn.
   */
  getPendingForSession(
    sessionKey: string,
    opts: { includeChoicePrompts?: boolean } = {},
  ): ClarifyEntry | null {
    const ids = this.sessionIndex.get(sessionKey) ?? [];
    for (const cid of ids) {
      const entry = this.entries.get(cid);
      if (!entry) continue;
      if (opts.includeChoicePrompts || entry.awaitingText) return entry;
    }
    return null;
  }

  /** Map typed choice replies to canonical choice text, otherwise keep custom text. */
  private coerceTextResponse(entry: ClarifyEntry, response: string): string {
    const text = (response ?? "").trim();
    if (!entry.choices) return text;
    const idx = parseInt(text, 10) - 1;
    if (Number.isInteger(idx) && idx >= 0 && idx < entry.choices.length) {
      return entry.choices[idx];
    }
    for (const choice of entry.choices) {
      if (text.toLowerCase() === choice.trim().toLowerCase()) {
        return choice.trim();
      }
    }
    return text;
  }

  /** Resolve the oldest pending clarify in `sessionKey` from typed text. */
  resolveTextResponseForSession(sessionKey: string, response: string): boolean {
    const entry = this.getPendingForSession(sessionKey, { includeChoicePrompts: true });
    if (!entry) return false;
    return this.resolveGatewayClarify(
      entry.clarifyId,
      this.coerceTextResponse(entry, response),
    );
  }

  /**
   * Flip an entry into text-capture mode (user picked the 'Other' button).
   * Returns true if the entry exists and was flipped, false otherwise.
   */
  markAwaitingText(clarifyId: string): boolean {
    const entry = this.entries.get(clarifyId);
    if (!entry) return false;
    entry.awaitingText = true;
    return true;
  }

  /** Return true when this session has at least one pending clarify entry. */
  hasPending(sessionKey: string): boolean {
    const ids = this.sessionIndex.get(sessionKey) ?? [];
    return ids.some((cid) => this.entries.has(cid));
  }

  /**
   * Resolve and drop every pending clarify for a session.
   * Used by session-boundary cleanup (e.g. /new, gateway shutdown, cached-
   * agent eviction) so blocked agent threads don't hang past the end of
   * their session. Returns the number of entries cancelled.
   */
  clearSession(sessionKey: string): number {
    const ids = this.sessionIndex.get(sessionKey) ?? [];
    if (ids.length === 0) return 0;
    this.sessionIndex.delete(sessionKey);
    let cancelled = 0;
    for (const cid of ids) {
      const entry = this.entries.get(cid);
      if (!entry) continue;
      this.remove(cid);
      // Empty string sentinel — agent code can distinguish from a real
      // response by inspecting the wait_for_response return value alongside
      // its own timeout deadline. Most callers treat any falsy result as
      // "user did not respond".
      entry.resolve("");
      cancelled++;
    }
    return cancelled;
  }

  /** Register a per-session notify callback used by `clarifyCallback`. */
  registerNotify(sessionKey: string, cb: (entry: ClarifyEntry) => void): void {
    this.notifyCbs.set(sessionKey, cb);
  }

  /** Drop the per-session notify callback and cancel any pending clarify entries. */
  unregisterNotify(sessionKey: string): void {
    this.notifyCbs.delete(sessionKey);
    // Cancel any pending entries so blocked async tasks unwind when the run
    // ends (interrupt, completion, gateway shutdown).
    this.clearSession(sessionKey);
  }

  getNotify(sessionKey: string): ((entry: ClarifyEntry) => void) | undefined {
    return this.notifyCbs.get(sessionKey);
  }

  /** Internal: remove an entry from both indices and clear its timeout. */
  private remove(clarifyId: string): void {
    const entry = this.entries.get(clarifyId);
    this.entries.delete(clarifyId);
    const handle = this.timeouts.get(clarifyId);
    if (handle) {
      clearTimeout(handle);
      this.timeouts.delete(clarifyId);
    }
    if (entry) {
      const ids = this.sessionIndex.get(entry.sessionKey);
      if (ids) {
        const idx = ids.indexOf(clarifyId);
        if (idx >= 0) ids.splice(idx, 1);
        if (ids.length === 0) this.sessionIndex.delete(entry.sessionKey);
      }
    }
  }

  /**
   * Cancel every pending clarify across all sessions and clear all timers.
   * Used by `_resetClarifyGatewayForTests` to prevent leaks across test
   * cases (the prior implementation only cleared a synthetic `__test_reset__`
   * session, leaving real test sessions' entries + setTimeout handles leaked).
   * Returns the number of entries cancelled.
   */
  clearAll(): number {
    let n = 0;
    for (const sessionKey of [...this.sessionIndex.keys()]) {
      n += this.clearSession(sessionKey);
    }
    return n;
  }
}

function timeoutPromise<T>(ms: number, value: T): Promise<T> {
  return new Promise<T>((resolve) => {
    const handle = setTimeout(() => resolve(value), ms);
    if (typeof handle === "object" && handle && "unref" in handle) {
      (handle as { unref?: () => void }).unref?.();
    }
  });
}

// ── Singleton accessor ────────────────────────────────────────────────
// Module-level singleton mirrors the Python module-level state. Callers that
// need isolated state per test should construct their own `ClarifyGateway`
// instance instead of using this singleton.
let _singleton: ClarifyGateway | null = null;

export function getClarifyGateway(): ClarifyGateway {
  if (!_singleton) _singleton = new ClarifyGateway();
  return _singleton;
}

/** Test-only: reset the module-level singleton. Clears ALL pending entries
 * (across every session) and their timeouts to prevent leaks between tests. */
export function _resetClarifyGatewayForTests(): void {
  if (_singleton) {
    _singleton.clearAll();
  }
  _singleton = null;
}
