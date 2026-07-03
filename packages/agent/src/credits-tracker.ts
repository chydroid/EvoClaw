/**
 * Credits tracking — parses x-nous-credits-* response headers into a validated
 * CreditsState, computes depletion / usage-band notices, and reconciles them
 * against an in-memory latch.
 *
 * TypeScript port of hermes-agent/agent/credits_tracker.py. Money is handled
 * as micros (integer) only; the *_usd strings are preserved verbatim as
 * the server sent them (never re-parsed to float, which would lose precision
 * above 2**53).
 *
 * Header schema (all optional except version + micros fields):
 *   x-nous-credits-version                    contract version (must be 1)
 *   x-nous-credits-remaining-micros           total remaining balance (micros)
 *   x-nous-credits-remaining-usd              same, formatted USD string
 *   x-nous-credits-subscription-micros        subscription balance (SIGNED)
 *   x-nous-credits-subscription-usd           same, formatted USD string
 *   x-nous-credits-subscription-limit-micros  subscription cap (PAIRED/optional)
 *   x-nous-credits-subscription-limit-usd     same, formatted USD string
 *   x-nous-credits-rollover-micros            rolled-over balance (micros)
 *   x-nous-credits-purchased-micros           purchased balance (micros)
 *   x-nous-credits-purchased-usd              same, formatted USD string
 *   x-nous-credits-denominator-kind           "subscription_cap" | "none"
 *   x-nous-credits-paid-access                "true" | "false" (STRING!)
 *   x-nous-credits-disabled-reason            reason string (header omitted when null)
 *   x-nous-credits-as-of-ms                   server-side timestamp (ms epoch)
 *
 * Tool-pool headers use a SEPARATE prefix:
 *   x-nous-tool-pool-micros                   tool-pool balance (micros)
 *   x-nous-tool-pool-gated-off                "true" | "false" (STRING!)
 */

// ── Internal sentinel for "parse failed" ─────────────────────────────
const PARSE_FAILED = Symbol("parse-failed");

type ParseResult = number | typeof PARSE_FAILED;

function safeInt(value: unknown): ParseResult {
  if (value === null || value === undefined) return PARSE_FAILED;
  // Parse with integer string only — NOT int(float()) — to avoid precision
  // loss above 2**53 that would silently corrupt large money values.
  // Reject float-shaped strings like "1.5" (the contract guarantees integers).
  const str = String(value).trim();
  if (str === "") return PARSE_FAILED;
  // Validate integer format manually to catch float strings.
  if (!/^-?\d+$/.test(str)) return PARSE_FAILED;
  const n = Number(str);
  if (!Number.isSafeInteger(n)) return PARSE_FAILED;
  return n;
}

const USD_RE = /^-?\d+\.\d{2}$/;

function validateUsd(value: string | undefined | null): boolean {
  if (value === null || value === undefined) return false;
  return USD_RE.test(value);
}

// ── CreditsState ──────────────────────────────────────────────────────
export interface CreditsState {
  version: number;
  remainingMicros: number;
  remainingUsd: string;
  // SIGNED — may be negative (debt). ONLY field allowed negative.
  subscriptionMicros: number;
  subscriptionUsd: string;
  // PAIRED + OPTIONAL (only present when subscription_cap)
  subscriptionLimitMicros: number | null;
  subscriptionLimitUsd: string | null;
  rolloverMicros: number;
  purchasedMicros: number;
  purchasedUsd: string;
  toolPoolMicros: number;
  toolPoolGatedOff: boolean;
  denominatorKind: "subscription_cap" | "none";
  // depletion keys off THIS === false, NEVER remainingMicros === 0
  paidAccess: boolean;
  disabledReason: string | null;
  asOfMs: number;
  capturedAt: number; // Date.now() when this was captured
  fromHeader: boolean; // true only when populated by parseCreditsHeaders()
}

export function hasData(state: CreditsState): boolean {
  return state.capturedAt > 0;
}

export function ageSeconds(state: CreditsState): number {
  if (!hasData(state)) return Number.POSITIVE_INFINITY;
  return (Date.now() - state.capturedAt) / 1000;
}

export function isDepleted(state: CreditsState): boolean {
  // Keyed off paidAccess === false ONLY — never remainingMicros === 0,
  // which would give a false positive when balance is zero but access is
  // still live (e.g. subscription renewal pending).
  return !state.paidAccess;
}

