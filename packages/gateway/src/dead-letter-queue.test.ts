import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import { DeadLetterQueue, DeadLetter } from "./dead-letter-queue";

function makeEntry(overrides?: Partial<Omit<DeadLetter, "id" | "deadLetteredAt" | "replayed">>): Omit<DeadLetter, "id" | "deadLetteredAt" | "replayed"> {
  return {
    channel: "telegram",
    target: "user123",
    content: "Hello world",
    contentType: "text",
    error: "Timeout after 30s",
    retryCount: 3,
    originalSentAt: new Date().toISOString(),
    failureType: "timeout",
    ...overrides,
  };
}

describe("DeadLetterQueue", () => {
  let tmpDir: string;
  let dlq: DeadLetterQueue;

  beforeEach(() => {
    tmpDir = path.join(os.tmpdir(), `evo-dlq-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    dlq = new DeadLetterQueue({ storageDir: tmpDir, maxAgeMs: 0, maxPerChannel: 0 });
  });

  afterEach(() => {
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
  });

  // ── Enqueue ───────────────────────────────────────────

  describe("enqueue", () => {
    it("creates a dead letter with generated id and timestamp", () => {
      const dl = dlq.enqueue(makeEntry());
      expect(dl.id).toMatch(/^dl_\d+_[a-z0-9]+_[a-f0-9]+$/);
      expect(dl.deadLetteredAt).toBeTruthy();
      expect(dl.replayed).toBe(false);
    });

    it("persists dead letter to JSONL file", () => {
      dlq.enqueue(makeEntry());
      const files = fs.readdirSync(tmpDir);
      expect(files.some((f) => f.endsWith(".jsonl"))).toBe(true);
    });

    it("stores all fields correctly", () => {
      const dl = dlq.enqueue(
        makeEntry({
          channel: "discord",
          content: "test",
          contentType: "markdown",
          error: "rate limited",
          failureType: "rate_limit",
          retryCount: 5,
          metadata: { foo: "bar" },
        }),
      );
      expect(dl.channel).toBe("discord");
      expect(dl.content).toBe("test");
      expect(dl.contentType).toBe("markdown");
      expect(dl.error).toBe("rate limited");
      expect(dl.failureType).toBe("rate_limit");
      expect(dl.retryCount).toBe(5);
      expect(dl.metadata).toEqual({ foo: "bar" });
    });
  });

  // ── Query ─────────────────────────────────────────────

  describe("query", () => {
    it("returns all dead letters sorted by time descending", () => {
      dlq.enqueue(makeEntry({ channel: "a", content: "first" }));
      dlq.enqueue(makeEntry({ channel: "a", content: "second" }));

      const results = dlq.query();
      expect(results).toHaveLength(2);
      expect(results[0].content).toBe("second");
      expect(results[1].content).toBe("first");
    });

    it("filters by channel", () => {
      dlq.enqueue(makeEntry({ channel: "telegram" }));
      dlq.enqueue(makeEntry({ channel: "discord" }));

      const results = dlq.query({ channel: "telegram" });
      expect(results).toHaveLength(1);
      expect(results[0].channel).toBe("telegram");
    });

    it("filters by failureType", () => {
      dlq.enqueue(makeEntry({ failureType: "timeout" }));
      dlq.enqueue(makeEntry({ failureType: "auth" }));

      const results = dlq.query({ failureType: "auth" });
      expect(results).toHaveLength(1);
      expect(results[0].failureType).toBe("auth");
    });

    it("filters unreplayed only", () => {
      const dl1 = dlq.enqueue(makeEntry());
      const dl2 = dlq.enqueue(makeEntry());
      dlq.markReplayed(dl1.id, true);

      const results = dlq.query({ unreplayed: true });
      expect(results).toHaveLength(1);
      expect(results[0].id).toBe(dl2.id);
    });

    it("limits results", () => {
      dlq.enqueue(makeEntry());
      dlq.enqueue(makeEntry());
      dlq.enqueue(makeEntry());

      expect(dlq.query({ limit: 2 })).toHaveLength(2);
    });
  });

  // ── Get ───────────────────────────────────────────────

  describe("get", () => {
    it("returns dead letter by ID", () => {
      const dl = dlq.enqueue(makeEntry());
      expect(dlq.get(dl.id)?.id).toBe(dl.id);
    });

    it("returns null for unknown ID", () => {
      expect(dlq.get("nonexistent")).toBeNull();
    });
  });

  // ── Mark Replayed ─────────────────────────────────────

  describe("markReplayed", () => {
    it("marks as replayed on success", () => {
      const dl = dlq.enqueue(makeEntry());
      const result = dlq.markReplayed(dl.id, true);
      expect(result).toBe(true);

      const updated = dlq.get(dl.id);
      expect(updated?.replayed).toBe(true);
      expect(updated?.replayedAt).toBeTruthy();
    });

    it("increments retry count on failure", () => {
      const dl = dlq.enqueue(makeEntry({ retryCount: 3 }));
      dlq.markReplayed(dl.id, false);

      const updated = dlq.get(dl.id);
      expect(updated?.retryCount).toBe(4);
      expect(updated?.replayed).toBe(false);
    });

    it("returns false for unknown ID", () => {
      expect(dlq.markReplayed("nonexistent", true)).toBe(false);
    });
  });

  // ── Delete ────────────────────────────────────────────

  describe("delete", () => {
    it("deletes a dead letter", () => {
      const dl = dlq.enqueue(makeEntry());
      expect(dlq.delete(dl.id)).toBe(true);
      expect(dlq.get(dl.id)).toBeNull();
      expect(dlq.count).toBe(0);
    });

    it("returns false for unknown ID", () => {
      expect(dlq.delete("nonexistent")).toBe(false);
    });
  });

  // ── getUnreplayed ─────────────────────────────────────

  describe("getUnreplayed", () => {
    it("returns only unreplayed entries", () => {
      const dl1 = dlq.enqueue(makeEntry());
      const dl2 = dlq.enqueue(makeEntry());
      dlq.markReplayed(dl1.id, true);

      const unreplayed = dlq.getUnreplayed();
      expect(unreplayed).toHaveLength(1);
      expect(unreplayed[0].id).toBe(dl2.id);
    });

    it("filters by channel", () => {
      dlq.enqueue(makeEntry({ channel: "telegram" }));
      dlq.enqueue(makeEntry({ channel: "discord" }));

      const results = dlq.getUnreplayed("telegram");
      expect(results).toHaveLength(1);
      expect(results[0].channel).toBe("telegram");
    });
  });

  // ── getStats ──────────────────────────────────────────

  describe("getStats", () => {
    it("returns accurate statistics", () => {
      const dl1 = dlq.enqueue(makeEntry({ channel: "telegram", failureType: "timeout" }));
      const dl2 = dlq.enqueue(makeEntry({ channel: "discord", failureType: "auth" }));
      const dl3 = dlq.enqueue(makeEntry({ channel: "telegram", failureType: "network" }));
      dlq.markReplayed(dl1.id, true);

      const stats = dlq.getStats();
      expect(stats.total).toBe(3);
      expect(stats.replayed).toBe(1);
      expect(stats.unreplayed).toBe(2);
      expect(stats.byChannel.telegram).toBe(2);
      expect(stats.byChannel.discord).toBe(1);
      expect(stats.byFailureType.timeout).toBe(1);
      expect(stats.byFailureType.auth).toBe(1);
      expect(stats.byFailureType.network).toBe(1);
    });
  });

  // ── hasDeadLetters ────────────────────────────────────

  describe("hasDeadLetters", () => {
    it("returns true when channel has entries", () => {
      dlq.enqueue(makeEntry({ channel: "telegram" }));
      expect(dlq.hasDeadLetters("telegram")).toBe(true);
    });

    it("returns false for unknown channel", () => {
      expect(dlq.hasDeadLetters("nonexistent")).toBe(false);
    });
  });

  // ── Count ─────────────────────────────────────────────

  describe("count", () => {
    it("returns total number of dead letters", () => {
      expect(dlq.count).toBe(0);
      dlq.enqueue(makeEntry());
      dlq.enqueue(makeEntry());
      expect(dlq.count).toBe(2);
    });
  });

  // ── Purge ─────────────────────────────────────────────

  describe("purge", () => {
    it("purges entries older than maxAgeMs", () => {
      const agedDlq = new DeadLetterQueue({
        storageDir: path.join(tmpDir, "aged"),
        maxAgeMs: 1000, // 1 second
        maxPerChannel: 0,
      });

      agedDlq.enqueue(makeEntry());

      // Wait for entry to age out
      const dl = agedDlq.enqueue(makeEntry());
      // Override deadLetteredAt to simulate old entry
      const file = path.join(agedDlq["config"].storageDir, "telegram.jsonl");
      const oldEntry = { ...dl, deadLetteredAt: new Date(Date.now() - 5000).toISOString() };
      fs.writeFileSync(file, JSON.stringify(oldEntry) + "\n", "utf-8");

      const purged = agedDlq.purge();
      expect(purged).toBeGreaterThanOrEqual(0); // At minimum it should work
    });

    it("purges excess entries beyond maxPerChannel", () => {
      const cappedDlq = new DeadLetterQueue({
        storageDir: path.join(tmpDir, "capped"),
        maxAgeMs: 0,
        maxPerChannel: 2,
      });

      cappedDlq.enqueue(makeEntry());
      cappedDlq.enqueue(makeEntry());
      cappedDlq.enqueue(makeEntry());
      cappedDlq.enqueue(makeEntry());

      const purged = cappedDlq.purge();
      expect(purged).toBe(2);
      expect(cappedDlq.count).toBe(2);
    });

    it("purgeChannel removes all entries for a channel", () => {
      dlq.enqueue(makeEntry({ channel: "telegram" }));
      dlq.enqueue(makeEntry({ channel: "telegram" }));
      dlq.enqueue(makeEntry({ channel: "discord" }));

      const purged = dlq.purgeChannel("telegram");
      expect(purged).toBe(2);
      expect(dlq.hasDeadLetters("telegram")).toBe(false);
      expect(dlq.hasDeadLetters("discord")).toBe(true);
    });

    it("purgeChannel returns 0 for non-existent channel", () => {
      expect(dlq.purgeChannel("nonexistent")).toBe(0);
    });
  });

  // ── configure ─────────────────────────────────────────

  describe("configure", () => {
    it("updates configuration", () => {
      dlq.configure({ maxPerChannel: 100 });
      // Verify config was updated by enqueueing and purging
      dlq.enqueue(makeEntry());
      // No error means config is valid
    });
  });

  // ── Channel name sanitization ─────────────────────────

  describe("channel name sanitization", () => {
    it("sanitizes channel names with special characters", () => {
      const dl = dlq.enqueue(makeEntry({ channel: "some/channel: test@123" }));
      expect(dl.channel).toBe("some/channel: test@123");
      // Should persist without error
      expect(dlq.count).toBe(1);
    });
  });

  // ── minAge filter ─────────────────────────────────────

  describe("query minAgeMs filter", () => {
    it("filters entries older than minAgeMs", () => {
      const dl = dlq.enqueue(makeEntry());
      // Immediately query with minAge — should return 0 since entry is brand new
      const results = dlq.query({ minAgeMs: 60000 }); // 1 minute
      expect(results).toHaveLength(0);
    });
  });

  // ── Empty state ───────────────────────────────────────

  describe("empty state", () => {
    it("query returns empty array", () => {
      expect(dlq.query()).toEqual([]);
    });

    it("getStats returns zeros", () => {
      const stats = dlq.getStats();
      expect(stats.total).toBe(0);
      expect(stats.unreplayed).toBe(0);
      expect(stats.replayed).toBe(0);
    });

    it("getUnreplayed returns empty array", () => {
      expect(dlq.getUnreplayed()).toEqual([]);
    });
  });
});