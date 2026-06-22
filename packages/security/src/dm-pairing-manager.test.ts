import { describe, it, expect, beforeEach, vi } from "vitest";
import { DMPairingManager } from "./dm-pairing-manager";
import { EventBus } from "@evoclaw/core";
import * as fs from "fs";
import * as path from "path";

// Mock fs to avoid filesystem side effects
vi.mock("fs", () => ({
  existsSync: vi.fn().mockReturnValue(false),
  mkdirSync: vi.fn(),
  writeFileSync: vi.fn(),
  readFileSync: vi.fn().mockReturnValue("{}"),
  openSync: vi.fn().mockReturnValue(1),
  closeSync: vi.fn(),
  fsyncSync: vi.fn(),
  copyFileSync: vi.fn(),
  renameSync: vi.fn(),
  unlinkSync: vi.fn(),
}));

describe("DMPairingManager", () => {
  let eventBus: EventBus;
  let dm: DMPairingManager;

  beforeEach(() => {
    vi.useFakeTimers();
    eventBus = new EventBus();
    dm = new DMPairingManager(eventBus, {
      pairingStorePath: path.join("test-data", "pairing-store.json"),
    });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  // ── Policy Configuration ────────────────────────

  it("should default to 'pairing' policy for unconfigured channels", () => {
    expect(dm.getChannelPolicy("telegram")).toBe("pairing");
  });

  it("should set and retrieve channel policy", () => {
    dm.setChannelPolicy({ channel: "telegram", policy: "open" });
    expect(dm.getChannelPolicy("telegram")).toBe("open");
  });

  it("should set allowlist policy with pre-approved peers", () => {
    dm.setChannelPolicy({
      channel: "discord",
      policy: "allowlist",
      allowlist: ["user-1", "user-2"],
    });
    expect(dm.isApproved("discord", "user-1")).toBe(true);
    expect(dm.isApproved("discord", "user-2")).toBe(true);
    expect(dm.isApproved("discord", "user-3")).toBe(false);
  });

  // ── Open Policy ─────────────────────────────────

  it("should allow all DMs with open policy", () => {
    dm.setChannelPolicy({ channel: "webchat", policy: "open" });
    const result = dm.checkDM({ channel: "webchat", peerId: "anyone" });
    expect(result.allowed).toBe(true);
  });

  // ── Allowlist Policy ─────────────────────────────

  it("should block unapproved peers in allowlist mode", () => {
    dm.setChannelPolicy({
      channel: "telegram",
      policy: "allowlist",
      allowlist: ["admin"],
    });
    const result = dm.checkDM({ channel: "telegram", peerId: "stranger" });
    expect(result.allowed).toBe(false);
    expect(result.reason).toBe("sender_not_in_allowlist");
  });

  it("should allow pre-approved peers in allowlist mode", () => {
    dm.setChannelPolicy({
      channel: "telegram",
      policy: "allowlist",
      allowlist: ["admin"],
    });
    const result = dm.checkDM({ channel: "telegram", peerId: "admin" });
    expect(result.allowed).toBe(true);
  });

  // ── Pairing Flow ────────────────────────────────

  it("should require pairing for unknown peer", () => {
    const result = dm.checkDM({
      channel: "telegram",
      peerId: "new-user",
      peerName: "Alice",
    });
    expect(result.allowed).toBe(false);
    expect(result.reason).toBe("pairing_required");
    expect(result.pairingCode).toBeDefined();
    expect(result.pairingCode).toMatch(/^\d{6}$/);
    expect(result.pairingMessage).toContain("pairing approve");
  });

  it("should return same pairing code for repeated checks", () => {
    const r1 = dm.checkDM({ channel: "telegram", peerId: "new-user" });
    const r2 = dm.checkDM({ channel: "telegram", peerId: "new-user" });
    expect(r1.pairingCode).toBe(r2.pairingCode);
  });

  it("should approve a pairing and allow subsequent DMs", () => {
    const r1 = dm.checkDM({ channel: "telegram", peerId: "new-user" });
    const approved = dm.approve(r1.pairingCode!, "operator");
    expect(approved).not.toBeNull();
    expect(approved!.peerId).toBe("new-user");
    expect(approved!.channel).toBe("telegram");

    const r2 = dm.checkDM({ channel: "telegram", peerId: "new-user" });
    expect(r2.allowed).toBe(true);
  });

  it("should return null when approving unknown code", () => {
    expect(dm.approve("000000")).toBeNull();
  });

  it("should return null when approving expired code", () => {
    const result = dm.checkDM({ channel: "telegram", peerId: "late-user" });
    // Advance time past expiry
    vi.advanceTimersByTime(15 * 60 * 1000); // 15 minutes
    expect(dm.approve(result.pairingCode!)).toBeNull();
  });

  it("should deny a pairing code", () => {
    const result = dm.checkDM({ channel: "telegram", peerId: "bad-user" });
    expect(dm.deny(result.pairingCode!)).toBe(true);
    expect(dm.deny(result.pairingCode!)).toBe(false); // already deleted
  });

  // ── Peer Management ─────────────────────────────

  it("should add and remove approved peers manually", () => {
    dm.addApprovedPeer("telegram", "manual-user");
    expect(dm.isApproved("telegram", "manual-user")).toBe(true);

    dm.removeApprovedPeer("telegram", "manual-user");
    expect(dm.isApproved("telegram", "manual-user")).toBe(false);
  });

  it("should list approved peers across channels", () => {
    dm.addApprovedPeer("telegram", "u1");
    dm.addApprovedPeer("discord", "u2");

    const all = dm.listApprovedPeers();
    expect(all).toHaveLength(2);

    const tgOnly = dm.listApprovedPeers("telegram");
    expect(tgOnly).toHaveLength(1);
    expect(tgOnly[0].peerId).toBe("u1");
  });

  it("should list pending pairings sorted by time", () => {
    dm.checkDM({ channel: "tg", peerId: "first" });
    dm.checkDM({ channel: "dc", peerId: "second" });

    const pending = dm.listPendingPairings();
    expect(pending).toHaveLength(2);
    expect(pending[0].peerId).toBe("first");
    expect(pending[1].peerId).toBe("second");
  });

  // ── Expiration ──────────────────────────────────

  it("should clean up expired pairing requests", () => {
    dm.checkDM({ channel: "tg", peerId: "user" });
    expect(dm.listPendingPairings()).toHaveLength(1);

    vi.advanceTimersByTime(15 * 60 * 1000); // 15 minutes

    // The cleanup interval fires every 60s in the constructor, so advance 60s
    // But we need to run the interval callback. Let's just test direct cleanup via checkDM
    const result = dm.checkDM({ channel: "tg", peerId: "user" });
    // Should create a new code since old one expired
    expect(result.allowed).toBe(false);
    expect(result.reason).toBe("pairing_required");
    expect(dm.listPendingPairings()).toHaveLength(1); // old expired, new created
  });
});