/**
 * Fraction of the subscription cap consumed, in [0.0, 1.0].
 *
 * Computable only when subscriptionLimitMicros is a truthy (non-zero,
 * non-null) number. Guarded on the LIMIT FIELD, not denominatorKind —
 * the limit field is the real denominator; denominatorKind is metadata.
 * Returns null when there is no computable denominator (no limit, or limit===0).
 */
export function usedFraction(state: CreditsState): number | null {
  if (typeof state.subscriptionLimitMicros !== "number") return null;
  if (state.subscriptionLimitMicros <= 0) return null;
  const used = state.subscriptionLimitMicros - state.subscriptionMicros;
  const frac = used / state.subscriptionLimitMicros;
  return Math.max(0.0, Math.min(1.0, frac));
}

// ── Credits policy constants ──────────────────────────────────────────
export const CREDITS_NOTICE_KIND = "sticky" as const;
export const CREDITS_RESTORED_TTL_MS = 8000;

// Usage-gauge bands (ascending). Each is [thresholdFraction, level, labelPct].
// The notice shows the HIGHEST band the current usedFraction has reached — a
// single escalating status-bar line (50 → 75 → 90), not three stacked notices.
export const CREDITS_USAGE_BANDS: ReadonlyArray<readonly [number, "info" | "warn", number]> = [
  [0.5, "info", 50],
  [0.75, "warn", 75],
  [0.9, "warn", 90],
];
export const CREDITS_USAGE_KEY = "credits.usage";

// ── AgentNotice ────────────────────────────────────────────────────────
export interface AgentNotice {
  text: string;
  level: "info" | "warn" | "error" | "success";
  kind: "sticky" | "ttl";
  ttlMs?: number;
  key?: string;
  id?: string;
}

export function makeNotice(partial: Partial<AgentNotice> & { text: string }): AgentNotice {
  return {
    level: "info",
    kind: "sticky",
    ...partial,
  };
}

// ── Latch shape ────────────────────────────────────────────────────────
export interface CreditsLatch {
  active: Set<string>;
  seenBelow90: boolean;
  usageBand: number | null;
}

export function createLatch(): CreditsLatch {
  return { active: new Set(), seenBelow90: false, usageBand: null };
}

// ── is_free_tier_model ──────────────────────────────────────────────────
/**
 * Return true when the model is a Nous free-tier model, using ONLY local data.
 *
 * Two signals, both zero-network:
 *   1. The `:free` suffix — canonical Nous free SKU marker.
 *   2. (Optional) peek into an in-process pricing cache.
*
* Fail-open to false (the depleted notice still shows) on any error.
*/
export function isFreeTierModel(model: string, _baseUrl: string = ""): boolean {
  if (!model) return false;
  if (model.endsWith(":free")) return true;
  // Pricing cache peek intentionally omitted — TS port runs in environments
  // that don't carry the Hermes model-picker cache, so the `:free` suffix is
  // the only zero-network signal we trust here.
  return false;
}

// ── evaluate_credits_notices (pure reconciliation) ────────────────────
export interface NoticeDelta {
  toShow: AgentNotice[];
  toClear: string[];
}

/**
 * Reconcile credits notices against the latch. Mutates `latch` in place.
 *
 * `modelIsFree`: true when the session's active model is a Nous free-tier
 * model. Suppresses the credits.depleted notice — a depleted account on a
 * free model can keep inferencing, so the error banner is noise. Suppression
 * does NOT emit the "restored" success notice; that fires only on a genuine
 * paidAccess flip back to true.
 *
 * Pure function — no I/O.
 */
export function evaluateCreditsNotices(
  state: CreditsState,
  latch: CreditsLatch,
  opts: { modelIsFree?: boolean } = {},
): NoticeDelta {
  const toShow: AgentNotice[] = [];
  const toClear: string[] = [];
  const modelIsFree = opts.modelIsFree ?? false;
  const uf = usedFraction(state);

  // Crossing latch: once we've observed uf below the LOWEST band, escalating
  // usage notices may fire. Prevents a brand-new session that opens mid-range
  // from firing spuriously on the first observation.
  const lowestBand = CREDITS_USAGE_BANDS[0][0];
  if (uf !== null && uf < lowestBand) {
    latch.seenBelow90 = true;
  }

  const active = latch.active;

  // Highest band whose threshold the current usage has reached (null below all).
  let currentBand: readonly [number, "info" | "warn", number] | null = null;
  if (uf !== null) {
    for (const band of CREDITS_USAGE_BANDS) {
      if (uf >= band[0]) currentBand = band;
    }
  }
  // Top-up suppression: when the account holds purchased (top-up) credits,
  // the subscription-cap gauge is the wrong denominator — warning "90% used"
  // at a user sitting on $50 of top-up is noise. Suppress the usage band.
  if (state.purchasedMicros > 0) {
    currentBand = null;
  }
  const grantCond =
    state.denominatorKind === "subscription_cap" &&
    uf !== null &&
    uf >= 1.0 &&
    state.purchasedMicros > 0;
  const depletedCond = !state.paidAccess;

  // Usage gauge (escalating single notice: 50 → 75 → 90)
  const shownBand = latch.usageBand;
  const targetBand = currentBand && latch.seenBelow90 ? currentBand[2] : null;
  if (targetBand !== shownBand) {
    if (active.has(CREDITS_USAGE_KEY)) {
      toClear.push(CREDITS_USAGE_KEY);
      active.delete(CREDITS_USAGE_KEY);
    }
    if (targetBand !== null && currentBand) {
      const capUsd = state.subscriptionLimitUsd ?? "?";
      const level = currentBand[1];
      const icon = level === "warn" ? "⚠" : "•";
      toShow.push(
        makeNotice({
          text: `${icon} Credits ${targetBand}% used · $${capUsd} cap`,
          level,
          kind: CREDITS_NOTICE_KIND,
          key: CREDITS_USAGE_KEY,
          id: CREDITS_USAGE_KEY,
        }),
      );
      active.add(CREDITS_USAGE_KEY);
    }
    latch.usageBand = targetBand;
  }

  // grant_spent
  if (grantCond && !active.has("credits.grant_spent")) {
    toShow.push(
      makeNotice({
        text: `• Grant spent · $${state.purchasedUsd} top-up left`,
        level: "info",
        kind: CREDITS_NOTICE_KIND,
        key: "credits.grant_spent",
        id: "credits.grant_spent",
      }),
    );
    active.add("credits.grant_spent");
  } else if (active.has("credits.grant_spent") && !grantCond) {
    toClear.push("credits.grant_spent");
    active.delete("credits.grant_spent");
  }

  // depleted (suppressed while the active model is free)
  const showDepleted = depletedCond && !modelIsFree;
  if (showDepleted && !active.has("credits.depleted")) {
    toShow.push(
      makeNotice({
        text: "✕ Credit access paused · run /credits to top up",
        level: "error",
        kind: CREDITS_NOTICE_KIND,
        key: "credits.depleted",
        id: "credits.depleted",
      }),
    );
    active.add("credits.depleted");
  } else if (active.has("credits.depleted") && !showDepleted) {
    toClear.push("credits.depleted");
    active.delete("credits.depleted");
    if (!depletedCond) {
      // Genuine recovery (paidAccess flipped back to true): also emit the
      // success notice. A clear caused by switching to a free model while
      // still depleted must NOT claim access was restored.
      toShow.push(
        makeNotice({
          text: "✓ Credit access restored",
          level: "success",
          kind: "ttl",
          ttlMs: CREDITS_RESTORED_TTL_MS,
          key: "credits.restored",
          id: "credits.restored",
        }),
      );
    }
  }

  return { toShow, toClear };
}

// ── parse_credits_headers ──────────────────────────────────────────────
export type HeaderMap = Record<string, string>;

const VALID_DENOMINATOR_KINDS = new Set(["subscription_cap", "none"]);

let versionWarningEmitted = false;

function reqNonNeg(lowered: HeaderMap, key: string): ParseResult {
  const val = safeInt(lowered[key]);
  if (val === PARSE_FAILED) return PARSE_FAILED;
  if (val < 0) return PARSE_FAILED;
  return val;
}

function reqInt(lowered: HeaderMap, key: string): ParseResult {
  return safeInt(lowered[key]);
}

/**
 * Parse x-nous-credits-* (and x-nous-tool-pool-*) headers into a CreditsState.
 *
 * Returns null (miss) on ANY of:
 *   - No `x-nous-credits-version` header present.
 *   - Version !== 1 (>1 also emits a one-time warning).
 *   - Any *_micros field is non-integer, or negative for a non-subscription field.
 *   - Any *_usd field doesn't match `^-?\d+\.\d{2}$`.
 *   - `denominator_kind` is not in {subscription_cap, none}.
 *   - `paid_access` / `tool_pool_gated_off` is not exactly "true"/"false".
 *   - `as_of_ms` is not a valid integer.
 *   - Any unexpected exception.
 *
 * Fail-open on the subscription_limit pair: a half-pair (only -micros or only
 * -usd present) is treated as both-absent; the overall parse STILL SUCCEEDS
 * but with subscription_limit_micros/usd both null.
 */
export function parseCreditsHeaders(
  headers: HeaderMap,
  _provider: string = "",
): CreditsState | null {
  try {
    // Cheap probe before the full lowercase copy: bail when the version
    // sentinel header is absent (the common case for non-Nous providers).
    let hasVersionHeader = false;
    for (const k of Object.keys(headers)) {
      if (k.toLowerCase() === "x-nous-credits-version") {
        hasVersionHeader = true;
        break;
      }
    }
    if (!hasVersionHeader) return null;

    // Normalize to lowercase so lookups work regardless of how the server
    // capitalises headers (HTTP header names are case-insensitive per RFC 7230).
    const lowered: HeaderMap = {};
    for (const [k, v] of Object.entries(headers)) {
      lowered[k.toLowerCase()] = v;
    }

    // Version check
    const versionRaw = lowered["x-nous-credits-version"];
    if (versionRaw === undefined || versionRaw === null) return null;
    const versionVal = safeInt(versionRaw);
    if (versionVal === PARSE_FAILED) return null;
    if (versionVal !== 1) {
      if (versionVal > 1 && !versionWarningEmitted) {
        versionWarningEmitted = true;
        // logger.warning equivalent — console.warn to avoid a hard dep on a
        // specific logger in this leaf module.
        console.warn(
          `credits header version ${versionVal} unsupported, ignoring — update EvoClaw`,
        );
      }
      return null;
    }

    // Parse micros fields
    const remainingMicros = reqNonNeg(lowered, "x-nous-credits-remaining-micros");
    if (remainingMicros === PARSE_FAILED) return null;

    const subscriptionMicros = reqInt(lowered, "x-nous-credits-subscription-micros");
    if (subscriptionMicros === PARSE_FAILED) return null;

    const rolloverMicros = reqNonNeg(lowered, "x-nous-credits-rollover-micros");
    if (rolloverMicros === PARSE_FAILED) return null;

    const purchasedMicros = reqNonNeg(lowered, "x-nous-credits-purchased-micros");
    if (purchasedMicros === PARSE_FAILED) return null;

    // tool_pool_micros is OPTIONAL: absent → 0; present-but-invalid → null (miss).
    let toolPoolMicros = 0;
    const tpRaw = lowered["x-nous-tool-pool-micros"];
    if (tpRaw !== undefined && tpRaw !== null) {
      const tpVal = safeInt(tpRaw);
      if (tpVal === PARSE_FAILED || tpVal < 0) return null;
      toolPoolMicros = tpVal;
    }

    const asOfMs = reqNonNeg(lowered, "x-nous-credits-as-of-ms");
    if (asOfMs === PARSE_FAILED) return null;

    // Validate USD strings
    const remainingUsd = lowered["x-nous-credits-remaining-usd"] ?? "";
    if (!validateUsd(remainingUsd)) return null;

    const subscriptionUsd = lowered["x-nous-credits-subscription-usd"] ?? "";
    if (!validateUsd(subscriptionUsd)) return null;

    const purchasedUsd = lowered["x-nous-credits-purchased-usd"] ?? "";
    if (!validateUsd(purchasedUsd)) return null;

    // subscription_limit_* PAIRED + OPTIONAL
    let subscriptionLimitMicros: number | null = null;
    let subscriptionLimitUsd: string | null = null;
    const subLimitMicrosRaw = lowered["x-nous-credits-subscription-limit-micros"];
    const subLimitUsdRaw = lowered["x-nous-credits-subscription-limit-usd"];
    if (subLimitMicrosRaw !== undefined && subLimitUsdRaw !== undefined) {
      const lm = safeInt(subLimitMicrosRaw);
      if (lm === PARSE_FAILED || lm < 0) return null;
      if (!validateUsd(subLimitUsdRaw)) return null;
      subscriptionLimitMicros = lm;
      subscriptionLimitUsd = subLimitUsdRaw;
    }

    // denominator_kind
    const denominatorKind = lowered["x-nous-credits-denominator-kind"] ?? "none";
    if (!VALID_DENOMINATOR_KINDS.has(denominatorKind)) return null;

    // paid_access / tool_pool_gated_off
    let paidAccess = true; // fail-open
    if ("x-nous-credits-paid-access" in lowered) {
      const paRaw = lowered["x-nous-credits-paid-access"].trim().toLowerCase();
      if (paRaw !== "true" && paRaw !== "false") return null;
      paidAccess = paRaw === "true";
    }
    let toolPoolGatedOff = false;
    if ("x-nous-tool-pool-gated-off" in lowered) {
      const tpgoRaw = lowered["x-nous-tool-pool-gated-off"].trim().toLowerCase();
      if (tpgoRaw !== "true" && tpgoRaw !== "false") return null;
      toolPoolGatedOff = tpgoRaw === "true";
    }

    const disabledReason = lowered["x-nous-credits-disabled-reason"] ?? null;

    return {
      version: versionVal,
      remainingMicros,
      remainingUsd,
      subscriptionMicros,
      subscriptionUsd,
      subscriptionLimitMicros,
      subscriptionLimitUsd,
      rolloverMicros,
      purchasedMicros,
      purchasedUsd,
      toolPoolMicros,
      toolPoolGatedOff,
      denominatorKind: denominatorKind as "subscription_cap" | "none",
      paidAccess,
      disabledReason,
      asOfMs,
      capturedAt: Date.now(),
      fromHeader: true,
    };
  } catch {
    // Fail-open → miss, but leave a breadcrumb so a parser/import regression
    // (feature silently dead) is distinguishable from a legitimate no-headers
    // response in agent.log.
    console.debug("credits ▸ parseCreditsHeaders raised (fail-open miss)");
    return null;
  }
}

// ── Helpers for building states from account info ──────────────────────
export interface AccountCreditsInput {
  totalUsableCredits?: number | null;
  subscriptionCreditsRemaining?: number | null;
  purchasedCreditsRemaining?: number | null;
  monthlyCredits?: number | null;
  rolloverCredits?: number | null;
  paidServiceAccess?: boolean | null;
}

function toMicros(dollars: number | null | undefined): number {
  if (typeof dollars !== "number" || !Number.isFinite(dollars)) return 0;
  return Math.round(dollars * 1_000_000);
}

function toUsd(dollars: number | null | undefined): string {
  if (typeof dollars !== "number" || !Number.isFinite(dollars)) return "";
  return dollars.toFixed(2);
}

/**
 * Map account info into a header-shaped CreditsState for the seed.
 *
 * Account dollars → micros (plus a DISPLAY *_usd string — allowed, since
 * we're formatting account floats, NOT parsing a server-provided *_usd).
 * Returns null if the account can't yield a usable state.
 */
export function creditsStateFromAccount(info: AccountCreditsInput): CreditsState | null {
  try {
    const monthly = info.monthlyCredits ?? null;
    const hasCap = typeof monthly === "number" && monthly > 0;
    const paid = info.paidServiceAccess ?? null;
    return {
      version: 1,
      remainingMicros: toMicros(info.totalUsableCredits),
      remainingUsd: toUsd(info.totalUsableCredits),
      subscriptionMicros: toMicros(info.subscriptionCreditsRemaining),
      subscriptionUsd: toUsd(info.subscriptionCreditsRemaining),
      subscriptionLimitMicros: hasCap ? toMicros(monthly) : null,
      subscriptionLimitUsd: hasCap ? toUsd(monthly) : null,
      purchasedMicros: toMicros(info.purchasedCreditsRemaining),
      purchasedUsd: toUsd(info.purchasedCreditsRemaining),
      rolloverMicros: toMicros(info.rolloverCredits),
      toolPoolMicros: 0,
      toolPoolGatedOff: false,
      denominatorKind: hasCap ? "subscription_cap" : "none",
      paidAccess: typeof paid === "boolean" ? paid : true,
      disabledReason: null,
      asOfMs: Date.now(),
      capturedAt: Date.now(),
      fromHeader: false,
    };
  } catch {
    return null;
  }
}
